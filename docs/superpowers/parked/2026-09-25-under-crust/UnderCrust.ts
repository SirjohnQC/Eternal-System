/**
 * UnderCrust — the rock beneath the living board, and the hero rolled into it.
 *
 * Spec: docs/superpowers/specs/2026-09-24-under-crust-hero-design.md
 * Metric: tools/underCrustCheck.ts (runs the pre-hero painter as its control).
 *
 * The keel's SILHOUETTE is not decided here — `paintCutawayCrust` computes it
 * with its smoothing chain and hands over the per-column top and depth. This
 * module decides what is inside it:
 *
 *  - a 6-step quantised rock ramp per strata band, ordered-dithered with a 4x4
 *    Bayer matrix keyed to ABSOLUTE screen coordinates (so the pattern never
 *    shears at a column), with sheared facet cells instead of grain noise;
 *  - one or two heroes rolled from `genomeSeed` — a living core, geode caverns
 *    with interiors, or a circulatory vein network — whose emitters feed a
 *    light field that raises the rock's ramp step and tints it, so the light
 *    reaches the rock instead of sitting on it.
 *
 * Pure: no DOM, no state. Everything is a function of the inputs.
 */

export interface RGB { r: number; g: number; b: number }

export type UnderCrustHero = 'coreLit' | 'geode' | 'circulatory';
export const HEROES: readonly UnderCrustHero[] = ['coreLit', 'geode', 'circulatory'];

export interface UnderCrustRoll {
  heroes: UnderCrustHero[];
  hue: Partial<Record<UnderCrustHero, number>>;
  /** One hero took a hue from outside its family. */
  glitch: boolean;
}

// ─── Hashing ──────────────────────────────────────────────────────────────────

function hash(seed: number, salt: number): number {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(salt | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

class Rng {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 1; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let z = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + this.next() * (b - a); }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
}

// ─── The roll ─────────────────────────────────────────────────────────────────

/** Hue families per hero, as [lo, hi] degree ranges; one range is picked. */
const HUE_FAMILY: Record<UnderCrustHero, Array<[number, number]>> = {
  coreLit:     [[8, 48]],                                          // magma, ember, molten gold
  geode:       [[275, 320], [185, 215], [120, 150], [45, 60]],     // amethyst, sapphire, emerald, citrine
  circulatory: [[165, 200], [80, 110], [330, 355]],                // bioluminescent, toxic, blood
};

/**
 * Which heroes a world gets, and their hues. ~15% none, ~70% one, ~15% two.
 * Salted so it is independent of the terrain-archetype roll on the same seed.
 */
export function rollUnderCrust(genomeSeed: number): UnderCrustRoll {
  const s = genomeSeed | 0;
  const u = hash(s, 0x51ed27);
  const count = u < 0.15 ? 0 : u < 0.85 ? 1 : 2;
  const pool = [...HEROES];
  const heroes: UnderCrustHero[] = [];
  for (let k = 0; k < count; k++) {
    const i = Math.floor(hash(s, 0x2c1b + k * 97) * pool.length);
    heroes.push(pool.splice(i, 1)[0]);
  }
  const hue: Partial<Record<UnderCrustHero, number>> = {};
  const glitch = heroes.length > 0 && hash(s, 0x61c8) < 0.06;
  heroes.forEach((h, k) => {
    const fam = HUE_FAMILY[h];
    const [lo, hi] = fam[Math.floor(hash(s, 0x3a7 + k) * fam.length)];
    let deg = lo + hash(s, 0x4b9 + k) * (hi - lo);
    if (glitch && k === 0) deg = (deg + 120 + hash(s, 0x77) * 120) % 360;   // off-family
    hue[h] = deg;
  });
  return { heroes, hue, glitch };
}

// ─── Ramp and ordered dither ──────────────────────────────────────────────────

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** 4x4 Bayer threshold in [0,1) at an ABSOLUTE screen pixel. */
export function bayer4(x: number, y: number): number {
  return (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16;
}

/** Continuous level (0..5) → ramp step 0..5, ordered-dithered at (x, y). */
export function rampIndex(level: number, x: number, y: number): number {
  const i = Math.floor(level + bayer4(x, y) - 0.5);
  return i < 0 ? 0 : i > 5 ? 5 : i;
}

function rgbToHsv(c: RGB): [number, number, number] {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx === 0 ? 0 : d / mx, mx];
}
function hsv(h: number, s: number, v: number): RGB {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); v = Math.max(0, Math.min(1, v));
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
                  : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
function toward(h: number, target: number, amt: number): number {
  const d = ((target - h + 540) % 360) - 180;
  return Math.abs(d) < amt ? target : h + Math.sign(d) * amt;
}

const RAMP_V  = [0.40, 0.54, 0.68, 0.83, 1.00, 1.18];
const RAMP_H  = [[250, 14], [250, 8], [0, 0], [0, 0], [50, 6], [50, 12]] as const;
const RAMP_S  = [1.10, 1.05, 1.0, 1.0, 0.95, 0.85];

/** Six hue-shifted steps from one strata colour: cool shadows, warm lights. */
export function rockRamp(c: RGB): RGB[] {
  const [h, s, v] = rgbToHsv(c);
  return RAMP_V.map((f, k) => {
    const [t, a] = RAMP_H[k];
    return hsv(a ? toward(h, t, a) : h, s * RAMP_S[k], v * f);
  });
}

// ─── Keel fill ────────────────────────────────────────────────────────────────

export interface KeelInput {
  /** ImageData covering the keel's bounding box; written in place. */
  img: { data: Uint8ClampedArray; width: number; height: number };
  /** Screen coordinate of img's (0,0). */
  ox: number; oy: number;
  /** First keel column (screen x) and per-column top (screen y, float) and depth (px). */
  x0: number; top: Float32Array; depth: Float32Array;
  cx: number; rx: number; cyTop: number; ry: number;
  /** Absolute-Y strata band per pixel, as the legacy painter computed it. */
  bandAt: (x: number, absY: number) => { band: number; frac: number };
  strata: RGB[];
  ember: RGB; emberHot: RGB;
  seed: number;
  roll: UnderCrustRoll;
  /** Optional: 1 written for every emitter pixel (screen-sized, w*h). */
  emitOut?: Uint8Array | null; screenW?: number;
  cavernsOut?: Array<{ cx: number; cy: number; rx: number; ry: number }>;
}

/** A light: `rad` is the emitting body's radius, `reach` how far light travels past it. */
interface Source { x: number; y: number; rad: number; I: number; reach: number; col: RGB }

/**
 * Fill every keel pixel. Writes `img` in place.
 */
export function fillKeel(k: KeelInput): void {
  const { img, ox, oy, x0, top, depth, cx, rx, cyTop, ry, seed, roll } = k;
  const W = img.width, H = img.height, cols = top.length;
  const scale = rx / 105;                      // designed at the 480px render (rx 105)
  const rng = new Rng((seed ^ 0x9e3779b9) >>> 0);

  // ── Keel mask, in screen coordinates ────────────────────────────────────
  const inside = new Uint8Array(W * H);
  const yTop = new Int32Array(cols), yBot = new Int32Array(cols);
  for (let i = 0; i < cols; i++) {
    yTop[i] = Math.round(top[i]); yBot[i] = Math.round(top[i] + depth[i] - 1);
    if (depth[i] < 2) { yBot[i] = yTop[i] - 1; continue; }
    const x = x0 + i, dxn = (x - cx) / rx;
    for (let y = 0; y < depth[i]; y++) {
      const ay = Math.round(top[i] + y), fy = (top[i] + y - cyTop) / ry;
      if (dxn * dxn + fy * fy <= 1) continue;
      const lx = x - ox, ly = ay - oy;
      if (lx >= 0 && ly >= 0 && lx < W && ly < H) inside[ly * W + lx] = 1;
    }
  }

  // Distance to the outside of the keel (chamfer 1 / 1.414). Placement reads
  // it so heroes sit in the thick of the rock, not squeezed into a spike.
  const dist = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) dist[p] = inside[p] ? 1e6 : 0;
  for (let pass = 0; pass < 2; pass++) {
    const f = pass === 0;
    for (let yy = 0; yy < H; yy++) {
      const y = f ? yy : H - 1 - yy;
      for (let xx = 0; xx < W; xx++) {
        const x = f ? xx : W - 1 - xx, p = y * W + x;
        if (!inside[p]) continue;
        const s = f ? -1 : 1;
        const nx = x + s, ny = y + s;
        dist[p] = Math.min(dist[p],
          nx >= 0 && nx < W ? dist[y * W + nx] + 1 : 1,
          ny >= 0 && ny < H ? dist[ny * W + x] + 1 : 1,
          nx >= 0 && nx < W && ny >= 0 && ny < H ? dist[ny * W + nx] + 1.414 : 1.414,
          ny >= 0 && ny < H && x - s >= 0 && x - s < W ? dist[ny * W + x - s] + 1.414 : 1.414);
      }
    }
  }
  const dAt = (x: number, y: number) => {
    const lx = Math.floor(x) - ox, ly = Math.floor(y) - oy;
    return lx >= 0 && ly >= 0 && lx < W && ly < H ? dist[ly * W + lx] : 0;
  };

  const over = new Int32Array(W * H).fill(-1);      // packed RGB override, or -1
  const emit = new Uint8Array(W * H);
  const cavern = new Float32Array(W * H).fill(-2);  // normalised v inside a cavern, else -2
  const sources: Source[] = [];
  const setOver = (x: number, y: number, c: RGB, isEmit: boolean) => {
    const lx = Math.floor(x) - ox, ly = Math.floor(y) - oy;
    if (lx < 0 || ly < 0 || lx >= W || ly >= H || !inside[ly * W + lx]) return;
    over[ly * W + lx] = (c.r << 16) | (c.g << 8) | c.b; if (isEmit) emit[ly * W + lx] = 1;
  };
  const ellipseFits = (ex: number, ey: number, erx: number, ery: number, margin: number) => {
    for (let y = Math.floor(ey - ery); y <= ey + ery; y++) for (let x = Math.floor(ex - erx); x <= ex + erx; x++) {
      const e = ((x + 0.5 - ex) / erx) ** 2 + ((y + 0.5 - ey) / ery) ** 2;
      if (e <= 1 && dAt(x, y) < margin + 1) return false;
    }
    return true;
  };

  const heroes = roll.heroes;
  let root: { x: number; y: number } | null = null;

  // ── coreLit: a living core low in the thickest rock ─────────────────────
  if (heroes.includes('coreLit')) {
    const hue = roll.hue.coreLit ?? 28;
    let best = -1, bx = 0, by = 0;
    for (let ly = 0; ly < H; ly++) for (let lx = 0; lx < W; lx++) {
      const p = ly * W + lx; if (!inside[p]) continue;
      const sx = lx + ox, i = sx - x0; if (i < cols * 0.2 || i > cols * 0.8) continue;
      const low = (ly + oy - top[i]) / Math.max(1, depth[i]);
      const score = dist[p] + low * 6 * scale;          // thick first, then low
      if (score > best) { best = score; bx = sx + 0.5; by = ly + oy + 0.5; }
    }
    let crx = rx * rng.range(0.10, 0.14), cry = crx * rng.range(0.55, 0.7);
    for (let t = 0; t < 14 && !ellipseFits(bx, by, crx, cry, 3); t++) { crx *= 0.88; cry *= 0.88; }
    if (cry >= 1.5) {
      const hot = hsv(hue + 18, 0.28, 1.0), body = hsv(hue, 0.85, 0.98), rim = hsv(hue - 6, 0.95, 0.70);
      for (let y = Math.floor(by - cry); y <= by + cry; y++) for (let x = Math.floor(bx - crx); x <= bx + crx; x++) {
        const e = ((x + 0.5 - bx) / crx) ** 2 + ((y + 0.5 - by) / cry) ** 2;
        if (e > 1) continue;
        // Molten skin: the rim is broken by the Bayer pattern so it is not a ring.
        const c = e < 0.28 ? hot : e < 0.68 ? body : (bayer4(x, y) < 0.55 ? rim : body);
        setOver(x, y, c, true);
      }
      sources.push({ x: bx, y: by, rad: (crx + cry) / 2, I: 1.6, reach: rx * 0.40, col: body });
      root = { x: bx, y: by };
    }
  }

  // ── geode: caverns with interiors, lined with crystal ───────────────────
  const caverns: Array<{ cx: number; cy: number; rx: number; ry: number }> = [];
  if (heroes.includes('geode')) {
    const hue = roll.hue.geode ?? 290;
    const want = rng.int(3, 6);
    for (let tries = 0; tries < 160 && caverns.length < want; tries++) {
      const lx = rng.int(0, W - 1), ly = rng.int(0, H - 1), p = ly * W + lx;
      if (!inside[p] || dist[p] < 5 * scale) continue;
      const c = { cx: lx + ox + 0.5, cy: ly + oy + 0.5, rx: 0, ry: 0 };
      c.rx = Math.min(rng.range(6, 12) * scale, dist[p] * 1.9);
      c.ry = Math.min(c.rx * rng.range(0.55, 0.75), dist[p] - 2);
      if (c.ry < 2.5 || !ellipseFits(c.cx, c.cy, c.rx, c.ry, 2)) continue;
      let ok = true;
      for (const o of caverns) if (Math.hypot(o.cx - c.cx, (o.cy - c.cy) * 1.5) < o.rx + c.rx + 4) ok = false;
      if (root && Math.hypot((root.x - c.cx) * 0.8, root.y - c.cy) < c.rx + rx * 0.16) ok = false;
      if (ok) caverns.push(c);
    }
    const crystal = hsv(hue, 0.60, 0.88), tip = hsv(hue + 10, 0.22, 1.0), deep = hsv(hue - 8, 0.80, 0.58);
    for (const c of caverns) {
      for (let y = Math.floor(c.cy - c.ry); y <= c.cy + c.ry; y++) for (let x = Math.floor(c.cx - c.rx); x <= c.cx + c.rx; x++) {
        const e = ((x + 0.5 - c.cx) / c.rx) ** 2 + ((y + 0.5 - c.cy) / c.ry) ** 2;
        if (e > 1) continue;
        const lx = x - ox, ly = y - oy; if (lx < 0 || ly < 0 || lx >= W || ly >= H) continue;
        cavern[ly * W + lx] = (y + 0.5 - c.cy) / c.ry;
      }
      // Crystal teeth hanging from the roof and growing off the side walls,
      // pointing into the void; the floor stays clear so it reads as a floor.
      const n = Math.max(6, Math.round((c.rx + c.ry) * 1.3));
      for (let k2 = 0; k2 < n; k2++) {
        const a = Math.PI * (0.92 + (k2 / (n - 1)) * 1.16);   // left wall, over the roof, right wall
        if (rng.next() < 0.25) continue;
        const bx = c.cx + Math.cos(a) * (c.rx - 0.5), by = c.cy + Math.sin(a) * (c.ry - 0.5);
        const len = rng.int(1, Math.max(2, Math.round(3 * scale)));
        for (let s2 = 0; s2 < len; s2++) {
          const px = bx - Math.cos(a) * s2 * 0.9, py = by - Math.sin(a) * s2;
          setOver(px, py, s2 === len - 1 ? tip : s2 === 0 ? deep : crystal, true);
        }
        sources.push({ x: bx, y: by, rad: 0.5, I: 0.8, reach: 13 * scale, col: crystal });
      }
    }
  }
  const inCavern = (x: number, y: number, pad = 0) => caverns.some(c =>
    ((x + 0.5 - c.cx) / (c.rx + pad)) ** 2 + ((y + 0.5 - c.cy) / (c.ry + pad)) ** 2 <= 1);

  // ── circulatory: a branching vessel network through the thick rock ──────
  if (heroes.includes('circulatory')) {
    const hue = roll.hue.circulatory ?? 180;
    const bright = hsv(hue, 0.50, 1.0), fluid = hsv(hue, 0.85, 0.86), node = hsv(hue + 8, 0.30, 1.0);
    const wall = hsv(hue - 10, 0.70, 0.34);
    let start = root;
    if (!start) {
      let best = -1;
      for (let ly = 0; ly < H; ly++) for (let lx = 0; lx < W; lx++) {
        const p = ly * W + lx; if (!inside[p]) continue;
        const i = lx + ox - x0, low = (ly + oy - top[i]) / Math.max(1, depth[i]);
        if (inCavern(lx + ox, ly + oy, 3)) continue;               // never root inside a cavern
        const sc = dist[p] * (1 + low * 0.15) + hash(lx * 31 + ly * 17, seed + 5) * 2;   // thickest rock; low only breaks ties
        if (sc > best) { best = sc; start = { x: lx + ox + 0.5, y: ly + oy + 0.5 }; }
      }
    }
    let laid = 0;
    const lay = (x: number, y: number, c: RGB) => {
      setOver(x, y, c, true);
      if (++laid % 2 === 0) sources.push({ x, y, rad: 0, I: 0.5, reach: 16 * scale, col: fluid });
    };
    type Tip = { x: number; y: number; a: number; len: number; w: number };
    const queue: Tip[] = [];
    const trunks = rng.int(2, 3);
    for (let t = 0; t < trunks; t++) {
      queue.push({ x: start!.x, y: start!.y, a: -Math.PI / 2 + (t - (trunks - 1) / 2) * 1.1 + rng.range(-0.3, 0.3),
        len: Math.round(rng.range(34, 60) * scale), w: 2 });
    }
    let branches = 0; const maxBranches = rng.int(8, 14);
    while (queue.length) {
      const t = queue.shift()!;
      let { x, y, a } = t;
      for (let s = 0; s < t.len; s++) {
        // Of three headings, prefer the one deeper in rock: vessels follow the thick.
        let bestA = NaN, bestD = -1;
        for (const da of [-0.45, 0, 0.45]) {
          const aa = a + da + rng.range(-0.25, 0.25);
          const nx = x + Math.cos(aa), ny = y + Math.sin(aa);
          const dd = dAt(nx, ny) + (da === 0 ? 0.6 : 0) + rng.range(0, 0.8);
          if (dAt(nx, ny) >= 2 && !inCavern(Math.floor(nx), Math.floor(ny), 1.5) && dd > bestD) { bestD = dd; bestA = aa; }
        }
        if (Number.isNaN(bestA)) break;
        a = bestA * 0.7 + t.a * 0.3;
        x += Math.cos(a); y += Math.sin(a);
        lay(x, y, t.w > 1 ? bright : fluid);
        // Trunks: a bright lumen with a dark vessel wall beside it. The wall is
        // not an emitter; it gives the vessel a body instead of a 2px glow.
        if (t.w > 1 && over[(Math.floor(y) - oy) * W + Math.floor(x) + 1 - ox] < 0) setOver(x + 1, y, wall, false);
        if (branches < maxBranches && s > 5 && rng.next() < 0.09) {
          branches++;
          const side = rng.next() < 0.5 ? -1 : 1;
          queue.push({ x, y, a: a + side * rng.range(0.6, 1.25), len: Math.round(rng.range(10, 24) * scale), w: 1 });
          for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]) setOver(x + dx, y + dy, node, true);
        }
      }
    }
  }

  // ── Light field: bounded falloff, so halos end instead of washing out ───
  const L = new Float32Array(W * H);
  const LR = new Float32Array(W * H), LG = new Float32Array(W * H), LB = new Float32Array(W * H);
  for (const s of sources) {
    const R = s.rad + s.reach;
    const xa = Math.max(0, Math.floor(s.x - R - ox)), xb = Math.min(W - 1, Math.ceil(s.x + R - ox));
    const ya = Math.max(0, Math.floor(s.y - R - oy)), yb = Math.min(H - 1, Math.ceil(s.y + R - oy));
    for (let ly = ya; ly <= yb; ly++) for (let lx = xa; lx <= xb; lx++) {
      const i = ly * W + lx; if (!inside[i]) continue;
      const d = Math.max(0, Math.hypot(lx + ox + 0.5 - s.x, ly + oy + 0.5 - s.y) - s.rad);
      if (d >= s.reach) continue;
      const q = 1 - d / s.reach, v = s.I * q * q;
      L[i] += v; LR[i] += v * s.col.r; LG[i] += v * s.col.g; LB[i] += v * s.col.b;
    }
  }

  // ── Write ───────────────────────────────────────────────────────────────
  const ramps = k.strata.map(rockRamp);
  const d = img.data;
  for (let i = 0; i < cols; i++) {
    const x = x0 + i;
    if (depth[i] < 2) continue;
    const dxn = (x - cx) / rx;
    const lit = 0.55 + 0.62 * Math.max(0, Math.min(1, dxn * 0.9 + 0.45));
    for (let y = yTop[i]; y <= yBot[i]; y++) {
      const lx = x - ox, ly = y - oy;
      if (lx < 0 || ly < 0 || lx >= W || ly >= H || !inside[ly * W + lx]) continue;
      const p = ly * W + lx, o = p * 4;
      if (over[p] >= 0) {
        d[o] = over[p] >> 16; d[o + 1] = (over[p] >> 8) & 255; d[o + 2] = over[p] & 255; d[o + 3] = 255;
        if (emit[p] && k.emitOut && k.screenW) k.emitOut[y * k.screenW + x] = 1;
        continue;
      }
      const t = (y - top[i]) / depth[i];
      const ao = 1 - t * 0.26 - (y - yTop[i] < 3 ? (3 - (y - yTop[i])) / 3 : 0) * 0.28;
      // Facets: flat planes built from whole 4x4 dither blocks (3x2 blocks),
      // sheared one block per block-row into a staircase. Snapping facet edges
      // to the dither grid keeps each block's dither pure — an edge through a
      // block reads as noise, an edge along blocks reads as a fracture.
      const bxI = x >> 2, byI = y >> 2;
      const fx = Math.floor((bxI + byI) / 3), fy = Math.floor((byI + ((fx * 5) & 1)) / 2);
      const facet = 1 + (hash(fx * 131 + fy * 977, seed + 3) - 0.5) * 0.2;
      let f = lit * ao * facet;
      const { band, frac } = k.bandAt(x, y);
      if (frac < 0.07) f *= 0.72; else if (frac < 0.16) f *= 1.10;
      const Lp = L[p];
      // The underworld sits one step darker than the wall above it: it is in
      // the board's shadow, and it leaves the heroes headroom to light it.
      let level = (f - 0.40) / 0.78 * 5 - 1.0 + Math.min(3.2, Lp * 3.0);
      const cv = cavern[p];
      if (cv > -2) {
        // Interior: a floor ledge at the bottom, and a back wall that darkens
        // toward the roof. Light reaches it, but cannot lift it past mid-ramp.
        level = cv > 0.45 ? 2.3 + Math.min(1.6, Lp * 1.4) : 0.1 + (cv + 1) * 0.55 + Math.min(1.2, Lp * 0.9);
      }
      const ramp = ramps[Math.max(0, Math.min(ramps.length - 1, band))];
      let c = ramp[rampIndex(level, x, y)];
      if (Lp > 0.01) {
        // Tint toward the light's own colour in 0.15 steps, dithered like the
        // ramp so a halo has no contour rings.
        // Inside a cavern the back wall takes only a faint tint: it is in the
        // crystals' shadow side, and must stay darker than the lit floor.
        // Light shows as brightness first, colour second: a low, gently rising
        // tint, or overlapping sources saturate it into a flat coloured disc.
        const cap = cv > -2 && cv <= 0.45 ? 0.15 : 0.30;
        const tv = Math.min(cap, Lp * 0.20);
        const tt = Math.min(3, Math.floor(tv / 0.15 + bayer4(x, y))) * 0.15;
        if (tt > 0) {
          const inv = 1 / Lp;
          c = { r: c.r + (LR[p] * inv - c.r) * tt, g: c.g + (LG[p] * inv - c.g) * tt, b: c.b + (LB[p] * inv - c.b) * tt };
        }
      }
      // The underside edge: the last row drops to the darkest step, so the keel
      // reads as a solid mass against space. (Was two alpha-blended fills after
      // the fact, which put continuous colours on every column's tip.) The old
      // deep ember specks are gone: they were glowing pixels that lit nothing,
      // which is the exact thing the craft requirement rules out.
      if (y === yBot[i]) c = ramp[0];
      d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b; d[o + 3] = 255;
    }
  }
  if (k.cavernsOut) for (const c of caverns) k.cavernsOut.push({ ...c });
}

/**
 * A roll with the heroes pinned — for the preview harness and the metric, so a
 * specific hero can be looked at without hunting for a seed. Hues still come
 * from `genomeSeed`, exactly as a natural roll would give them.
 */
export function forcedRoll(genomeSeed: number, heroes: UnderCrustHero[]): UnderCrustRoll {
  const s = genomeSeed | 0;
  const hue: Partial<Record<UnderCrustHero, number>> = {};
  heroes.forEach((h, k) => {
    const fam = HUE_FAMILY[h];
    const [lo, hi] = fam[Math.floor(hash(s, 0x3a7 + k) * fam.length)];
    hue[h] = lo + hash(s, 0x4b9 + k) * (hi - lo);
  });
  return { heroes: [...heroes], hue, glitch: false };
}
