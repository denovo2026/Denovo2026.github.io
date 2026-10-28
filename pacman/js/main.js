import { createAudio } from './audio.js';
import { Game, ROLE_COPY, ROSTER, bootCheck } from './game.js';
import { createInput } from './input.js';
import { draw, resizeBoard } from './render.js';

const HIGH_KEY = 'mazemuncher.high';

function loadHighScore() {
  try {
    const value = Number(localStorage.getItem(HIGH_KEY));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function saveHighScore(score) {
  try {
    localStorage.setItem(HIGH_KEY, String(score));
  } catch {
    /* private mode */
  }
}

const problems = bootCheck();
if (problems.length) console.error('Maze Muncher maze check failed', problems);

const canvas = document.getElementById('board');
const wrap = document.getElementById('board-wrap');
const field = document.getElementById('playfield');
const overlay = document.getElementById('overlay');
const audio = createAudio();
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const game = new Game({
  highScore: loadHighScore(),
  reduceMotion: reduce,
  debug: new URLSearchParams(location.search).has('debug'),
});

const input = createInput({
  board: wrap,
  dpad: document.getElementById('dpad'),
});

const ui = {
  score: document.getElementById('score'),
  best: document.getElementById('best'),
  level: document.getElementById('level'),
  left: document.getElementById('left'),
  lives: document.getElementById('lives'),
  combo: document.getElementById('combo'),
  mute: document.getElementById('btn-mute'),
  pause: document.getElementById('btn-pause'),
  title: document.getElementById('screen-title'),
  pauseScreen: document.getElementById('screen-pause'),
  over: document.getElementById('screen-over'),
  overScore: document.getElementById('over-score'),
  overBest: document.getElementById('over-best'),
  overNote: document.getElementById('over-note'),
  titleBest: document.getElementById('title-best'),
  roster: document.getElementById('roster'),
};

ui.roster.innerHTML = ROSTER.map((shade) => (
  `<li><i style="background:${shade.color}"></i><span><b>${shade.name}</b> ${ROLE_COPY[shade.role]}</span></li>`
)).join('');

function unlock() {
  audio.unlock();
}

document.getElementById('btn-play').addEventListener('click', () => {
  unlock();
  input.pressStart();
});
document.getElementById('btn-resume').addEventListener('click', () => {
  unlock();
  input.pressPause();
});
document.getElementById('btn-restart').addEventListener('click', () => {
  unlock();
  input.pressRestart();
});
document.getElementById('btn-again').addEventListener('click', () => {
  unlock();
  input.pressStart();
});
ui.pause.addEventListener('click', () => {
  unlock();
  if (game.state === 'title') input.pressStart();
  else if (game.state === 'gameover') input.pressStart();
  else input.pressPause();
});
document.getElementById('dpad-pause').addEventListener('click', () => {
  unlock();
  if (game.state === 'title' || game.state === 'gameover') input.pressStart();
  else input.pressPause();
});
ui.mute.addEventListener('click', () => {
  unlock();
  audio.toggle();
  syncHud();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && (game.state === 'playing' || game.state === 'ready')) input.pressPause();
});

let savedHigh = game.highScore;
let shownScore = -1;

function syncHud() {
  ui.score.textContent = String(game.score);
  ui.best.textContent = String(game.highScore);
  ui.titleBest.textContent = String(game.highScore);
  ui.level.textContent = game.state === 'title' ? '–' : String(game.level);
  ui.left.textContent = game.state === 'title' ? '–' : String(game.dotsLeft);
  if (game.score !== shownScore) {
    shownScore = game.score;
    ui.score.classList.remove('bump');
    void ui.score.offsetWidth;
    ui.score.classList.add('bump');
  }
  ui.lives.replaceChildren();
  const count = Math.max(0, game.lives);
  for (let i = 0; i < Math.min(count, 5); i++) {
    const icon = document.createElement('span');
    icon.className = 'life';
    icon.setAttribute('aria-hidden', 'true');
    ui.lives.appendChild(icon);
  }
  ui.lives.setAttribute('aria-label', `${count} ${count === 1 ? 'life' : 'lives'} left`);
  if (game.state === 'playing' && game.frightTimer > 0) {
    ui.combo.hidden = false;
    ui.combo.textContent = game.combo > 0 ? `Chain ×${game.combo}` : 'Power';
  } else {
    ui.combo.hidden = true;
  }
  ui.mute.textContent = audio.muted ? 'Sound off' : 'Sound on';
  ui.mute.setAttribute('aria-pressed', audio.muted ? 'true' : 'false');
  const canPause = game.state === 'playing' || game.state === 'ready' || game.state === 'paused';
  ui.pause.textContent = game.state === 'paused' ? 'Resume' : 'Pause';
  ui.pause.disabled = !canPause;

  const showTitle = game.state === 'title';
  const showPause = game.state === 'paused';
  const showOver = game.state === 'gameover';
  overlay.hidden = !(showTitle || showPause || showOver);
  ui.title.hidden = !showTitle;
  ui.pauseScreen.hidden = !showPause;
  ui.over.hidden = !showOver;
  if (showOver) {
    ui.overScore.textContent = String(game.score);
    ui.overBest.textContent = String(game.highScore);
    ui.overNote.hidden = !game.newBest;
  }
  if (game.highScore !== savedHigh) {
    savedHigh = game.highScore;
    saveHighScore(savedHigh);
  }
}

let last = performance.now();
let acc = 0;
const STEP = 1 / 60;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt;
  const sample = input.sample();
  let steps = 0;
  while (acc >= STEP && steps < 5) {
    game.update(STEP, sample);
    for (const event of game.events) audio.play(event);
    sample.pausePressed = false;
    sample.startPressed = false;
    sample.restartPressed = false;
    acc -= STEP;
    steps += 1;
  }
  if (steps === 5) acc = 0;
  audio.sync(game);
  const ctx = resizeBoard(canvas, wrap, field, game.maze.cols, game.maze.rows);
  if (ctx) draw(ctx, game);
  syncHud();
  requestAnimationFrame(frame);
}

window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });
syncHud();
requestAnimationFrame(frame);
