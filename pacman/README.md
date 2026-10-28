# Maze Muncher

An original maze arcade game. Guide the muncher through hand-built mazes, eat every crumb, and keep ahead of four shades. It is not affiliated with Namco, Pac-Man, or any other maze-chase trademark, and it does not use those names, mazes, or art.

Everything runs in the browser: HTML, CSS, and vanilla JavaScript modules on a canvas. There is no build step and no network request. Sound is synthesized with the Web Audio API. The best score is stored in `localStorage`.

## Play

On GitHub Pages, after this folder is merged, the game is served at:

https://denovo2026.github.io/pacman/

Locally, modules need a static server (opening the file directly can block them):

```bash
cd pacman
python3 -m http.server 8080
```

Then open http://localhost:8080/

## How to play

- Eat every crumb to clear the maze. Power orbs turn the shades vulnerable; eating more than one during a single orb raises the chain (200, 400, 800, 1600).
- A treat appears twice each maze. Levels cycle through Lantern Court, Spiral Vault, and Twin Canals, and the shades get faster.
- Blaze chases. Hex aims ahead of you. Jinx wanders. Quill patrols until you come close.
- You start with 3 lives. Another life is awarded every 10,000 points, up to 5.

## Controls

- Arrow keys or WASD
- Swipe the board, or use the on-screen pad
- P or Esc pauses. Enter or Space starts, resumes, or plays again
- R restarts the run from level 1
- Sound button mutes the synthesized audio

## Checks

```bash
cd pacman
npm test
```

## Files

- `index.html` — cabinet, screens, and touch pad
- `css/style.css` — layout
- `js/main.js` — loop, score saving, and screens
- `js/game.js` — rules and shade personalities
- `js/motion.js` — grid movement, corner turns, tunnels
- `js/maze.js` / `js/levels.js` — three mazes
- `js/render.js` — canvas drawing
- `js/audio.js` — Web Audio effects
- `js/input.js` — keyboard, swipe, and pad
- `tests/logic.test.mjs` — movement and rules
