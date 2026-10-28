/**
 * Tiny Web Audio synthesizer. No sample files.
 * The siren is quiet on purpose; the crumb clicks carry the rhythm.
 */

const STORAGE_KEY = 'mazemuncher.mute';

function readMute() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMute(muted) {
  try {
    localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* private mode */
  }
}

export function createAudio() {
  let ctx = null;
  let master = null;
  let siren = null;
  let sirenGain = null;
  let muted = readMute();
  let flip = false;

  function context() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!ctx) {
      ctx = new AudioCtx();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, dur, type, vol, freq2, delay = 0) {
    if (muted) return;
    const audio = context();
    if (!audio || !master) return;
    const t = audio.currentTime + delay;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(40, freq), t);
    if (freq2) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq2), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function stopSiren() {
    if (!siren) return;
    try {
      siren.stop();
    } catch {
      /* already stopped */
    }
    siren.disconnect();
    sirenGain.disconnect();
    siren = null;
    sirenGain = null;
  }

  function sync(game) {
    const active = !muted && game.state === 'playing' && !game.demo;
    if (!active || !ctx) {
      stopSiren();
      return;
    }
    if (!siren) {
      siren = ctx.createOscillator();
      sirenGain = ctx.createGain();
      siren.type = 'triangle';
      siren.frequency.value = 78;
      sirenGain.gain.value = 0.012;
      siren.connect(sirenGain);
      sirenGain.connect(master);
      siren.start();
    }
    const total = Math.max(1, game.maze.totalDots);
    const urgency = 1 - game.dotsLeft / total;
    const freq = 74 + urgency * 96;
    siren.frequency.setTargetAtTime(freq, ctx.currentTime, 0.12);
  }

  function play(event) {
    if (muted || !event) return;
    switch (event) {
      case 'dot':
        flip = !flip;
        tone(flip ? 760 : 560, 0.04, 'square', 0.02);
        break;
      case 'power':
        tone(160, 0.22, 'sawtooth', 0.04, 70);
        tone(480, 0.18, 'square', 0.03, 880);
        break;
      case 'eat':
        tone(420, 0.08, 'square', 0.04, 640);
        tone(760, 0.12, 'square', 0.035, 1100);
        break;
      case 'fruit':
        tone(660, 0.1, 'triangle', 0.04);
        tone(990, 0.14, 'triangle', 0.035);
        break;
      case 'death':
        tone(420, 0.45, 'sawtooth', 0.05, 70);
        break;
      case 'clear':
        [523, 659, 784, 1046].forEach((freq, index) => {
          tone(freq, 0.12, 'square', 0.028, null, index * 0.09);
        });
        break;
      case 'start':
        tone(392, 0.09, 'square', 0.03, null, 0);
        tone(523, 0.09, 'square', 0.03, null, 0.1);
        tone(659, 0.14, 'square', 0.035, null, 0.2);
        break;
      case 'go':
        tone(784, 0.09, 'square', 0.028);
        break;
      case 'extra':
        tone(880, 0.1, 'square', 0.035);
        tone(1320, 0.16, 'square', 0.03);
        break;
      default:
        break;
    }
  }

  return {
    play,
    sync,
    unlock: context,
    get muted() {
      return muted;
    },
    toggle() {
      muted = !muted;
      writeMute(muted);
      if (muted) stopSiren();
      else context();
      return muted;
    },
  };
}
