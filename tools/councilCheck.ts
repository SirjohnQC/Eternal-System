/**
 * Rulers who live (stage-moments plan, P3; Council.ts), headless.
 *
 *   npm run test:council
 *
 * 1. In seeded worlds leapt to the fourth age and run on: rulers die and are
 *    succeeded (at least one succession per nation per two ages, median),
 *    every succession is a Chronicle entry with its causes, loyalty follows
 *    cohesion, and the leader who speaks to the god is the leading nation's
 *    ruler.
 * 2. The lever: three of the god's signs on a nation make its devout
 *    councillor the heir when the ruler dies, far more often than in an
 *    untouched twin.
 * 3. A save keeps the councils; a new game starts with new people.
 *
 * Exits non-zero on any failure.
 */
import { makeCanvas } from './lib/headlessDom';
const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState, runtimeState, createDefaultGameState } = await import('../src/simulation/GameState');
const { NationSystem } = await import('../src/simulation/Nations');
const { newCouncil, stepCouncil } = await import('../src/simulation/Council');
const { SeedRNG } = await import('../src/utils/SeedRNG');

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failed++;
};
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => { const o = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(xs.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
  const ra = rank(a), rb = rank(b), n = a.length;
  let d2 = 0; for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - 6 * d2 / (n * (n * n - 1));
}

function world(seed: string): any {
  Object.assign(gameState, createDefaultGameState(), { playerPlanetName: 'C', playerSpeciesName: 'Velari', skipFormation: true, masterSeed: seed, divinePoints: 100 });
  runtimeState.playerNations = null; runtimeState.playerPlanetGrid = null;
  const stats = { life: 18, evolution: 10, hostility: 10, entropy: 10, divine: 10 };
  gameState.stats = stats;
  const e = new BigBangEngine(makeCanvas()) as any;
  e.init(stats, seed);
  for (let i = 0; i < 3000; i++) e.update();
  e.leapToEra(4);
  return e;
}

console.log('Councils that live');
const perNation: number[] = [];
let uncaused = 0, total = 0, leaderOk = 0, leaderSeen = 0;
const loy: number[] = [], coh: number[] = [];
for (const seed of ['council_a', 'council_b', 'council_c', 'council_d']) {
  const e = world(seed);
  const ns = runtimeState.playerNations as any;
  const age0 = ns.now, tick0 = e.tick;
  const firstRulers = new Map(ns.nations.map((n: any) => [n.id, n.council?.[0]?.id]));
  for (let i = 0; i < 140_000; i++) {
    e.update();
    if (i % 4000 === 0) {
      for (const n of ns.nations) if (!n.fallen) for (const f of n.council ?? []) if (f.seat !== 0) { loy.push(f.loyalty); coh.push(n.state.cohesion); }
      const l = gameState.leaders.find(x => x.starId === e.getPlayerStar().id);
      const lead = ns.nations.filter((n: any) => !n.fallen && n.council?.length).sort((a: any, b: any) => b.era - a.era || b.state.population - a.state.population)[0];
      if (l && lead) { leaderSeen++; if (l.name === lead.council[0].name && l.faction === lead.name) leaderOk++; }
    }
  }
  const ages = ns.now - age0;
  const succ = ns.chronicle.filter((h: any) => h.tick > tick0 && / took the throne\.| seized power in /.test(h.what));
  total += succ.length;
  uncaused += succ.filter((h: any) => !h.because?.length).length;
  for (const n of ns.nations) {
    if (n.fallen) continue;
    const mine = succ.filter((h: any) => h.nation === n.id).length;
    perNation.push(mine / Math.max(0.5, ages / 2));
  }
  const changed = ns.nations.filter((n: any) => !n.fallen && n.council?.[0]?.id !== firstRulers.get(n.id)).length;
  console.log(`  · ${seed}: ${ages.toFixed(2)} ages, ${succ.filter((h: any) => /seized/.test(h.what)).length} coups, ${succ.length} successions, ${changed} of ${ns.nations.filter((n: any) => !n.fallen).length} nations have a new ruler — ${succ.slice(0, 2).map((h: any) => h.what).join(' | ')}`);
}
check('rulers are succeeded (median 0.5..4 per nation per two era-units)', median(perNation) >= 0.5 && median(perNation) <= 4, `median ${median(perNation).toFixed(2)}`);
check('every succession is in the Chronicle with its causes', total > 0 && uncaused === 0, `${total} successions, ${uncaused} without a cause`);
check('loyalty follows cohesion (Spearman > 0.5)', spearman(loy, coh) > 0.5, spearman(loy, coh).toFixed(2));
check('the leader who speaks is the leading nation\'s ruler', leaderSeen > 0 && leaderOk === leaderSeen, `${leaderOk}/${leaderSeen}`);

console.log('The lever: the god\'s signs raise the devout');
{
  let blessed = 0, twin = 0;
  for (let k = 0; k < 8; k++) {
    const run = (casts: number) => {
      const rng = new SeedRNG(`lever_${k}`);
      let id = 1;
      // A Warband's devout seat (Shaman) is its weakest: only the signs can raise it.
      const c = newCouncil(rng, () => id++, 'Warband', 0, 0, 0.8);
      c[0].dies = 0.2;   // the ruler dies within this run
      for (const f of c) if (f.seat !== 0) f.dies = 5;
      let heir = null as any;
      for (let step = 0, now = 0; step < 10 && !heir; step++) {
        now += 0.045;
        const ch = stepCouncil(c, 'Warband', { eras: 0.045, atWar: false, casts: step < 3 ? casts : 0, banes: 0, learned: 0, cohesion: 0.8, unrest: 0 }, rng, () => id++, now, step * 2000);
        heir = ch.find(x => x.kind === 'death')?.heir ?? null;
      }
      return heir?.bent;
    };
    if (run(1) === 'faith') blessed++;
    if (run(0) === 'faith') twin++;
  }
  check('three signs make the devout the heir (most seeds, more than the twin)', blessed >= 5 && blessed > twin, `${blessed}/8 blessed vs ${twin}/8 untouched`);
}

console.log('Saves and new games');
{
  const e = world('council_save');
  for (let i = 0; i < 20_000; i++) e.update();
  const ns = runtimeState.playerNations as any;
  const before = ns.nations.map((n: any) => (n.council ?? []).map((f: any) => `${f.id}:${f.name}:${f.influence.toFixed(4)}`).join(',')).join('|');
  const back = NationSystem.fromSnapshot(JSON.parse(JSON.stringify(ns.toSnapshot())));
  const after = back.nations.map((n: any) => (n.council ?? []).map((f: any) => `${f.id}:${f.name}:${f.influence.toFixed(4)}`).join(',')).join('|');
  check('a save keeps every council', before === after && before.length > 0);
  const ruler = gameState.leaders.find(l => l.starId === e.getPlayerStar().id)?.name;
  const fresh = new BigBangEngine(makeCanvas()) as any;
  fresh.init(gameState.stats, 'council_new_game');
  check('a new game starts with new people', !gameState.leaders.some(l => l.name === ruler) && runtimeState.playerNations === null);
}

console.log(failed ? `\n${failed} council check(s) FAILED` : '\ncouncil checks passed');
if (failed) process.exit(1);
