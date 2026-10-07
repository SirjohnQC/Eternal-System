/**
 * GalaxyArt — the galaxy as a real star cloud, not a stretched 128 px blob.
 *
 * Two bakes per galaxy, in galaxy-local unit space (radius 1, the disc
 * face-on, because the simulation's systems orbit their galaxy on circles —
 * a squashed, tilted picture left them floating outside the drawn disc):
 *
 *  - HAZE (256², drawn smoothly filtered, like the suns' glows): the bulge's
 *    warm light, the bar, arms glowing in the galaxy's own colour, the faint
 *    disc, and dark dust lanes along the inner edge of each arm.
 *  - STARS (1024², drawn as crisp pixels when zoomed in): thousands of points
 *    sampled by population — old warm stars in the bulge and bar, young blue
 *    stars and pink star-forming knots in the arms, a mixed disc, a sparse
 *    halo with a few globular clusters. Bright giants get a small cross.
 *
 * Arms follow the same law the engine seeds its systems on
 * (theta = armAngle + ln(r) / pitch), so systems are born in the arms.
 *
 * Pure: RGBA arrays out, no DOM. Deterministic per galaxy.
 */
export type GalaxyMorphArt = 'spiral' | 'barred' | 'elliptical' | 'lenticular' | 'irregular';

export interface GalaxyShape {
  id: number;
  morph: GalaxyMorphArt;
  armCount: number;
  armPitch: number;
  barLength: number;
  /** Identity colour '#rrggbb' (labels, the arms' tint). */
  color: string;
}

export interface Raster { size: number; data: Uint8ClampedArray }

/** Half-extent of the bake in galaxy radii: the halo reaches past the disc. */
export const GALAXY_EXTENT = 1.1;
export const HAZE_RES = 256;
export const STARS_RES = 1024;

type RGB = [number, number, number];

function rng(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (R: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-9, R()))) * Math.cos(2 * Math.PI * R());
const hex = (h: string): RGB => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

const WARM: RGB = [255, 214, 160], OLD: RGB = [255, 180, 120], YOUNG: RGB = [170, 200, 255], BLUE: RGB = [130, 170, 255];
const PINK: RGB = [255, 130, 170], WHITE: RGB = [235, 238, 255], DUST: RGB = [40, 22, 18];

const spiralLike = (g: GalaxyShape) => (g.morph === 'spiral' || g.morph === 'barred') && g.armCount > 0;
/** Where the arms start: the bar's end, or just outside the bulge. */
const armStart = (g: GalaxyShape) => g.barLength > 0 ? Math.max(0.16, g.barLength) : 0.16;
const pitch = (g: GalaxyShape) => Math.max(0.12, g.armPitch);

/** The angle of arm `a` at radius r: the engine's log spiral, with a slight wobble of its own. */
function armTheta(g: GalaxyShape, a: number, r: number): number {
  // A barred spiral's arms leave from the bar's tips (the bar lies along u: angles 0 and pi).
  const phase = g.barLength > 0 ? -Math.log(Math.max(0.08, armStart(g))) / pitch(g) : 0;
  return a * (Math.PI * 2 / g.armCount) + phase + Math.log(Math.max(0.08, r)) / pitch(g)
    + 0.13 * Math.sin(r * 5.3 + a * 2.1 + g.id * 0.77) + 0.05 * Math.sin(r * 13.1 + a * 4.3);
}

/**
 * Signed angular offset (radians) from the nearest arm at (r, theta), in the
 * sense of increasing theta.
 */
function armOffset(g: GalaxyShape, r: number, theta: number): number {
  let best = 99;
  for (let a = 0; a < g.armCount; a++) {
    const arm = armTheta(g, a, r);
    let d = theta - arm;
    d = ((d % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    if (Math.abs(d) < Math.abs(best)) best = d;
  }
  return best;
}

/** Clumps along an arm: star-forming regions are knots, not a smooth tube. */
function clumpiness(g: GalaxyShape, r: number, th: number): number {
  const s = g.id * 0.913;
  return 0.55 + 0.45 * Math.sin(r * 21 + th * 1.3 + s) * Math.sin(r * 8.7 - th * 0.7 + s * 1.7);
}

/** The haze: soft light of the galaxy, dust lanes and all. */
export function bakeGalaxyHaze(g: GalaxyShape, res = HAZE_RES): Raster {
  const data = new Uint8ClampedArray(res * res * 4);
  const tint = mix(hex(g.color), YOUNG, 0.35);
  const R = rng(g.id * 7919 + 17);
  // Irregular galaxies: a few clumps, fixed per galaxy.
  const clumps = Array.from({ length: 5 }, () => ({ x: (R() - 0.5) * 1.1, y: (R() - 0.5) * 1.1, s: 0.12 + R() * 0.18, w: 0.5 + R() * 0.6 }));
  for (let py = 0; py < res; py++) for (let px = 0; px < res; px++) {
    const u = ((px + 0.5) / res * 2 - 1) * GALAXY_EXTENT, v = ((py + 0.5) / res * 2 - 1) * GALAXY_EXTENT;
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    let col: RGB = [0, 0, 0], a = 0;
    const add = (c: RGB, k: number) => { if (k <= 0) return; col = [col[0] + c[0] * k, col[1] + c[1] * k, col[2] + c[2] * k]; a += k; };
    const core = Math.exp(-((r / 0.075) ** 2)) + Math.exp(-((r / 0.2) ** 2)) * 0.32;
    if (g.morph === 'elliptical') {
      add(WARM, Math.exp(-6.5 * (Math.pow(Math.max(r, 1e-3) / 0.95, 0.5))) * 3.2 + core * 0.6);
    } else if (g.morph === 'lenticular') {
      add(WARM, core * 0.9 + Math.exp(-r / 0.26) * 0.42 * (1 - smooth(0.85, 1.02, r)));
      add(WHITE, Math.exp(-(((r - 0.62) / 0.05) ** 2)) * 0.1);            // a faint ring
    } else if (g.morph === 'irregular') {
      let k = 0;
      for (const c of clumps) k += c.w * Math.exp(-(((u - c.x) ** 2 + (v - c.y) ** 2) / (c.s * c.s)));
      add(tint, k * 0.26 * (1 - smooth(0.8, 1.05, r)));
      add(PINK, k > 0.9 ? (k - 0.9) * 0.2 : 0);
    } else {
      add(WARM, core);
      if (g.barLength > 0) {
        // A tapered, lens-shaped bar: brightest at the core, thinning to its tips.
        const t = Math.min(1, Math.abs(u) / g.barLength), half = 0.036 * (1 - 0.55 * t ** 4);
        add(WARM, Math.exp(-((v / half) ** 2)) * (1 - smooth(0.7, 1.08, Math.abs(u) / g.barLength)) * (0.55 - 0.25 * t));
      }
      add(WHITE, Math.exp(-r / 0.36) * 0.2 * (1 - smooth(0.85, 1.05, r)));
      if (spiralLike(g)) {
        const d = armOffset(g, r, th), w = 0.05 + 0.05 * r, dl = d * r;
        const reach = smooth(armStart(g) * 0.75, armStart(g) * 1.15, r) * (1 - smooth(0.78, 1.04, r));
        const arm = (Math.exp(-((dl / w) ** 2)) * 0.55 + Math.exp(-((dl / (w * 2.6)) ** 2)) * 0.27) * reach * clumpiness(g, r, th);
        add(tint, arm);
        // The dust lane: dark, just inside the arm (behind it as the pattern turns).
        const lane = Math.exp(-(((dl + w * 0.75) / (w * 0.35)) ** 2)) * reach;
        if (lane > 0.05) { const keep = 1 - 0.75 * lane; col = [col[0] * keep + DUST[0] * lane * 0.2, col[1] * keep + DUST[1] * lane * 0.2, col[2] * keep + DUST[2] * lane * 0.2]; a *= keep; }
      }
    }
    if (a <= 0.004) continue;
    const i = (py * res + px) * 4, A = Math.min(1, a);
    data[i] = col[0] / a; data[i + 1] = col[1] / a; data[i + 2] = col[2] / a; data[i + 3] = A * 255;
  }
  return { size: res, data };
}

/** The stars: thousands of points by population. */
export function bakeGalaxyStars(g: GalaxyShape, res = STARS_RES): Raster {
  const R = rng(g.id * 104729 + (g.morph.length * 31));
  const acc = new Float32Array(res * res * 3);
  const tint = hex(g.color);
  const plot = (u: number, v: number, c: RGB, b: number, cross = false) => {
    const x = Math.floor((u / GALAXY_EXTENT * 0.5 + 0.5) * res), y = Math.floor((v / GALAXY_EXTENT * 0.5 + 0.5) * res);
    const put = (px: number, py: number, k: number) => {
      if (px < 0 || py < 0 || px >= res || py >= res) return;
      const o = (py * res + px) * 3;
      acc[o] += c[0] * k; acc[o + 1] += c[1] * k; acc[o + 2] += c[2] * k;
    };
    put(x, y, b);
    if (cross) { put(x + 1, y, b * 0.4); put(x - 1, y, b * 0.4); put(x, y + 1, b * 0.4); put(x, y - 1, b * 0.4); }
  };
  const star = (u: number, v: number, base: RGB, bright: number, giantP = 0) => {
    const c = mix(base, tint, 0.12);
    const giant = R() < giantP;
    plot(u, v, c, giant ? 1.25 : bright * (0.35 + R() * 0.65), giant);
  };
  const polar = (r: number, t: number): [number, number] => [Math.cos(t) * r, Math.sin(t) * r];

  if (g.morph === 'elliptical') {
    for (let k = 0; k < 7000; k++) {
      const r = 0.95 * Math.pow(R(), 1.9), [u, v] = polar(r, R() * Math.PI * 2);
      star(u, v, mix(WARM, OLD, R()), 0.55 + 0.45 * (1 - r), 0.004);
    }
  } else if (g.morph === 'irregular') {
    const centres = Array.from({ length: 4 }, () => [(R() - 0.5) * 1.0, (R() - 0.5) * 1.0, 0.12 + R() * 0.2] as const);
    for (let k = 0; k < 7500; k++) {
      const [cx, cy, s] = centres[Math.floor(R() * centres.length)];
      star(cx + gauss(R) * s, cy + gauss(R) * s, R() < 0.6 ? YOUNG : WHITE, 1.1, 0.03);
    }
    for (let k = 0; k < 18; k++) { const [cx, cy, s] = centres[Math.floor(R() * centres.length)]; const kx = cx + gauss(R) * s, ky = cy + gauss(R) * s; for (let j = 0; j < 10; j++) star(kx + gauss(R) * 0.012, ky + gauss(R) * 0.012, PINK, 0.9); }
  } else {
    const n = 12000;
    for (let k = 0; k < n; k++) {
      const roll = R();
      if (roll < 0.15) {                                   // bulge: old, warm, dense
        const r = Math.abs(gauss(R)) * 0.075, [u, v] = polar(r, R() * Math.PI * 2);
        star(u, v, mix(WARM, OLD, R()), 1.1);
      } else if (g.barLength > 0 && roll < 0.23) {         // bar
        const bu = (R() * 2 - 1) * g.barLength, bt = Math.abs(bu) / g.barLength;
        star(bu, gauss(R) * 0.022 * (1 - 0.55 * bt ** 4), mix(WARM, WHITE, R() * 0.4), 0.8);
      } else if (spiralLike(g) && roll < 0.68) {           // arms: young, blue, bright
        const r = armStart(g) + (0.97 - armStart(g)) * Math.pow(R(), 0.85);
        const arm = armTheta(g, Math.floor(R() * g.armCount), r);
        const w = 0.045 + 0.06 * r, off = gauss(R) * w / Math.max(0.05, r);
        if (R() > clumpiness(g, r, arm + off)) { k--; continue; }   // denser in the knots
        const [u, v] = polar(r, arm + off);
        star(u, v, R() < 0.55 ? YOUNG : R() < 0.5 ? BLUE : WHITE, 1.3, 0.025);
      } else if (roll < 0.95) {                            // disc: mixed, dim
        const r = Math.min(1.0, -0.3 * Math.log(Math.max(1e-6, R()))), [u, v] = polar(r, R() * Math.PI * 2);
        star(u, v, mix(WHITE, WARM, R()), g.morph === 'lenticular' ? 0.75 : 0.7);
      } else {                                             // halo
        const r = 0.6 + R() * 0.5, [u, v] = polar(r, R() * Math.PI * 2);
        star(u, v, OLD, 0.3);
      }
    }
    // Star-forming knots along the arms.
    if (spiralLike(g)) for (let k = 0; k < 26; k++) {
      const r = armStart(g) + (0.92 - armStart(g)) * R();
      const arm = armTheta(g, Math.floor(R() * g.armCount), r);
      const [u, v] = polar(r, arm + gauss(R) * 0.02);
      for (let j = 0; j < 9; j++) star(u + gauss(R) * 0.01, v + gauss(R) * 0.01, PINK, 0.95);
    }
  }
  // Globular clusters in the halo (every kind has some).
  for (let k = 0; k < 7; k++) {
    const r = 0.55 + R() * 0.45, t = R() * Math.PI * 2, cx = Math.cos(t) * r, cy = Math.sin(t) * r;
    for (let j = 0; j < 16; j++) star(cx + gauss(R) * 0.008, cy + gauss(R) * 0.008, OLD, 0.7);
  }
  // Tone-map: soft knee so the dense core saturates warm-white, not into a flat blob.
  const data = new Uint8ClampedArray(res * res * 4);
  for (let i = 0, o = 0; i < acc.length; i += 3, o += 4) {
    const m = Math.max(acc[i], acc[i + 1], acc[i + 2]);
    if (m <= 0) continue;
    const k = (1 - Math.exp(-m / 255 * 1.6)) / (m / 255);
    data[o] = acc[i] * k; data[o + 1] = acc[i + 1] * k; data[o + 2] = acc[i + 2] * k;
    data[o + 3] = Math.min(255, Math.max(data[o], data[o + 1], data[o + 2]) * 1.15);
  }
  return { size: res, data };
}
