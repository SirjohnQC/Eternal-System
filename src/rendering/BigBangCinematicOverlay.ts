/**
 * Screen-space overlay for the Big Bang cinematic (BigBangCinematic).
 *
 * Draws what the simulation itself cannot show: the singularity, the flash and
 * shockwave, the primordial plasma and its cooling, the sparks of the first
 * stars, the cosmic web threading the real galaxies, the mark on the player's
 * home galaxy, and the ignition of their sun inside its protoplanetary disc.
 * Everything that is the universe itself (stars, galaxies, worlds) stays the
 * engine's, drawn underneath by PixiBigBangRenderer.
 */

import { Container, Graphics, Sprite, Text, TextStyle, Texture, TilingSprite } from 'pixi.js';
import type { BigBangEngine, StarBody, Galaxy } from '../simulation/BigBangEngine';
import { planetOffsetFromStar } from '../simulation/BigBangEngine';
import { ramp, type BigBangCinematic } from '../simulation/BigBangCinematic';

// ─── Baked textures ──────────────────────────────────────────────────────────

/** Soft white radial glow (alpha falls off), for tinted blooms. */
function glowCanvas(size: number, falloff = 2.2): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const h = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x + 0.5 - h, y + 0.5 - h) / h;
    const a = r >= 1 ? 0 : Math.pow(1 - r, falloff);
    const o = (y * size + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
    img.data[o + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Edge vignette: clear centre, dark rim. */
function vignetteCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size * 0.72);
  grd.addColorStop(0, 'rgba(0,0,8,0)');
  grd.addColorStop(1, 'rgba(0,0,8,0.85)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

/**
 * Tileable fractal value noise, grey on opaque. Periodic lattices make it wrap
 * so a TilingSprite can scroll and scale it forever.
 */
function noiseTile(size: number, seed: number, octaves = 5, base = 4): HTMLCanvasElement {
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  const field = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const P = base << o;
    const lat = new Float32Array(P * P);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * P, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * P, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
        const a = lat[y0 * P + x0], b = lat[y0 * P + x1], c = lat[y1 * P + x0], d = lat[y1 * P + x1];
        field[y * size + x] += amp * ((a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy);
      }
    }
    total += amp;
    amp *= 0.55;
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  for (let i = 0; i < field.length; i++) {
    // Stretch contrast so the plasma has bright filaments and dark pockets.
    const v = Math.max(0, Math.min(1, (field[i] / total - 0.28) / 0.44));
    const k = Math.round(Math.pow(v, 1.6) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = k;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
function mixHex(a: number, b: number, k: number): number {
  const t = Math.max(0, Math.min(1, k));
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, t));
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, t));
  const bl = Math.round(lerp(a & 255, b & 255, t));
  return (r << 16) | (g << 8) | bl;
}
/** Colour along a gradient of stops at 0..1. */
function gradient(stops: number[], k: number): number {
  const t = Math.max(0, Math.min(1, k)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  return mixHex(stops[i], stops[i + 1], t - i);
}
function hash(n: number): number {
  let x = (n | 0) * 374761393;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
function cssHex(c: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  return m ? parseInt(m[1], 16) : 0xa0b0ff;
}

const PLASMA = [0xfff8e8, 0xffe09a, 0xffa040, 0xe0561c, 0x8a2414, 0x3a0c10];
const CMB = [0x5a2a30, 0x2c2440, 0x10101c];

interface WebNode { x: number; y: number; real: Galaxy | null; }

// ─── Overlay ─────────────────────────────────────────────────────────────────

export class BigBangCinematicOverlay {
  readonly container = new Container();
  private backdrop = new Graphics();
  private plasmaFloor = new Graphics();
  private plasmaBase: TilingSprite;
  private plasmaGlow: TilingSprite;
  private gfx = new Graphics();
  private glowTex: Texture;
  private glows: Sprite[] = [];
  private glowUsed = 0;
  private flash = new Graphics();
  private vignette: Sprite;
  private homeLabel: Text;
  private web: { nodes: WebNode[]; edges: Array<[number, number, number]> } | null = null;
  private webKey = '';

  constructor() {
    this.glowTex = Texture.from(glowCanvas(128));
    this.glowTex.source.scaleMode = 'linear';
    const nA = Texture.from(noiseTile(256, 0x51a7e, 5, 4));
    const nB = Texture.from(noiseTile(256, 0x0c0ffee, 4, 8));
    // Nearest: the plasma boils in chunky pixels, like the rest of the game's art.
    nA.source.scaleMode = 'nearest'; nB.source.scaleMode = 'nearest';
    nA.source.addressMode = 'repeat'; nB.source.addressMode = 'repeat';
    this.plasmaBase = new TilingSprite({ texture: nA, width: 16, height: 16 });
    this.plasmaGlow = new TilingSprite({ texture: nB, width: 16, height: 16 });
    this.plasmaBase.blendMode = 'add';
    this.plasmaGlow.blendMode = 'add';
    const vt = Texture.from(vignetteCanvas(256));
    vt.source.scaleMode = 'linear';
    this.vignette = new Sprite(vt);
    this.homeLabel = new Text({
      text: 'YOUR GALAXY',
      style: new TextStyle({ fontFamily: '"Pixelify Sans", monospace', fontSize: 13, fill: 0xffd27a, letterSpacing: 2 }),
    });
    this.homeLabel.anchor.set(0.5);
    this.container.addChild(this.backdrop, this.plasmaFloor, this.plasmaBase, this.plasmaGlow, this.gfx, this.vignette, this.homeLabel, this.flash);
    this.container.visible = false;
  }

  private glow(x: number, y: number, size: number, tint: number, alpha: number, add = true): void {
    if (alpha <= 0.003 || size < 1) return;
    let s = this.glows[this.glowUsed];
    if (!s) {
      s = new Sprite(this.glowTex);
      s.anchor.set(0.5);
      this.glows.push(s);
      this.container.addChildAt(s, this.container.getChildIndex(this.gfx));
    }
    this.glowUsed++;
    s.visible = true;
    s.x = x; s.y = y;
    s.width = s.height = size;
    s.tint = tint;
    s.alpha = Math.min(1, alpha);
    s.blendMode = add ? 'add' : 'normal';
  }

  update(engine: BigBangEngine, W: number, H: number): void {
    const cine = engine.cinematic;
    if (!cine || cine.finished) { this.container.visible = false; return; }
    this.container.visible = true;
    const g = this.gfx, fl = this.flash;
    g.clear(); fl.clear(); this.backdrop.clear(); this.plasmaFloor.clear();
    this.glowUsed = 0;
    this.homeLabel.visible = false;
    const cx = W / 2, cy = H / 2, R = Math.hypot(W, H) / 2;
    const t = cine.t;

    // Black of the early universe; lifts as the dark ages end.
    const dark = 1 - ramp(cine.since('cooling'), 1.4, 3.0);
    if (dark > 0) this.backdrop.rect(0, 0, W, H).fill({ color: 0x000006, alpha: dark });

    this.drawSingularity(cine, g, cx, cy, R, t);
    this.drawPlasma(cine, W, H);
    this.drawBang(cine, g, fl, W, H, cx, cy, R);
    this.drawFirstStars(cine, engine, g, W, H);
    this.drawWeb(cine, engine, g, W, H);
    this.drawHomeGalaxy(cine, engine, g, W, H);
    this.drawIgnition(cine, engine, g, W, H);

    this.vignette.width = W; this.vignette.height = H;
    this.vignette.alpha = 0.55 * (1 - ramp(cine.since('world'), 3.5, 5.5));
    for (let i = this.glowUsed; i < this.glows.length; i++) this.glows[i].visible = false;
  }

  // ── Beats ────────────────────────────────────────────────────────────────

  private drawSingularity(cine: BigBangCinematic, g: Graphics, cx: number, cy: number, R: number, t: number): void {
    const d = cine.since('singularity');
    const end = cine.since('bang');
    if (end > 0.25) return;
    const swell = ramp(d, 0, 3.2), surge = ramp(d, 3.0, 3.5);
    const tremor = 3 * ramp(d, 2.2, 3.5);
    const jx = cx + (hash(Math.floor(t * 40)) - 0.5) * tremor;
    const jy = cy + (hash(Math.floor(t * 40) + 7) - 0.5) * tremor;
    const flick = 0.85 + 0.15 * Math.sin(t * 9) * Math.sin(t * 3.7);
    // Space falling inward: faint rings contracting onto the point.
    for (let i = 0; i < 4; i++) {
      const f = ((d * 0.45 + i / 4) % 1);
      const r = R * 0.9 * (1 - f) * (1 - surge * 0.6);
      g.circle(jx, jy, r).stroke({ color: 0x8c7cff, width: 1, alpha: 0.10 * f * ramp(d, 0.2, 1.4) });
    }
    this.glow(jx, jy, (60 + 160 * swell) * (1 + 3 * surge) * flick, 0xb8a8ff, 0.35 * ramp(d, 0, 1) + 0.4 * surge);
    this.glow(jx, jy, (14 + 26 * swell) * (1 + 2 * surge), 0xfff6e8, 0.8 * ramp(d, 0, 0.6) * flick + surge);
    const px = 2 + Math.round(2 * swell + 4 * surge);
    g.rect(Math.round(jx - px / 2), Math.round(jy - px / 2), px, px).fill({ color: 0xffffff, alpha: ramp(d, 0, 0.5) });
  }

  private drawBang(cine: BigBangCinematic, g: Graphics, fl: Graphics, W: number, H: number, cx: number, cy: number, R: number): void {
    const d = cine.since('bang');
    if (d < 0 || d > 3.5) return;
    // The flash: white, held, then burning off into the plasma.
    const fa = d < 0.06 ? d / 0.06 : d < 0.3 ? 1 : Math.exp(-(d - 0.3) * 2.0);
    fl.rect(0, 0, W, H).fill({ color: 0xfffcf4, alpha: Math.min(1, fa) });
    this.glow(cx, cy, R * (0.6 + 1.6 * ramp(d, 0, 1.2)), 0xfff2d0, 0.9 * Math.exp(-d * 0.9));
    // Shockwaves racing out: a bright edge with a soft wake.
    for (let i = 0; i < 3; i++) {
      const k = (d - 0.2 - i * 0.2) / 1.6;
      if (k <= 0 || k >= 1) continue;
      const e = 1 - Math.pow(1 - k, 3), r = R * 1.08 * e;
      g.circle(cx, cy, r).stroke({ color: 0xffe6b0, width: 26 * (1 - k) + 4, alpha: 0.18 * (1 - k) });
      g.circle(cx, cy, r).stroke({ color: 0xffffff, width: Math.max(1, 5 * (1 - k)), alpha: 0.9 * (1 - k) });
    }
    // Radial streaks: matter flung outward.
    const sk = (d - 0.15) / 2.2;
    if (sk > 0 && sk < 1) {
      for (let i = 0; i < 140; i++) {
        const a = hash(i * 3 + 1) * Math.PI * 2;
        const v = 0.35 + hash(i * 3 + 2) * 0.9;
        const r0 = R * Math.min(1.2, sk * v * 1.1), len = R * (0.05 + 0.2 * hash(i * 3 + 3)) * (1 - sk);
        const ca = Math.cos(a), sa = Math.sin(a);
        g.moveTo(cx + ca * r0, cy + sa * r0).lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len))
          .stroke({ color: hash(i) < 0.5 ? 0xffffff : 0xffd890, width: 1 + hash(i * 5) * 1.5, alpha: 0.8 * (1 - sk) });
      }
    }
  }

  private drawPlasma(cine: BigBangCinematic, W: number, H: number): void {
    const a = ramp(cine.since('bang'), 0.15, 0.7) * (1 - ramp(cine.since('cooling'), 0.6, 2.7));
    const base = this.plasmaBase, glow = this.plasmaGlow;
    base.visible = glow.visible = a > 0.002;
    if (!base.visible) return;
    base.width = glow.width = W;
    base.height = glow.height = H;
    const e = cine.since('bang');
    const cool = ramp(e, 0.2, 8.5);                                    // white-hot → red over the plasma beat
    const cmb = ramp(cine.since('cooling'), 0, 1.6);                   // red → the mottled afterglow
    // A glowing floor so the pockets between filaments are never black while it burns.
    const floor = mixHex(gradient(PLASMA, Math.min(1, cool + 0.32)), 0x0c0a14, cmb * 0.85);
    this.plasmaFloor.rect(0, 0, W, H).fill({ color: floor, alpha: a });
    // Expansion: the noise swells about the centre, so every feature rushes outward.
    const s1 = 3 * Math.exp(e * 0.09), s2 = 5 * Math.exp(e * 0.13);
    base.tileScale.set(s1);
    glow.tileScale.set(s2);
    base.tilePosition.set(W / 2 - (W / 2) * s1 + e * 9, H / 2 - (H / 2) * s1 - e * 5);
    glow.tilePosition.set(W / 2 - (W / 2) * s2 - e * 15, H / 2 - (H / 2) * s2 + e * 9);
    base.tint = mixHex(gradient(PLASMA, cool), gradient(CMB, ramp(cine.since('cooling'), 0.4, 2.6)), cmb);
    glow.tint = mixHex(gradient(PLASMA, Math.max(0, cool - 0.2)), 0x281c3a, cmb);
    base.alpha = a * (1 - 0.35 * cmb);
    glow.alpha = a * (0.7 - 0.4 * cmb);
  }

  private drawFirstStars(cine: BigBangCinematic, engine: BigBangEngine, g: Graphics, W: number, H: number): void {
    const d = cine.since('firstStars');
    if (d < -0.6 || d > 6.5) return;
    const cam = engine.currentCamera, sc = cam.scale;
    const stars = engine.stars;
    // Every star streams out of the centre: a streak behind it along its flight.
    const streak = ramp(d, -0.6, 0.4) * (1 - ramp(d, 3.5, 6.5));
    if (streak > 0.01) for (const st of stars) {
      const v = Math.hypot(st.vx, st.vy);
      if (v < 0.05) continue;
      const x = W / 2 + (st.x - cam.x) * sc, y = H / 2 + (st.y - cam.y) * sc;
      if (x < -60 || x > W + 60 || y < -60 || y > H + 60) continue;
      const L = Math.min(90, v * sc * 14 + 4);
      const ux = st.vx / v, uy = st.vy / v;
      const col = hash(st.id) < 0.6 ? 0xb8ccff : 0xffe2b0;
      g.moveTo(x, y).lineTo(x - ux * L, y - uy * L).stroke({ color: col, width: 1.5, alpha: 0.55 * streak });
      g.moveTo(x, y).lineTo(x - ux * L * 0.35, y - uy * L * 0.35).stroke({ color: 0xffffff, width: 2, alpha: 0.7 * streak });
    }
    const n = Math.min(stars.length, 220);
    for (let i = 0; i < n; i++) {
      const st = stars[Math.floor(i * stars.length / n)];
      const ti = -0.4 + hash(st.id * 7 + 3) * 5.6;
      const u = (d - ti) / 0.9;
      if (u < 0 || u > 1) continue;
      const x = W / 2 + (st.x - cam.x) * sc, y = H / 2 + (st.y - cam.y) * sc;
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      const k = 1 - u, len = 3 + 10 * k * k;
      const col = hash(st.id) < 0.6 ? 0xcfe0ff : 0xfff0d0;
      g.rect(Math.round(x - len), Math.round(y), Math.round(len * 2), 1).fill({ color: col, alpha: 0.9 * k });
      g.rect(Math.round(x), Math.round(y - len), 1, Math.round(len * 2)).fill({ color: col, alpha: 0.9 * k });
      this.glow(x, y, 10 + 22 * k, col, 0.55 * k);
    }
  }

  /** Nodes = the real galaxies plus seeded dwarf knots; edges = nearest neighbours. */
  private buildWeb(galaxies: Galaxy[], C: number): void {
    const live = galaxies.filter(gl => gl.starIds.length > 0);
    const key = live.map(gl => gl.id).join(',');
    if (this.web && this.webKey === key) return;
    this.webKey = key;
    let spread = 600;
    for (const gl of live) spread = Math.max(spread, Math.hypot(gl.cx - C, gl.cy - C));
    const nodes: WebNode[] = live.map(gl => ({ x: gl.cx, y: gl.cy, real: gl }));
    const seed = live.reduce((s, gl) => s * 31 + gl.id, 7);
    const extra = 26;
    for (let i = 0; i < extra; i++) {
      const a = hash(seed + i * 11) * Math.PI * 2;
      const r = Math.sqrt(hash(seed + i * 11 + 5)) * spread * 1.45;
      nodes.push({ x: C + Math.cos(a) * r, y: C + Math.sin(a) * r, real: null });
    }
    const edges: Array<[number, number, number]> = [];
    const seen = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      const near = nodes.map((nd, j) => ({ j, d: Math.hypot(nd.x - nodes[i].x, nd.y - nodes[i].y) }))
        .filter(o => o.j !== i).sort((p, q) => p.d - q.d).slice(0, nodes[i].real ? 4 : 3);
      for (const o of near) {
        const k = i < o.j ? `${i}-${o.j}` : `${o.j}-${i}`;
        if (seen.has(k) || o.d > spread * 1.3) continue;
        seen.add(k);
        edges.push([i, o.j, hash(seed + edges.length * 13) - 0.5]);
      }
    }
    this.web = { nodes, edges };
  }

  private drawWeb(cine: BigBangCinematic, engine: BigBangEngine, g: Graphics, W: number, H: number): void {
    const a = ramp(cine.since('web'), -0.5, 2.5) * (1 - ramp(cine.since('galaxies'), 0.5, 4.0));
    if (a <= 0.003) return;
    const C = 2800;
    this.buildWeb(engine.currentGalaxies, C);
    const web = this.web!;
    const cam = engine.currentCamera, sc = cam.scale;
    const P = (x: number, y: number) => [W / 2 + (x - cam.x) * sc, H / 2 + (y - cam.y) * sc] as const;
    const flow = cine.since('web');
    for (const [i, j, bend] of web.edges) {
      const A = web.nodes[i], B = web.nodes[j];
      const strong = !!(A.real || B.real);
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      const dx = B.x - A.x, dy = B.y - A.y;
      const qx = mx - dy * bend * 0.45, qy = my + dx * bend * 0.45;
      const pts: Array<readonly [number, number]> = [];
      const SEG = 22;
      for (let s = 0; s <= SEG; s++) {
        const u = s / SEG, iu = 1 - u;
        // A slow wobble across the curve so threads read as gas, not wire.
        const len = Math.hypot(dx, dy) || 1;
        const wob = Math.sin(u * Math.PI) * Math.sin(u * 9.4 + bend * 20 + flow * 0.35) * len * 0.035;
        const bx = iu * iu * A.x + 2 * iu * u * qx + u * u * B.x - dy / len * wob;
        const by = iu * iu * A.y + 2 * iu * u * qy + u * u * B.y + dx / len * wob;
        pts.push(P(bx, by));
      }
      // Gas sheath, then the bright thread.
      for (const [w, al] of [[9, 0.045], [3, 0.08], [1, strong ? 0.42 : 0.24]] as const) {
        g.moveTo(pts[0][0], pts[0][1]);
        for (let s = 1; s < pts.length; s++) g.lineTo(pts[s][0], pts[s][1]);
        g.stroke({ color: 0x9aa6ff, width: w, alpha: al * a });
      }
      // Matter streaming along the thread toward the galaxy it feeds.
      const toB = B.real && !A.real ? true : A.real && !B.real ? false : hash(i * 31 + j) < 0.5;
      for (let k = 0; k < 4; k++) {
        let u = (flow * 0.11 + k / 4 + hash(i * 7 + j * 13)) % 1;
        if (!toB) u = 1 - u;
        const idx = Math.min(SEG - 1, Math.floor(u * SEG)), f = u * SEG - idx;
        const x = lerp(pts[idx][0], pts[idx + 1][0], f), y = lerp(pts[idx][1], pts[idx + 1][1], f);
        g.rect(Math.round(x) - 1, Math.round(y) - 1, 2, 2).fill({ color: 0xdfe4ff, alpha: 0.75 * a });
      }
    }
    // Knots: the galaxies gather where threads meet.
    const grow = ramp(cine.since('web'), 0, 6);
    for (const nd of web.nodes) {
      const [x, y] = P(nd.x, nd.y);
      if (nd.real) {
        this.glow(x, y, nd.real.radius * 2.6 * sc * (0.5 + 0.5 * grow), cssHex(nd.real.color), 0.55 * a);
      } else {
        this.glow(x, y, 26, 0x9aa6ff, 0.35 * a);
        g.rect(Math.round(x) - 1, Math.round(y) - 1, 2, 2).fill({ color: 0xe8ecff, alpha: 0.8 * a });
      }
    }
  }

  private drawHomeGalaxy(cine: BigBangCinematic, engine: BigBangEngine, g: Graphics, W: number, H: number): void {
    const a = ramp(cine.since('galaxies'), 2.0, 3.0) * (1 - ramp(cine.since('dive'), 0.6, 1.6));
    if (a <= 0.003) return;
    const ps = engine.getPlayerStar();
    const gal = ps ? engine.currentGalaxies.find(q => q.id === ps.galaxyId) : undefined;
    if (!gal) return;
    const cam = engine.currentCamera, sc = cam.scale;
    const x = W / 2 + (gal.cx - cam.x) * sc, y = H / 2 + (gal.cy - cam.y) * sc;
    const r = gal.radius * 1.15 * sc + 6;
    const pulse = 0.75 + 0.25 * Math.sin(cine.t * 4);
    // Pixel ring of dots, and gold corner brackets like the YOUR WORLD marker.
    const n = Math.max(24, Math.round(r * 0.6));
    for (let i = 0; i < n; i++) {
      const th = i / n * Math.PI * 2 + cine.t * 0.15;
      g.rect(Math.round(x + Math.cos(th) * r) - 1, Math.round(y + Math.sin(th) * r) - 1, 2, 2).fill({ color: 0xffcc44, alpha: 0.7 * a * pulse });
    }
    const p = r + 8, arm = 9;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const bx = x + sx * p, by = y + sy * p;
      g.rect(sx < 0 ? bx : bx - arm, sy < 0 ? by : by - 2, arm, 2).fill({ color: 0xffcc44, alpha: a * pulse });
      g.rect(sx < 0 ? bx : bx - 2, sy < 0 ? by : by - arm, 2, arm).fill({ color: 0xffcc44, alpha: a * pulse });
    }
    this.homeLabel.visible = true;
    this.homeLabel.alpha = a;
    this.homeLabel.x = Math.round(x);
    this.homeLabel.y = Math.round(y + p + 14);
  }

  private drawIgnition(cine: BigBangCinematic, engine: BigBangEngine, g: Graphics, W: number, H: number): void {
    const dv = cine.since('dive'), ig = cine.since('ignition'), wd = cine.since('world');
    if (dv < 3.2) return;
    const ps = engine.getPlayerStar() as StarBody | undefined;
    if (!ps) return;
    const cam = engine.currentCamera, sc = cam.scale;
    const P = (x: number, y: number) => [W / 2 + (x - cam.x) * sc, H / 2 + (y - cam.y) * sc] as const;
    const [sx, sy] = P(ps.x, ps.y);
    const anim = engine.currentAnimTick;

    // The protoplanetary disc: dust on Kepler orbits, hot within, sooty without.
    // Sized to the inner system as framed during ignition (scale ~3), so it
    // reads as one dense disc rather than spray across the whole screen.
    let outer = 40;
    for (const pl of ps.planets) outer = Math.max(outer, pl.orbitalRadius * 1.15);
    outer = Math.min(outer, H * 0.36 / 3.0);
    const inner = Math.max(4, ps.radius * 2.2);
    const discA = ramp(dv, 3.4, 4.8) * (1 - 0.9 * engine.planetsReveal);
    if (discA > 0.003) {
      // Warm haze of the disc and the collapsing cloud, beneath the dust.
      const cloud = 1 - ramp(ig, 0.2, 1.4);
      this.glow(sx, sy, outer * 2.7 * sc * (1 + 0.5 * cloud), 0x8a4428, 0.4 * discA * (0.55 + 0.45 * cloud));
      this.glow(sx, sy, outer * 1.3 * sc, 0xd88a48, 0.22 * discA);
      const N = 2400;
      const light = 0.55 + 0.45 * engine.homeStarLight;
      for (let i = 0; i < N; i++) {
        const h1 = hash(i * 5 + 1), h2 = hash(i * 5 + 2), h3 = hash(i * 5 + 3), h4 = hash(i * 5 + 4);
        const rr = inner + (outer - inner) * Math.pow(h1, 0.75);
        // Infall before ignition: the cloud is still contracting onto the disc.
        const fall = 1 + 0.7 * (1 - ramp(ig, -1.5, 1.2)) * h3;
        const w = 0.02 * Math.pow(outer / rr, 1.5);
        // Two trailing spiral arms of denser dust.
        const arm = (h4 < 0.55 ? 0 : 1) * Math.PI + Math.log(rr / inner) * 2.2;
        const th = (h4 < 0.7 ? arm + (h2 - 0.5) * 0.9 : h2 * Math.PI * 2) + anim * w * 0.12;
        const [x, y] = P(ps.x + Math.cos(th) * rr * fall, ps.y + Math.sin(th) * rr * fall);
        if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;
        const heat = 1 - (rr - inner) / (outer - inner);
        const col = gradient([0x6a5048, 0xa8703e, 0xe8a050, 0xfff0b0], Math.min(1, heat * light + 0.1));
        const sz = h3 < 0.45 ? 2 : 1;
        g.rect(Math.round(x), Math.round(y), sz, sz).fill({ color: col, alpha: discA * (0.45 + 0.5 * h1) });
      }
    }

    // Ignition: a flash, a ring, rays.
    if (ig >= 0 && wd < 1.5) {
      const f = ig - 1.1;
      // Before: the protostar smoulders and brightens.
      if (f < 0) this.glow(sx, sy, 30 + 30 * ramp(ig, 0, 1.1), 0xff7040, 0.5 + 0.4 * ramp(ig, 0, 1.1));
      if (f >= 0) {
        const fa = f < 0.06 ? f / 0.06 : Math.exp(-(f - 0.06) * 1.25);
        this.glow(sx, sy, 80 + 1600 * ramp(f, 0, 0.8), 0xfff0d0, 0.95 * fa);
        this.glow(sx, sy, 60 + 300 * ramp(f, 0, 0.4), 0xffffff, fa);
        const k = f / 1.8;
        if (k < 1) {
          const e = 1 - Math.pow(1 - k, 3);
          const rr = 12 + Math.hypot(W, H) * 0.6 * e;
          g.circle(sx, sy, rr).stroke({ color: 0xffd890, width: 22 * (1 - k) + 3, alpha: 0.14 * (1 - k) });
          g.circle(sx, sy, rr).stroke({ color: 0xfffaf0, width: Math.max(1, 3.5 * (1 - k)), alpha: 0.85 * (1 - k) });
        }
        const ra = Math.exp(-f * 1.1);
        for (let i = 0; i < 18; i++) {
          const th = i / 18 * Math.PI * 2 + f * 0.25;
          const len = (120 + 220 * hash(i * 9)) * (0.6 + 0.4 * Math.sin(f * 6 + i));
          g.moveTo(sx + Math.cos(th) * 14, sy + Math.sin(th) * 14)
            .lineTo(sx + Math.cos(th) * (14 + len), sy + Math.sin(th) * (14 + len))
            .stroke({ color: 0xfff0c0, width: 2, alpha: 0.5 * ra });
        }
      }
    }

    // The molten world glows as it forms.
    if (wd > -0.5) {
      const home = engine.homeWorld(ps);
      if (home) {
        const o = planetOffsetFromStar(home, anim);
        const [hx, hy] = P(ps.x + o.x, ps.y + o.y);
        const body = Math.max(home.radius * 3.2, 2 / sc) * sc;
        this.glow(hx, hy, body * 3.2, 0xff6a28, 0.45 * engine.planetsReveal * (1 - ramp(wd, 3.5, 5.5) * 0.6));
      }
    }
  }
}
