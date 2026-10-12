/**
 * Seeded simulation invariants — the fast CI gate.
 *
 * Runs the real BigBangEngine headless over a fixed set of seeds and checks
 * rules that must hold on EVERY sampled tick, for EVERY star. A universe is
 * fully determined by its seed, so any failure here is reproducible with the
 * seed and tick it prints.
 *
 *   npm run test:invariants
 *   npm run test:invariants -- --ticks=200000 --seeds=8   (longer local run)
 *
 * Adding a rule: write one `rule(...)`. If it reproduces an open GitHub issue,
 * pass `knownIssue: <number>` — it is still run and reported, but does not fail
 * CI until the issue is fixed. When a known-issue rule starts passing, the run
 * says so: remove the flag so the fix is locked in.
 *
 * Exits non-zero if any rule without a `knownIssue` fails.
 */
import { makeCanvas } from './lib/headlessDom';

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState, BIO_PHASE_SEQUENCE, TECH_LEVELS } = await import('../src/simulation/GameState');
const { DEFAULT_BIOSPHERE } = await import('../src/simulation/SpeciesGenome');
const { UNIVERSE_RADIUS, WORLD_SIZE } = await import('../src/constants');
const { runtimeState } = await import('../src/simulation/GameState');
const { generatePlanetGrid } = await import('../src/simulation/PlanetGrid');
const { assignDominantSpecies } = await import('../src/simulation/SpeciesDistribution');

type Engine = InstanceType<typeof BigBangEngine>;
type Star = ReturnType<Engine['getPlayerStar']> & {};

// ── CLI ──────────────────────────────────────────────────────────────────────
const arg = (name: string, dflt: number): number => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const TICKS = arg('ticks', 60_000);
const SAMPLE_EVERY = arg('every', 500);
const SEED_COUNT = arg('seeds', 4);

// Varied stat lines so seeds exercise calm and violent universes alike.
const SEEDS: { seed: string; stats: { life: number; evolution: number; hostility: number; entropy: number; divine: number } }[] = [
  { seed: 'inv_alpha',   stats: { life: 15, evolution: 13, hostility: 12, entropy: 11, divine: 10 } },
  { seed: 'inv_beta',    stats: { life: 20, evolution: 20, hostility: 20, entropy: 20, divine: 20 } },
  { seed: 'inv_gamma',   stats: { life: 5,  evolution: 18, hostility: 3,  entropy: 6,  divine: 15 } },
  { seed: 'inv_delta',   stats: { life: 12, evolution: 8,  hostility: 18, entropy: 16, divine: 4  } },
  { seed: 'inv_epsilon', stats: { life: 18, evolution: 15, hostility: 8,  entropy: 3,  divine: 12 } },
  { seed: 'inv_zeta',    stats: { life: 9,  evolution: 20, hostility: 14, entropy: 9,  divine: 7  } },
  { seed: 'inv_eta',     stats: { life: 16, evolution: 11, hostility: 5,  entropy: 18, divine: 18 } },
  { seed: 'inv_theta',   stats: { life: 7,  evolution: 6,  hostility: 10, entropy: 12, divine: 9  } },
].slice(0, SEED_COUNT);

// ── Rules ────────────────────────────────────────────────────────────────────
interface Ctx { engine: Engine; stars: Star[]; tick: number; }
interface Rule {
  name: string;
  knownIssue?: number;
  /** Returns a failure description, or null if the rule holds. */
  check: (c: Ctx) => string | null;
}
const rules: Rule[] = [];
const rule = (r: Rule) => rules.push(r);

const firstBad = (stars: Star[], bad: (s: Star) => boolean, describe: (s: Star) => string) => {
  const hits = stars.filter(bad);
  return hits.length ? `${hits.length} star(s), e.g. #${hits[0].id}: ${describe(hits[0])}` : null;
};

rule({
  name: 'star positions are finite',
  check: ({ stars }) => firstBad(stars,
    s => !Number.isFinite(s.x) || !Number.isFinite(s.y),
    s => `(${s.x}, ${s.y})`),
});

rule({
  name: 'stars stay inside the universe',
  check: ({ stars }) => firstBad(stars,
    s => Math.hypot(s.x - WORLD_SIZE / 2, s.y - WORLD_SIZE / 2) > UNIVERSE_RADIUS + 1,
    s => `r=${Math.hypot(s.x - WORLD_SIZE / 2, s.y - WORLD_SIZE / 2).toFixed(1)} > ${UNIVERSE_RADIUS}`),
});

rule({
  name: 'no stars pinned to the universe edge',
  check: ({ stars }) => firstBad(stars.filter(s => !s.isDead),
    s => Math.hypot(s.x - WORLD_SIZE / 2, s.y - WORLD_SIZE / 2) > UNIVERSE_RADIUS - 1,
    s => `r=${Math.hypot(s.x - WORLD_SIZE / 2, s.y - WORLD_SIZE / 2).toFixed(1)}`),
});

rule({
  name: 'biology phase is a known phase',
  check: ({ stars }) => firstBad(stars,
    s => BIO_PHASE_SEQUENCE.indexOf(s.biologyPhase) < 0,
    s => String(s.biologyPhase)),
});

rule({
  name: 'tech level is a valid index into TECH_LEVELS',
  check: ({ stars }) => firstBad(stars,
    s => !Number.isInteger(s.civLevel) || s.civLevel < 0 || s.civLevel >= TECH_LEVELS.length,
    s => `civLevel=${s.civLevel}`),
});

rule({
  name: 'tech level only advances on intelligent living worlds',
  check: ({ stars }) => firstBad(stars.filter(s => !s.isDead),
    s => s.civLevel > 0 && (!s.hasLife || s.biologyPhase !== 'intelligent'),
    s => `civLevel=${s.civLevel}, phase=${s.biologyPhase}, hasLife=${s.hasLife}`),
});

rule({
  // Also run this one long (--ticks=250000): regressions that leave a stale
  // culture record are rare and late (#20).
  name: 'culture exists only for intelligent living civilisations',
  check: ({ stars }) => {
    const byId = new Map(stars.map(s => [s.id, s]));
    const bad = Object.keys(gameState.civilizations).map(Number).filter(id => {
      const s = byId.get(id);
      return !s || s.isDead || !s.hasLife || s.biologyPhase !== 'intelligent';
    });
    if (!bad.length) return null;
    const s = byId.get(bad[0]);
    return `${bad.length} record(s), e.g. star #${bad[0]}: ` +
      (s ? `phase=${s.biologyPhase}, hasLife=${s.hasLife}, dead=${s.isDead}` : 'star no longer exists');
  },
});

rule({
  // Re-entering the planet view re-stamps the map; it must never change it,
  // or the view shows a stale world until the player leaves and comes back (#11).
  name: 'player map matches a fresh species stamp',
  check: () => {
    const g = runtimeState.playerPlanetGrid;
    if (!g || !gameState.playerSpecies.length) return null;
    const before = g.map(row => row.map(c => c.dominantSpeciesId));
    assignDominantSpecies(g, gameState.playerSpecies);
    let diff = 0;
    for (let r = 0; r < g.length; r++) for (let c = 0; c < g[r].length; c++) {
      if (g[r][c].dominantSpeciesId !== before[r][c]) diff++;
      g[r][c].dominantSpeciesId = before[r][c];     // restore: checking must not change the run
    }
    return diff ? `${diff} cells would change on re-stamp` : null;
  },
});

rule({
  name: 'player always has a living home star',
  check: ({ engine }) => {
    const ps = engine.getPlayerStar();
    if (!ps) return `playerStarId ${gameState.playerStarId} has no star`;
    if (ps.isDead) return `player star #${ps.id} is dead`;
    if (!ps.planets.length) return `player star #${ps.id} has no planets`;
    return null;
  },
});

// ── Runner ───────────────────────────────────────────────────────────────────
function resetGameState(name: string): void {
  gameState.playerPlanetName = name;
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  gameState.playerSpecies = [];
  gameState.playerBiosphere = { ...DEFAULT_BIOSPHERE };
  gameState.branchIds = [];
  gameState.playerDNA = {};
  gameState.dnaFocusBranch = null;
  gameState.codexEntries = [];
  gameState.leaders = [];
  gameState.leaderMemories = [];
  gameState.factionFlags = {};
  gameState.civilizations = {};
  gameState.divinePoints = 100;
  gameState.dnaPoints = 0;
  gameState.techPoints = 0;
  gameState.firstContactFired = false;
  runtimeState.playerPlanetGrid = null;
}

/**
 * The player's surface grid, created the way openPlanetView() does. The game
 * builds it lazily on the first planet view, so without this the headless
 * engine never spreads life or places species on the home world.
 */
function ensurePlayerGrid(engine: Engine): void {
  if (runtimeState.playerPlanetGrid) return;
  const ps = engine.getPlayerStar();
  const idx = ps ? ps.planets.findIndex(p => p.discovery === 'landing') : -1;
  if (!ps || idx < 0) return;
  runtimeState.playerPlanetGrid = generatePlanetGrid(
    (ps.planets[idx].type ?? 'rocky') as any, ps.id * 7777 + idx * 131, gameState.playerPlanetDNA);
}

interface Failure { seed: string; tick: number; detail: string; }
const failures = new Map<Rule, Failure>();   // first failure per rule
const failCount = new Map<Rule, number>();
const crashes: string[] = [];
const t0 = Date.now();

console.log(`Invariants: ${rules.length} rules × ${SEEDS.length} seeds × ${TICKS.toLocaleString()} ticks (sampled every ${SAMPLE_EVERY})\n`);

for (const { seed, stats } of SEEDS) {
  resetGameState(`Inv_${seed}`);
  const engine = new BigBangEngine(makeCanvas());
  engine.init(stats, seed);
  const ts = Date.now();
  let tick = 0;
  try {
    for (; tick <= TICKS; tick++) {
      if (tick % SAMPLE_EVERY === 0) {
        const ctx: Ctx = { engine, stars: (engine as any).stars as Star[], tick };
        for (const r of rules) {
          const detail = r.check(ctx);
          if (detail) {
            failCount.set(r, (failCount.get(r) ?? 0) + 1);
            if (!failures.has(r)) failures.set(r, { seed, tick, detail });
          }
        }
      }
      ensurePlayerGrid(engine);
      engine.update();
    }
  } catch (err) {
    crashes.push(`${seed} @ tick ${tick}: ${(err as Error).stack ?? err}`);
  }
  console.log(`  ran ${seed.padEnd(12)} ${((Date.now() - ts) / 1000).toFixed(1)}s`);
}

// ── Determinism: same seed, same universe ───────────────────────────────────
// Every rule above is only reproducible if this holds.
{
  const fingerprint = (seed: string, stats: typeof SEEDS[0]['stats'], ticks: number): string => {
    resetGameState(`Det_${seed}`);
    const e = new BigBangEngine(makeCanvas());
    e.init(stats, seed);
    for (let i = 0; i < ticks; i++) e.update();
    return ((e as any).stars as Star[])
      .map(s => `${s.id}:${s.x.toFixed(3)},${s.y.toFixed(3)},${s.biologyPhase},${s.civLevel},${s.isDead ? 1 : 0}`)
      .join('|');
  };
  const { seed, stats } = SEEDS[0];
  const a = fingerprint(seed, stats, 5_000), b = fingerprint(seed, stats, 5_000);
  const detRule: Rule = { name: 'same seed → identical universe after 5k ticks', check: () => null };
  rules.push(detRule);
  if (a !== b) {
    failures.set(detRule, { seed, tick: 5_000, detail: 'star fingerprints differ between two runs' });
    failCount.set(detRule, 1);
  }
}

// ── Scenarios: drive rare transitions directly ──────────────────────────────
// Some transitions happen too rarely for the seeded runs to hit reliably
// (a catastrophe on an intelligent world, ~88k ticks on one seed). Force them.
{
  const scenario = (name: string, run: () => string | null) => {
    const r: Rule = { name: `scenario: ${name}`, check: () => null };
    rules.push(r);
    let detail: string | null;
    try { detail = run(); } catch (err) { detail = `threw: ${(err as Error).message}`; }
    if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
  };

  resetGameState('Inv_scenarios');
  const e = new BigBangEngine(makeCanvas()) as any;
  e.init(SEEDS[0].stats, 'inv_scenarios');
  for (let i = 0; i < 2_000; i++) e.update();

  // Intelligent NPC worlds are rare early on, so build the subject: promote a
  // fresh NPC world and give it a culture through the engine's own path.
  const used = new Set<number>();
  const makeCivilisation = (): Star | null => {
    const s = (e.stars as Star[]).find(x => !x.isDead && !x.isPlayerStar && !used.has(x.id) && x.planets.length);
    if (!s) return null;
    used.add(s.id);
    s.hasLife = true;
    s.biologyPhase = 'intelligent';
    s.civLevel = 3;
    e.ensureCivilization(s);
    return gameState.civilizations[s.id] ? s : null;
  };

  // Ending a civilisation must drop its culture in the same step (#20).
  const demoted = (how: string, act: (s: Star) => void) => scenario(
    `${how} drops culture and tech level`, () => {
      const s = makeCivilisation();
      if (!s) return 'could not set up an NPC civilisation with a culture';
      act(s);
      const left = [
        gameState.civilizations[s.id] ? 'culture record kept' : '',
        s.civLevel !== 0 ? `civLevel=${s.civLevel}` : '',
      ].filter(Boolean);
      return left.length ? `star #${s.id} → ${s.biologyPhase}: ${left.join(', ')}` : null;
    });
  demoted('regression below intelligent', s => e.regressPhases(s, 1));
  demoted('regression past the microbial floor', s => e.regressPhases(s, 99));
  demoted('sterilisation', s => e.sterilise(s));
  demoted('star death', s => e.makeRemnant(s, 'supernova'));
}

// ── Report ───────────────────────────────────────────────────────────────────
const samples = SEEDS.length * (Math.floor(TICKS / SAMPLE_EVERY) + 1);
let blocking = crashes.length;
console.log('');
for (const r of rules) {
  const f = failures.get(r);
  const tag = r.knownIssue ? ` (known issue #${r.knownIssue})` : '';
  if (!f) {
    console.log(`  PASS  ${r.name}`);
    if (r.knownIssue) console.log(`        ↳ #${r.knownIssue} no longer reproduces — remove knownIssue so the fix is locked in`);
    continue;
  }
  const label = r.knownIssue ? 'KNOWN' : 'FAIL ';
  if (!r.knownIssue) blocking++;
  console.log(`  ${label} ${r.name}${tag}`);
  console.log(f.seed === 'scenario'
    ? `        ${f.detail}`
    : `        ${failCount.get(r)}/${samples} samples; first at seed=${f.seed} tick=${f.tick}: ${f.detail}`);
}
for (const c of crashes) console.log(`  CRASH ${c}`);

console.log(`\n═══ ${blocking === 0 ? 'OK' : `${blocking} BLOCKING FAILURE(S)`} in ${((Date.now() - t0) / 1000).toFixed(1)}s ═══`);
process.exit(blocking === 0 ? 0 : 1);
