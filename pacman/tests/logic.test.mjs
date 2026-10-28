import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bootCheck, Game, tuningFor } from '../js/game.js';
import { LEVELS } from '../js/levels.js';
import { analyzeMaze, parseMaze } from '../js/maze.js';
import { advance, currentTile, tileDist } from '../js/motion.js';

function tick(game, frames, input = {}) {
  for (let i = 0; i < frames; i++) game.update(1 / 60, input);
}

function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function actor(partial) {
  return {
    kind: 'player',
    dir: null,
    wish: null,
    justArrived: false,
    forceDecide: false,
    moved: false,
    ...partial,
  };
}

test('every shipped maze is sealed, reachable, and original-sized', () => {
  assert.equal(LEVELS.length, 3);
  const names = new Set(LEVELS.map((level) => level.name));
  assert.equal(names.size, 3);
  for (const level of LEVELS) {
    assert.equal(level.rows.length, 23);
    assert.equal(level.rows[0].length, 21);
    const maze = parseMaze(level);
    assert.deepEqual(analyzeMaze(maze), []);
  }
  assert.deepEqual(bootCheck(), []);
});

test('player walks corridors, stops at walls, and buffers a corner', () => {
  const maze = parseMaze({
    name: 'Tiny',
    rows: [
      '#######',
      '#S....#',
      '###.###',
      '#.....#',
      '#######',
    ],
  });
  const player = actor({ x: 1, y: 1, dir: 'right' });
  advance(player, maze, 0.5, null, null);
  assert.ok(player.x > 1 && player.x < 2);
  assert.equal(player.y, 1);

  const blocked = actor({ x: 1, y: 1, dir: 'up' });
  advance(blocked, maze, 1, 'up', null);
  assert.equal(blocked.x, 1);
  assert.equal(blocked.y, 1);

  const turning = actor({ x: 2.4, y: 1, dir: 'right' });
  advance(turning, maze, 1.2, 'down', null);
  assert.ok(turning.y > 1.2, `expected to leave the row, y=${turning.y}`);
  assert.ok(Math.abs(turning.x - 3) < 0.05, `expected to snap onto the column, x=${turning.x}`);
});

test('immediate reverse and tunnel wrap', () => {
  const maze = parseMaze({
    name: 'Wrap',
    rows: ['#####', 'S... ', '#####'],
  });
  const player = actor({ x: 0, y: 1, dir: 'right' });
  advance(player, maze, 1.2, 'left', null);
  assert.ok(player.x > maze.cols - 2, `wrapped x=${player.x}`);

  const back = actor({ x: 2, y: 1, dir: 'right' });
  const before = back.x;
  advance(back, maze, 0.4, 'left', null);
  assert.ok(back.x < before);
  assert.equal(back.dir, 'left');
});

test('crumbs, power orbs, chain devour, death, and level clear', () => {
  const game = new Game({
    highScore: 5000,
    rng: rng(3),
    levels: [
      {
        name: 'Pocket',
        palette: LEVELS[0].palette,
        rows: [
          '#########',
          '#S......#',
          '#.##.##.#',
          '#.o.....#',
          '##D######',
          '#HHH#...#',
          '#HHH#.F.#',
          '#########',
        ],
      },
      LEVELS[0],
    ],
  });
  game.startGame('right');
  assert.equal(game.state, 'ready');
  tick(game, 80, { dir: 'right' });
  assert.equal(game.state, 'playing');
  assert.ok(game.score > 0, 'eating crumbs scores');
  assert.ok(game.dotsLeft < game.maze.totalDots);

  const orb = game.ghosts[0];
  orb.mode = 'active';
  orb.x = 4;
  orb.y = 1;
  game.player.x = 4;
  game.player.y = 1;
  game.maze.dots.fill(0);
  game.maze.dots[1 * game.maze.cols + 2] = 2;
  game.player.x = 2;
  game.player.y = 1;
  game.dotsLeft = 6;
  const before = game.score;
  game.update(1 / 60, {});
  assert.ok(game.frightTimer > 0);
  assert.equal(orb.mode, 'fright');
  assert.ok(game.score >= before + 50);

  const a = game.ghosts[0];
  const b = game.ghosts[1];
  a.mode = 'fright';
  b.mode = 'fright';
  a.x = game.player.x;
  a.y = game.player.y;
  b.x = game.player.x;
  b.y = game.player.y;
  game.maze.dots.fill(0);
  game.dotsLeft = 5;
  const scored = game.score;
  game.update(1 / 60, {});
  assert.equal(a.mode, 'eaten');
  assert.equal(b.mode, 'eaten');
  assert.equal(game.score - scored, 600);
  assert.equal(game.combo, 2);

  game.ghosts[2].mode = 'active';
  game.ghosts[2].x = game.player.x;
  game.ghosts[2].y = game.player.y;
  game.lives = 1;
  game.update(1 / 60, {});
  assert.equal(game.state, 'dying');
  assert.equal(game.lives, 0);
  tick(game, 80, {});
  assert.equal(game.state, 'gameover');
  assert.equal(game.highScore, 5000);

  game.update(1 / 60, { startPressed: true });
  assert.equal(game.state, 'ready');
  assert.equal(game.score, 0);
  assert.equal(game.lives, 3);
});

test('clearing a maze advances and raises the pace', () => {
  const game = new Game({ rng: rng(9), levels: [LEVELS[0], LEVELS[1]] });
  game.startGame(null);
  tick(game, 80, {});
  game.maze.dots.fill(0);
  game.dotsLeft = 1;
  const x = game.player.x;
  const y = game.player.y;
  const tx = ((Math.round(x) % game.maze.cols) + game.maze.cols) % game.maze.cols;
  const ty = Math.round(y);
  game.maze.dots[ty * game.maze.cols + tx] = 1;
  game.player.x = tx;
  game.player.y = ty;
  game.update(1 / 60, {});
  assert.equal(game.dotsLeft, 0);
  assert.equal(game.state, 'levelclear');
  const slow = tuningFor(1).ghost;
  tick(game, 110, {});
  assert.equal(game.level, 2);
  assert.equal(game.maze.name, 'Spiral Vault');
  assert.ok(game.tuning.ghost > slow);
  assert.equal(game.state, 'ready');
});

test('pause freezes the board and restart deals a new run', () => {
  const game = new Game({ rng: rng(4) });
  game.startGame('right');
  tick(game, 100, { dir: 'right' });
  const x = game.player.x;
  const score = game.score;
  game.update(1 / 60, { pausePressed: true });
  assert.equal(game.state, 'paused');
  tick(game, 30, { dir: 'down' });
  assert.equal(game.player.x, x);
  assert.equal(game.score, score);
  game.update(1 / 60, { pausePressed: true });
  assert.equal(game.state, 'playing');
  game.update(1 / 60, { restartPressed: true });
  assert.equal(game.score, 0);
  assert.equal(game.level, 1);
  assert.equal(game.state, 'ready');
});

test('high score is ignored on the title and kept when beaten', () => {
  const game = new Game({ highScore: 100, rng: rng(2) });
  assert.equal(game.state, 'title');
  game.addScore(5000);
  assert.equal(game.highScore, 100);
  assert.equal(game.score, 0);
  game.startGame(null);
  game.addScore(40);
  assert.equal(game.highScore, 100);
  game.addScore(80);
  assert.equal(game.highScore, 120);
  assert.equal(game.newBest, true);
  game.addScore(10000);
  assert.ok(game.lives >= 4);
});

test('shades leave the den, stay on legal tiles, and a life can be lost', () => {
  const game = new Game({ rng: rng(11) });
  game.startGame('left');
  tick(game, 90, { dir: 'left' });
  tick(game, 60 * 8, { dir: 'left' });
  assert.notEqual(game.state, 'title');
  for (const ghost of game.ghosts) {
    assert.ok(Number.isFinite(ghost.x) && Number.isFinite(ghost.y));
    const tile = currentTile(ghost, game.maze.cols);
    assert.ok(game.maze.isOpen(tile.x, tile.y, ghost), `${ghost.name} on ${ghost.mode} ${tile.x},${tile.y}`);
  }
  const left = game.ghosts.some((ghost) => ghost.mode !== 'house' && ghost.mode !== 'rest');
  assert.ok(left, 'at least one shade should have left the den');

  if (game.state === 'playing') {
    game.ghosts[0].mode = 'active';
    game.ghosts[0].x = game.player.x;
    game.ghosts[0].y = game.player.y;
    const lives = game.lives;
    game.update(1 / 60, {});
    assert.equal(game.state, 'dying');
    assert.equal(game.lives, lives - 1);
    tick(game, 80, {});
    assert.equal(game.state, 'ready');
    assert.ok(tileDist(game.player, { x: game.maze.start.x, y: game.maze.start.y }, game.maze.cols) < 0.1);
  }
});

test('title demo runs without throwing or recording a score', () => {
  const game = new Game({ highScore: 80, rng: rng(6) });
  tick(game, 60 * 6, {});
  assert.equal(game.state, 'title');
  assert.equal(game.score, 0);
  assert.equal(game.highScore, 80);
  const tile = currentTile(game.player, game.maze.cols);
  assert.equal(game.maze.tiles[tile.y][tile.x], 'floor');
});
