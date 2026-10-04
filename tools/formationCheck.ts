/**
 * Dev-only headless check of the home-world formation lifecycle
 * (docs/superpowers/specs/2026-10-04-planet-formation-lifecycle-design.md),
 * against the spec's success criteria, on the real BigBangEngine.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/formationCheck.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/formation.mjs" --log-level=error && node "$TEMP/formation.mjs" [runs]
 */

// ── Minimal DOM stub, installed before the engine module is imported ─────────
const noopCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 1200, height: 800 };
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'getImageData') {
      return (_x: number, _y: number, w: number, h: number) =>
        ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    }
    if (prop === 'createImageData') {
      return (w: number, h: number) =>
        ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    }
    if (prop === 'measureText') return () => ({ width: 10 });
    return () => undefined;
  },
  set() { return true; },
});

function makeCanvas(): any {
  return {
    width: 1200, height: 800,
    style: {},
    getContext: () => noopCtx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    toDataURL: () => '',
  };
}

const g = globalThis as any;
g.document = {
  createElement: () => makeCanvas(),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};
g.window = g;
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.addEventListener = () => {};
g.performance = g.performance ?? { now: () => Date.now() };
g.Image = class { set src(_v: string) {} };
g.eternalSpeed = 1;

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');
const F = await import('../src/simulation/Formation');

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${name.padEnd(58)} ${detail}`);
};

const RUNS = Number(process.argv[2]) || 12;
const stats = { life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 };

interface Run {
  destiny: string; budget: number; startType: string; startLife: boolean;
  stages: string[]; doneTick: number; startTick: number; endType: string;
  lifeDuring: string | null; lifeAtEnd: boolean; phaseAtEnd: string;
  bioWhileForming: boolean; faces: string[];
}

function runOne(seed: string, opts: { override?: any; skip?: boolean; meteorEvery?: number } = {}): Run {
  gameState.playerPlanetName = 'Home';
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'ocean_world', chaos: 'turbulent' } as any;
  gameState.playerSpecies = [];
  gameState.codexEntries = [];
  gameState.destinyOverride = opts.override ?? null;
  gameState.skipFormation = !!opts.skip;
  const engine: any = new BigBangEngine(makeCanvas());
  engine.init(stats, seed);
  engine.onCivEvent = () => {};
  engine.onLifeEvent = () => {};
  const ps = engine.getPlayerStar();
  const home = engine.homePlanetOf(ps);
  const r: Run = {
    destiny: home.destinyType, budget: ps.formationBudget ?? 0,
    startType: home.type, startLife: ps.hasLife || home.hasLife,
    stages: [ps.formationStage], doneTick: -1, startTick: engine.tick, endType: '',
    lifeDuring: null, lifeAtEnd: false, phaseAtEnd: '', bioWhileForming: false, faces: [home.type],
  };
  engine.onPlanetFormationProgress = (st: string) => { r.stages.push(st); r.faces.push(home.type); };
  engine.onFormationLifeArrived = (src: string) => { r.lifeDuring ??= src; };
  engine.onPlanetFormationComplete = () => { r.doneTick = engine.tick; };
  g.eternalSpeed = 60;
  const limit = r.budget + 20_000;
  let bioMark = -1;
  // Formation only ticks once inflation is over: time it from there.
  while (engine.phase === 'inflation' && engine.tick < limit) engine.update();
  r.startTick = engine.tick;
  while (engine.tick < limit && r.doneTick < 0) {
    engine.update();
    if (opts.meteorEvery && engine.tick % opts.meteorEvery === 0) engine.placeLife();
    if (ps.formationDestiny && ps.hasLife) {
      if (bioMark < 0) bioMark = ps.bioPhaseProgress;
      else if (ps.bioPhaseProgress !== bioMark || ps.biologyPhase !== 'microbial') r.bioWhileForming = true;
    }
  }
  r.endType = home.type;
  r.lifeAtEnd = ps.hasLife && home.hasLife;
  r.phaseAtEnd = ps.biologyPhase;
  return r;
}

console.log(`\n  FORMATION LIFECYCLE — ${RUNS} universes\n`);
const runs: Run[] = [];
for (let i = 0; i < RUNS; i++) runs.push(runOne(`form_${i}`));
for (const r of runs) {
  console.log(`    ${r.destiny.padEnd(7)} budget ${String(r.budget).padStart(6)} (${(r.budget / F.PLAYER_DAY_TICKS).toFixed(2)} d)` +
    `  took ${String(r.doneTick - r.startTick).padStart(6)}  ${r.stages.join('>')}  faces ${r.faces.join(',')}` +
    `  life ${r.lifeDuring ?? 'at end'}`);
}

check('home world is born molten with no life',
  runs.every(r => r.startType === 'lava' && !r.startLife && r.stages[0] === 'magma'),
  runs.map(r => `${r.startType}/${r.startLife}`).join(' '));
check('budget is 1-3 player days',
  runs.every(r => r.budget >= F.PLAYER_DAY_TICKS && r.budget <= 3 * F.PLAYER_DAY_TICKS),
  runs.map(r => (r.budget / F.PLAYER_DAY_TICKS).toFixed(2)).join(' '));
check('stages follow the destiny ladder in order',
  runs.every(r => r.stages.join() === F.ladderOf(r.destiny as any).join()), '');
check('world finishes as its destiny type',
  runs.every(r => r.doneTick > 0 && r.endType === r.destiny),
  runs.map(r => `${r.destiny}->${r.endType}`).join(' '));
check('formation takes the budget (life can at most halve what is left)',
  runs.every(r => { const t = r.doneTick - r.startTick; return t >= r.budget / (1 + F.MAX_BOOST) - 120 && t <= r.budget + 200; }),
  runs.map(r => ((r.doneTick - r.startTick) / r.budget).toFixed(2)).join(' '));
check('biology ladder starts on finished ground, with life',
  runs.every(r => r.lifeAtEnd && r.phaseAtEnd === 'microbial'), '');
check('life during formation stays dormant (no biology progress)',
  runs.every(r => !r.bioWhileForming), '');

// Destiny distribution — ocean/rocky common, others possible.
const tally: Record<string, number> = {};
for (let i = 0; i < 400; i++) { const d = F.rollDestiny(Math.random); tally[d] = (tally[d] ?? 0) + 1; }
check('destiny roll: ocean and rocky common, ice/desert rarer',
  tally.ocean > tally.ice && tally.rocky > tally.desert && (tally.ice ?? 0) > 0 && (tally.desert ?? 0) > 0,
  JSON.stringify(tally));
const seedDestinies = new Set(runs.map(r => r.destiny));
check('destiny comes from the seed (setup DNA ignored on a normal run)',
  seedDestinies.size > 1, [...seedDestinies].join(','));
const again = runOne('form_0');
check('same seed, same destiny and budget', again.destiny === runs[0].destiny && again.budget === runs[0].budget,
  `${again.destiny}/${again.budget}`);

// Lab override and skip.
const forced = runOne('form_0', { override: 'ice' });
check('lab override forces the destiny', forced.destiny === 'ice' && forced.endType === 'ice', forced.destiny);
const skipped = runOne('form_1', { skip: true });
check('lab skip starts finished and alive', skipped.startLife && skipped.startType !== 'lava', skipped.startType);

// Life hastens but never redirects, and is capped.
const spam = runOne('form_2', { meteorEvery: 30 });
const base = runs[2];
check('repeated seeding hastens formation, capped at (1+MAX_BOOST)x',
  spam.doneTick - spam.startTick < base.doneTick - base.startTick
  && spam.doneTick - spam.startTick >= spam.budget / (1 + F.MAX_BOOST) - 120 && spam.endType === spam.destiny,
  `${spam.doneTick - spam.startTick} vs ${base.doneTick - base.startTick} (budget ${spam.budget})`);

console.log(failed ? `\n  ${failed} check(s) FAILED\n` : '\n  all formation checks passed\n');
if (failed) process.exitCode = 1;
