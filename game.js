'use strict';

const COLS = 10;
const ROWS = 20;
const BLOCK = 30;

const WILDCARD = -1;
const POWERUP_INTERVAL_INITIAL = 8;
const POWERUP_INTERVAL = 12;
const FREEZE_DURATION = 5000;
const POWERUP_BONUS = 200;
const POWERUP = { BOMB: 8, LASER: 9, DYE: 10, GRAVITY: 11, FREEZE: 12 };

const COLORS = [
  null,
  '#4dd0e1', // I - cyan
  '#ffd54f', // O - yellow
  '#ba68c8', // T - purple
  '#81c784', // S - green
  '#e57373', // Z - red
  '#90CAF9', // J - pale blue
  '#ffb74d', // L - orange
  '#ff4444', // BOMB
  '#ffdd44', // LASER
  '#dd88ff', // DYE
  '#66dd88', // GRAVITY
  '#66bbff', // FREEZE
];

const PIECES = [
  null,
  [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], // I
  [[2,2],[2,2]],                               // O
  [[0,3,0],[3,3,3],[0,0,0]],                  // T
  [[0,4,4],[4,4,0],[0,0,0]],                  // S
  [[5,5,0],[0,5,5],[0,0,0]],                  // Z
  [[6,0,0],[6,6,6],[0,0,0]],                  // J
  [[0,0,7],[7,7,7],[0,0,0]],                  // L
];

const POWERUP_SHAPES = {
  8:  [[0,8,0],[8,8,8],[0,8,0]],              // Bomb (cross)
  9:  [[9,9,9,9,9]],                            // Laser (horizontal bar)
  10: [[10,0,10],[0,10,0],[10,0,10]],          // Dye (X shape)
  11: [[0,11,0],[11,11,11]],                   // Gravity (down arrow)
  12: [[12,12,12],[0,12,0],[0,12,0]],          // Freeze (downward T)
};

const POWERUP_NAMES = {
  8: 'BOMBA', 9: 'RAYO', 10: 'TINTE', 11: 'GRAVEDAD', 12: 'CONGELAR',
};

const LINE_SCORES = [0, 100, 300, 500, 800];

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const nextCanvas = document.getElementById('next-canvas');
const nextCtx = nextCanvas.getContext('2d');
const scoreEl = document.getElementById('score');
const linesEl = document.getElementById('lines');
const levelEl = document.getElementById('level');
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayScore = document.getElementById('overlay-score');
const restartBtn = document.getElementById('restart-btn');
const themeToggle = document.getElementById('checkbox');
const powerupNameEl = document.getElementById('powerup-name');
const powerupSection = document.getElementById('powerup-section');
const freezeSection = document.getElementById('freeze-section');
const freezeTimerEl = document.getElementById('freeze-timer');

let board, current, next, score, lines, level, paused, gameOver, lastTime, dropAccum, dropInterval, animId;
let pendingPowerUp, nextPowerUpLines, freezeTimer, flashAlpha;

// ── Board & Pieces ────────────────────────────────────────────────

function createBoard() {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
}

function randomPowerUpPiece() {
  const types = [POWERUP.BOMB, POWERUP.LASER, POWERUP.DYE, POWERUP.GRAVITY, POWERUP.FREEZE];
  const type = types[Math.floor(Math.random() * types.length)];
  const shape = POWERUP_SHAPES[type].map(row => [...row]);
  return { type, shape, x: Math.floor(COLS / 2) - Math.floor(shape[0].length / 2), y: 0 };
}

function randomPiece() {
  if (pendingPowerUp) {
    pendingPowerUp = false;
    return randomPowerUpPiece();
  }
  const type = Math.floor(Math.random() * 7) + 1;
  const shape = PIECES[type].map(row => [...row]);
  return { type, shape, x: Math.floor(COLS / 2) - Math.floor(shape[0].length / 2), y: 0 };
}

function collide(shape, ox, oy) {
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const nx = ox + c;
      const ny = oy + r;
      if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
      // wildcards (<=0) don't block; only positive values are solid blocks
      if (ny >= 0 && board[ny][nx] > 0) return true;
    }
  }
  return false;
}

function rotateCW(shape) {
  const rows = shape.length, cols = shape[0].length;
  const result = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      result[c][rows - 1 - r] = shape[r][c];
  return result;
}

function tryRotate() {
  const rotated = rotateCW(current.shape);
  const kicks = [0, -1, 1, -2, 2];
  for (const kick of kicks) {
    if (!collide(rotated, current.x + kick, current.y)) {
      current.shape = rotated;
      current.x += kick;
      return;
    }
  }
}

function merge() {
  for (let r = 0; r < current.shape.length; r++)
    for (let c = 0; c < current.shape[r].length; c++)
      if (current.shape[r][c])
        board[current.y + r][current.x + c] = current.shape[r][c];
}

function clearLines() {
  let cleared = 0;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r].every(v => v !== 0)) {
      board.splice(r, 1);
      board.unshift(new Array(COLS).fill(0));
      cleared++;
      r++;
    }
  }
  if (cleared) {
    lines += cleared;
    score += (LINE_SCORES[cleared] || 0) * level;
    level = Math.floor(lines / 10) + 1;
    dropInterval = Math.max(100, 1000 - (level - 1) * 90);
    updateHUD();

    if (!pendingPowerUp && lines >= nextPowerUpLines) {
      pendingPowerUp = true;
      nextPowerUpLines += POWERUP_INTERVAL;
    }
  }
}

// ── Power-up Effects ──────────────────────────────────────────────

function fireBomb(piece) {
  for (let r = piece.y; r <= piece.y + 2; r++) {
    if (r < 0 || r >= ROWS) continue;
    for (let c = piece.x; c <= piece.x + 2; c++) {
      if (c >= 0 && c < COLS) board[r][c] = 0;
    }
  }
}

function fireLaser(piece) {
  // Clear the row the piece is on
  const row = Math.min(ROWS - 1, Math.max(0, piece.y));
  for (let c = 0; c < COLS; c++) board[row][c] = 0;
  // Clear the column at center of the laser bar
  const col = Math.min(COLS - 1, Math.max(0, piece.x + 2));
  for (let r = 0; r < ROWS; r++) if (board[r][col] > 0) board[r][col] = 0;
}

function fireDye() {
  // Collect regular block colors (1-7) present on the board
  const colors = new Set();
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (board[r][c] > 0 && board[r][c] < 8) colors.add(board[r][c]);
  if (!colors.size) return;
  const target = [...colors][Math.floor(Math.random() * colors.size)];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (board[r][c] === target) board[r][c] = WILDCARD;
}

function fireGravity() {
  for (let c = 0; c < COLS; c++) {
    let wr = ROWS - 1;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (board[r][c] > 0) {
        board[wr][c] = board[r][c];
        if (wr !== r) board[r][c] = 0;
        wr--;
      } else if (board[r][c] === WILDCARD) {
        board[r][c] = 0; // wildcards get removed by gravity
      }
    }
    for (; wr >= 0; wr--) board[wr][c] = 0;
  }
}

function firePowerUp(piece) {
  flashAlpha = 0.25;
  score += POWERUP_BONUS * level;
  updateHUD();

  switch (piece.type) {
    case POWERUP.BOMB: fireBomb(piece); break;
    case POWERUP.LASER: fireLaser(piece); break;
    case POWERUP.DYE: fireDye(); break;
    case POWERUP.GRAVITY: fireGravity(); break;
  }
  clearLines();
}

// ── Piece Movement ────────────────────────────────────────────────

function ghostY() {
  let gy = current.y;
  while (!collide(current.shape, current.x, gy + 1)) gy++;
  return gy;
}

function hardDrop() {
  const gy = ghostY();
  score += (gy - current.y) * 2;
  current.y = gy;
  lockPiece();
}

function softDrop() {
  if (!collide(current.shape, current.x, current.y + 1)) {
    current.y++;
    score += 1;
    updateHUD();
  } else {
    lockPiece();
  }
}

function lockPiece() {
  // Non-freeze power-ups fire their effect instead of merging
  if (current.type >= 8 && current.type !== POWERUP.FREEZE) {
    firePowerUp(current);
    spawn();
    return;
  }
  merge();
  clearLines();
  if (current.type === POWERUP.FREEZE) {
    freezeTimer = FREEZE_DURATION;
    flashAlpha = 0.2;
    updateFreezeIndicator();
  }
  spawn();
}

// ── Game Loop ─────────────────────────────────────────────────────

function spawn() {
  current = next;
  next = randomPiece();
  updatePowerUpIndicator();
  if (collide(current.shape, current.x, current.y)) {
    endGame();
    return;
  }
  drawNext();
}

function loop(ts) {
  const dt = ts - lastTime;
  lastTime = ts;

  // Freeze pauses automatic falling
  if (freezeTimer > 0) {
    freezeTimer = Math.max(0, freezeTimer - dt);
    updateFreezeIndicator();
  } else {
    dropAccum += dt;
  }

  if (dropAccum >= dropInterval) {
    dropAccum = 0;
    if (!collide(current.shape, current.x, current.y + 1)) {
      current.y++;
    } else {
      lockPiece();
    }
  }
  draw();
  animId = requestAnimationFrame(loop);
}

// ── HUD ───────────────────────────────────────────────────────────

function updateHUD() {
  scoreEl.textContent = score.toLocaleString();
  linesEl.textContent = lines;
  levelEl.textContent = level;
}

function updatePowerUpIndicator() {
  if (current && current.type >= 8) {
    powerupNameEl.textContent = POWERUP_NAMES[current.type];
    powerupSection.style.display = 'block';
  } else if (next && next.type >= 8) {
    powerupNameEl.textContent = 'PRÓX: ' + POWERUP_NAMES[next.type];
    powerupSection.style.display = 'block';
  } else {
    powerupSection.style.display = 'none';
  }
}

function updateFreezeIndicator() {
  if (freezeTimer > 0) {
    freezeSection.style.display = 'block';
    freezeTimerEl.textContent = `❄️ ${(freezeTimer / 1000).toFixed(1)}s`;
  } else {
    freezeSection.style.display = 'none';
  }
}

// ── Rendering ─────────────────────────────────────────────────────

function drawBlock(context, x, y, colorIndex, size, alpha) {
  if (!colorIndex) return;

  // Wildcard — drawn as semi-transparent white block
  if (colorIndex === WILDCARD) {
    context.globalAlpha = 0.25;
    context.fillStyle = '#ffffff';
    context.fillRect(x * size + 1, y * size + 1, size - 2, size - 2);
    context.strokeStyle = 'rgba(255,255,255,0.4)';
    context.lineWidth = 1;
    context.strokeRect(x * size + 2, y * size + 2, size - 4, size - 4);
    context.globalAlpha = 1;
    return;
  }

  const color = COLORS[colorIndex];
  context.globalAlpha = alpha ?? 1;
  context.fillStyle = color;
  context.fillRect(x * size + 1, y * size + 1, size - 2, size - 2);
  context.fillStyle = 'rgba(255,255,255,0.12)';
  context.fillRect(x * size + 1, y * size + 1, size - 2, 4);
  context.globalAlpha = 1;
}

function drawGrid() {
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--grid-line');
  ctx.lineWidth = 0.5;
  for (let c = 1; c < COLS; c++) {
    ctx.beginPath();
    ctx.moveTo(c * BLOCK, 0);
    ctx.lineTo(c * BLOCK, ROWS * BLOCK);
    ctx.stroke();
  }
  for (let r = 1; r < ROWS; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * BLOCK);
    ctx.lineTo(ROWS * BLOCK, r * BLOCK);
    ctx.stroke();
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();

  // Board
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      drawBlock(ctx, c, r, board[r][c], BLOCK);

  // ponytail: don't draw floating pieces after game over
  if (gameOver) return;

  // Ghost
  const gy = ghostY();
  for (let r = 0; r < current.shape.length; r++)
    for (let c = 0; c < current.shape[r].length; c++)
      if (current.shape[r][c])
        drawBlock(ctx, current.x + c, gy + r, current.shape[r][c], BLOCK, 0.2);

  // Current piece
  for (let r = 0; r < current.shape.length; r++)
    for (let c = 0; c < current.shape[r].length; c++)
      drawBlock(ctx, current.x + c, current.y + r, current.shape[r][c], BLOCK);

  // Power-up flash overlay
  if (flashAlpha > 0) {
    ctx.fillStyle = `rgba(255,255,255,${flashAlpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function drawNext() {
  const NB = 30;
  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  const shape = next.shape;
  const offX = Math.floor((4 - shape[0].length) / 2);
  const offY = Math.floor((4 - shape.length) / 2);
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++)
      drawBlock(nextCtx, offX + c, offY + r, shape[r][c], NB);
}

// ── State Management ──────────────────────────────────────────────

function endGame() {
  gameOver = true;
  cancelAnimationFrame(animId);
  draw();
  overlayTitle.textContent = 'GAME OVER';
  overlayScore.textContent = `Puntuación: ${score.toLocaleString()}`;
  overlay.classList.remove('hidden');
}

function togglePause() {
  if (gameOver) return;
  paused = !paused;
  if (!paused) {
    lastTime = performance.now();
    loop(lastTime);
  } else {
    cancelAnimationFrame(animId);
    overlayTitle.textContent = 'PAUSA';
    overlayScore.textContent = '';
    overlay.classList.remove('hidden');
  }
}

function init() {
  board = createBoard();
  score = 0;
  lines = 0;
  level = 1;
  paused = false;
  gameOver = false;
  dropInterval = 1000;
  dropAccum = 0;
  freezeTimer = 0;
  flashAlpha = 0;
  pendingPowerUp = false;
  nextPowerUpLines = POWERUP_INTERVAL_INITIAL;
  lastTime = performance.now();
  next = randomPiece();
  spawn();
  updateHUD();
  updatePowerUpIndicator();
  updateFreezeIndicator();
  overlay.classList.add('hidden');
  cancelAnimationFrame(animId);
  animId = requestAnimationFrame(loop);
  draw();
  drawNext();
}

// ── Theme ─────────────────────────────────────────────────────────

function toggleTheme(e) {
  if (e.target.checked) {
    document.body.setAttribute('data-theme', 'light');
  } else {
    document.body.removeAttribute('data-theme');
  }
  draw();
  drawNext();
}

// ── Input ─────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.code === 'KeyP') { togglePause(); return; }
  if (paused || gameOver) return;
  switch (e.code) {
    case 'ArrowLeft':
      if (!collide(current.shape, current.x - 1, current.y)) current.x--;
      break;
    case 'ArrowRight':
      if (!collide(current.shape, current.x + 1, current.y)) current.x++;
      break;
    case 'ArrowDown':
      softDrop();
      break;
    case 'ArrowUp':
    case 'KeyX':
      tryRotate();
      break;
    case 'Space':
      e.preventDefault();
      hardDrop();
      break;
  }
  updateHUD();
});

restartBtn.addEventListener('click', init);
themeToggle.addEventListener('change', toggleTheme);

init();
