/**
 * UI sounds, synthesised (no files to ship): the menu and the dice console.
 *
 * Every sound has two layers, the game's theme in miniature:
 *   - a soft sine "bell": the god;
 *   - a short square/noise "bit" under it: the machine the god is running in.
 *
 * All go through AudioManager's SFX bus, so the SFX volume and mute apply.
 * UI only: Math.random here never touches the simulation.
 */
import { AudioManager } from './AudioManager';

/** A minor pentatonic, two octaves: hovering down a menu plays a little scale. */
const SCALE = [440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98];

/** A note in `SCALE` (wraps). */
export function scaleNote(i: number): number {
  const n = SCALE.length;
  return SCALE[((Math.floor(i) % n) + n) % n];
}

/** One enveloped oscillator. */
function tone(ctx: AudioContext, out: AudioNode, type: OscillatorType, freq: number,
  gain: number, attack: number, decay: number, at = 0, detune = 0): void {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

let noiseBuf: AudioBuffer | null = null;
/** A burst of filtered noise. */
function noise(ctx: AudioContext, out: AudioNode, freq: number, q: number, gain: number,
  decay: number, at = 0, sweepTo?: number): void {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + decay);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.3);
  src.stop(t + decay + 0.05);
}

let lastHover = 0;

export const UiSound = {
  /** Pointer over a button: a glassy ping, pitched by the button's place. */
  hover(index = 0): void {
    const now = performance.now();
    if (now - lastHover < 45) return; // a sweep across many buttons stays a sweep, not a roar
    lastHover = now;
    AudioManager.synth((ctx, out) => {
      const f = scaleNote(index + 2);
      tone(ctx, out, 'sine', f, 0.07, 0.004, 0.22);
      tone(ctx, out, 'sine', f * 2, 0.018, 0.004, 0.12, 0, 6);
      tone(ctx, out, 'square', f * 4, 0.006, 0.001, 0.025, 0.012); // the machine, under it
    });
  },

  /** A button pressed: root and fifth, with a digital click. */
  click(): void {
    AudioManager.synth((ctx, out) => {
      tone(ctx, out, 'sine', 330, 0.09, 0.005, 0.35);
      tone(ctx, out, 'sine', 495, 0.05, 0.005, 0.3, 0.02);
      tone(ctx, out, 'square', 1320, 0.012, 0.001, 0.03);
      noise(ctx, out, 3000, 4, 0.03, 0.04);
    });
  },

  /** One face of a tumbling die: a ratchet click, rising as the roll goes on (0..1). */
  tick(progress: number): void {
    AudioManager.synth((ctx, out) => {
      const p = Math.max(0, Math.min(1, progress));
      noise(ctx, out, 1400 + 2600 * p + Math.random() * 500, 9, 0.05, 0.03);
      tone(ctx, out, 'square', 220 + 440 * p, 0.006, 0.001, 0.02);
    });
  },

  /** A die settles on `value` (1..20): low rolls a minor chord, high a bright major. */
  lock(value: number): void {
    AudioManager.synth((ctx, out) => {
      const root = 196 + value * 6;
      const third = value >= 13 ? root * 1.26 : value >= 8 ? root * 1.2 : root * 1.19;
      const chord = [root, third, root * 1.5];
      chord.forEach((f, i) => tone(ctx, out, 'sine', f, 0.06, 0.006, 0.9, i * 0.035));
      if (value >= 17) [2, 2.52, 3].forEach((m, i) => tone(ctx, out, 'sine', root * m, 0.025, 0.01, 1.4, 0.12 + i * 0.05, 4));
      tone(ctx, out, 'square', root * 4, 0.01, 0.001, 0.04);
      tone(ctx, out, 'square', root * 6, 0.008, 0.001, 0.04, 0.06);
      noise(ctx, out, 900, 2, 0.04, 0.12);
    });
  },

  /** The simulation shows its seams: a short torn-signal burst. */
  glitch(): void {
    AudioManager.synth((ctx, out) => {
      noise(ctx, out, 5000, 3, 0.035, 0.14, 0, 300);
      tone(ctx, out, 'square', 60, 0.02, 0.001, 0.08);
      tone(ctx, out, 'square', 2093, 0.006, 0.001, 0.02, 0.05);
    });
  },

  /** The god wakes: a slow deep swell with a bright edge. */
  awaken(): void {
    AudioManager.synth((ctx, out) => {
      [55, 82.5, 110, 165].forEach((f, i) => tone(ctx, out, 'sine', f, 0.09 - i * 0.012, 0.9, 2.8, 0, i * 3));
      [880, 1318.5].forEach((f, i) => tone(ctx, out, 'sine', f, 0.012, 1.2, 2.2, 0.3 + i * 0.2));
      noise(ctx, out, 400, 1, 0.03, 1.6, 0.1, 4000);
    });
  },
};

/** Buttons that answer to hover, on the menu and the dice console. */
export const HOVER_SOUND_SELECTOR =
  '.menu-btn, .action-btn, .mode-choice, .planet-name-rnd, #rolling-back-btn, .pq-choice';

/** Hover and click sounds for every matching button, present or future (event delegation). */
export function wireUiSounds(root: HTMLElement | Document = document): void {
  let current: Element | null = null;
  root.addEventListener('pointerover', e => {
    const btn = (e.target as Element | null)?.closest?.(HOVER_SOUND_SELECTOR) ?? null;
    if (btn === current) return;
    current = btn;
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    const sibs = btn.parentElement ? Array.from(btn.parentElement.querySelectorAll(HOVER_SOUND_SELECTOR)) : [];
    UiSound.hover(Math.max(0, sibs.indexOf(btn)));
  });
  root.addEventListener('click', e => {
    const btn = (e.target as Element | null)?.closest?.(HOVER_SOUND_SELECTOR);
    if (btn && !(btn as HTMLButtonElement).disabled) UiSound.click();
  });
}
