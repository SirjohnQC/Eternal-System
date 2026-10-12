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
const { EVOLUTION_TICK_RATE } = await import('../src/simulation/EvolutionEngine');
const { formationFaceType } = await import('../src/simulation/Formation');
const { MAX_PER_CIV, MAX_TOTAL } = await import('../src/simulation/Colonies');
let formingSamples = 0;   // how often the formation rule actually had a forming world to check
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
interface Ctx { engine: Engine; stars: Star[]; tick: number; seedName: string; }
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
  // The system view's globe and the body card draw the home world as
  // `planet.type`; the planet view draws the formation stage. They must agree
  // at every stage — previews used to force magma for the whole formation (#12).
  name: 'a forming home world shows its current stage face',
  check: ({ engine }) => {
    const ps = engine.getPlayerStar();
    if (!ps?.formationDestiny || !ps.formationStage) return null;
    formingSamples++;
    const planet = ps.planets[engine.homeIndexOf(ps)];
    const want = formationFaceType(ps.formationStage, ps.formationDestiny);
    return planet?.type === want ? null
      : `stage ${ps.formationStage} of a ${ps.formationDestiny} world: face is ${planet?.type}, expected ${want}`;
  },
});

rule({
  // The engine owns the home-world surface: it must exist without anyone
  // having opened the planet view (#76).
  name: 'a living home world has a surface grid (no view needed)',
  check: ({ engine, tick }) => {
    const ps = engine.getPlayerStar();
    if (!ps?.hasLife || ps.formationDestiny) return null;
    if (tick < (ps.lifeFirstTick ?? 0) + EVOLUTION_TICK_RATE + 1) return null;
    return runtimeState.playerPlanetGrid ? null : `tick ${tick}: no grid ${tick - (ps.lifeFirstTick ?? 0)} ticks after life`;
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
  // Colonies live on real, living worlds, within the bounds Colonies.ts sets.
  name: 'colonies are well-formed',
  check: ({ engine }) => {
    const e = engine as any, cs = e.colonies.colonies as any[];
    if (cs.length > MAX_TOTAL) return `${cs.length} colonies > MAX_TOTAL ${MAX_TOTAL}`;
    const per = new Map<number, number>();
    for (const c of cs) {
      const s = e.stars.find((x: any) => x.id === c.starId), p = s?.planets[c.planetIndex];
      if (!s || s.isDead) return `${c.id} on a missing or dead star #${c.starId}`;
      if (!p || p.type === 'gas') return `${c.id} on planet ${c.planetIndex} (${p?.type ?? 'missing'})`;
      if (!(c.population >= 0 && c.population <= 1)) return `${c.id} population ${c.population}`;
      if (s.isPlayerStar && c.planetIndex === engine.homeIndexOf(s)) return `${c.id} on the player's home world`;
      if (c.seizedTick == null) per.set(c.founderStarId, (per.get(c.founderStarId) ?? 0) + 1);
    }
    for (const [id, n] of per) if (n > MAX_PER_CIV) return `star #${id} has ${n} colonies > ${MAX_PER_CIV}`;
    for (const f of e.fleets as any[]) {
      if (!f.ark) continue;
      const to = e.stars.find((x: any) => x.id === f.toStarId);
      if (to && !to.planets[f.ark.planetIndex]) return `ark ${f.id} bound for a missing planet`;
    }
    return null;
  },
});

rule({
  // Divergence (P2): adaptations stay in range; a player colony's own species
  // copy carries exactly the colony's adaptations (that is what is drawn).
  name: 'colony adaptations are in range and mirrored',
  check: ({ engine }) => {
    for (const c of (engine as any).colonies.colonies as any[]) {
      const a = c.adaptations;
      if (!a) continue;
      for (const k of ['size', 'pigment', 'eyes', 'insulation']) {
        if (!(a[k] >= -1 && a[k] <= 1)) return `${c.id} ${k}=${a[k]}`;
      }
      if (c.lineage && JSON.stringify(c.lineage.adaptations) !== JSON.stringify(a)) return `${c.id} lineage not mirrored`;
    }
    return null;
  },
});

rule({
  // Sovereignty (P3): status, ruler and occupation agree; an occupied home
  // world is another civilisation's (never the player's), seized not settled.
  name: 'colony rule is consistent',
  check: ({ engine }) => {
    for (const c of (engine as any).colonies.colonies as any[]) {
      if (!(c.loyalty >= 0 && c.loyalty <= 1)) return `${c.id} loyalty ${c.loyalty}`;
      if ((c.status === 'independent') !== (c.rulerStarId === -1)) return `${c.id} status ${c.status} with ruler ${c.rulerStarId}`;
      if ((c.status === 'occupied') !== !!c.occupation) return `${c.id} status ${c.status}, occupation ${!!c.occupation}`;
      const o = c.occupation;
      if (!o) continue;
      if (o.byStarId !== c.rulerStarId || !!o.byPlayer !== !!c.rulerIsPlayer) return `${c.id} occupier ${o.byStarId} is not its ruler ${c.rulerStarId}`;
      if (!(o.hold >= 0 && o.hold <= 1)) return `${c.id} hold ${o.hold}`;
      if (o.homeWorld) {
        const s = (engine as any).stars.find((x: any) => x.id === c.starId);
        if (c.seizedTick == null || c.lineage) return `${c.id} occupied home world not marked seized`;
        if (s?.isPlayerStar) return `${c.id}: the player's home star occupied (not modelled)`;
      }
    }
    return null;
  },
});

const lastHome = new Map<string, string>();   // seed -> "starId:index"
rule({
  // Home is chosen once (start, exodus). Discovery landings at Space Age /
  // Interstellar must not move it to another planet (#16, #17).
  name: 'the home planet never changes while the home star does not',
  check: ({ engine, seedName }) => {
    const ps = engine.getPlayerStar();
    if (!ps) return null;
    const now = `${ps.id}:${engine.homeIndexOf(ps)}`, prev = lastHome.get(seedName);
    lastHome.set(seedName, now);
    if (!prev || prev.split(':')[0] !== String(ps.id)) return null;
    return prev === now ? null : `home moved from orbit ${+prev.split(':')[1] + 1} to ${engine.homeIndexOf(ps) + 1}`;
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
        const ctx: Ctx = { engine, stars: (engine as any).stars as Star[], tick, seedName: seed };
        for (const r of rules) {
          const detail = r.check(ctx);
          if (detail) {
            failCount.set(r, (failCount.get(r) ?? 0) + 1);
            if (!failures.has(r)) failures.set(r, { seed, tick, detail });
          }
        }
      }
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

// ── Scenario: home stays home through discovery landings (#16, #17) ─────────
// Space Age lands on orbit 1 and Interstellar on every orbit. A home world
// further out must stay home, with the same surface grid.
{
  const r: Rule = { name: 'scenario: home stays home through Space Age and Interstellar landings', check: () => null };
  rules.push(r);
  let detail: string | null = 'no seed with the home world beyond orbit 2 in 40 tries';
  for (let k = 0; k < 40; k++) {
    resetGameState('Inv_home');
    const h = new BigBangEngine(makeCanvas()) as any;
    h.init(SEEDS[0].stats, `inv_home_${k}`);
    const ps = h.getPlayerStar();
    if (!ps) continue;
    const home = h.homeIndexOf(ps);
    if (home < 2) continue;                       // need planets inside the home orbit
    const homePlanet = ps.planets[home];
    const grid = h.ensurePlayerGrid();
    for (const lvl of [5, 6]) {
      ps.civLevel = lvl;
      for (let i = 0; i < 3; i++) h.advancePlayerPlanetDiscovery(ps);
    }
    const after = h.homeIndexOf(ps);
    detail = after !== home ? `seed inv_home_${k}: home moved from orbit ${home + 1} to ${after + 1}`
      : h.homeWorld(ps) !== homePlanet || h.homePlanetOf(ps) !== homePlanet ? 'homeWorld/homePlanetOf disagree with homeIndexOf'
      : h.ensurePlayerGrid() !== grid ? 'home grid was rebuilt after the landings'
      : null;
    break;
  }
  if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
}

// ── Scenario: a colony ark, end to end (Colonies.ts, P1) ────────────────────
// Real engine paths: launch → voyage (fleet) → landfall → growth → save/load.
{
  const r: Rule = { name: 'scenario: colony ark launches, lands, grows and survives a save', check: () => null };
  rules.push(r);
  let detail: string | null = null;
  try {
    resetGameState('Inv_colony');
    gameState.skipFormation = true;
    const e = new BigBangEngine(makeCanvas()) as any;
    e.init(SEEDS[0].stats, 'inv_colony');
    for (let i = 0; i < 2_100; i++) e.update();
    const ps = e.getPlayerStar();
    const launcher = { starId: ps.id, x: ps.x, y: ps.y, era: 6, techs: ['colony_ark'],
      pressures: { hunger: 0, crowding: 1, scarcity: 0, unrest: 0, pollution: 0 },
      values: { militarism: 0.5, piety: 0.5, curiosity: 0.8, collectivism: 0.5, xenophobia: 0.2 }, isPlayer: true };
    const sites = (e.colonyCandidates() as any[]).filter(c => e.canSettle(ps.id, c))
      .sort((a, b) => b.suitability - a.suitability);
    if (!sites.length) throw new Error('no settleable world at all');
    const site = sites[0];
    e.launchArk(launcher, site);
    const ark = e.fleets.find((f: any) => f.ark);
    if (!ark) throw new Error('no ark fleet after launch');
    // Fly it; a landfall roll is suitability-weighted, so retry the arrival a few times if it is lost.
    let colony = null;
    for (let attempt = 0; attempt < 12 && !colony; attempt++) {
      if (attempt > 0) e.launchArk(launcher, site);
      for (let i = 0; i < 1_000 && e.fleets.some((f: any) => f.ark); i++) e.updateFleets();
      colony = e.colonyAt(site.starId, site.planetIndex);
    }
    if (!colony) throw new Error(`twelve arks to the best world (suitability ${sites[0].suitability.toFixed(2)}), no landfall`);
    if (!colony.byPlayer || !colony.lineage) throw new Error('player colony without its own lineage copy');
    if (colony.lineage === gameState.playerSpecies.find((sp: any) => sp.id === colony.homeLineageId)) throw new Error('lineage is shared, not copied');
    const p0 = colony.population;
    for (let i = 0; i < 20; i++) e.stepColonyWorlds([], null);
    if (!(colony.population > p0)) throw new Error(`no growth on a good world (${p0} → ${colony.population})`);
    const snap = JSON.parse(JSON.stringify(e.serialize()));
    const e2 = new BigBangEngine(makeCanvas()) as any;
    e2.init(SEEDS[0].stats, 'inv_colony');
    e2.loadState(snap);
    const c2 = e2.colonyAt(site.starId, site.planetIndex);
    if (!c2 || Math.abs(c2.population - colony.population) > 1e-9) throw new Error('colony did not survive save/load');
  } catch (err) { detail = (err as Error).message; }
  if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
}

// ── Scenario: early expansion is limited until interstellar (Colonies.ts tiers) ─
{
  const r: Rule = { name: 'scenario: Space Age outposts stay home and small until the colony ark', check: () => null };
  rules.push(r);
  let detail: string | null = null;
  try {
    const { capabilityOf, pickTarget, emptyColonies, foundColony, stepColonies } = await import('../src/simulation/Colonies');
    const values = { militarism: 0.5, piety: 0.5, curiosity: 0.9, collectivism: 0.5, xenophobia: 0.1 };
    const pressures = { hunger: 0, crowding: 1, scarcity: 0, unrest: 0, pollution: 0 };
    const early = { starId: 1, x: 0, y: 0, era: 5, techs: ['rocketry'], pressures, values, isPlayer: false };
    const cands = [
      { starId: 1, planetIndex: 2, name: 'home system world', x: 0, y: 0, suitability: 0.4 },
      { starId: 2, planetIndex: 0, name: 'better world next door', x: 50, y: 0, suitability: 0.95 },
    ];
    if (capabilityOf(early.techs).tier !== 1) throw new Error('rocketry is not tier 1');
    const t1 = pickTarget(early, cands, new Set());
    if (t1?.starId !== 1) throw new Error(`a Space Age people targeted star #${t1?.starId} outside its system`);
    const t3 = pickTarget({ ...early, era: 6, techs: ['rocketry', 'orbital', 'colony_ark'] }, cands, new Set());
    if (t3?.starId !== 2) throw new Error('a colony-ark people did not reach the better world next door');
    const st = emptyColonies();
    const c = foundColony(st, cands[0], { starId: 1, isPlayer: false, lineage: null, tier: 1 }, 0);
    for (let i = 0; i < 200; i++) stepColonies(st, () => true, () => 1);
    if (c.population > 0.2 + 1e-9) throw new Error(`a tier-1 outpost grew to ${c.population.toFixed(2)} (> 0.20)`);
    if (c.status !== 'outpost') throw new Error('a tier-1 outpost became a colony');
    for (let i = 0; i < 200; i++) stepColonies(st, () => true, () => 3);
    if (!(c.population > 0.25) || c.status !== 'colony') throw new Error(`after the colony ark the outpost stayed at ${c.population.toFixed(2)} (${c.status})`);
  } catch (err) { detail = (err as Error).message; }
  if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
}

// ── Scenarios: sovereignty (Sovereignty.ts, P3) ─────────────────────────────
{
  const S = await import('../src/simulation/Sovereignty');
  const C = await import('../src/simulation/Colonies');
  const { SeedRNG } = await import('../src/utils/SeedRNG');
  const scen = (name: string, run: () => string | null) => {
    const r: Rule = { name: `scenario: ${name}`, check: () => null };
    rules.push(r);
    let detail: string | null;
    try { detail = run(); } catch (err) { detail = `threw: ${(err as Error).message}`; }
    if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
  };
  const mk = (over: any = {}) => {
    const st = C.emptyColonies();
    const c = C.foundColony(st, { starId: 9, planetIndex: 1, name: 'Testworld', x: 0, y: 0, suitability: 0.7 },
      { starId: 1, isPlayer: true, lineage: null, tier: 3 }, 0);
    c.status = 'colony'; c.population = 0.5;
    return Object.assign(c, over);
  };

  scen('near colonies stay loyal; far, changed ones break away; orphans govern themselves', () => {
    const rng = new SeedRNG('loyal');
    const near = mk();
    for (let g = 0; g < 300; g++) if (S.stepLoyalty(near, 0.8, true, g, rng.next())) return `a same-system colony broke away at generation ${g}`;
    const far = mk();
    for (let g = 0; g < 300; g++) if (S.stepLoyalty(far, 0.3, true, g, rng.next())) return `a far colony of the SAME people broke away at generation ${g} (loyalty ${far.loyalty.toFixed(2)})`;
    const apart = mk({ stage: 'species' });
    let at = -1;
    for (let g = 0; g < 80 && at < 0; g++) if (S.stepLoyalty(apart, 0.1, true, g, rng.next())) at = g;
    if (at < 0) return `an isolated new species never broke away (loyalty ${apart.loyalty.toFixed(2)})`;
    if (at < 8) return `broke away after only ${at} generations — owner wants it slow`;
    if (apart.status !== 'independent' || S.rulerOf(apart) !== null || S.ruledByPlayer(apart) || !S.concernsPlayer(apart)) return 'independence did not take';
    const outpost = mk({ status: 'outpost', stage: 'species' });
    for (let g = 0; g < 200; g++) if (S.stepLoyalty(outpost, 0.1, true, g, rng.next())) return 'an outpost broke away while its rulers still stand';
    const orphan = mk({ status: 'outpost' });
    if (S.stepLoyalty(orphan, 0, false, 5, 0.99) !== 'independent') return 'a colony whose rulers are gone stayed theirs';
    return null;
  });

  scen('an occupation ends in liberation or absorption, by numbers and edge', () => {
    const run = (c: any, f: any, seed: string, n = 120) => {
      const rng = new SeedRNG(seed);
      for (let g = 0; g < n; g++) { const how = S.stepOccupation(c, f, rng.next()); if (how) return { how, g }; }
      return null;
    };
    const big = mk(); S.occupyColony(big, { starId: 5, isPlayer: false }, 0);
    if (big.status !== 'occupied' || S.ruledByPlayer(big) || big.occupation?.prevRulerStarId !== 1 || !big.occupation.prevByPlayer) return 'occupation did not record the former rulers';
    const r1 = run(big, { advantage: 0, occupierPresent: true }, 'big');
    if (r1?.how !== 'liberated') return `a large colony at an even match: ${JSON.stringify(r1)}`;
    S.endOccupation(big, 'liberated', true, 1);
    if (big.status !== 'colony' || !S.ruledByPlayer(big) || big.occupation) return `liberation did not return it to the player (${big.status})`;
    const small = mk({ population: 0.2 }); S.occupyColony(small, { starId: 5, isPlayer: false }, 0);
    const r2 = run(small, { advantage: 1 / 3, occupierPresent: true }, 'small');
    if (r2?.how !== 'absorbed') return `a small colony against a stronger occupier: ${JSON.stringify(r2)}`;
    S.endOccupation(small, 'absorbed', true, 1);
    if (small.status !== 'colony' || S.rulerOf(small) !== 5) return 'absorption did not hand it to the conqueror';
    const gone = mk({ population: 0.2 }); S.occupyColony(gone, { starId: 5, isPlayer: false }, 0);
    const r3 = run(gone, { advantage: 1, occupierPresent: false }, 'gone');
    if (r3?.how !== 'liberated' || r3.g > 3) return `an absent occupier kept its hold: ${JSON.stringify(r3)}`;
    S.endOccupation(gone, 'liberated', false, 1);
    if (gone.status !== 'independent') return 'liberated with its old rulers gone, yet not independent';
    const home = mk({ population: 1 }); S.occupyColony(home, { starId: 5, isPlayer: false }, 0); home.occupation!.homeWorld = true;
    const r4 = run(home, { advantage: 1, occupierPresent: true }, 'home', 400);
    if (r4?.how === 'absorbed') return 'a home world was absorbed';
    if (home.occupation!.hold > S.HOME_HOLD_MAX) return `home hold ${home.occupation!.hold}`;
    return null;
  });
}

{
  const r: Rule = { name: 'scenario: a won war takes a player colony; it is freed when the occupier falls; saves keep it', check: () => null };
  rules.push(r);
  let detail: string | null = null;
  try {
    const S = await import('../src/simulation/Sovereignty');
    resetGameState('Inv_conquest');
    gameState.skipFormation = true;
    const e = new BigBangEngine(makeCanvas()) as any;
    e.init(SEEDS[0].stats, 'inv_conquest');
    for (let i = 0; i < 2_100; i++) e.update();
    const ps = e.getPlayerStar();
    const L = { starId: ps.id, x: ps.x, y: ps.y, era: 6, techs: ['colony_ark'],
      pressures: { hunger: 0, crowding: 1, scarcity: 0, unrest: 0, pollution: 0 },
      values: { militarism: 0.5, piety: 0.5, curiosity: 0.8, collectivism: 0.5, xenophobia: 0.2 }, isPlayer: true };
    const sites = (e.colonyCandidates() as any[]).filter(c => e.canSettle(ps.id, c) && c.starId !== ps.id).sort((a, b) => b.suitability - a.suitability);
    let col: any = null;
    for (const site of sites.slice(0, 6)) {
      for (let k = 0; k < 12 && !col; k++) { e.launchArk(L, site); for (let i = 0; i < 1_000 && e.fleets.some((f: any) => f.ark); i++) e.updateFleets(); col = e.colonyAt(site.starId, site.planetIndex); }
      if (col) break;
    }
    if (!col) throw new Error('could not found a colony');
    col.status = 'colony'; col.population = 0.5;
    e.colonies.lastLaunch[ps.id] = Infinity;
    // An interstellar people elsewhere, with the ships to hold a world.
    const foe = e.stars.find((s: any) => !s.isPlayerStar && !s.isDead && !s.formationStage && s.id !== col.starId && s.planets.length);
    Object.assign(foe, { hasLife: true, biologyPhase: 'intelligent', civLevel: 6 });
    foe.planets[0].hasLife = true;
    e.interstellar.polities[foe.id] = { ...(e.interstellar.polities[foe.id] ?? {}), techs: ['rocketry', 'orbital', 'colony_ark'] };
    let taken = false;
    for (let id = 9000; id < 9040 && !taken; id++) {
      e.conquestAfterWar({ id, attackerStarId: foe.id, defenderStarId: ps.id, attackerStrength: 0.9, defenderStrength: 0.1 }, foe, ps);
      taken = col.status === 'occupied';
    }
    if (!taken) throw new Error('forty clear victories took nothing');
    if (S.ruledByPlayer(col) || !S.concernsPlayer(col) || S.rulerOf(col) !== foe.id) throw new Error('occupied colony still counted as the player\'s');
    if (e.colonyAt(ps.id, e.homeIndexOf(ps))) throw new Error("the player's home world was taken");
    // Saves keep the occupation.
    const e2 = new BigBangEngine(makeCanvas()) as any;
    e2.init(SEEDS[0].stats, 'inv_conquest');
    e2.loadState(JSON.parse(JSON.stringify(e.serialize())));
    const c2 = e2.colonyAt(col.starId, col.planetIndex);
    if (c2?.status !== 'occupied' || c2.occupation?.byStarId !== foe.id) throw new Error('occupation did not survive save/load');
    // The occupier falls: the colony rises and returns to the player.
    foe.isDead = true;
    for (let g = 0; g < 6 && col.occupation; g++) { e.tick += 2_000; e.stepColonyWorlds([], null); }
    const now = e.colonyAt(col.starId, col.planetIndex);
    if (!now || now.occupation || !S.ruledByPlayer(now)) throw new Error(`not freed back to the player (${now?.status}, hold ${now?.occupation?.hold})`);
  } catch (err) { detail = (err as Error).message; }
  if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
}

{
  const r: Rule = { name: "scenario: a won war can occupy another civilisation's home world; its people stay", check: () => null };
  rules.push(r);
  let detail: string | null = null;
  try {
    resetGameState('Inv_occupy');
    gameState.skipFormation = true;
    const e = new BigBangEngine(makeCanvas()) as any;
    e.init(SEEDS[0].stats, 'inv_occupy');
    for (let i = 0; i < 2_100; i++) e.update();
    const others = e.stars.filter((s: any) => !s.isPlayerStar && !s.isDead && !s.formationStage && s.planets.length);
    const [a, b] = others;
    for (const s of [a, b]) { Object.assign(s, { hasLife: true, biologyPhase: 'intelligent', civLevel: 6 }); s.planets[e.homeIndexOf(s)].hasLife = true; }
    const bHome = e.homeIndexOf(b);
    if (b.planets[bHome].type === 'gas') b.planets[bHome].type = 'rocky';
    e.interstellar.polities[a.id] = { ...(e.interstellar.polities[a.id] ?? {}), techs: ['rocketry', 'orbital', 'colony_ark'] };
    let c: any = null;
    for (let id = 9100; id < 9140 && !c; id++) {
      e.conquestAfterWar({ id, attackerStarId: a.id, defenderStarId: b.id, attackerStrength: 0.9, defenderStrength: 0.1 }, a, b);
      c = e.colonyAt(b.id, bHome);
    }
    if (!c) throw new Error('no home world taken in forty clear victories');
    if (!c.occupation?.homeWorld || c.occupation.prevRulerStarId !== b.id) throw new Error('not recorded as an occupied home world');
    if (!(b.hasLife && b.biologyPhase === 'intelligent')) throw new Error('the natives did not stay');
    if (!e.canSettle || e.colonies.colonies.filter((x: any) => x.starId === b.id).length !== 1) throw new Error('duplicate records');
    // The natives are lost: the occupiers remain as a plain colony.
    b.biologyPhase = 'multicellular';
    e.tick += 2_000; e.stepColonyWorlds([], null);
    const after = e.colonyAt(c.starId, c.planetIndex);
    if (!after || after.occupation || after.status !== 'colony') throw new Error(`with the natives gone it stayed ${after?.status}`);
  } catch (err) { detail = (err as Error).message; }
  if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
}

// ── Scenarios: divergence (Divergence.ts, P2) ───────────────────────────────
{
  const D = await import('../src/simulation/Divergence');
  const { forgeCreature } = await import('../src/rendering/CreatureForge');
  const { createPrimordialSpecies } = await import('../src/simulation/SpeciesGenome');
  const { SeedRNG } = await import('../src/utils/SeedRNG');
  const scen = (name: string, run: () => string | null) => {
    const r: Rule = { name: `scenario: ${name}`, check: () => null };
    rules.push(r);
    let detail: string | null;
    try { detail = run(); } catch (err) { detail = `threw: ${(err as Error).message}`; }
    if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
  };
  const live = (env: any, contact: number, gens: number, seed: string) => {
    const rng = new SeedRNG(seed), opt = D.optimumFor(env);
    let a = { ...D.NO_ADAPTATION };
    for (let g = 0; g < gens; g++) a = D.generationStep(a, opt, contact, () => rng.next());
    return a;
  };

  scen('a cold heavy world breeds smaller shaggy people, a hot light one larger sleek ones', () => {
    const home = { radius: 4, orbitalRadius: 30, type: 'rocky', starTemperature: 5800 };
    const cold = D.worldEnv({ radius: 6, orbitalRadius: 48, type: 'ice', starTemperature: 5800 }, home);
    const hot = D.worldEnv({ radius: 2.6, orbitalRadius: 20, type: 'desert', starTemperature: 5800 }, home);
    const a = live(cold, 0.3, 80, 'cold'), b = live(hot, 0.3, 80, 'hot');
    if (!(a.size < -0.05 && b.size > 0.05)) return `size: cold ${a.size.toFixed(2)}, hot ${b.size.toFixed(2)}`;
    if (!(a.insulation > 0.05 && b.insulation < -0.05)) return `insulation: cold ${a.insulation.toFixed(2)}, hot ${b.insulation.toFixed(2)}`;
    if (!(a.pigment < b.pigment)) return `pigment: cold ${a.pigment.toFixed(2)} not paler than hot ${b.pigment.toFixed(2)}`;
    const twin = live(D.worldEnv(home, home), 0.3, 80, 'twin');
    if (D.distanceFromHome(twin) > D.STAGE_AT.variant) return `a world like home diverged to ${D.distanceFromHome(twin).toFixed(2)}`;
    const iso = D.distanceFromHome(live(cold, 0, 40, 'iso')), conn = D.distanceFromHome(live(cold, 1, 40, 'conn'));
    if (!(iso > conn)) return `contact did not slow divergence (isolated ${iso.toFixed(2)} vs connected ${conn.toFixed(2)})`;
    if (D.stageOf(D.distanceFromHome(live(cold, 0, 9, 'fast')), 0) !== 'same') return 'a visible variant in under 10 generations — owner wants it slow';
    return null;
  });

  scen('adapted creatures are drawn darker and stouter', () => {
    const base = createPrimordialSpecies(0);
    base.dna.locomotion = 'walking'; base.dna.environment = 'land'; base.physicalTraits.size = 'medium'; base.physicalTraits.bodyStructure = 'endoskeletal';
    const dark = { ...base, adaptations: { size: 0.6, pigment: 0.7, eyes: 0, insulation: 0 } };
    const f0 = forgeCreature(base as any, 32) as any, f1 = forgeCreature(dark as any, 32) as any;
    const stats = (f: any) => {
      const d: Uint8ClampedArray | number[] = f.data ?? f.pixels ?? f.rgba;
      let n = 0, lum = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) { n++; lum += d[i] + d[i + 1] + d[i + 2]; }
      return { n, lum: n ? lum / n : 0 };
    };
    const s0 = stats(f0), s1 = stats(f1);
    if (!s0.n) return `no pixels in the forged sprite (keys: ${Object.keys(f0).join(',')})`;
    if (!(s1.lum < s0.lum - 5)) return `not darker: mean ${s0.lum.toFixed(0)} → ${s1.lum.toFixed(0)}`;
    // Sprites are framed to their length, so size shows as girth (more covered pixels).
    if (!(s1.n > s0.n)) return `not stouter: ${s0.n} → ${s1.n} px`;
    return null;
  });
}

{
  const r: Rule = { name: 'scenario: a colony lives 30 generations, diverges, and keeps it through a save', check: () => null };
  rules.push(r);
  let detail: string | null = null;
  try {
    resetGameState('Inv_diverge');
    gameState.skipFormation = true;
    const e = new BigBangEngine(makeCanvas()) as any;
    e.init(SEEDS[0].stats, 'inv_diverge');
    for (let i = 0; i < 2_100; i++) e.update();
    const ps = e.getPlayerStar();
    const L = { starId: ps.id, x: ps.x, y: ps.y, era: 6, techs: ['colony_ark'],
      pressures: { hunger: 0, crowding: 1, scarcity: 0, unrest: 0, pollution: 0 },
      values: { militarism: 0.5, piety: 0.5, curiosity: 0.8, collectivism: 0.5, xenophobia: 0.2 }, isPlayer: true };
    // The world LEAST like home that can still be settled: most to adapt to.
    const sites = (e.colonyCandidates() as any[]).filter(c => e.canSettle(ps.id, c));
    const envDist = (c: any) => { const g = e.colonyGenerationInputs({ starId: c.starId, planetIndex: c.planetIndex, founderStarId: ps.id, byPlayer: true });
      return g ? Math.hypot(g.env.gravity, g.env.light, g.env.heat) : 0; };
    sites.sort((a, b) => envDist(b) - envDist(a));
    let col: any = null;
    for (const site of sites.slice(0, 6)) {
      for (let k = 0; k < 12 && !col; k++) { e.launchArk(L, site); for (let i = 0; i < 1_000 && e.fleets.some((f: any) => f.ark); i++) e.updateFleets(); col = e.colonyAt(site.starId, site.planetIndex); }
      if (col) break;
    }
    if (!col) throw new Error('could not found a colony');
    e.colonies.lastLaunch[ps.id] = Infinity;   // no further launches during the test
    for (let g = 0; g < 30; g++) { e.tick += 2_000; e.stepColonyWorlds([], null); }
    if (col.generations !== 30) throw new Error(`expected 30 generations, got ${col.generations}`);
    const D = await import('../src/simulation/Divergence');
    const dist = D.distanceFromHome(col.adaptations);
    if (!(dist > 0.01)) throw new Error(`no divergence after 30 generations (distance ${dist.toFixed(3)}, env ${JSON.stringify(e.colonyGenerationInputs(col).env)})`);
    if (JSON.stringify(col.lineage?.adaptations) !== JSON.stringify(col.adaptations)) throw new Error('lineage copy not updated');
    const home = gameState.playerSpecies.find((sp: any) => sp.id === col.homeLineageId);
    if (home?.adaptations) throw new Error('the HOME species changed — colony adaptations leaked into it');
    const e2 = new BigBangEngine(makeCanvas()) as any;
    e2.init(SEEDS[0].stats, 'inv_diverge');
    e2.loadState(JSON.parse(JSON.stringify(e.serialize())));
    const c2 = e2.colonyAt(col.starId, col.planetIndex);
    if (!c2 || JSON.stringify(c2.adaptations) !== JSON.stringify(col.adaptations) || c2.generations !== 30) throw new Error('divergence did not survive save/load');
  } catch (err) { detail = (err as Error).message; }
  if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
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
  console.log(`        ${failCount.get(r)}/${samples} samples; first at seed=${f.seed} tick=${f.tick}: ${f.detail}`);
}
for (const c of crashes) console.log(`  CRASH ${c}`);

console.log(`\n  (formation rule checked ${formingSamples} forming samples)`);
console.log(`\n═══ ${blocking === 0 ? 'OK' : `${blocking} BLOCKING FAILURE(S)`} in ${((Date.now() - t0) / 1000).toFixed(1)}s ═══`);
process.exit(blocking === 0 ? 0 : 1);
