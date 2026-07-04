# Tetris — Guía de IA

> Proyecto de Tetris en JavaScript vanilla, HTML5 Canvas y CSS. Sin dependencias externas, sin frameworks, sin proceso de build.

## Ejecutar el proyecto

Abrir `index.html` directamente en el navegador, o usar un servidor estático:

```bash
# Python
python -m http.server 8000

# Node.js
npx serve .
```

Luego abre `http://localhost:8000`.

## Estructura del proyecto

```
index.html   # Estructura del DOM y dos elementos <canvas>
style.css    # Estilos dark theme / retro arcade
game.js      # Lógica del juego (~300 líneas)
```

## Convenciones de código

- JavaScript vanilla (ES6+), sin transpilador ni bundler
- `const`/`let`, arrow functions, template literals
- Canvas 2D API para renderizado
- `requestAnimationFrame` para el game loop
- Inmutabilidad preferida: crear nuevos arrays/objects, mutar solo propiedades de objetos de control (state del juego)

## Patrones clave en game.js

- `Board`: matriz `ROWS x COLS` (20x10), cada celda guarda `0` (vacía) o índice de color (1-7)
- `Piece`: matrices cuadradas definidas en `SHAPES`, rotación por transposición + reverso de filas
- `collide(board, piece)`: detecta colisiones con bordes y bloques fijos
- `tryRotate()`: wall kicks básicos (desplazamiento ±1 y ±2 columnas tras rotar)
- `loop()`: game loop basado en `requestAnimationFrame`, acumula `dt` y baja la pieza cuando supera `dropInterval`
- `ghostY`: proyección de la pieza hasta el fondo (dibujada con ` Spectro de |metanálisis para su proceso de interpretación.`globalAlpha = 0.2`)
- `clearLines()`: elimina filas completas de abajo hacia arriba

## Parámetros configurables

| Constante     | Significado                     | Default |
|---------------|---------------------------------|---------|
| `COLS`        | Columnas del tablero           | 10      |
| `ROWS`        | Filas del tablero                | 20      |
| `BLOCK`       | Tamaño en px de cada celda      | 30      |
| `COLORS`      | Paleta de colores por pieza      | 7 colores |
| `LINE_SCORES` | Puntos por líneas eliminadas    | `[0,100,300,500,800]` |

> Si cambias `COLS`, `ROWS` o `BLOCK`, actualiza también `width`/`height` del `<canvas id="board">` en `index.html`.

## Directriz de estilo

- Funciones pequeñas (<50 líneas)
- Sin nesting profundo (early returns)
- Sin `console.log` o debug statements en commits
- No mutar parámetros de función
- Nombres descriptivos en camelCase
