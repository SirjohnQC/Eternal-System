/**
 * SkyDebris — a few small rocks and dust motes drifting through the home-world
 * sky, behind the planet (drawn in the far-space pass, before the body).
 *
 * Stateless per frame: each body's position is a pure function of elapsed
 * time and a per-world seed, from typed arrays filled once per world. No
 * allocation in the frame path. Rocks tumble (the lit pixel walks round the
 * body) and nearer ones are bigger and faster (parallax).
 *
 * Pixel sizes: dust 1 px, pebble 2 px, rock 3 px (virtual px at zoom 1;
 * multiplied by round(k) when zoomed). Count: 6 dust + 5 rocks.
 */

const N = 11;
const N_DUST = 6;

export class SkyDebris {
  private seed = -1;
  private x0 = new Float32Array(N);
  private y0 = new Float32Array(N);
  private vx = new Float32Array(N);
  private vy = new Float32Array(N);
  private size = new Uint8Array(N);
  private tone = new Uint8Array(N);
  private spin = new Float32Array(N);

  /** Rock palette by tone: [shadow, body, lit]; tone 0 grey stone, 1 brown, 2 rust. */
  private static readonly PAL: string[][] = [
    ['#3a3a42', '#6c6a70', '#b4b0aa'],
    ['#3c342e', '#6e5e50', '#bca88c'],
    ['#40281e', '#7a4a34', '#c88a62'],
  ];
  private static readonly DUST = ['rgba(180,170,160,0.55)', 'rgba(150,160,190,0.5)', 'rgba(200,180,150,0.45)'];

  private reseed(seed: number): void {
    this.seed = seed;
    let s = (seed * 2654435761 ^ 0x5bd1e995) >>> 0 || 1;
    const r = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
    for (let i = 0; i < N; i++) {
      const rock = i >= N_DUST;
      this.size[i] = rock ? (r() < 0.45 ? 3 : 2) : 1;
      this.x0[i] = r();
      // Sky band: the upper 70% of the frame (the planet hides the rest).
      this.y0[i] = 0.04 + r() * 0.66;
      const dir = r() < 0.5 ? -1 : 1;
      // px/s: dust 1.2-3, rocks 2.5-7 (nearer = faster).
      const sp = rock ? 2.5 + r() * 4.5 * (this.size[i] / 3) : 1.2 + r() * 1.8;
      this.vx[i] = dir * sp;
      this.vy[i] = (r() - 0.5) * sp * 0.35;
      this.tone[i] = Math.floor(r() * 3);
      this.spin[i] = 0.4 + r() * 1.2;
    }
  }

  /**
   * @param elapsed seconds
   * @param seed per-world seed (the bodies re-roll when it changes)
   * @param lightX sun direction on screen, -1 (left) .. 1 (right)
   * @param k zoom (pixels scale by round(k), capped at 3)
   */
  draw(g: CanvasRenderingContext2D, VW: number, VH: number, elapsed: number, seed: number, lightX: number, k: number): void {
    if (seed !== this.seed) this.reseed(seed);
    const W = VW + 16, H = VH * 0.8;
    const p = Math.max(1, Math.min(3, Math.round(k)));
    for (let i = 0; i < N; i++) {
      let x = (this.x0[i] * W + this.vx[i] * elapsed) % W;
      if (x < 0) x += W;
      let y = (this.y0[i] * VH + this.vy[i] * elapsed) % H;
      if (y < 0) y += H;
      x = Math.round(x - 8); y = Math.round(y);
      const s = this.size[i];
      if (s === 1) {
        g.fillStyle = SkyDebris.DUST[this.tone[i]];
        g.fillRect(x, y, p, p);
        continue;
      }
      const pal = SkyDebris.PAL[this.tone[i]];
      const d = s * p;
      // Lumpy body: a plus-shape for 3 px, a square for 2 px.
      g.fillStyle = pal[1];
      if (s === 3) { g.fillRect(x + p, y, p, d); g.fillRect(x, y + p, d, p); g.fillRect(x + (lightX > 0 ? 0 : 2 * p), y + 2 * p, p, p); }
      else g.fillRect(x, y, d, d);
      // Tumble: the lit pixel walks round the rim, biased to the sun side.
      const a = elapsed * this.spin[i] + i;
      const lx = Math.cos(a) * 0.6 + lightX * 0.8, ly = Math.sin(a) * 0.6 - 0.5;
      const cx = x + (lx > 0.25 ? d - p : lx < -0.25 ? 0 : (d - p) >> 1);
      const cy = y + (ly > 0.25 ? d - p : ly < -0.25 ? 0 : (d - p) >> 1);
      g.fillStyle = pal[2];
      g.fillRect(cx, cy, p, p);
      if (s === 3) {
        g.fillStyle = pal[0];
        g.fillRect(x + d - p - (cx - x), y + d - p - (cy - y), p, p);
      }
    }
  }
}
