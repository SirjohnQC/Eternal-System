/**
 * SettlementForge — pixel buildings for the diorama's towns.
 *
 * Buildings are boxes and roofs drawn straight into pixels in the diorama's
 * own view: a front wall facing the camera and the top (or roof) seen from
 * above, foreshortened like the terrain (SQUASH). Lit from the right like the
 * land, shaded in quantised five-step ramps (CreatureForge's), with a 1-px
 * outline. Detail arrives with the camera scale S: doors, windows, timber
 * framing, brickwork, roof tiles, lit office windows.
 *
 * Styles follow the tech era (huts, adobe and ziggurats, timber houses and
 * keeps, brick rows and mills, concrete blocks, glass towers, white spires
 * and domes) and the species' building material tints the early ones.
 *
 * Pure: RGBA out, no DOM.
 */
import { ramp, type Ramp, type RGB } from './CreatureForge';
import { SQUASH, type Building, type BuildingKind, type Era } from './SettlementPlan';
import type { ArchGenome } from './Architecture';
import { buildingOverride, type Tint } from './SpriteOverride';

export interface BuildingSprite {
  width: number; height: number; data: Uint8ClampedArray;
  /** The front-centre foot pixel (stands on the ground point). */
  footX: number; footY: number;
}

export interface TownStyle {
  era: Era;
  wall: Ramp; roof: Ramp; trim: Ramp; glass: Ramp;
  /** Warm window light. */
  lamp: RGB;
  /** Wildcard: a lantern on every rooftop. */
  lanterns?: boolean;
  /** The species' material colour for hand-made sheets (SpriteOverride). */
  tint?: Tint;
}

/** Wall hue for the species' building material (early eras only). */
const MATERIAL_HUE: Array<[RegExp, number, number, number]> = [
  [/resin|amber/, 36, 0.55, 0.55],
  [/gel|membrane/, 186, 0.35, 0.7],
  [/shell/, 30, 0.18, 0.82],
  [/coral/, 8, 0.45, 0.65],
  [/filament|fibre|woven/, 48, 0.42, 0.66],
  [/chitin/, 300, 0.22, 0.4],
  [/cartilage/, 20, 0.22, 0.7],
  [/film/, 110, 0.22, 0.62],
];

export function townStyle(era: Era, material = 'quarried stone', arch?: ArchGenome): TownStyle {
  let wall: [number, number, number], roof: [number, number, number], trim: [number, number, number], glass: [number, number, number];
  switch (era) {
    case 0: wall = [28, 0.32, 0.42]; roof = [44, 0.45, 0.52]; trim = [24, 0.32, 0.26]; glass = [30, 0.3, 0.15]; break;
    case 1: wall = [34, 0.36, 0.64]; roof = [42, 0.42, 0.56]; trim = [26, 0.3, 0.34]; glass = [25, 0.3, 0.18]; break;
    case 2: wall = [40, 0.26, 0.78]; roof = [8, 0.55, 0.42]; trim = [24, 0.36, 0.26]; glass = [210, 0.25, 0.22]; break;
    case 3: wall = [12, 0.42, 0.47]; roof = [215, 0.1, 0.44]; trim = [30, 0.12, 0.62]; glass = [210, 0.3, 0.24]; break;
    case 4: wall = [210, 0.06, 0.62]; roof = [210, 0.05, 0.48]; trim = [210, 0.08, 0.36]; glass = [205, 0.35, 0.42]; break;
    case 5: wall = [200, 0.18, 0.66]; roof = [200, 0.08, 0.76]; trim = [205, 0.12, 0.4]; glass = [196, 0.6, 0.52]; break;
    default: wall = [190, 0.12, 0.86]; roof = [186, 0.45, 0.72]; trim = [200, 0.14, 0.62]; glass = [185, 0.8, 0.6]; break;
  }
  if (arch?.wall) {
    // The civilisation's own material: fully until the industrial era, then
    // blended with the modern materials (glass and concrete take over).
    const m = era <= 3 ? 1 : era === 4 ? 0.6 : 0.4, aw = arch.wall;
    wall = [aw[0], aw[1] * m + wall[1] * (1 - m), aw[2] * m + wall[2] * (1 - m)];
  }
  if (arch) roof = [arch.accent[0], arch.accent[1], Math.max(0.3, Math.min(0.7, (arch.accent[2] + roof[2]) / 2))];
  // Their glass takes their colour too, so modern domes and pods differ.
  if (arch) {
    const dh = ((arch.accent[0] - glass[0] + 540) % 360) - 180;
    glass = [(glass[0] + dh * 0.6 + 360) % 360, glass[1], glass[2]];
  }
  if (!arch?.wall && era <= 3) {
    for (const [re, h, s, l] of MATERIAL_HUE) {
      if (re.test(material)) { wall = [h, s, (wall[2] + l) / 2]; break; }
    }
  }
  return {
    era,
    wall: ramp(...wall), roof: ramp(...roof), trim: ramp(...trim), glass: ramp(...glass),
    lamp: era >= 6 ? [150, 250, 255] : [255, 214, 130],
    lanterns: !!arch?.quirks.includes('lanterns'),
    tint: arch ? { hue: (arch.wall ?? arch.accent)[0], sat: (arch.wall ?? arch.accent)[1] } : undefined,
  };
}

function hash(a: number, b: number, c: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class Px {
  data: Uint8ClampedArray;
  out: RGB;
  constructor(public w: number, public h: number) { this.data = new Uint8ClampedArray(w * h * 4); this.out = [0, 0, 0]; }
  set(x: number, y: number, c: RGB): void {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    this.data[o] = c[0]; this.data[o + 1] = c[1]; this.data[o + 2] = c[2]; this.data[o + 3] = 255;
  }
  has(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.data[(y * this.w + x) * 4 + 3] > 0;
  }
  rect(x0: number, y0: number, w: number, h: number, c: RGB): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c);
  }
  /** A 1-px outline around the silhouette. */
  outline(c: RGB): void {
    const add: number[] = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.has(x, y)) continue;
      if (this.has(x - 1, y) || this.has(x + 1, y) || this.has(x, y - 1) || this.has(x, y + 1)) add.push(x, y);
    }
    for (let i = 0; i < add.length; i += 2) this.set(add[i], add[i + 1], c);
  }
}

/**
 * Paint one building at camera scale S (screen px per world px; an integer
 * at least 1). Long walls get detail only once there are pixels for it.
 */
export function paintBuilding(b: Building, S: number, st: TownStyle): BuildingSprite {
  const spr = paintBody(b, S, st);
  return b.pad && b.pad > 0 ? withFoundation(spr, Math.max(1, Math.round(b.pad * S)), S, st) : spr;
}

/**
 * The building raised on a foundation `padPx` tall: where its plot falls
 * away across a terrace step, the town levelled it (cut and fill) and walled
 * the drop. Rubble and packed earth early, dressed stone courses through the
 * industrial era, poured concrete after. Lit from the right like the land.
 * The foot stays the building's base (the top of the pad).
 */
export function withFoundation(spr: BuildingSprite, padPx: number, S: number, st: TownStyle): BuildingSprite {
  const { width: W, height: H } = spr;
  // The building's base: the opaque extent of its lowest rows.
  let x0 = W, x1 = -1;
  for (let y = Math.max(0, spr.footY - 1); y <= spr.footY; y++) for (let x = 0; x < W; x++) {
    if (spr.data[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  }
  if (x1 < x0) { x0 = Math.max(0, spr.footX - 2); x1 = Math.min(W - 1, spr.footX + 2); }
  const NH = Math.max(H, spr.footY + 1 + padPx);
  const out = new Uint8ClampedArray(W * NH * 4);
  out.set(spr.data.subarray(0, W * H * 4));
  const era = st.era;
  // Earthy, darker than the buildings, so the wall reads as ground work.
  const base: RGB = era <= 1 ? [112, 92, 70] : era <= 3 ? [126, 116, 102] : [138, 138, 136];
  const shade = (c: RGB, k: number): RGB => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
  const put = (x: number, y: number, c: RGB) => {
    if (x < 0 || y < 0 || x >= W || y >= NH) return;
    const o = (y * W + x) * 4;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
  };
  const top = spr.footY + 1, bottom = spr.footY + padPx;
  const course = Math.max(2, Math.round(S * 0.6)), block = Math.max(3, Math.round(S * 1.2));
  for (let y = top; y <= bottom; y++) for (let x = x0; x <= x1; x++) {
    const edge = x === x0 || x === x1 || y === bottom;
    let k = x <= x0 + Math.max(0, Math.round((x1 - x0) * 0.15)) ? 0.82 : x >= x1 - Math.max(0, Math.round((x1 - x0) * 0.2)) ? 1.12 : 1;
    if (y === top) k *= 1.15;                                        // the lip of the pad
    if (era <= 1 && ((x * 7 + y * 13) % 5 === 0)) k *= 0.85;          // rubble
    else if (era >= 2 && era <= 3 && S >= 2) {
      const row = Math.floor((y - top) / course);
      if ((y - top) % course === course - 1 || (x - x0 + (row & 1) * (block >> 1)) % block === 0) k *= 0.78;   // mortar
    } else if (era >= 4 && S >= 3 && (x - x0) % (block * 2) === 0) k *= 0.88;                                   // shuttering joints
    put(x, y, edge && S >= 2 ? shade(base, 0.45) : shade(base, k));
  }
  // Steps up to the door, cut into the front of the pad.
  if (S >= 2 && padPx >= 3) {
    const sw = Math.max(2, Math.round(S * 0.9)), sx = Math.max(x0 + 1, Math.min(x1 - sw, spr.footX - (sw >> 1)));
    for (let y = top; y < bottom; y++) for (let x = sx; x < sx + sw; x++) put(x, y, shade(base, (y - top) % 2 ? 0.7 : 1.22));
  }
  return { width: W, height: NH, data: out, footX: spr.footX, footY: spr.footY };
}

/**
 * Without the hand-made sheets a trade or service is forged as the nearest
 * box form: a works shed with its stack for factories and power, a tower
 * for a silo or a launch gantry, and so on.
 */
const CIVIC_FORM: Partial<Record<BuildingKind, (era: Era) => BuildingKind>> = {
  market: () => 'gable', granary: e => (e <= 2 ? 'hut' : 'tower'), temple: () => 'ziggurat', workshop: () => 'row',
  warehouse: () => 'gable', school: () => 'house', harbour: () => 'block', factory: () => 'mill', station: () => 'row',
  power: () => 'mill', airfield: () => 'block', spaceport: () => 'spire',
};

function paintBody(b: Building, S: number, st: TownStyle): BuildingSprite {
  const sheet = buildingOverride(b, S, st.era, st.tint);
  if (sheet) return sheet;
  const form = CIVIC_FORM[b.kind];
  if (form) return paintBody({ ...b, kind: form(st.era) }, S, st);
  const W = Math.max(1, Math.round(b.w * S));
  const D = Math.max(1, Math.round(b.d * S * SQUASH));
  const H = Math.max(1, Math.round(b.h * S));
  const pad = 2;
  // Room above for roofs, spires and chimneys.
  const above = D + Math.max(W, Math.round(b.h * S * 1.8)) + 2 * S + 2;
  // On stilts the whole building stands raised; the legs reach the ground.
  const stilt = b.stilts ? Math.max(2, Math.round(Math.max(H, 2 * S) * 0.5)) : 0;
  const cw = W + pad * 2 + 2, ch = H + above + pad + stilt;
  const P = new Px(cw, ch);
  const ox = pad + 1, base = ch - pad - stilt;      // front wall: columns ox..ox+W-1, rows base-H..base-1
  const wallTop = base - H;
  const { wall, roof, trim, glass } = st;
  const detail = S >= 3;
  const r = (k: number) => hash(b.seed, k, 7);

  const frontWall = (x0: number, w: number, top: number, bottom: number, R: Ramp = wall) => {
    for (let y = top; y < bottom; y++) for (let x = x0; x < x0 + w; x++) {
      const lv = w >= 3 && x === x0 ? 1 : w >= 3 && x === x0 + w - 1 ? 3 : 2;
      P.set(x, y, R.lv[lv]);
    }
  };
  const flatTop = (x0: number, w: number, top: number, d: number, R: Ramp = roof) => {
    for (let y = top - d; y < top; y++) for (let x = x0; x < x0 + w; x++) {
      const edge = detail && (y === top - d || x === x0 || x === x0 + w - 1);
      P.set(x, y, R.lv[edge ? 3 : 4]);
    }
  };
  const door = (cx: number, R: Ramp = trim) => {
    if (!detail) return;
    const dw = Math.max(1, Math.round(S * 0.35)), dh = Math.max(2, Math.round(S * 0.6));
    P.rect(cx - (dw >> 1), base - dh, dw, dh, R.lv[0]);
  };
  const windowsRow = (x0: number, w: number, y: number, lit: boolean) => {
    if (!detail) return;
    const ws = Math.max(1, Math.round(S * 0.25));
    for (const f of [0.22, 0.78]) {
      const x = x0 + Math.round(w * f) - (ws >> 1);
      P.rect(x, y, ws, ws, lit ? st.lamp : glass.lv[1]);
    }
  };
  /** Floors of windows on a tall wall (blocks, towers). */
  const windowGrid = (x0: number, w: number, top: number, bottom: number, dense: boolean) => {
    if (S < 2) return;
    const fy = Math.max(2, Math.round(S * 0.9)), fx = Math.max(2, Math.round(S * (dense ? 0.55 : 0.8)));
    let row = 0;
    for (let y = top + 1; y < bottom - 1; y += fy, row++) {
      let col = 0;
      for (let x = x0 + 1; x < x0 + w - 1; x += fx, col++) {
        const lit = hash(b.seed, row, col) < (st.era >= 5 ? 0.35 : 0.22);
        P.set(x, y, lit ? st.lamp : glass.lv[x > x0 + w / 2 ? 3 : 2]);
        if (S >= 4) P.set(x, y + 1, lit ? st.lamp : glass.lv[1]);
      }
    }
  };
  /** Gable end facing the camera, roof slopes running back (ridge front-to-back). */
  const gableFront = (x0: number, w: number, top: number, R: Ramp) => {
    const T = Math.max(1, Math.round(w * 0.42));
    const c = x0 + (w - 1) / 2, half = w / 2;
    const edge = (x: number) => {
      const t = 1 - Math.abs(x - c) / (half + 0.5);
      return top - Math.max(0, Math.round(T * t));
    };
    // Gable triangle in wall colour.
    for (let x = x0; x < x0 + w; x++) for (let y = edge(x); y < top; y++) P.set(x, y, wall.lv[2]);
    // Roof band of depth D above the gable edge, overhanging by a pixel.
    const ov = S >= 2 ? 1 : 0;
    for (let x = x0 - ov; x < x0 + w + ov; x++) {
      const e = edge(Math.max(x0, Math.min(x0 + w - 1, x)));
      for (let y = e - D; y < e; y++) {
        const sun = x > c ? 3 : x < c - 0.5 ? 1 : 4;
        const tile = detail && ((y - (e - D)) & 1) === 1 ? -1 : 0;
        P.set(x, y, R.lv[Math.max(0, sun + tile)]);
      }
      if (detail) P.set(x, e, R.lv[0]);                       // eave line
    }
  };
  /** Roof with its ridge along x: front slope seen face-on, back slope beyond. */
  const gableSide = (x0: number, w: number, top: number, R: Ramp) => {
    // The front slope faces the sun and the camera: tall and lit, in tile
    // courses; the ridge a bright line; the back slope a thin dark sliver.
    const rise = Math.max(1, Math.round(w * 0.3));
    const front = Math.max(1, Math.round(D * 0.55)) + rise, back = Math.max(1, Math.round(D * 0.3));
    const ov = S >= 2 ? 1 : 0;
    for (let x = x0 - ov; x < x0 + w + ov; x++) {
      for (let y = top - front; y < top; y++) {
        const course = detail && ((top - y) & 1) === 0;
        P.set(x, y, R.lv[y === top - front ? 4 : course ? 2 : 3]);
      }
      for (let y = top - front - back; y < top - front; y++) P.set(x, y, R.lv[1]);
      if (detail) P.set(x, top - 1, R.lv[0]);               // eave shadow
    }
    return top - front - back;
  };

  switch (b.kind) {
    case 'hut': {
      // Low round wall, conical thatch.
      const wh = Math.max(1, H);
      frontWall(ox, W, base - wh, base);
      const T = Math.max(2, Math.round(W * 0.7));
      const c = ox + (W - 1) / 2;
      for (let i = 0; i < T + D; i++) {
        const hw = (W / 2 + (S >= 2 ? 1 : 0)) * (1 - i / (T + D));
        const y = base - wh - 1 - i;
        for (let x = Math.round(c - hw); x <= Math.round(c + hw); x++) {
          const lv = x > c + hw * 0.3 ? 4 : x < c - hw * 0.3 ? 1 : 3;
          P.set(x, y, roof.lv[detail && (i & 1) ? Math.max(0, lv - 1) : lv]);
        }
      }
      door(Math.round(c));
      break;
    }
    case 'adobe': case 'block': {
      frontWall(ox, W, wallTop, base);
      flatTop(ox, W, wallTop, D);
      if (b.kind === 'block') windowGrid(ox, W, wallTop, base, false);
      else { windowsRow(ox, W, wallTop + Math.max(1, Math.round(H * 0.3)), false); door(ox + (W >> 1)); }
      if (b.kind === 'adobe' && detail) {
        // Roof beams poking through the wall top.
        for (let x = ox + 1; x < ox + W - 1; x += Math.max(2, Math.round(S * 0.7))) P.set(x, wallTop, trim.lv[1]);
      }
      break;
    }
    case 'house': {
      frontWall(ox, W, wallTop, base);
      gableFront(ox, W, wallTop, roof);
      if (st.era === 2 && S >= 4) {
        // Timber framing.
        for (let y = wallTop; y < base; y++) { P.set(ox, y, trim.lv[1]); P.set(ox + W - 1, y, trim.lv[1]); }
        for (let x = ox; x < ox + W; x++) P.set(x, wallTop + Math.round(H * 0.45), trim.lv[1]);
      }
      windowsRow(ox, W, wallTop + Math.max(1, Math.round(H * 0.25)), st.era >= 3 && r(1) < 0.4);
      door(ox + (W >> 1));
      break;
    }
    case 'gable': case 'row': {
      frontWall(ox, W, wallTop, base);
      if (b.kind === 'row' && detail) {
        // Brickwork: staggered mortar flecks.
        for (let y = wallTop; y < base; y += 2) for (let x = ox + ((y >> 1) & 1) * 2; x < ox + W; x += 4) P.set(x, y, wall.lv[3]);
      }
      const top = gableSide(ox, W, wallTop, roof);
      if (b.kind === 'row') {
        // Chimney on the roof.
        const cwid = Math.max(1, Math.round(S * 0.55)), cx = ox + Math.round(W * 0.72);
        const stub = Math.max(1, Math.round(S * 0.45));
        for (let y = top - stub; y < top + stub; y++) for (let x = cx; x < cx + cwid; x++) P.set(x, y, wall.lv[x === cx ? 1 : 2]);
        if (S >= 3) for (let x = cx; x < cx + cwid; x++) P.set(x, top - stub, trim.lv[0]);
      }
      windowsRow(ox, W, wallTop + Math.max(1, Math.round(H * 0.3)), st.era >= 3 && r(2) < 0.45);
      door(ox + Math.round(W * (r(3) < 0.5 ? 0.35 : 0.65)));
      break;
    }
    case 'tower': {
      frontWall(ox, W, wallTop, base, st.era >= 5 ? glass : wall);
      if (st.era >= 5) {
        // Glass curtain wall: vertical mullions.
        for (let x = ox + 1; x < ox + W - 1; x += Math.max(2, Math.round(S * 0.6))) for (let y = wallTop; y < base; y++) P.set(x, y, trim.lv[3]);
        windowGrid(ox, W, wallTop, base, true);
      } else {
        windowGrid(ox, W, wallTop, base, true);
      }
      flatTop(ox, W, wallTop, D);
      if (st.era >= 5 && S >= 2) {
        // Antenna.
        const ax = ox + (W >> 1);
        for (let y = wallTop - D - Math.max(2, S * 2); y < wallTop - D; y++) P.set(ax, y, trim.lv[3]);
        P.set(ax, wallTop - D - Math.max(2, S * 2) - 1, [255, 90, 80]);
      }
      break;
    }
    case 'dome': {
      const wh = Math.max(1, H);
      frontWall(ox, W, base - wh, base);
      const R = Math.max(1, Math.round(W * 0.48)) + D;
      const c = ox + (W - 1) / 2;
      const domeRamp = st.era >= 5 || st.era === 0 ? glass : roof;
      for (let x = ox; x < ox + W; x++) {
        const u = (x - c) / (W / 2 + 0.01);
        const hgt = Math.round(R * Math.sqrt(Math.max(0, 1 - u * u)));
        for (let i = 0; i < hgt; i++) {
          const y = base - wh - 1 - i;
          const lv = u > 0.25 && i > hgt * 0.45 ? 4 : u < -0.35 ? 1 : u > 0.25 ? 3 : 2;
          P.set(x, y, domeRamp.lv[lv]);
        }
      }
      if (detail) {
        // A ring of lit ports round the base.
        for (let x = ox + 1; x < ox + W - 1; x += Math.max(2, S)) P.set(x, base - wh - 1, st.lamp);
      }
      break;
    }
    case 'spire': {
      const sw = Math.max(1, Math.min(W, Math.round(W * 0.6)));
      const sx = ox + ((W - sw) >> 1);
      frontWall(sx, sw, wallTop, base, st.era >= 5 ? glass : wall);
      for (let y = wallTop + 1; y < base - 1; y += Math.max(2, S)) P.set(sx + (sw >> 1), y, st.lamp);
      const T = Math.max(2, Math.round(sw * 1.8));
      const c = sx + (sw - 1) / 2;
      for (let i = 0; i < T; i++) {
        const hw = (sw / 2) * (1 - i / T);
        for (let x = Math.round(c - hw); x <= Math.round(c + hw); x++) P.set(x, wallTop - 1 - i, roof.lv[x > c ? 4 : 2]);
      }
      break;
    }
    case 'ziggurat': {
      const tiers = 3;
      let tw = W, y = base;
      for (let t = 0; t < tiers; t++) {
        const th = Math.max(1, Math.round(H / tiers)), td = Math.max(1, Math.round(D / tiers));
        const x0 = ox + ((W - tw) >> 1);
        frontWall(x0, tw, y - th, y);
        flatTop(x0, tw, y - th, td, wall);
        y -= th + td;
        tw = Math.max(1, Math.round(tw * 0.68));
      }
      // Central stair.
      if (S >= 2) for (let yy = y; yy < base; yy++) P.set(ox + (W >> 1), yy, wall.lv[yy & 1 ? 1 : 3]);
      break;
    }
    case 'keep': {
      frontWall(ox, W, wallTop, base, wall);
      flatTop(ox, W, wallTop, D, wall);
      // Crenellations along the front of the top.
      for (let x = ox; x < ox + W; x += 2) P.set(x, wallTop - D - 1, wall.lv[4]);
      if (S >= 2) for (let y = wallTop + 1; y < base - 2; y += Math.max(2, S)) P.set(ox + (W >> 1), y, trim.lv[0]);
      door(ox + (W >> 1));
      break;
    }
    case 'church': {
      // Nave with its gable to the camera, a tower with a spire on the left.
      const tw = Math.max(1, Math.round(W * 0.34)), nw = W - tw;
      frontWall(ox + tw, nw, base - Math.max(1, Math.round(H * 0.55)), base);
      gableFront(ox + tw, nw, base - Math.max(1, Math.round(H * 0.55)), roof);
      frontWall(ox, tw, wallTop, base, wall);
      const T = Math.max(2, Math.round(tw * 2.2)), c = ox + (tw - 1) / 2;
      for (let i = 0; i < T; i++) {
        const hw = (tw / 2 + 0.3) * (1 - i / T);
        for (let x = Math.round(c - hw); x <= Math.round(c + hw); x++) P.set(x, wallTop - 1 - i, roof.lv[x > c ? 3 : 1]);
      }
      if (detail) P.set(Math.round(c), wallTop + Math.max(1, S >> 1), st.lamp);
      door(ox + tw + (nw >> 1));
      break;
    }
    case 'hive': {
      // Stacked rings narrowing upward, dark openings round each course.
      const n = Math.max(3, Math.round(H / Math.max(2, S * 0.9)));
      const c = ox + (W - 1) / 2;
      let y = base;
      for (let i = 0; i < n; i++) {
        const hw = (W / 2) * (1 - (i / n) * 0.65), hb = Math.max(1, Math.round(H / n));
        for (let yy = y - hb; yy < y; yy++) for (let x = Math.round(c - hw); x <= Math.round(c + hw); x++) {
          const u = (x - c) / (hw + 0.01);
          P.set(x, yy, wall.lv[yy === y - hb ? 3 : u > 0.35 ? 3 : u < -0.45 ? 1 : 2]);
        }
        if (S >= 2 && (i & 1) === 0) for (let x = Math.round(c - hw * 0.6); x <= Math.round(c + hw * 0.6); x += Math.max(2, S)) {
          P.set(x, y - Math.max(1, hb >> 1) - 1, st.era >= 4 && hash(b.seed, i, x) < 0.5 ? st.lamp : trim.lv[0]);
        }
        y -= hb;
      }
      for (let yy = y - Math.max(1, S >> 1); yy < y; yy++) P.set(Math.round(c), yy, roof.lv[3]);
      if (detail) P.rect(Math.round(c) - (Math.max(1, Math.round(S * 0.3)) >> 1), base - Math.max(2, Math.round(S * 0.6)), Math.max(1, Math.round(S * 0.3)), Math.max(2, Math.round(S * 0.6)), trim.lv[0]);
      break;
    }
    case 'pod': {
      // A round pod on a short stalk; glass from the space age.
      const c = ox + (W - 1) / 2, rr = W / 2, stalk = Math.max(1, Math.round(H * 0.35));
      const sw = Math.max(1, Math.round(W * 0.2));
      P.rect(Math.round(c - sw / 2), base - stalk, sw, stalk, trim.lv[1]);
      const cy = base - stalk - rr;
      const R2 = st.era >= 5 ? glass : wall;
      for (let y = Math.floor(cy - rr - D * 0.3); y <= Math.ceil(cy + rr); y++) for (let x = ox; x < ox + W; x++) {
        const u = (x + 0.5 - c - 0.5) / rr, v = (y + 0.5 - cy) / (rr + D * 0.15);
        if (u * u + v * v > 1) continue;
        P.set(x, y, R2.lv[u > 0.2 && v < -0.2 ? 4 : u < -0.4 || v > 0.55 ? 1 : u > 0.2 ? 3 : 2]);
      }
      if (S >= 2) for (let x = ox + 1; x < ox + W - 1; x += Math.max(2, S)) P.set(x, Math.round(cy), st.era >= 3 ? st.lamp : trim.lv[0]);
      break;
    }
    case 'burrow': {
      // A low turfed mound with an arched mouth; skylights later on.
      const mw = Math.round(W * 1.1), x0 = ox - ((mw - W) >> 1), c = x0 + (mw - 1) / 2;
      const mh = Math.max(2, H + D);
      for (let x = x0; x < x0 + mw; x++) {
        const u = (x + 0.5 - c - 0.5) / (mw / 2);
        const hh = Math.round(mh * Math.sqrt(Math.max(0, 1 - u * u)));
        for (let i = 0; i < hh; i++) P.set(x, base - 1 - i, roof.lv[i === hh - 1 ? 4 : u > 0.3 ? 3 : u < -0.4 ? 1 : 2]);
      }
      const aw = Math.max(1, Math.round(W * 0.28)), ah = Math.max(1, Math.round(mh * 0.5));
      for (let y = base - ah; y < base; y++) for (let x = Math.round(c - aw / 2); x < Math.round(c + aw / 2); x++) P.set(x, y, trim.lv[0]);
      if (st.era >= 3 && S >= 2) P.set(Math.round(c + mw * 0.25), base - Math.round(mh * 0.8), st.lamp);
      break;
    }
    case 'grown': {
      // A living tower: a trunk swelling into a bulbous crown, lit windows.
      const c = ox + (W - 1) / 2, tw = Math.max(1, Math.round(W * 0.42)), th = Math.max(1, Math.round(H * 0.55));
      for (let y = base - th; y < base; y++) {
        const flare = y > base - 2 ? 1 : 0;
        for (let x = Math.round(c - tw / 2) - flare; x < Math.round(c + tw / 2) + flare; x++) P.set(x, y, wall.lv[x < c - tw * 0.2 ? 1 : x > c + tw * 0.2 ? 3 : 2]);
      }
      const cr = W / 2 + (S >= 2 ? 1 : 0), cyc = base - th - (H - th) / 2 - D * 0.4, ch2 = (H - th) / 2 + D * 0.5;
      for (let y = Math.floor(cyc - ch2); y <= Math.ceil(cyc + ch2); y++) for (let x = Math.floor(c - cr); x <= Math.ceil(c + cr); x++) {
        const u = (x - c) / cr, v = (y - cyc) / ch2;
        if (u * u + v * v > 1) continue;
        P.set(x, y, roof.lv[u > 0.25 && v < -0.1 ? 4 : u < -0.4 || v > 0.5 ? 1 : 3]);
      }
      if (S >= 2) for (let y = base - th + 1; y < base - 1; y += Math.max(2, S)) P.set(Math.round(c), y, st.era >= 2 ? st.lamp : trim.lv[0]);
      break;
    }
    case 'carved': {
      // Halls cut into a block of the world's own stone: stepped masses
      // with dark carved openings.
      const steps = 2 + (b.seed & 1);
      let y = base, w = W, x0 = ox;
      for (let i = 0; i < steps; i++) {
        const hh = Math.max(1, Math.round(H / steps)), dd = Math.max(1, Math.round(D / steps));
        frontWall(x0, w, y - hh, y);
        flatTop(x0, w, y - hh, dd, wall);
        if (S >= 2) for (let x = x0 + 1; x < x0 + w - 1; x += Math.max(3, S + 1)) {
          const oh = Math.max(1, Math.round(hh * 0.5));
          for (let yy = y - oh - 1; yy < y - 1; yy++) P.set(x, yy, st.era >= 4 && hash(b.seed, i, x) < 0.5 ? st.lamp : trim.lv[0]);
        }
        y -= hh + dd;
        const nw = Math.max(1, Math.round(w * 0.7));
        x0 += (b.seed >> (i + 2)) & 1 ? w - nw : 0;
        w = nw;
      }
      break;
    }
    case 'mill': {
      // Long works shed with a tall chimney stack.
      frontWall(ox, W, wallTop, base);
      if (detail) for (let y = wallTop; y < base; y += 2) for (let x = ox + ((y >> 1) & 1) * 2; x < ox + W; x += 4) P.set(x, y, wall.lv[3]);
      gableSide(ox, W, wallTop, roof);
      windowGrid(ox, W, wallTop, base, true);
      const cwid = Math.max(1, Math.round(S * 0.5)), cx = ox + Math.round(W * 0.8);
      const ctop = wallTop - Math.round(b.h * S * 1.6);
      for (let y = ctop; y < wallTop; y++) for (let x = cx; x < cx + cwid; x++) P.set(x, y, wall.lv[x === cx ? 1 : 2]);
      if (S >= 2) for (let x = cx; x < cx + cwid; x++) P.set(x, ctop, trim.lv[0]);
      break;
    }
  }
  if (st.lanterns && S >= 2) {
    // Wildcard: a lantern above every building.
    for (let y = 0; y < ch; y++) {
      let hit = -1;
      for (let x = 0; x < cw; x++) if (P.has(x, y)) { hit = x; break; }
      if (hit >= 0) { P.set(ox + (W >> 1), Math.max(0, y - 2), st.lamp); P.set(ox + (W >> 1), Math.max(0, y - 1), trim.lv[1]); break; }
    }
  }
  if (stilt) {
    // Legs down to the ground (and a cross-brace on longer ones).
    const legs = W >= 4 ? [ox, ox + (W >> 1), ox + W - 1] : [ox, ox + W - 1];
    for (const x of legs) for (let y = base; y < base + stilt; y++) P.set(x, y, trim.lv[x === ox ? 1 : 2]);
    if (stilt >= 4) for (let x = ox; x < ox + W; x++) P.set(x, base + (stilt >> 1), trim.lv[1]);
  }
  if (S >= 2) P.outline(wall.outline);
  return { width: cw, height: ch, data: P.data, footX: ox + (W >> 1), footY: base + stilt - 1 };
}

/**
 * A building under construction, `p` 0..1 of the way, made from the finished
 * sprite (hand-made or forged) so it fits whatever stands there at the end:
 *
 *   0.00–0.15  the plot staked out and cleared (the foundation, if any, laid);
 *   0.15–0.35  a scaffold frame rising to the building's height;
 *   0.35–0.95  the building itself wiped in bottom-up inside the scaffold,
 *              its newest courses pale, dust kicked up at its foot;
 *   0.95–1.00  the scaffold struck, the last dust settling.
 *
 * Industrial and later sites get a crane beside them. Same foot as the
 * finished sprite (the canvas only widens to the right for the crane), so
 * the site sits where the building will stand. 12 steps are cached by the
 * renderer: nothing here runs per frame.
 */
export function paintConstruction(b: Building, S: number, st: TownStyle, p: number): BuildingSprite {
  const done = paintBuilding(b, S, st);
  const W0 = done.width, H = done.height, base = done.footY;
  // The building's extent above its foot.
  let x0 = W0, x1 = -1, top = base;
  for (let y = 0; y <= base; y++) for (let x = 0; x < W0; x++) {
    if (!done.data[(y * W0 + x) * 4 + 3]) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < top) top = y;
  }
  if (x1 < x0) return done;
  const crane = st.era >= 3 && S >= 2;
  const extra = crane ? 2 + S * 2 : 1;
  const W = W0 + extra;
  const out = new Uint8ClampedArray(W * H * 4);
  const put = (x: number, y: number, c: RGB) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
  };
  const copyRow = (y: number, fresh: number) => {
    for (let x = 0; x < W0; x++) {
      const si = (y * W0 + x) * 4;
      if (!done.data[si + 3]) continue;
      // Fresh courses read pale (wet mortar, new timber) for a moment.
      put(x, y, [done.data[si] + (255 - done.data[si]) * fresh, done.data[si + 1] + (255 - done.data[si + 1]) * fresh, done.data[si + 2] + (255 - done.data[si + 2]) * fresh]);
    }
  };
  // Below the foot: the foundation goes in first, whole.
  for (let y = base + 1; y < H; y++) copyRow(y, 0);
  const steel = st.era >= 4;
  const pole: RGB = steel ? [150, 156, 164] : st.trim.lv[2], ledger: RGB = steel ? [190, 196, 204] : st.trim.lv[3];
  const dirt: RGB = [122, 96, 66], dirtDark: RGB = [92, 70, 48];
  const h = base - top + 1, span = x1 - x0 + 1;
  const hsh = (k: number) => hash(b.seed, k, Math.floor(p * 12));

  // The cleared plot: a band of turned earth along the base.
  if (p < 0.95) {
    const band = Math.max(1, Math.round(S * 0.5));
    for (let y = base - band + 1; y <= base; y++) for (let x = x0; x <= x1; x++) put(x, y, y === base - band + 1 ? dirt : dirtDark);
  }
  if (p < 0.15) {
    // Stakes at the corners, a string between them.
    const t = Math.max(1, Math.round(S * 0.7));
    for (const x of [x0, x1]) for (let y = base - t - 1; y <= base; y++) put(x, y, pole);
    if (S >= 3) for (let x = x0; x <= x1; x += 2) put(x, base - t, ledger);
  } else {
    // How high the scaffold stands, and how much of the building is up.
    const frameF = p < 0.35 ? (p - 0.15) / 0.2 : 1;
    const wallF = p < 0.35 ? 0 : Math.min(1, (p - 0.35) / 0.6);
    const cut = base - Math.round(h * wallF);
    if (wallF > 0) for (let y = Math.max(top, cut); y <= base; y++) {
      const age = (y - cut) / Math.max(1, S * 1.5);
      copyRow(y, wallF < 1 && age < 1 ? 0.2 * (1 - age) : 0);
    }
    if (p < 0.95) {
      const sTop = base - Math.round((h + 1) * frameF);
      const step = Math.max(3, S * 3);
      const xs: number[] = [];
      for (let x = x0 - 1; x < x1 + 1; x += step) xs.push(x);
      xs.push(x1 + 1);
      for (const x of xs) for (let y = sTop; y <= base; y++) {
        // Poles stand in front of the walls only at the sides and every few px.
        if (y >= cut && x > x0 && x < x1 && (x - x0) % (step * 2)) continue;
        put(x, y, pole);
      }
      for (let y = base - Math.max(2, S * 2); y >= sTop; y -= Math.max(2, S * 2)) {
        for (let x = x0 - 1; x <= x1 + 1; x++) if (y < cut || x === x0 - 1 || x === x1 + 1 || (x & 1)) put(x, y, ledger);
      }
    }
    // Dust at the foot while the walls go up (fewer as it finishes).
    const puffs = p < 0.95 ? Math.max(1, Math.round(span / Math.max(2, S))) : 1;
    for (let k = 0; k < puffs; k++) {
      if (hsh(k) > (p < 0.95 ? 0.7 : 0.3)) continue;
      const x = x0 - S + Math.floor(hsh(k + 50) * (span + 2 * S)), y = base - Math.floor(hsh(k + 90) * Math.max(2, S * 1.5));
      const c: RGB = [214, 196, 160];
      put(x, y, c);
      if (S >= 3) { put(x + 1, y, c); put(x, y - 1, [230, 216, 186]); }
    }
  }
  // A crane over industrial-era and later sites while the walls go up.
  if (crane && p >= 0.15 && p < 0.95) {
    const yellow: RGB = [232, 184, 46], dark: RGB = [150, 112, 24];
    const mx = x1 + 1 + Math.max(2, S);
    const mtop = Math.max(0, top - Math.max(3, S * 2));
    for (let y = mtop; y <= base; y++) put(mx, y, ((y - mtop) & 1) ? yellow : dark);
    for (let x = Math.max(0, x0 + Math.round(span * 0.2)); x <= Math.min(W - 1, mx + S); x++) put(x, mtop, yellow);
    const hx = x0 + Math.round(span * (0.3 + 0.4 * ((p * 7) % 1)));
    for (let y = mtop + 1; y < mtop + Math.max(2, Math.round((base - mtop) * 0.4)); y++) put(hx, y, dark);
  }
  return { width: W, height: H, data: out, footX: done.footX, footY: done.footY };
}
