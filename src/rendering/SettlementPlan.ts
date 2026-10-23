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
  | 'hive' | 'pod' | 'burrow' | 'grown' | 'carved'
  // A town's trades and services (CIVIC_KINDS), by era:
  | 'market' | 'granary' | 'temple' | 'workshop' | 'warehouse' | 'school'
  | 'harbour' | 'factory' | 'station' | 'power' | 'airfield' | 'spaceport';

/**
 * The trades and services a town builds, the eras they stand in (inclusive)
 * and how many towns get one: `capital` only the capital, `big` towns of
 * size > 0.55 too, `any` every town. `tech`: built by every civilisation
 * whatever its architecture (a hive people's power plant is still a power
 * plant); the others only by box builders (a species' own shape family
 * keeps its houses, temples and markets in its own forms).
 */
export const CIVIC_KINDS: Array<{ kind: BuildingKind; from: Era; to: Era; where: 'capital' | 'big' | 'any'; tech: boolean; w: number; h: number }> = [
  { kind: 'market', from: 1, to: 6, where: 'any', tech: false, w: 2.6, h: 1.2 },
  { kind: 'granary', from: 1, to: 4, where: 'any', tech: false, w: 2.2, h: 1.8 },
  { kind: 'temple', from: 1, to: 3, where: 'big', tech: false, w: 2.6, h: 1.8 },
  { kind: 'workshop', from: 2, to: 3, where: 'any', tech: false, w: 2.6, h: 1.6 },
  { kind: 'warehouse', from: 2, to: 4, where: 'big', tech: false, w: 2.6, h: 1.6 },
  { kind: 'school', from: 2, to: 4, where: 'big', tech: false, w: 2.6, h: 2 },
  { kind: 'harbour', from: 1, to: 6, where: 'any', tech: true, w: 3, h: 1.4 },
  { kind: 'factory', from: 3, to: 6, where: 'big', tech: true, w: 3, h: 2.4 },
  { kind: 'station', from: 3, to: 4, where: 'big', tech: true, w: 3.4, h: 2 },
  { kind: 'power', from: 4, to: 6, where: 'capital', tech: true, w: 3.4, h: 2.4 },
];

/**
 * Flying begins: an airfield in the capital from the industrial era (3),
 * in big towns too from the atomic era (4); a spaceport in the capital from
 * the space age (5), in big towns too after (6).
 */
export function airfieldEra(kind: 'airfield' | 'spaceport', capital: boolean): Era {
  return kind === 'airfield' ? (capital ? 3 : 4) : (capital ? 5 : 6);
}

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
   * (`PlanInput.liftAt`): `lift` is the levelled pad's height (the ground at
   * its door: cut into higher ground behind), `pad` how far the ground falls
   * away below it in front (world px), walled up as a foundation.
   */
  lift?: number;
  pad?: number;
}

/** A levelled building plot painted into the ground bake (terraforming). */
export interface Pad {
  x0: number; y0: number; x1: number; y1: number;
  /** A levelled plot (default), an airfield's runway, or a spaceport's launch apron. */
  kind?: 'runway' | 'apron';
  /** Its town's era (a grass strip, then asphalt, then lit concrete). */
  era?: Era;
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
  /** Through a cliff no road could climb: only its two mouths show. */
  tunnel?: boolean;
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
  /** Towns joined by a road between them (indices into `towns`). */
  links: Array<[number, number]>;
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
  let lo = Infinity, hi = -Infinity, frontLo = Infinity;
  const foot = inp.liftAt?.(x, y) ?? 0;
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
    if (fy === 0 && l < frontLo) frontLo = l;
  }
  if (hi - lo > MAX_PLOT_STEP) return null;
  // The door opens onto the ground at the foot: the building stands at that
  // level, cut into any higher ground behind it, and walls up the front
  // where the ground beside the door falls away.
  return { lift: foot, pad: Math.max(0, foot - frontLo) };
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
  return { era: 0, towns: [], buildings: [], fields: [], roads: [], pads: [], links: [], bucket: 8, cells: new Map() };
}

/**
 * The terrain queries, remembered on a quarter-pixel lattice for the length
 * of one plan: plots, streets and the road lattice ask about the same
 * points again and again, and each answer is a map projection.
 */
function memoTerrain(inp: PlanInput): PlanInput {
  const at = <T>(fn: (x: number, y: number) => T) => {
    const m = new Map<number, T>();
    return (x: number, y: number): T => {
      const k = Math.round(x * 4) * 65536 + Math.round(y * 4);
      let v = m.get(k);
      if (v === undefined) { v = fn(Math.round(x * 4) / 4, Math.round(y * 4) / 4); m.set(k, v); }
      return v;
    };
  };
  return {
    ...inp,
    isLand: at((x, y) => inp.isLand(x, y)),
    liftAt: inp.liftAt ? at((x, y) => inp.liftAt!(x, y)) : undefined,
    waterAt: inp.waterAt ? at((x, y) => inp.waterAt!(x, y)) : undefined,
  };
}

export function planSettlements(input: PlanInput): SettlementPlan {
  const inp = memoTerrain(input);
  // The plan's era is the most advanced town's (roads between towns follow it).
  const era = Math.max(eraOf(inp.civLevel), ...inp.sites.map(s => s.era ?? 0)) as Era;
  const eraOfSite = (s: Site): Era => s.era ?? eraOf(inp.civLevel);
  // Sizes are absolute world px, matched to the trees (decals stand ~6 px
  // tall whatever the body size), growing only on very large renders.
  const sc = 1.8 * Math.max(1, inp.rx / REF_RX);
  const lineHalf = 0.5 * Math.max(1, inp.rx / REF_RX);
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
    // Streets run out from the centre as far as the ground lets them: they
    // stop at water and at a cliff (more than a terrace step from the centre).
    const streetsHere: RoadSeg[] = [];
    const street = (dx: number, dy: number, back: number, fwd: number) => {
      const a = streetReach(inp, t.x, t.y, -dx, -dy, back), b = streetReach(inp, t.x, t.y, dx, dy, fwd);
      if (a + b < 1) return;
      const seg: RoadSeg = { ax: t.x - dx * a, ay: t.y - dy * a, bx: t.x + dx * b, by: t.y + dy * b, half: streetHalf, street: true };
      plan.roads.push(seg);
      streetsHere.push(seg);
    };
    if (era >= 1 || t.capital) street(1, 0, t.r * 1.05, t.r * 1.05);
    const cross = (t.size > 0.5 || era >= 2) && era >= 1;
    if (cross) street(0, SQUASH, t.r, t.r * 1.05);

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
    /**
     * A runway (or a launch apron) on dead-flat ground in a ring outside the
     * town, clear of other towns and plots, with its terminal (or the pad's
     * rocket) behind it, joined to the town by a lane.
     */
    function placeField(kind: 'airfield' | 'spaceport', C: () => number): void {
      const L0 = sc * (kind === 'spaceport' ? 4 : era >= 5 ? 8 : era >= 4 ? 7 : 6), D = sc * (kind === 'spaceport' ? 3.4 : 1.4);
      const a0 = C() * Math.PI * 2;
      // Full length first, then a shorter strip: flat ground is scarce on terraced worlds.
      for (const L of [L0, L0 * 0.75]) for (const rr of [1.3, 1.6, 2, 2.5, 3.1]) for (let k = 0; k < 16; k++) {
        const ang = a0 + k / 16 * Math.PI * 2;
        const cx = t.x + Math.cos(ang) * (t.r * rr + L * 0.3), cy = t.y + Math.sin(ang) * (t.r * rr + L * 0.3) * SQUASH;
        const g = plotGround(inp, cx, cy, L / 1.6, D);
        if (!g || g.pad > 0) continue;
        const pad: Pad = { x0: cx - L / 2, x1: cx + L / 2, y0: cy - D * SQUASH, y1: cy, kind: kind === 'airfield' ? 'runway' : 'apron', era };
        const clash = plan.towns.some((o, oi) => oi !== ti && Math.hypot((cx - o.x) / (o.r + L), (cy - o.y) / ((o.r + L) * SQUASH)) < 1)
          || plan.pads.some(o => o.x0 < pad.x1 + sc && o.x1 > pad.x0 - sc && o.y0 < pad.y1 + sc && o.y1 > pad.y0 - sc)
          || plan.buildings.some(b => b.x > pad.x0 - b.w && b.x < pad.x1 + b.w && b.y > pad.y0 - sc && b.y < pad.y1 + b.d * SQUASH + sc);
        if (clash) continue;
        const spec = kind === 'airfield' ? { w: 3.2, h: 1.8 } : { w: 3.4, h: 3 };
        const b: Building = { x: kind === 'airfield' ? pad.x0 + sc * spec.w * 0.6 : cx, y: kind === 'airfield' ? pad.y0 - 0.2 : cy - D * SQUASH * 0.35,
          w: sc * spec.w, d: sc * spec.w * 0.7, h: sc * spec.h, kind, seed: (C() * 0x7fffffff) | 0, town: ti };
        const bg = plotGround(inp, b.x, b.y, b.w, b.d);
        if (!bg) continue;
        if (inp.liftAt) { b.lift = bg.lift; b.pad = bg.pad; }
        plan.pads.push(pad);
        plan.buildings.push(b);
        const lane = isoLegs(inp, [[cx, cy + 0.3], [t.x, t.y]]);
        if (groundRuns(inp, lane)) for (let i = 0; i + 1 < lane.length; i++) plan.roads.push({ ax: lane[i][0], ay: lane[i][1], bx: lane[i + 1][0], by: lane[i + 1][1], half: lineHalf * 0.8, street: true });
        return;
      }
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
    // Trades and services: some lots become a market, a granary, a temple,
    // a workshop… (CIVIC_KINDS), each where it belongs: the market and the
    // temple at the centre, the granary towards the fields, the harbour on
    // the shore, works and power at the edge.
    {
      const C = rng(Math.imul(Math.round(t.x * 4) + 31, 2654435761) ^ Math.imul(Math.round(t.y * 4) + 17, 40503) ^ inp.seed ^ 0xc1c1);
      const family = !!tin.arch && tin.arch.shape !== 'box';
      const ours = plan.buildings.filter(b => b.town === ti && b !== lm);
      const taken = new Set<Building>();
      const coastal = (b: Building) => {
        for (let a = 0; a < 12; a++) {
          const ang = a / 12 * Math.PI * 2, rr = 2.6 * sc;
          const x = b.x + Math.cos(ang) * rr, y = b.y + Math.sin(ang) * rr * SQUASH;
          if (!inp.isLand(x, y) && !inp.waterAt?.(x, y)) return true;
        }
        return false;
      };
      for (const c of CIVIC_KINDS) {
        if (era < c.from || era > c.to || (family && !c.tech) || (inp.aquatic && !tin.arch && !c.tech)) continue;
        if (c.where === 'capital' ? !t.capital : c.where === 'big' ? !(t.capital || t.size > 0.55) : false) continue;
        if (c.kind === 'temple' && (lm?.kind === 'church' || lm?.kind === 'ziggurat')) continue;
        // The best lot for it: by distance from the centre, near or far.
        const near = c.kind === 'market' || c.kind === 'temple' || c.kind === 'school';
        const pool = ours.filter(b => !taken.has(b) && (c.kind !== 'harbour' || coastal(b)));
        if (!pool.length) continue;
        const dc = (b: Building) => Math.hypot(b.x - t.x, (b.y - t.y) / SQUASH) + C() * lot * 0.5;
        pool.sort((a, b) => near ? dc(a) - dc(b) : dc(b) - dc(a));
        for (const b of pool.slice(0, 3)) {
          const nb: Building = { ...b, kind: c.kind, w: sc * c.w * (tin.arch?.scale ?? 1), d: sc * c.w * 0.8, h: sc * c.h };
          const g = plotGround(inp, nb.x, nb.y, nb.w, nb.d);
          if (!g) continue;
          if (inp.liftAt) { nb.lift = g.lift; nb.pad = g.pad; }
          Object.assign(b, nb);
          taken.add(b);
          break;
        }
      }
      // An airfield, then a spaceport, on flat open ground outside the town.
      for (const kind of ['airfield', 'spaceport'] as const) {
        if (era < airfieldEra(kind, t.capital) || (!t.capital && t.size <= 0.55)) continue;
        placeField(kind, C);
      }
    }
    // Lanes: every house reaches a street, along the iso axes, where the
    // ground between allows (no water, no cliff).
    if (era >= 1 && streetsHere.length) {
      const laneHalf = lineHalf * 0.6;
      for (const b of plan.buildings) {
        if (b.town !== ti) continue;
        const fx = b.x, fy = b.y + 0.4 * sc;
        let best: [number, number] | null = null, bd = Infinity;
        for (const sg of streetsHere) {
          const [d, tt] = segDist(sg, fx, fy);
          if (d < bd) { bd = d; best = [sg.ax + (sg.bx - sg.ax) * tt, sg.ay + (sg.by - sg.ay) * tt]; }
        }
        if (!best || bd < streetHalf + 0.3 || bd > lot * 2.5) continue;
        const legs = isoLegs(inp, [[fx, fy], best]);
        if (legs.length < 2 || !groundRuns(inp, legs)) continue;
        for (let i = 0; i + 1 < legs.length; i++) plan.roads.push({ ax: legs[i][0], ay: legs[i][1], bx: legs[i + 1][0], by: legs[i + 1][1], half: laneHalf, street: true });
      }
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
      if (plan.pads.some(o => o.kind && f.x0 < o.x1 + sc && f.x1 > o.x0 - sc && f.y0 < o.y1 + sc && f.y1 > o.y0 - sc)) continue;
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
  // A network that follows the land: candidate links to each town's nearest
  // neighbours, each routed over a terrain-cost lattice (routeRoad); the
  // cheapest tree joining them (Kruskal), plus a few shortcuts where the
  // tree makes a long detour.
  if (era >= 1 && plan.towns.length > 1) {
    const half = lineHalf * (era >= 4 ? 1.4 : 1.1);
    const T = plan.towns, n = T.length;
    const dist = (a: number, b: number) => Math.hypot(T[a].x - T[b].x, (T[a].y - T[b].y) / SQUASH);
    const routes = new Map<number, Route | null>();
    const routeOf = (a: number, b: number): Route | null => {
      const k = Math.min(a, b) * 64 + Math.max(a, b);
      if (!routes.has(k)) routes.set(k, routeRoad(inp, T[Math.min(a, b)], T[Math.max(a, b)], sc));
      return routes.get(k) ?? null;
    };
    const cand: Array<[number, number]> = [];
    for (let a = 0; a < n; a++) {
      const near = Array.from({ length: n }, (_, b) => b).filter(b => b !== a).sort((p, q) => dist(a, p) - dist(a, q) || p - q).slice(0, 3);
      for (const b of near) if (!cand.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) cand.push([Math.min(a, b), Math.max(a, b)]);
    }
    const root = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
    const tree: Array<[number, number]> = [];
    const kruskal = (edges: Array<[number, number]>) => {
      const ok = edges.map(e => ({ e, r: routeOf(e[0], e[1]) })).filter(x => x.r) as Array<{ e: [number, number]; r: Route }>;
      ok.sort((p, q) => p.r.cost - q.r.cost || p.e[0] - q.e[0] || p.e[1] - q.e[1]);
      for (const { e } of ok) {
        const ra = find(e[0]), rb = find(e[1]);
        if (ra === rb) continue;
        root[ra] = rb;
        tree.push(e);
      }
    };
    kruskal(cand);
    // Towns the nearest-neighbour links left apart: try every pair across
    // the split, nearest first (towns on separate islands stay apart).
    for (let guard = 0; guard < n; guard++) {
      const groups = new Set(Array.from({ length: n }, (_, i) => find(i)));
      if (groups.size <= 1) break;
      const across: Array<[number, number]> = [];
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (find(a) !== find(b) && !routes.has(a * 64 + b)) across.push([a, b]);
      if (!across.length) break;
      across.sort((p, q) => dist(p[0], p[1]) - dist(q[0], q[1]));
      const before = tree.length;
      kruskal(across.slice(0, 6));
      if (tree.length === before && across.length <= 6) break;
    }
    // Shortcuts: a candidate link far cheaper than the way round the tree.
    const viaTree = (a: number, b: number): number => {
      const best = new Map<number, number>([[a, 0]]), q = [a];
      while (q.length) {
        const c = q.shift()!;
        for (const [p, r] of tree) {
          const o = p === c ? r : r === c ? p : -1;
          if (o < 0 || best.has(o)) continue;
          best.set(o, best.get(c)! + (routeOf(p, r)?.cost ?? Infinity));
          q.push(o);
        }
      }
      return best.get(b) ?? Infinity;
    };
    const extra = cand.filter(([a, b]) => !tree.some(([p, r]) => p === a && r === b))
      .map(e => ({ e, r: routeOf(e[0], e[1]) }))
      .filter(x => x.r && x.r.cost < 0.6 * viaTree(x.e[0], x.e[1]))
      .sort((p, q) => p.r!.cost - q.r!.cost)
      .slice(0, Math.max(1, Math.floor(n / 4)));
    for (const e of [...tree, ...extra.map(x => x.e)]) {
      const r = routeOf(e[0], e[1]);
      if (!r) continue;
      plan.links.push(e);
      for (let i = 0; i + 1 < r.pts.length; i++) {
        plan.roads.push({ ax: r.pts[i][0], ay: r.pts[i][1], bx: r.pts[i + 1][0], by: r.pts[i + 1][1], half, street: false, tunnel: r.tunnel[i] || undefined });
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

/** A routed road: its corner points, and which legs run in a tunnel. */
interface Route { pts: Array<[number, number]>; tunnel: boolean[]; cost: number }

/** Costs of the road lattice, in lattice steps. */
const ROAD_COST = {
  /** Each step over a river (a bridge): roads cross rivers, they do not follow them. */
  bridge: 5,
  /** Per px of climb (a terrace step of 3–5 px: a ramp or a short switchback). */
  climb: 0.6,
  /** Per px of height: roads keep to the valleys. */
  height: 0.02,
  /** A change of direction. */
  turn: 0.5,
  /** A step through a cliff no road can climb: a tunnel, only when unavoidable. */
  tunnel: 30,
};

/**
 * A road between two towns over the land, by A* on a lattice laid along the
 * isometric axes (so every leg runs on a diagonal, #97). Each step costs
 * more for a bridge, a climb or high ground, and a turn; the sea, lakes,
 * glaciers and lava cannot be crossed; a cliff higher than a terrace step
 * only by a tunnel. Null when no land joins the towns.
 */
function routeRoad(inp: PlanInput, a: { x: number; y: number }, b: { x: number; y: number }, sc: number): Route | null {
  const s = Math.max(2, 2.2 * sc), sq = s * SQUASH;
  const ux = (x: number, y: number) => ((x - a.x) / s + (y - a.y) / sq) / 2;
  const vx = (x: number, y: number) => ((y - a.y) / sq - (x - a.x) / s) / 2;
  const gi = Math.round(ux(b.x, b.y)), gj = Math.round(vx(b.x, b.y));
  const m = Math.ceil(Math.max(Math.abs(gi), Math.abs(gj)) * 0.35) + 4;
  const i0 = Math.min(0, gi) - m, j0 = Math.min(0, gj) - m;
  const W = Math.max(0, gi) + m - i0 + 1, H = Math.max(0, gj) + m - j0 + 1;
  if (W * H > 120000) return null;
  const posX = (i: number, j: number) => a.x + (i - j) * s, posY = (i: number, j: number) => a.y + (i + j) * sq;
  const N = W * H;
  // Per node: 0 unknown, 1 land, 2 blocked; lift and river cached.
  const kind = new Uint8Array(N), lift = new Float32Array(N), wet = new Uint8Array(N);
  const node = (i: number, j: number) => (j - j0) * W + (i - i0);
  const start = node(0, 0), goal = node(gi, gj);
  const probe = (n: number) => {
    if (kind[n]) return kind[n];
    const i = (n % W) + i0, j = Math.floor(n / W) + j0, x = posX(i, j), y = posY(i, j);
    kind[n] = n === start || n === goal || inp.isLand(x, y) ? 1 : 2;
    lift[n] = inp.liftAt?.(x, y) ?? 0;
    wet[n] = inp.waterAt?.(x, y) ? 1 : 0;
    return kind[n];
  };
  const DI = [1, -1, 0, 0], DJ = [0, 0, 1, -1];
  // A* over the nodes; each remembers the direction it was reached by, for
  // the turn cost (a node's best arrival, not every arrival: cheap and close).
  const g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), arrive = new Uint8Array(N).fill(4);
  const heap: number[] = [], hf: number[] = [];
  const push = (st: number, f: number) => {
    heap.push(st); hf.push(f);
    for (let c = heap.length - 1; c > 0;) {
      const p = (c - 1) >> 1;
      if (hf[p] <= hf[c]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]]; [hf[p], hf[c]] = [hf[c], hf[p]]; c = p;
    }
  };
  const pop = (): number => {
    const top = heap[0], lastS = heap.pop()!, lastF = hf.pop()!;
    if (heap.length) {
      heap[0] = lastS; hf[0] = lastF;
      for (let c = 0; ;) {
        const l = 2 * c + 1, r = l + 1;
        let m2 = c;
        if (l < heap.length && hf[l] < hf[m2]) m2 = l;
        if (r < heap.length && hf[r] < hf[m2]) m2 = r;
        if (m2 === c) break;
        [heap[m2], heap[c]] = [heap[c], heap[m2]]; [hf[m2], hf[c]] = [hf[c], hf[m2]]; c = m2;
      }
    }
    return top;
  };
  const h = (n: number) => Math.abs((n % W) + i0 - gi) + Math.abs(Math.floor(n / W) + j0 - gj);
  probe(start); probe(goal);
  g[start] = 0;
  push(start, h(start));
  const closed = new Uint8Array(N);
  let end = -1;
  while (heap.length) {
    const n = pop();
    if (closed[n]) continue;
    closed[n] = 1;
    if (n === goal) { end = n; break; }
    const dir = arrive[n], gc = g[n], i = (n % W) + i0, j = Math.floor(n / W) + j0;
    for (let d = 0; d < 4; d++) {
      const ni = i + DI[d], nj = j + DJ[d];
      if (ni < i0 || nj < j0 || ni >= i0 + W || nj >= j0 + H) continue;
      const q = node(ni, nj);
      if (closed[q] || probe(q) === 2) continue;
      // The midpoint must be land too (a narrow inlet between two nodes).
      const mx = (posX(i, j) + posX(ni, nj)) / 2, my = (posY(i, j) + posY(ni, nj)) / 2;
      if (!inp.isLand(mx, my)) continue;
      const jump = Math.abs(lift[q] - lift[n]);
      let c = 1 + Math.abs(lift[q] - lift[n]) * ROAD_COST.climb + lift[q] * ROAD_COST.height;
      if (jump > MAX_PLOT_STEP) c += ROAD_COST.tunnel;
      if (wet[q]) c += ROAD_COST.bridge;
      if (dir !== 4 && dir !== d) c += ROAD_COST.turn;
      const ng = gc + c;
      if (ng < g[q]) { g[q] = ng; from[q] = n; arrive[q] = d; push(q, ng + h(q)); }
    }
  }
  if (end < 0) return null;
  const chain: number[] = [];
  for (let st = end; st >= 0; st = from[st]) chain.push(st);
  chain.reverse();
  // Corners: where the direction or the tunnel state changes.
  const pts: Array<[number, number]> = [[a.x, a.y]], tunnel: boolean[] = [];
  let curDir = -1, curTun = false;
  for (let k = 1; k < chain.length; k++) {
    const p = chain[k - 1], q = chain[k], d = arrive[q];
    const pi = (p % W) + i0, pj = Math.floor(p / W) + j0;
    const tun = Math.abs(lift[q] - lift[p]) > MAX_PLOT_STEP;
    if (k > 1 && (d !== curDir || tun !== curTun)) { pts.push([posX(pi, pj), posY(pi, pj)]); tunnel.push(curTun); }
    curDir = d; curTun = tun;
  }
  // The last node is the lattice point nearest the town: finish at the town itself.
  const last = chain[chain.length - 1];
  const lx = posX((last % W) + i0, Math.floor(last / W) + j0), ly = posY((last % W) + i0, Math.floor(last / W) + j0);
  pts.push([lx, ly]); tunnel.push(curTun);
  if (Math.hypot(lx - b.x, ly - b.y) > 0.3) { pts.push([b.x, b.y]); tunnel.push(false); }
  return { pts, tunnel, cost: g[end] };
}

/**
 * How far (≤ max) a town street can run from the centre along (dx, dy)
 * (a unit step in face px) before water or a cliff stops it.
 */
function streetReach(inp: PlanInput, x: number, y: number, dx: number, dy: number, max: number): number {
  const l0 = inp.liftAt?.(x, y) ?? 0;
  for (let t = 0.5; t <= max; t += 0.5) {
    const qx = x + dx * t, qy = y + dy * t;
    if (!inp.isLand(qx, qy) || Math.abs((inp.liftAt?.(qx, qy) ?? 0) - l0) > MAX_PLOT_STEP) return Math.max(0, t - 0.5);
  }
  return max;
}

/** A path stays on dry land, steps no more than a terrace at a time, and crosses no river. */
function groundRuns(inp: PlanInput, path: Array<[number, number]>): boolean {
  for (let k = 0; k + 1 < path.length; k++) {
    const [x0, y0] = path[k], [x1, y1] = path[k + 1];
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    let prev = inp.liftAt?.(x0, y0) ?? 0;
    for (let i = 0; i <= n; i++) {
      const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
      if (!inp.isLand(x, y) || inp.waterAt?.(x, y)) return false;
      const l = inp.liftAt?.(x, y) ?? 0;
      if (Math.abs(l - prev) > MAX_PLOT_STEP) return false;
      prev = l;
    }
  }
  return true;
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
    if (d > rd.half || d >= best) continue;
    if (rd.tunnel) {
      // Under the hill: only the two mouths show, dark arches at the ends.
      const len = Math.hypot(rd.bx - rd.ax, rd.by - rd.ay), along = Math.min(t, 1 - t) * len;
      if (along < rd.half * 2.2) {
        const m = along < rd.half * 1.1 ? 0.22 : 0.45;
        return (((r * m) | 0) << 16) | (((g * m) | 0) << 8) | ((b * m) | 0);
      }
      continue;
    }
    best = d; bestR = rd; bestT = t;
  }
  if (bestR) {
    const era = plan.era;
    let cr: number, cg: number, cb: number;
    if (water) {
      // A bridge: planks, then stone arches, then concrete; railings at its edges.
      if (era <= 2) { cr = 120; cg = 92; cb = 64; } else if (era === 3) { cr = 156; cg = 146; cb = 128; } else { cr = 176; cg = 178; cb = 180; }
      if (k >= 2 && best > bestR.half * 0.7) { cr *= 0.6; cg *= 0.6; cb *= 0.6; }
      return ((cr | 0) << 16) | ((cg | 0) << 8) | (cb | 0);
    }
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
    if (p.kind) return airGround(p, x, y, k, r, g, b);
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

/**
 * A runway or a launch apron: a mown grass strip in the industrial era,
 * asphalt with a dashed centre line and threshold bars in the atomic era,
 * lit concrete after; an apron is concrete slabs with a blast ring.
 */
function airGround(p: Pad, x: number, y: number, k: number, r: number, g: number, b: number): number {
  const era = p.era ?? 4;
  const len = p.x1 - p.x0, u = (x - p.x0) / len, v = (y - p.y0) / Math.max(0.01, p.y1 - p.y0);
  let cr: number, cg: number, cb: number;
  if (p.kind === 'apron') {
    [cr, cg, cb] = [184, 184, 180];
    if (k >= 2 && ((Math.floor(x / 1.5) + Math.floor(y / 0.8)) & 1)) { cr -= 10; cg -= 10; cb -= 10; }
    const du = (u - 0.5) * len, dv = (v - 0.5) * (p.y1 - p.y0) / SQUASH;
    const rr = Math.hypot(du, dv);
    if (rr < len * 0.22 && rr > len * 0.22 - Math.max(0.5, 1 / k)) { cr = 212; cg = 180; cb = 70; }
    if (rr < len * 0.14) { cr *= 0.72; cg *= 0.7; cb *= 0.68; }               // scorched
  } else if (era <= 3) {
    [cr, cg, cb] = [r * 0.85 + 30, g * 0.85 + 36, b * 0.85 + 14];
    if (k >= 2 && Math.floor(x / 1.2) & 1) { cr *= 0.92; cg *= 0.95; cb *= 0.92; }   // mown stripes
  } else {
    [cr, cg, cb] = era === 4 ? [72, 74, 78] : [118, 122, 128];
    const mid = Math.abs(v - 0.5) < 0.12;
    if (mid && u > 0.08 && u < 0.92 && Math.floor(u * len / 1.4) % 2 === 0) { cr = 232; cg = 232; cb = 220; }
    if ((u < 0.05 || u > 0.95) && Math.floor(v * 6) % 2 === 0) { cr = 232; cg = 232; cb = 220; }
    if (era >= 5 && k >= 2 && (v < 0.1 || v > 0.9) && Math.floor(u * len) % 3 === 0) { cr = 120; cg = 220; cb = 255; }
  }
  return ((cr | 0) << 16) | ((cg | 0) << 8) | (cb | 0);
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
  for (const n of c.p) {
    const p = plan.pads[n];
    if (x > p.x0 - 1 && x < p.x1 + 1 && y > p.y0 - 1 && y < p.y1 + 1) return true;
  }
  return false;
}
