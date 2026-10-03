/**
 * Dev-only frame-budget bench for the zoom camera (spec 5b). Installed by the
 * diorama preview page as `window.__zoomBench(opts)`; driven headless by
 * tools/zoomBench.ts over the Chrome DevTools Protocol. Not in the game bundle.
 *
 * Scripted gesture, through the renderer's own ZoomController (the object the
 * real wheel / pointer handlers forward to):
 *   1. back to zoom 1, then wheel notches at the mount centre up to zoom 4;
 *      wait until the camera set is shown (settled);
 *   2. a pointer drag of `dragMs` along a Lissajous path (amplitude `ampX`,
 *      `ampY` CSS px), one panMove per animation frame;
 *   3. release, then keep recording for `tailMs` (settle, re-centre bake, swap).
 * Every requestAnimationFrame interval is recorded with performance.now().
 * The engine's bake entry points are wrapped to time each call in-page.
 */
type AnyR = any;

export interface ZoomBenchOpts {
  dragMs?: number; tailMs?: number; ampX?: number; ampY?: number; settleMs?: number;
}

export interface ZoomBenchResult {
  frames: number; max: number; p95: number; median: number;
  over33: Array<{ i: number; ms: number; phase: string }>;
  byPhase: Record<string, { n: number; max: number; p95: number; median: number }>;
  bakes: Array<{ name: string; ms: number; phase: string }>;
  zoom: number; shownAtEnd: boolean; mount: { w: number; h: number }; VW: number; VH: number;
}

const rafP = () => new Promise<number>(res => requestAnimationFrame(res));
const stat = (a: number[]) => {
  if (!a.length) return { n: 0, max: 0, p95: 0, median: 0 };
  const s = [...a].sort((x, y) => x - y);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { n: a.length, max: s[s.length - 1], p95: q(0.95), median: q(0.5) };
};

export function installZoomBench(renderer: AnyR): void {
  (window as AnyR).__zoomBench = async (o: ZoomBenchOpts = {}): Promise<ZoomBenchResult> => {
    const dragMs = o.dragMs ?? 3000, tailMs = o.tailMs ?? 1500;
    const ampX = o.ampX ?? 260, ampY = o.ampY ?? 120;
    const r = renderer, z = r.zoom, e = r.cutaway;
    const box = r.mount.getBoundingClientRect();
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    let phase = 'setup';
    const bakes: ZoomBenchResult['bakes'] = [];
    // Time every bake entry point the engine has (Task 7: setCamera; 5b adds
    // the re-centre steps). Wrapped on the instance, restored at the end.
    const names = ['setCamera', 'recentreStep', 'stepRecentre'].filter(n => typeof e[n] === 'function');
    const orig: Record<string, AnyR> = {};
    for (const n of names) {
      orig[n] = e[n];
      e[n] = function (this: AnyR, ...args: AnyR[]) {
        const t0 = performance.now();
        try { return orig[n].apply(this, args); } finally { bakes.push({ name: n, ms: performance.now() - t0, phase }); }
      };
    }
    try {
      z.reset(); r.updateView?.(performance.now());
      for (let i = 0; i < 6; i++) await rafP();
      for (let i = 0; i < 12; i++) { z.wheel(0, 0, -1, performance.now()); await rafP(); }
      const t0 = performance.now();
      while (!(z.showCamera && e.showCamera) && performance.now() - t0 < 3000) await rafP();
      // Let any re-centre / first-frame work finish before recording.
      for (let i = 0; i < 30; i++) await rafP();
      bakes.length = 0;

      const deltas: number[] = [], phases: string[] = [];
      let last = await rafP();
      const rec = (now: number) => { deltas.push(now - last); phases.push(phase); last = now; };
      phase = 'drag';
      z.panStart(cx, cy, performance.now());
      const d0 = performance.now();
      for (;;) {
        const now = await rafP();
        rec(now);
        const s = (now - d0) / dragMs;
        if (s >= 1) break;
        const a = s * Math.PI * 2;
        z.panMove(cx + Math.sin(a) * ampX, cy + Math.sin(a * 2) * ampY, performance.now());
      }
      phase = 'release';
      z.panEnd(performance.now());
      const r0 = performance.now();
      while (performance.now() - r0 < tailMs) rec(await rafP());

      const over33: ZoomBenchResult['over33'] = [];
      deltas.forEach((ms, i) => { if (ms > 33) over33.push({ i, ms: +ms.toFixed(1), phase: phases[i] }); });
      const byPhase: ZoomBenchResult['byPhase'] = {};
      for (const p of new Set(phases)) byPhase[p] = stat(deltas.filter((_, i) => phases[i] === p));
      const all = stat(deltas);
      return {
        frames: all.n, max: +all.max.toFixed(1), p95: +all.p95.toFixed(1), median: +all.median.toFixed(1),
        over33, byPhase, bakes: bakes.map(b => ({ ...b, ms: +b.ms.toFixed(1) })),
        zoom: z.viewZoom, shownAtEnd: !!e.showCamera, mount: { w: box.width, h: box.height }, VW: r.VW, VH: r.VH,
      };
    } finally {
      for (const n of names) e[n] = orig[n];
    }
  };
}
