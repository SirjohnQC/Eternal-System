/**
 * MeteorStrike — a body falling out of the sky onto the home-world diorama.
 *
 * Sequence (seconds from the call):
 *   0.00-1.15  approach: a burning head on a straight line from high in the
 *              sky, accelerating, with a quantised fire trail (white, yellow,
 *              orange, red, then smoke) and shed sparks. Entry flash at ~45%
 *              of the fall, where it hits the air.
 *   1.15       impact: a white flash that lights the surface round the
 *              impact (additive radial wash clipped to the body) and a short
 *              full-frame flash.
 *   1.15-2.0   fireball rising off the impact point.
 *   1.15-3.0   shockwave: two rings on the ground plane (ry/rx squash), a hot
 *              one and a slower dust one.
 *   1.15-3.4   ejecta: 24-44 ballistic fragments, hot then cooling to rock.
 *   1.3-10     plume: dithered dust puffs rising and mushrooming, fading.
 *   1.15-61    scorch: a baked crater mark (dark floor, lit rim, ejecta rays)
 *              stays on the surface, molten for the first ~8 s, fading out
 *              between 30 s and 60 s.
 *
 * Everything is stored in BASE-WORLD virtual px (the diorama's placement
 * geometry) and mapped through the active camera when drawn, like the divine
 * effects. Pixel strokes stay 1-2 px; areas scale by the zoom k.
 *
 * Reset: `clear()` on a new planet / new game (IsoDioramaRenderer.refreshData).
 * Allocation: puff and crater sprites are baked once per strike; the frame
 * path allocates only the two radial gradients during the 0.5 s flash.
 */

type Map1 = (v: number) => number;

/** Active camera geometry and mapping, passed in per draw. */
export interface StrikeView {
  wsx: Map1; wsy: Map1;
  /** Zoom of the active camera. */
  k: number;
  /** Top-face ellipse (active geometry). */
  cx: number; cy: number; rx: number; ry: number;
  /** Body circle (active geometry), for clipping washes to the world. */
  bodyCx: number; bodyCy: number; bodyR: number;
  VW: number; VH: number;
  /** Sun direction on screen, -1 (left) .. 1 (right). */
  lightX: number;
}

interface Strike {
  ix: number; iy: number;     // impact, base-world px
  sx: number; sy: number;     // entry point high in the sky, base-world px
  reach: number;              // shockwave reach, base-world px
  size: number;               // 0.4..1.2
  age: number;
  seed: number;
  /** Ejecta: vx, vy (base px/s), landing depth below impact, hot life (s). */
  ej: Float32Array; nEj: number;
  /** Plume puffs: dx, rise, spread, phase, size. */
  pf: Float32Array; nPf: number;
  /** Sparks shed from the head: offset along trail, lateral drift. */
  sp: Float32Array;
  scorched: boolean;
}

interface Scorch {
  x: number; y: number; w: number; h: number;
  age: number;
  sprite: HTMLCanvasElement | null;
  /** Molten core half-size, base px. */
  core: number;
}

const T_FALL = 1.15;
const T_STRIKE = 10.5;          // strike object lifetime (plume gone by then)
const SCORCH_LIFE = 60;
const SCORCH_FADE_FROM = 30;

/** Fire ramp, hottest first (quantised, no blending between steps). */
const FIRE = ['#ffffff', '#fff2b0', '#ffd060', '#ff9a3c', '#e8582a', '#a8301c', '#5c3a32', '#3c3030'];
/** Ejecta: hot to cold. */
const EJ_HOT = ['#fff2b0', '#ffb04a', '#e8582a'];
const EJ_COLD = ['#6a5446', '#4a3c34'];
/** Puff ramp: lit, body, shadow (warm grey-brown dust). */
const PUFF_TONES: Array<[number, number, number][]> = [
  [[176, 160, 140], [128, 112, 98], [78, 66, 60]],
  [[150, 138, 128], [104, 94, 88], [62, 56, 56]],
];
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);

function hashStream(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Pixel puff: a dithered, top-lit disc, `n` px across. */
function bakePuff(n: number, tone: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = n; cv.height = n;
  const g = cv.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(n, n), d = img.data, R = n / 2;
  const ramp = PUFF_TONES[tone];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (x + 0.5 - R) / R, v = (y + 0.5 - R) / R, rr = u * u + v * v;
    const b = BAYER4[(y & 3) * 4 + (x & 3)];
    // Ragged edge: the outer ring is dithered away.
    if (rr > 1 || (rr > 0.62 && b < (rr - 0.62) * 2.6)) continue;
    const lit = -v * 0.8 - u * 0.25 + (1 - rr) * 0.4;
    const step = lit + b * 0.35 > 0.55 ? 0 : lit + b * 0.35 > 0.05 ? 1 : 2;
    const c = ramp[step], i = (y * n + x) * 4;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return cv;
}

/**
 * Crater mark, `w` x `h` px (the ellipse of the crater rim), drawn in a canvas
 * 1.7x larger to hold the ejecta rays. Lit from the left or right by `lightX`.
 */
function bakeCrater(w: number, h: number, seed: number, lightX: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const W = Math.max(5, Math.round(w * 1.7)), H = Math.max(4, Math.round(h * 1.7));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(W, H), d = img.data;
  const rnd = hashStream(seed ^ 0x2c1b3c6d);
  const rays = 7 + Math.floor(rnd() * 6);
  const rayA: number[] = [], rayW: number[] = [], rayL: number[] = [];
  for (let i = 0; i < rays; i++) { rayA.push(rnd() * Math.PI * 2); rayW.push(0.08 + rnd() * 0.12); rayL.push(1.25 + rnd() * 0.45); }
  const cxp = W / 2, cyp = H / 2, ax = w / 2, ay = h / 2;
  const set = (i: number, r: number, gg: number, b: number, a: number) => { d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = a; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5 - cxp) / ax, v = (y + 0.5 - cyp) / ay;
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    const b = BAYER4[(y & 3) * 4 + (x & 3)];
    const i = (y * W + x) * 4;
    if (r < 0.62) {
      // Floor: charred, a dithered pair of tones; darker toward the lit rim.
      const shade = r * 0.6 + (u * -Math.sign(lightX || 1)) * 0.2;
      if (shade + b * 0.3 > 0.32) set(i, 44, 36, 30, 255); else set(i, 28, 22, 20, 255);
    } else if (r < 0.82) {
      // Rim: the sun-facing inner wall in shadow, the far wall lit (and the
      // outer slope the other way round), quantised to three steps.
      const face = (u * Math.sign(lightX || 1)) * 0.8 - v * 0.6;
      const t = face + (b - 0.5) * 0.5;
      if (t > 0.25) set(i, 150, 132, 108, 255);
      else if (t > -0.25) set(i, 96, 80, 66, 255);
      else set(i, 54, 44, 38, 255);
    } else {
      // Ejecta blanket: dithered density falling with distance, plus rays.
      let ray = 0;
      for (let k = 0; k < rays; k++) {
        let da = Math.abs(th - rayA[k]); if (da > Math.PI) da = Math.PI * 2 - da;
        if (da < rayW[k] * (1.3 - r * 0.4) && r < rayL[k] * 1.4) ray = Math.max(ray, 1 - (r - 0.82) / (rayL[k] * 1.4 - 0.82));
      }
      const blanket = Math.max(0, 1 - (r - 0.82) / 0.38);
      const p = Math.max(blanket * 0.85, ray * 0.75);
      if (p > b) set(i, 40, 32, 28, Math.round(150 + p * 90));
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}

/** Filled pixel disc of radius r centred on integer (x, y): one fillRect per row. */
function pxDisc(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  g.fillStyle = color;
  for (let dy = -r; dy <= r; dy++) {
    const hw = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy) + r * 0.3));
    g.fillRect(x - hw, y + dy, hw * 2 + 1, 1);
  }
}

export class MeteorStrike {
  private strikes: Strike[] = [];
  private scorches: Scorch[] = [];
  private puffs: Array<HTMLCanvasElement | null> = [];
  /** Puff sprite sizes, px. */
  private static readonly PUFF_N = [3, 4, 5, 7, 9, 12];

  get active(): boolean { return this.strikes.length > 0 || this.scorches.length > 0; }

  /** Drop every strike and crater (new planet / new game). */
  clear(): void { this.strikes.length = 0; this.scorches.length = 0; }

  /**
   * Begin a strike at base-world (ix, iy).
   * @param reach shockwave reach, base-world px
   * @param size 0.4 (small comet fragment) .. 1.2 (dinosaur-killer)
   * @param VH backbuffer height, for the entry height
   */
  start(ix: number, iy: number, reach: number, size: number, seed: number, VW: number, VH: number): void {
    const rnd = hashStream(seed);
    size = Math.max(0.4, Math.min(1.2, size));
    // Enters from high on the left or right, at 30-50 degrees from vertical.
    const side = rnd() < 0.5 ? -1 : 1;
    const ang = (0.52 + rnd() * 0.35) * side;
    // Enters just inside the top of the frame, so the whole fall is seen.
    const len = Math.max(VH * 0.3, (iy - VH * 0.02) / Math.cos(ang));
    const sx = Math.max(-VW * 0.1, Math.min(VW * 1.1, ix + Math.sin(ang) * len));
    const sy = iy - Math.cos(ang) * len;
    const nEj = Math.round(24 + 20 * size);
    const ej = new Float32Array(nEj * 4);
    for (let i = 0; i < nEj; i++) {
      const a = rnd() * Math.PI * 2;
      const sp = reach * (0.5 + rnd() * 1.1);
      ej[i * 4] = Math.cos(a) * sp;                                  // vx
      ej[i * 4 + 1] = -(reach * (1.0 + rnd() * 1.6));               // vy (up)
      ej[i * 4 + 2] = Math.sin(a) * sp * 0.35;                       // landing depth (ground plane)
      ej[i * 4 + 3] = 0.25 + rnd() * 0.45;                           // hot life
    }
    const nPf = Math.round(12 + 10 * size);
    const pf = new Float32Array(nPf * 5);
    for (let i = 0; i < nPf; i++) {
      const top = i / nPf;                                           // later puffs ride higher
      pf[i * 5] = (rnd() - 0.5) * reach * 0.35;                      // base dx
      pf[i * 5 + 1] = reach * (0.35 + top * 0.95 + rnd() * 0.2);     // rise
      pf[i * 5 + 2] = (rnd() - 0.5) * reach * (0.3 + top * 0.9);     // mushroom spread
      pf[i * 5 + 3] = rnd() * 0.5;                                   // start delay
      pf[i * 5 + 4] = rnd();                                         // size roll
    }
    const sp = new Float32Array(16);
    for (let i = 0; i < 8; i++) { sp[i * 2] = rnd(); sp[i * 2 + 1] = (rnd() - 0.5) * 2; }
    this.strikes.push({ ix, iy, sx, sy, reach, size, age: 0, seed, ej, nEj, pf, nPf, sp, scorched: false });
    if (this.strikes.length > 3) this.strikes.shift();
  }

  private puff(i: number): HTMLCanvasElement | null {
    if (this.puffs.length === 0) {
      for (let t = 0; t < 2; t++) for (const n of MeteorStrike.PUFF_N) this.puffs.push(bakePuff(n, t));
    }
    return this.puffs[i] ?? null;
  }

  /** Advance clocks. Call once per frame. */
  step(dt: number, lightX: number): void {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.age += dt;
      if (!s.scorched && s.age >= T_FALL) {
        s.scorched = true;
        const w = Math.max(8, Math.round(s.reach * 0.95 * s.size + 6));
        const h = Math.max(3, Math.round(w * 0.52));
        this.scorches.push({ x: s.ix, y: s.iy, w, h, age: 0, sprite: bakeCrater(w, h, s.seed, lightX), core: Math.max(1, w * 0.18) });
        if (this.scorches.length > 4) this.scorches.shift();
      }
      if (s.age > T_STRIKE) this.strikes.splice(i, 1);
    }
    for (let i = this.scorches.length - 1; i >= 0; i--) {
      const c = this.scorches[i];
      c.age += dt;
      if (c.age > SCORCH_LIFE) this.scorches.splice(i, 1);
    }
  }

  /**
   * Crater marks on the surface. Draw in the surface-overlay pass (above the
   * terrain and the day/night veil, under clouds and atmosphere).
   */
  drawSurface(g: CanvasRenderingContext2D, v: StrikeView): void {
    if (this.scorches.length === 0) return;
    const prevS = g.imageSmoothingEnabled;
    g.imageSmoothingEnabled = false;
    for (const c of this.scorches) {
      const fade = c.age < SCORCH_FADE_FROM ? 1 : 1 - (c.age - SCORCH_FADE_FROM) / (SCORCH_LIFE - SCORCH_FADE_FROM);
      // Quantised fade (4 steps): pixel art does not cross-fade smoothly.
      const qa = Math.ceil(fade * 4) / 4;
      if (qa <= 0) continue;
      const x = v.wsx(c.x), y = v.wsy(c.y), k = v.k;
      if (c.sprite) {
        const W = c.sprite.width * k, H = c.sprite.height * k;
        g.globalAlpha = qa;
        g.drawImage(c.sprite, Math.round(x - W / 2), Math.round(y - H / 2), Math.round(W), Math.round(H));
      }
      // Molten floor: bright for ~3 s, cooling through orange and red by 8 s.
      if (c.age < 8) {
        const t = c.age / 8;
        const idx = Math.min(FIRE.length - 1, 1 + Math.floor(t * 5));
        const flick = (Math.floor(c.age * 12) & 1) ? 1 : 0;
        const cw = Math.max(1, Math.round(c.core * 2 * k * (1 - t * 0.5))), ch = Math.max(1, Math.round(cw * 0.5));
        g.globalAlpha = 1;
        g.fillStyle = FIRE[idx];
        g.fillRect(Math.round(x - cw / 2), Math.round(y - ch / 2), cw, ch);
        if (cw >= 3) {
          g.fillStyle = FIRE[Math.max(0, idx - 1)];
          g.fillRect(Math.round(x - cw / 4) + flick, Math.round(y - ch / 4), Math.max(1, cw >> 1), Math.max(1, ch >> 1));
        }
        // Glow onto the surrounding ground.
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = 0.18 * (1 - t);
        g.fillStyle = '#ff7a2a';
        g.fillRect(Math.round(x - cw), Math.round(y - ch), cw * 2, ch * 2);
        g.globalCompositeOperation = 'source-over';
      }
      g.globalAlpha = 1;
    }
    g.imageSmoothingEnabled = prevS;
  }

  /** The falling body, flash, fireball, shockwave, ejecta and plume. Draw over the scene. */
  drawSky(g: CanvasRenderingContext2D, v: StrikeView): void {
    if (this.strikes.length === 0) return;
    const k = v.k, p = Math.max(1, Math.round(k));
    const prevS = g.imageSmoothingEnabled;
    g.imageSmoothingEnabled = false;
    for (const s of this.strikes) {
      const ix = v.wsx(s.ix), iy = v.wsy(s.iy), reach = s.reach * k;
      if (s.age < T_FALL) this.drawFall(g, v, s, ix, iy, p);
      else this.drawImpact(g, v, s, ix, iy, reach, p);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.imageSmoothingEnabled = prevS;
  }

  private drawFall(g: CanvasRenderingContext2D, v: StrikeView, s: Strike, ix: number, iy: number, p: number): void {
    const sx = v.wsx(s.sx), sy = v.wsy(s.sy);
    const u = s.age / T_FALL;
    const pos = Math.pow(u, 1.35);                     // accelerating
    const hx = sx + (ix - sx) * pos, hy = sy + (iy - sy) * pos;
    const dx = ix - sx, dy = iy - sy, L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;
    // Trail: quantised fire steps back along the path; longer as it speeds up
    // and heats in the air.
    const heat = Math.min(1, u * 1.6);
    const trail = (14 + 60 * heat) * s.size * p;
    const steps = Math.max(6, Math.round(trail / p));
    for (let j = steps; j >= 1; j--) {
      const f = j / steps;
      const tx = hx - ux * trail * f, ty = hy - uy * trail * f;
      const idx = Math.min(FIRE.length - 1, Math.floor(f * FIRE.length * (0.75 + (1 - heat) * 0.5)));
      // Width tapers: 3 px near the head, 1 px at the tail.
      const w = (f < 0.2 ? 3 : f < 0.5 ? 2 : 1) * p * (s.size > 0.8 ? 1 : 1);
      g.globalAlpha = f > 0.75 ? 0.5 : 1;
      g.fillStyle = FIRE[idx];
      g.fillRect(Math.round(tx - w / 2), Math.round(ty - w / 2), w, w);
    }
    // Sparks shed sideways off the trail.
    g.globalAlpha = 1;
    for (let i = 0; i < 8; i++) {
      const f = (s.sp[i * 2] + s.age * 2.3) % 1;
      const tx = hx - ux * trail * f * 0.8 + -uy * s.sp[i * 2 + 1] * f * 9 * p;
      const ty = hy - uy * trail * f * 0.8 + ux * s.sp[i * 2 + 1] * f * 9 * p;
      g.fillStyle = FIRE[1 + Math.floor(f * 4)];
      g.fillRect(Math.round(tx), Math.round(ty), p, p);
    }
    // Head: white core with a yellow rim, plus an additive glow.
    const hs = Math.max(2, Math.round((2 + s.size * 2) * p));
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.35 + heat * 0.3;
    g.fillStyle = '#ffb04a';
    const gr = hs * 2;
    g.fillRect(Math.round(hx - gr), Math.round(hy - gr / 2), gr * 2, gr);
    g.fillRect(Math.round(hx - gr / 2), Math.round(hy - gr), gr, gr * 2);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = FIRE[2];
    g.fillRect(Math.round(hx - hs / 2) - p, Math.round(hy - hs / 2), hs + 2 * p, hs);
    g.fillRect(Math.round(hx - hs / 2), Math.round(hy - hs / 2) - p, hs, hs + 2 * p);
    g.fillStyle = FIRE[0];
    g.fillRect(Math.round(hx - hs / 2), Math.round(hy - hs / 2), hs, hs);
    // Entry flash where it hits the air (~40% of the path): a cross-shaped
    // burst that blooms and dies in ~0.2 s.
    const ue = s.age - T_FALL * 0.42;
    if (ue > 0 && ue < 0.22) {
      const pe = Math.pow(0.42, 1.35);
      const ex = sx + dx * pe, ey = sy + dy * pe;
      const a = 1 - ue / 0.22, r = Math.round((4 + ue * 60) * p * s.size);
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = a;
      g.fillStyle = '#fff2b0';
      g.fillRect(Math.round(ex - r), Math.round(ey) - p, r * 2, 2 * p);
      g.fillRect(Math.round(ex) - p, Math.round(ey - r), 2 * p, r * 2);
      g.globalAlpha = a * 0.5;
      g.fillRect(Math.round(ex - r / 2), Math.round(ey - r / 2), r, r);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
  }

  private drawImpact(g: CanvasRenderingContext2D, v: StrikeView, s: Strike, ix: number, iy: number, reach: number, p: number): void {
    const b = s.age - T_FALL;
    const squash = v.ry / Math.max(1, v.rx);
    // 1 - flash: the surface lights up round the impact, the frame blinks.
    if (b < 0.6) {
      const a = Math.pow(1 - b / 0.6, 2);
      g.save();
      g.beginPath();
      g.arc(v.bodyCx, v.bodyCy, v.bodyR - 1, 0, Math.PI * 2);
      g.clip();
      g.globalCompositeOperation = 'lighter';
      const wr = reach * (1.4 + b * 2.2);
      const wash = g.createRadialGradient(ix, iy, 0, ix, iy, wr);
      wash.addColorStop(0, `rgba(255,244,210,${(0.95 * a).toFixed(3)})`);
      wash.addColorStop(0.35, `rgba(255,190,110,${(0.5 * a).toFixed(3)})`);
      wash.addColorStop(1, 'rgba(255,140,60,0)');
      g.fillStyle = wash;
      g.fillRect(ix - wr, iy - wr, wr * 2, wr * 2);
      g.restore();
      if (b < 0.14) {
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = 0.45 * (1 - b / 0.14) * s.size;
        g.fillStyle = '#fff6e0';
        g.fillRect(0, 0, v.VW, v.VH);
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
      }
    }
    // 2 - shockwave rings on the ground plane, clipped to the face.
    if (b < 1.9) {
      g.save();
      g.beginPath();
      g.ellipse(v.cx, v.cy, v.rx + 1, v.ry + 1, 0, 0, Math.PI * 2);
      g.clip();
      const t = b / 1.9, e = 1 - Math.pow(1 - t, 2.2);
      const rr = reach * 1.7 * e;
      g.globalAlpha = (1 - t) * 0.95;
      g.strokeStyle = t < 0.3 ? '#fff2b0' : '#ffd8a0';
      g.lineWidth = t < 0.4 ? 2 : 1;
      g.beginPath(); g.ellipse(ix, iy, rr, rr * squash, 0, 0, Math.PI * 2); g.stroke();
      // Trailing dust ring: brown, slower.
      const rd = rr * 0.72;
      g.globalAlpha = (1 - t) * 0.8;
      g.strokeStyle = '#8a6a52';
      g.lineWidth = 2;
      g.beginPath(); g.ellipse(ix, iy, rd, rd * squash, 0, 0, Math.PI * 2); g.stroke();
      g.restore();
      g.globalAlpha = 1;
    }
    // 3 - fireball: concentric pixel discs (quantised fire ramp, hottest at
    // the core) rising off the impact and cooling outward-in.
    if (b < 1.0) {
      const t = b;
      const r = Math.max(2, Math.round(reach * 0.22 * s.size * (0.6 + t * 1.1)));
      const fx = Math.round(ix), fy = Math.round(iy - reach * 0.32 * t);
      const idx = Math.min(5, Math.floor(t * 6));
      g.globalAlpha = 1;
      pxDisc(g, fx, fy, r, FIRE[Math.min(7, idx + 2)]);
      pxDisc(g, fx - Math.round(r * 0.12), fy - Math.round(r * 0.15), Math.round(r * 0.66), FIRE[Math.min(7, idx + 1)]);
      pxDisc(g, fx - Math.round(r * 0.2), fy - Math.round(r * 0.25), Math.max(1, Math.round(r * 0.33)), FIRE[idx]);
    }
    // 4 - ejecta: ballistic arcs (gravity in base px/s^2), hot then cold.
    const G = s.reach * 4.2 * v.k;
    for (let i = 0; i < s.nEj; i++) {
      const vx = s.ej[i * 4] * v.k, vy = s.ej[i * 4 + 1] * v.k, land = s.ej[i * 4 + 2] * v.k, hot = s.ej[i * 4 + 3];
      const x = ix + vx * b, y = iy + vy * b + 0.5 * G * b * b;
      if (y > iy + land && b > 0.1) continue;        // came down
      const col = b < hot ? EJ_HOT[Math.min(2, Math.floor(b / hot * 3))] : EJ_COLD[i & 1];
      g.fillStyle = col;
      const q = (i % 2 === 0 && s.size >= 0.6) ? 2 * p : p;
      g.fillRect(Math.round(x), Math.round(y), q, q);
      // A 1-px streak behind fast fragments.
      if (b < 0.8) {
        const pb = b - 0.05;
        g.fillRect(Math.round(ix + vx * pb), Math.round(iy + vy * pb + 0.5 * G * pb * pb), p, p);
      }
    }
    // 5 - plume: dust puffs rising and spreading into a mushroom, fading.
    if (b > 0.15) {
      const life = T_STRIKE - T_FALL;
      const fade = 1 - Math.max(0, (b - life * 0.45) / (life * 0.55));
      for (let i = 0; i < s.nPf; i++) {
        const delay = s.pf[i * 5 + 3];
        const bt = b - 0.15 - delay;
        if (bt <= 0) continue;
        const riseF = 1 - Math.exp(-bt * 0.7), spreadF = 1 - Math.exp(-bt * 0.45);
        const x = ix + (s.pf[i * 5] + s.pf[i * 5 + 2] * spreadF) * v.k;
        const y = iy - s.pf[i * 5 + 1] * riseF * v.k * s.size;
        const grow = Math.min(1, bt * 0.6);
        const si = Math.min(5, Math.floor((0.3 + s.pf[i * 5 + 4] * 0.7) * grow * (2 + 4 * s.size)));
        const spr = this.puff((i & 1) * 6 + si);
        if (!spr) continue;
        const a = Math.ceil(fade * Math.min(1, bt * 3) * 4) / 4;
        if (a <= 0) continue;
        g.globalAlpha = a * 0.92;
        const n = spr.width * p;
        g.drawImage(spr, Math.round(x - n / 2), Math.round(y - n / 2), n, n);
        // Lit from the fire beneath for the first second.
        if (bt < 1.2) {
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = (1 - bt / 1.2) * 0.4;
          g.fillStyle = '#ff7a2a';
          g.fillRect(Math.round(x - n / 2), Math.round(y), n, Math.max(1, n >> 1));
          g.globalCompositeOperation = 'source-over';
        }
      }
      g.globalAlpha = 1;
    }
  }
}
