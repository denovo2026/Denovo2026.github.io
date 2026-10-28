/**
 * Maze Muncher rules: movement, shades, scoring, and the screen state machine.
 * This module does not touch the DOM.
 */

import { LEVELS } from './levels.js';
import { analyzeMaze, cornerTargets, parseMaze } from './maze.js';
import {
  advance,
  bfsDir,
  canStep,
  currentTile,
  dirToNearestCrumb,
  exits,
  opposite,
  stepTile,
  tileDist,
  VECTORS,
} from './motion.js';

export const ROSTER = [
  { id: 'blaze', name: 'Blaze', role: 'chaser', color: '#ff4d6d', accessory: 'horns' },
  { id: 'hex', name: 'Hex', role: 'ambusher', color: '#c084fc', accessory: 'gem' },
  { id: 'jinx', name: 'Jinx', role: 'drifter', color: '#ffe14a', accessory: 'mask' },
  { id: 'quill', name: 'Quill', role: 'patroller', color: '#2ee6c7', accessory: 'visor' },
];

export const ROLE_COPY = {
  chaser: 'chases you directly',
  ambusher: 'aims ahead of your path',
  drifter: 'wanders, then drifts close',
  patroller: 'patrols until you are near',
};

const FRUITS = [
  { id: 'berry', name: 'Sunberry', points: 200, color: '#ff5d73' },
  { id: 'gem', name: 'Moongem', points: 500, color: '#7ee0ff' },
  { id: 'star', name: 'Starfig', points: 800, color: '#ffd166' },
  { id: 'pip', name: 'Glowpip', points: 1200, color: '#9dffb0' },
  { id: 'crown', name: 'Crownbit', points: 1600, color: '#e0b0ff' },
];

const CHAIN = [200, 400, 800, 1600];

export function tuningFor(level) {
  const n = Math.max(0, level - 1);
  return {
    player: Math.min(8.6, 6.35 + n * 0.18),
    ghost: Math.min(8.2, 5.75 + n * 0.2),
    frightSpeed: Math.min(5.3, 4.05 + n * 0.06),
    eaten: 12.2,
    house: 3.4,
    frightTime: Math.max(2.4, 7.2 - n * 0.48),
    release: [0.35, 2.1, 4.6, 7.2].map((t) => Math.max(0.25, t * Math.max(0.42, 1 - n * 0.07))),
    elroyDots: Math.max(8, 26 - n * 2),
  };
}

function phasesFor(level) {
  const n = Math.max(0, level - 1);
  const scatter = Math.max(1.5, 6.2 - n * 0.55);
  const chase = 14 + n * 1.5;
  return [
    ['scatter', scatter],
    ['chase', chase],
    ['scatter', Math.max(1.2, scatter * 0.6)],
    ['chase', chase],
    ['scatter', 1.15],
    ['chase', Infinity],
  ];
}

function pickHomes(houses) {
  if (!houses.length) return [0, 1, 2, 3].map(() => ({ x: 1, y: 1 }));
  const minX = Math.min(...houses.map((h) => h.x));
  const maxX = Math.max(...houses.map((h) => h.x));
  const minY = Math.min(...houses.map((h) => h.y));
  const maxY = Math.max(...houses.map((h) => h.y));
  const wanted = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: minX, y: maxY },
    { x: Math.round((minX + maxX) / 2), y: maxY },
  ];
  return wanted.map((spot, index) => {
    let best = houses[index % houses.length];
    let bestD = Infinity;
    for (const home of houses) {
      const d = (home.x - spot.x) ** 2 + (home.y - spot.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = home;
      }
    }
    return { x: best.x, y: best.y };
  });
}

export class Game {
  constructor(options = {}) {
    this.levels = options.levels?.length ? options.levels : LEVELS;
    this.rng = options.rng || Math.random;
    this.highScore = options.highScore || 0;
    this.reduce = !!options.reduceMotion;
    this.debug = !!options.debug;
    this.events = [];
    this.enterTitle();
  }

  emit(name) {
    if (!this.demo) this.events.push(name);
  }

  enterTitle() {
    this.demo = true;
    this.score = 0;
    this.lives = 3;
    this.level = 1;
    this.nextLife = 10000;
    this.newBest = false;
    this.launchDir = null;
    this.demoReset = false;
    this.loadLevel();
  }

  startGame(dir) {
    this.demo = false;
    this.score = 0;
    this.lives = 3;
    this.level = 1;
    this.nextLife = 10000;
    this.newBest = false;
    this.launchDir = dir || null;
    this.loadLevel();
    if (dir) this.player.wish = dir;
    this.events.push('start');
  }

  loadLevel() {
    const def = this.levels[(this.level - 1) % this.levels.length];
    this.maze = parseMaze(def);
    this.tuning = tuningFor(this.level);
    this.phases = phasesFor(this.level);
    this.phaseIndex = 0;
    this.mode = this.phases[0][0];
    this.phaseTime = this.phases[0][1];
    this.dotsLeft = this.maze.totalDots;
    this.dotsEaten = 0;
    this.fruit = null;
    this.fruitSpawned = new Set();
    this.particles = [];
    this.popups = [];
    this.frightTimer = 0;
    this.combo = 0;
    this.playTime = 0;
    this.anim = 0;
    this.shake = 0;
    this.levelBonus = 0;
    this.placeActors();
    this.state = this.demo ? 'title' : 'ready';
    this.stateTimer = this.demo ? 0 : 1.2;
  }

  placeActors() {
    const start = this.maze.start || { x: 1, y: 1 };
    const keepWish = this.player?.wish || this.launchDir || null;
    this.player = {
      kind: 'player',
      x: start.x,
      y: start.y,
      dir: null,
      wish: keepWish,
      justArrived: false,
      forceDecide: false,
      moved: false,
    };
    const homes = pickHomes(this.maze.houses);
    const corners = this.maze.floors.length ? cornerTargets(this.maze) : homes;
    this.ghosts = ROSTER.map((info, index) => ({
      ...info,
      kind: 'ghost',
      x: homes[index].x,
      y: homes[index].y,
      home: homes[index],
      dir: index % 2 === 0 ? 'left' : 'right',
      mode: 'house',
      release: this.tuning.release[index],
      restTimer: 0,
      scatter: corners[index] || homes[index],
      patrol: corners.filter(Boolean),
      patrolIndex: index % Math.max(1, corners.length),
      wanderTarget: this.randomFloor() || homes[index],
      wanderTimer: 1.1 + index * 0.35,
      forceDecide: true,
      justArrived: false,
      reverseNow: false,
      phase: index * 1.37,
    }));
  }

  randomFloor() {
    const list = this.maze.floors;
    if (!list.length) return null;
    return list[Math.floor(this.rng() * list.length)];
  }

  addScore(amount) {
    if (this.demo || !(amount > 0)) return;
    const before = this.score;
    this.score += amount;
    let gainedLife = false;
    while (this.score >= this.nextLife && this.lives < 5) {
      this.lives += 1;
      this.nextLife += 10000;
      gainedLife = true;
    }
    if (gainedLife) this.emit('extra');
    if (this.score > this.highScore) {
      const crossed = before <= this.highScore;
      this.highScore = this.score;
      this.newBest = true;
      if (crossed) this.emit('highscore');
    }
  }

  update(dt, input = {}) {
    this.events = [];
    this.demoReset = false;
    const step = Math.min(0.05, Math.max(0, Number.isFinite(dt) ? dt : 0));

    if (input.restartPressed && this.state !== 'title') {
      this.startGame(input.dir || null);
      return;
    }
    if (input.pausePressed && (this.state === 'playing' || this.state === 'ready')) {
      this.pausedFrom = this.state;
      this.state = 'paused';
      this.emit('pause');
      return;
    }
    if ((input.pausePressed || input.startPressed) && this.state === 'paused') {
      this.state = this.pausedFrom || 'playing';
      this.emit('resume');
      return;
    }
    if (this.state === 'title' && (input.startPressed || input.dir)) {
      this.startGame(input.dir || null);
      return;
    }
    if (this.state === 'gameover' && (input.startPressed || input.restartPressed)) {
      this.startGame(input.dir || null);
      return;
    }

    switch (this.state) {
      case 'title':
        this.updateTitle(step);
        if (this.demoReset || this.playTime > 80) this.enterTitle();
        break;
      case 'ready':
        if (input.dir) {
          this.player.wish = input.dir;
          this.launchDir = input.dir;
        }
        this.anim += step;
        this.stateTimer -= step;
        if (this.stateTimer <= 0) {
          this.state = 'playing';
          this.playTime = 0;
          this.emit('go');
        }
        break;
      case 'playing':
        this.updatePlaying(step, input);
        break;
      case 'dying':
        this.anim += step;
        this.updateFx(step);
        this.stateTimer -= step;
        if (this.stateTimer <= 0) this.finishDeath();
        break;
      case 'levelclear':
        this.anim += step;
        this.updateFx(step);
        this.stateTimer -= step;
        if (this.stateTimer <= 0) this.advanceLevel();
        break;
      default:
        break;
    }
  }

  updateTitle(dt) {
    this.updatePlaying(dt, { dir: this.demoWish() });
  }

  updatePlaying(dt, input) {
    this.anim += dt;
    this.playTime += dt;
    if (input.dir) this.launchDir = null;
    if (this.launchDir && this.playTime < 0.5 && !input.dir) this.player.wish = this.launchDir;
    else this.player.wish = input.dir || null;

    this.updatePhase(dt);
    this.updateFruit(dt);
    const fromX = this.player.x;
    const fromY = this.player.y;
    advance(this.player, this.maze, this.tuning.player * dt, this.player.wish, null);
    this.eatAlong(fromX, fromY, this.player.x, this.player.y);
    this.eatFruit();
    if (this.dotsLeft <= 0) {
      if (this.demo) this.demoReset = true;
      else this.beginClear();
      this.updateFx(dt);
      return;
    }
    for (const ghost of this.ghosts) this.updateGhost(ghost, dt);
    if (this.state === 'playing' || this.state === 'title') this.resolveHits();
    this.updateFx(dt);
  }

  updatePhase(dt) {
    if (this.frightTimer > 0) {
      this.frightTimer -= dt;
      if (this.frightTimer <= 0) {
        this.frightTimer = 0;
        this.combo = 0;
        for (const ghost of this.ghosts) {
          if (ghost.mode === 'fright') {
            ghost.mode = 'active';
            ghost.reverseNow = true;
          }
        }
      }
      return;
    }
    if (!Number.isFinite(this.phaseTime)) return;
    this.phaseTime -= dt;
    if (this.phaseTime > 0) return;
    this.phaseIndex = Math.min(this.phaseIndex + 1, this.phases.length - 1);
    const [mode, duration] = this.phases[this.phaseIndex];
    this.mode = mode;
    this.phaseTime = duration;
    for (const ghost of this.ghosts) {
      if (ghost.mode === 'active') ghost.reverseNow = true;
    }
  }

  startFright() {
    this.frightTimer = this.tuning.frightTime;
    this.combo = 0;
    for (const ghost of this.ghosts) {
      if (ghost.mode === 'active' || ghost.mode === 'fright') {
        ghost.mode = 'fright';
        ghost.reverseNow = true;
      }
    }
  }

  updateFruit(dt) {
    if (!this.maze.fruit) return;
    const marks = [
      Math.floor(this.maze.totalDots * 0.38),
      Math.floor(this.maze.totalDots * 0.72),
    ];
    for (const mark of marks) {
      if (mark > 0 && this.dotsEaten >= mark && !this.fruitSpawned.has(mark)) {
        this.fruitSpawned.add(mark);
        const spec = FRUITS[(this.level - 1) % FRUITS.length];
        this.fruit = {
          ...spec,
          x: this.maze.fruit.x,
          y: this.maze.fruit.y,
          timer: 9.5,
          max: 9.5,
        };
      }
    }
    if (!this.fruit) return;
    this.fruit.timer -= dt;
    if (this.fruit.timer <= 0) this.fruit = null;
  }

  eatAlong(x0, y0, x1, y1) {
    let dx = x1 - x0;
    const dy = y1 - y0;
    if (Math.abs(dx) > this.maze.cols / 2) {
      this.tryEat(x0, y0);
      this.tryEat(x1, y1);
      return;
    }
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / 0.18));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.tryEat(x0 + dx * t, y0 + dy * t);
    }
  }

  tryEat(x, y) {
    if (Math.abs(x - Math.round(x)) > 0.34) return;
    if (Math.abs(y - Math.round(y)) > 0.34) return;
    const tx = ((Math.round(x) % this.maze.cols) + this.maze.cols) % this.maze.cols;
    const ty = Math.round(y);
    if (ty < 0 || ty >= this.maze.rows) return;
    const kind = this.maze.consume(tx, ty);
    if (!kind) return;
    this.dotsLeft = Math.max(0, this.dotsLeft - 1);
    this.dotsEaten += 1;
    if (kind === 'power') {
      this.addScore(50);
      this.startFright();
      this.emit('power');
      this.burst(x, y, '#ff4fa3', 14, 3.4);
      this.popup(x, y - 0.6, '50', '#ffd0ea');
    } else {
      this.addScore(10);
      this.emit('dot');
      this.burst(x, y, '#fff4d2', 4, 1.5);
    }
  }

  eatFruit() {
    if (!this.fruit) return;
    if (tileDist(this.player, this.fruit, this.maze.cols) > 0.48) return;
    const fruit = this.fruit;
    this.addScore(fruit.points);
    this.emit('fruit');
    this.popup(fruit.x, fruit.y - 0.4, String(fruit.points), fruit.color);
    this.burst(fruit.x, fruit.y, fruit.color, 16, 3.2);
    this.fruit = null;
  }

  updateGhost(ghost, dt) {
    if (ghost.mode === 'house' && this.playTime >= ghost.release) {
      ghost.mode = 'leaving';
      ghost.forceDecide = true;
    }
    if (ghost.mode === 'rest') {
      ghost.restTimer -= dt;
      if (ghost.restTimer <= 0) {
        ghost.mode = 'leaving';
        ghost.forceDecide = true;
      } else {
        return;
      }
    }
    if (ghost.reverseNow && ghost.dir && (ghost.mode === 'active' || ghost.mode === 'fright')) {
      const back = opposite(ghost.dir);
      if (back) ghost.dir = back;
      ghost.reverseNow = false;
    }
    if (ghost.role === 'drifter') {
      ghost.wanderTimer -= dt;
      if (ghost.wanderTimer <= 0) {
        ghost.wanderTarget = this.randomFloor() || ghost.wanderTarget;
        ghost.wanderTimer = 1.5 + this.rng() * 1.4;
      }
    }
    advance(ghost, this.maze, this.speedFor(ghost) * dt, null, (actor, tile) => {
      this.decideGhost(actor, tile);
    });
    if (ghost.role === 'patroller' && ghost.patrol.length) {
      const waypoint = ghost.patrol[ghost.patrolIndex];
      if (waypoint && Math.hypot(ghost.x - waypoint.x, ghost.y - waypoint.y) < 0.45) {
        ghost.patrolIndex = (ghost.patrolIndex + 1) % ghost.patrol.length;
      }
    }
  }

  decideGhost(ghost, tile) {
    if (ghost.mode === 'eaten' && tile.x === ghost.home.x && tile.y === ghost.home.y) {
      ghost.mode = 'rest';
      ghost.restTimer = 0.7;
      ghost.dir = null;
      return;
    }
    if (ghost.mode === 'leaving' && this.maze.exit && tile.x === this.maze.exit.x && tile.y === this.maze.exit.y) {
      ghost.mode = this.frightTimer > 0 ? 'fright' : 'active';
    }
    if (ghost.mode === 'house' || ghost.mode === 'rest') {
      if (!canStep(this.maze, tile, ghost.dir, ghost)) {
        const back = opposite(ghost.dir);
        if (back && canStep(this.maze, tile, back, ghost)) ghost.dir = back;
        else {
          const options = exits(this.maze, tile, ghost);
          if (options.length) ghost.dir = options[0];
        }
      }
      return;
    }
    if (ghost.mode === 'fright') {
      const options = exits(this.maze, tile, ghost);
      const back = opposite(ghost.dir);
      let choices = options.filter((dir) => dir !== back);
      if (!choices.length) choices = options;
      if (choices.length > 1) ghost.dir = choices[Math.floor(this.rng() * choices.length)];
      else if (choices.length === 1) ghost.dir = choices[0];
      return;
    }
    const target = this.targetFor(ghost);
    const dir = bfsDir(this.maze, tile, target, ghost);
    if (dir) ghost.dir = dir;
  }

  targetFor(ghost) {
    if (ghost.mode === 'eaten') return ghost.home;
    if (ghost.mode === 'leaving') return this.maze.exit || ghost.home;
    const playerTile = currentTile(this.player, this.maze.cols);
    if (this.mode === 'scatter' && (ghost.role === 'chaser' || ghost.role === 'ambusher')) {
      return ghost.scatter;
    }
    if (ghost.role === 'chaser') return playerTile;
    if (ghost.role === 'ambusher') {
      const dir = this.player.dir || 'left';
      const vector = VECTORS[dir];
      const lead = 3 + Math.min(4, this.level - 1);
      return { x: playerTile.x + vector.x * lead, y: playerTile.y + vector.y * lead };
    }
    if (ghost.role === 'drifter') return ghost.wanderTarget || playerTile;
    const radius = (this.mode === 'chase' ? 5.5 : 3) + Math.min(4, this.level - 1) * 0.45;
    if (tileDist(ghost, this.player, this.maze.cols) <= radius) return playerTile;
    return ghost.patrol[ghost.patrolIndex] || ghost.scatter;
  }

  speedFor(ghost) {
    const tuning = this.tuning;
    let speed = tuning.ghost;
    if (ghost.mode === 'fright') speed = tuning.frightSpeed;
    else if (ghost.mode === 'eaten') speed = tuning.eaten;
    else if (ghost.mode === 'house' || ghost.mode === 'rest' || ghost.mode === 'leaving') speed = tuning.house;
    else if (ghost.role === 'chaser' && ghost.mode === 'active') {
      if (this.dotsLeft <= tuning.elroyDots) speed *= 1.12;
      if (this.dotsLeft <= Math.max(4, tuning.elroyDots / 2)) speed *= 1.08;
      if (this.seesPlayer(ghost)) speed *= 1.05;
    }
    const tile = currentTile(ghost, this.maze.cols);
    if ((ghost.mode === 'active' || ghost.mode === 'fright') && (tile.x === 0 || tile.x === this.maze.cols - 1)) {
      speed *= 0.55;
    }
    if (this.demo && ghost.mode !== 'eaten') speed *= 0.88;
    return speed;
  }

  seesPlayer(ghost) {
    const maze = this.maze;
    const playerTile = currentTile(this.player, maze.cols);
    const ghostTile = currentTile(ghost, maze.cols);
    if (playerTile.x !== ghostTile.x && playerTile.y !== ghostTile.y) return false;
    const stepX = Math.sign(playerTile.x - ghostTile.x);
    const stepY = Math.sign(playerTile.y - ghostTile.y);
    let x = ghostTile.x;
    let y = ghostTile.y;
    for (let i = 0; i < 14; i++) {
      if (x === playerTile.x && y === playerTile.y) return true;
      x += stepX;
      y += stepY;
      if (x < 0 || y < 0 || x >= maze.cols || y >= maze.rows) return false;
      const kind = maze.tiles[y][x];
      if (kind === 'wall' || kind === 'door' || kind === 'house') return false;
    }
    return false;
  }

  resolveHits() {
    for (const ghost of this.ghosts) {
      if (ghost.mode !== 'active' && ghost.mode !== 'fright') continue;
      if (tileDist(this.player, ghost, this.maze.cols) > 0.72) continue;
      if (ghost.mode === 'fright') this.devour(ghost);
      else if (!this.demo) {
        this.killPlayer();
        return;
      }
    }
  }

  devour(ghost) {
    const chain = Math.min(CHAIN.length, this.combo + 1);
    this.combo = chain;
    const points = CHAIN[chain - 1];
    this.addScore(points);
    ghost.mode = 'eaten';
    ghost.forceDecide = true;
    ghost.reverseNow = false;
    this.emit('eat');
    this.popup(ghost.x, ghost.y - 0.2, String(points), '#fff6d8');
    this.burst(ghost.x, ghost.y, '#d6e4ff', 16, 3.8);
  }

  killPlayer() {
    if (this.state !== 'playing') return;
    this.lives -= 1;
    this.state = 'dying';
    this.stateTimer = 1.15;
    this.shake = this.reduce ? 0 : 0.55;
    this.frightTimer = 0;
    this.combo = 0;
    this.fruit = null;
    this.emit('death');
    this.burst(this.player.x, this.player.y, '#ff8618', 22, 4.2);
  }

  finishDeath() {
    if (this.lives > 0) this.respawn();
    else {
      this.state = 'gameover';
      this.emit('over');
    }
  }

  respawn() {
    this.frightTimer = 0;
    this.combo = 0;
    this.fruit = null;
    this.phaseIndex = 0;
    this.mode = this.phases[0][0];
    this.phaseTime = this.phases[0][1];
    this.playTime = 0;
    this.launchDir = null;
    const start = this.maze.start;
    this.player.x = start.x;
    this.player.y = start.y;
    this.player.dir = null;
    this.player.wish = null;
    this.player.justArrived = false;
    this.player.forceDecide = false;
    const homes = pickHomes(this.maze.houses);
    this.ghosts.forEach((ghost, index) => {
      ghost.x = homes[index].x;
      ghost.y = homes[index].y;
      ghost.dir = index % 2 === 0 ? 'left' : 'right';
      ghost.mode = 'house';
      ghost.restTimer = 0;
      ghost.forceDecide = true;
      ghost.justArrived = false;
      ghost.reverseNow = false;
      ghost.wanderTimer = 1.2;
    });
    this.state = 'ready';
    this.stateTimer = 1.15;
  }

  beginClear() {
    this.levelBonus = 200 * this.level;
    this.addScore(this.levelBonus);
    this.state = 'levelclear';
    this.stateTimer = 1.65;
    this.fruit = null;
    this.popup(this.player.x, this.player.y - 0.8, `+${this.levelBonus}`, '#9dffdf');
    this.emit('clear');
  }

  advanceLevel() {
    this.level += 1;
    this.launchDir = null;
    this.loadLevel();
  }

  demoWish() {
    const maze = this.maze;
    const player = this.player;
    const tile = currentTile(player, maze.cols);
    const centered = Math.hypot(player.x - tile.x, player.y - tile.y) < 0.18;
    if (!centered && player.dir) return player.dir;
    const options = exits(maze, tile, player);
    if (!options.length) return player.dir;
    const hunters = this.ghosts.filter(
      (ghost) => ghost.mode === 'active' && tileDist(player, ghost, maze.cols) < 4.6,
    );
    const snacks = this.ghosts.filter(
      (ghost) => ghost.mode === 'fright' && tileDist(player, ghost, maze.cols) < 7,
    );
    const crumbDir = dirToNearestCrumb(maze, tile, player);
    let best = player.dir;
    let bestScore = -1e9;
    for (const dir of options) {
      const next = stepTile(maze, tile, dir);
      let score = 0;
      if (hunters.length && next) {
        let nearest = Infinity;
        for (const ghost of hunters) nearest = Math.min(nearest, Math.hypot(ghost.x - next.x, ghost.y - next.y));
        score += nearest * 3;
      } else if (crumbDir) {
        score += dir === crumbDir ? 6 : 0;
      }
      if (snacks.length && next) {
        let nearest = Infinity;
        for (const ghost of snacks) nearest = Math.min(nearest, Math.hypot(ghost.x - next.x, ghost.y - next.y));
        score += Math.max(0, 5 - nearest);
      }
      if (next && maze.dotAt(next.x, next.y) === 2 && hunters.length) score += 5;
      if (dir === player.dir) score += 0.75;
      if (player.dir && dir === opposite(player.dir)) score -= hunters.length ? 0.25 : 2.5;
      if (score > bestScore) {
        bestScore = score;
        best = dir;
      }
    }
    return best || player.dir;
  }

  burst(x, y, color, count, speed) {
    const total = this.reduce ? Math.min(3, count) : count;
    for (let i = 0; i < total; i++) {
      const angle = this.rng() * Math.PI * 2;
      const mag = speed * (0.35 + this.rng() * 0.7);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * mag,
        vy: Math.sin(angle) * mag,
        life: 0.25 + this.rng() * 0.22,
        max: 0.47,
        color,
        r: 0.05 + this.rng() * 0.06,
      });
    }
    if (this.particles.length > 220) this.particles.splice(0, this.particles.length - 220);
  }

  popup(x, y, text, color) {
    this.popups.push({ x, y, text, life: 0.9, max: 0.9, color });
    if (this.popups.length > 8) this.popups.shift();
  }

  updateFx(dt) {
    for (const particle of this.particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.life -= dt;
    }
    this.particles = this.particles.filter((particle) => particle.life > 0);
    for (const popup of this.popups) {
      popup.y -= dt * 0.55;
      popup.life -= dt;
    }
    this.popups = this.popups.filter((popup) => popup.life > 0);
    if (!this.reduce) this.shake = Math.max(0, this.shake - dt * 1.5);
  }
}

export function bootCheck(levels = LEVELS) {
  const problems = [];
  for (const level of levels) {
    const maze = parseMaze(level);
    for (const issue of analyzeMaze(maze)) problems.push(`${level.name}: ${issue}`);
  }
  return problems;
}
