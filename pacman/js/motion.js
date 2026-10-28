/**
 * Tile motion for Maze Muncher.
 * Integer coordinates are tile centers. Tunnels wrap on the horizontal axis.
 */

export const DIRS = ['up', 'left', 'down', 'right'];

export const VECTORS = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

const OPPOSITE = { left: 'right', right: 'left', up: 'down', down: 'up' };
const EPS = 1e-4;

export function opposite(dir) {
  return OPPOSITE[dir] || null;
}

export function mod(n, m) {
  return ((n % m) + m) % m;
}

export function stepTile(maze, tile, dir) {
  const v = VECTORS[dir];
  if (!v) return null;
  const y = tile.y + v.y;
  if (y < 0 || y >= maze.rows) return null;
  const x = mod(tile.x + v.x, maze.cols);
  return { x, y };
}

export function canStep(maze, tile, dir, actor) {
  const next = stepTile(maze, tile, dir);
  return !!(next && maze.isOpen(next.x, next.y, actor));
}

export function currentTile(actor, cols) {
  return {
    x: mod(Math.round(actor.x), cols),
    y: Math.round(actor.y),
  };
}

export function tileDist(a, b, cols) {
  let dx = Math.abs(a.x - b.x);
  if (cols && dx > cols / 2) dx = cols - dx;
  return Math.hypot(dx, a.y - b.y);
}

export function exits(maze, tile, actor) {
  const open = [];
  for (let i = 0; i < DIRS.length; i++) {
    if (canStep(maze, tile, DIRS[i], actor)) open.push(DIRS[i]);
  }
  return open;
}

function nextCenter(pos, sign) {
  const rounded = Math.round(pos);
  if (Math.abs(pos - rounded) <= EPS) return rounded + sign;
  return sign > 0 ? Math.ceil(pos - 1e-8) : Math.floor(pos + 1e-8);
}

/**
 * Slide an actor up to `dist` tiles.
 * A `wish` opposite the current direction reverses immediately.
 * Any other wish is taken when the actor reaches a tile center and that step is open.
 * `onCenter(actor, tile)` may change `actor.dir` on arrival (ghosts).
 */
export function advance(actor, maze, dist, wish, onCenter) {
  actor.moved = false;
  if (!(dist > 0)) return;

  if (wish && actor.dir && wish === opposite(actor.dir)) actor.dir = wish;

  const limit = 12 + Math.ceil(dist);
  for (let guard = 0; guard < limit && dist > 1e-8; guard++) {
    const axis = actor.dir ? (VECTORS[actor.dir].x !== 0 ? actor.x : actor.y) : actor.x;
    const onTile = !actor.dir || Math.abs(axis - Math.round(axis)) <= EPS;

    if (!actor.dir || onTile) {
      if (actor.x < 0) actor.x += maze.cols;
      else if (actor.x >= maze.cols) actor.x -= maze.cols;
      const tile = {
        x: mod(Math.round(actor.x), maze.cols),
        y: Math.round(actor.y),
      };
      actor.x = tile.x;
      actor.y = tile.y;

      const blocked = !!(actor.dir && !canStep(maze, tile, actor.dir, actor));
      if (typeof onCenter === 'function' && (actor.justArrived || actor.forceDecide || blocked)) {
        onCenter(actor, tile);
      }
      actor.justArrived = false;
      actor.forceDecide = false;

      if (wish && wish !== actor.dir && canStep(maze, tile, wish, actor)) actor.dir = wish;
      if (!actor.dir || !canStep(maze, tile, actor.dir, actor)) return;
    }

    const v = VECTORS[actor.dir];
    const sign = v.x !== 0 ? v.x : v.y;
    const along = v.x !== 0 ? actor.x : actor.y;
    const center = nextCenter(along, sign);
    const distTo = Math.abs(center - along);
    if (!(distTo > 1e-8)) return;
    const step = Math.min(dist, distTo);
    actor.x += v.x * step;
    actor.y += v.y * step;
    dist -= step;
    actor.moved = true;

    const along2 = v.x !== 0 ? actor.x : actor.y;
    if (Math.abs(along2 - center) <= EPS) {
      if (v.x !== 0) actor.x = center;
      else actor.y = center;
      if (actor.x < 0) actor.x += maze.cols;
      else if (actor.x >= maze.cols) actor.x -= maze.cols;
      actor.justArrived = true;
    }
  }
}

export function nearestOpen(maze, goal, actor) {
  const gx = Math.max(0, Math.min(maze.cols - 1, Math.round(goal.x)));
  const gy = Math.max(0, Math.min(maze.rows - 1, Math.round(goal.y)));
  if (maze.isOpen(gx, gy, actor)) return { x: gx, y: gy };
  let best = null;
  let bestD = Infinity;
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (!maze.isOpen(x, y, actor)) continue;
      const d = (x - goal.x) ** 2 + (y - goal.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/** First step from `start` toward `goal` along open tiles, or null. */
export function bfsDir(maze, start, goal, actor) {
  if (!start || !goal) return null;
  const target = nearestOpen(maze, goal, actor);
  if (!target) return null;
  if (start.x === target.x && start.y === target.y) return null;

  const key = (x, y) => x + y * maze.cols;
  const prev = new Map();
  const queue = [start];
  prev.set(key(start.x, start.y), null);
  let found = false;
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    if (cur.x === target.x && cur.y === target.y) {
      found = true;
      break;
    }
    for (let i = 0; i < DIRS.length; i++) {
      const dir = DIRS[i];
      const next = stepTile(maze, cur, dir);
      if (!next || !maze.isOpen(next.x, next.y, actor)) continue;
      const k = key(next.x, next.y);
      if (prev.has(k)) continue;
      prev.set(k, { x: cur.x, y: cur.y, dir });
      queue.push(next);
    }
  }
  if (!found) return null;

  let k = key(target.x, target.y);
  let dir = null;
  let guard = 0;
  while (prev.get(k) && guard++ < maze.cols * maze.rows) {
    const parent = prev.get(k);
    dir = parent.dir;
    k = key(parent.x, parent.y);
  }
  return dir;
}

/** Direction of the first step toward the nearest crumb, if any. */
export function dirToNearestCrumb(maze, start, actor) {
  const key = (x, y) => x + y * maze.cols;
  const prev = new Map();
  const queue = [start];
  prev.set(key(start.x, start.y), null);
  let found = null;
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    if (!(cur.x === start.x && cur.y === start.y) && maze.dotAt(cur.x, cur.y)) {
      found = cur;
      break;
    }
    for (let i = 0; i < DIRS.length; i++) {
      const dir = DIRS[i];
      const next = stepTile(maze, cur, dir);
      if (!next || !maze.isOpen(next.x, next.y, actor)) continue;
      const k = key(next.x, next.y);
      if (prev.has(k)) continue;
      prev.set(k, { x: cur.x, y: cur.y, dir });
      queue.push(next);
    }
  }
  if (!found) return null;
  let k = key(found.x, found.y);
  let dir = null;
  let guard = 0;
  while (prev.get(k) && guard++ < maze.cols * maze.rows) {
    const parent = prev.get(k);
    dir = parent.dir;
    k = key(parent.x, parent.y);
  }
  return dir;
}
