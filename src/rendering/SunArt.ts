/**
 * Procedural pixel-art sun, shared by the system view (baked Pixi sprites in
 * CosmicPixelSprites) and the planet view's sky (SkyPainter). Pure: writes
 * straight-alpha RGBA into a buffer, no DOM.
 *
 * A star is lit from INSIDE, so nothing here has a light direction. The disc is
 * radial limb darkening quantised into a five-step palette, broken up by
 * boiling granulation (a noise field walked around a loop, so `phase` 0..1
 * animates seamlessly), with a few sunspots. The corona is a ring of uneven
 * pixel rays plus limb prominences — drawn as a separate layer so callers can
 * spin and pulse it without re-baking the disc.
 */

export type RGB3 = readonly [number, number, number];

/** Five steps, rim → core. */
export type SunPalette = readonly [RGB3, RGB3, RGB3, RGB3, RGB3];

export type SunBand = 'blue' | 'white' | 'yellow' | 'orange' | 'red';

export const SUN_PALETTES: Record<SunBand, SunPalette> = {
  blue:   [[38, 62, 160], [74, 122, 226], [134, 180, 255], [198, 222, 255], [246, 250, 255]],
  white:  [[132, 140, 190], [190, 200, 232], [226, 232, 250], [244, 247, 255], [255, 255, 255]],
  yellow: [[214, 112, 28], [248, 168, 48], [255, 212, 88], [255, 238, 158], [255, 252, 230]],
  orange: [[160, 52, 18], [222, 98, 30], [250, 146, 56], [255, 192, 108], [255, 232, 188]],
  red:    [[110, 22, 18], [172, 42, 28], [222, 76, 42], [250, 126, 76], [255, 186, 146]],
};

/** Band for a black-body temperature (K). Same cut points as the system view. */
export function sunBandOf(temperature: number): SunBand {
  if (temperature > 10000) return 'blue';
  if (temperature > 7500) return 'white';
  if (temperature > 5000) return 'yellow';
  if (temperature > 4000) return 'orange';
  return 'red';
}

/**
 * Palette nudged toward an arbitrary tint (the sky passes the star's own
 * black-body colour, warmed at sunrise). `t` 0 = band palette unchanged.
 */
export function tintPalette(p: SunPalette, rgb: RGB3, t: number): SunPalette {
  if (t <= 0) return p;
  const m = (c: RGB3, k: number): RGB3 => [
    c[0] + (rgb[0] - c[0]) * k, c[1] + (rgb[1] - c[1]) * k, c[2] + (rgb[2] - c[2]) * k,
  ];
  // The white-hot core keeps most of its heat; the rim takes the tint.
  return [m(p[0], t), m(p[1], t), m(p[2], t * 0.8), m(p[3], t * 0.5), m(p[4], t * 0.2)];
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16 - 0.5);

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  const top = a + (b - a) * ux, bot = c + (d - c) * ux;
  return top + (bot - top) * uy;
}

/** Source-over onto a straight-alpha buffer. */
function over(d: Uint8ClampedArray, o: number, c: RGB3, a: number): void {
  if (a <= 0) return;
  if (a >= 1) { d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; return; }
  const da = d[o + 3] / 255, oa = a + da * (1 - a);
  d[o] = (c[0] * a + d[o] * da * (1 - a)) / oa;
  d[o + 1] = (c[1] * a + d[o + 1] * da * (1 - a)) / oa;
  d[o + 2] = (c[2] * a + d[o + 2] * da * (1 - a)) / oa;
  d[o + 3] = oa >= 0.999 ? 255 : oa * 255;
}

export interface SunBodyOpts {
  /** Stable per-star seed: spots and granulation layout. */
  seed: number;
  /** Animation phase 0..1; loops seamlessly. */
  phase?: number;
  /** Overall opacity (sunset fade). 1 = the disc is fully opaque. */
  alpha?: number;
  /** Sunspots on (off for tiny discs where one would read as a hole). */
  spots?: boolean;
}

/**
 * Disc of radius `R` px centred on (cx, cy). Every pixel inside is written
 * opaque (times `alpha`) so a caller measuring the disc sees its full size.
 */
export function paintSunBody(
  d: Uint8ClampedArray, W: number, H: number,
  cx: number, cy: number, R: number, pal: SunPalette, opts: SunBodyOpts,
): void {
  const { seed } = opts;
  const phase = (opts.phase ?? 0) * Math.PI * 2;
  const alpha = opts.alpha ?? 1;
  // Granule size tracks the disc: ~5 cells across whatever the pixel size.
  const f = 5 / Math.max(2, 2 * R);
  const ox = Math.cos(phase) * 1.3, oy = Math.sin(phase) * 1.3;
  const ox2 = Math.cos(phase + 2.1) * 0.9, oy2 = Math.sin(phase + 2.1) * 0.9;
  const spots: Array<[number, number, number]> = [];
  if (opts.spots !== false && R >= 5) {
    const n = 1 + Math.floor(hash2(seed, 7, 3) * 2.99);
    for (let i = 0; i < n; i++) {
      const a = hash2(seed, i, 11) * Math.PI * 2, rr = 0.2 + hash2(seed, i, 13) * 0.45;
      // Spots drift across the face with the phase, like rotation.
      const drift = (opts.phase ?? 0) * 0.25;
      spots.push([Math.cos(a + drift) * rr * R, Math.sin(a) * rr * R * 0.8, Math.max(0.9, R * (0.08 + hash2(seed, i, 17) * 0.06))]);
    }
  }
  const x0 = Math.max(0, Math.floor(cx - R - 1)), x1 = Math.min(W - 1, Math.ceil(cx + R + 1));
  const y0 = Math.max(0, Math.floor(cy - R - 1)), y1 = Math.min(H - 1, Math.ceil(cy + R + 1));
  const R2 = R * R;
  // Small discs are mostly rim: lift them so they still read as hot.
  const bias = R < 9 ? 1.1 : 0.85;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r2 = dx * dx + dy * dy;
      if (r2 > R2) continue;
      const r = Math.sqrt(r2) / R;
      const mu = Math.sqrt(Math.max(0, 1 - r * r));
      const g = vnoise(dx * f + ox + 40, dy * f + oy + 40, seed)
              + 0.5 * vnoise(dx * f * 2.3 + ox2 + 90, dy * f * 2.3 + oy2 + 90, seed + 1);
      let level = bias + mu * 3.6 + (g / 1.5 - 0.5) * 1.15 * (0.4 + mu)
                + BAYER4[((y & 3) << 2) | (x & 3)] * 0.55;
      // Hard 1-px rim one step down from the limb: the outline that makes it
      // a sprite, without the dark ring that reads as a planet's shadow.
      if (Math.sqrt(r2) > R - 1) level = Math.min(level, 1.5);
      let idx = level < 1 ? 0 : level > 4 ? 4 : Math.floor(level);
      for (const [sx, sy, sr] of spots) {
        const q = Math.hypot(dx - sx, dy - sy);
        if (q < sr * 0.55) { idx = 0; break; }
        if (q < sr) idx = Math.min(idx, 1);
      }
      over(d, (y * W + x) * 4, pal[idx], alpha);
    }
  }
}

export interface SunCoronaOpts {
  seed: number;
  /** 0..1, loops: ray lengths breathe and prominences rise and fall. */
  phase?: number;
  /** Rotation of the ray pattern, radians. */
  spin?: number;
  /** How far the longest ray reaches, as a multiple of R (default 0.9). */
  reach?: number;
  /** Number of rays (default by size). */
  rays?: number;
  alpha?: number;
  /** Limb prominences (skip on small suns). */
  prominences?: boolean;
}

/**
 * Corona around a disc of radius `R`: a dithered halo hugging the limb,
 * uneven tapered rays, and a few prominence loops. Never fully opaque, so the
 * body painted over it stays the only opaque disc.
 */
export function paintSunCorona(
  d: Uint8ClampedArray, W: number, H: number,
  cx: number, cy: number, R: number, pal: SunPalette, opts: SunCoronaOpts,
): void {
  const { seed } = opts;
  const phase = (opts.phase ?? 0) * Math.PI * 2;
  const spin = opts.spin ?? 0;
  const alpha = opts.alpha ?? 1;
  const reach = (opts.reach ?? 0.9) * R;
  const n = opts.rays ?? Math.max(8, Math.min(14, Math.round(R * 0.8)));
  const put = (x: number, y: number, c: RGB3, a: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const o = (yi * W + xi) * 4, was = d[o + 3];
    over(d, o, c, Math.min(0.95, a * alpha));
    // Stacked strokes must not add up to opaque: the body is the only opaque disc.
    if (d[o + 3] === 255 && was !== 255) d[o + 3] = 247;
  };

  // Halo: two dithered rings just outside the limb.
  const outer = R + Math.max(1.5, R * 0.22);
  const x0 = Math.max(0, Math.floor(cx - outer - 1)), x1 = Math.min(W - 1, Math.ceil(cx + outer + 1));
  const y0 = Math.max(0, Math.floor(cy - outer - 1)), y1 = Math.min(H - 1, Math.ceil(cy + outer + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const q = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (q <= R || q > outer) continue;
      const t = (q - R) / (outer - R);
      const b = BAYER4[((y & 3) << 2) | (x & 3)] + 0.5;
      if (t < 0.45) put(x, y, pal[3], 0.75);
      else if (b > t * 1.1 - 0.1) put(x, y, pal[2], 0.5 * (1 - t));
    }
  }

  // Outer glow: sparse dither falling off to ~1.7 R — light, not a ring.
  const glowR = R + Math.max(3, R * 0.7);
  const gx0 = Math.max(0, Math.floor(cx - glowR)), gx1 = Math.min(W - 1, Math.ceil(cx + glowR));
  const gy0 = Math.max(0, Math.floor(cy - glowR)), gy1 = Math.min(H - 1, Math.ceil(cy + glowR));
  for (let y = gy0; y <= gy1; y++) {
    for (let x = gx0; x <= gx1; x++) {
      const q = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (q <= outer || q > glowR) continue;
      const t = (q - outer) / (glowR - outer);
      if (BAYER4[((y & 3) << 2) | (x & 3)] + 0.5 > (1 - t) * 0.55) continue;
      put(x, y, pal[2], 0.35 * (1 - t));
    }
  }

  // Rays: tapered flame tongues, long and short alternating, each breathing
  // on its own clock. Width at the root ~R/5, down to a 1-px tip.
  const rootW = Math.max(1, R * 0.2);
  for (let i = 0; i < n; i++) {
    const h = hash2(seed, i, 29);
    const ang = spin + (i + (h - 0.5) * 0.4) / n * Math.PI * 2;
    const long = i % 2 === 0;
    const breathe = 0.72 + 0.28 * Math.sin(phase + h * 6.283);
    const len = (long ? 0.6 + h * 0.4 : 0.3 + h * 0.25) * reach * breathe;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const steps = Math.ceil(len * 1.5);
    for (let s = 0; s <= steps; s++) {
      const u = s / Math.max(1, steps);
      const rr = R - 0.5 + u * len;
      const x = cx + ca * rr, y = cy + sa * rr;
      const c = u < 0.3 ? pal[4] : u < 0.65 ? pal[3] : pal[2];
      const a = 0.92 * (1 - u * 0.6);
      const hw = (long ? rootW : rootW * 0.6) * (1 - u);
      put(x, y, c, a);
      for (let k = 1; k <= Math.floor(hw + 0.35); k++) {
        const edge = k >= hw - 0.4 ? pal[2] : c;
        put(x - sa * k, y + ca * k, edge, a * 0.85);
        put(x + sa * k, y - ca * k, edge, a * 0.85);
      }
    }
  }

  // Prominences: small arches of plasma standing on the limb.
  if (opts.prominences !== false && R >= 6) {
    const m = 2 + Math.floor(hash2(seed, 3, 41) * 2);
    for (let i = 0; i < m; i++) {
      const base = hash2(seed, i, 43) * Math.PI * 2 + spin * 0.3;
      const span = 0.18 + hash2(seed, i, 47) * 0.2;
      const rise = Math.max(1.5, R * (0.18 + 0.12 * hash2(seed, i, 53)))
                 * (0.7 + 0.3 * Math.sin(phase * 1 + i * 2.2));
      const steps = Math.ceil(R * span * 4 + 6);
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const a = base - span / 2 + span * u;
        const rr = R + Math.sin(u * Math.PI) * rise;
        put(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, s & 1 ? pal[2] : pal[3], 0.85);
      }
    }
  }
}
