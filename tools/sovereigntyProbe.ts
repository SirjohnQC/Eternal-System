/**
 * How often colonies break away and worlds are conquered in a long run (P3 tuning).
 *   npx esbuild tools/sovereigntyProbe.ts --bundle --platform=node --format=esm --outfile=/tmp/sov.mjs --log-level=error && node /tmp/sov.mjs [ticks] [seed]
 */
import { makeCanvas } from './lib/headlessDom';
const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');
const ticks = Number(process.argv[2] ?? 400_000), seed = process.argv[3] ?? 'probe_sov';
gameState.skipFormation = true;
const e = new BigBangEngine(makeCanvas()) as any;
e.init({ gravity: 10, entropy: 10, life: 14, hostility: 12, evolution: 14, chaos: 8 }, seed);
const lines: string[] = [];
// Every colony line, known to the player or not.
const news = e.colonyNews.bind(e);
e.colonyNews = (byPlayer: boolean, starId: number, line: string, cause: string, also?: number) => {
  if (/broken away|govern themselves|seized|occupied|rose against|realm of|threw off|No people/.test(line)) lines.push(`${e.tick}: ${line}`);
  news(byPlayer, starId, line, cause, also);
};
const t0 = Date.now();
for (let i = 0; i < ticks; i++) e.update();
const cs = e.colonies.colonies as any[];
const count = (k: string) => cs.filter(c => c.status === k).length;
console.log(`${ticks} ticks in ${((Date.now() - t0) / 1000).toFixed(0)}s; colonies ${cs.length}: outpost ${count('outpost')}, colony ${count('colony')}, independent ${count('independent')}, occupied ${count('occupied')}; wars so far ${e.warIdCounter}`);
for (const l of lines.slice(0, 40)) console.log(l);
