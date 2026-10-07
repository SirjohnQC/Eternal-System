/**
 * The Big Bang cinematic: a ~43 s, skippable camera tour of THIS universe's
 * birth, from a single point of light to the player's molten world.
 *
 * Nothing here is canned footage. The early beats (singularity, plasma,
 * cooling) are drawn by the overlay; from "first stars" on, what you see is the
 * real simulation — the engine's own inflation, its galaxies, the player's
 * actual home galaxy, star and world. This module is only the clock: which beat
 * we are in, how far through it, when the simulation is let go and how fast it
 * runs, and how strongly each layer shows. The engine reads it to hold or pace
 * its ticks and to point the camera; the renderer reads it for the overlay.
 *
 * Pure and DOM-free so tools can drive it headless.
 */

import { INFLATION_TICKS } from '../constants';

export type CineStage =
  | 'singularity' | 'bang' | 'plasma' | 'cooling' | 'firstStars'
  | 'web' | 'galaxies' | 'dive' | 'ignition' | 'world';

export interface CineBeat {
  stage: CineStage;
  /** Seconds. */
  dur: number;
  /**
   * The god's line for this beat. `{galaxy}`, `{planet}` and `{god}` are filled
   * in by the UI from the real universe. Empty = no caption.
   */
  caption: string;
}

export const CINE_BEATS: readonly CineBeat[] = [
  { stage: 'singularity', dur: 3.5, caption: 'Before light, there was only potential.' },
  { stage: 'bang',        dur: 1.5, caption: '' },
  { stage: 'plasma',      dur: 5.0, caption: 'Then everything, everywhere, at once: a sea of fire.' },
  { stage: 'cooling',     dur: 3.0, caption: 'It cooled. The first light broke free, and the dark came after.' },
  { stage: 'firstStars',  dur: 5.5, caption: 'Out of that dark, the first stars ignite.' },
  { stage: 'web',         dur: 6.0, caption: 'Gravity draws them along the threads of a vast web.' },
  { stage: 'galaxies',    dur: 5.0, caption: 'Where the threads knot, galaxies are born.' },
  { stage: 'dive',        dur: 5.0, caption: 'In {galaxy}, a cloud of gas begins to fall inward...' },
  { stage: 'ignition',    dur: 4.0, caption: '...and a sun ignites.' },
  { stage: 'world',       dur: 5.5, caption: 'Around it, a molten world takes shape. {planet}.' },
];

const STARTS: number[] = [];
{ let t = 0; for (const b of CINE_BEATS) { STARTS.push(t); t += b.dur; } }
export const CINE_TOTAL = CINE_BEATS.reduce((s, b) => s + b.dur, 0);

/** Start time (s) of a beat. */
export function beatStart(stage: CineStage): number {
  return STARTS[CINE_BEATS.findIndex(b => b.stage === stage)];
}

/**
 * When the simulation is let go: as the dark lifts, so the first stars are
 * seen streaming out of the centre.
 */
export const CINE_RELEASE = beatStart('firstStars') - 0.4;

/** Simulation ticks of Big Bang (inflation + gravity) the cinematic must fit. */
export const CINE_BANG_TICKS = INFLATION_TICKS + 300;

/**
 * The Big Bang's ticks against the cinematic clock, as (time, tick) keys.
 * Slow while the stars stream outward (inflation does most of its spreading
 * in its first ~80 ticks), faster while the galaxies gather, settled a moment
 * before the dive.
 */
const TICK_KEYS: ReadonlyArray<readonly [number, number]> = [
  [CINE_RELEASE, 0],
  [beatStart('web'), 90],
  [beatStart('dive') - 0.3, CINE_BANG_TICKS],
];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const x = clamp01(v); return x * x * (3 - 2 * x); };
/** 0→1 as t goes a→b, smoothstepped. */
export const ramp = (t: number, a: number, b: number) => smooth((t - a) / (b - a));

export class BigBangCinematic {
  /** Seconds since the cinematic began. */
  t = 0;
  /** Set once it has run out or been skipped. */
  finished = false;
  /** Dev/tools: stop the clock (seek still works) to inspect a moment. */
  frozen = false;

  get beatIndex(): number {
    for (let i = CINE_BEATS.length - 1; i >= 0; i--) if (this.t >= STARTS[i]) return i;
    return 0;
  }
  get beat(): CineBeat { return CINE_BEATS[this.beatIndex]; }
  get stage(): CineStage { return this.beat.stage; }
  /** 0..1 through the current beat. */
  get stageT(): number { const i = this.beatIndex; return clamp01((this.t - STARTS[i]) / CINE_BEATS[i].dur); }
  /** Seconds into a given beat (negative before it, past its length after). */
  since(stage: CineStage): number { return this.t - beatStart(stage); }

  /** Whether the engine may tick yet. */
  get simReleased(): boolean { return this.finished || this.t >= CINE_RELEASE; }

  /** Ticks the engine should have run by now (the target for skip/seek). */
  get targetTicks(): number {
    if (this.finished) return CINE_BANG_TICKS;
    const t = this.t;
    if (t <= TICK_KEYS[0][0]) return 0;
    for (let i = 1; i < TICK_KEYS.length; i++) {
      const [t0, k0] = TICK_KEYS[i - 1], [t1, k1] = TICK_KEYS[i];
      if (t <= t1) return Math.floor(k0 + (k1 - k0) * (t - t0) / (t1 - t0));
    }
    return CINE_BANG_TICKS;
  }

  advance(dtSec: number): void {
    if (this.finished || this.frozen) return;
    this.t += Math.max(0, dtSec);
    if (this.t >= CINE_TOTAL) { this.t = CINE_TOTAL; this.finished = true; }
  }

  // ── Layer strengths (0..1) ────────────────────────────────────────────────

  /** How much of the galaxy art shows: none in the early universe, growing as the web gathers. */
  get galaxyReveal(): number {
    if (this.finished) return 1;
    return 0.35 * ramp(this.since('web'), 1.5, 6) + 0.65 * ramp(this.since('galaxies'), 0, 3);
  }

  /** The player's sun: a dim protostar until it ignites. */
  get homeStarLight(): number {
    if (this.finished) return 1;
    return 0.12 + 0.88 * ramp(this.since('ignition'), 1.1, 2.0);
  }

  /** The player's planets condense out of the disc after the sun ignites. */
  get planetsReveal(): number {
    if (this.finished) return 1;
    return ramp(this.since('world'), -0.6, 1.8);
  }

  /** Fog of war stays off for the whole tour. */
  get fog(): number { return this.finished ? 1 : 0; }
}
