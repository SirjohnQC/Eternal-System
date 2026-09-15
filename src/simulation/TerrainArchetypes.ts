/**
 * Terrain archetypes — structurally different world recipes.
 *
 * Every world used to be `fbm(nx * 4, ny * 4)` with a sea-level offset, so
 * different seeds gave shuffles of one centred blob rather than different
 * worlds. These are separate generators, not one field masked three ways.
 *
 * The archetype shapes the ELEVATION FIELD only. Sea level still comes from
 * `oceanCoverage` (the player's DNA `oceans` choice), so the two stay
 * orthogonal: a barren archipelago is a broken plateau of exposed peaks, an
 * ocean-world supercontinent is a smaller continent.
 *
 * Noise lives here rather than being imported from PlanetGrid, because
 * PlanetGrid imports THIS module — importing back would make a runtime cycle.
 */

export type TerrainArchetype =
  | 'supercontinent' | 'archipelago' | 'hemispheric'
  | 'equatorial' | 'craterworld' | 'rift';

/** The archetypes with a generator today. The union carries all six. */
export const IMPLEMENTED: readonly TerrainArchetype[] =
  ['supercontinent', 'archipelago', 'hemispheric'] as const;

// ─── Noise, self-contained ───────────────────────────────────────────────────

function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 1057017 + seed * 2654435761) | 0;
  h = ((h ^ (h >>> 13)) * 1540483477) | 0;
  h = h ^ (h >>> 15);
  return ((h >>> 0) & 0xffff) / 0xffff;
}

function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const tx = x - ix, ty = y - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const n00 = hash2(ix, iy, seed), n10 = hash2(ix + 1, iy, seed);
  const n01 = hash2(ix, iy + 1, seed), n11 = hash2(ix + 1, iy + 1, seed);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
}

function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0, amp = 0.5, tot = 0, fx = x, fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(fx, fy, seed + o * 131) * amp;
    tot += amp; amp *= 0.5; fx *= 2; fy *= 2;
  }
  return sum / tot;
}

/**
 * fbm that wraps in x, by cross-fading the sample with one a full period away.
 * Mirrors the approach PlanetGrid already uses for its own field.
 */
function fbmWrapX(x: number, y: number, seed: number, octaves: number, nx: number,
                  period: number): number {
  const a = fbm(x, y, seed, octaves);
  const b = fbm(x - period, y, seed, octaves);
  return a * (1 - nx) + b * nx;
}

/** Ridged noise: peaks where the field crosses zero, valleys elsewhere. */
function ridge(x: number, y: number, seed: number, octaves: number, nx: number,
               period: number): number {
  const v = fbmWrapX(x, y, seed, octaves, nx, period);
  return 1 - Math.abs(v * 2 - 1);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ─── The generators ──────────────────────────────────────────────────────────

/**
 * Elevation for one cell, 0..1 — the same contract as the field it replaces.
 *
 * `nx` wraps (0 == 1) and is longitude; `ny` is latitude, 0 north to 1 south.
 */
export function elevationFor(
  archetype: TerrainArchetype, nx: number, ny: number, seed: number,
): number {
  switch (archetype) {
    case 'archipelago': {
      // Ridged high-frequency noise: only the ridge crests clear sea level, so
      // the world is hundreds of islets with no continental term at all.
      const r = ridge(nx * 9, ny * 9, seed, 4, nx, 9);
      const fine = ridge(nx * 19 + 7, ny * 19, seed ^ 0x51, 3, nx, 19);
      // Only the sharpest crests clear the water. Raising the ridge to a power
      // keeps the field low almost everywhere: a gentle version of this made a
      // continuous mountainous landmass with lakes, which is the opposite of
      // an archipelago.
      const crest = Math.pow(clamp01(r * 0.7 + fine * 0.3), 4.5);
      return clamp01(crest * 1.35);
    }

    case 'hemispheric': {
      // One half land, one half ocean, split by a seeded great circle with a
      // noisy boundary so the coast is ragged rather than drawn with a ruler.
      const ang = hash2(11, 7, seed) * Math.PI * 2;
      const px = Math.cos(nx * Math.PI * 2) , py = Math.sin(nx * Math.PI * 2);
      const along = px * Math.cos(ang) + py * Math.sin(ang);      // -1..1
      const lat = (ny - 0.5) * 2;                                  // -1..1
      const plane = along * 0.72 + lat * 0.28;
      const wobble = (fbmWrapX(nx * 5, ny * 5, seed ^ 0x9d, 4, nx, 5) - 0.5) * 0.55;
      const t = clamp01((plane + wobble + 0.55) / 1.1);
      // Land side rises to a broad interior, ocean side falls away. Kept just
      // above SEA_LEVEL (0.48) for most of the land: an earlier version ran to
      // ~0.85 and classified nearly the whole land half as mountain and snow,
      // so a temperate world came out white.
      return clamp01(0.30 + t * 0.34
        + (fbmWrapX(nx * 7, ny * 7, seed ^ 0x33, 3, nx, 7) - 0.5) * 0.18 * t);
    }

    case 'supercontinent':
    default: {
      // One dominant mass: a low-frequency dome with an offset centre, warped
      // by mid-frequency noise, with an inland sea subtracted from the
      // interior so the middle is not a featureless plateau.
      const cx = hash2(3, 5, seed), cy = 0.32 + hash2(5, 3, seed) * 0.36;
      const dx = Math.min(Math.abs(nx - cx), 1 - Math.abs(nx - cx)) * 2; // wraps
      const dy = (ny - cy) * 1.6;
      // Peak kept modest for the same reason as hemispheric: a dome running to
      // 1.0 turns its own interior into snowfields.
      const dome = clamp01(1 - Math.hypot(dx * 1.15, dy) * 1.25) * 0.62;
      const warp = (fbmWrapX(nx * 3.5, ny * 3.5, seed, 5, nx, 3.5) - 0.5) * 0.55;
      let e = clamp01(0.30 + dome + warp * 0.6);
      // Inland sea: a second lobe, only where the dome is already high.
      const sx = hash2(17, 2, seed), sy = 0.35 + hash2(2, 17, seed) * 0.3;
      const sdx = Math.min(Math.abs(nx - sx), 1 - Math.abs(nx - sx)) * 2;
      const sea = clamp01(1 - Math.hypot(sdx * 1.7, (ny - sy) * 2.4) * 2.4);
      e -= sea * 0.55 * clamp01((e - 0.35) * 3);
      return clamp01(e);
    }
  }
}

/** Which archetype a world gets. Rolled from `genomeSeed`, type-independent. */
export function rollArchetype(genomeSeed: number): TerrainArchetype {
  const r = hash2(91, 13, genomeSeed | 0);
  return IMPLEMENTED[Math.min(IMPLEMENTED.length - 1,
    Math.floor(r * IMPLEMENTED.length))];
}
