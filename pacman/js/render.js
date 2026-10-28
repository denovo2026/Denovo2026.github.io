/**
 * Canvas renderer. World coordinates put every tile's center on an integer,
 * so tile (c, r) spans [c-0.5, c+0.5] × [r-0.5, r+0.5].
 */

import { VECTORS } from './motion.js';

const PLAYER = '#ff8618';
const DIR_ANGLE = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };

export function resizeBoard(canvas, wrap, field, cols, rows) {
  const rect = field.getBoundingClientRect();
  const aspect = cols / rows;
  let w = rect.width;
  let h = rect.height;
  if (!(w > 0) || !(h > 0)) {
    w = 480;
    h = 520;
  }
  if (w / h > aspect) w = h * aspect;
  else h = w / aspect;
  w = Math.max(140, Math.floor(w));
  h = Math.max(140, Math.floor(w / aspect));
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  const scaleX = bw / cols;
  const scaleY = bh / rows;
  ctx.setTransform(scaleX, 0, 0, scaleY, scaleX / 2, scaleY / 2);
  return ctx;
}

export function draw(ctx, game) {
  const maze = game.maze;
  const cols = maze.cols;
  const rows = maze.rows;
  ctx.save();
  if (game.shake > 0) {
    ctx.translate(
      Math.sin(game.anim * 48) * game.shake * 0.07,
      Math.cos(game.anim * 41) * game.shake * 0.07,
    );
  }
  ctx.clearRect(-1, -1, cols + 2, rows + 2);
  drawFloor(ctx, maze);
  drawWalls(ctx, maze);
  drawDots(ctx, maze, game.anim);
  drawFruit(ctx, game);
  for (const ghost of game.ghosts) drawGhost(ctx, game, ghost);
  if (game.state !== 'levelclear' || game.stateTimer > 0.15) drawPlayer(ctx, game);
  drawParticles(ctx, game);
  drawPopups(ctx, game);
  drawBanner(ctx, game);
  if (game.debug) drawDebug(ctx, game);
  ctx.restore();
}

function palette(maze) {
  return maze.palette || {
    floor: '#0d1428',
    wall: '#2a3d86',
    wallHi: '#4d62b8',
    edge: '#9aefff',
    house: '#070b16',
    gate: '#ffd0ea',
  };
}

function drawFloor(ctx, maze) {
  const pal = palette(maze);
  ctx.fillStyle = pal.floor;
  ctx.fillRect(-0.5, -0.5, maze.cols, maze.rows);
  ctx.fillStyle = pal.house;
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (maze.tiles[y][x] === 'house') ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
    }
  }
}

function isSolid(maze, x, y) {
  if (x < 0 || y < 0 || x >= maze.cols || y >= maze.rows) return true;
  return maze.tiles[y][x] === 'wall';
}

function drawWalls(ctx, maze) {
  const pal = palette(maze);
  ctx.fillStyle = pal.wall;
  ctx.beginPath();
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (maze.tiles[y][x] !== 'wall') continue;
      ctx.rect(x - 0.46, y - 0.46, 0.92, 0.92);
    }
  }
  ctx.fill();

  ctx.fillStyle = pal.wallHi;
  ctx.beginPath();
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (maze.tiles[y][x] !== 'wall') continue;
      if (isSolid(maze, x, y - 1)) continue;
      ctx.rect(x - 0.46, y - 0.46, 0.92, 0.16);
    }
  }
  ctx.fill();

  ctx.strokeStyle = pal.edge;
  ctx.lineWidth = 0.065;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (maze.tiles[y][x] !== 'wall') continue;
      const pad = 0.42;
      if (!isSolid(maze, x, y - 1)) {
        ctx.moveTo(x - pad, y - 0.46);
        ctx.lineTo(x + pad, y - 0.46);
      }
      if (!isSolid(maze, x, y + 1)) {
        ctx.moveTo(x - pad, y + 0.46);
        ctx.lineTo(x + pad, y + 0.46);
      }
      if (!isSolid(maze, x - 1, y)) {
        ctx.moveTo(x - 0.46, y - pad);
        ctx.lineTo(x - 0.46, y + pad);
      }
      if (!isSolid(maze, x + 1, y)) {
        ctx.moveTo(x + 0.46, y - pad);
        ctx.lineTo(x + 0.46, y + pad);
      }
    }
  }
  ctx.stroke();

  if (maze.door) {
    const gate = maze.door;
    ctx.fillStyle = pal.gate;
    ctx.fillRect(gate.x - 0.28, gate.y - 0.08, 0.56, 0.16);
    ctx.fillStyle = 'rgba(8, 10, 18, 0.85)';
    ctx.fillRect(gate.x - 0.08, gate.y - 0.08, 0.16, 0.16);
  }
}

function drawDots(ctx, maze, anim) {
  ctx.fillStyle = '#fff4d2';
  ctx.beginPath();
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (maze.dotAt(x, y) !== 1) continue;
      ctx.moveTo(x + 0.11, y);
      ctx.arc(x, y, 0.11, 0, Math.PI * 2);
    }
  }
  ctx.fill();

  const pulse = 0.22 + Math.sin(anim * 5.2) * 0.05;
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (maze.dotAt(x, y) !== 2) continue;
      const glow = ctx.createRadialGradient(x, y, 0.04, x, y, pulse + 0.28);
      glow.addColorStop(0, '#ffffff');
      glow.addColorStop(0.35, '#ff4fa3');
      glow.addColorStop(1, 'rgba(255, 79, 163, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, pulse + 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff6fb';
      ctx.beginPath();
      ctx.arc(x, y, pulse * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawFruit(ctx, game) {
  const fruit = game.fruit;
  if (!fruit || game.state === 'dying') return;
  const { x, y } = fruit;
  const remain = fruit.timer / fruit.max;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.arc(0, 0, 0.42, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remain);
  ctx.stroke();
  ctx.fillStyle = fruit.color;
  if (fruit.id === 'gem') {
    ctx.beginPath();
    ctx.moveTo(0, -0.28);
    ctx.lineTo(0.24, 0);
    ctx.lineTo(0, 0.28);
    ctx.lineTo(-0.24, 0);
    ctx.closePath();
    ctx.fill();
  } else if (fruit.id === 'star') {
    star(ctx, 0, 0, 0.12, 0.28);
    ctx.fill();
  } else if (fruit.id === 'crown') {
    ctx.beginPath();
    ctx.moveTo(-0.24, 0.16);
    ctx.lineTo(-0.24, -0.02);
    ctx.lineTo(-0.1, 0.08);
    ctx.lineTo(0, -0.2);
    ctx.lineTo(0.1, 0.08);
    ctx.lineTo(0.24, -0.02);
    ctx.lineTo(0.24, 0.16);
    ctx.closePath();
    ctx.fill();
  } else if (fruit.id === 'pip') {
    ctx.beginPath();
    ctx.arc(0, 0.04, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#d8ffe8';
    ctx.beginPath();
    ctx.moveTo(0, -0.16);
    ctx.lineTo(0.08, -0.28);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0.02, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2f8f4e';
    ctx.beginPath();
    ctx.ellipse(0.08, -0.16, 0.1, 0.06, -0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function star(ctx, x, y, inner, outer) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function withWrap(ctx, cols, x, y, drawAt) {
  drawAt(x, y);
  if (x < 1.2) drawAt(x + cols, y);
  if (x > cols - 2.2) drawAt(x - cols, y);
}

function drawPlayer(ctx, game) {
  const player = game.player;
  withWrap(ctx, game.maze.cols, player.x, player.y, (x, y) => {
    let angle = DIR_ANGLE[player.dir] ?? Math.PI;
    let mouth = player.moved ? 0.16 + Math.abs(Math.sin(game.anim * 15)) * 0.52 : 0.2;
    let scale = 1;
    if (game.state === 'dying') {
      const t = 1 - Math.max(0, game.stateTimer) / 1.15;
      mouth = 0.25 + t * 1.2;
      angle += t * 6;
      scale = t < 0.45 ? 1 : Math.max(0.05, 1 - (t - 0.45) / 0.55);
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
    shadow(ctx, 0.34);
    ctx.fillStyle = PLAYER;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 0.42, mouth, Math.PI * 2 - mouth);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 0.045;
    ctx.strokeStyle = '#6a3208';
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.38)';
    ctx.beginPath();
    ctx.arc(-0.1, -0.12, 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1b1020';
    ctx.beginPath();
    ctx.arc(0.05, -0.16, 0.065, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(0.07, -0.175, 0.025, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

function shadow(ctx, dy) {
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(0, dy, 0.26, 0.08, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawGhost(ctx, game, ghost) {
  withWrap(ctx, game.maze.cols, ghost.x, ghost.y, (x, y) => {
    const frightened = ghost.mode === 'fright'
      || ((ghost.mode === 'house' || ghost.mode === 'leaving') && game.frightTimer > 0);
    const flash = frightened && game.frightTimer > 0 && game.frightTimer < 1.7 && Math.floor(game.anim * 9) % 2 === 0;
    ctx.save();
    ctx.translate(x, y);
    shadow(ctx, 0.4);
    if (ghost.mode !== 'eaten') {
      ctx.fillStyle = frightened ? (flash ? '#f7f8ff' : '#6d86ff') : ghost.color;
      ghostSkirt(ctx, game.anim, ghost.phase);
      ctx.fill();
      if (!frightened) accessory(ctx, ghost.accessory, ghost.color);
    }
    eyes(ctx, ghost, frightened && ghost.mode !== 'eaten');
    ctx.restore();
  });
}

function ghostSkirt(ctx, time, phase) {
  const r = 0.4;
  ctx.beginPath();
  ctx.arc(0, -0.02, r, Math.PI, 0);
  ctx.lineTo(r, 0.32);
  const waves = 3;
  const span = r * 2;
  for (let i = 0; i < waves; i++) {
    const x0 = r - (i * span) / waves;
    const x1 = r - ((i + 1) * span) / waves;
    const mid = (x0 + x1) / 2;
    const dip = 0.1 + Math.sin(time * 9 + phase + i) * 0.045;
    ctx.quadraticCurveTo(mid, 0.32 + dip, x1, 0.32);
  }
  ctx.closePath();
}

function accessory(ctx, kind) {
  ctx.save();
  if (kind === 'horns') {
    ctx.fillStyle = '#ffd0d8';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 0.22, -0.28);
      ctx.lineTo(side * 0.12, -0.52);
      ctx.lineTo(side * 0.02, -0.28);
      ctx.closePath();
      ctx.fill();
    }
  } else if (kind === 'gem') {
    ctx.fillStyle = '#f4e8ff';
    ctx.beginPath();
    ctx.moveTo(0, -0.5);
    ctx.lineTo(0.1, -0.38);
    ctx.lineTo(0, -0.26);
    ctx.lineTo(-0.1, -0.38);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'mask') {
    ctx.fillStyle = '#5a4308';
    for (const dx of [-0.16, 0, 0.16]) {
      ctx.beginPath();
      ctx.arc(dx, 0.16, 0.045, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === 'visor') {
    ctx.fillStyle = 'rgba(8, 40, 46, 0.8)';
    ctx.fillRect(-0.28, -0.12, 0.56, 0.12);
  }
  ctx.restore();
}

function eyes(ctx, ghost, frightened) {
  const look = VECTORS[ghost.dir] || { x: 0, y: 0 };
  for (const side of [-0.14, 0.14]) {
    ctx.fillStyle = frightened ? '#24305f' : '#fff';
    ctx.beginPath();
    ctx.ellipse(side, -0.04, frightened ? 0.075 : 0.11, frightened ? 0.1 : 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    if (!frightened) {
      ctx.fillStyle = '#161a2e';
      ctx.beginPath();
      ctx.arc(side + look.x * 0.07, -0.04 + look.y * 0.07, 0.055, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (frightened) {
    ctx.strokeStyle = '#24305f';
    ctx.lineWidth = 0.045;
    ctx.beginPath();
    ctx.moveTo(-0.16, 0.16);
    ctx.quadraticCurveTo(-0.08, 0.26, 0, 0.14);
    ctx.quadraticCurveTo(0.08, 0.02, 0.16, 0.16);
    ctx.stroke();
  }
}

function drawParticles(ctx, game) {
  for (const particle of game.particles) {
    ctx.globalAlpha = Math.max(0, particle.life / particle.max);
    ctx.fillStyle = particle.color;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPopups(ctx, game) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const popup of game.popups) {
    ctx.globalAlpha = Math.max(0, Math.min(1, popup.life / popup.max));
    ctx.fillStyle = popup.color;
    ctx.font = 'bold 0.48px Trebuchet MS, Segoe UI, sans-serif';
    ctx.fillText(popup.text, popup.x, popup.y);
  }
  ctx.globalAlpha = 1;
}

function drawBanner(ctx, game) {
  if (game.state !== 'ready' && game.state !== 'levelclear') return;
  const cols = game.maze.cols;
  const rows = game.maze.rows;
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  ctx.fillStyle = 'rgba(6, 10, 20, 0.78)';
  roundRect(ctx, cx - 5.2, cy - 1.35, 10.4, 2.7, 0.35);
  ctx.fill();
  ctx.strokeStyle = 'rgba(154, 239, 255, 0.7)';
  ctx.lineWidth = 0.06;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f6f1de';
  ctx.font = 'bold 0.72px Trebuchet MS, Segoe UI, sans-serif';
  if (game.state === 'ready') {
    ctx.fillText('GET READY', cx, cy - 0.35);
    ctx.fillStyle = '#9aefff';
    ctx.font = '0.4px Trebuchet MS, Segoe UI, sans-serif';
    ctx.fillText(`Level ${game.level}  ·  ${game.maze.name}`, cx, cy + 0.5);
  } else {
    ctx.fillText('MAZE CLEAR', cx, cy - 0.35);
    ctx.fillStyle = '#9dffdf';
    ctx.font = '0.42px Trebuchet MS, Segoe UI, sans-serif';
    ctx.fillText(`Bonus +${game.levelBonus}`, cx, cy + 0.5);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawDebug(ctx, game) {
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 0.04;
  for (const ghost of game.ghosts) {
    const target = game.targetFor(ghost);
    if (!target) continue;
    ctx.beginPath();
    ctx.moveTo(ghost.x, ghost.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
  }
}
