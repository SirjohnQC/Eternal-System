import { makeCanvas } from './lib/headlessDom';
const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');
gameState.skipFormation = true;
const e = new BigBangEngine(makeCanvas()) as any;
e.init({ gravity: 10, entropy: 10, life: 14, hostility: 12, evolution: 14, chaos: 8 }, 'long_run_probe');
const T = Number(process.argv[2] ?? 600000), every = 200000;
let t0 = performance.now();
for (let i = 1; i <= T; i++) {
  e.update();
  if (i % every === 0) { const t = performance.now(); const live = e.stars.filter((s: any) => !s.isDead).length; console.log(`${i}: ${((t - t0) * 1000 / every).toFixed(0)} µs/tick, stars ${live}+${e.stars.length - live}`); t0 = t; }
}
