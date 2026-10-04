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
import { forgeFlora, groundKey, FLORA_VARIANTS, type FloraSprite } from './FloraForge';

export type DecalKind =
  | 'conifer' | 'broadleaf' | 'palm' | 'scrub' | 'bush' | 'grass' | 'cactus' | 'mushroom'
  | 'rock' | 'ore' | 'crystal';

/** Trees: they clump in groves and need a living world to reach full size. */
export function isWoody(k: DecalKind): boolean {
  return k === 'conifer' || k === 'broadleaf' || k === 'palm';
}
/** Not life: stone and crystal, which a dead or still-forming world carries too. */
export function isMineralKind(k: DecalKind): boolean {
  return k === 'rock' || k === 'ore' || k === 'crystal';
}
/** The atlas only draws the original five; newer kinds borrow the nearest shape. */
const ATLAS_FALLBACK: Record<DecalKind, DecalKind> = {
  conifer: 'conifer', broadleaf: 'broadleaf', palm: 'broadleaf', scrub: 'scrub', bush: 'scrub',
  grass: 'scrub', cactus: 'cactus', mushroom: 'scrub', rock: 'rock', ore: 'rock', crystal: 'rock',
};

export interface DecalSite {
  /** Screen x, in virtual pixels (the planner's: at the identity view this IS base world x). */
  x: number;
  /** Screen y, ALREADY raised by the cell's terrace lift. */
  y: number;
  /**
   * Base-world position (the identity plan's x, y), set by the engine when it
   * stores its plan; a camera bake maps these to screen and never re-plans.
   */
  wx?: number;
  wy?: number;
  /**
   * The ground colour (packed 0xRRGGBB) this decal was stamped on in the
   * identity bake, or -1 when it was not stamped (no footing). Written by
   * `stampDecals` when asked to `record`; a camera stamp uses it for a decal
   * whose anchor is off its buffer but whose sprite reaches into it.
   */
  foot?: number;
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

/**
 * Spacing bucket, in virtual pixels AT THE REFERENCE RADIUS below.
 *
 * Scaled with the body at plan time — see REF_RX. A fixed pixel value would make
 * decals crowd on a small render and scatter on a large one.
 */
const BUCKET = 11;

/**
 * The body radius these spatial constants were calibrated at (1200x800).
 *
 * MEASURED BUG this exists to fix: the grove/sward wavelengths and the spacing
 * bucket were absolute screen pixels, so when the diorama rendered smaller the
 * noise cells stayed the same size while the planet shrank. Proportionally more
 * of the surface fell inside a "clearing" and was rejected, and a fully lush
 * world placed 12 decals at rx=105 against 285 at rx=262 — decal density was a
 * property of the VIEWPORT rather than of the world. Everything spatial is now
 * scaled by `rx / REF_RX`.
 */
const REF_RX = 262;

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
  mineralsOnly = false,
): DecalSite[] {
  const { cx, cyTop, rx, ry, grid } = opts;
  if (!grid) return [];
  const seed = decalSeed | 0;
  // Everything spatial scales with the body, so density is a property of the
  // world and not of the window. See REF_RX.
  const sc = Math.max(0.25, rx / REF_RX);
  const bucket = Math.max(3, Math.round(BUCKET * sc));
  const cand: Array<DecalSite & { w: number }> = [];
  // Loop-invariant: the world's bound depends only on planetType. Hoisted out
  // of the per-candidate loop below, where it was re-derived ~200k times.
  const bound = woodyBound(opts.planetType);

  for (let py = cyTop - ry; py <= cyTop + ry; py += 2) {
    const dy = (py - cyTop) / ry;
    for (let px = cx - rx; px <= cx + rx; px += 2) {
      const dx = (px - cx) / rx;
      // Body-relative sampling position: decals belong to the world, so moving the
      // body on screen (resize, framing) must not re-roll them. Offset keeps it positive.
      const bx = px - cx + 4096, by = py - cyTop + 4096;
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
      if (!mineralsOnly && biome !== 'mountain' && life < 0.12) continue;

      // Woodland and ground cover clump on DIFFERENT scales. Sharing one field
      // made scrub carpet wherever trees thinned, the opposite of the intent.
      // Wavelengths scale with the body (see REF_RX) so a grove covers the same
      // FRACTION of the world at every render size.
      const grove = vnoise(bx, by, 52 * sc, seed) * 0.7
                  + vnoise(bx, by, 19 * sc, seed ^ 0x9e) * 0.3;
      const sward = vnoise(bx, by, 88 * sc, seed ^ 0x5bd1) * 0.75
                  + vnoise(bx, by, 27 * sc, seed ^ 0x31af) * 0.25;
      const canopy = biome === 'forest' || biome === 'jungle';
      if (grove < (canopy ? 0.58 : 0.74) - life * 0.04 && sward < 0.80 - life * 0.04) continue;

      let kind: DecalKind;
      // Which stone a crag shows: ore seams, crystal (common on crystal
      // worlds), plain rock otherwise.
      const mineral = (): DecalKind => {
        const m = hash1(bx * 41 + by * 13, seed ^ 0x0e);
        if (m < (opts.planetType === 'crystal' ? 0.5 : 0.05)) return 'crystal';
        return m > 0.88 ? 'ore' : 'rock';
      };
      if (mineralsOnly) {
        // A world still forming (or lifeless by choice): stone only, crags
        // first, a thin scatter of boulders across open ground.
        if (biome !== 'mountain' && sward < 0.72) continue;
        kind = mineral();
      } else if (biome === 'mountain') {
        // Bare rock: no fertility, and none needed — this is the one kind that
        // is not life, so it alone is exempt from the life floor above. Scrub
        // IS life, though, so a dead world must not grow it on crags either —
        // fall back to rock when the life floor isn't met. (Falling back to
        // rock rather than skipping the site keeps mountain terrain reading
        // as rocky at every lushness; only the vegetated kind is gated.)
        const wantsScrub = hash1(bx * 31 + by, seed) >= 0.62;
        kind = (wantsScrub && life >= 0.12) ? 'scrub' : mineral();
      } else if (fert <= 0) {
        continue;                                        // dead ground, not rock
      } else if (biome === 'desert') {
        if (fert < 0.22) continue;                  // dry land stays visibly dry
        kind = hash1(bx * 7 + by, seed) < 0.45 ? 'cactus' : 'rock';
      } else if (biome === 'tundra') {
        kind = hash1(bx + by * 17, seed) < 0.30 ? 'conifer' : 'scrub';
      } else if (biome === 'jungle') {
        kind = hash1(bx * 3 + by * 29, seed) < 0.35 ? 'palm' : 'broadleaf';
      } else if (biome === 'forest') {
        kind = hash1(bx * 13 + by * 5, seed) < 0.62 ? 'conifer' : 'broadleaf';
      } else {
        kind = hash1(bx * 5 + by * 11, seed) < 0.18 + life * 0.22 ? 'conifer' : 'scrub';
      }
      // Bound by what this WORLD can carry, not just what this cell says.
      // NOTE: rewriting `kind` here also changes the TOTAL site count, not just
      // the mix. `woody` is derived from `kind` immediately below and feeds both
      // the `!woody` sward cutoff (which skips sites outright) and the spacing
      // weight `w`, which decides who survives the bucket sort. Changing this
      // branch is never a pure re-labelling.
      if (bound !== 'forest' && isWoody(kind)) {
        kind = bound === 'arid'
          ? (hash1(bx * 17 + by * 3, seed) < 0.40 ? 'cactus' : 'scrub')
          : 'scrub';
      }

      // Ground cover spreads before woodland. This is the evolutionary read and
      // it falls out of the rule rather than being scripted.
      if (isWoody(kind) && life < 0.30) kind = 'scrub';

      // Ground cover in its local forms: grass on open land, berry bushes
      // where life is rich, fungi on toxic and carbon worlds. A relabelling
      // only: the count and spacing above are already decided.
      if (kind === 'scrub' && !mineralsOnly) {
        const g = hash1(bx * 23 + by * 7, seed ^ 0x51);
        if ((opts.planetType === 'toxic' || opts.planetType === 'carbon') && g < 0.45) kind = 'mushroom';
        else if (opts.planetType === 'crystal' && g < 0.4) kind = 'crystal';
        else if (biome === 'grassland' || biome === 'plains' || biome === 'savanna') kind = g < 0.55 ? 'grass' : g < 0.55 + life * 0.3 ? 'bush' : 'scrub';
        else if (biome !== 'mountain' && biome !== 'tundra' && g < life * 0.4) kind = 'bush';
      } else if (kind === 'cactus' && opts.planetType === 'toxic' && hash1(bx + by * 3, seed) < 0.5) {
        kind = 'mushroom';
      }

      const woody = isWoody(kind);
      if (!woody && sward < 0.58 - life * 0.10) continue;

      const lift = opts.liftOf(
        opts.smoothElevation(grid, gp.row, gp.col) - opts.rimFalloff(r));
      // Atlas cell is 16px. Ordinary cover is a fraction of that so a grove
      // does not bury the ground. `decalScale` raises a cell whose flora
      // genome is gigantic. A little extra toward the middle of the face.
      const body = opts.decalScale?.(gp.row, gp.col, kind)
        ?? defaultDecalScale(kind);
      cand.push({
        x: px, y: py - lift, kind,
        scale: body * (0.9 + (1 - r) * 0.2),
        row: gp.row, col: gp.col,
        w: life * (woody ? grove : sward) * (0.6 + hash1(bx * 977 + by * 31, seed) * 0.8),
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
    // Body-relative buckets, like the sampling above: moving the body must
    // not move the bucket grid under the decals.
    const key = (((c.x - cx + 4096) / bucket) | 0) * 4096 + (((c.y - cyTop + 4096) / bucket) | 0);
    if (taken.has(key)) continue;
    taken.add(key);
    sites.push({ x: c.x, y: c.y, kind: c.kind, scale: c.scale, row: c.row, col: c.col });
  }
  sites.sort((a, b) => a.y - b.y);        // back to front, for correct overlap
  return sites;
}

/** How big a kind stamps, as a fraction of the 16px atlas cell. */
export function defaultDecalScale(kind: DecalKind): number {
  switch (kind) {
    case 'rock': case 'ore': return 0.5;
    case 'crystal': return 0.44;
    case 'grass': return 0.28;
    case 'mushroom': return 0.32;
    case 'scrub': case 'bush': case 'cactus': return 0.34;
    default: return 0.38;
  }
}

/**
 * Forged sprites, keyed by what changes their pixels. Plants ignore the
 * ground; stone takes its colour from it (bucketed).
 */
const forgeCache = new Map<string, FloraSprite>();
/** On-screen size (px) from which a decal is forged rather than taken from the atlas. */
export const FORGE_DECAL_MIN_PX = 10;
const FORGE_MAX_PX = 72;

function forgedDecal(kind: DecalKind, variant: number, px: number, planetType: string, r: number, g: number, b: number): FloraSprite {
  const gk = isMineralKind(kind) ? groundKey([r, g, b]) : 0;
  const key = `${kind}|${variant}|${px}|${planetType}|${gk}`;
  let f = forgeCache.get(key);
  if (!f) {
    if (forgeCache.size > 900) forgeCache.clear();
    f = forgeFlora(kind, variant, px, planetType, [r, g, b]);
    forgeCache.set(key, f);
  }
  return f;
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
 * `scale` (a camera bake: round(k)) blows every sprite pixel up to a
 * scale x scale block, nearest-neighbour, anchored on the same base pixel.
 * Sprites are CLIPPED to the buffer, not culled by their anchor: a decal whose
 * anchor is off the buffer but whose sprite reaches into it is stamped on the
 * ground colour its identity stamp recorded (`site.foot`); without that
 * record its footing cannot be tested and it is skipped. `record` (the
 * identity bake) writes `site.foot` for every site.
 *
 * Returns the number of decals actually drawn.
 */
export function stampDecals(
  d: Uint8ClampedArray, bw: number, bh: number,
  x0: number, yTop: number,
  sites: DecalSite[], atlas: DecalAtlas | null,
  scale = 1, record = false,
  _camera = false,
  planetType?: HabitableType,
): number {
  let drawn = 0;
  const S = Math.max(1, Math.round(scale)), half = S >> 1;
  const reach = ((atlas?.cell ?? 16) + 2) * S;
  for (const s of sites) {
    const bx = Math.round(s.x) - x0, by = Math.round(s.y) - yTop;
    let ur: number, ug: number, ub: number;
    // bx needs room for the bx-1/bx+1 reads below; by only needs to be a valid
    // row (by-1 is never read — see the note at the vertical guard).
    if (bx >= 1 && bx < bw - 1 && by >= 0 && by < bh) {
      const foot = (by * bw + bx) * 4;
      // Its own footprint must stand on painted land, or decals hang off coasts.
      // The footprint is the decal's BASE, so the pixel it rests on must be
      // painted too, or the decal reads as floating on nothing. Deliberately
      // NOT checking the pixel above: decals draw upward from their base, and
      // at the top rim the terrain silhouette ends with space above it — trees
      // breaking the skyline there are the correct look, not a bug.
      if (d[foot + 3] === 0
        || d[((by * bw) + bx - 1) * 4 + 3] === 0
        || d[((by * bw) + bx + 1) * 4 + 3] === 0
        || (by + 1 < bh && d[((by + 1) * bw + bx) * 4 + 3] === 0)) {
        if (record) s.foot = -1;
        continue;
      }
      ur = d[foot]; ug = d[foot + 1]; ub = d[foot + 2];
      if (record) s.foot = (ur << 16) | (ug << 8) | ub;
    } else {
      // Anchor off the buffer: stamp the part of the sprite that reaches in,
      // on the ground its identity stamp stood on. No record, no footing: skip.
      if (record) s.foot = -1;
      if (s.foot === undefined || s.foot < 0) continue;
      if (bx + reach < 0 || bx - reach >= bw || by - reach >= bh || by + 2 * S < 0) continue;
      ur = (s.foot >> 16) & 255; ug = (s.foot >> 8) & 255; ub = s.foot & 255;
    }

    // lit 0..255 from the atlas mask -> a multiplier plus a small hue push, so
    // foliage reads greener than the ground without leaving its family.
    const shade = (lit: number): [number, number, number] => {
      const t = lit / 255;
      const m = 0.45 + t * 0.42;
      const push = isMineralKind(s.kind) ? 0 : 1;
      return [
        Math.max(0, Math.min(255, ur * m + (push ? -12 : 8))),
        Math.max(0, Math.min(255, ug * m + (push ? 34 : 8))),
        Math.max(0, Math.min(255, ub * m + (push ? -10 : 10))),
      ];
    };
    const px1 = (x: number, y: number, c: [number, number, number]) => {
      if (x < 0 || y < 0 || x >= bw || y >= bh) return;
      const o = (y * bw + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    };
    // One sprite pixel at sprite offset (ox, oy) from the anchor: an S x S
    // block whose bottom row sits on the anchor row's scaled position.
    const px = S === 1
      ? (ox: number, oy: number, c: [number, number, number]) => px1(bx + ox, by + oy, c)
      : (ox: number, oy: number, c: [number, number, number]) => {
        const X = bx + ox * S - half, Y = by + oy * S - (S - 1);
        for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) px1(X + i, Y + j, c);
      };

    // Big enough on screen to deserve real art: forge it. Colour comes from
    // the world (foliage by planet type, stone from this ground), nudged a
    // little toward the ground so it sits in the planet's palette.
    const destPx = Math.max(2, Math.round(16 * Math.max(0.2, Math.min(1.35, s.scale)))) * S;
    if (planetType && destPx >= FORGE_DECAL_MIN_PX) {
      const variant = Math.abs(Math.round(s.wx ?? s.x) * 7 + s.row * 31 + s.col * 17) % FLORA_VARIANTS;
      const f = forgedDecal(s.kind, variant, Math.min(FORGE_MAX_PX, destPx), planetType, ur, ug, ub);
      const gx = bx - f.footX, gy = by - f.footY;
      for (let y = 0; y < f.height; y++) {
        const Y = gy + y;
        if (Y < 0 || Y >= bh) continue;
        for (let x = 0; x < f.width; x++) {
          const so = (y * f.width + x) * 4, a = f.data[so + 3];
          if (a === 0) continue;
          const X = gx + x;
          if (X < 0 || X >= bw) continue;
          const o = (Y * bw + X) * 4;
          if (a === 255) {
            d[o] = f.data[so] * 0.88 + ur * 0.12;
            d[o + 1] = f.data[so + 1] * 0.88 + ug * 0.12;
            d[o + 2] = f.data[so + 2] * 0.88 + ub * 0.12;
          } else {
            const t = a / 255;   // translucent crystal: the ground shows through
            d[o] = f.data[so] * t + d[o] * (1 - t);
            d[o + 1] = f.data[so + 1] * t + d[o + 1] * (1 - t);
            d[o + 2] = f.data[so + 2] * t + d[o + 2] * (1 - t);
          }
          d[o + 3] = 255;
        }
      }
      drawn++;
      continue;
    }

    const row = atlas ? atlas.rows[s.kind] ?? atlas.rows[ATLAS_FALLBACK[s.kind]] ?? 0 : 0;
    const variant = atlas ? Math.abs((s.row * 31 + s.col * 17)) % Math.max(1, atlas.variants) : 0;
    const sx0 = variant * (atlas?.cell ?? 0), sy0 = row * (atlas?.cell ?? 0);
    // A malformed atlas (rows/variants/width/height inconsistent with cell)
    // would otherwise read past the buffer: `atlas.data[...]` returns
    // `undefined`, which slips past the `=== 0` skip check and feeds NaN into
    // shading. Confirm the source rect actually lies inside the atlas first.
    const atlasRectOk = !!atlas && sx0 + atlas.cell <= atlas.width && sy0 + atlas.cell <= atlas.height;
    if (atlas && atlasRectOk) {
      // Nearest-neighbour so a small tree stays crisp pixels, not a blur.
      // Scale 1 reproduces the full cell, footed on the same two-pixel pad.
      const cellN = atlas.cell;
      const dest = Math.max(2, Math.round(cellN * Math.max(0.2, Math.min(1.35, s.scale))));
      const foot = Math.max(1, Math.round(2 * dest / cellN));
      for (let ay = 0; ay < dest; ay++) {
        const sy = Math.min(cellN - 1, (ay * cellN / dest) | 0);
        for (let ax = 0; ax < dest; ax++) {
          const sx = Math.min(cellN - 1, (ax * cellN / dest) | 0);
          const ao = ((sy0 + sy) * atlas.width + (sx0 + sx)) * 4;
          if (atlas.data[ao + 3] === 0) continue;
          px(ax - (dest >> 1), ay - (dest - foot), shade(atlas.data[ao]));
        }
      }
    } else {
      // Procedural fallback so the renderer degrades gracefully if the atlas
      // has not loaded yet. Deliberately crude: a marker, not art.
      const h = Math.round((isWoody(s.kind) || s.kind === 'cactus' ? 10 : 4) * s.scale);
      for (let i = 0; i < h; i++) {
        const hw = Math.max(0, Math.round((1 - i / h) * h * 0.4));
        for (let dx = -hw; dx <= hw; dx++) px(dx, -i, shade(dx < 0 ? 210 : 70));
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
