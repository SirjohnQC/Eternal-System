const H = await import('./zoomHarness');
const r: any = await H.makeRenderer('ocean', 3);
const e: any = r.cutaway, z: any = r.zoom;
r.bakeBudgetMs = Infinity;
let t = 1e6;
for (let i = 0; i < 10; i++) z.wheel(-220, 20, -1, t += 4);
r.updateView(t += 200);
console.log('shown', e.showCamera, e.camSet?.W);
const gc = (globalThis as any).gc;
const meas = (name: string, fn: (i: number) => void) => {
  for (let i = 0; i < 3000; i++) fn(i);
  let best = Infinity, worst = -Infinity;
  for (let w = 0; w < 3; w++) {
    gc(); const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1000; i++) fn(i);
    const d = process.memoryUsage().heapUsed - h0; best = Math.min(best, d); worst = Math.max(worst, d);
  }
  console.log(name.padEnd(30), (best / 1024).toFixed(1), (worst / 1024).toFixed(1), 'KB');
};
meas('tick', () => z.tick(t += 16));
meas('liveCamera', () => z.liveCamera());
meas('setView', () => e.setView(z.liveCamera()));
meas('stepBake', () => e.stepBake(8));
meas('showCamera get', () => { if (e.showCamera !== z.showCamera) e.showCamera = z.showCamera; });
meas('updateView', () => r.updateView(t += 16));
meas('applyViewTransform', () => r.applyViewTransform());
z.panStart(480, 320, t += 4);
let s = 0;
meas('panMove', () => { s++; z.panMove(480 + Math.sin(s * 0.05) * 200, 320 + Math.cos(s * 0.07) * 100, t += 16); });
meas('panMove+setView', () => { s++; z.panMove(480 + Math.sin(s * 0.05) * 200, 320 + Math.cos(s * 0.07) * 100, t += 16); e.setView(z.liveCamera()); });
meas('panMove+updateView', () => { s++; z.panMove(480 + Math.sin(s * 0.05) * 200, 320 + Math.cos(s * 0.07) * 100, t += 16); r.updateView(t); });
