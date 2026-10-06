/**
 * Technology as a response, end to end (docs/CORE_LOOP_VISION.md phase 2):
 * the real BigBangEngine with the player's world brought to civilisation.
 * Checks that the world splits into nations, that what they learn (and not
 * the clock) moves the world through the eras, and that discoveries are
 * announced with their deeds.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/techCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/tech.mjs --log-level=error && node /tmp/tech.mjs
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
const { gameState, runtimeState, TECH_LEVELS } = await import('../src/simulation/GameState');
const { DEFAULT_BIOSPHERE } = await import('../src/simulation/SpeciesGenome');
const { TECHS } = await import('../src/simulation/Technology');
const { generatePlanetGrid } = await import('../src/simulation/PlanetGrid');

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(50)} ${detail}`);
  if (!ok) failed++;
};

gameState.playerPlanetName = 'TechWorld';
gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
gameState.skipFormation = true; gameState.destinyOverride = 'rocky';
gameState.playerSpecies = []; gameState.playerBiosphere = { ...DEFAULT_BIOSPHERE };
gameState.branchIds = []; gameState.playerDNA = {}; gameState.codexEntries = []; gameState.leaders = [];

const engine = new BigBangEngine(makeCanvas());
const events: string[] = [];
engine.onCivEvent = (m: string) => { events.push(m); };
// A calm universe: few impacts and extinctions, so the run measures the nations.
engine.init({ life: 15, evolution: 13, hostility: 1, entropy: 1, divine: 10 }, 'tech_main');
const ps = engine.getPlayerStar()!;
// The game builds the home grid in the UI (main.ts); headless, build it here.
runtimeState.playerPlanetGrid = generatePlanetGrid('rocky', 4242, gameState.playerPlanetDNA);

// Let life evolve a while (species to lead the nations), then wake it.
for (let i = 0; i < 60_000; i++) engine.update();
ps.biologyPhase = 'intelligent';
ps.civLevel = 1;
const eras: number[] = [];
const T = 360_000;
for (let i = 1; i <= T; i++) {
  engine.update();
  if (i % 40_000 === 0) eras.push(ps.civLevel);
}
const ns = runtimeState.playerNations;
check('the world split into nations', !!ns?.isFounded, ns ? `${ns.nations.length}: ${ns.nations.map(n => n.name).join(', ')}` : 'none');
check('eras climbed', ps.civLevel >= 3, `civLevel by 40k ticks: ${eras.join(' ')}`);
check('the world stands in its best nation\'s era', !!ns && ps.civLevel === Math.min(ns.maxEra, TECH_LEVELS.length - 1), `civLevel ${ps.civLevel}, best nation era ${ns?.maxEra}`);
const deeds = events.filter(m => TECHS.some(t => m.endsWith(t.deed + '.')));
check('discoveries were announced', deeds.length >= 4, `${deeds.length}, e.g. "${deeds[0] ?? ''}"`);
const refounded = events.some(m => m.startsWith('The nations have fallen silent'));
check('each announced only once', refounded || new Set(deeds.map(m => TECHS.find(t => m.endsWith(t.deed + '.'))!.id)).size === deeds.length);
check('nations were announced', events.some(m => m.includes('split into')));
if (ns) for (const n of ns.nations) console.log(`        ${n.name}: era ${n.era}, ${n.techs.length} techs, studying ${n.research?.id ?? '-'} (${n.research?.why.join('; ') ?? ''})`);
// ── Creative: leap to an era ──
{
  gameState.playerSpecies = []; gameState.playerBiosphere = { ...DEFAULT_BIOSPHERE };
  const e2 = new BigBangEngine(makeCanvas());
  e2.init({ life: 15, evolution: 13, hostility: 1, entropy: 1, divine: 10 }, 'leap_main');
  runtimeState.playerPlanetGrid = generatePlanetGrid('rocky', 777, gameState.playerPlanetDNA);
  for (let i = 0; i < 3000; i++) e2.update();
  const p2 = e2.getPlayerStar()!;
  const t0 = Date.now();
  const line = e2.leapToEra(5);
  const ms = Date.now() - t0;
  const n2 = runtimeState.playerNations;
  check('leap wakes intelligence and founds nations', p2.biologyPhase === 'intelligent' && !!n2?.isFounded, line ?? 'null');
  check('leap reaches the era asked', p2.civLevel === 5 && (n2?.maxEra ?? 0) >= 5, `civLevel ${p2.civLevel} in ${ms}ms`);
  check('leap is quick', ms < 5000, `${ms}ms`);
  e2.leapToEra(2);
  check('leap back unwinds the ages', p2.civLevel === 2 && (n2?.maxEra ?? 9) <= 2, `civLevel ${p2.civLevel}, best nation ${n2?.maxEra}`);
  for (let i = 0; i < 2000; i++) e2.update();
  check('the world keeps living after a leap', p2.civLevel >= 2 && !!runtimeState.playerNations?.isFounded);
}
console.log(failed === 0 ? '\n  all tech checks passed\n' : `\n  ${failed} tech check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
