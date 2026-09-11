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
import type { CutawayBakeOpts } from './HabitableCutawayEngine';
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
 * Decals stop below this elevation.
 *
 * COUPLED CONSTANT: `paintCutawaySurface` re-classifies `mountain` cells above
 * elevation 0.82 as snow LOCALLY, without touching `cell.biome`
 * (HabitableCutawayEngine.ts:817-820). A planner reading `cell.biome` alone
 * therefore stamps scrub across the white cap. This sits a little below that
 * line so nothing creeps onto snow. If either constant moves, both move.
 */
export const DECAL_SNOW_LINE = 0.78;

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
      if (grove < (canopy ? 0.34 : 0.52) - life * 0.12 && sward < 0.62 - life * 0.10) continue;

      let kind: DecalKind;
      if (biome === 'mountain') {
        // Bare rock: no fertility, and none needed — this is the one kind that
        // is not life. Gate it on lushness only so a dead world still has crags.
        kind = hash1(px * 31 + py, seed) < 0.62 ? 'rock' : 'scrub';
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
