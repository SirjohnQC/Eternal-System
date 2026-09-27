/**
 * PlanetGenome — the single source of per-planet identity.
 *
 * Everything that makes one world look different from another derives from one
 * number. The SEED is never derived from `planet.type`: terraforming mutates
 * type (BigBangEngine TERRAFORM_SEQUENCES), and a type-derived seed would
 * silently reroll a world's identity mid-game. Type is an input to the roll —
 * it sets the colour family the seed drifts around — so the air of a
 * terraformed world follows its new type while keeping its own drift.
 * `sourceType` records the type a genome was rolled with.
 *
 * Pure module. No DOM, no Canvas, no imports from src/rendering.
 */

import type { PlanetDNA } from './GameState';

/** Air: colour of the scatter, how thick the shell is, how opaque. */
export interface AtmosphereChannel {
  /** Hue 0–360 of the sunlit limb. */
  hue: number;
  /** 0–1. How far the scatter departs from grey. */
  saturation: number;
  /** Shell thickness in native px, before body-radius scaling. */
  thicknessPx: number;
  /** Multiplies overall opacity. Thick on lava/gas, thin on desert/carbon. */
  density: number;
}

export interface PlanetGenome {
  /** The number everything derives from. Stable for the planet's whole life. */
  seed: number;
  /** Planet type at roll time. Informational — never re-derive from live type. */
  sourceType: string;
  atmosphere: AtmosphereChannel;
}

// ─── Deterministic hashing ────────────────────────────────────────────────────

/** Stable 32-bit hash. Same inputs always give the same float in [0,1). */
function hash1(seed: number, salt: number): number {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(salt | 0, 2654435761)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1540483477) | 0;
  h = h ^ (h >>> 15);
  return (h >>> 0) / 4294967296;
}

/** Float in [lo, hi) from (seed, salt). */
function rand(seed: number, salt: number, lo: number, hi: number): number {
  return lo + hash1(seed, salt) * (hi - lo);
}

/**
 * Genome seed for a planet, from its star and orbital index.
 *
 * Multiplied by large odd co-prime factors so neighbouring planets in
 * neighbouring systems do not land on the same seed.
 */
export function genomeSeedFor(starId: number, planetIndex: number): number {
  return ((Math.imul(starId | 0, 2654435761) ^ Math.imul(planetIndex | 0, 40503)) >>> 0);
}

// ─── Legacy parity ────────────────────────────────────────────────────────────

/**
 * Today's per-type atmosphere, held as RGB bytes lifted verbatim from
 * src/rendering/HabitableCutawayEngine.ts and converted to hue/saturation
 * in code. RGB bytes eliminate the error class of hand-converted HSL.
 * Densities came from `CutawayPalette.atmoDensity` in that file.
 *
 * This is now the ONLY copy of those numbers: `CutawayPalette.atmo` and
 * `.atmoDensity` were deleted once nothing read them, rather than left behind
 * as a second source of truth to drift against this one.
 *
 * This table exists so Phase 1 is invisible: `genomeFromLegacy` reproduces the
 * shipped look exactly. It is deleted once the rolled atmosphere lands.
 */
const LEGACY_ATMO: Record<string, { rgb: [number, number, number]; density: number }> = {
  ocean:   { rgb: [ 65, 165, 255], density: 1.00 },
  rocky:   { rgb: [158, 148, 128], density: 1.00 },
  ice:     { rgb: [140, 200, 240], density: 1.05 },
  lava:    { rgb: [210,  70,  20], density: 1.55 },
  gas:     { rgb: [170, 140, 190], density: 1.45 },
  toxic:   { rgb: [170, 210,  50], density: 1.25 },
  crystal: { rgb: [150,  90, 220], density: 1.15 },
  desert:  { rgb: [210, 170,  90], density: 0.70 },
  storm:   { rgb: [100,  90, 130], density: 1.60 },
  carbon:  { rgb: [ 70, 120, 190], density: 0.65 },
};

/**
 * RGB -> hue/saturation, so the table above can hold the renderer's bytes
 * verbatim instead of hand-converted HSL. Hand conversion is what produced
 * four wrong entries in the first draft of this table; copying integers and
 * converting in code removes that class of error entirely.
 */
function rgbToHueSat(r: number, g: number, b: number): { hue: number; saturation: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn);
  const d = mx - mn, l = (mx + mn) / 2;
  if (d === 0) return { hue: 0, saturation: 0 };
  let h: number;
  if (mx === rn)      h = ((gn - bn) / d) % 6;
  else if (mx === gn) h = (bn - rn) / d + 2;
  else                h = (rn - gn) / d + 4;
  return {
    hue: ((h * 60) % 360 + 360) % 360,
    saturation: d / (1 - Math.abs(2 * l - 1)),
  };
}

/** OZONE_FADE_PX in the shipped renderer. Kept identical for Phase 1 parity. */
const LEGACY_THICKNESS_PX = 8;

/** The shipped renderer's air for one planet type, as an AtmosphereChannel. */
function legacyChannel(type: string): AtmosphereChannel {
  const l = LEGACY_ATMO[type] ?? LEGACY_ATMO.rocky;
  const { hue, saturation } = rgbToHueSat(l.rgb[0], l.rgb[1], l.rgb[2]);
  return { hue, saturation, thicknessPx: LEGACY_THICKNESS_PX, density: l.density };
}

/**
 * A genome that reproduces the shipped per-type look exactly.
 *
 * Used by call sites that still pass a bare type string, so existing
 * guards keep running unchanged while they are migrated.
 */
export function genomeFromLegacy(type: string, seed: number): PlanetGenome {
  return { seed, sourceType: type, atmosphere: legacyChannel(type) };
}

/**
 * The air to draw for a planet.
 *
 * Pass the LIVE type. Type sets the colour family and the seed sets the drift
 * around it, so a terraformed world's air follows its new type while its
 * drift — its identity — stays the same. With no usable seed (a dev harness,
 * or anything that bypassed `loadState`'s backfill) this is the shipped
 * per-type air, exactly as before genomes reached the screen.
 */
export function atmosphereForPlanet(
  genomeSeed: number | undefined, type: string,
): AtmosphereChannel {
  return Number.isFinite(genomeSeed)
    ? rollPlanetGenome(genomeSeed as number, type, null).atmosphere
    : legacyChannel(type);
}

// ─── The roll ─────────────────────────────────────────────────────────────────

/**
 * The thickest shell the roll can produce, in native px. The home-world
 * layout reserves room for this much air above the dome, so it must stay the
 * roll's real upper bound.
 */
export const ATMO_THICKNESS_MAX_PX = 13;

/**
 * Hue drift range per type, degrees; ±22 unless listed. Lava sits at ~16deg,
 * one short step from the red/magenta boundary: a symmetric roll reached 354deg
 * and rendered a salmon-PINK dome (measured 2026-09-26, 3 of 12 seeds; the
 * project's recurring lava-pink failure). Its drift only runs toward orange.
 */
const HUE_DRIFT: Record<string, [number, number]> = {
  lava: [-4, 22],
};

/**
 * Roll a genome. Type and DNA bias the result; the seed decides it.
 *
 * Phase 1 rolls only the atmosphere channel. Terrain archetype, materials,
 * fluids and interior land in later phases — the shape of this function does
 * not change when they do.
 */
export function rollPlanetGenome(
  seed: number, type: string, _dna?: PlanetDNA | null,
): PlanetGenome {
  const base = legacyChannel(type);
  return {
    seed,
    sourceType: type,
    atmosphere: {
      // Drift around the type's characteristic hue rather than replacing it,
      // so a lava world is still recognisably lava-coloured.
      hue: (base.hue + rand(seed, 101, HUE_DRIFT[type]?.[0] ?? -22, HUE_DRIFT[type]?.[1] ?? 22) + 360) % 360,
      saturation: Math.max(0, Math.min(1, base.saturation * rand(seed, 103, 0.82, 1.18))),
      thicknessPx: Math.round(rand(seed, 107, 6, ATMO_THICKNESS_MAX_PX)),
      // Density is deliberately unclamped because it is a multiplier (0.85–1.15×),
      // not a normalised value.
      density: base.density * rand(seed, 109, 0.85, 1.15),
    },
  };
}
