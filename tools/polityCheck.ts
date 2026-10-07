/**
 * (DOM stub borrowed from smokeTest.ts.)
 *
 * Runs the real BigBangEngine under a DOM stub and asserts that every major
 * system actually fires and stays consistent over a long run. This is the
 * "is everything still working" check — it is meant to be run after any
 * simulation change.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/smokeTest.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs
 *
 * Exits non-zero if any check fails.
 */

const noopCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 1200, height: 800 };
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'getImageData' || prop === 'createImageData') {
      return (a: number, b: number, w = 1, h = 1) =>
        ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
    }
    if (prop === 'measureText') return () => ({ width: 10 });
    return () => undefined;
  },
  set() { return true; },
});

function makeCanvas(): any {
  return {
    width: 1200, height: 800, style: {},
    getContext: () => noopCtx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
  };
}

const g = globalThis as any;
g.document = {
  createElement: () => makeCanvas(),
  getElementById: () => null, querySelector: () => null,
  querySelectorAll: () => [], addEventListener() {},
};
g.window = g;
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.addEventListener = () => {};
g.eternalSpeed = 60;

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState, BIO_PHASE_SEQUENCE } = await import('../src/simulation/GameState');
const { generatePlanetGrid, isWater, GRID_SIZE, landFraction, stepLifeSpread } =
  await import('../src/simulation/PlanetGrid');
const { UNIVERSE_RADIUS, WORLD_SIZE } = await import('../src/constants');
const { planetHabitability, ARCHETYPES, filterChance, resolveTransition, MAX_FILTER_CHANCE } =
  await import('../src/simulation/LifeSystem');
const { stepEvolution } = await import('../src/simulation/EvolutionEngine');
const { createPrimordialSpecies, DEFAULT_BIOSPHERE } = await import('../src/simulation/SpeciesGenome');
const { assignDominantSpecies } = await import('../src/simulation/SpeciesDistribution');
const { SeedRNG } = await import('../src/utils/SeedRNG');

// ── Tiny assertion harness ──────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log(`  FAIL  ${name}  — ${detail}`); }
}

function resetGameState(name: string): void {
  gameState.playerPlanetName = name;
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  // Measures the biology ladder: start the home world formed and alive (lab path).
  gameState.skipFormation = true; gameState.destinyOverride = 'ocean';
  gameState.playerSpecies = [];
  gameState.playerBiosphere = { ...DEFAULT_BIOSPHERE };
  gameState.branchIds = [];
  gameState.playerDNA = {};
  gameState.codexEntries = [];
  gameState.leaders = [];
  gameState.divinePoints = 100;
  gameState.dnaPoints = 0;
  gameState.techPoints = 0;
  gameState.firstContactFired = false;
}
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Checks other stars' civilisations as agents and the trade between stars
 * (src/simulation/StarPolities.ts and its engine wiring).
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/polityCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/polity.mjs --log-level=error && node /tmp/polity.mjs
 */
const SP = await import('../src/simulation/StarPolities');
const { TECH_BY_ID } = await import('../src/simulation/Technology');
let pfailed = 0;
const pc = (name: string, ok: boolean, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(58)} ${detail}`); if (!ok) pfailed++; };
const vals = (o: Partial<Record<string, number>> = {}) => ({ militarism: 0.5, piety: 0.5, curiosity: 0.5, collectivism: 0.5, xenophobia: 0.3, ...o }) as any;
const view = (id: number, x: number, o: any = {}) => ({ id, x, y: 0, biosphere: 0.6, habitability: 0.8, planetType: 'rocky', belt: 0, civLevel: 5, isPlayer: false, ...o, values: vals(o.values) });
const R = (() => { let s = 7; return () => ((s = Math.imul(s, 1664525) + 1013904223 | 0) >>> 0) / 4294967296; })();

console.log('\n═══ Polities: a civilisation climbs by what it faces ═══');
{
  const st = SP.emptyInterstellar();
  // A barren, poor world at the dawn of history: hungry, it reaches for agriculture.
  const stars = [view(1, 0, { civLevel: 0, biosphere: 0.05, habitability: 0.2 })];
  let first: string | null = null;
  // (The engine raises a star's era as its polity learns; do the same here.)
  const step = (e: number) => { const out = SP.stepInterstellar(st, stars, null, e, R); stars[0].civLevel = st.polities[1].era; return out; };
  for (let i = 0; i < 400 && !first; i++) for (const n of step(0.02)) if (n.kind === 'learned' && !first) first = n.tech!;
  const p = st.polities[1];
  pc('a polity is founded for an intelligent world', !!p);
  pc('a hungry people learns to feed itself first', !!first && (TECH_BY_ID[first].answers.hunger ?? 0) > 0, `first: ${first} (hunger ${p.pressures.hunger.toFixed(2)})`);
  for (let i = 0; i < 300; i++) step(0.05);
  pc('it climbs the ages by learning', p.era >= 2, `era ${p.era}, ${p.techs.length} techs`);
  // The engine knocks it back (a war lost): it forgets what lay past that age.
  stars[0].civLevel = 1;
  SP.stepInterstellar(st, stars, null, 0.01, R);
  pc('a setback from outside costs knowledge', p.era <= 1, `era ${p.era}`);
}

console.log('\n═══ Polities: trade between stars ═══');
{
  const st = SP.emptyInterstellar();
  // A starving world and a rich one, kindred in temper, in reach.
  const hungry = view(1, 0, { biosphere: 0.02, habitability: 0.3, values: { curiosity: 0.4 } });
  const rich = view(2, 500, { biosphere: 1, habitability: 1, values: { curiosity: 0.4 } });
  const far = view(3, 5000, { biosphere: 1, habitability: 1 });
  for (let i = 0; i < 60; i++) SP.stepInterstellar(st, [hungry, rich, far], null, 0.05, R);
  const r = st.routes.find(x => x.a === 1 && x.b === 2);
  pc('a trade route opens where one has what the other lacks', !!r, r ? `${r.goods} to ${r.to}` : JSON.stringify(st.routes));
  const recv = r ? st.polities[r.to] : null;
  pc('...carrying what its receiver lacks', !!r && !!recv && (r.goods === 'grain' ? recv.pressures.hunger : recv.pressures.scarcity) >= 0, r ? `${r.goods} to ${r.to}` : '');
  const ever = new Set<string>();
  const st3 = SP.emptyInterstellar();
  for (let i = 0; i < 60; i++) { SP.stepInterstellar(st3, [hungry, rich, far], null, 0.05, R); for (const x of st3.routes) ever.add(`${x.goods}>${x.to}`); }
  pc('grain went to the starving world at some point', ever.has('grain>1'), [...ever].join(' '));
  pc('no route beyond the reach of space-age ships', !st.routes.some(x => x.b === 3));
  // Twin without the rich partner: hunger is worse.
  const solo = SP.emptyInterstellar();
  for (let i = 0; i < 60; i++) SP.stepInterstellar(solo, [{ ...hungry }], null, 0.05, R);
  pc('the trade eases the hunger it answers', st.polities[1].pressures.hunger < solo.polities[1].pressures.hunger,
    `${st.polities[1].pressures.hunger.toFixed(2)} vs ${solo.polities[1].pressures.hunger.toFixed(2)} alone`);
  pc('trade warms them toward each other', (st.polities[1].attitude[2] ?? 0) > 0, (st.polities[1].attitude[2] ?? 0).toFixed(2));
  // A war between them: grievances, and the route closes.
  SP.grieve(st, 1, 2, 0.9);
  pc('war closes their trade', !st.routes.some(x => x.a === 1 && x.b === 2));
  for (let i = 0; i < 10; i++) SP.stepInterstellar(st, [hungry, rich, far], null, 0.05, R);
  pc('wrongs sour them', (st.polities[1].attitude[2] ?? 0) < 0.1, (st.polities[1].attitude[2] ?? 0).toFixed(2));
  // Interstellar ships reach anywhere.
  const st2 = SP.emptyInterstellar();
  const c1 = view(4, 0, { civLevel: 6, values: { curiosity: 0.9 } }), c2 = view(5, 5000, { civLevel: 6, values: { curiosity: 0.9 } });
  for (let i = 0; i < 60; i++) SP.stepInterstellar(st2, [c1, c2], null, 0.05, R);
  pc('two curious interstellar peoples trade knowledge across the void', st2.routes.some(x => x.goods === 'knowledge'), JSON.stringify(st2.routes.map(x => x.goods)));
}

console.log('\n═══ Polities: war drive ═══');
{
  const st = SP.emptyInterstellar();
  const a = view(1, 0, { biosphere: 0.05, habitability: 0.3, values: { militarism: 0.95, xenophobia: 0.95, piety: 0.95, collectivism: 0.95 } });
  const b = view(2, 400, { values: { militarism: 0.05, xenophobia: 0.95, piety: 0.05, collectivism: 0.05 } });
  for (let i = 0; i < 60; i++) SP.stepInterstellar(st, [a, b], null, 0.05, R);
  const d = SP.warDrive(st, 1, a.values);
  pc('a martial, hungry people with a bitter rival is driven to war', !!d && d.target === 2 && d.chance > 0.2, d ? `chance ${d.chance.toFixed(2)}, attitude ${st.polities[1].attitude[2].toFixed(2)}` : 'none');
  const peace = SP.warDrive(st, 2, b.values);
  pc('a peaceable, sated one is not', !peace || peace.chance < 0.1, peace ? peace.chance.toFixed(2) : 'none');
}

console.log('\n═══ Engine: the civilisations of the universe live ═══');
{
  resetGameState('PolityWorld');
  const engine: any = new BigBangEngine(makeCanvas());
  let wars = 0, events: string[] = [];
  engine.onWarStart = () => { wars++; };
  engine.onCivEvent = (t: string) => { if (/trade route|Scholars now/.test(t)) events.push(t); };
  engine.init({ life: 15, evolution: 13, hostility: 12, entropy: 11, divine: 10 }, 'smoke_main');
  // Make every star known so the news is not filtered by fog.
  engine.isStarKnownToPlayer = () => true;
  const levels0 = new Map(engine.stars.map((s: any) => [s.id, s.civLevel]));
  let maxRoutes = 0, advances = 0;
  const adv = engine.advanceCiv.bind(engine); engine.advanceCiv = (s: any) => { if (!s.isPlayerStar) advances++; adv(s); };
  for (let i = 0; i < 400_000; i++) { engine.update(); if (i % 5000 === 0) maxRoutes = Math.max(maxRoutes, engine.interstellar.routes.length); }
  const pols = Object.values(engine.interstellar.polities) as any[];
  pc('every intelligent world elsewhere is a polity', engine.stars.filter((s: any) => !s.isDead && !s.isPlayerStar && s.biologyPhase === 'intelligent').every((s: any) => engine.interstellar.polities[s.id]), `${pols.length} polities`);
  pc('their eras match what they know', engine.stars.filter((s: any) => engine.interstellar.polities[s.id]).every((s: any) => s.civLevel === Math.min(8, engine.interstellar.polities[s.id].era)),
    engine.stars.filter((s: any) => engine.interstellar.polities[s.id]).map((s: any) => `${s.civLevel}/${engine.interstellar.polities[s.id].era}`).join(' '));
  pc('civilisations advanced by learning', advances > 0, `${advances} advances`);
  pc('they press on different needs', new Set(pols.map(p => p.research?.id).filter(Boolean)).size >= Math.min(2, pols.length), pols.map(p => p.research?.id).join(','));
  pc('trade routes opened between stars', maxRoutes > 0 || events.length > 0, `${maxRoutes} at most at once; ${events.length} announced${events[0] ? ': ' + events[0] : ''}`);
  pc('wars still break out', wars > 0, String(wars));
  const snap = engine.serialize();
  pc('saved with the game', !!snap.interstellar && Object.keys(snap.interstellar.polities).length === pols.length);
}

console.log(pfailed ? `\n${pfailed} check(s) FAILED` : '\nall polity checks passed');
process.exit(pfailed ? 1 : 0);
