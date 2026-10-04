/**
 * Paints the sky layer: the orbit arc, the sibling planets with their phases,
 * and the sun, into a transparent ImageData drawn behind the diorama. Pure.
 *
 * Everything rides one elliptical track arching behind the body — the orbital
 * plane seen from the ground, so the track IS the orbit arc.
 */
import type { ImageDataLike } from '../weather/WeatherPainter';
import { wrapPi } from './OrbitSky';
import { farScale, isIdentity, type Camera } from '../ZoomCamera';
import { paintSunBody, paintSunCorona, SUN_PALETTES, sunBandOf, tintPalette, type RGB3 } from '../SunArt';

export interface SkyLayout {
  cx: number; horizonY: number; A: number; B: number; bloom: number;
  /**
   * Far scale this layout was transformed by (`farLayout`); the sun disc and
   * the sibling discs scale by it. Omitted = 1 (the identity view).
   */
  far?: number;
}

export function skyLayout(geom: { cx: number; cyTop: number; rx: number }, vw: number, vh: number): SkyLayout {
  return {
    cx: geom.cx,
    horizonY: geom.cyTop,
    A: Math.min(vw / 2 - 8, Math.max(1.25 * geom.rx, 0.42 * vw)),
    B: Math.max(8, geom.cyTop - 12),
    bloom: 0.42 * Math.min(vw, vh),
  };
}

/**
 * The sky seen through a zoom camera: a FAR layer, so it moves by
 * `farScale(zoom)` (a mild parallax), not by the zoom. `A`, `B` and `bloom`
 * scale by it and the track's centre maps about the camera focus:
 * x' = (x - fx) * s + VW/2. The identity camera returns `L` itself, so zoom 1
 * is exactly today's sky. `L` must come from the BASE geometry.
 */
export function farLayout(L: SkyLayout, cam: Camera, VW: number, VH: number): SkyLayout {
  if (isIdentity(cam, VW, VH)) return L;
  const s = farScale(cam.zoom);
  return {
    cx: (L.cx - cam.fx) * s + VW / 2,
    horizonY: (L.horizonY - cam.fy) * s + VH / 2,
    A: L.A * s, B: L.B * s, bloom: L.bloom * s, far: s,
  };
}

export const trackX = (az: number, L: SkyLayout): number => L.cx + Math.sin(az) * L.A;
export const trackY = (az: number, L: SkyLayout): number => L.horizonY - Math.cos(az) * L.B;

/**
 * The painter only rasterises the bright bloom CORE, t < BLOOM_CORE, so the
 * per-pixel loop stays a small box around the sun instead of scanning close
 * to the whole canvas. The wash — the whole glow's flat BASE level,
 * `WASH_ALPHA * fade` from the centre out to BLOOM_CORE, falling to 0 by
 * t = 1 — is drawn by the renderer as a canvas radial gradient instead
 * (`IsoDioramaRenderer.drawSunWash`); `bloom` in SkyLayout is that gradient's
 * full radius, only the painter's own loop is restricted to the core. The
 * painter's `bloomCoreAlpha` adds only the brightness ABOVE that base, so the
 * two composite into one continuous profile with no seam at BLOOM_CORE.
 */
export const BLOOM_CORE = 0.35;

/**
 * The wash's flat level from the centre out to BLOOM_CORE (see
 * `IsoDioramaRenderer.drawSunWash`), scaled by `fade` like everything else
 * here.
 */
export const WASH_ALPHA = 0.07;

/** t < 0.10: 0.55 -> 0.22; t < BLOOM_CORE: 0.22 -> 0.07; else 0 (the wash's job). */
function coreProfile(t: number): number {
  if (t >= BLOOM_CORE) return 0;
  return t < 0.10 ? 0.55 + (0.22 - 0.55) * (t / 0.10)
    : 0.22 + (0.07 - 0.22) * ((t - 0.10) / 0.25);
}

/**
 * The painter's own alpha at t, chosen so that compositing it OVER the
 * renderer's flat wash (alpha `WASH_ALPHA * fade` from the centre to
 * BLOOM_CORE) reproduces `coreProfile(t) * fade` exactly — not the wash's
 * alpha plus the painter's, which double-counted the core and left a seam at
 * t = BLOOM_CORE. Given two same-colour layers composited with the usual
 * `1 - (1-a)(1-w)`, solving for `a` at the target `p * fade` gives this.
 * Reaches 0 at t = BLOOM_CORE, so there is nothing left to seam.
 */
export function bloomCoreAlpha(t: number, fade: number): number {
  const w = WASH_ALPHA * fade;
  const a = (coreProfile(t) * fade - w) / (1 - w);
  return a < 0 ? 0 : a;
}

/**
 * Sun disc diameter in px at the home world's mean distance. Big enough to
 * carry the pixel-art face (limb bands, granulation, a spot) rather than a
 * white dot. Kepler distance scales it inside SUN_MIN..SUN_MAX.
 */
export const SUN_DIAMETER = 14;
export const SUN_MIN_DIAMETER = 10;
export const SUN_MAX_DIAMETER = 20;
export function sunDiameter(sizeScale: number): number {
  const d = SUN_DIAMETER * sizeScale;
  return d < SUN_MIN_DIAMETER ? SUN_MIN_DIAMETER : d > SUN_MAX_DIAMETER ? SUN_MAX_DIAMETER : d;
}

/**
 * The scale used for the bloom's radius, clamped to the same range as the sun
 * disc (`sunDiameter`'s implicit 0.8-1.6): bloom cost grows with sizeScale^2,
 * and an unclamped periapsis (home-world ~0.32 ms, over the 0.3 ms budget)
 * blew that up. The renderer's `drawSunWash` must use this SAME clamped scale
 * for its own radius, or the wash and the painter's core drift apart.
 */
export function bloomScale(sizeScale: number): number {
  return sizeScale < 0.8 ? 0.8 : sizeScale > 1.6 ? 1.6 : sizeScale;
}

export interface SkySiblingDraw { az: number; elev: number; litFraction: number; radiusPx: number; rgb: [number, number, number] }
export interface SkyDraw {
  sunAz: number; sunElev: number; sunSizeScale: number;
  sunRgb: [number, number, number];
  /** Star temperature (K): picks the sun's palette. Omitted: from `sunRgb` alone (yellow band). */
  sunTemperature?: number;
  /** Seconds, for the boiling surface and breathing corona. Omitted: still. */
  time?: number;
  /** Stable per-star seed for spots and ray layout. */
  sunSeed?: number;
  siblings: SkySiblingDraw[];
}

/** Source-over onto a straight-alpha layer. */
function over(d: Uint8ClampedArray, o: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  const da = d[o + 3] / 255, oa = a + da * (1 - a);
  d[o] = (r * a + d[o] * da * (1 - a)) / oa;
  d[o + 1] = (g * a + d[o + 1] * da * (1 - a)) / oa;
  d[o + 2] = (b * a + d[o + 2] * da * (1 - a)) / oa;
  d[o + 3] = oa >= 0.999 ? 255 : oa * 255;
}

const fadeOf = (elev: number) => (elev <= 0 ? 0 : elev >= 0.15 ? 1 : elev / 0.15);

export function paintSky(img: ImageDataLike, L: SkyLayout, sky: SkyDraw, opts: { fixedSunSize?: boolean } = {}): void {
  const d = img.data, W = img.width, H = img.height;
  const sunX = trackX(sky.sunAz, L), sunY = trackY(sky.sunAz, L), sunUp = sky.sunElev > 0;

  // Orbit arc: a dot every ~3 px, brighter within 0.3 rad of a risen sun.
  const step = 3 / Math.max(1, (L.A + L.B) / 2);
  for (let az = -Math.PI / 2; az <= Math.PI / 2; az += step) {
    const elev = Math.cos(az), f = fadeOf(elev);
    if (f === 0) continue;
    const near = sunUp && Math.abs(wrapPi(az - sky.sunAz)) < 0.3 ? 0.10 : 0;
    const x = Math.round(trackX(az, L)), y = Math.round(trackY(az, L));
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    over(d, (y * W + x) * 4, 200, 210, 240, (0.12 + near) * f);
  }

  // Siblings: phase from litFraction, lit side toward the sun on screen.
  for (const b of sky.siblings) {
    const f = fadeOf(b.elev);
    if (f === 0) continue;
    const bx = trackX(b.az, L), by = trackY(b.az, L), r = b.radiusPx;
    const side = sunX >= bx ? 1 : -1, edge = 1 - 2 * b.litFraction;
    for (let y = Math.floor(by - r); y <= Math.ceil(by + r); y++) {
      if (y < 0 || y >= H) continue;
      for (let x = Math.floor(bx - r); x <= Math.ceil(bx + r); x++) {
        if (x < 0 || x >= W) continue;
        const u = (x - bx) / r, v = (y - by) / r;
        if (u * u + v * v > 1) continue;
        const lit = u * side > edge * Math.sqrt(1 - v * v);
        const k = lit ? 1 : 0.25;
        over(d, (y * W + x) * 4, b.rgb[0] * k, b.rgb[1] * k, b.rgb[2] * k, 0.9 * f);
      }
    }
  }

  // The sun: bloom core (t < BLOOM_CORE; the outer wash beyond it is the
  // renderer's canvas radial gradient, not this loop), flare cross, then the
  // opaque core. `bloomCoreAlpha` draws only the brightness ABOVE the wash,
  // so painter-over-wash composites to the full target profile with no seam.
  if (!sunUp) return;
  const f = fadeOf(sky.sunElev), warm = sky.sunElev < 0.3 ? 1 - sky.sunElev / 0.3 : 0;
  const cr = sky.sunRgb[0] + (255 - sky.sunRgb[0]) * 0.5 * warm;
  const cg = sky.sunRgb[1] + (150 - sky.sunRgb[1]) * 0.5 * warm;
  const cb = sky.sunRgb[2] + (70 - sky.sunRgb[2]) * 0.5 * warm;
  const Rb = L.bloom * bloomScale(sky.sunSizeScale), RbCore = Rb * BLOOM_CORE, core2 = RbCore * RbCore;
  for (let y = Math.max(0, Math.floor(sunY - RbCore)); y <= Math.min(H - 1, Math.ceil(sunY + RbCore)); y++) {
    const dy = y - sunY, dy2 = dy * dy;
    for (let x = Math.max(0, Math.floor(sunX - RbCore)); x <= Math.min(W - 1, Math.ceil(sunX + RbCore)); x++) {
      const dx = x - sunX, d2 = dx * dx + dy2;
      if (d2 >= core2) continue;
      over(d, (y * W + x) * 4, cr, cg, cb, bloomCoreAlpha(Math.sqrt(d2) / Rb, f));
    }
  }
  // Far class: the disc (and with it the corona) grows by the far scale.
  const D = (opts.fixedSunSize ? SUN_DIAMETER : sunDiameter(sky.sunSizeScale)) * (L.far ?? 1), rad = D / 2;
  const band = sky.sunTemperature !== undefined ? sunBandOf(sky.sunTemperature) : 'yellow';
  // Low sun reddens: lean the palette toward the (warmed) sky tint.
  const pal = tintPalette(SUN_PALETTES[band], [cr, cg, cb] as RGB3, 0.5 * warm);
  const t = sky.time ?? 0, seed = sky.sunSeed ?? 7;
  const phase = ((t / 9) % 1 + 1) % 1;
  paintSunCorona(d, W, H, sunX, sunY, rad, pal, {
    seed, phase, spin: t * 0.05, reach: 1.1, alpha: f, prominences: rad >= 6,
  });
  paintSunBody(d, W, H, sunX, sunY, rad, pal, { seed, phase, alpha: f, spots: rad >= 5 });
}
