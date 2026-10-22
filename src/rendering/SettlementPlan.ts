/**
 * SettlementPlan — where a civilisation's towns, buildings, farm fields and
 * roads sit on the diorama, planned once from the simulation.
 *
 * Everything is in base-world FACE coordinates (the identity view's screen
 * pixels before terrace lift), so the surface bake can paint fields and roads
 * per pixel at any zoom (`groundAt`), and the renderer can stand buildings on
 * the lifted ground. Pure and deterministic: the same inputs give the same
 * towns, so a save reloads into the world the player left.
 *
 * Era follows the civ level (TECH_LEVELS): huts and garden plots, then
 * fields and dirt tracks, cobbled lanes, asphalt with lane marks.
 */

/** Tech era used for building and road styles: 0 Primitive .. 6 Interstellar and beyond. */
export type Era = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export function eraOf(civLevel: number): Era {
  return Math.max(0, Math.min(6, Math.floor(civLevel))) as Era;
}

export type BuildingKind =
  | 'hut' | 'house' | 'gable' | 'adobe' | 'row' | 'block' | 'tower' | 'dome' | 'spire'
  | 'ziggurat' | 'keep' | 'church' | 'mill'
  | 'hive' | 'pod' | 'burrow' | 'grown' | 'carved';

export interface Building {
  /** Foot (front-centre of the footprint), face coordinates. */
  x: number; y: number;
  /** Width, depth (on the ground, before foreshortening) and wall height, world px. */
  w: number; d: number; h: number;
  kind: BuildingKind;
  seed: number;
  town: number;
  /** Raised on stilts (the civilisation's architecture). */
  stilts?: boolean;
  /**
   * Ground the building stands on, when the plan knows the terrain
   * (`PlanInput.liftAt`): `lift` is the levelled pad's height (the highest
   * ground under the footprint: cut and fill), `pad` how far the ground
   * falls away below it in front (world px), drawn as a foundation.
   */
  lift?: number;
  pad?: number;
}

/** A levelled building plot painted into the ground bake (terraforming). */
export interface Pad {
  x0: number; y0: number; x1: number; y1: number;
}

/**
 * A farm field: a diamond on the isometric axes (#96). On the unsquashed
 * ground (X = x, Y = y / SQUASH) its sides run at 45 degrees: half-sizes `hu`
 * along (1, 1) and `hv` along (-1, 1), around (cx, cy). x0..y1 is its
 * bounding box, for bucketing and overlap tests.
 */
export interface Field {
  cx: number; cy: number; hu: number; hv: number;
  x0: number; y0: number; x1: number; y1: number;
  /** 0 ripe grain, 1 young green, 2 ploughed, 3 second crop (yellow-green), 4 orchard/garden. */
  crop: number;
  /** Crop rows run along the u axis (false) or the v axis (true). */
  rowsY: boolean;
}

export interface RoadSeg {
  ax: number; ay: number; bx: number; by: number;
  /** Half width, world px. */
  half: number;
  /** A town street (true) or a road between towns. */
  street: boolean;
}

export interface Town {
  x: number; y: number;
  /** Footprint radius along x (y is foreshortened by SQUASH), world px. */
  r: number;
  size: number;
  capital: boolean;
  /** The era this town is built in (its nation's, or the civilisation's). */
  era: Era;
  /** Owning nation (Nations.ts index), -1 for none. */
  nation: number;
  /** How this town builds (its nation's architecture), if it differs from the plan's. */
  arch?: ArchGenome;
}

/** A town site, best first; a nation's town carries that nation's era, architecture and temper. */
export interface Site {
  x: number; y: number;
  era?: Era;
  nation?: number;
  arch?: ArchGenome;
  /** 0..10 (keeps for warlike peoples). */
  aggression?: number;
  /** The first town of its nation (gets the landmark). */
  capital?: boolean;
}

export interface SettlementPlan {
  era: Era;
  towns: Town[];
  buildings: Building[];
  fields: Field[];
  roads: RoadSeg[];
  /** Levelled plots under buildings on uneven ground. */
  pads: Pad[];
  /** Spatial buckets for `groundAt` / `keepClear`. */
  bucket: number;
  cells: Map<number, { f: number[]; r: number[]; p: number[] }>;
}

export interface PlanInput {
  /** Chosen town centres (face coordinates), best first. */
  sites: Site[];
  civLevel: number;
  seed: number;
  /** Body radius (px): sizes scale with it (calibrated at 262). */
  rx: number;
  /** Land you can build on (face coordinates). */
  isLand(x: number, y: number): boolean;
  /** 0..1, 0 where nothing can be farmed (mountain, desert, snow, water). */
  fertileAt(x: number, y: number): number;
  /** Ocean-born species build domes and spires. */
  aquatic: boolean;
  /** 0..10: walled keeps for warlike species. */
  aggression: number;
  /** How this civilisation builds (Architecture.ts); absent: by era only. */
  arch?: ArchGenome;
  /**
   * Height (px) the drawn ground is lifted at a face point: the terrain's
   * terraces. Absent: flat ground. Buildings stand only where their footprint
   * spans at most one terrace step, and level a pad where it spans one.
   */
  liftAt?(x: number, y: number): number;
  /** A river or stream at a face point (roads bridge it, nothing is built on it). */
  waterAt?(x: number, y: number): boolean;
}

/**
 * The most a building plot may fall across its footprint (world px): one
 * terrace step (the tiers rise 3–5 px). More is a cliff: nothing is built.
 */
export const MAX_PLOT_STEP = 5;

/**
 * The ground under a footprint `w` wide and `d` deep (world px) whose front
 * centre is (x, y): its levelled height and the foundation it needs, or null
 * where nothing should be built (water, a river, a cliff). The sampled width
 * covers the drawn sprite, which is wider than the plan's box.
 */
export function plotGround(inp: Pick<PlanInput, 'isLand' | 'liftAt' | 'waterAt'>, x: number, y: number, w: number, d: number): { lift: number; pad: number } | null {
  const hw = w * 0.8, hd = d * SQUASH;
  let lo = Infinity, hi = -Infinity;
  for (const fy of [0, 0.5, 1]) for (const fx of [-1, -0.5, 0, 0.5, 1]) {
    const px = x + fx * hw, py = y - fy * hd;
    if (!inp.isLand(px, py) || inp.waterAt?.(px, py)) return null;
    const l = inp.liftAt?.(px, py) ?? 0;
    // Lifted ground shows where it lands on the screen only if the face
    // there is not sea (the sea is drawn over it): a lone high cell behind
    // the water is not ground anyone can see.
    if (l > 0 && !inp.isLand(px, py - l)) return null;
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  if (hi - lo > MAX_PLOT_STEP) return null;
  return { lift: hi, pad: hi - lo };
}

import type { ArchGenome } from './Architecture';

/** The diorama's top-face foreshortening (BOARD_SQUASH). */
export const SQUASH = 0.52;
const REF_RX = 262;

function rng(seed: number) {
  let s = seed | 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

export function emptyPlan(): SettlementPlan {
  return { era: 0, towns: [], buildings: [], fields: [], roads: [], pads: [], bucket: 8, cells: new Map() };
}

export function planSettlements(inp: PlanInput): SettlementPlan {
  // The plan's era is the most advanced town's (roads between towns follow it).
  const era = Math.max(eraOf(inp.civLevel), ...inp.sites.map(s => s.era ?? 0)) as Era;
  const eraOfSite = (s: Site): Era => s.era ?? eraOf(inp.civLevel);
  // Sizes are absolute world px, matched to the trees (decals stand ~6 px
  // tall whatever the body size), growing only on very large renders.
  const sc = 1.8 * Math.max(1, inp.rx / REF_RX);
  const lineHalf = 0.5 * Math.max(1, inp.rx / REF_RX);
  const R = rng(inp.seed ^ 0x51ab7);
  const plan = emptyPlan();
  plan.era = era;
  plan.bucket = Math.max(4, Math.round(8 * sc));

  // Each town draws from its own stream, seeded by where it stands: a
  // growing civilisation adds towns without re-rolling the ones it has.
  const townRng = (t: { x: number; y: number }) =>
    rng(inp.seed ^ Math.imul(Math.round(t.x * 4) + 7919, 73856093) ^ Math.imul(Math.round(t.y * 4) + 104729, 19349663));

  // ── Towns ──
  inp.sites.forEach((s, i) => {
    const capital = s.capital ?? i === 0;
    const size = capital ? 1 : 0.35 + townRng(s)() * 0.5;
    const te = eraOfSite(s);
    const r = sc * (2.6 + size * 4.2) * (0.75 + te * 0.07);
    plan.towns.push({ x: s.x, y: s.y, r, size, capital, era: te, nation: s.nation ?? -1, arch: s.arch });
  });

  // ── Streets and buildings ──
  plan.towns.forEach((t, ti) => {
    const R = townRng(t);
    R();
    // Each town in its own era and its nation's ways.
    const era = t.era, site = inp.sites[ti];
    const tin: PlanInput = { ...inp, arch: t.arch ?? inp.arch, aggression: site.aggression ?? inp.aggression };
    const streetHalf = lineHalf * (era >= 4 ? 1.3 : 1);
    const main: RoadSeg = { ax: t.x - t.r * 1.05, ay: t.y, bx: t.x + t.r * 1.05, by: t.y, half: streetHalf, street: true };
    if (era >= 1 || t.capital) plan.roads.push(main);
    const cross = (t.size > 0.5 || era >= 2) && era >= 1;
    if (cross) plan.roads.push({ ax: t.x, ay: t.y - t.r * SQUASH, bx: t.x, by: t.y + t.r * SQUASH * 1.05, half: streetHalf, street: true });

    // The landmark (temple, keep, church, mill, tower) fronts the main street
    // on its far side, just past the crossing, in the capital and big towns.
    let lm: Building | null = null;
    if ((t.capital || t.size > 0.6) && inp.isLand(t.x, t.y)) {
      lm = makeBuilding(era, tin, R, sc, 0, 0, ti, true);
      lm.x = t.x + (cross ? streetHalf + lm.w / 2 + 0.6 : 0);
      lm.y = t.y - streetHalf - 0.4;
      if (!settle(lm, lm.w * 0.6)) lm = null;
    }
    // Lots by the civilisation's layout: a jittered grid along the
    // streets, concentric rings, a dense cluster, a line along the main
    // street, or houses scattered wide.
    const layout = tin.arch?.layout ?? 'grid';
    const lot = sc * (era >= 4 ? 2.0 : 1.75) * (tin.arch?.scale ?? 1) * (layout === 'cluster' ? 0.85 : layout === 'scatter' ? 1.5 : 1);
    const cand: Array<[number, number]> = [];
    if (layout === 'ring') {
      for (let ring = 1; ring * lot * 1.1 < t.r; ring++) {
        const rr = ring * lot * 1.15, n = Math.max(4, Math.round((Math.PI * 2 * rr) / (lot * 1.05)));
        for (let k = 0; k < n; k++) {
          const a2 = (k / n) * Math.PI * 2 + ring * 0.37;
          cand.push([t.x + Math.cos(a2) * rr, t.y + Math.sin(a2) * rr * SQUASH]);
        }
      }
    } else if (layout === 'cluster' || layout === 'scatter') {
      const n = Math.round((Math.PI * t.r * t.r) / (lot * lot) * (layout === 'cluster' ? 1.1 : 0.5));
      for (let k = 0; k < n; k++) {
        const a2 = R() * Math.PI * 2, rr = Math.sqrt(R()) * t.r * (layout === 'scatter' ? 1.25 : 0.95);
        cand.push([t.x + Math.cos(a2) * rr, t.y + Math.sin(a2) * rr * SQUASH]);
      }
    } else {
      const rows = layout === 'line' ? 1 : Math.ceil(t.r / lot) + 1;
      const cols = Math.ceil(t.r / lot) + (layout === 'line' ? 3 : 1);
      for (let gy = -rows; gy <= rows; gy++) for (let gx = -cols; gx <= cols; gx++) {
        const jx = (R() - 0.5) * lot * 0.35, jy = (R() - 0.5) * lot * SQUASH * 0.35;
        cand.push([t.x + gx * lot + jx, t.y + gy * lot * SQUASH + jy]);
      }
    }
    const streets = layout === 'grid' || layout === 'line';
    const placed: Array<[number, number]> = [];
    /**
     * Stand a building on its plot if the ground allows: never on water or
     * across a cliff; on a terrace step the plot is levelled (a pad, and a
     * foundation in front). Returns whether it was built.
     */
    function settle(b: Building, nudge = 0): boolean {
      // A plot that does not fit is shifted a little before it is given up.
      let g = plotGround(inp, b.x, b.y, b.w, b.d);
      for (const [ox, oy] of nudge ? [[1, 0], [-1, 0], [0, -1], [0, 1]] : []) {
        if (g) break;
        const nx = b.x + ox * nudge, ny = b.y + oy * nudge * SQUASH;
        g = plotGround(inp, nx, ny, b.w, b.d);
        if (g) { b.x = nx; b.y = ny; }
      }
      if (!g) return false;
      if (inp.liftAt) { b.lift = g.lift; b.pad = g.pad; }
      if (g.pad > 0) {
        const hw = b.w * 0.8 + 0.4 * sc;
        plan.pads.push({ x0: b.x - hw, x1: b.x + hw, y0: b.y - b.d * SQUASH - 0.3 * sc, y1: b.y + 0.6 * sc });
      }
      plan.buildings.push(b);
      return true;
    }
    for (const [x, y] of cand) {
      const e = Math.hypot((x - t.x) / t.r, (y - t.y) / (t.r * SQUASH));
      if (e > (layout === 'scatter' ? 1.3 : layout === 'line' ? 1.6 : 1)) continue;
      // Keep the streets clear.
      if (streets && (era >= 1 || t.capital)) {
        if (Math.abs(y - t.y) < streetHalf + 0.35 * sc) continue;
        if (cross && layout === 'grid' && Math.abs(x - t.x) < streetHalf + 0.6 * sc) continue;
      }
      if (layout === 'ring' && e < 0.25) continue;                    // the central plaza
      if (layout !== 'ring' && R() > 0.97 - e * 0.4) continue;
      if (!inp.isLand(x, y)) continue;
      if (lm && Math.abs(x - lm.x) < (lm.w + lot) / 2 && y < lm.y + 0.2 && y > lm.y - lm.d * SQUASH - lot * SQUASH) continue;
      if (!streets && placed.some(([px, py]) => Math.abs(px - x) < lot * 0.7 && Math.abs(py - y) < lot * SQUASH * 0.7)) continue;
      const nb = makeBuilding(era, tin, R, sc, x, y, ti, false);
      if (settle(nb, lot * 0.4)) placed.push([nb.x, nb.y]);
    }
  });
  // Back to front.
  plan.buildings.sort((a, b) => a.y - b.y);

  // ── Fields ──
  const inTown = (x: number, y: number, pad: number) => plan.towns.some(t =>
    Math.hypot((x - t.x) / (t.r + pad), (y - t.y) / ((t.r + pad) * SQUASH)) < 1);
  // Diamonds share their axes, so they are rectangles in (u, v): overlap is exact there.
  const overlaps = (f: Field) => plan.fields.some(o => {
    const [du, dv] = fieldUV(o, f.cx, f.cy);
    return Math.abs(du) < f.hu + o.hu + 0.6 * sc && Math.abs(dv) < f.hv + o.hv + 0.6 * sc;
  });
  for (const t of plan.towns) {
    const R = rng(townRng(t)() * 0x7fffffff ^ 0x3f1e);
    const era = t.era;
    const tries = era === 0 ? 6 : Math.round((14 + t.size * 26) * (era >= 3 ? 1.3 : 1));
    const want = era === 0 ? 2 : Math.round((5 + t.size * 12) * (era >= 3 ? 1.25 : 1));
    let made = 0;
    for (let k = 0; k < tries && made < want; k++) {
      const a = R() * Math.PI * 2;
      const dist = t.r * (1.08 + R() * (era === 0 ? 0.3 : 1.3)) + sc * R() * 2;
      const cx = t.x + Math.cos(a) * dist, cy = t.y + Math.sin(a) * dist * SQUASH;
      // Same draws as the old rectangles (the plan's other picks are unchanged);
      // 0.7 keeps a diamond's area close to the old rectangle's.
      const fw = sc * (era === 0 ? 1.4 + R() : 2.4 + R() * 3.4) * (era >= 3 ? 1.3 : 1);
      const fh = sc * SQUASH * (era === 0 ? 1.4 + R() : 2.2 + R() * 3) * (era >= 3 ? 1.3 : 1);
      const f = isoField(cx, cy, fw * 0.7, fh / SQUASH * 0.7, era === 0 ? 4 : pickCrop(R), R() < 0.5);
      if (overlaps(f) || inTown(cx, cy, 0.4 * sc)) continue;
      let ok = true;
      for (const [px, py] of fieldCorners(f)) {
        if (inp.fertileAt(px, py) < 0.15) { ok = false; break; }
      }
      if (!ok) continue;
      plan.fields.push(f);
      made++;
    }
  }

  // ── Roads between towns ──
  if (era >= 1 && plan.towns.length > 1) {
    const half = lineHalf * (era >= 4 ? 1.4 : 1.1);
    const n = plan.towns.length, linked = [0], edges: Array<[number, number]> = [];
    const free = new Set(Array.from({ length: n - 1 }, (_, i) => i + 1));
    // Prim's tree over towns, by distance, only along land.
    while (free.size) {
      let best: [number, number, number] | null = null;
      for (const a of linked) for (const b of free) {
        const d = Math.hypot(plan.towns[a].x - plan.towns[b].x, (plan.towns[a].y - plan.towns[b].y) / SQUASH);
        if (!best || d < best[2]) best = [a, b, d];
      }
      if (!best) break;
      free.delete(best[1]);
      linked.push(best[1]);
      edges.push([best[0], best[1]]);
    }
    for (const [a, b] of edges) {
      const ta = plan.towns[a], tb = plan.towns[b];
      const routed = routeOverLand(inp, ta.x, ta.y, tb.x, tb.y, sc, R);
      if (!routed) continue;
      const path = isoLegs(inp, routed);
      for (let i = 0; i + 1 < path.length; i++) {
        plan.roads.push({ ax: path[i][0], ay: path[i][1], bx: path[i + 1][0], by: path[i + 1][1], half, street: false });
      }
    }
  }

  index(plan);
  return plan;
}

/** A diamond field around (cx, cy) with half-sizes hu, hv on the iso axes. */
export function isoField(cx: number, cy: number, hu: number, hv: number, crop: number, rowsY: boolean): Field {
  const ex = (hu + hv) / Math.SQRT2, ey = (hu + hv) / Math.SQRT2 * SQUASH;
  return { cx, cy, hu, hv, x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey, crop, rowsY };
}

/** The field's position on its own axes: [u, v] (unsquashed ground units). */
export function fieldUV(f: Field, x: number, y: number): [number, number] {
  const X = x - f.cx, Y = (y - f.cy) / SQUASH;
  return [(X + Y) / Math.SQRT2, (Y - X) / Math.SQRT2];
}

/** Its four corners and centre, in face coordinates. */
function fieldCorners(f: Field): Array<[number, number]> {
  const pt = (u: number, v: number): [number, number] => [f.cx + (u - v) / Math.SQRT2, f.cy + (u + v) / Math.SQRT2 * SQUASH];
  return [pt(f.hu, 0), pt(-f.hu, 0), pt(0, f.hv), pt(0, -f.hv), [f.cx, f.cy]];
}

function pickCrop(R: () => number): number {
  const v = R();
  return v < 0.38 ? 0 : v < 0.66 ? 1 : v < 0.82 ? 2 : v < 0.94 ? 3 : 4;
}

function makeBuilding(era: Era, inp: PlanInput, R: () => number, sc: number, x: number, y: number, town: number, landmark: boolean): Building {
  const seed = (R() * 0x7fffffff) | 0;
  const b: Building = { x, y, w: 0, d: 0, h: 0, kind: 'house', seed, town };
  const s = (lo: number, hi: number) => sc * (lo + R() * (hi - lo));
  const A = inp.arch;
  if (A) {
    b.stilts = A.stilts;
    if (A.shape !== 'box') {
      // The civilisation's own shape family, growing taller and grander
      // with the era; the landmark is the same form, much bigger.
      const grand = 1 + era * 0.12;
      b.kind = A.shape;
      const [w0, w1, h0, h1] = A.shape === 'spire' ? [1.2, 1.7, 2.4, 3.6] : A.shape === 'burrow' ? [2.2, 3, 0.6, 0.9]
        : A.shape === 'hive' ? [1.8, 2.4, 1.8, 2.6] : A.shape === 'grown' ? [1.7, 2.3, 2.2, 3.2]
        : A.shape === 'carved' ? [2, 2.8, 1.4, 2.2] : A.shape === 'pod' ? [1.6, 2.2, 1.4, 2] : [1.8, 2.6, 0.5, 0.8];
      b.w = s(w0, w1) * A.scale; b.d = b.w * 0.9; b.h = s(h0, h1) * A.tall * grand;
      // Ordinary buildings stay below a few trees' height, however tall the
      // style; the landmark may tower.
      b.h = Math.min(b.h, sc * 3.2);
      if (landmark) {
        const big = A.quirks.includes('colossal') ? 2.6 : 1.8;
        b.w *= big * 0.8; b.d *= big * 0.8; b.h = Math.min(b.h * big, sc * 6);
      }
      return b;
    }
  }
  if (inp.aquatic && !A) {
    if (landmark || (era >= 3 && R() < 0.2)) { b.kind = 'spire'; b.w = s(1.2, 1.6); b.d = b.w; b.h = s(2.6, 3.6) * (1 + era * 0.1); }
    else { b.kind = 'dome'; b.w = s(1.8, 2.6); b.d = b.w; b.h = s(0.4, 0.7); }
    return b;
  }
  if (landmark) {
    switch (era) {
      case 0: b.kind = 'hut'; b.w = s(2.4, 2.8); b.d = b.w; b.h = s(0.8, 1); break;
      case 1: b.kind = 'ziggurat'; b.w = s(3.6, 4.4); b.d = b.w; b.h = s(2.6, 3.2); break;
      case 2: b.kind = inp.aggression > 5 ? 'keep' : 'church'; b.w = s(2.2, 2.8); b.d = s(2, 2.6); b.h = s(3, 4); break;
      case 3: b.kind = 'mill'; b.w = s(3, 3.6); b.d = s(2, 2.4); b.h = s(1.6, 2); break;
      case 4: b.kind = 'tower'; b.w = s(2, 2.4); b.d = b.w; b.h = s(3.6, 4.4); break;
      default: b.kind = 'spire'; b.w = s(1.8, 2.2); b.d = b.w; b.h = s(4.4, 5.4); break;
    }
    return b;
  }
  switch (era) {
    case 0: b.kind = 'hut'; b.w = s(1.4, 1.9); b.d = b.w; b.h = s(0.5, 0.8); break;
    case 1: b.kind = R() < 0.55 ? 'adobe' : 'house'; b.w = s(1.6, 2.3); b.d = s(1.4, 2); b.h = s(1, 1.4); break;
    case 2: b.kind = R() < 0.5 ? 'gable' : 'house'; b.w = s(1.6, 2.2); b.d = s(1.6, 2.2); b.h = s(1.2, 1.7); break;
    case 3: b.kind = R() < 0.6 ? 'row' : 'house'; b.w = s(2, 2.6); b.d = s(1.6, 2.2); b.h = b.kind === 'row' ? s(1.5, 1.9) : s(1.3, 1.6); break;
    case 4: b.kind = R() < 0.25 ? 'tower' : 'block'; b.w = s(1.8, 2.4); b.d = s(1.6, 2.2); b.h = b.kind === 'tower' ? s(2.8, 3.6) : s(1.6, 2.2); break;
    case 5: b.kind = R() < 0.35 ? 'tower' : 'block'; b.w = s(1.7, 2.2); b.d = s(1.6, 2); b.h = b.kind === 'tower' ? s(3, 4.2) : s(1.8, 2.4); break;
    default: b.kind = R() < 0.25 ? 'spire' : 'dome'; b.w = s(1.7, 2.3); b.d = b.w; b.h = b.kind === 'spire' ? s(3.2, 4.6) : s(0.6, 1); break;
  }
  if (A) {
    b.w *= A.scale; b.d *= A.scale; b.h *= A.tall;
    if (landmark && A.quirks.includes('colossal')) { b.w *= 1.6; b.d *= 1.6; b.h *= 2; }
  }
  return b;
}

/** Whether the straight line between two face points stays on land. */
function landLine(inp: PlanInput, x0: number, y0: number, x1: number, y1: number): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= n; i++) if (!inp.isLand(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)) return false;
  return true;
}

/**
 * Lay a road path along the isometric axes (#97): each leg becomes a run
 * along one diagonal then the other (an L on the iso grid), whichever order
 * stays on land; a leg neither order can lay on land stays straight.
 */
export function isoLegs(inp: PlanInput, path: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const [px, py] = path[i - 1], [qx, qy] = path[i];
    const dX = qx - px, dY = (qy - py) / SQUASH;
    const a = (dX + dY) / 2, b = (dY - dX) / 2;          // along (1, 1) and (-1, 1)
    const viaU: [number, number] = [px + a, py + a * SQUASH];
    const viaV: [number, number] = [px - b, py + b * SQUASH];
    if (Math.abs(a) < 0.5 || Math.abs(b) < 0.5) { out.push([qx, qy]); continue; }   // already on an axis
    if (landLine(inp, px, py, viaU[0], viaU[1]) && landLine(inp, viaU[0], viaU[1], qx, qy)) out.push(viaU);
    else if (landLine(inp, px, py, viaV[0], viaV[1]) && landLine(inp, viaV[0], viaV[1], qx, qy)) out.push(viaV);
    out.push([qx, qy]);
  }
  return out;
}

/**
 * A road from a to b: straight when the whole line is on land, else around
 * the water by a coarse breadth-first search over a lattice. Null when the
 * towns are on different islands. The result is a few gently jittered
 * segments, not a ruler line.
 */
function routeOverLand(inp: PlanInput, ax: number, ay: number, bx: number, by: number, sc: number, R: () => number): Array<[number, number]> | null {
  const len = Math.hypot(bx - ax, (by - ay) / SQUASH);
  const lineOk = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= n; i++) if (!inp.isLand(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)) return false;
    return true;
  };
  if (lineOk(ax, ay, bx, by)) {
    // A bend or two, so the road reads as laid on the land.
    const pts: Array<[number, number]> = [[ax, ay]];
    const bends = len > 30 * sc ? 2 : 1;
    for (let i = 1; i <= bends; i++) {
      const t = i / (bends + 1), nx = -(by - ay) / SQUASH, ny = (bx - ax) * SQUASH, nl = Math.hypot(nx, ny) || 1;
      const off = (R() - 0.5) * len * 0.12;
      const px = ax + (bx - ax) * t + nx / nl * off, py = ay + (by - ay) * t + ny / nl * off;
      const prev = pts[pts.length - 1];
      if (lineOk(prev[0], prev[1], px, py)) pts.push([px, py]);
    }
    const last = pts[pts.length - 1];
    if (!lineOk(last[0], last[1], bx, by)) return [[ax, ay], [bx, by]];
    pts.push([bx, by]);
    return pts;
  }
  // Lattice search around water.
  const step = Math.max(2, 2.5 * sc);
  const minX = Math.min(ax, bx) - len * 0.6, maxX = Math.max(ax, bx) + len * 0.6;
  const minY = Math.min(ay, by) - len * 0.4, maxY = Math.max(ay, by) + len * 0.4;
  const W = Math.ceil((maxX - minX) / step) + 1, H = Math.ceil((maxY - minY) / step) + 1;
  if (W * H > 40000) return null;
  const at = (i: number) => [minX + (i % W) * step, minY + Math.floor(i / W) * step] as [number, number];
  const idx = (x: number, y: number) => Math.round((y - minY) / step) * W + Math.round((x - minX) / step);
  const start = idx(ax, ay), goal = idx(bx, by);
  const prev = new Int32Array(W * H).fill(-1);
  prev[start] = start;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    if (c === goal) break;
    const cx = c % W, cy = Math.floor(c / W);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (prev[n] !== -1) continue;
      const p = at(n);
      if (n !== goal && !inp.isLand(p[0], p[1])) continue;
      prev[n] = c;
      q.push(n);
    }
  }
  if (prev[goal] === -1) return null;
  const cells: number[] = [];
  for (let c = goal; c !== start; c = prev[c]) cells.push(c);
  cells.push(start);
  cells.reverse();
  // Thin the lattice path to its corners, then keep only what stays on land.
  const pts: Array<[number, number]> = [[ax, ay]];
  let anchor: [number, number] = [ax, ay];
  for (let i = 1; i < cells.length; i++) {
    const p = i === cells.length - 1 ? [bx, by] as [number, number] : at(cells[i]);
    const nxt = i + 1 < cells.length ? (i + 1 === cells.length - 1 ? [bx, by] as [number, number] : at(cells[i + 1])) : null;
    if (nxt && lineOk(anchor[0], anchor[1], nxt[0], nxt[1])) continue;
    pts.push(p);
    anchor = p;
  }
  return pts;
}

/** Bucket the fields and roads for per-pixel lookup. */
function index(plan: SettlementPlan): void {
  const B = plan.bucket, cells = plan.cells;
  const key = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
  const add = (x0: number, y0: number, x1: number, y1: number, fn: (c: { f: number[]; r: number[]; p: number[] }) => void) => {
    for (let j = Math.floor(y0 / B); j <= Math.floor(y1 / B); j++) {
      for (let i = Math.floor(x0 / B); i <= Math.floor(x1 / B); i++) {
        const k = key(i, j);
        let c = cells.get(k);
        if (!c) { c = { f: [], r: [], p: [] }; cells.set(k, c); }
        fn(c);
      }
    }
  };
  plan.fields.forEach((f, n) => add(f.x0, f.y0, f.x1, f.y1, c => c.f.push(n)));
  plan.pads.forEach((p, n) => add(p.x0, p.y0, p.x1, p.y1, c => c.p.push(n)));
  plan.roads.forEach((r, n) => add(Math.min(r.ax, r.bx) - r.half - 1, Math.min(r.ay, r.by) - r.half - 1,
    Math.max(r.ax, r.bx) + r.half + 1, Math.max(r.ay, r.by) + r.half + 1, c => c.r.push(n)));
}

function cellAt(plan: SettlementPlan, x: number, y: number) {
  const B = plan.bucket;
  return plan.cells.get((Math.floor(x / B) + 4096) * 8192 + (Math.floor(y / B) + 4096));
}

/** Distance from (x, y) to a segment, and the position along it (0..1). */
function segDist(r: RoadSeg, x: number, y: number): [number, number] {
  const vx = r.bx - r.ax, vy = r.by - r.ay, l2 = vx * vx + vy * vy || 1;
  let t = ((x - r.ax) * vx + (y - r.ay) * vy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [Math.hypot(x - (r.ax + vx * t), y - (r.ay + vy * t)), t];
}

/** Crop colours: ripe grain, young green, ploughed earth, second crop, garden. */
const CROPS: Array<[number, number, number]> = [
  [206, 172, 84], [112, 152, 64], [124, 88, 58], [168, 168, 72], [96, 124, 60],
];

const SPRING: [number, number, number] = [128, 168, 76];
const STUBBLE: [number, number, number] = [188, 158, 96];
const FALLOW: [number, number, number] = [176, 172, 164];

/**
 * The ground colour a field or road gives the face pixel at world (x, y),
 * packed 0xRRGGBB, or -1 when there is none. `k` is the camera zoom (detail:
 * crop rows, hedges and lane marks appear as it grows); (r, g, b) the ground
 * colour underneath, which the marks blend with so they keep the planet's
 * palette. `water`: the pixel is a river (only a road crosses it: a bridge).
 */
export function groundAt(plan: SettlementPlan, x: number, y: number, k: number, r: number, g: number, b: number, water = false, season = -1): number {
  const c = cellAt(plan, x, y);
  if (!c) return -1;
  // Roads first: they run over fields' edges and bridge rivers.
  let best = Infinity, bestR: RoadSeg | null = null, bestT = 0;
  for (const n of c.r) {
    const rd = plan.roads[n];
    const [d, t] = segDist(rd, x, y);
    if (d <= rd.half && d < best) { best = d; bestR = rd; bestT = t; }
  }
  if (bestR) {
    const era = plan.era;
    let cr: number, cg: number, cb: number;
    if (water) { cr = 120; cg = 92; cb = 64; }                         // a plank bridge
    else if (era <= 2) { cr = 184; cg = 150; cb = 102; }                // dirt / packed earth
    else if (era === 3) { cr = 150; cg = 146; cb = 138; }               // cobbles
    else { cr = 74; cg = 76; cb = 82; }                                  // asphalt
    const m = era >= 3 ? 0.88 : 0.82;
    cr = cr * m + r * (1 - m); cg = cg * m + g * (1 - m); cb = cb * m + b * (1 - m);
    // Edges darker once the road is several pixels wide.
    if (k >= 3 && best > bestR.half * 0.72) { cr *= 0.82; cg *= 0.82; cb *= 0.82; }
    // Cobble texture and dashed centre lines as the camera closes in.
    if (era === 3 && k >= 3 && ((Math.floor(x * 2) + Math.floor(y * 3)) & 1)) { cr *= 0.9; cg *= 0.9; cb *= 0.9; }
    if (era >= 4 && !bestR.street && k >= 3 && best < 0.1) {
      const len = Math.hypot(bestR.bx - bestR.ax, bestR.by - bestR.ay);
      if (Math.floor(bestT * len / 1.2) % 2 === 0) { cr = 228; cg = 214; cb = 150; }
    }
    return ((cr | 0) << 16) | ((cg | 0) << 8) | (cb | 0);
  }
  if (water) return -1;
  // A levelled plot under a building on uneven ground: packed earth, then
  // dressed stone, then paving, with a kerb as the camera closes in.
  for (const n of c.p) {
    const p = plan.pads[n];
    if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1) continue;
    const era = plan.era;
    let [cr, cg, cb] = era <= 1 ? [150, 118, 82] : era <= 3 ? [168, 160, 146] : [150, 152, 156];
    cr = cr * 0.75 + r * 0.25; cg = cg * 0.75 + g * 0.25; cb = cb * 0.75 + b * 0.25;
    const e = Math.min(x - p.x0, p.x1 - x, (y - p.y0) / SQUASH, (p.y1 - y) / SQUASH);
    if (k >= 3 && e < 0.3) { cr *= 0.8; cg *= 0.8; cb *= 0.8; }
    else if (era >= 2 && k >= 4 && ((Math.floor(x * 1.5) + Math.floor(y * 3)) & 1)) { cr *= 0.94; cg *= 0.94; cb *= 0.94; }
    return ((cr | 0) << 16) | ((cg | 0) << 8) | (cb | 0);
  }
  for (const n of c.f) {
    const f = plan.fields[n];
    if (x < f.x0 || x > f.x1 || y < f.y0 || y > f.y1) continue;
    const [u, v] = fieldUV(f, x, y);
    if (Math.abs(u) > f.hu || Math.abs(v) > f.hv) continue;
    // The farming year: sprouting in spring, the crop itself in summer,
    // stubble and fresh ploughing in autumn, frosted fallow in winter.
    let [cr, cg, cb] = season === 0 ? (f.crop === 2 ? CROPS[2] : SPRING)
      : season === 2 ? (f.crop % 2 ? CROPS[2] : STUBBLE)
      : season === 3 ? FALLOW
      : CROPS[f.crop];
    cr = cr * 0.8 + r * 0.2; cg = cg * 0.8 + g * 0.2; cb = cb * 0.8 + b * 0.2;
    if (k >= 2) {
      // Crop rows: alternate darker furrows, half a world pixel apart.
      const along = f.rowsY ? u : v;
      if (Math.floor(along * (k >= 4 ? 2 : 1)) & 1) { cr *= 0.86; cg *= 0.86; cb *= 0.86; }
      // A hedge or ditch along the edge.
      const e = Math.min(f.hu - Math.abs(u), f.hv - Math.abs(v));
      if (k >= 3 && e < 0.28) { cr = r * 0.62; cg = g * 0.7; cb = b * 0.58; }
    }
    return ((cr | 0) << 16) | ((cg | 0) << 8) | (cb | 0);
  }
  return -1;
}

/** Trees and rocks stay off towns, fields and roads. */
export function keepClear(plan: SettlementPlan, x: number, y: number): boolean {
  for (const t of plan.towns) {
    if (Math.hypot((x - t.x) / (t.r + 1), (y - t.y) / ((t.r + 1) * SQUASH)) < 1) return true;
  }
  const c = cellAt(plan, x, y);
  if (!c) return false;
  for (const n of c.f) {
    const f = plan.fields[n];
    const [u, v] = fieldUV(f, x, y);
    if (Math.abs(u) <= f.hu + 0.5 && Math.abs(v) <= f.hv + 0.5) return true;
  }
  for (const n of c.r) {
    const rd = plan.roads[n];
    if (segDist(rd, x, y)[0] < rd.half + 1.2) return true;
  }
  return false;
}
