/**
 * A wireframe d20 for the dice console: it tumbles while a parameter rolls and
 * settles face-on, lit in the roll's tier colour. The number stays in the DOM
 * on top of it; this only draws the die.
 *
 * Geometry is exported (pure) so tools/menuCheck.ts can guard it.
 */

type V3 = [number, number, number];
type Q = [number, number, number, number]; // w, x, y, z

const PHI = (1 + Math.sqrt(5)) / 2;

/** The 12 vertices, 30 edges and 20 faces of an icosahedron (edge length 2). */
export function icosahedron(): { verts: V3[]; edges: [number, number][]; faces: [number, number, number][] } {
  const verts: V3[] = [];
  for (const a of [-1, 1]) for (const b of [-PHI, PHI]) {
    verts.push([0, a, b], [a, b, 0], [b, 0, a]);
  }
  const d2 = (i: number, j: number) => (verts[i][0] - verts[j][0]) ** 2 + (verts[i][1] - verts[j][1]) ** 2 + (verts[i][2] - verts[j][2]) ** 2;
  const adj = (i: number, j: number) => Math.abs(d2(i, j) - 4) < 1e-6;
  const edges: [number, number][] = [];
  const faces: [number, number, number][] = [];
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
    if (!adj(i, j)) continue;
    edges.push([i, j]);
    for (let k = j + 1; k < 12; k++) if (adj(i, k) && adj(j, k)) faces.push([i, j, k]);
  }
  return { verts, edges, faces };
}

const GEO = icosahedron();
const R0 = Math.hypot(1, PHI);

// ── quaternions ──
const qMul = (a: Q, b: Q): Q => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const qNorm = (q: Q): Q => { const n = Math.hypot(...q) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };
const qAxis = (ax: V3, ang: number): Q => {
  const n = Math.hypot(...ax) || 1, s = Math.sin(ang / 2);
  return [Math.cos(ang / 2), ax[0] / n * s, ax[1] / n * s, ax[2] / n * s];
};
function qRot(q: Q, v: V3): V3 {
  const [w, x, y, z] = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
function qSlerp(a: Q, b: Q, t: number): Q {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d > 0.9995) return qNorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(d), s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return [a[0] * ka + bb[0] * kb, a[1] * ka + bb[1] * kb, a[2] * ka + bb[2] * kb, a[3] * ka + bb[3] * kb];
}

/** Rotation that turns `q`'s most viewer-facing face exactly toward the viewer (+z). */
export function faceOn(q: Q): Q {
  let best: V3 = [0, 0, 1], bz = -2;
  for (const f of GEO.faces) {
    const c: V3 = [0, 1, 2].map(k => (GEO.verts[f[0]][k] + GEO.verts[f[1]][k] + GEO.verts[f[2]][k]) / 3) as V3;
    const n = qRot(q, c);
    const len = Math.hypot(...n);
    if (n[2] / len > bz) { bz = n[2] / len; best = [n[0] / len, n[1] / len, n[2] / len]; }
  }
  const axis: V3 = [best[1], -best[0], 0]; // best × z
  const ang = Math.acos(Math.max(-1, Math.min(1, best[2])));
  return Math.hypot(...axis) < 1e-9 ? q : qNorm(qMul(qAxis(axis, ang), q));
}

type Mode = 'idle' | 'rolling' | 'settling' | 'settled';

const views = new Set<D20View>();
let raf = 0;
let last = 0;
let active = false;
function loop(now: number): void {
  raf = 0;
  if (!active) { last = 0; return; }
  const dt = Math.min(0.05, (now - (last || now)) / 1000);
  last = now;
  for (const v of views) {
    if (!v.canvas.isConnected) { views.delete(v); continue; }
    v.step(dt, now);
  }
  if (views.size) raf = requestAnimationFrame(loop);
  else last = 0;
}
function kick(): void { if (active && !raf && views.size) raf = requestAnimationFrame(loop); }

/** The dice console is on screen (true) or not: dice draw only while it is. */
export function setDiceActive(on: boolean): void {
  active = on;
  kick();
}

export class D20View {
  private q: Q;
  private w: V3 = [0.25, 0.4, 0.1];
  private mode: Mode = 'idle';
  private from: Q = [1, 0, 0, 0];
  private to: Q = [1, 0, 0, 0];
  private t0 = 0;
  private color = '#aa88dd';
  private flash = 0;
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(readonly canvas: HTMLCanvasElement, seed = 0) {
    this.ctx = canvas.getContext('2d');
    this.q = qNorm(qAxis([1, 0.6 + seed * 0.1, 0.3], 0.7 + seed));
    views.add(this);
    kick();
  }

  /** Tumble fast until settle(). */
  roll(): void {
    this.mode = 'rolling';
    this.color = '#44ffcc';
    const r = () => (Math.random() * 2 - 1);
    this.w = [r() * 14 + 6, r() * 14 + 6, r() * 8];
  }

  /** Come to rest face-on, lit in `color`. */
  settle(color: string): void {
    this.mode = 'settling';
    this.color = color;
    this.from = this.q;
    this.to = faceOn(this.q);
    this.t0 = performance.now();
    this.flash = 1;
  }

  step(dt: number, now: number): void {
    if (this.mode === 'rolling' || this.mode === 'idle') {
      const sp = Math.hypot(...this.w);
      if (sp > 1e-6) this.q = qNorm(qMul(qAxis(this.w, sp * dt), this.q));
    } else if (this.mode === 'settling') {
      const t = Math.min(1, (now - this.t0) / 450);
      const e = 1 - Math.pow(1 - t, 3);
      this.q = qSlerp(this.from, this.to, e);
      if (t >= 1) this.mode = 'settled';
    }
    this.flash = Math.max(0, this.flash - dt * 1.6);
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const css = this.canvas.clientWidth || 80;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (this.canvas.width !== px) { this.canvas.width = px; this.canvas.height = px; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    const s = css * 0.44 / R0, c = css / 2;
    const P = GEO.verts.map(v => qRot(this.q, v));
    const proj = (v: V3): [number, number] => {
      const k = 1 + v[2] / (R0 * 7); // a touch of perspective
      return [c + v[0] * s * k, c - v[1] * s * k];
    };
    const rolling = this.mode === 'rolling';
    // Faces: front ones softly lit (the god), back ones skipped.
    const faces = GEO.faces.map(f => {
      const [a, b, d] = f.map(i => P[i]);
      const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v: V3 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      let n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const cz = a[2] + b[2] + d[2];
      if (n[0] * (a[0] + b[0] + d[0]) + n[1] * (a[1] + b[1] + d[1]) + n[2] * cz < 0) n = [-n[0], -n[1], -n[2]];
      return { f, nz: n[2] / Math.hypot(...n), cz };
    }).filter(x => x.nz > 0).sort((x, y) => x.cz - y.cz);
    for (const { f, nz } of faces) {
      const pts = f.map(i => proj(P[i]));
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.lineTo(pts[2][0], pts[2][1]); ctx.closePath();
      ctx.globalAlpha = (rolling ? 0.05 : 0.08) + nz * nz * (this.mode === 'settled' || this.mode === 'settling' ? 0.16 : 0.08) + this.flash * 0.25 * nz;
      ctx.fillStyle = this.color;
      ctx.fill();
    }
    // Edges: the wireframe (the machine). Back edges faint.
    ctx.lineWidth = 1;
    for (const [i, j] of GEO.edges) {
      const back = P[i][2] + P[j][2] < -0.6;
      const a = proj(P[i]), b = proj(P[j]);
      ctx.globalAlpha = back ? 0.12 : (rolling ? 0.75 : 0.55) + this.flash * 0.4;
      ctx.strokeStyle = this.color;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    // Vertices as single pixels: it is a simulated die.
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = this.color;
    for (const v of P) if (v[2] > -0.3) { const p = proj(v); ctx.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 1, 2, 2); }
    ctx.globalAlpha = 1;
  }

  dispose(): void { views.delete(this); }
}
