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

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** PlanetGrid's SEA_LEVEL, duplicated rather than imported: PlanetGrid imports
 *  this module, so importing back would make a runtime cycle. */
const SEA = 0.48;

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
      // Island ARCS in open sea. A plain ridge field does not work here and a
      // power curve does not save it: four-octave fbm piles up around 0.5, so
      // `1 - |2v-1|` sits near 1 over most of the world and the "ridges" merge
      // into one mountainous continent with lakes. Measured: 68% land, biggest
      // mass 0.998 — the opposite of the archetype.
      //
      // So the crest band is cut narrow instead of being raised to a power, and
      // a low-frequency mask decides which stretches of arc surface at all.
      // Between the arcs there is nothing to clear sea level.
      const v = fbmWrapX(nx * 6, ny * 6, seed, 5, nx, 6);
      const crest = clamp01(1 - Math.abs(v * 2 - 1) * 6.2);
      // The arcs fade toward the poles. Without this the densest island cluster
      // can be polar, and IsoDioramaRenderer centres its disc on the densest
      // land — so the player got a white pinwheel of snow islets where the
      // grid's columns converge, on a world the metrics called a fine
      // archipelago. Structure metrics cannot see that; looking at it can.
      const latBand = clamp01(1.6 - Math.abs(ny - 0.5) * 3.2);
      const mask = clamp01(
        (fbmWrapX(nx * 2.5, ny * 2.5, seed ^ 0xa7, 3, nx, 2.5) - 0.20) * 5.0) * latBand;
      // High-frequency noise breaks each arc into separate islands. fbm clusters
      // hard around 0.5, so it is stretched first — undiluted it barely varies
      // and the arcs come out as one unbroken reef.
      const fine = clamp01(
        (fbmWrapX(nx * 21 + 3, ny * 21, seed ^ 0x51, 3, nx, 21) - 0.5) * 2.4 + 0.5);
      const isle = clamp01(crest * mask * (0.05 + fine * 1.55));
      // Sea floor deliberately low: generatePlanetGrid adds up to +0.3 of pole
      // fade, and a higher floor would grow a land cap at each pole.
      const raw = 0.14 + isle * 0.62;
      // Islands are PLATEAUS, not cones. Two measured reasons, both invisible to
      // the structure metrics and both found by reading the rendered pixels:
      //
      //  - Hugging the waterline puts nearly every island cell inside the 0.02
      //    band that IsoDioramaRenderer re-classifies as `beach`, so islands
      //    rendered tan. The grid said 59% of this world's land was grassland,
      //    forest, jungle or plains; 0.8% of its land pixels came out green.
      //  - Running to 0.76 puts them on the 9px and 13px lift tiers, and an
      //    island ~30px across at the diorama's real size is then mostly
      //    extruded cliff face.
      //
      // So land steps straight up past the beach band and stays in the low
      // tiers: 0.52-0.63, where grassland and forest live. The step is at sea
      // level, so the coastline itself does not move.
      return clamp01(raw < SEA ? raw : 0.52 + (raw - SEA) * 0.40);
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
      // The dome is shallow and the shelf it sits on is high, rather than the
      // other way round: a dome running to 1.0 turns its own interior into bare
      // rock — measured at 0.62 it put a grey massif across the whole continent.
      // Interior lands at ~0.68, under the 0.75 mountain threshold.
      const dome = clamp01(1 - Math.hypot(dx * 1.15, dy) * 1.25) * 0.34;
      const warp = (fbmWrapX(nx * 3.5, ny * 3.5, seed, 5, nx, 3.5) - 0.5) * 0.55;
      let e = clamp01(0.34 + dome + warp * 0.6);
      // Inland sea: a second lobe, only where the dome is already high.
      const sx = hash2(17, 2, seed), sy = 0.35 + hash2(2, 17, seed) * 0.3;
      const sdx = Math.min(Math.abs(nx - sx), 1 - Math.abs(nx - sx)) * 2;
      const sea = clamp01(1 - Math.hypot(sdx * 1.7, (ny - sy) * 2.4) * 2.4);
      e -= sea * 0.55 * clamp01((e - 0.35) * 3);
      return clamp01(e);
    }
  }
}

/**
 * Shared layout for a split ocean: 2–4 centres spread in longitude so the
 * masses do not all pile onto one side of the planet.
 */
function continentCentres(seed: number): Array<{ cx: number; cy: number; reach: number }> {
  const n = 2 + Math.floor(hash2(1, 1, seed) * 3);
  const out: Array<{ cx: number; cy: number; reach: number }> = [];
  for (let i = 0; i < n; i++) {
    out.push({
      cx: ((i + 0.2 + hash2(i + 3, 8, seed) * 0.55) / n) % 1,
      cy: (i % 2 === 0 ? 0.34 : 0.58) + (hash2(8, i + 3, seed) - 0.5) * 0.12,
      reach: 0.46 + hash2(i, 21, seed) * 0.10,
    });
  }
  return out;
}

/**
 * 2–4 separate landmasses. The coast is warped in the mass's own frame, and
 * the height on land is local noise — not distance from the middle.
 * A cone drawn in the diorama's lift steps is a stack of oval plates, which
 * is what a world-scale wobble was still producing on the smaller masses:
 * the wobble was flat across them, the sea ate the low skirt, and the shelf
 * that remained rose toward the centre.
 */
export function continentsElevation(nx: number, ny: number, seed: number): number {
  let e = 0.20;
  let i = 0;
  for (const c of continentCentres(seed)) {
    const dx = Math.min(Math.abs(nx - c.cx), 1 - Math.abs(nx - c.cx)) * 2;
    const dy = (ny - c.cy) * 1.58;
    const warp =
      (fbm(dx * 10, dy * 10, seed ^ (0x51 + i * 19), 3) - 0.5) * 0.34
      + (fbm(dx * 20, dy * 20, seed ^ (0x27 + i * 13), 2) - 0.5) * 0.14;
    const body = clamp01(1 - (Math.hypot(dx * 1.15, dy) + warp) / c.reach);
    // A shoulder off to one side, overlapping the body, so the silhouette is
    // a lump rather than the ellipse the body alone would be.
    const ang = hash2(i + 4, 9, seed) * Math.PI * 2;
    const ox = Math.cos(ang) * 0.16;
    const oy = Math.sin(ang) * 0.13;
    const shoulder = clamp01(1 - Math.hypot(dx - ox, dy - oy) / (c.reach * 0.62));
    const dome = Math.max(body, shoulder);
    const inland = clamp01((dome - 0.60) / 0.05);
    if (inland <= 0) {
      e = Math.max(e, 0.18 + dome * 0.38);
    } else {
      // No distance term. A small mass still changes height across itself
      // because this noise is sampled in the mass's own frame.
      const bump = fbm(dx * 14 + i, dy * 14, seed ^ (0x9c + i * 17), 2);
      const h = 0.60 + (bump - 0.5) * 0.22;
      e = Math.max(e, h);
    }
    i++;
  }
  return clamp01(e);
}

/**
 * Rare sibling of `continentsElevation`: the same centres, drawn as clean
 * circular domes. Most split oceans should not look like this.
 */
export function discsElevation(nx: number, ny: number, seed: number): number {
  let e = 0.20;
  for (const c of continentCentres(seed)) {
    const dx = Math.min(Math.abs(nx - c.cx), 1 - Math.abs(nx - c.cx)) * 2;
    const dy = (ny - c.cy) * 1.58;
    const dome = clamp01(1 - Math.hypot(dx * 1.15, dy) / c.reach);
    e = Math.max(e, 0.20 + dome * 0.50);
  }
  e += (fbmWrapX(nx * 4, ny * 4, seed ^ 0x5a, 3, nx, 4) - 0.5) * 0.10;
  return clamp01(e);
}

/**
 * A highland plateau. The gorge itself is cut after sea level is applied,
 * so a dry world and a wetter one get the same depth of trench.
 */
export function canyonElevation(nx: number, ny: number, seed: number): number {
  return clamp01(0.62 + (fbmWrapX(nx * 3, ny * 3, seed, 4, nx, 3) - 0.5) * 0.16);
}

/** 0–1 narrow trough. High frequency, so the cut is a slot and not a wide valley. */
export function canyonTrough(nx: number, ny: number, seed: number): number {
  const along = fbmWrapX(nx * 14, ny * 6, seed ^ 0x71, 3, nx, 14);
  const across = fbmWrapX(nx * 6, ny * 14, seed ^ 0x2c, 3, nx, 6);
  const trough = Math.max(
    clamp01(1 - Math.abs(along * 2 - 1) * 16),
    clamp01(1 - Math.abs(across * 2 - 1) * 18) * 0.75,
  );
  const open = clamp01((fbmWrapX(nx * 1.4, ny * 1.4, seed ^ 0x44, 2, nx, 1.4) - 0.42) * 3.4);
  return trough * open;
}

export type LandStructure = 'continents' | 'discs' | 'archipelago' | 'canyon' | 'legacy';

/** What an untyped world is allowed to be. Water can split; dry highland can crack. */
export function structureFor(planetType: string, seed: number): LandStructure {
  let h = (planetType.length * 131 + seed * 17) | 0;
  h = ((h ^ (h >>> 13)) * 1540483477) | 0;
  const r = ((h >>> 0) % 1000) / 1000;
  const water = planetType === 'ocean' || planetType === 'toxic' || planetType === 'storm';
  const dry = planetType === 'desert' || planetType === 'ice' || planetType === 'rocky'
    || planetType === 'carbon' || planetType === 'crystal';
  if (water) {
    // Clean circular domes are a rare roll. The common split is a ragged coast.
    if (r < 0.08) return 'discs';
    if (r < 0.58) return 'continents';
    if (r < 0.83) return 'archipelago';
    return 'legacy';
  }
  if (dry) return r < 0.55 ? 'canyon' : 'legacy';
  return 'legacy';
}

/** Which archetype a world gets. Rolled from `genomeSeed`, type-independent. */
export function rollArchetype(genomeSeed: number): TerrainArchetype {
  const r = hash2(91, 13, genomeSeed | 0);
  return IMPLEMENTED[Math.min(IMPLEMENTED.length - 1,
    Math.floor(r * IMPLEMENTED.length))];
}
