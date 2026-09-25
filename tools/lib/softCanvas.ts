/**
 * softCanvas — a minimal software Canvas 2D for headless sprite metrics.
 *
 * Enough of the API to rasterise the procedural sprite bakers in node without a
 * browser: fillRect, paths (moveTo/lineTo/quadraticCurveTo/ellipse/closePath),
 * fill with 4x4 supersampled coverage (Chrome anti-aliases path fills, so a
 * hard-edged rasteriser would flatter the path-based baker), save/restore,
 * translate/rotate/scale, drawImage with nearest-neighbour sampling, and the
 * ImageData trio. Colours accept #rgb, #rrggbb, rgb() and rgba().
 *
 * It is not a Canvas implementation. It is exact for axis-aligned integer
 * rects and ImageData, and approximate (within one edge pixel of coverage) for
 * curves, which is the precision a 7-pixel creature is judged at anyway.
 */

export interface SoftImageData { data: Uint8ClampedArray; width: number; height: number; }

type M = [number, number, number, number, number, number]; // a b c d e f

function parseColor(s: string): [number, number, number, number] {
  s = s.trim();
  if (s[0] === '#') {
    if (s.length === 4) {
      return [parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16), parseInt(s[3] + s[3], 16), 1];
    }
    return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16),
            s.length >= 9 ? parseInt(s.slice(7, 9), 16) / 255 : 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map(v => parseFloat(v));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return [0, 0, 0, 1];
}

export class SoftCtx {
  fillStyle: string = '#000';
  globalAlpha = 1;
  imageSmoothingEnabled = true;
  private m: M = [1, 0, 0, 1, 0, 0];
  private stack: Array<{ m: M; fillStyle: string; globalAlpha: number }> = [];
  private subpaths: Array<Array<[number, number]>> = [];
  private cur: Array<[number, number]> | null = null;

  constructor(public canvas: SoftCanvas) {}

  // ── state ──
  save(): void { this.stack.push({ m: [...this.m] as M, fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }); }
  restore(): void {
    const s = this.stack.pop(); if (!s) return;
    this.m = s.m; this.fillStyle = s.fillStyle; this.globalAlpha = s.globalAlpha;
  }
  translate(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
  }
  rotate(t: number): void {
    const [a, b, c, d, e, f] = this.m; const co = Math.cos(t), si = Math.sin(t);
    this.m = [a * co + c * si, b * co + d * si, -a * si + c * co, -b * si + d * co, e, f];
  }
  scale(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a * x, b * x, c * y, d * y, e, f];
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.m = [a, b, c, d, e, f]; }
  resetTransform(): void { this.m = [1, 0, 0, 1, 0, 0]; }
  private tx(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.m; return [a * x + c * y + e, b * x + d * y + f];
  }
  private untx(px: number, py: number): [number, number] {
    const [a, b, c, d, e, f] = this.m; const det = a * d - b * c;
    return [(d * (px - e) - c * (py - f)) / det, (-b * (px - e) + a * (py - f)) / det];
  }

  // ── paths ──
  beginPath(): void { this.subpaths = []; this.cur = null; }
  moveTo(x: number, y: number): void { this.cur = [this.tx(x, y)]; this.subpaths.push(this.cur); }
  lineTo(x: number, y: number): void {
    if (!this.cur) { this.moveTo(x, y); return; }
    this.cur.push(this.tx(x, y));
  }
  quadraticCurveTo(qx: number, qy: number, x: number, y: number): void {
    if (!this.cur) this.moveTo(qx, qy);
    const last = this.cur![this.cur!.length - 1];
    const [ux, uy] = this.untx(last[0], last[1]);
    for (let i = 1; i <= 16; i++) {
      const t = i / 16, it = 1 - t;
      this.cur!.push(this.tx(it * it * ux + 2 * it * t * qx + t * t * x,
                             it * it * uy + 2 * it * t * qy + t * t * y));
    }
  }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void {
    const n = 64; const pts: Array<[number, number]> = [];
    const co = Math.cos(rot), si = Math.sin(rot);
    for (let i = 0; i <= n; i++) {
      const t = a0 + (a1 - a0) * (i / n);
      const ex = Math.cos(t) * rx, ey = Math.sin(t) * ry;
      pts.push(this.tx(x + ex * co - ey * si, y + ex * si + ey * co));
    }
    if (this.cur && this.cur.length) { for (const p of pts) this.cur.push(p); }
    else { this.cur = pts; this.subpaths.push(this.cur); }
  }
  arc(x: number, y: number, r: number, a0: number, a1: number): void { this.ellipse(x, y, r, r, 0, a0, a1); }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath();
  }
  closePath(): void { if (this.cur && this.cur.length) this.cur.push(this.cur[0]); this.cur = null; }

  fill(): void { this.rasterise(this.subpaths.map(p => p.slice())); }
  clip(): void { /* not needed by the bakers under test */ }
  stroke(): void { /* not used by the bakers under test */ }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.rasterise([[this.tx(x, y), this.tx(x + w, y), this.tx(x + w, y + h), this.tx(x, y + h)]]);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    const { width: W, height: H, data } = this.canvas;
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(H, Math.ceil(y + h)); yy++)
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(W, Math.ceil(x + w)); xx++)
        data.fill(0, (yy * W + xx) * 4, (yy * W + xx) * 4 + 4);
  }

  /** Nonzero-winding polygon fill with 4x4 supersampled coverage. */
  private rasterise(polys: Array<Array<[number, number]>>): void {
    const edges: Array<[number, number, number, number]> = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of polys) {
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
        minX = Math.min(minX, a[0]); maxX = Math.max(maxX, a[0]);
        minY = Math.min(minY, a[1]); maxY = Math.max(maxY, a[1]);
      }
    }
    if (!edges.length) return;
    const W = this.canvas.width, H = this.canvas.height;
    const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(W - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
    if (x1 < x0 || y1 < y0) return;
    const [r, g, b, a] = parseColor(this.fillStyle);
    const S = 4;
    for (let py = y0; py <= y1; py++) {
      const cov = new Float32Array(x1 - x0 + 1);
      for (let sy = 0; sy < S; sy++) {
        const yy = py + (sy + 0.5) / S;
        const xs: Array<[number, number]> = [];
        for (const [ax, ay, bx, by] of edges) {
          if ((yy >= ay && yy < by) || (yy >= by && yy < ay)) {
            xs.push([ax + (yy - ay) * (bx - ax) / (by - ay), by > ay ? 1 : -1]);
          }
        }
        if (!xs.length) continue;
        xs.sort((p, q) => p[0] - q[0]);
        for (let px = x0; px <= x1; px++) {
          for (let sx = 0; sx < S; sx++) {
            const xx = px + (sx + 0.5) / S;
            let w = 0;
            for (const [cx, dir] of xs) { if (cx <= xx) w += dir; else break; }
            if (w !== 0) cov[px - x0] += 1 / (S * S);
          }
        }
      }
      for (let px = x0; px <= x1; px++) {
        const c = cov[px - x0]; if (c <= 0) continue;
        this.blend(px, py, r, g, b, a * Math.min(1, c) * this.globalAlpha);
      }
    }
  }

  private blend(x: number, y: number, r: number, g: number, b: number, sa: number): void {
    const d = this.canvas.data, i = (y * this.canvas.width + x) * 4;
    const da = d[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    d[i]     = (r * sa + d[i]     * da * (1 - sa)) / oa;
    d[i + 1] = (g * sa + d[i + 1] * da * (1 - sa)) / oa;
    d[i + 2] = (b * sa + d[i + 2] * da * (1 - sa)) / oa;
    d[i + 3] = oa * 255;
  }

  // ── images ──
  createImageData(w: number, h: number): SoftImageData {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }
  getImageData(x: number, y: number, w: number, h: number): SoftImageData {
    const out = this.createImageData(w, h); const W = this.canvas.width;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const sx = x + xx, sy = y + yy;
      if (sx < 0 || sy < 0 || sx >= W || sy >= this.canvas.height) continue;
      for (let k = 0; k < 4; k++) out.data[(yy * w + xx) * 4 + k] = this.canvas.data[(sy * W + sx) * 4 + k];
    }
    return out;
  }
  putImageData(img: SoftImageData, x: number, y: number): void {
    const W = this.canvas.width;
    for (let yy = 0; yy < img.height; yy++) for (let xx = 0; xx < img.width; xx++) {
      const dx = x + xx, dy = y + yy;
      if (dx < 0 || dy < 0 || dx >= W || dy >= this.canvas.height) continue;
      for (let k = 0; k < 4; k++) this.canvas.data[(dy * W + dx) * 4 + k] = img.data[(yy * img.width + xx) * 4 + k];
    }
  }
  /** drawImage(src, dx, dy[, dw, dh]) with nearest-neighbour sampling, translation-only. */
  drawImage(src: SoftCanvas, dx: number, dy: number, dw?: number, dh?: number): void {
    const sw = src.width, sh = src.height;
    dw = dw ?? sw; dh = dh ?? sh;
    const e = this.m[4], f = this.m[5];
    dx = Math.round(dx + e); dy = Math.round(dy + f);
    for (let yy = 0; yy < dh; yy++) for (let xx = 0; xx < dw; xx++) {
      const sx = Math.min(sw - 1, Math.floor((xx + 0.5) * sw / dw));
      const sy = Math.min(sh - 1, Math.floor((yy + 0.5) * sh / dh));
      const si = (sy * sw + sx) * 4;
      const a = src.data[si + 3] / 255;
      if (a <= 0) continue;
      const X = dx + xx, Y = dy + yy;
      if (X < 0 || Y < 0 || X >= this.canvas.width || Y >= this.canvas.height) continue;
      this.blend(X, Y, src.data[si], src.data[si + 1], src.data[si + 2], a * this.globalAlpha);
    }
  }
}

export class SoftCanvas {
  private _w = 300; private _h = 150;
  data = new Uint8ClampedArray(300 * 150 * 4);
  style: Record<string, string> = {};
  private ctx: SoftCtx | null = null;
  get width(): number { return this._w; }
  set width(v: number) { this._w = Math.max(0, v | 0); this.data = new Uint8ClampedArray(this._w * this._h * 4); }
  get height(): number { return this._h; }
  set height(v: number) { this._h = Math.max(0, v | 0); this.data = new Uint8ClampedArray(this._w * this._h * 4); }
  getContext(_k?: string): SoftCtx { return this.ctx ??= new SoftCtx(this); }
}

/** Install document.createElement('canvas') returning SoftCanvas on globalThis. */
export function installSoftCanvas(): void {
  const g = globalThis as any;
  g.document = g.document ?? {};
  g.document.createElement = () => new SoftCanvas();
}
