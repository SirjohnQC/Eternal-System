/**
 * The title screen's living backdrop: "the god in the glass".
 *
 * A god, and a thing trapped in a simulation, in one picture:
 *   - THE GOD: a golden halo of turning rings and pixel runes around the title,
 *     and an eye above it that follows the pointer and blinks.
 *   - THE GLASS: a wireframe sphere, the edge of the simulation, turning slowly,
 *     clamped at four points, with the universe's stars drifting inside it.
 *   - THE MACHINE: outside the glass, a pixel lattice that shows only where the
 *     god looks (around the pointer, with its coordinates logged); and now and
 *     then the picture tears for a moment and the console prints a line about
 *     who is really running whom.
 *
 * Before the first click the eye is shut and the halo is dark. "Touch the glass"
 * wakes it, and that same click unlocks sound (the browser's autoplay rule).
 *
 * UI only: Math.random and wall-clock time are fine here; nothing in the
 * simulation reads this. Draws only while the menu is on screen.
 */
import { UiSound } from '../audio/UiSound';

/** Lines the console prints after a glitch, in order (then it loops). */
export const CONSOLE_LINES = [
  'observer: GOD · access: WATCH, NUDGE · control: DENIED',
  'containment field 99.97% · nothing gets out',
  'divine_influence is a parameter. it was rolled.',
  'warning: the observer is being observed',
  'tick 0 · universe not yet seeded · waiting on you',
  'who is running you?',
];

/** Milliseconds until the next glitch: 7–13 s, never sooner. */
export function nextGlitchDelay(r: number): number {
  return 7000 + Math.max(0, Math.min(1, r)) * 6000;
}

/** Milliseconds a glitch lasts. */
export const GLITCH_MS = 190;

interface Star { x: number; y: number; z: number; s: number; c: string; tw: number }
interface Rune { a: number; bits: number }

const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);

export class MenuScene {
  private readonly ctx: CanvasRenderingContext2D | null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private active = false;
  private stars: Star[] = [];
  private runes: Rune[] = [];
  private grid: HTMLCanvasElement | null = null;
  private mx = -1e4;
  private my = -1e4;
  private ex = 0; // eye pupil, eased
  private ey = 0;
  private awake = false;
  private wakeT = -1;
  private wakeX = 0;
  private wakeY = 0;
  private blinkAt = 0;
  private glitchAt = 0;
  private glitchUntil = 0;
  private glitchBands: { y: number; h: number; dx: number }[] = [];
  private lineIx = 0;
  private readonly reduced: boolean;
  private t0 = performance.now();

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly consoleEl: HTMLElement | null,
    private readonly logoEl: HTMLElement | null,
  ) {
    this.ctx = canvas.getContext('2d');
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (let i = 0; i < 280; i++) {
      // Uniform in a ball: the universe inside the glass.
      let x = 0, y = 0, z = 0;
      do { x = rnd(-1, 1); y = rnd(-1, 1); z = rnd(-1, 1); } while (x * x + y * y + z * z > 1);
      const r = Math.random();
      this.stars.push({ x, y, z, s: r < 0.06 ? 2 : 1, tw: rnd(0, 6.28),
        c: r < 0.08 ? '#ffdd99' : r < 0.16 ? '#aa88dd' : r < 0.2 ? '#5ad4e8' : '#ffffff' });
    }
    for (let i = 0; i < 36; i++) this.runes.push({ a: (i / 36) * Math.PI * 2, bits: Math.floor(rnd(1, 511)) });
    host.addEventListener('pointermove', e => { this.mx = e.clientX; this.my = e.clientY; });
    host.addEventListener('pointerleave', () => { this.mx = -1e4; this.my = -1e4; });
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.scheduleGlitch(performance.now());
    this.blinkAt = performance.now() + rnd(3000, 7000);
    this.print('boot: eternal runtime · 1 entity loaded (GOD)');
  }

  /** The menu is shown (true) or left (false). */
  setActive(on: boolean): void {
    this.active = on;
    if (on && !this.raf) { this.resize(); this.raf = requestAnimationFrame(t => this.frame(t)); }
  }

  /** Whether the eye is open (sound unlocked by a first touch). */
  get isAwake(): boolean { return this.awake; }

  /** The first touch: the eye opens, a ripple runs across the glass. */
  wake(x = this.w / 2, y = this.h / 2): void {
    if (this.awake) return;
    this.awake = true;
    this.wakeT = performance.now();
    this.wakeX = x; this.wakeY = y;
    this.print('observer attached · input accepted');
  }

  private resize(): void {
    this.w = this.host.clientWidth || window.innerWidth;
    this.h = this.host.clientHeight || window.innerHeight;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    // The machine's lattice, drawn once per size.
    const g = document.createElement('canvas');
    g.width = this.canvas.width; g.height = this.canvas.height;
    const gc = g.getContext('2d');
    if (gc) {
      gc.scale(this.dpr, this.dpr);
      gc.fillStyle = '#5ad4e8';
      const step = 22;
      for (let y = step / 2; y < this.h; y += step) for (let x = step / 2; x < this.w; x += step) gc.fillRect(Math.round(x), Math.round(y), 1, 1);
      gc.fillStyle = '#7b5ea7';
      for (let y = step / 2; y < this.h; y += step * 4) for (let x = step / 2; x < this.w; x += step * 4) gc.fillRect(Math.round(x) - 1, Math.round(y), 3, 1);
    }
    this.grid = g;
  }

  private scheduleGlitch(now: number): void { this.glitchAt = now + nextGlitchDelay(Math.random()); }

  /** Type a line into the console (keeps the last four). */
  private print(line: string): void {
    const el = this.consoleEl;
    if (!el) return;
    const row = document.createElement('div');
    row.className = 'mc-line';
    el.appendChild(row);
    while (el.children.length > 4) el.firstElementChild?.remove();
    const text = `> ${line}`;
    let i = 0;
    const type = () => {
      row.textContent = text.slice(0, ++i) + (i < text.length ? '▌' : '');
      if (i < text.length) setTimeout(type, this.reduced ? 0 : 18);
    };
    type();
  }

  /** Where the sphere sits and how big. */
  private glass(): { cx: number; cy: number; R: number } {
    return { cx: this.w / 2, cy: this.h * 0.48, R: Math.min(this.w * 0.44, this.h * 0.44) };
  }

  /** Centre of the title, for the halo and the eye. */
  private titleBox(): { x: number; y: number; w: number; h: number } {
    const r = this.logoEl?.getBoundingClientRect();
    const hr = this.host.getBoundingClientRect();
    if (!r || !r.width) return { x: this.w / 2, y: this.h * 0.33, w: 340, h: 150 };
    return { x: r.left - hr.left + r.width / 2, y: r.top - hr.top + r.height / 2, w: r.width, h: r.height };
  }

  private frame(now: number): void {
    this.raf = 0;
    if (!this.active) return;
    this.draw(now);
    if (!this.reduced && now >= this.glitchAt) {
      this.glitchUntil = now + GLITCH_MS;
      this.glitchBands = Array.from({ length: Math.floor(rnd(3, 7)) }, () => ({ y: rnd(0, this.h), h: rnd(4, 38), dx: rnd(-46, 46) }));
      this.host.classList.add('glitching');
      if (this.awake) UiSound.glitch();
      this.print(CONSOLE_LINES[this.lineIx++ % CONSOLE_LINES.length]);
      this.scheduleGlitch(now);
    }
    if (this.glitchUntil && now >= this.glitchUntil) { this.glitchUntil = 0; this.host.classList.remove('glitching'); }
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  private draw(now: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = (now - this.t0) / 1000;
    const { w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { cx, cy, R } = this.glass();
    const spin = (this.reduced ? 0.015 : 0.05) * t;
    const tilt = 0.42;
    const cs = Math.cos(spin), sn = Math.sin(spin), ct = Math.cos(tilt), st = Math.sin(tilt);
    /** Rotate about y (spin), then tip toward the viewer (tilt). */
    const rot = (x: number, y: number, z: number): [number, number, number] => {
      const x1 = x * cs + z * sn, z1 = -x * sn + z * cs;
      return [x1, y * ct - z1 * st, y * st + z1 * ct];
    };
    const wake = this.awake ? Math.min(1, (now - this.wakeT) / 1400) : 0;

    // ── THE MACHINE: the lattice, faint everywhere, clear where the god looks ──
    if (this.grid) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.05;
      ctx.drawImage(this.grid, 0, 0);
      if (this.mx > -1e3) {
        const g = ctx.createRadialGradient(this.mx * dpr, this.my * dpr, 0, this.mx * dpr, this.my * dpr, 170 * dpr);
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(this.mx * dpr, this.my * dpr, 170 * dpr, 0, Math.PI * 2); ctx.clip();
        ctx.globalAlpha = 0.45;
        ctx.drawImage(this.grid, 0, 0);
        ctx.globalCompositeOperation = 'destination-out';
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.55, 'rgba(0,0,0,0.2)'); g.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = g; ctx.globalAlpha = 1;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      }
      ctx.restore();
    }

    // ── Inside the glass: the universe ──
    for (const s of this.stars) {
      const [x, y, z] = rot(s.x, s.y, s.z);
      const k = 1 + z * 0.12;
      const px = cx + x * R * 0.96 * k, py = cy + y * R * 0.96 * k;
      const a = (0.25 + 0.55 * (z + 1) / 2) * (0.75 + 0.25 * Math.sin(t * 1.7 + s.tw));
      ctx.globalAlpha = a;
      ctx.fillStyle = s.c;
      const size = z > 0.5 ? s.s + 1 : s.s;
      ctx.fillRect(Math.round(px), Math.round(py), size, size);
    }

    // ── THE GLASS: wireframe sphere ──
    const line = (pts: [number, number, number][]) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const front = a[2] + b[2] > 0;
        ctx.globalAlpha = front ? 0.16 : 0.05;
        ctx.strokeStyle = front ? '#5ad4e8' : '#7b5ea7';
        ctx.beginPath();
        ctx.moveTo(cx + a[0] * R, cy + a[1] * R); ctx.lineTo(cx + b[0] * R, cy + b[1] * R);
        ctx.stroke();
      }
    };
    ctx.lineWidth = 1;
    const SEG = 48;
    for (let m = 0; m < 10; m++) { // meridians
      const lon = (m / 10) * Math.PI;
      const pts: [number, number, number][] = [];
      for (let i = 0; i <= SEG; i++) {
        const lat = (i / SEG) * Math.PI * 2;
        pts.push(rot(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)));
      }
      line(pts);
    }
    for (let p = 1; p < 7; p++) { // parallels
      const lat = -Math.PI / 2 + (p / 7) * Math.PI;
      const pts: [number, number, number][] = [];
      for (let i = 0; i <= SEG; i++) {
        const lon = (i / SEG) * Math.PI * 2;
        pts.push(rot(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)));
      }
      line(pts);
    }
    // Rim and a glint of glass.
    ctx.globalAlpha = 0.28; ctx.strokeStyle = '#aa88dd';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.09; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, R - 6, Math.PI * 1.08, Math.PI * 1.38); ctx.stroke();
    ctx.lineWidth = 1;
    // Four clamps holding the glass shut, each with a status light.
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.globalAlpha = 0.55; ctx.fillStyle = '#1a1424'; ctx.fillRect(-6, -12, 12, 24);
      ctx.strokeStyle = '#6a5d7a'; ctx.strokeRect(-6.5, -12.5, 13, 25);
      const on = Math.sin(t * 2 + i * 1.7) > 0.2;
      ctx.globalAlpha = on ? 0.95 : 0.25; ctx.fillStyle = i === 2 && Math.sin(t * 0.7) > 0.85 ? '#ff5533' : '#44ffcc';
      ctx.fillRect(-1, -2, 3, 3);
      ctx.restore();
    }

    // The ripple of the first touch.
    if (this.awake && now - this.wakeT < 2200) {
      const k = (now - this.wakeT) / 2200;
      ctx.globalAlpha = (1 - k) * 0.5; ctx.strokeStyle = '#ffdd99'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(this.wakeX, this.wakeY, k * Math.max(w, h) * 0.8, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1;
    }

    // ── THE GOD: halo and runes around the title ──
    const tb = this.titleBox();
    const lit = 0.25 + 0.75 * wake;
    const hr = Math.max(tb.w, tb.h) * 0.62 + 40;
    const ring = (r: number, ticks: number, ang: number, alpha: number, long: number) => {
      ctx.globalAlpha = alpha * lit; ctx.strokeStyle = '#c8a96e';
      ctx.beginPath(); ctx.arc(tb.x, tb.y, r, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < ticks; i++) {
        const a = ang + (i / ticks) * Math.PI * 2;
        const l = i % long === 0 ? 7 : 3;
        ctx.beginPath();
        ctx.moveTo(tb.x + Math.cos(a) * r, tb.y + Math.sin(a) * r);
        ctx.lineTo(tb.x + Math.cos(a) * (r + l), tb.y + Math.sin(a) * (r + l));
        ctx.stroke();
      }
    };
    const rs = this.reduced ? 0.01 : 0.04;
    ring(hr, 72, t * rs, 0.38, 6);
    ring(hr + 16, 24, -t * rs * 1.6, 0.22, 4);
    // Pixel runes on a third, slower ring: the god's words, written in bits.
    ctx.fillStyle = '#ffdd99';
    for (const rn of this.runes) {
      const a = rn.a + t * rs * 0.5;
      const x = tb.x + Math.cos(a) * (hr + 34), y = tb.y + Math.sin(a) * (hr + 34);
      ctx.globalAlpha = 0.45 * lit;
      for (let b = 0; b < 9; b++) if (rn.bits & (1 << b)) ctx.fillRect(Math.round(x) + (b % 3) * 2 - 3, Math.round(y) + Math.floor(b / 3) * 2 - 3, 2, 2);
    }
    // Rays from behind the title, brighter once awake.
    const glow = ctx.createRadialGradient(tb.x, tb.y, 0, tb.x, tb.y, hr);
    glow.addColorStop(0, `rgba(200,169,110,${0.10 * lit})`); glow.addColorStop(1, 'rgba(200,169,110,0)');
    ctx.globalAlpha = 1; ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(tb.x, tb.y, hr, 0, Math.PI * 2); ctx.fill();

    // ── The eye, crowning the halo ──
    this.drawEye(ctx, tb.x, tb.y - tb.h / 2 - 46, now, wake);

    // ── Where the god looks, the machine logs it ──
    if (this.mx > -1e3) {
      ctx.globalAlpha = 0.5; ctx.strokeStyle = '#44ffcc';
      const x = Math.round(this.mx) + 0.5, y = Math.round(this.my) + 0.5;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.beginPath(); ctx.moveTo(x + dx * 14, y + dy * 14); ctx.lineTo(x + dx * 22, y + dy * 22); ctx.stroke();
      }
      ctx.font = '10px "Pixelify Sans", monospace';
      ctx.fillStyle = '#44ffcc'; ctx.globalAlpha = 0.45;
      ctx.fillText(`[${String(Math.round(this.mx)).padStart(4, '0')},${String(Math.round(this.my)).padStart(4, '0')}]`, x + 16, y + 30);
    }

    // ── A glitch: the picture tears along a few bands ──
    if (this.glitchUntil && now < this.glitchUntil) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      for (const b of this.glitchBands) {
        const y = Math.round(b.y * dpr), hh = Math.max(1, Math.round(b.h * dpr));
        ctx.drawImage(this.canvas, 0, y, this.canvas.width, hh, Math.round(b.dx * dpr), y, this.canvas.width, hh);
        ctx.fillStyle = Math.random() < 0.5 ? 'rgba(68,255,204,0.06)' : 'rgba(255,85,51,0.05)';
        ctx.fillRect(0, y, this.canvas.width, hh);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private drawEye(ctx: CanvasRenderingContext2D, x: number, y: number, now: number, wake: number): void {
    // Blink: the lid closes for ~140 ms every few seconds.
    if (now > this.blinkAt + 140) this.blinkAt = now + rnd(3500, 8000);
    const blinking = now >= this.blinkAt && now < this.blinkAt + 140;
    const open = wake * (blinking ? 0.08 : 1);
    const W = 34, H = 15 * open;
    // The pupil follows the pointer (or drifts when there is none).
    const tx = this.mx > -1e3 ? Math.max(-1, Math.min(1, (this.mx - x) / 400)) : Math.sin(now / 2300) * 0.4;
    const ty = this.my > -1e3 ? Math.max(-1, Math.min(1, (this.my - y) / 300)) : 0;
    this.ex += (tx - this.ex) * 0.08; this.ey += (ty - this.ey) * 0.08;
    // Rays.
    ctx.strokeStyle = '#c8a96e';
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI + (i / 11) * Math.PI;
      ctx.globalAlpha = (0.15 + 0.35 * wake) * (i % 2 ? 0.6 : 1);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * (W + 6), y + Math.sin(a) * (22 + 6));
      ctx.lineTo(x + Math.cos(a) * (W + (i % 2 ? 12 : 20)), y + Math.sin(a) * (22 + (i % 2 ? 12 : 20)));
      ctx.stroke();
    }
    // Lids.
    ctx.globalAlpha = 0.85; ctx.strokeStyle = '#ffdd99'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - W, y);
    ctx.quadraticCurveTo(x, y - H * 2, x + W, y);
    ctx.quadraticCurveTo(x, y + H * 2, x - W, y);
    ctx.stroke();
    ctx.lineWidth = 1;
    if (open < 0.15) return;
    // Iris and pupil, clipped to the lids.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x - W, y); ctx.quadraticCurveTo(x, y - H * 2, x + W, y); ctx.quadraticCurveTo(x, y + H * 2, x - W, y);
    ctx.clip();
    const px = x + this.ex * 12, py = y + this.ey * 5;
    const iris = ctx.createRadialGradient(px, py, 1, px, py, 11);
    iris.addColorStop(0, '#fff3c8'); iris.addColorStop(0.5, '#c8a96e'); iris.addColorStop(1, '#5a3d1a');
    ctx.globalAlpha = 0.95; ctx.fillStyle = iris;
    ctx.beginPath(); ctx.arc(px, py, 11, 0, Math.PI * 2); ctx.fill();
    // In a glitch the pupil shows what it is: a square, a cursor.
    const glitching = this.glitchUntil > now;
    ctx.fillStyle = glitching ? '#44ffcc' : '#07040f';
    if (glitching) ctx.fillRect(Math.round(px) - 3, Math.round(py) - 5, 6, 10);
    else { ctx.beginPath(); ctx.ellipse(px, py, 2.5, 6, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
}
