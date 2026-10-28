/**
 * Maze parsing and queries.
 * Legend: # wall, . crumb, o power orb, space empty floor,
 * S muncher start, F treat spot, H den, D gate.
 */

import { nearestOpen, stepTile } from './motion.js';

function flood(maze, origin, actor) {
  const seen = new Set();
  if (!origin) return seen;
  const queue = [origin];
  seen.add(origin.x + ',' + origin.y);
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    for (const dir of ['left', 'right', 'up', 'down']) {
      const next = stepTile(maze, cur, dir);
      if (!next || !maze.isOpen(next.x, next.y, actor)) continue;
      const key = next.x + ',' + next.y;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return seen;
}

function findExit(maze, door) {
  const prefs = [
    { x: door.x, y: door.y - 1 },
    { x: door.x, y: door.y + 1 },
    { x: door.x - 1, y: door.y },
    { x: door.x + 1, y: door.y },
  ];
  for (const spot of prefs) {
    if (spot.x < 0 || spot.y < 0 || spot.x >= maze.cols || spot.y >= maze.rows) continue;
    if (maze.tiles[spot.y][spot.x] === 'floor') return spot;
  }
  return null;
}

export function parseMaze(level) {
  const rows = level.rows;
  if (!rows?.length) throw new Error('Maze is empty');
  const height = rows.length;
  const width = rows[0].length;
  const tiles = [];
  const dots = new Uint8Array(width * height);
  const houses = [];
  const floors = [];
  let start = null;
  let fruit = null;
  let door = null;
  let totalDots = 0;

  for (let y = 0; y < height; y++) {
    const row = rows[y];
    if (row.length !== width) throw new Error(`Row ${y} has width ${row.length}, expected ${width}`);
    const line = new Array(width);
    for (let x = 0; x < width; x++) {
      const ch = row[x];
      let kind = 'floor';
      if (ch === '#') kind = 'wall';
      else if (ch === 'H') kind = 'house';
      else if (ch === 'D') kind = 'door';
      else if (ch !== '.' && ch !== 'o' && ch !== ' ' && ch !== 'S' && ch !== 'F') {
        throw new Error(`Unknown tile "${ch}" at ${x},${y}`);
      }
      line[x] = kind;
      if (ch === '.' || ch === 'o') {
        dots[y * width + x] = ch === 'o' ? 2 : 1;
        totalDots++;
      }
      if (ch === 'S') {
        if (start) throw new Error('Maze has two starts');
        start = { x, y };
      } else if (ch === 'F') {
        if (fruit) throw new Error('Maze has two treat spots');
        fruit = { x, y };
      } else if (ch === 'D') {
        if (door) throw new Error('Maze has two gates');
        door = { x, y };
      } else if (ch === 'H') {
        houses.push({ x, y });
      }
      if (kind === 'floor') floors.push({ x, y });
    }
    tiles.push(line);
  }

  const maze = {
    name: level.name || 'Maze',
    palette: level.palette,
    cols: width,
    rows: height,
    tiles,
    dots,
    totalDots,
    start,
    fruit,
    door,
    houses,
    floors,
    exit: null,
  };

  maze.isOpen = (x, y, actor) => isOpen(maze, x, y, actor);
  maze.dotAt = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return dots[y * width + x];
  };
  maze.consume = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const index = y * width + x;
    const value = dots[index];
    if (!value) return null;
    dots[index] = 0;
    return value === 2 ? 'power' : 'dot';
  };
  maze.exit = door ? findExit(maze, door) : null;
  return maze;
}

export function isOpen(maze, x, y, actor) {
  if (x < 0 || y < 0 || x >= maze.cols || y >= maze.rows) return false;
  const kind = maze.tiles[y][x];
  if (kind === 'wall') return false;
  if (kind === 'floor') return true;
  if (!actor || actor.kind !== 'ghost') return false;
  const mode = actor.mode;
  if (kind === 'house') return mode === 'house' || mode === 'rest' || mode === 'leaving' || mode === 'eaten';
  if (kind === 'door') return mode === 'leaving' || mode === 'eaten';
  return false;
}

export function cornerTargets(maze) {
  const actor = { kind: 'ghost', mode: 'active' };
  const goals = [
    { x: 1, y: 1 },
    { x: maze.cols - 2, y: 1 },
    { x: 1, y: maze.rows - 2 },
    { x: maze.cols - 2, y: maze.rows - 2 },
  ];
  return goals.map((goal) => nearestOpen(maze, goal, actor));
}

/** Structural checks used by tests and boot. Returns a list of problems. */
export function analyzeMaze(maze) {
  const issues = [];
  if (!maze.start) issues.push('missing start');
  if (!maze.door) issues.push('missing gate');
  if (!maze.exit) issues.push('gate has no exit');
  if (!maze.fruit) issues.push('missing treat spot');
  if (maze.houses.length < 4) issues.push('den has fewer than 4 tiles');
  if (maze.totalDots < 40) issues.push('too few crumbs');

  let powers = 0;
  for (let i = 0; i < maze.dots.length; i++) if (maze.dots[i] === 2) powers++;
  if (powers < 4) issues.push(`expected 4 power orbs, found ${powers}`);

  const player = { kind: 'player', mode: 'active' };
  const reachable = flood(maze, maze.start, player);
  const mark = (x, y, label) => {
    if (!reachable.has(x + ',' + y)) issues.push(`${label} unreachable at ${x},${y}`);
  };
  if (maze.start) mark(maze.start.x, maze.start.y, 'start');
  if (maze.fruit) mark(maze.fruit.x, maze.fruit.y, 'treat');
  if (maze.exit) mark(maze.exit.x, maze.exit.y, 'exit');
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (maze.dotAt(x, y)) mark(x, y, 'crumb');
    }
  }

  if (maze.houses.length) {
    const sealed = flood(maze, maze.houses[0], { kind: 'ghost', mode: 'house' });
    for (const key of sealed) {
      const [x, y] = key.split(',').map(Number);
      if (maze.tiles[y][x] === 'floor' || maze.tiles[y][x] === 'door') {
        issues.push(`den leaks at ${x},${y}`);
      }
    }
    const leaving = { kind: 'ghost', mode: 'leaving' };
    for (const home of maze.houses) {
      const out = flood(maze, home, leaving);
      if (maze.exit && !out.has(maze.exit.x + ',' + maze.exit.y)) {
        issues.push(`shade cannot leave from ${home.x},${home.y}`);
      }
    }
  }

  for (let x = 0; x < maze.cols; x++) {
    if (maze.tiles[0][x] !== 'wall') issues.push('top border open');
    if (maze.tiles[maze.rows - 1][x] !== 'wall') issues.push('bottom border open');
  }
  for (let y = 0; y < maze.rows; y++) {
    for (const x of [0, maze.cols - 1]) {
      const kind = maze.tiles[y][x];
      const chOpen = kind === 'floor';
      if (chOpen) {
        const row = maze.tiles[y];
        const other = x === 0 ? row[maze.cols - 1] : row[0];
        if (other !== 'floor') issues.push(`one-sided tunnel at ${x},${y}`);
      }
    }
  }
  return issues;
}
