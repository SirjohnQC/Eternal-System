/**
 * Surface decals: trees, scrub, cacti and rock stamped onto the diorama's
 * land, placed from simulation data so the surface reads as HOW ALIVE the
 * world is rather than as decoration.
 *
 * Pure. No canvas, no DOM, no time — the same inputs always produce the same
 * forest, which is what lets a save reload into the world the player left.
 * Mirrors `planVolcanoChimneys` in HabitableCutawayEngine.ts, the established
 * pattern for deterministic prop placement.
 */
import type { CutawayBakeOpts, HabitableType } from './HabitableCutawayEngine';
import { isWater } from '../simulation/PlanetGrid';

export type DecalKind = 'conifer' | 'broadleaf' | 'scrub' | 'cactus' | 'rock';

export interface DecalSite {
  /** Screen x, in virtual pixels. */
  x: number;
  /** Screen y, ALREADY raised by the cell's terrace lift. */
  y: number;
  kind: DecalKind;
  /** Size multiplier, larger toward the centre of the face. */
  scale: number;
  row: number;
  col: number;
}

/**
 * Elevation above which `paintCutawaySurface` re-classifies a `mountain` cell
 * as snow — LOCALLY, inside its own paint loop, without ever touching
 * `cell.biome` (`HabitableCutawayEngine.ts`, at the snow-cap site). A decal
 * planner reading `cell.biome` alone therefore cannot see the white cap, and
 * would stamp scrub across it.
 *
 * WHY IT LIVES HERE AND NOT IN THE PAINTER: `HabitableCutawayEngine.ts`
 * value-imports `planSurfaceDecals`/`stampDecals` from this module, while this
 * module only TYPE-imports from it (erased at compile). Declaring this in the
 * painter and importing it here would close that into a real runtime import
 * cycle. The painter imports it from here instead, following the direction
 * that already exists.
 */
export const PAINTER_SNOW_ELEVATION = 0.82;

/**
 * Decals stop below this elevation.
 *
 * COUPLED CONSTANT, compile-time rather than comment-time: a deliberate margin
 * below `PAINTER_SNOW_ELEVATION` so nothing creeps onto the painter's snow. If
 * that constant moves, this moves with it automatically.
 */
export const DECAL_SNOW_LINE = PAINTER_SNOW_ELEVATION - 0.04;

/** Target site count at full lushness. A COUNT, not a per-cell probability. */
export const DECAL_BUDGET = 900;

/** Spacing bucket in virtual pixels — see the note on rejection cost below. */
const BUCKET = 11;

function hash1(n: number, seed: number): number {
  let h = (n | 0) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise, bilinear over a coarse lattice. Groves and clearings. */
function vnoise(x: number, y: number, cellPx: number, seed: number): number {
  const fx = x / cellPx, fy = y / cellPx;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const c = (a: number, b: number) => hash1(a * 73856093 + b * 19349663, seed);
  const n00 = c(ix, iy), n10 = c(ix + 1, iy);
  const n01 = c(ix, iy + 1), n11 = c(ix + 1, iy + 1);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * What a world can carry, regardless of how a single cell classifies.
 *
 * Cell biome comes from elevation/moisture/temperature and happily returns
 * `grassland` on a desert planet. Without this bound, a desert world at high
 * lushness grew 194 conifers — every assertion green, because every assertion
 * ran on `ocean`. The planet's own type is the outer bound; the cell's biome
 * chooses within it.
 */
function woodyBound(planetType: HabitableType): 'forest' | 'arid' | 'barren' {
  switch (planetType) {
    case 'ocean': case 'rocky': case 'ice': return 'forest';
    case 'desert': case 'toxic': case 'carbon': return 'arid';
    default: return 'barren';   // lava, storm, gas, crystal and anything new
  }
}

/**
 * Plan every decal on the face.
 *
 * `lush` is the planet-wide biosphere term already computed by the host
 * (IsoDioramaRenderer.ts:1109). `decalSeed` must be `planet.genomeSeed` — not
 * the planet type, which terraforming mutates, and not the bake seed, which
 * changes per render.
 */
export function planSurfaceDecals(
  opts: CutawayBakeOpts,
  lush: number,
  decalSeed: number,
  budget = DECAL_BUDGET,
): DecalSite[] {
  const { cx, cyTop, rx, ry, grid } = opts;
  if (!grid) return [];
  const seed = decalSeed | 0;
  const cand: Array<DecalSite & { w: number }> = [];
  // Loop-invariant: the world's bound depends only on planetType. Hoisted out
  // of the per-candidate loop below, where it was re-derived ~200k times.
  const bound = woodyBound(opts.planetType);

  for (let py = cyTop - ry; py <= cyTop + ry; py += 2) {
    const dy = (py - cyTop) / ry;
    for (let px = cx - rx; px <= cx + rx; px += 2) {
      const dx = (px - cx) / rx;
      const r = Math.hypot(dx, dy);
      if (r > 0.94) continue;                      // keep decals off the coast rim
      const gp = opts.discToGrid(dx, dy);
      if (!gp) continue;
      const cell = grid[gp.row]?.[gp.col];
      if (!cell) continue;

      const biome = cell.biome as string;
      if (biome === 'volcanic' || biome === 'snow' || biome === 'beach') continue;
      if (isWater(cell.biome)) continue;                  // measured: see below
      if (cell.elevation > DECAL_SNOW_LINE) continue;     // see DECAL_SNOW_LINE
      const fert = cell.fertility ?? 0;
      // NOT `if (fert <= 0) continue` as a water guard. Measured on a real
      // grid: water cells carry fertility > 0 (shallow 4983/4983, ocean
      // 1701/1701), contradicting the field's own doc comment, while EVERY
      // mountain cell has fertility 0 (3309/3309). A fertility guard here
      // would let water through and silently delete the mountain branch below.

      // Carrying capacity. A world with no life has no decals however fertile
      // its rock is — this is what makes the surface a readout.
      // MEASURED (Task 1): on a world that has not passed the microbial phase —
      // per this project's own multi-seed check, the common case — land cells
      // carry lifeDensity EXACTLY 0; only shallow/ocean cells are ever written.
      // So `fert * lush` is what actually drives land placement, and the
      // lifeDensity term enriches the picture later rather than carrying it.
      // The prototype's dead/mid/lush progression was produced with
      // lifeDensity 0 everywhere, so this is the proven path, not a fallback.
      const life = clamp01((cell.lifeDensity ?? 0) * 0.55 + fert * lush * 0.85);
      if (biome !== 'mountain' && life < 0.12) continue;

      // Woodland and ground cover clump on DIFFERENT scales. Sharing one field
      // made scrub carpet wherever trees thinned, the opposite of the intent.
      const grove = vnoise(px, py, 52, seed) * 0.7 + vnoise(px, py, 19, seed ^ 0x9e) * 0.3;
      const sward = vnoise(px, py, 88, seed ^ 0x5bd1) * 0.75
                  + vnoise(px, py, 27, seed ^ 0x31af) * 0.25;
      const canopy = biome === 'forest' || biome === 'jungle';
      if (grove < (canopy ? 0.58 : 0.74) - life * 0.04 && sward < 0.80 - life * 0.04) continue;

      let kind: DecalKind;
      if (biome === 'mountain') {
        // Bare rock: no fertility, and none needed — this is the one kind that
        // is not life, so it alone is exempt from the life floor above. Scrub
        // IS life, though, so a dead world must not grow it on crags either —
        // fall back to rock when the life floor isn't met. (Falling back to
        // rock rather than skipping the site keeps mountain terrain reading
        // as rocky at every lushness; only the vegetated kind is gated.)
        const wantsScrub = hash1(px * 31 + py, seed) >= 0.62;
        kind = (wantsScrub && life >= 0.12) ? 'scrub' : 'rock';
      } else if (fert <= 0) {
        continue;                                        // dead ground, not rock
      } else if (biome === 'desert') {
        if (fert < 0.22) continue;                  // dry land stays visibly dry
        kind = hash1(px * 7 + py, seed) < 0.45 ? 'cactus' : 'rock';
      } else if (biome === 'tundra') {
        kind = hash1(px + py * 17, seed) < 0.30 ? 'conifer' : 'scrub';
      } else if (biome === 'jungle') {
        kind = 'broadleaf';
      } else if (biome === 'forest') {
        kind = hash1(px * 13 + py * 5, seed) < 0.62 ? 'conifer' : 'broadleaf';
      } else {
        kind = hash1(px * 5 + py * 11, seed) < 0.18 + life * 0.22 ? 'conifer' : 'scrub';
      }
      // Bound by what this WORLD can carry, not just what this cell says.
      // NOTE: rewriting `kind` here also changes the TOTAL site count, not just
      // the mix. `woody` is derived from `kind` immediately below and feeds both
      // the `!woody` sward cutoff (which skips sites outright) and the spacing
      // weight `w`, which decides who survives the bucket sort. Changing this
      // branch is never a pure re-labelling.
      if (bound !== 'forest' && (kind === 'conifer' || kind === 'broadleaf')) {
        kind = bound === 'arid'
          ? (hash1(px * 17 + py * 3, seed) < 0.40 ? 'cactus' : 'scrub')
          : 'scrub';
      }

      // Ground cover spreads before woodland. This is the evolutionary read and
      // it falls out of the rule rather than being scripted.
      if ((kind === 'conifer' || kind === 'broadleaf') && life < 0.30) kind = 'scrub';

      const woody = kind === 'conifer' || kind === 'broadleaf';
      if (!woody && sward < 0.58 - life * 0.10) continue;

      const lift = opts.liftOf(
        opts.smoothElevation(grid, gp.row, gp.col) - opts.rimFalloff(r));
      cand.push({
        x: px, y: py - lift, kind, scale: 0.75 + (1 - r) * 0.45,
        row: gp.row, col: gp.col,
        w: life * (woody ? grove : sward) * (0.6 + hash1(px * 977 + py * 31, seed) * 0.8),
      });
    }
  }

  // Strongest candidates first, then spacing rejection. A bucket grid, NOT the
  // pairwise `sites.some(...)` that planVolcanoChimneys uses — that is O(n^2)
  // and fine for a dozen cones, quadratic for several hundred decals.
  cand.sort((a, b) => b.w - a.w);
  const taken = new Set<number>();
  const sites: DecalSite[] = [];
  for (const c of cand) {
    if (sites.length >= budget) break;
    const key = ((c.x / BUCKET) | 0) * 4096 + ((c.y / BUCKET) | 0);
    if (taken.has(key)) continue;
    taken.add(key);
    sites.push({ x: c.x, y: c.y, kind: c.kind, scale: c.scale, row: c.row, col: c.col });
  }
  sites.sort((a, b) => a.y - b.y);        // back to front, for correct overlap
  return sites;
}

export interface DecalAtlas {
  cell: number;
  rows: Record<DecalKind, number>;
  variants: number;
  /** RGBA, R = shading mask, A = coverage. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Stamp decals into the surface bake's ImageData.
 *
 * Colour is NEVER taken from the atlas. Each decal samples the terrain pixel
 * it stands on and shades relative to it, which is what keeps decals inside the
 * planet's own palette on every planet type and under any terrain tint. The
 * atlas supplies shape (alpha) and a lit/shadow mask (red channel) only.
 *
 * `d` is the sub-rect buffer the surface painter builds; `x0`/`yTop` are its
 * offset on screen, so site coordinates convert with `x - x0`, `y - yTop`.
 *
 * Returns the number of decals actually drawn.
 */
export function stampDecals(
  d: Uint8ClampedArray, bw: number, bh: number,
  x0: number, yTop: number,
  sites: DecalSite[], atlas: DecalAtlas | null,
): number {
  let drawn = 0;
  for (const s of sites) {
    const bx = Math.round(s.x) - x0, by = Math.round(s.y) - yTop;
    // bx needs room for the bx-1/bx+1 reads below; by only needs to be a valid
    // row (by-1 is never read — see the note at the vertical guard).
    if (bx < 1 || bx >= bw - 1 || by < 0 || by >= bh) continue;
    const foot = (by * bw + bx) * 4;
    // Its own footprint must stand on painted land, or decals hang off coasts.
    if (d[foot + 3] === 0) continue;
    if (d[((by * bw) + bx - 1) * 4 + 3] === 0) continue;
    if (d[((by * bw) + bx + 1) * 4 + 3] === 0) continue;
    // The footprint is the decal's BASE, so the pixel it rests on must be
    // painted too, or the decal reads as floating on nothing. Deliberately
    // NOT checking the pixel above: decals draw upward from their base, and
    // at the top rim the terrain silhouette ends with space above it — trees
    // breaking the skyline there are the correct look, not a bug.
    if (by + 1 < bh && d[((by + 1) * bw + bx) * 4 + 3] === 0) continue;
    const ur = d[foot], ug = d[foot + 1], ub = d[foot + 2];

    // lit 0..255 from the atlas mask -> a multiplier plus a small hue push, so
    // foliage reads greener than the ground without leaving its family.
    const shade = (lit: number): [number, number, number] => {
      const t = lit / 255;
      const m = 0.45 + t * 0.42;
      const push = s.kind === 'rock' ? 0 : 1;
      return [
        Math.max(0, Math.min(255, ur * m + (push ? -12 : 8))),
        Math.max(0, Math.min(255, ug * m + (push ? 34 : 8))),
        Math.max(0, Math.min(255, ub * m + (push ? -10 : 10))),
      ];
    };
    const px = (x: number, y: number, c: [number, number, number]) => {
      if (x < 0 || y < 0 || x >= bw || y >= bh) return;
      const o = (y * bw + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    };

    const row = atlas ? atlas.rows[s.kind] ?? 0 : 0;
    const variant = atlas ? Math.abs((s.row * 31 + s.col * 17)) % Math.max(1, atlas.variants) : 0;
    const sx0 = variant * (atlas?.cell ?? 0), sy0 = row * (atlas?.cell ?? 0);
    // A malformed atlas (rows/variants/width/height inconsistent with cell)
    // would otherwise read past the buffer: `atlas.data[...]` returns
    // `undefined`, which slips past the `=== 0` skip check and feeds NaN into
    // shading. Confirm the source rect actually lies inside the atlas first.
    const atlasRectOk = !!atlas && sx0 + atlas.cell <= atlas.width && sy0 + atlas.cell <= atlas.height;
    if (atlas && atlasRectOk) {
      for (let ay = 0; ay < atlas.cell; ay++) {
        for (let ax = 0; ax < atlas.cell; ax++) {
          const ao = ((sy0 + ay) * atlas.width + (sx0 + ax)) * 4;
          if (atlas.data[ao + 3] === 0) continue;
          const tx = bx + ax - (atlas.cell >> 1);
          const ty = by + ay - (atlas.cell - 2);
          px(tx, ty, shade(atlas.data[ao]));
        }
      }
    } else {
      // Procedural fallback so the renderer degrades gracefully if the atlas
      // has not loaded yet. Deliberately crude: a marker, not art.
      const h = Math.round((s.kind === 'scrub' || s.kind === 'rock' ? 4 : 10) * s.scale);
      for (let i = 0; i < h; i++) {
        const half = Math.max(0, Math.round((1 - i / h) * h * 0.4));
        for (let dx = -half; dx <= half; dx++) px(bx + dx, by - i, shade(dx < 0 ? 210 : 70));
      }
    }
    drawn++;
  }
  return drawn;
}

/**
 * Should the surface re-bake for decals?
 *
 * The biosphere nudges every tick; re-baking on each would repaint the world
 * continuously for changes nobody can see. Re-bake on a material move in
 * lushness, or whenever the species count crosses an integer — that is the
 * event a player actually notices, because it is when new decal kinds unlock.
 */
export function decalRebakeNeeded(
  prev: { lush: number; biodiversity: number } | null,
  next: { lush: number; biodiversity: number },
): boolean {
  if (!prev) return true;
  if (Math.abs(next.lush - prev.lush) > 0.05) return true;
  return Math.floor(next.biodiversity) !== Math.floor(prev.biodiversity);
}
