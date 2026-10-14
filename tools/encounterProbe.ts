/**
 * Long-run census of star systems and their bodies (#115).
 *
 *   npx esbuild tools/encounterProbe.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/enc.mjs --log-level=error && node /tmp/enc.mjs [ticks] [seed] [every]
 *
 * Every `every` ticks prints: live / dead stars, planets, moons,
 * pairs of systems whose planet zones overlap, systems sitting wholly inside
 * another, and the encounter tallies (perturbed, captured, ejected, swallowed,
 * planet collisions).
 */
import { makeCanvas } from './lib/headlessDom';
const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');
const ticks = Number(process.argv[2] ?? 400_000);
const seed = process.argv[3] ?? 'long_run_probe';
const every = Number(process.argv[4] ?? 100_000);
gameState.skipFormation = true;
const e = new BigBangEngine(makeCanvas()) as any;
e.init({ gravity: 10, entropy: 10, life: 14, hostility: 12, evolution: 14, chaos: 8 }, seed);

/** Outermost reach of a system's planets (apoapsis). */
const extent = (s: any) => s.planets.reduce((m: number, p: any) => Math.max(m, p.orbitalRadius * (1 + (p.eccentricity ?? 0))), 0);

function census(): string {
  const all = e.stars as any[];
  const live = all.filter(s => !s.isDead);
  const planets = all.reduce((n, s) => n + s.planets.length, 0);
  const moons = all.reduce((n, s) => n + s.planets.reduce((m: number, p: any) => m + p.moons.length, 0), 0);
  let overlap = 0, inside = 0;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    const ea = extent(a), eb = extent(b);
    if (!ea && !eb) continue;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < ea + eb) overlap++;
    if (d + eb < ea || d + ea < eb) inside++;
  }
  const t = e.encounterTally ?? {};
  const living = live.filter(s => s.hasLife).length, smart = live.filter(s => s.biologyPhase === 'intelligent' && s.hasLife).length;
  const bare = live.filter(s => !s.planets.length).length;
  const home = e.getPlayerStar();
  return `tick ${e.tick}: stars ${live.length} live + ${all.length - live.length} dead, planets ${planets}, moons ${moons}, ` +
    `overlapping pairs ${overlap}, inside ${inside}, living ${living} (intelligent ${smart}), bare live stars ${bare}, home planets ${home?.planets.length}` +
    (Object.keys(t).length ? ` | ${Object.entries(t).map(([k, v]) => `${k} ${v}`).join(', ')}` : '');
}

const t0 = Date.now();
for (let i = 1; i <= ticks; i++) {
  e.update();
  if (i % every === 0) console.log(census());
}
console.log(`${ticks} ticks in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
