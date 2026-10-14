/**
 * Dashed lines that only draw what is on screen (#30). Pure apart from the
 * Graphics calls, so tools/lineClipCheck.ts can count what a frame draws.
 */
import type { Graphics } from 'pixi.js';

/** What dashedLine needs to know about the view: its centre and half extents, in world units. */
export interface ViewBox { x: number; y: number; halfW: number; halfH: number }

/** The subset of Graphics a dashed line uses (so a check can pass a counter). */
export type LineSink = Pick<Graphics, 'moveTo' | 'lineTo' | 'stroke'>;

/**
 * Clip the segment (x1,y1)-(x2,y2) to an axis-aligned box (Liang–Barsky).
 * Returns the [t0, t1] part of the segment inside it, or null.
 */
export function clipSegment(
  x1: number, y1: number, x2: number, y2: number,
  minX: number, minY: number, maxX: number, maxY: number,
): [number, number] | null {
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  const edges: Array<[number, number]> = [[-dx, x1 - minX], [dx, maxX - x1], [-dy, y1 - minY], [dy, maxY - y1]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}

/** Most dashes one line may draw in a frame; past this it is drawn solid. */
export const MAX_DASHES = 2000;

/**
 * A dashed line. With `view`, only the part on screen is dashed (#30: a
 * trade route to another galaxy, seen from a planet's zoom, was cut into
 * hundreds of thousands of dashes every frame). The dash pattern stays
 * anchored to the line's start, so it doesn't crawl as the view moves.
 */
export function dashedLine(
  g: LineSink,
  x1: number, y1: number,
  x2: number, y2: number,
  dashLen: number,
  gapLen: number,
  color: number,
  width: number,
  alpha: number,
  view?: ViewBox,
): void {
  const dx = x2 - x1, dy = y2 - y1;
  const total = Math.sqrt(dx * dx + dy * dy);
  if (total < 0.5) return;
  const nx = dx / total, ny = dy / total;
  let from = 0, to = total;
  if (view) {
    const pad = dashLen + gapLen;
    const c = clipSegment(x1, y1, x2, y2, view.x - view.halfW - pad, view.y - view.halfH - pad, view.x + view.halfW + pad, view.y + view.halfH + pad);
    if (!c) return;
    from = c[0] * total; to = c[1] * total;
  }
  const period = dashLen + gapLen;
  if (period <= 0 || (to - from) / period > MAX_DASHES) {
    g.moveTo(x1 + nx * from, y1 + ny * from).lineTo(x1 + nx * to, y1 + ny * to).stroke({ color, width, alpha: alpha * 0.6 });
    return;
  }
  let pos = Math.floor(from / period) * period;
  while (pos < to) {
    const dEnd = Math.min(pos + dashLen, to);
    const dStart = Math.max(pos, from);
    if (dEnd > dStart) {
      g.moveTo(x1 + nx * dStart, y1 + ny * dStart).lineTo(x1 + nx * dEnd, y1 + ny * dEnd).stroke({ color, width, alpha });
    }
    pos += period;
  }
}

