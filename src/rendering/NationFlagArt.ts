/**
 * Pixel art for nation flags (Nations.NationFlag): one function that gives
 * the colour of any point of a flag, shared by the diorama's waving banners
 * and the tile info card.
 */
import type { NationFlag } from '../simulation/Nations';

/**
 * Colour at (u, v) of a flag, u 0..1 across from the hoist, v 0..1 down.
 * `cols` x `rows` is the pixel grid the emblem is snapped to.
 */
export function flagColorAt(f: NationFlag, u: number, v: number, cols: number, rows: number): string {
  const [a, b, c] = f.colors;
  let col: string;
  switch (f.layout) {
    case 'bicolor-h': col = v < 0.5 ? a : b; break;
    case 'bicolor-v': col = u < 0.5 ? a : b; break;
    case 'tricolor-h': col = v < 1 / 3 ? a : v < 2 / 3 ? b : c; break;
    case 'tricolor-v': col = u < 1 / 3 ? a : u < 2 / 3 ? b : c; break;
    case 'cross': {
      const cu = Math.abs(u - 0.36) * cols < 0.75, cv = Math.abs(v - 0.5) * rows < 0.75;
      col = cu || cv ? b : a; break;
    }
    case 'saltire': {
      // Corner to corner, about one pixel thick at any size.
      const d1 = Math.abs(u - v), d2 = Math.abs(1 - u - v), w = 0.75 / Math.min(cols, rows);
      col = d1 < w || d2 < w ? b : a; break;
    }
    case 'canton': col = u < 0.45 && v < 0.55 ? b : a; break;
    case 'chevron': col = u < 0.42 * (1 - Math.abs(v - 0.5) * 2) ? b : v < 0.5 ? a : c; break;
    case 'border': {
      const edge = u * cols < 1 || (1 - u) * cols < 1 || v * rows < 1 || (1 - v) * rows < 1;
      col = edge ? b : a; break;
    }
    default: col = a;
  }
  // Emblem in the middle of the fly half (or centre for symmetric layouts).
  const ex = f.layout === 'canton' ? 0.22 : f.layout === 'cross' ? 0.68 : 0.55, ey = f.layout === 'canton' ? 0.27 : 0.5;
  const px = Math.round((u - ex) * cols), py = Math.round((v - ey) * rows);
  const on = emblemPixel(f.emblem, px, py);
  return on ? f.emblemColor : col;
}

/** Whether the emblem covers pixel (px, py) relative to its centre. */
function emblemPixel(e: NationFlag['emblem'], px: number, py: number): boolean {
  const ax = Math.abs(px), ay = Math.abs(py);
  switch (e) {
    case 'star': return (ax === 0 && ay <= 1) || (ay === 0 && ax <= 1);
    case 'disc': return ax + ay <= 1 || (ax === 1 && ay === 1);
    case 'crescent': return (ax <= 1 && ay <= 1) && !(px === 1 && ay <= 0) && !(px === 1 && py === 0);
    case 'diamond': return ax + ay === 1;
    case 'bar': return ay === 0 && ax <= 1;
    case 'eye': return (ay === 0 && ax <= 1) || (ax === 0 && ay === 1);
    default: return false;
  }
}

/**
 * Paint a flag as `cols` x `rows` pixels of size `px` at (x, y). `wave`
 * (radians) ripples the columns: each column drops by a sine of its distance
 * from the hoist, as cloth does in wind. 0 draws it flat.
 */
export function paintFlag(g: CanvasRenderingContext2D, f: NationFlag, x: number, y: number,
  cols: number, rows: number, px: number, wave = 0, amp = 0): void {
  for (let i = 0; i < cols; i++) {
    const dy = amp ? Math.round(Math.sin(wave - i * 0.9) * amp * (i / cols)) : 0;
    for (let j = 0; j < rows; j++) {
      g.fillStyle = flagColorAt(f, (i + 0.5) / cols, (j + 0.5) / rows, cols, rows);
      g.fillRect(x + i * px, y + (j * px) + dy, px, px);
    }
  }
}

/** A small flag canvas for UI (crisp: whole-pixel scale). */
export function flagCanvas(f: NationFlag, scale = 3): HTMLCanvasElement {
  const cols = 9, rows = 6;
  const cv = document.createElement('canvas');
  cv.width = cols * scale; cv.height = rows * scale;
  const g = cv.getContext('2d');
  if (g) paintFlag(g, f, 0, 0, cols, rows, scale);
  cv.style.imageRendering = 'pixelated';
  return cv;
}

/**
 * A nation's colour made readable on the map: the same hue, saturated and
 * at mid lightness (flag colours can be near-black or washed out).
 */
export function mapColor(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
  let h = 0;
  if (dl > 0) h = mx === r ? ((g - b) / dl + 6) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
  const s = Math.max(0.6, dl / Math.max(1e-6, 1 - Math.abs(mx + mn - 1))), l = 0.58;
  const c = (1 - Math.abs(2 * l - 1)) * Math.min(1, s), x = c * (1 - Math.abs((h % 2) - 1)), m = l - c / 2;
  const [R, G, B] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round((R + m) * 255), Math.round((G + m) * 255), Math.round((B + m) * 255)];
}
