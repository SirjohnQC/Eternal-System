/**
 * The space backdrop: gradient, nebula band and stars, baked once per size
 * as a panorama PANORAMA_SCREENS wide that tiles in x, so it can slide one
 * full width per year with no seam. Pure pixel ops, no canvas.
 *
 * The pre-2026-09-28 bake (kept as `periodic: false`, the check's control)
 * used a diagonal gradient and a straight rotated band: neither tiles.
 */
import type { ImageDataLike } from '../weather/WeatherPainter';

export const PANORAMA_SCREENS = 3;
const TAU = Math.PI * 2;

export function backdropWidth(vw: number): number {
  return Math.round(vw) * PANORAMA_SCREENS;
}

/** Panorama x shown at screen x = 0. Rises with the sun's longitude: the panorama moves left. */
export function backdropOffset(sunLongitude: number, W: number): number {
  const f = ((sunLongitude / TAU) % 1 + 1) % 1;
  return Math.round(f * W) % W;
}

function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blend(d: Uint8ClampedArray, o: number, r: number, g: number, b: number, a: number): void {
  d[o] = d[o] + (r - d[o]) * a;
  d[o + 1] = d[o + 1] + (g - d[o + 1]) * a;
  d[o + 2] = d[o + 2] + (b - d[o + 2]) * a;
}

/**
 * Bake the panorama. `scale` (a zoom camera's `farScale`) re-bakes the SAME
 * backdrop seen through the far transform: `img` is then
 * `round(backdropWidth(vw) * scale)` wide and `VH` tall, feature sizes and
 * spacing (gradient span, nebula line and blobs, star spacing) are x scale,
 * vertically about `fy` (the camera focus, base px; default the canvas
 * centre), and every star stays a 1-px point with 1-px cross arms. Omitted or
 * 1: today's bake, untouched.
 *
 * Far bake with vertical overscan (spec 5b): `vh` is the view height the
 * panorama belongs to (default `img.height`) and `oy` the image row of view
 * row 0, so a taller image holds the rows above and below the view that a
 * vertical pan brings in: view row y is image row y + oy.
 */
export function bakeBackdrop(
  img: ImageDataLike, opts: { seed: number; vw: number; periodic?: boolean; scale?: number; fy?: number; vh?: number; oy?: number },
): void {
  if (opts.scale !== undefined && opts.scale !== 1) {
    bakeBackdropFar(img, opts.seed, opts.vw, opts.scale, opts.fy, opts.vh, opts.oy);
    return;
  }
  const periodic = opts.periodic ?? true;
  const W = img.width, H = img.height, d = img.data, vw = opts.vw;
  const s = rng(opts.seed);

  // Gradient. Periodic: vertical only (#080a1c -> #050614 at 55% -> #02030c).
  // Old: the diagonal createLinearGradient(0, 0, 0.4 vw, vh).
  // Colour stops hoisted out of the per-pixel loop: picking between the two
  // pre-built arrays below allocates nothing, where `[8, 10, 28, ...]` written
  // inline in the loop allocated a fresh array every pixel.
  const STOP_A = [8, 10, 28, 5, 6, 20], STOP_B = [5, 6, 20, 2, 3, 12];
  const gx = 0.4 * vw, gLen2 = gx * gx + H * H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let t = periodic ? y / Math.max(1, H - 1) : (x * gx + y * H) / gLen2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const u = t < 0.55 ? t / 0.55 : (t - 0.55) / 0.45;
    const stop = t < 0.55 ? STOP_A : STOP_B;
    const o = (y * W + x) * 4;
    d[o] = stop[0] + (stop[3] - stop[0]) * u; d[o + 1] = stop[1] + (stop[4] - stop[1]) * u;
    d[o + 2] = stop[2] + (stop[5] - stop[2]) * u; d[o + 3] = 255;
  }

  // Nebula band: five soft blobs along a centre line. Periodic: the line is a
  // sine in x with period W and every blob is also drawn at x +/- W. Old: a
  // straight line at a random slope, no wrap.
  const y0 = H * (0.25 + s() * 0.35), amp = H * (0.08 + s() * 0.10), ph = s() * TAU;
  const slope = Math.tan(-0.20 - s() * 0.35);
  for (let i = 0; i < 5; i++) {
    const bx = (i + s()) * (W / 5);
    const by = periodic ? y0 + amp * Math.sin((TAU * bx) / W + ph) : y0 + (bx - W / 2) * slope;
    const bw = vw * (0.5 + s() * 0.45), bh = bw * (0.30 + s() * 0.25);
    const tint = s() > 0.5 ? [90, 110, 200] : [120, 90, 180];
    const copies = periodic ? [-W, 0, W] : [0];
    for (const shift of copies) {
      const cx = bx + shift;
      const xa = Math.max(0, Math.floor(cx - bw / 2)), xb = Math.min(W - 1, Math.ceil(cx + bw / 2));
      const ya = Math.max(0, Math.floor(by - bh / 2)), yb = Math.min(H - 1, Math.ceil(by + bh / 2));
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        const nx = (x - cx) / (bw / 2), ny = (y - by) / (bh / 2), r = Math.sqrt(nx * nx + ny * ny);
        if (r >= 1) continue;
        const a = r < 0.5 ? 0.07 + (0.028 - 0.07) * (r / 0.5) : 0.028 * (1 - (r - 0.5) / 0.5);
        blend(d, (y * W + x) * 4, tint[0], tint[1], tint[2], a);
      }
    }
  }

  // Stars: the old density and three tiers. Periodic: cross arms wrap in x.
  const count = Math.round((W * H) / 900);
  const put = (x: number, y: number, c: number[], a: number) => {
    if (y < 0 || y >= H) return;
    if (periodic) x = ((x % W) + W) % W; else if (x < 0 || x >= W) return;
    blend(d, (y * W + x) * 4, c[0], c[1], c[2], a);
  };
  for (let i = 0; i < count; i++) {
    const x = Math.floor(s() * W), y = Math.floor(s() * H), t = s();
    if (t > 0.965) {
      const c = s() > 0.5 ? [255, 240, 210] : [210, 230, 255];
      put(x, y, c, 0.95);
      put(x - 1, y, c, 0.35); put(x + 1, y, c, 0.35); put(x, y - 1, c, 0.35); put(x, y + 1, c, 0.35);
    } else if (t > 0.80) {
      put(x, y, [255, 250, 240], 0.55 + s() * 0.35);
    } else {
      put(x, y, [200, 215, 255], 0.14 + s() * 0.28);
    }
  }
}

/**
 * The far-scaled bake (see `bakeBackdrop`). Same random stream in the same
 * order as the identity bake, so every feature is the same feature: world
 * (identity panorama) point (x, y) lands at X = x * sx, Y = (y - fy) * s + H/2,
 * with sx = img.width / W so the panorama still tiles exactly. Periodic only.
 * Stars also repeat one panorama height above and below, so a focus near the
 * top or bottom does not show a starless band where the identity panorama ends.
 */
function bakeBackdropFar(
  img: ImageDataLike, seed: number, vw: number, scale: number, fyIn?: number, vhIn?: number, oyIn?: number,
): void {
  // H: the view height the panorama belongs to; Hi: image rows (H plus the
  // vertical overscan, view row 0 at image row oy).
  const Wi = img.width, Hi = img.height, H = vhIn ?? Hi, oy = oyIn ?? 0, d = img.data;
  const W = backdropWidth(vw), sx = Wi / W, sy = scale, fy = fyIn ?? H / 2;
  const s = rng(seed);
  const worldY = (Y: number) => (Y - oy - H / 2) / sy + fy;
  const imgY = (y: number) => (y - fy) * sy + H / 2 + oy;

  // Gradient over the world rows each image row shows (clamped past the ends).
  const STOP_A = [8, 10, 28, 5, 6, 20], STOP_B = [5, 6, 20, 2, 3, 12];
  for (let Y = 0; Y < Hi; Y++) {
    let t = worldY(Y) / Math.max(1, H - 1);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const u = t < 0.55 ? t / 0.55 : (t - 0.55) / 0.45;
    const stop = t < 0.55 ? STOP_A : STOP_B;
    const r = stop[0] + (stop[3] - stop[0]) * u, g = stop[1] + (stop[4] - stop[1]) * u, b = stop[2] + (stop[5] - stop[2]) * u;
    for (let X = 0; X < Wi; X++) {
      const o = (Y * Wi + X) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }

  // Nebula: the same five blobs on the same sine line, in image px.
  const y0 = H * (0.25 + s() * 0.35), amp = H * (0.08 + s() * 0.10), ph = s() * TAU;
  s();   // the non-periodic slope draw, kept so the stream stays in step
  for (let i = 0; i < 5; i++) {
    const bx = (i + s()) * (W / 5);
    const by = y0 + amp * Math.sin((TAU * bx) / W + ph);
    const bw = vw * (0.5 + s() * 0.45), bh = bw * (0.30 + s() * 0.25);
    const tint = s() > 0.5 ? [90, 110, 200] : [120, 90, 180];
    const hw = (bw / 2) * sx, hh = (bh / 2) * sy, cyI = imgY(by);
    for (const shift of [-Wi, 0, Wi]) {
      const cxI = bx * sx + shift;
      const xa = Math.max(0, Math.floor(cxI - hw)), xb = Math.min(Wi - 1, Math.ceil(cxI + hw));
      const ya = Math.max(0, Math.floor(cyI - hh)), yb = Math.min(Hi - 1, Math.ceil(cyI + hh));
      for (let Y = ya; Y <= yb; Y++) for (let X = xa; X <= xb; X++) {
        const nx = (X - cxI) / hw, ny = (Y - cyI) / hh, r = Math.sqrt(nx * nx + ny * ny);
        if (r >= 1) continue;
        const a = r < 0.5 ? 0.07 + (0.028 - 0.07) * (r / 0.5) : 0.028 * (1 - (r - 0.5) / 0.5);
        blend(d, (Y * Wi + X) * 4, tint[0], tint[1], tint[2], a);
      }
    }
  }

  // Stars: the same stars at their far-transformed spots, 1 px each.
  const count = Math.round((W * H) / 900);
  const put = (X: number, Y: number, c: number[], a: number) => {
    if (Y < 0 || Y >= Hi) return;
    X = ((X % Wi) + Wi) % Wi;
    blend(d, (Y * Wi + X) * 4, c[0], c[1], c[2], a);
  };
  const star = (x: number, y: number, draw: (X: number, Y: number) => void) => {
    const X = Math.round(x * sx);
    for (const dy of [-H, 0, H]) draw(X, Math.round(imgY(y + dy)));
  };
  for (let i = 0; i < count; i++) {
    const x = Math.floor(s() * W), y = Math.floor(s() * H), t = s();
    if (t > 0.965) {
      const c = s() > 0.5 ? [255, 240, 210] : [210, 230, 255];
      star(x, y, (X, Y) => {
        put(X, Y, c, 0.95);
        put(X - 1, Y, c, 0.35); put(X + 1, Y, c, 0.35); put(X, Y - 1, c, 0.35); put(X, Y + 1, c, 0.35);
      });
    } else if (t > 0.80) {
      const a = 0.55 + s() * 0.35;
      star(x, y, (X, Y) => put(X, Y, [255, 250, 240], a));
    } else {
      const a = 0.14 + s() * 0.28;
      star(x, y, (X, Y) => put(X, Y, [200, 215, 255], a));
    }
  }
}
