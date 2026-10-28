/**
 * Keyboard, swipe, and D-pad input.
 * Direction is held while a key or pad button is down, and remembered
 * briefly afterward so a corner press still counts.
 */

const KEY_DIRS = {
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  a: 'left',
  d: 'right',
  w: 'up',
  s: 'down',
};

const BUFFER_MS = 280;

export function createInput(root) {
  const keys = [];
  let dpadDir = null;
  let dpadPointer = null;
  let bufferDir = null;
  let bufferUntil = 0;
  let swipeDir = null;
  let swipeUntil = 0;
  let pauseEdge = false;
  let startEdge = false;
  let restartEdge = false;
  let swipe = null;

  function remember(dir) {
    if (!dir) return;
    bufferDir = dir;
    bufferUntil = performance.now() + BUFFER_MS;
  }

  function pushKey(dir) {
    const index = keys.indexOf(dir);
    if (index >= 0) keys.splice(index, 1);
    keys.push(dir);
  }

  function dropKey(dir) {
    const index = keys.indexOf(dir);
    if (index >= 0) keys.splice(index, 1);
    remember(dir);
  }

  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    const dir = KEY_DIRS[key];
    if (dir || key === ' ' || key === 'escape' || ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(event.key.toLowerCase())) {
      event.preventDefault();
    }
    if (dir) {
      pushKey(dir);
      return;
    }
    if (event.repeat) return;
    if (key === 'p' || key === 'escape') pauseEdge = true;
    else if (key === 'r') restartEdge = true;
    else if (key === 'enter' || key === ' ') startEdge = true;
  }

  function onKeyUp(event) {
    const dir = KEY_DIRS[event.key.toLowerCase()];
    if (dir) dropKey(dir);
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  root.dpad?.querySelectorAll('[data-dir]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      dpadPointer = event.pointerId;
      dpadDir = button.dataset.dir;
    });
    const release = (event) => {
      if (event.pointerId !== dpadPointer) return;
      dpadPointer = null;
      remember(dpadDir);
      dpadDir = null;
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
  });

  const board = root.board;
  if (board) {
    board.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      if (board.setPointerCapture) board.setPointerCapture(event.pointerId);
      swipe = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
    });
    board.addEventListener('pointermove', (event) => {
      if (!swipe || event.pointerId !== swipe.id) return;
      const dx = event.clientX - swipe.x;
      const dy = event.clientY - swipe.y;
      if (Math.hypot(dx, dy) < 22) return;
      swipe.moved = true;
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      swipeDir = dir;
      swipeUntil = performance.now() + 420;
      remember(dir);
      swipe.x = event.clientX;
      swipe.y = event.clientY;
    });
    const endSwipe = (event) => {
      if (!swipe || event.pointerId !== swipe.id) return;
      if (!swipe.moved) startEdge = true;
      swipe = null;
    };
    board.addEventListener('pointerup', endSwipe);
    board.addEventListener('pointercancel', endSwipe);
  }

  return {
    sample() {
      const now = performance.now();
      let dir = null;
      if (dpadDir) dir = dpadDir;
      else if (keys.length) dir = keys[keys.length - 1];
      else if (now < swipeUntil) dir = swipeDir;
      else if (now < bufferUntil) dir = bufferDir;
      const out = {
        dir,
        pausePressed: pauseEdge,
        startPressed: startEdge,
        restartPressed: restartEdge,
      };
      pauseEdge = false;
      startEdge = false;
      restartEdge = false;
      return out;
    },
    pressStart() {
      startEdge = true;
    },
    pressPause() {
      pauseEdge = true;
    },
    pressRestart() {
      restartEdge = true;
    },
  };
}
