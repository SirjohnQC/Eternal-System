/**
 * PlanetGenome — the single source of per-planet identity.
 *
 * Everything that makes one world look different from another derives from one
 * number. The genome is NEVER derived from `planet.type`: terraforming mutates
 * type (BigBangEngine TERRAFORM_SEQUENCES), and a type-derived genome would
 * silently reroll a world's identity mid-game. Type biases the roll once, at
 * creation, and is recorded as `sourceType` for reference only.
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
 * Today's per-type atmosphere, lifted verbatim from HabitableCutawayEngine's
 * palettes (`atmo` + `atmoDensity`) and OZONE_FADE_PX.
 *
 * This table exists so Phase 1 is invisible: `genomeFromLegacy` reproduces the
 * shipped look exactly. It is deleted once the rolled atmosphere lands.
 */
const LEGACY_ATMO: Record<string, { hue: number; saturation: number; density: number }> = {
  ocean:   { hue: 209, saturation: 1.00, density: 1.00 },
  rocky:   { hue:  36, saturation: 0.19, density: 1.00 },
  ice:     { hue: 200, saturation: 0.42, density: 1.05 },
  lava:    { hue:  16, saturation: 0.90, density: 1.55 },
  crystal: { hue: 276, saturation: 0.29, density: 1.45 },
  toxic:   { hue:  71, saturation: 0.76, density: 1.25 },
  storm:   { hue: 265, saturation: 0.59, density: 1.15 },
  desert:  { hue:  40, saturation: 0.57, density: 0.70 },
  gas:     { hue: 209, saturation: 1.00, density: 1.00 },
  carbon:  { hue:  36, saturation: 0.19, density: 0.70 },
};

/** OZONE_FADE_PX in the shipped renderer. Kept identical for Phase 1 parity. */
const LEGACY_THICKNESS_PX = 8;

/**
 * A genome that reproduces the shipped per-type look exactly.
 *
 * Used by the nine call sites that still pass a bare type string, so existing
 * guards keep running unchanged while they are migrated.
 */
export function genomeFromLegacy(type: string, seed: number): PlanetGenome {
  const l = LEGACY_ATMO[type] ?? LEGACY_ATMO.rocky;
  return {
    seed,
    sourceType: type,
    atmosphere: {
      hue: l.hue,
      saturation: l.saturation,
      thicknessPx: LEGACY_THICKNESS_PX,
      density: l.density,
    },
  };
}

// ─── The roll ─────────────────────────────────────────────────────────────────

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
  const base = LEGACY_ATMO[type] ?? LEGACY_ATMO.rocky;
  return {
    seed,
    sourceType: type,
    atmosphere: {
      // Drift around the type's characteristic hue rather than replacing it,
      // so a lava world is still recognisably lava-coloured.
      hue: (base.hue + rand(seed, 101, -22, 22) + 360) % 360,
      saturation: Math.max(0, Math.min(1, base.saturation * rand(seed, 103, 0.82, 1.18))),
      thicknessPx: Math.round(rand(seed, 107, 6, 13)),
      density: base.density * rand(seed, 109, 0.85, 1.15),
    },
  };
}
