/**
 * CosmicPixelSprites — baked pixel-art stars, planets, and moons.
 *
 * Target look: mockup_planets.jpg — chunky 16-bit spheres, hard outlines,
 * banded shading, jagged sun corona (with glow rings), gas stripes + rings,
 * continents/clouds on ocean worlds. Nearest-neighbour blit only.
 */

import { paintSunBody, paintSunCorona, SUN_PALETTES } from './SunArt';

// ─── Colour helpers ───────────────────────────────────────────────────────────

type RGB = [number, number, number];

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function shade(c: RGB, amount: number): RGB {
  const cool: RGB = [c[0] * 0.42, c[1] * 0.4, Math.min(255, c[2] * 0.65 + 22)];
  return mix(c, cool, amount);
}

function hilite(c: RGB, amount: number): RGB {
  const warm: RGB = [
    Math.min(255, c[0] + 52),
    Math.min(255, c[1] + 36),
    Math.min(255, c[2] * 0.88 + 20),
  ];
  return mix(c, warm, amount);
}

/** Parse #rrggbb (or fallback). */
export function parseHexColor(hex: string, fallback: RGB): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Tiny deterministic hash → 0..n-1. */
export function variantIndex(seed: number, n: number): number {
  let x = (seed | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x >>> 0) % Math.max(1, n));
}

// ─── Star / planet kinds ──────────────────────────────────────────────────────

export type StarTempBand = 'blue' | 'white' | 'yellow' | 'orange' | 'red';

export function starTempBand(temperature: number): StarTempBand {
  if (temperature > 10000) return 'blue';
  if (temperature > 7500) return 'white';
  if (temperature > 5000) return 'yellow';
  if (temperature > 4000) return 'orange';
  return 'red';
}

export type PlanetKind =
  | 'rocky' | 'ocean' | 'gas' | 'ice' | 'lava'
  | 'toxic' | 'crystal' | 'desert' | 'storm' | 'carbon';

/** Palette families — pick by seed for more variety than a single midtone. */
const PLANET_PALETTES: Record<PlanetKind, RGB[]> = {
  rocky: [
    [170, 100, 70],
    [153, 119, 85],
    [130, 95, 70],
    [190, 130, 95],
    [110, 80, 65],
  ],
  ocean: [
    [34, 102, 170],
    [40, 120, 190],
    [25, 85, 145],
    [45, 140, 165],
    [55, 95, 160],
  ],
  gas: [
    [204, 150, 70],
    [180, 140, 90],
    [220, 170, 100],
    [160, 120, 70],
    [190, 155, 120],
  ],
  ice: [
    [170, 210, 240],
    [200, 230, 255],
    [150, 190, 220],
    [180, 220, 230],
  ],
  lava: [
    [255, 70, 35],
    [220, 55, 30],
    [255, 100, 40],
    [200, 45, 25],
  ],
  toxic: [
    [90, 180, 50],
    [70, 160, 40],
    [120, 200, 60],
    [50, 140, 35],
  ],
  crystal: [
    [160, 80, 200],
    [190, 100, 230],
    [130, 60, 180],
    [200, 140, 255],
  ],
  desert: [
    [210, 170, 90],
    [190, 150, 70],
    [230, 190, 110],
    [170, 130, 60],
  ],
  storm: [
    [70, 65, 95],
    [90, 80, 110],
    [50, 48, 70],
    [100, 90, 130],
  ],
  carbon: [
    [40, 42, 48],
    [55, 55, 60],
    [28, 28, 32],
    [70, 72, 78],
  ],
};

const LIFE_GREEN: RGB = [50, 160, 85];
const CLOUD: RGB = [230, 240, 255];

export type MoonKind = 'rock' | 'ice' | 'iron' | 'volcanic' | 'carbon' | 'ocean';

const MOON_BASE: Record<MoonKind, RGB> = {
  rock:     [185, 178, 166],
  ice:      [214, 236, 248],
  iron:     [140, 127, 120],
  volcanic: [201, 106, 68],
  carbon:   [76, 74, 82],
  ocean:    [95, 159, 208],
};

// ─── Pixel painters ───────────────────────────────────────────────────────────

function setPx(data: Uint8ClampedArray, size: number, x: number, y: number, c: RGB, a = 255): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = a;
}

function getA(data: Uint8ClampedArray, size: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= size || y >= size) return 0;
  return data[(y * size + x) * 4 + 3];
}

/**
 * Cell-shaded sphere. Light from upper-left (mockup: lit toward sun side).
 * When lightAngle is set, light comes from that world angle (radians).
 */
function paintSphere(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  R: number,
  ramp: RGB[],
  outline: RGB,
  opts: { dither?: boolean; lightAngle?: number } = {},
): void {
  const lx = opts.lightAngle != null ? Math.cos(opts.lightAngle) : -0.5;
  const ly = opts.lightAngle != null ? Math.sin(opts.lightAngle) : -0.55;

  const x0 = Math.max(0, Math.floor(cx - R - 1));
  const x1 = Math.min(w - 1, Math.ceil(cx + R + 1));
  const y0 = Math.max(0, Math.floor(cy - R - 1));
  const y1 = Math.min(h - 1, Math.ceil(cy + R + 1));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      const i = (y * w + x) * 4;

      if (d2 > R * R) continue;

      if (d2 > (R - 1.05) * (R - 1.05)) {
        data[i] = outline[0]; data[i + 1] = outline[1]; data[i + 2] = outline[2]; data[i + 3] = 255;
        continue;
      }

      const nx = dx / R, ny = dy / R;
      const ndz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      let lit = nx * lx + ny * ly + ndz * 0.65;
      lit = Math.max(0, Math.min(1, (lit + 0.12) / 1.12));

      let band = Math.min(ramp.length - 1, Math.floor(lit * ramp.length));
      if (lit > 0.84 && ramp.length > 2) band = ramp.length - 1;

      if (opts.dither && band < ramp.length - 1) {
        const frac = lit * ramp.length - band;
        const bayer = ((x & 1) ^ (y & 1)) ? 0.35 : 0.65;
        if (frac > bayer) band++;
      }

      const c = ramp[band];
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
}

function makeCanvas(w: number, h = w): { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D; img: ImageData } | null {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(w, h);
  return { cv, ctx, img };
}

function blankCanvas(w: number, h = w): HTMLCanvasElement {
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null!;
  if (cv) { cv.width = w; cv.height = h; }
  return cv;
}

// ─── Caches ───────────────────────────────────────────────────────────────────

const starCache = new Map<string, HTMLCanvasElement>();
const planetCache = new Map<string, HTMLCanvasElement>();
const moonCache = new Map<string, HTMLCanvasElement>();
const starGlowCache = new Map<string, HTMLCanvasElement>();
const orreryCache = new Map<string, HTMLCanvasElement>();

const STAR_GLOW_RGBA: Record<StarTempBand, string> = {
  blue:   '140,185,255',
  white:  '245,248,255',
  yellow: '255,215,90',
  orange: '255,155,60',
  red:    '255,95,50',
};

/** How each spectral class blooms and spins — used by Pixi/canvas animation. */
export interface StarVisualProfile {
  /** Soft glow diameter vs star sprite size. */
  glowMul: number;
  /** Base glow opacity (before pulse). */
  glowAlpha: number;
  /** Extra pulse amplitude on glow size/alpha. */
  pulseAmp: number;
  /** Pulse angular speed (animTick). */
  pulseSpeed: number;
  /** Corona rotation speed (radians per animTick). */
  coronaSpeed: number;
  /** Second outer haze multiplier (hotter = farther). */
  hazeMul: number;
  hazeAlpha: number;
}

export function starVisualProfile(band: StarTempBand): StarVisualProfile {
  switch (band) {
    case 'blue':
      return { glowMul: 2.65, glowAlpha: 0.95, pulseAmp: 0.035, pulseSpeed: 0.012,
        coronaSpeed: 0.0012, hazeMul: 3.4, hazeAlpha: 0.35 };
    case 'white':
      return { glowMul: 2.45, glowAlpha: 0.92, pulseAmp: 0.03, pulseSpeed: 0.010,
        coronaSpeed: 0.0010, hazeMul: 3.15, hazeAlpha: 0.30 };
    case 'yellow':
      return { glowMul: 2.35, glowAlpha: 0.90, pulseAmp: 0.028, pulseSpeed: 0.009,
        coronaSpeed: 0.0009, hazeMul: 3.0, hazeAlpha: 0.28 };
    case 'orange':
      return { glowMul: 2.55, glowAlpha: 0.88, pulseAmp: 0.025, pulseSpeed: 0.007,
        coronaSpeed: 0.00065, hazeMul: 3.3, hazeAlpha: 0.32 };
    case 'red':
    default:
      return { glowMul: 2.85, glowAlpha: 0.85, pulseAmp: 0.022, pulseSpeed: 0.006,
        coronaSpeed: 0.00045, hazeMul: 3.6, hazeAlpha: 0.38 };
  }
}

const coronaCache = new Map<string, HTMLCanvasElement>();

// ─── Star (body + animated corona + soft glow) ────────────────────────────────

/** Frames in the star body's boiling-surface loop (see {@link bakeStarBody}). */
export const STAR_BODY_FRAMES = 8;

/**
 * Pixel star body: limb-darkened disc with granulation and sunspots
 * (SunArt). Self-lit — no light direction. `frame` 0..STAR_BODY_FRAMES-1 walks
 * the granulation around a seamless loop. Corona is a separate layer so it
 * can rotate / pulse without re-baking the disc.
 */
export function bakeStarBody(band: StarTempBand, size = 48, frame = 0, seed = 5): HTMLCanvasElement {
  const f = ((frame % STAR_BODY_FRAMES) + STAR_BODY_FRAMES) % STAR_BODY_FRAMES;
  const key = `body|${band}|${size}|${f}|${seed}`;
  const hit = starCache.get(key);
  if (hit) return hit;

  const blank = blankCanvas(size);
  const pack = makeCanvas(size);
  if (!pack) return blank;

  const c = size / 2;
  paintSunBody(pack.img.data, size, size, c, c, size * 0.30, SUN_PALETTES[band],
    { seed, phase: f / STAR_BODY_FRAMES });

  pack.ctx.putImageData(pack.img, 0, 0);
  starCache.set(key, pack.cv);
  return pack.cv;
}

/** Corona: limb halo, tapered flame rays and prominences (SunArt). Rotated in-game. */
/**
 * Disc radius inside a corona canvas, as a fraction of its size. Draw the
 * corona sprite at body size x (0.30 / CORONA_BODY_FRAC) to line it up.
 */
export const CORONA_BODY_FRAC = 0.19;

export function bakeStarCorona(band: StarTempBand, size = 80, seed = 5): HTMLCanvasElement {
  const key = `corona|${band}|${size}|${seed}`;
  const hit = coronaCache.get(key);
  if (hit) return hit;

  const blank = blankCanvas(size);
  const pack = makeCanvas(size);
  if (!pack) return blank;

  // Body radius is CORONA_BODY_FRAC of the canvas: the rest is room for rays.
  const c = size / 2;
  const lenMul = band === 'red' ? 1.35 : band === 'blue' ? 1.3 : 1.2;
  paintSunCorona(pack.img.data, size, size, c, c, size * CORONA_BODY_FRAC, SUN_PALETTES[band],
    { seed, reach: lenMul });

  pack.ctx.putImageData(pack.img, 0, 0);
  coronaCache.set(key, pack.cv);
  return pack.cv;
}

/** @deprecated Prefer bakeStarBody + bakeStarCorona — kept for any stray callers. */
export function bakeStarSprite(band: StarTempBand, size = 48): HTMLCanvasElement {
  return bakeStarBody(band, size);
}

// ─── Planets ──────────────────────────────────────────────────────────────────

export interface PlanetBakeOpts {
  /** Canvas body resolution (square before rings). Default 24. */
  size?: number;
  /** Stable seed for palette / features. */
  seed?: number;
  /** Optional #rrggbb override tint. */
  colorHex?: string;
  /** Draw Saturn-style rings (gas). */
  rings?: boolean;
  hasLife?: boolean;
}

/** Bake a planet; gas with rings=true gets a wider canvas. */
export function bakePlanetSprite(
  kind: PlanetKind,
  hasLife = false,
  sizeOrOpts: number | PlanetBakeOpts = 24,
): HTMLCanvasElement {
  const opts: PlanetBakeOpts = typeof sizeOrOpts === 'number'
    ? { size: sizeOrOpts, hasLife }
    : { hasLife, ...sizeOrOpts };

  const bodySize = opts.size ?? 24;
  const seed = opts.seed ?? 0;
  const withRings = opts.rings ?? (kind === 'gas');
  const life = opts.hasLife ?? hasLife;

  const key = `p|${kind}|${life ? 1 : 0}|${bodySize}|${seed}|${withRings ? 1 : 0}|${opts.colorHex ?? ''}`;
  const hit = planetCache.get(key);
  if (hit) return hit;

  const w = withRings ? Math.round(bodySize * 1.85) : bodySize;
  const h = withRings ? Math.round(bodySize * 1.15) : bodySize;
  const blank = blankCanvas(w, h);
  const pack = makeCanvas(w, h);
  if (!pack) return blank;

  const palettes = PLANET_PALETTES[kind] ?? PLANET_PALETTES.rocky;
  let base = palettes[variantIndex(seed, palettes.length)];
  if (opts.colorHex) {
    base = mix(base, parseHexColor(opts.colorHex, base), 0.55);
  }
  if (life && kind !== 'lava') {
    base = mix(base, LIFE_GREEN, kind === 'ocean' ? 0.35 : 0.5);
  }

  const ramp: RGB[] = [
    shade(base, 0.82),
    shade(base, 0.48),
    base,
    hilite(base, 0.42),
    hilite(base, 0.72),
  ];
  if (kind === 'gas') ramp[4] = hilite(base, 0.3);
  const outline = shade(base, 0.92);

  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = bodySize / 2 - 1.2;

  // Rings behind body (far half)
  if (withRings) {
    paintRings(pack.img.data, w, h, cx, cy, R, base, seed, 'back');
  }

  paintSphere(pack.img.data, w, h, cx, cy, R, ramp, outline, {
    dither: kind === 'rocky' || kind === 'gas',
  });

  // Features
  if (kind === 'gas') {
    paintGasBands(pack.img.data, w, h, cx, cy, R, base, seed);
  } else if (kind === 'ocean' || kind === 'toxic' || life) {
    paintContinents(pack.img.data, w, h, cx, cy, R, life, seed);
  } else if (kind === 'rocky' || kind === 'lava' || kind === 'desert' || kind === 'carbon' || kind === 'storm') {
    paintCraters(pack.img.data, w, h, cx, cy, R, base, kind === 'lava', seed);
  } else if (kind === 'ice' || kind === 'crystal') {
    paintIceCracks(pack.img.data, w, h, cx, cy, R, base, seed);
  }

  // Rings in front (near half)
  if (withRings) {
    paintRings(pack.img.data, w, h, cx, cy, R, base, seed, 'front');
  }

  pack.ctx.putImageData(pack.img, 0, 0);
  planetCache.set(key, pack.cv);
  return pack.cv;
}

function paintGasBands(
  data: Uint8ClampedArray, w: number, h: number,
  cx: number, cy: number, R: number, base: RGB, seed: number,
): void {
  const dark = shade(base, 0.4);
  const light = hilite(base, 0.28);
  const spot = [180, 60, 45] as RGB;
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
    const bandOn = ((y + seed) >> 1) & 1;
    const col = bandOn ? dark : light;
    for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > R * R * 0.88) continue;
      const i = (y * w + x) * 4;
      if (data[i + 3] < 200) continue;
      data[i] = (data[i] * 0.5 + col[0] * 0.5) | 0;
      data[i + 1] = (data[i + 1] * 0.5 + col[1] * 0.5) | 0;
      data[i + 2] = (data[i + 2] * 0.5 + col[2] * 0.5) | 0;
    }
  }
  // Great Red Spot–style blotch
  const sx = Math.round(cx + R * 0.25);
  const sy = Math.round(cy + R * (0.1 + (seed % 5) * 0.05));
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -2; ox <= 2; ox++) {
      if (ox * ox + oy * oy * 2 > 5) continue;
      const i = ((sy + oy) * w + (sx + ox)) * 4;
      if (data[i + 3] > 200) {
        data[i] = spot[0]; data[i + 1] = spot[1]; data[i + 2] = spot[2];
      }
    }
  }
}

function paintContinents(
  data: Uint8ClampedArray, w: number, h: number,
  cx: number, cy: number, R: number, life: boolean, seed: number,
): void {
  const land = life ? shade(LIFE_GREEN, 0.15) : shade([90, 140, 70], 0.1);
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
    for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > R * R * 0.72) continue;
      const i = (y * w + x) * 4;
      if (data[i + 3] < 200) continue;
      // Blob continents from hash noise
      const n = ((x * 17 + y * 31 + seed * 13) ^ (x * y + seed)) & 15;
      if (n < 4 || n === 7) {
        data[i] = land[0]; data[i + 1] = land[1]; data[i + 2] = land[2];
      }
      // Cloud pixels
      if (((x + y * 3 + seed) & 11) === 0 && d2 < R * R * 0.55) {
        data[i] = CLOUD[0]; data[i + 1] = CLOUD[1]; data[i + 2] = CLOUD[2];
      }
    }
  }
}

function paintCraters(
  data: Uint8ClampedArray, w: number, h: number,
  cx: number, cy: number, R: number, base: RGB, lava: boolean, seed: number,
): void {
  const dark = shade(base, 0.55);
  const crack: RGB = [255, 210, 70];
  const craters = [
    [-0.3, -0.2], [0.25, 0.15], [-0.1, 0.35], [0.35, -0.25],
  ];
  for (let i = 0; i < craters.length; i++) {
    if ((seed + i) % 3 === 0 && i > 1) continue;
    const [ux, uy] = craters[i];
    const px = Math.round(cx + ux * R);
    const py = Math.round(cy + uy * R);
    const idx = (py * w + px) * 4;
    if (data[idx + 3] > 200) {
      data[idx] = dark[0]; data[idx + 1] = dark[1]; data[idx + 2] = dark[2];
      const idx2 = (py * w + px + 1) * 4;
      if (data[idx2 + 3] > 200) {
        data[idx2] = dark[0]; data[idx2 + 1] = dark[1]; data[idx2 + 2] = dark[2];
      }
    }
  }
  if (lava) {
    for (let y = Math.floor(cy - R * 0.6); y < cy + R * 0.6; y++) {
      const x = Math.round(cx - R * 0.3 + ((y * 3 + seed) % Math.max(1, Math.floor(R))));
      const i = (y * w + x) * 4;
      if (data[i + 3] > 200) {
        data[i] = crack[0]; data[i + 1] = crack[1]; data[i + 2] = crack[2];
      }
    }
  }
}

function paintIceCracks(
  data: Uint8ClampedArray, w: number, h: number,
  cx: number, cy: number, R: number, base: RGB, seed: number,
): void {
  const crack = hilite(base, 0.35);
  for (let s = 0; s < 8; s++) {
    const ang = (s / 8) * Math.PI + seed * 0.1;
    for (let t = 2; t < R * 0.7; t++) {
      const x = Math.round(cx + Math.cos(ang) * t);
      const y = Math.round(cy + Math.sin(ang) * t * 0.7);
      const i = (y * w + x) * 4;
      if (data[i + 3] > 200 && (t + seed) % 3 === 0) {
        data[i] = crack[0]; data[i + 1] = crack[1]; data[i + 2] = crack[2];
      }
    }
  }
}

/** Saturn-style tilted solid pixel rings. */
function paintRings(
  data: Uint8ClampedArray, w: number, h: number,
  cx: number, cy: number, R: number, base: RGB,
  seed: number,
  half: 'back' | 'front',
): void {
  const ringA = mix(hilite(base, 0.2), [200, 195, 180], 0.5);
  const ringB = mix(shade(base, 0.3), [160, 155, 145], 0.5);
  const tilt = 0.28 + (seed % 5) * 0.02;
  const rx = R * 1.65;
  const ry = R * tilt;

  for (let a = 0; a < Math.PI * 2; a += 0.04) {
    const sy = Math.sin(a);
    // back = upper half of ellipse (behind planet), front = lower
    if (half === 'back' && sy > 0.15) continue;
    if (half === 'front' && sy < -0.05) continue;

    for (const scale of [1.0, 1.12, 1.22]) {
      const x = Math.round(cx + Math.cos(a) * rx * scale);
      const y = Math.round(cy + sy * ry * scale);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      // Don't paint over the planet body on the front pass where it overlaps the disc
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < R * R * 0.92) continue;

      const i = (y * w + x) * 4;
      const col = (scale > 1.1) ? ringB : ringA;
      data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; data[i + 3] = 230;
    }
  }
}

// ─── Moons ────────────────────────────────────────────────────────────────────

export function bakeMoonSprite(kind: MoonKind, size = 8): HTMLCanvasElement {
  const key = `moon|${kind}|${size}`;
  const hit = moonCache.get(key);
  if (hit) return hit;

  const blank = blankCanvas(size);
  const pack = makeCanvas(size);
  if (!pack) return blank;

  const base = MOON_BASE[kind] ?? MOON_BASE.rock;
  const ramp: RGB[] = [
    shade(base, 0.7),
    base,
    hilite(base, 0.45),
  ];
  const outline = shade(base, 0.9);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  paintSphere(pack.img.data, size, size, cx, cy, size / 2 - 0.7, ramp, outline);

  pack.ctx.putImageData(pack.img, 0, 0);
  moonCache.set(key, pack.cv);
  return pack.cv;
}

/** Clear caches (new game / HMR). */
export function clearCosmicSpriteCaches(): void {
  starCache.clear();
  planetCache.clear();
  moonCache.clear();
  starGlowCache.clear();
  orreryCache.clear();
  coronaCache.clear();
}

/**
 * Wrap an equirectangular terrain bake (same as surface/diorama seed path) onto
 * a shaded disc for the solar-system orrery — close to the diorama look.
 */
export function wrapEquirectToGlobe(
  equirect: HTMLCanvasElement,
  size: number,
  opts: { rings?: boolean; ringTint?: RGB; seed?: number } = {},
): HTMLCanvasElement {
  const key = `orb|${equirect.width}x${equirect.height}|${size}|${opts.rings ? 1 : 0}|${opts.seed ?? 0}`;
  const hit = orreryCache.get(key);
  if (hit) return hit;

  const w = opts.rings ? Math.round(size * 1.85) : size;
  const h = opts.rings ? Math.round(size * 1.15) : size;
  const blank = blankCanvas(w, h);
  const pack = makeCanvas(w, h);
  if (!pack) return blank;

  const ew = equirect.width, eh = equirect.height;
  const ectx = equirect.getContext('2d');
  if (!ectx) return blank;
  const src = ectx.getImageData(0, 0, ew, eh).data;

  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = size / 2 - 1.2;
  const lx = -0.45, ly = -0.5;
  const outline: RGB = [20, 24, 36];
  const d = pack.img.data;

  if (opts.rings) {
    paintRings(d, w, h, cx, cy, R, opts.ringTint ?? [200, 190, 160], opts.seed ?? 0, 'back');
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > R * R) continue;
      const i = (y * w + x) * 4;

      if (d2 > (R - 1.0) * (R - 1.0)) {
        d[i] = outline[0]; d[i + 1] = outline[1]; d[i + 2] = outline[2]; d[i + 3] = 255;
        continue;
      }

      const nx = dx / R, ny = dy / R;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const lon = Math.atan2(nx, nz);
      const lat = Math.asin(Math.max(-1, Math.min(1, -ny)));
      let u = (lon / (Math.PI * 2) + 0.5) * ew;
      let v = (0.5 - lat / Math.PI) * eh;
      u = ((u % ew) + ew) % ew;
      v = Math.max(0, Math.min(eh - 1, v));
      const sx = u | 0, sy = v | 0;
      const si = (sy * ew + sx) * 4;
      let r = src[si], g = src[si + 1], b = src[si + 2];

      let lit = nx * lx + ny * ly + nz * 0.7;
      lit = Math.max(0.25, Math.min(1.15, lit));
      const shadeAmt = lit < 0.55 ? 0.55 : lit < 0.85 ? 0.85 : 1.1;
      r = Math.min(255, r * shadeAmt);
      g = Math.min(255, g * shadeAmt);
      b = Math.min(255, b * shadeAmt);

      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }

  if (opts.rings) {
    paintRings(d, w, h, cx, cy, R, opts.ringTint ?? [200, 190, 160], opts.seed ?? 0, 'front');
  }

  pack.ctx.putImageData(pack.img, 0, 0);
  orreryCache.set(key, pack.cv);
  return pack.cv;
}
export function bakeStarGlow(band: StarTempBand, size = 160): HTMLCanvasElement {
  const key = `glow|${band}|${size}`;
  const hit = starGlowCache.get(key);
  if (hit) return hit;

  const blank = blankCanvas(size);
  if (typeof document === 'undefined') return blank;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  if (!ctx) return blank;

  const cx = size / 2;
  const cy = size / 2;
  const rgb = STAR_GLOW_RGBA[band];
  const profile = starVisualProfile(band);

  // Hot core bloom
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.22);
  core.addColorStop(0,   `rgba(255,255,255,${band === 'red' ? 0.45 : 0.75})`);
  core.addColorStop(0.35, `rgba(${rgb},0.70)`);
  core.addColorStop(1,   `rgba(${rgb},0)`);
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);

  // Mid halo
  const mid = ctx.createRadialGradient(cx, cy, size * 0.08, cx, cy, size * 0.42);
  mid.addColorStop(0,   `rgba(${rgb},0.55)`);
  mid.addColorStop(0.45, `rgba(${rgb},0.22)`);
  mid.addColorStop(1,   `rgba(${rgb},0)`);
  ctx.fillStyle = mid;
  ctx.fillRect(0, 0, size, size);

  // Wide atmospheric haze (red giants / blue giants read farther)
  const haze = ctx.createRadialGradient(cx, cy, size * 0.2, cx, cy, size * 0.5);
  haze.addColorStop(0, `rgba(${rgb},${profile.hazeAlpha * 0.5})`);
  haze.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, size, size);

  starGlowCache.set(key, cv);
  return cv;
}

const softHazeCache = new Map<string, HTMLCanvasElement>();

/**
 * Soft linear-filtered nebula blot (NOT pixel art).
 * Used as atmospheric haze over system view — no hard disc edges.
 */
export function bakeSoftNebulaHaze(
  kind: 'bloom' | 'veil' | 'streak' = 'bloom',
  size = 256,
): HTMLCanvasElement {
  const key = `softhaze|${kind}|${size}`;
  const hit = softHazeCache.get(key);
  if (hit) return hit;

  const blank = blankCanvas(size);
  if (typeof document === 'undefined') return blank;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  if (!ctx) return blank;

  const cx = size / 2;
  const cy = size / 2;
  ctx.clearRect(0, 0, size, size);

  if (kind === 'veil') {
    // Wide soft falloff for full-frame color wash
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.28)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  } else if (kind === 'streak') {
    // Elongated arm-like mist
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.4);
    ctx.scale(1.55, 0.55);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.42);
    g.addColorStop(0, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else {
    // Organic bloom: layered soft blobs
    const blobs = [
      { x: 0, y: 0, r: 0.42, a: 0.5 },
      { x: 0.12, y: -0.08, r: 0.28, a: 0.35 },
      { x: -0.14, y: 0.1, r: 0.26, a: 0.3 },
      { x: 0.05, y: 0.14, r: 0.2, a: 0.25 },
    ];
    for (const b of blobs) {
      const bx = cx + b.x * size;
      const by = cy + b.y * size;
      const br = b.r * size;
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, `rgba(255,255,255,${b.a})`);
      g.addColorStop(0.45, `rgba(255,255,255,${b.a * 0.4})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
  }

  softHazeCache.set(key, cv);
  return cv;
}
