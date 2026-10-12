/**
 * Divergence — a people living generations on another world becomes a
 * different people (design: docs/plans/2026-10-12-expansion-and-divergence.md,
 * phase P2; owner's idea: smaller / bigger / different colour over time).
 *
 * A colony's `lineage` carries four heritable ADAPTATIONS, each -1..1, all 0
 * for the home population:
 *
 *   size        - heavier gravity selects smaller, sturdier bodies; lighter, larger
 *   pigment     - harsher light selects darker skin; dim light, paler
 *   eyes        - dim light selects larger eyes
 *   insulation  - cold selects fur, fat and bulk; heat, bare and slender
 *
 * The world sets an OPTIMUM from how it differs from home (gravity, light,
 * heat). Each generation (one EVOLUTION_TICK_RATE on the colony world) the
 * adaptations move a small step toward it, with a little drift. Contact with
 * home is gene flow: it slows the step and pulls back toward home. A world
 * like home barely changes its people; a strange, isolated one changes them a
 * great deal — slowly (owner: across sessions).
 *
 * Pure and deterministic: the caller supplies the random source.
 */
import type { SpeciesGenome } from './SpeciesGenome';
import { idealOrbitRadius } from './LifeSystem';

export interface Adaptations { size: number; pigment: number; eyes: number; insulation: number }
export const NO_ADAPTATION: Adaptations = { size: 0, pigment: 0, eyes: 0, insulation: 0 };
const KEYS: Array<keyof Adaptations> = ['size', 'pigment', 'eyes', 'insulation'];

/** How a world differs from the home world, each -1..1 (0 = the same). */
export interface WorldEnv { gravity: number; light: number; heat: number }

export interface WorldFacts { radius: number; orbitalRadius: number; type: string; starTemperature: number }

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
/** How warm a planet type runs, beyond what its light gives it. */
const TYPE_HEAT: Record<string, number> = { ice: -0.6, ocean: 0, rocky: 0, desert: 0.35, lava: 0.8, toxic: 0.3, crystal: -0.1, carbon: 0.1, storm: 0, gas: 0 };

/** Light falling on a planet, relative units: T^4 / (r / goldilocks r)^2. */
function lightOf(w: WorldFacts): number {
  const rel = w.orbitalRadius / Math.max(1e-6, idealOrbitRadius(w.starTemperature));
  return Math.pow(w.starTemperature / 5800, 4) / Math.max(0.05, rel * rel);
}

/** How a colony world differs from home. */
export function worldEnv(colony: WorldFacts, home: WorldFacts): WorldEnv {
  const gravity = clamp((colony.radius / Math.max(1e-6, home.radius) - 1) * 1.5);
  const light = clamp(Math.log2(lightOf(colony) / Math.max(1e-9, lightOf(home))) / 3);
  const heat = clamp(light * 0.6 + (TYPE_HEAT[colony.type] ?? 0) - (TYPE_HEAT[home.type] ?? 0));
  return { gravity, light, heat };
}

/** What the world selects for. */
export function optimumFor(env: WorldEnv): Adaptations {
  return {
    size: clamp(-env.gravity * 0.9 - env.heat * 0.2),
    pigment: clamp(env.light),
    eyes: clamp(-env.light * 0.9),
    insulation: clamp(-env.heat),
  };
}

// ── Tuning (owner: slow, across sessions) ───────────────────────────────────
/** Share of the gap to the optimum closed per generation, with no contact. */
export const SELECTION = 0.03;
/** Pull back toward home per generation, at contact 1. */
export const GENE_FLOW = 0.012;
/** Per-generation drift (standard deviation, roughly). */
const DRIFT = 0.01;
/**
 * Most a trait can move in one generation. Without it a very strange world
 * made a new species in ~24 generations (~7 h at Normal pace); the owner wants
 * a new species to be rare: ~60+ generations, isolated.
 */
export const MAX_STEP = 0.007;

/** One generation on the colony world. `rand()` is 0..1. */
export function generationStep(a: Adaptations, opt: Adaptations, contact: number, rand: () => number): Adaptations {
  const c = clamp(contact, 0, 1);
  const out = { ...a };
  for (const k of KEYS) {
    const noise = (rand() + rand() + rand() - 1.5) * DRIFT;
    const d = SELECTION * (1 - 0.6 * c) * (opt[k] - a[k]) - GENE_FLOW * c * a[k] + noise;
    out[k] = clamp(a[k] + clamp(d, -MAX_STEP, MAX_STEP));
  }
  return out;
}

/** How far a lineage has moved from the home population (RMS of its adaptations). */
export function distanceFromHome(a: Adaptations | undefined): number {
  if (!a) return 0;
  return Math.sqrt(KEYS.reduce((s, k) => s + a[k] * a[k], 0) / KEYS.length);
}

export type DivergenceStage = 'same' | 'variant' | 'subspecies' | 'species';
/** Thresholds on distanceFromHome. A new species also needs little contact. */
export const STAGE_AT = { variant: 0.08, subspecies: 0.18, species: 0.3 } as const;
export const SPECIES_MAX_CONTACT = 0.35;

export function stageOf(distance: number, contact: number): DivergenceStage {
  if (distance >= STAGE_AT.species && contact <= SPECIES_MAX_CONTACT) return 'species';
  if (distance >= STAGE_AT.subspecies) return 'subspecies';
  if (distance >= STAGE_AT.variant) return 'variant';
  return 'same';
}

/** Words for what has visibly changed, strongest first ("pale", "great", ...). */
export function describe(a: Adaptations | undefined): string[] {
  if (!a) return [];
  const words: Array<[number, string]> = [
    [a.size, a.size > 0 ? 'great' : 'lesser'],
    [a.pigment, a.pigment > 0 ? 'dark' : 'pale'],
    [a.eyes, a.eyes > 0 ? 'wide-eyed' : 'narrow-eyed'],
    [a.insulation, a.insulation > 0 ? 'shaggy' : 'sleek'],
  ];
  return words.filter(([v]) => Math.abs(v) >= 0.08).sort((x, y) => Math.abs(y[0]) - Math.abs(x[0])).map(([, w]) => w);
}

/** The lineage's adaptations, defaulting to the home population's. */
export function adaptationsOf(g: SpeciesGenome | null | undefined): Adaptations {
  return { ...NO_ADAPTATION, ...(g?.adaptations ?? {}) };
}
