---
name: auto-issue-implementer
description: "Crea el workflow de GitHub Actions que analiza issues con IA y genera, comitea, pushea y mergea el código automáticamente"
whenToUse: "Cuando quieras configurar resolución automática de issues en un repo — analiza el issue con un LLM, genera el código, crea PR y lo mergea solo"
---

# Auto Issue Implementer

Workflow de GitHub Actions en dos fases que analiza issues con un LLM (OpenAI-compatible) y **genera, comitea, pushea y mergea** el código automáticamente.

## Qué hace

1. **Análisis** — cuando se abre un issue, el LLM asigna labels y publica un diagnóstico
2. **Implementación** — el LLM genera el código necesario, lo comitea en una branch, crea un PR, lo mergea (squash), cierra el issue y elimina la branch

## Instalación

Crear `.github/workflows/ai-issue-analysis.yml` con el contenido de la sección **Workflow completo**.

Luego configurar en Settings > Secrets and variables > Actions del repo:

| Variable | Dónde | Valor ejemplo |
|---|---|---|
| `LLM_BASE_URL` | **Variables** | `https://integrate.api.nvidia.com/v1` |
| `LLM_API_KEY` | **Secrets** | `nvapi-...` |
| `LLM_MODEL` | **Variables** | `nvidia_nim/moonshotai/kimi-k2.6` |

> `LLM_BASE_URL` y `LLM_MODEL` van en **Variables** (no Secrets) — se acceden con `vars.`, no `secrets.`.

## Permisos necesarios

El workflow requiere estos permisos en el YAML:

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write
```

## Workflow completo

```yaml
name: AI Issue Analysis

on:
  issues:
    types: [opened, edited]
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  analyze-and-implement:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Analyze and implement issue
        uses: actions/github-script@v8
        env:
          LLM_BASE_URL: ${{ vars.LLM_BASE_URL }}
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
          LLM_MODEL: ${{ vars.LLM_MODEL }}
        with:
          script: |
            const fs = require('fs');
            const issue = context.payload.issue;

            const baseUrl = process.env.LLM_BASE_URL;
            const apiKey = process.env.LLM_API_KEY;
            let   model  = process.env.LLM_MODEL;

            if (!baseUrl || !model) {
              core.setFailed(
                'Variables requeridas no encontradas. ' +
                'LLM_BASE_URL=' + (baseUrl ? 'SET' : 'EMPTY') + ', ' +
                'LLM_MODEL=' + (model ? 'SET' : 'EMPTY') + '. ' +
                'Configuralas en Settings > Secrets and variables > Actions (repositorio).'
              );
              return;
            }

            // Strip LiteLLM-style provider prefixes (e.g. nvidia_nim/)
            model = model.replace(/^nvidia_nim\//, '');

            core.info('LLM endpoint: ' + baseUrl + '/chat/completions');
            core.info('LLM model:    ' + model);

            const isCommentEvent = context.payload.comment !== undefined;
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

            // Undici's default headersTimeout (~5-10s) aborts before a cold NVIDIA NIM model loads.
            // Force a 6-minute window so the API can start streaming.
            const globalFetchTimeoutMs = 360000;

            async function fetchWithTimeout(url, opts, timeoutMs) {
              const controller = new AbortController();
              const id = setTimeout(() => controller.abort(), timeoutMs);
              try {
                return await fetch(url, { ...opts, signal: controller.signal });
              } finally {
                clearTimeout(id);
              }
            }

            async function callLLM(prompt, maxTokens) {
              for (let attempt = 0; attempt < 4; attempt++) {
                const resp = await fetchWithTimeout(baseUrl + '/chat/completions', {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({
                    model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens,
                  }),
                }, globalFetchTimeoutMs);
                if (resp.ok) return resp;
                if (resp.status !== 429 || attempt === 3) return resp;
                await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 5000));
              }
              return null;
            }

            async function parseLLMResponse(response, label) {
              if (!response || !response.ok) {
                const status = response ? response.status : 'no response';
                if (label === 'analysis') core.setFailed(label + ' LLM error: ' + status);
                else core.warning(label + ' LLM error: ' + status);
                return null;
              }
              const data = await response.json();
              const raw = data.choices?.[0]?.message?.content;
              if (!raw) { core.warning(label + ' returned empty'); return null; }
              try { return JSON.parse(raw); }
              catch (e) {
                const m = raw.match(/\{[\s\S]*\}/);
                if (m) return JSON.parse(m[0]);
                core.warning(label + ' unparseable: ' + raw.substring(0, 100));
                return null;
              }
            }

            // === ANALYSIS PHASE (issue events only, not comments) ===
            if (!isCommentEvent) {
              const { data: repoLabels } = await github.rest.issues.listLabelsForRepo({
                owner: context.repo.owner, repo: context.repo.repo,
              });
              const labelNames = new Set(repoLabels.map(l => l.name));

              const analysis = await parseLLMResponse(await callLLM([
                'Analiza el siguiente issue de GitHub y responde UNICAMENTE con un JSON valido.',
                '',
                'Titulo: ' + issue.title,
                'Cuerpo: ' + (issue.body || 'Sin descripcion'),
                '',
                'Formato requerido (no incluyas markdown, solo JSON puro):',
                '{"labels": ["label1", "label2"], "diagnosis": "Analisis detallado..."}',
                '',
                'Reglas:',
                '- labels debe contener entre 1 y 3 elementos.',
                '- Usa labels descriptivos (ej: bug, feature, enhancement, refactor, documentation, question, ui, gameplay, performance).',
                '- diagnosis debe ser un analisis conciso pero completo en espanol, formateado en Markdown.',
                '- El JSON debe ser valido y no contener comentarios.',
              ].join('\n'), 2048), 'analysis');

              if (analysis) {
                const labelsToApply = Array.isArray(analysis.labels)
                  ? analysis.labels.filter(l => typeof l === 'string') : [];
                for (const label of labelsToApply) {
                  if (!labelNames.has(label)) {
                    try {
                      await github.rest.issues.createLabel({
                        owner: context.repo.owner, repo: context.repo.repo, name: label, color: 'ededed',
                      });
                      labelNames.add(label);
                    } catch (e) { core.warning('Could not create label ' + label + ': ' + e.message); }
                  }
                }
                if (labelsToApply.length > 0) {
                  await github.rest.issues.addLabels({
                    owner: context.repo.owner, repo: context.repo.repo, issue_number: issue.number, labels: labelsToApply,
                  });
                }
                if (analysis.diagnosis) {
                  await github.rest.issues.createComment({
                    owner: context.repo.owner, repo: context.repo.repo, issue_number: issue.number,
                    body: '## \u{1F916} Diagnóstico de IA\n\n' + analysis.diagnosis,
                  });
                }
              }
            }

            // === IMPLEMENTATION PHASE ===
            if (context.payload.action === 'edited') {
              core.info('Skipping implementation for edited issue');
              return;
            }
            if (isCommentEvent && context.payload.comment.user.type === 'Bot') {
              core.info('Skipping implementation on bot comment');
              return;
            }

            const implContext = isCommentEvent
              ? 'Issue #' + issue.number + ': ' + issue.title + '\n\n' + issue.body + '\n\n---\n\nEl usuario ha comentado:\n\n' + context.payload.comment.body
              : 'Issue #' + issue.number + ': ' + issue.title + '\n\n' + issue.body;

            const sourceFiles = {};
            const fileList = ['index.html', 'style.css', 'game.js', 'CLAUDE.md'];
            for (const f of fileList) {
              try {
                sourceFiles[f] = fs.readFileSync(f, 'utf-8');
              } catch (e) {
                core.warning('Could not read ' + f + ': ' + e.message);
              }
            }

            const implPrompt = [
              'Eres un desarrollador senior implementando un issue de GitHub.',
              'El proyecto es Tetris en JavaScript vanilla, HTML5 Canvas y CSS.',
              '',
              implContext,
              '',
              '=== Codigo fuente actual ===',
              '',
              ...Object.entries(sourceFiles).map(([name, content]) =>
                '<file path="' + name + '">\n' + content + '\n</file>'
              ),
              '',
              '=== Instrucciones ===',
              'Responde UNICAMENTE con un JSON valido con este formato:',
              JSON.stringify({
                files: {
                  'ruta/archivo': 'contenido COMPLETO del archivo modificado'
                },
                pr_title: 'feat: descripcion corta',
                pr_body: 'Closes #' + issue.number + '\\n\\nDescripcion detallada...'
              }, null, 2),
              '',
              'Reglas:',
              '- Incluye SOLO los archivos que necesiten cambios, con su contenido COMPLETO.',
              '- Manten el estilo y convenciones del codigo existente.',
              '- Sin dependencias externas, sin frameworks, sin build process.',
              '- Si el issue es muy ambiguo o no implementable, responde: {"impossible": true, "reason": "..."}',
              '- El JSON debe ser valido, sin comentarios.',
            ].join('\n');

            let implResponse;
            for (let attempt = 0; attempt < 4; attempt++) {
              implResponse = await fetchWithTimeout(baseUrl + '/chat/completions', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  model: model,
                  messages: [{ role: 'user', content: implPrompt }],
                  max_tokens: 8192,
                }),
              }, 180000);

              if (implResponse.ok) break;

              if (implResponse.status !== 429 || attempt === 3) {
                core.warning('Implementation LLM call failed: ' + implResponse.status);
                await github.rest.issues.createComment({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  issue_number: issue.number,
                  body: '## ⚠️ Error en implementación\nNo se pudo generar el código automáticamente.\n\nError: LLM API responded with status ' + implResponse.status,
                });
                return;
              }

              await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 5000));
            }

            if (!implResponse || !implResponse.ok) {
              core.warning('Implementation LLM call failed after retries');
              return;
            }

            const implData = await implResponse.json();
            const implRaw = implData.choices?.[0]?.message?.content;
            if (!implRaw) {
              core.warning('Implementation LLM returned empty');
              return;
            }

            let implResult;
            try {
              implResult = JSON.parse(implRaw);
            } catch (e) {
              const match = implRaw.match(/\{[\s\S]*\}/);
              if (match) {
                implResult = JSON.parse(match[0]);
              } else {
                core.warning('Could not parse implementation response');
                return;
              }
            }

            if (implResult.impossible) {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: issue.number,
                body: '## ⚠️ No se pudo implementar automáticamente\n\n' + (implResult.reason || 'El cambio requiere análisis manual.'),
              });
              return;
            }

            if (!implResult.files || Object.keys(implResult.files).length === 0) {
              core.warning('No files to change');
              return;
            }

            // Create blobs for each changed file
            const blobs = await Promise.all(
              Object.entries(implResult.files).map(async ([path, content]) => {
                const { data } = await github.rest.git.createBlob({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  content: content,
                  encoding: 'utf-8',
                });
                return { path, sha: data.sha, mode: '100644', type: 'blob' };
              })
            );

            // Get default branch info
            const { data: repo } = await github.rest.repos.get(context.repo);
            const defaultBranch = repo.default_branch;
            const { data: ref } = await github.rest.git.getRef({
              owner: context.repo.owner,
              repo: context.repo.repo,
              ref: 'heads/' + defaultBranch,
            });
            const { data: baseCommit } = await github.rest.git.getCommit({
              owner: context.repo.owner,
              repo: context.repo.repo,
              commit_sha: ref.object.sha,
            });

            // Create a tree with the changes on top of the base
            const { data: newTree } = await github.rest.git.createTree({
              owner: context.repo.owner,
              repo: context.repo.repo,
              base_tree: baseCommit.tree.sha,
              tree: blobs,
            });

            // Commit
            const { data: newCommit } = await github.rest.git.createCommit({
              owner: context.repo.owner,
              repo: context.repo.repo,
              message: implResult.pr_title || 'Implement ' + issue.title,
              tree: newTree.sha,
              parents: [ref.object.sha],
            });

            // Branch name from issue
            const branchName = 'ai/issue-' + issue.number + '-' +
              issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').substring(0, 50);

            // Create or force-update branch
            try {
              await github.rest.git.createRef({
                owner: context.repo.owner,
                repo: context.repo.repo,
                ref: 'refs/heads/' + branchName,
                sha: newCommit.sha,
              });
            } catch (e) {
              if (e.status === 422) {
                core.info('Branch ' + branchName + ' exists, force-updating...');
                await github.rest.git.deleteRef({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  ref: 'heads/' + branchName,
                });
                await github.rest.git.createRef({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  ref: 'refs/heads/' + branchName,
                  sha: newCommit.sha,
                });
              } else {
                core.warning('Branch creation failed: ' + e.message);
                await github.rest.issues.createComment({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  issue_number: issue.number,
                  body: '## ⚠️ Error al crear PR\n' + e.message,
                });
                return;
              }
            }

            // Create or update PR
            let pull = null;
            try {
              const { data: pr } = await github.rest.pulls.create({
                owner: context.repo.owner,
                repo: context.repo.repo,
                title: implResult.pr_title || 'Implement ' + issue.title,
                head: branchName,
                base: defaultBranch,
                body: implResult.pr_body || 'Implementación automática de #' + issue.number,
              });
              pull = pr;
            } catch (e) {
              if (e.status === 422) {
                core.info('PR already exists, updating...');
                const { data: existingPRs } = await github.rest.pulls.list({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  head: context.repo.owner + ':' + branchName,
                  state: 'open',
                });
                const existingPR = existingPRs[0];
                if (existingPR) {
                  await github.rest.pulls.update({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    pull_number: existingPR.number,
                    title: implResult.pr_title || 'Implement ' + issue.title,
                    body: implResult.pr_body || 'Implementación automática de #' + issue.number,
                  });
                  pull = existingPR;
                }
              } else if (e.status === 403) {
                core.warning('PR creation blocked by repo permissions. Notifying on issue.');
              } else {
                throw e;
              }
            }

            if (pull) {
              try {
                await github.rest.pulls.merge({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  pull_number: pull.number,
                  merge_method: 'squash',
                });
                core.info('PR #' + pull.number + ' merged automatically');
                await github.rest.issues.update({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  issue_number: issue.number,
                  state: 'closed',
                });
                try {
                  await github.rest.git.deleteRef({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    ref: 'heads/' + branchName,
                  });
                  core.info('Branch ' + branchName + ' deleted');
                } catch (deleteErr) {
                  core.warning('Branch deletion skipped: ' + deleteErr.message);
                }
              } catch (mergeErr) {
                core.warning('Auto-merge skipped: ' + mergeErr.message);
              }

              const body = pull.body
                ? (pull.body.includes('🔄 Actualizado') ? pull.body : pull.body + '\n\n---\n🔄 Actualizado automáticamente con nueva implementación.')
                : implResult.pr_body || 'Implementación automática de #' + issue.number;
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: issue.number,
                body: '## 🚀 PR ' + (pull.number ? 'actualizado' : 'generado') + '\n\n[' + (implResult.pr_title || 'Implement #' + issue.number) + '](https://github.com/' + context.repo.owner + '/' + context.repo.repo + '/pull/' + pull.number + ')',
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: issue.number,
                body: '## ⚠️ No se pudo crear/actualizar el PR\nPermisos de Actions insuficientes para crear PRs en este repositorio.',
              });
            }
```

## Edge cases y lecciones aprendidas

| Situación | Comportamiento |
|---|---|
| Issue editado | Skipea implementación (solo re-analiza) |
| Comentario de bot | Ignorado (evita loops) |
| Branch ya existe | Borra y recrea con nuevo commit |
| PR ya existe | Actualiza título y cuerpo |
| Labels no se pueden crear | Warning, no bloquea |
| 429 rate limit | Backoff 5s→10s→20s, luego falla |
| LLM dice "impossible" | Comenta en el issue y termina |
| Auto-merge falla | Warning, no bloquea — el PR queda abierto |
| 403 en creación de PR | Notifica en el issue |

### Requisito crítico: fetch timeout

NVIDIA NIM puede tardar varios minutos en empezar a responder (modelo se carga en caliente). El `headersTimeout` por defecto de undici (Node 20) es ~5-10s y aborta la conexión. El `AbortController` con 360s resuelve esto.

### Adaptar a otros proyectos

El `fileList` y el contexto del proyecto en `implPrompt` están hardcodeados para Tetris. Para otros repos cambia:
1. `fileList` — los archivos que necesita conocer el LLM
2. "El proyecto es Tetris en JavaScript vanilla..." por la descripción del proyecto real
