/**
 * Paints the sky layer: the orbit arc, the sibling planets with their phases,
 * and the sun, into a transparent ImageData drawn behind the diorama. Pure.
 *
 * Everything rides one elliptical track arching behind the body — the orbital
 * plane seen from the ground, so the track IS the orbit arc.
 */
import type { ImageDataLike } from '../weather/WeatherPainter';
import { wrapPi } from './OrbitSky';

export interface SkyLayout { cx: number; horizonY: number; A: number; B: number; bloom: number }

export function skyLayout(geom: { cx: number; cyTop: number; rx: number }, vw: number, vh: number): SkyLayout {
  return {
    cx: geom.cx,
    horizonY: geom.cyTop,
    A: Math.min(vw / 2 - 8, Math.max(1.25 * geom.rx, 0.42 * vw)),
    B: Math.max(8, geom.cyTop - 12),
    bloom: 0.42 * Math.min(vw, vh),
  };
}

export const trackX = (az: number, L: SkyLayout): number => L.cx + Math.sin(az) * L.A;
export const trackY = (az: number, L: SkyLayout): number => L.horizonY - Math.cos(az) * L.B;

/**
 * The painter only rasterises the bright bloom CORE, t < BLOOM_CORE, so the
 * per-pixel loop stays a small box around the sun instead of scanning close
 * to the whole canvas. The faint outer wash beyond it (t in [BLOOM_CORE, 1),
 * alpha fading 0.07 -> 0) is drawn by the renderer as a canvas radial
 * gradient instead — `bloom` in SkyLayout is still that gradient's full
 * radius, only the painter's own loop is restricted.
 */
export const BLOOM_CORE = 0.35;

export const SUN_DIAMETER = 5;
export function sunDiameter(sizeScale: number): number {
  const d = SUN_DIAMETER * sizeScale;
  return d < 4 ? 4 : d > 8 ? 8 : d;
}

export interface SkySiblingDraw { az: number; elev: number; litFraction: number; radiusPx: number; rgb: [number, number, number] }
export interface SkyDraw {
  sunAz: number; sunElev: number; sunSizeScale: number;
  sunRgb: [number, number, number];
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
  // opaque core.
  if (!sunUp) return;
  const f = fadeOf(sky.sunElev), warm = sky.sunElev < 0.3 ? 1 - sky.sunElev / 0.3 : 0;
  const cr = sky.sunRgb[0] + (255 - sky.sunRgb[0]) * 0.5 * warm;
  const cg = sky.sunRgb[1] + (150 - sky.sunRgb[1]) * 0.5 * warm;
  const cb = sky.sunRgb[2] + (70 - sky.sunRgb[2]) * 0.5 * warm;
  const Rb = L.bloom * sky.sunSizeScale, RbCore = Rb * BLOOM_CORE;
  for (let y = Math.max(0, Math.floor(sunY - RbCore)); y <= Math.min(H - 1, Math.ceil(sunY + RbCore)); y++) {
    for (let x = Math.max(0, Math.floor(sunX - RbCore)); x <= Math.min(W - 1, Math.ceil(sunX + RbCore)); x++) {
      const t = Math.hypot(x - sunX, y - sunY) / Rb;
      if (t >= BLOOM_CORE) continue;
      const a = t < 0.10 ? 0.55 + (0.22 - 0.55) * (t / 0.10)
        : 0.22 + (0.07 - 0.22) * ((t - 0.10) / 0.25);
      over(d, (y * W + x) * 4, cr, cg, cb, a * f);
    }
  }
  const D = opts.fixedSunSize ? SUN_DIAMETER : sunDiameter(sky.sunSizeScale), rad = D / 2;
  const arm = Math.round(6 + D);
  for (let k = -arm; k <= arm; k++) {
    const xs = Math.round(sunX) + k, ys = Math.round(sunY) + k;
    if (xs >= 0 && xs < W && sunY >= 0 && sunY < H) over(d, (Math.round(sunY) * W + xs) * 4, cr, cg, cb, 0.35 * f);
    if (ys >= 0 && ys < H && sunX >= 0 && sunX < W) over(d, (ys * W + Math.round(sunX)) * 4, cr, cg, cb, 0.35 * f);
  }
  for (let y = Math.floor(sunY - rad); y <= Math.ceil(sunY + rad); y++) {
    if (y < 0 || y >= H) continue;
    for (let x = Math.floor(sunX - rad); x <= Math.ceil(sunX + rad); x++) {
      if (x < 0 || x >= W) continue;
      if ((x + 0.5 - sunX) ** 2 + (y + 0.5 - sunY) ** 2 > rad * rad) continue;
      over(d, (y * W + x) * 4, 255 + (cr - 255) * 0.25, 255 + (cg - 255) * 0.25, 255 + (cb - 255) * 0.25, f);
    }
  }
}
