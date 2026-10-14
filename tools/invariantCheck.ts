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
const { systemReach } = await import('../src/rendering/viewCull');
const { planetOffsetFromStar } = await import('../src/simulation/Orbit');
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
  // The system view culls a system by its star plus this reach; a planet
  // outside it would vanish while on screen (#84).
  name: 'every planet lies within its system\'s view reach',
  check: ({ stars, engine }) => firstBad(stars.filter(s => !s.isDead && s.planets.length), s => {
    const reach = systemReach(s);
    const t = (engine as any).animTick ?? 0;
    return s.planets.some((p: any) => Math.hypot(planetOffsetFromStar(p, t).x, planetOffsetFromStar(p, t).y) > reach + 0.5);
  }, s => `star ${s.id}: reach ${systemReach(s).toFixed(1)}`),
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
  // One life record (rule 7): a living, formed system's life world is alive.
  // An asteroid impact used to mark the home world lifeless under a living
  // civilisation ("No life detected" beside 100 billion people).
  name: "a living system's life world is alive",
  check: ({ engine, stars }) => firstBad(stars.filter(s => !s.isDead && s.hasLife && !s.formationStage), s => {
    const lp = s.planets[(engine as any).homeIndexOf(s)];
    return !!lp && !lp.isDead && !lp.hasLife;
  }, s => `#${s.id} ${s.biologyPhase}, life world #${(engine as any).homeIndexOf(s)} hasLife=false`),
});

rule({
  // One source of truth (#9, #21): the player's era IS what its nations know.
  // Wars, absorption, catastrophes and Creative leaps move the era from
  // outside; the engine reconciles the nations the same tick.
  name: "the player's era equals its nations' era",
  check: ({ engine, stars }) => {
    const ps = stars.find(s => s.isPlayerStar);
    const ns = runtimeState.playerNations;
    if (!ps || !ns?.isFounded || !ps.hasLife || ps.biologyPhase !== 'intelligent') return null;
    const want = Math.min(ns.maxEra, TECH_LEVELS.length - 1);
    if (ps.civLevel !== want) return `civLevel=${ps.civLevel}, nations' era=${ns.maxEra}`;
    const p = (engine as any).progressionOf(ps);
    if (p.era !== ps.civLevel || p.eraName !== (engine as any).eraNameOf(ps)) return `progression ${p.era} "${p.eraName}" vs era ${ps.civLevel} "${(engine as any).eraNameOf(ps)}"`;
    return null;
  },
});

rule({
  // Every view reads one progression (#9): its stage matches the star, and
  // its labels are the ones for that stage and era.
  name: 'progression agrees with the star it describes',
  check: ({ engine, stars }) => firstBad(stars.filter(s => !s.isDead), s => {
    const p = (engine as any).progressionOf(s);
    const stage = s.formationStage ? 'forming' : !s.hasLife ? 'lifeless' : s.biologyPhase !== 'intelligent' ? 'life' : 'civilization';
    if (p.stage !== stage) return true;
    if (stage === 'civilization' && (p.era !== s.civLevel || !p.eraName.endsWith(TECH_LEVELS[s.civLevel]) || !p.fullLabel.includes(p.eraName))) return true;
    if (s.formationStage === 'magma' && p.worldDnaKnown) return true;     // #18
    return false;
  }, s => { const p = (engine as any).progressionOf(s); return `stage ${p.stage}, era ${p.era} "${p.eraName}", civLevel ${s.civLevel}, ${s.formationStage ?? s.biologyPhase}`; }),
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
  // World history (#17): bounded, in order, never from the future.
  name: 'world histories are bounded and in order',
  check: ({ engine }) => {
    const e = engine as any;
    for (const [k, log] of Object.entries(e.worldHistory as Record<string, any[]>)) {
      if (log.length > 60) return `${k}: ${log.length} entries`;
      for (let i = 0; i < log.length; i++) {
        if (log[i].tick > e.tick) return `${k}: entry from the future (${log[i].tick} > ${e.tick})`;
        if (i && log[i].tick < log[i - 1].tick) return `${k}: out of order at ${i}`;
      }
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

const { LEDGER_MAX } = await import('../src/simulation/Nations');
rule({
  // The World Ledger reads these: samples bounded and in order, and every
  // explanation finite (a NaN would print as "NaN% fed").
  name: "nations' ledgers are bounded and in order; their explanations are finite",
  check: () => {
    const ns = runtimeState.playerNations;
    if (!ns?.isFounded) return null;
    for (let k = 0; k < ns.nations.length; k++) {
      const log = ns.ledger[k] ?? [];
      if (log.length > LEDGER_MAX) return `${ns.nations[k].name}: ${log.length} samples`;
      for (let i = 1; i < log.length; i++) if (log[i].age < log[i - 1].age) return `${ns.nations[k].name}: sample ${i} goes back in time`;
      const x = ns.explain(k);
      if (!x) continue;
      const nums = [x.fed, x.carries, x.pollution.settles, x.pollution.fromTechs, x.pollution.fromCards, x.cohesionTarget,
        x.food.techs, x.food.cards, x.food.season, x.materials.techs, x.research.techs, x.research.cards];
      if (nums.some(v => !Number.isFinite(v))) return `${ns.nations[k].name}: explain() gave ${nums.join(', ')}`;
      if (x.pollution.settles < 0 || x.pollution.settles > 1 || x.cohesionTarget < 0 || x.cohesionTarget > 1) return `${ns.nations[k].name}: settles ${x.pollution.settles}, cohesion → ${x.cohesionTarget}`;
    }
    return null;
  },
});

rule({
  // System encounters (#115) stretch, capture and remove planets: every orbit
  // left behind must still be one the orbit drawer can place.
  name: 'planet orbits are well-formed',
  check: ({ engine }) => {
    for (const s of (engine as any).stars as any[]) for (const p of s.planets) {
      const e = p.eccentricity ?? 0;
      if (!(p.orbitalRadius > 0) || !Number.isFinite(p.orbitalSpeed) || !(e >= 0 && e <= 0.72) || !Array.isArray(p.moons)) {
        return `star #${s.id} planet ${p.name}: a=${p.orbitalRadius}, e=${e}, speed=${p.orbitalSpeed}`;
      }
    }
    return null;
  },
});

rule({
  // Tech cards (#40): TP is spent, never owed; a technology pays its TP once.
  name: 'TP never negative; each technology paid once',
  check: () => {
    if (gameState.techPoints < 0) return `techPoints ${gameState.techPoints}`;
    const paid = gameState.techRewarded ?? [];
    return new Set(paid).size === paid.length ? null : `${paid.length - new Set(paid).size} technologies paid twice`;
  },
});

rule({
  // A timed tech-card effect never outlives a full age of the slowest pace by much (no stuck shields).
  name: 'tech card effects are bounded in time',
  check: ({ engine }) => {
    const fx = gameState.techEffects ?? {};
    const far = (engine as any).tick + 400_000;
    return (fx.defenceUntil ?? 0) > far || (fx.kinshipUntil ?? 0) > far ? `defence ${fx.defenceUntil}, kinship ${fx.kinshipUntil} at tick ${(engine as any).tick}` : null;
  },
});

const { orreryColor } = await import('../src/rendering/OrreryPalette');
rule({
  // The system panel's orrery appends alpha digits to each planet's colour; a
  // short '#888' fallback threw and kept the panel shut (clicking a sun did nothing).
  name: 'every planet type has a six-digit orrery colour',
  check: ({ engine }) => {
    for (const s of (engine as any).stars as any[]) for (const p of s.planets) {
      if (!/^#[0-9a-f]{6}$/i.test(orreryColor(p.type))) return `star #${s.id} planet type '${p.type}' → ${orreryColor(p.type)}`;
    }
    return null;
  },
});

const lastHome = new Map<string, string>();   // seed -> "starId:index:homeMovedTick"
rule({
  // Home is chosen once (start, exodus). Discovery landings at Space Age /
  // Interstellar must not move it to another planet (#16, #17). The one
  // exception is the people moving on purpose ("A New World", a TP card),
  // which records itself in gameState.homeMoved.
  name: 'the home planet never changes while the home star does not',
  check: ({ engine, seedName }) => {
    const ps = engine.getPlayerStar();
    if (!ps) return null;
    const moved = gameState.homeMoved;
    const idx = engine.homeIndexOf(ps);
    const now = `${ps.id}:${idx}:${moved?.tick ?? -1}`, prev = lastHome.get(seedName);
    lastHome.set(seedName, now);
    if (!prev || prev.split(':')[0] !== String(ps.id)) return null;
    const [, prevIdx, prevMoved] = prev.split(':');
    if (+prevIdx === idx) return null;
    const movedHereSince = moved && moved.tick !== +prevMoved && moved.starId === ps.id && moved.planetIndex === idx;
    return movedHereSince ? null : `home moved from orbit ${+prevIdx + 1} to ${idx + 1}`;
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
  gameState.homeMoved = null;
  gameState.techWear = {};
  gameState.techRewarded = [];
  gameState.tpEraHigh = 0;
  gameState.techCardsKnown = [];
  gameState.techEffects = {};
  runtimeState.playerPlanetGrid = null;
  runtimeState.playerNations = null;
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
    // Landed-on worlds in the home system open as dioramas of their own
    // terrain, not the planet renderer (P4 regression); home keeps its grid.
    if (!detail) {
      ps.formationStage = null;                  // a Space Age world is long formed
      if (h.otherWorldView(ps.id, home)) detail = 'the home world got an other-world view';
      for (let i = 0; i < ps.planets.length && !detail; i++) {
        if (i === home || ps.planets[i].isDead || ps.planets[i].discovery !== 'landing') continue;
        const v = h.otherWorldView(ps.id, i);
        if (!v) detail = `landed orbit ${i + 1} (${ps.planets[i].type}) has no diorama view`;
        else if (v.grid === grid) detail = `landed orbit ${i + 1} shares the home grid`;
        else if (v.colony || v.species.length) detail = `landed orbit ${i + 1} shows people with no colony`;
      }
    }
    break;
  }
  if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
}

// ── Scenario: "A New World" (TP card): the whole people moves (#40) ─────────
{
  const scen = (name: string, run: () => string | null) => {
    const r: Rule = { name: `scenario: ${name}`, check: () => null };
    rules.push(r);
    let detail: string | null;
    try { detail = run(); } catch (err) { detail = `threw: ${(err as Error).message}`; }
    if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
  };
  const { RELOCATE_TP, RELOCATE_ERA, RELOCATE_STAR_ERA } = await import('../src/simulation/BigBangEngine');
  const { GRID_SIZE } = await import('../src/simulation/PlanetGrid');

  /** A world at the Space Age with a free world beside home, or null. */
  const spaceAgeWorld = (): { e: any; ps: Star } | null => {
    for (let k = 0; k < 12; k++) {
      resetGameState('Inv_newworld');
      gameState.skipFormation = true;
      const e = new BigBangEngine(makeCanvas()) as any;
      e.init(SEEDS[0].stats, `inv_newworld_${k}`);
      for (let i = 0; i < 3_000; i++) e.update();
      if (!e.leapToEra(RELOCATE_ERA - 1)) continue;
      const ps = e.getPlayerStar() as Star;
      gameState.techPoints = RELOCATE_TP;
      if (!e.relocationBlock()) return null;            // must still be refused below the Space Age
      e.leapToEra(RELOCATE_ERA);
      if (ps.civLevel !== RELOCATE_ERA || !runtimeState.playerNations?.isFounded) continue;
      gameState.techPoints = RELOCATE_TP;
      if (e.relocationTargets().some((t: any) => !t.otherStar)) return { e, ps };
    }
    return null;
  };
  const w = spaceAgeWorld();

  scen('A New World is refused before the Space Age and without the TP', () => {
    if (!w) return 'no seed reached the Space Age with a free world in its system (or the card was allowed too early)';
    gameState.techPoints = RELOCATE_TP - 1;
    const blocked = w.e.relocationBlock();
    const refused = w.e.relocateHome(w.ps.id, w.e.relocationTargets()[0]?.planetIndex ?? 0);
    gameState.techPoints = RELOCATE_TP;
    if (!blocked) return `playable with ${RELOCATE_TP - 1} TP`;
    if (refused !== null) return 'relocateHome went ahead without the TP';
    if (w.e.relocateHome(w.ps.id, w.e.homeIndexOf(w.ps)) !== null) return 'moved to the world it already lives on';
    return null;
  });

  scen('A New World moves the whole people: new home, same era, nations re-sited, old world wild', () => {
    if (!w) return 'no Space Age world';
    const { e, ps } = w;
    const ns = runtimeState.playerNations!;
    const target = e.relocationTargets().find((t: any) => !t.otherStar).planetIndex;
    const oldIdx = e.homeIndexOf(ps), oldPlanet = ps.planets[oldIdx], oldGrid = e.ensurePlayerGrid();
    const era = ps.civLevel, techs = ns.nations.map(n => n.techs.length).join(','), alive = ns.nations.filter(n => !n.fallen).length;
    const tp = gameState.techPoints;
    const line = e.relocateHome(ps.id, target);
    if (!line) return 'refused a listed target';
    if (e.homeIndexOf(ps) !== target) return `home is orbit ${e.homeIndexOf(ps) + 1}, wanted ${target + 1}`;
    if (gameState.techPoints !== tp - RELOCATE_TP) return `TP ${tp} → ${gameState.techPoints}`;
    if (ps.civLevel !== era) return `era ${era} → ${ps.civLevel}`;
    if (runtimeState.playerNations !== ns) return 'the nations were replaced';
    if (ns.nations.map(n => n.techs.length).join(',') !== techs) return 'nations lost what they knew';
    const nowAlive = ns.nations.filter(n => !n.fallen);
    if (nowAlive.length !== alive) return `${alive - nowAlive.length} nation(s) lost in the crossing`;
    const grid = e.ensurePlayerGrid();
    if (!grid || grid === oldGrid) return 'the home grid was not rebuilt for the new world';
    for (const n of nowAlive) {
      if (ns.owner[n.capital.row * GRID_SIZE + n.capital.col] !== n.id) return `${n.name}'s capital is not its own land`;
      if (grid[n.capital.row][n.capital.col].civId == null) return `${n.name}'s capital is not settled`;
    }
    if (!oldPlanet.hasLife) return 'the old world lost its wild life';
    if (!ps.planets[target].hasLife) return 'the new home has no life';
    // The new home stays home, and its grid stays this world's, as time runs.
    for (let i = 0; i < 2_000; i++) e.update();
    if (e.homeIndexOf(ps) !== target) return 'home drifted back after the move';
    if (e.ensurePlayerGrid() !== grid) return 'the new home grid was rebuilt by the simulation';
    return null;
  });

  scen("A New World survives a save: the new home's ground comes from its own DNA", () => {
    if (!w || !gameState.homeMoved) return 'no move to save';
    const { e, ps } = w;
    const biomes = (g: any) => { let h = 0; for (let r = 0; r < GRID_SIZE; r += 8) for (let c = 0; c < GRID_SIZE; c += 8) h = (h * 31 + g[r][c].biome.length + Math.round(g[r][c].elevation * 100)) | 0; return h; };
    const before = biomes(e.ensurePlayerGrid());
    const saved = JSON.parse(JSON.stringify({ engine: e.serialize(), moved: gameState.homeMoved }));
    runtimeState.playerPlanetGrid = null;
    const e2 = new BigBangEngine(makeCanvas()) as any;
    e2.init(SEEDS[0].stats, 'inv_newworld_load');
    e2.loadState(saved.engine);
    gameState.homeMoved = saved.moved;
    runtimeState.playerPlanetGrid = null;
    const ps2 = e2.getPlayerStar();
    if (!ps2 || e2.homeIndexOf(ps2) !== e.homeIndexOf(ps)) return 'the loaded game has another home world';
    return biomes(e2.ensurePlayerGrid()) === before ? null : 'the loaded home world has different ground';
  });
}

// ── Scenario: "A New World" to another star (Interstellar, #40) ──────────────
// Crossing to another star moves the player's identity: everything that was
// the people's must follow them, and the star they left must be left with
// nothing of theirs (rule 7).
{
  const scen = (name: string, run: () => string | null) => {
    const r: Rule = { name: `scenario: ${name}`, check: () => null };
    rules.push(r);
    let detail: string | null;
    try { detail = run(); } catch (err) { detail = `threw: ${(err as Error).message}`; }
    if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
  };
  const { RELOCATE_TP, RELOCATE_ERA, RELOCATE_STAR_ERA } = await import('../src/simulation/BigBangEngine');
  const C = await import('../src/simulation/Colonies');

  const setup = (): { e: any; from: Star } | null => {
    for (let k = 0; k < 12; k++) {
      resetGameState('Inv_newstar');
      gameState.skipFormation = true;
      const e = new BigBangEngine(makeCanvas()) as any;
      e.init(SEEDS[0].stats, `inv_newstar_${k}`);
      for (let i = 0; i < 3_000; i++) e.update();
      if (!e.leapToEra(RELOCATE_ERA)) continue;
      const from = e.getPlayerStar() as Star;
      gameState.techPoints = RELOCATE_TP;
      if (e.relocationTargets().some((t: any) => t.otherStar)) {
        // Known stars are a Space Age people's own system only.
        return null;
      }
      e.leapToEra(RELOCATE_STAR_ERA);
      if (from.civLevel !== RELOCATE_STAR_ERA || !runtimeState.playerNations?.isFounded) continue;
      gameState.techPoints = RELOCATE_TP;
      if (e.relocationTargets().some((t: any) => t.otherStar)) return { e, from };
    }
    return null;
  };
  const w = setup();

  scen('A New World to another star moves everything that was the people\'s, and leaves nothing of theirs behind', () => {
    if (!w) return 'no Interstellar world with a free world under another star (or other stars were offered at the Space Age)';
    const { e, from } = w;
    const a = from.id;
    // Give the people one of everything that is keyed to their star.
    const enemy = (e.stars as Star[]).find(s => !s.isDead && !s.isPlayerStar && s.id !== a)!;
    e.activeWars.push({ id: 9_999, attackerStarId: enemy.id, defenderStarId: a, startTick: e.tick, duration: 1e6,
      phase: 'siege', attackerStrength: 0.5, defenderStrength: 0.5, lastBattleReportTick: e.tick, resolved: false });
    e.orbitalFleets.push({ id: 9_999, warId: 9_999, starId: a, angle: 0, speed: 0.01, orbitRadius: 20, civColor: '#ff0000' });
    e.fleets.push({ id: 9_999, fromStarId: enemy.id, toStarId: a, x: enemy.x, y: enemy.y, progress: 0.5, hostile: true, isPlayerFleet: false });
    const site = (e.stars as Star[]).find(s => !s.isDead && s.id !== a && s.planets.some(p => p.type !== 'gas'))!;
    const colony = C.foundColony(e.colonies, { starId: site.id, planetIndex: site.planets.findIndex(p => p.type !== 'gas'), name: 'Test colony', x: site.x, y: site.y, suitability: 0.6 },
      { starId: a, isPlayer: true, lineage: null, tier: 3 }, e.tick);
    e.colonies.lastLaunch[a] = e.tick;
    e.interstellar.polities[enemy.id] ??= { starId: enemy.id, techs: [], research: null, era: 3, population: 0.5, pollution: 0, inequality: 0, cohesion: 0.8,
      pressures: { hunger: 0, crowding: 0, scarcity: 0, unrest: 0, pollution: 0 }, importFood: 0, importMaterials: 0, attitude: {}, grievance: {} };
    e.interstellar.polities[enemy.id].attitude[a] = -0.7;
    e.interstellar.polities[enemy.id].grievance[a] = 0.4;
    e.interstellar.routes.push({ a: Math.min(a, enemy.id), b: Math.max(a, enemy.id), goods: 'ore', to: a, since: e.tick });
    gameState.factionFlags[a] ??= { colors: ['#123456'] } as any;
    gameState.leaders.push({ id: 'test_leader', starId: a } as any);
    const culture = gameState.civilizations[a];
    const ns = runtimeState.playerNations!;
    const techs = ns.nations.map(n => n.techs.join(',')).join('|');
    const era = from.civLevel, species = gameState.playerSpecies.length;

    const t = e.relocationTargets().find((x: any) => x.otherStar)!;
    const line = e.relocateHome(t.starId, t.planetIndex);
    if (!line) return 'refused a listed target under another star';
    const to = e.getPlayerStar() as Star;
    const b = t.starId;
    const bad: string[] = [];
    const want = (ok: boolean, what: string) => { if (!ok) bad.push(what); };
    want(!!to && to.id === b, `player star is #${to?.id}, wanted #${b}`);
    want(e.currentPlayerStarId === b && gameState.playerStarId === b, 'player star id not moved');
    want(!from.isPlayerStar && from.civLevel === 0 && from.biologyPhase !== 'intelligent' && from.hasLife, `old star: player=${from.isPlayerStar} civ=${from.civLevel} phase=${from.biologyPhase} life=${from.hasLife}`);
    want(!gameState.civilizations[a], 'the old star kept a culture record');
    want(!culture || gameState.civilizations[b] === culture, 'the culture did not move with the people');
    want(to.civLevel === era && to.biologyPhase === 'intelligent' && to.hasLife, `new star: civ=${to.civLevel} phase=${to.biologyPhase}`);
    want(e.homeIndexOf(to) === t.planetIndex, 'home is not the chosen world');
    want(runtimeState.playerNations === ns && ns.nations.map(n => n.techs.join(',')).join('|') === techs, 'the nations changed or forgot');
    want(gameState.playerSpecies.length === species, 'species lost in the crossing');
    const war = e.activeWars.find((x: any) => x.id === 9_999);
    want(war.defenderStarId === b, 'the war stayed with the old star');
    want(e.orbitalFleets.find((x: any) => x.id === 9_999).starId === b, 'the siege stayed at the old star');
    want(!e.fleets.some((x: any) => x.id === 9_999), 'a war fleet still flies at the empty world');
    want(colony.founderStarId === b, 'the colony still answers to the old star');
    want(e.colonies.lastLaunch[b] !== undefined && e.colonies.lastLaunch[a] === undefined, 'launch clock not moved');
    const pol = e.interstellar.polities[enemy.id];
    want(pol.attitude[b] === -0.7 && pol.grievance[b] === 0.4 && pol.attitude[a] === undefined, 'other peoples forgot who they hate');
    want(e.interstellar.routes.every((r: any) => r.a !== a && r.b !== a && r.to !== a && r.a < r.b), 'a trade route still runs to the old star');
    want(!!gameState.factionFlags[b] && !gameState.factionFlags[a], 'the flag stayed behind');
    want(gameState.leaders.every((l: any) => l.starId !== a), 'a leader stayed behind');
    if (bad.length) return bad.join('; ');
    // Time runs: they stay where they went, and the old star stays wild.
    for (let i = 0; i < 3_000; i++) e.update();
    const now = e.getPlayerStar();
    if (now?.id !== b) return `after 3k ticks the player star is #${now?.id}`;
    // A new people may rise from the animals left behind; it must be its own.
    if (from.isPlayerStar || (culture && gameState.civilizations[a] === culture)) return 'the old star is the people\'s again';
    if (e.ensurePlayerGrid() == null) return 'no home grid at the new star';
    // And a save keeps it.
    const e2 = new BigBangEngine(makeCanvas()) as any;
    e2.init(SEEDS[0].stats, 'inv_newstar_load');
    e2.loadState(JSON.parse(JSON.stringify(e.serialize())));
    return e2.getPlayerStar()?.id === b && e2.homeIndexOf(e2.getPlayerStar()) === t.planetIndex ? null : 'the loaded game lives somewhere else';
  });
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
    // The world remembers it (#17), through a save too.
    const hist = (x: any) => (x.worldHistoryAt(col.starId, col.planetIndex) as any[]).map(h => h.text).join(' | ');
    if (!/made landfall/.test(hist(e)) || !/seized/.test(hist(e))) throw new Error(`world history lacks landfall/seizure: ${hist(e)}`);
    if (hist(e2) !== hist(e)) throw new Error('world history did not survive save/load');
    // The occupier falls: the colony rises and returns to the player.
    foe.isDead = true;
    for (let g = 0; g < 6 && col.occupation; g++) { e.tick += 2_000; e.stepColonyWorlds([], null); }
    const now = e.colonyAt(col.starId, col.planetIndex);
    if (!now || now.occupation || !S.ruledByPlayer(now)) throw new Error(`not freed back to the player (${now?.status}, hold ${now?.occupation?.hold})`);
    if (!/rose against/.test(hist(e))) throw new Error(`liberation not in the world's history: ${hist(e)}`);
    // A lost colony's world still remembers who lived there.
    now.population = 0.001; now.suitability = 0;
    e.stepColonyWorlds([], null);
    if (e.colonyAt(col.starId, col.planetIndex)) throw new Error('the dying colony did not die out');
    if (!/is gone/.test(hist(e)) || !/made landfall/.test(hist(e))) throw new Error(`history forgot the lost colony: ${hist(e)}`);
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
    // While held, the Codex species card stays the natives' (P4).
    const { colonyPeopleCard } = await import('../src/simulation/ColonyWorld');
    if (colonyPeopleCard(c, 'X', 'Y')) throw new Error('an occupied home world\'s species card shows the occupiers');
    if (!e.canSettle || e.colonies.colonies.filter((x: any) => x.starId === b.id).length !== 1) throw new Error('duplicate records');
    // The natives are lost: the occupiers remain as a plain colony.
    b.biologyPhase = 'multicellular';
    e.tick += 2_000; e.stepColonyWorlds([], null);
    const after = e.colonyAt(c.starId, c.planetIndex);
    if (!after || after.occupation || after.status !== 'colony') throw new Error(`with the natives gone it stayed ${after?.status}`);
    if (!/^Conquerors from/.test(colonyPeopleCard(after, 'X', 'Y')?.desc ?? '')) throw new Error('with the natives gone the species card is not the occupiers\'');
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
    // The Codex lineage lists it under its home species (P4).
    if (!e.colonyOffshoots(col.homeLineageId).includes(col)) throw new Error('colony missing from its species\' offshoots');
    // Its Codex species card is its own people, not the star's (P4): a colony
    // world's star is often lifeless ("No life detected").
    {
      const { colonyPeopleCard } = await import('../src/simulation/ColonyWorld');
      const card = colonyPeopleCard(col, col.lineage.name, 'Home');
      if (!card || card.name !== col.lineage.name) throw new Error(`colony species card names ${card?.name}, not ${col.lineage.name}`);
      if (!card.desc.includes(`${col.generations} generation`)) throw new Error(`colony species card lacks its generations: ${card.desc}`);
    }
    // Its surface (P4, ColonyWorld.ts): territory sized by population, its own
    // people on it, derived the same way every time, re-stamped as it grows.
    const { territorySize } = await import('../src/simulation/ColonyWorld');
    const { SEA_LEVEL } = await import('../src/simulation/PlanetGrid');
    const count = (g: any[][]) => { let land = 0, civ = 0, ours = 0;
      for (const row of g) for (const c of row) { if (c.elevation > SEA_LEVEL) land++; if (c.civId === col.id) civ++; if (c.dominantSpeciesId === col.lineage.id) ours++; }
      return { land, civ, ours }; };
    // (A land people, so it can live on the settled ground whatever this world is.)
    const env0 = col.lineage.dna.environment;
    col.lineage.dna.environment = 'land';
    const v1 = e.colonyWorldView(col.starId, col.planetIndex);
    if (!v1) throw new Error('no surface view for a colony world');
    if (v1.grid === runtimeState.playerPlanetGrid) throw new Error('colony view shares the home grid');
    const k1 = count(v1.grid);
    if (k1.civ !== territorySize(k1.land, col.population)) throw new Error(`territory ${k1.civ} cells, expected ${territorySize(k1.land, col.population)} of ${k1.land} land`);
    if (!k1.ours) throw new Error(`the colony people are not on their world (${col.lineage.dna.environment}, population ${col.lineage.population})`);
    const snap1 = JSON.stringify(v1.grid.map((r: any[]) => r.map(c => c.civId ? 1 : 0).join('')));
    (e as any).colonyGrids.clear();
    const again = JSON.stringify(e.colonyWorldView(col.starId, col.planetIndex).grid.map((r: any[]) => r.map((c: any) => c.civId ? 1 : 0).join('')));
    if (again !== snap1) throw new Error('the colony surface is not derived deterministically');
    const p0 = col.population;
    col.population = Math.min(1, p0 + 0.3);
    const v2 = e.colonyWorldView(col.starId, col.planetIndex);
    if (v2.sig === v1.sig || !(count(v2.grid).civ > k1.civ)) throw new Error('the surface did not grow with the colony');
    col.population = p0;
    col.lineage.dna.environment = env0;
    if (e.colonyWorldView(ps.id, e.homeIndexOf(ps))) throw new Error('the home world was given a colony view');
    const e2 = new BigBangEngine(makeCanvas()) as any;
    e2.init(SEEDS[0].stats, 'inv_diverge');
    e2.loadState(JSON.parse(JSON.stringify(e.serialize())));
    const c2 = e2.colonyAt(col.starId, col.planetIndex);
    if (!c2 || JSON.stringify(c2.adaptations) !== JSON.stringify(col.adaptations) || c2.generations !== 30) throw new Error('divergence did not survive save/load');
  } catch (err) { detail = (err as Error).message; }
  if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
}

// ── Scenario: the home world's life record and era clock (playtest Oct 13) ──
{
  const r: Rule = { name: 'scenario: an impact does not unmake a living home world; the first era always comes', check: () => null };
  rules.push(r);
  let detail: string | null = null;
  try {
    resetGameState('Inv_homelife');
    gameState.skipFormation = true;
    const e = new BigBangEngine(makeCanvas()) as any;
    e.init(SEEDS[0].stats, 'inv_homelife');
    for (let i = 0; i < 2_100; i++) e.update();
    const ps = e.getPlayerStar();
    const home = ps.planets[e.homeIndexOf(ps)];
    // Repeated impacts: ravaged, thrown back, but alive.
    for (let k = 0; k < 4; k++) e.applyCosmicStrike({ id: 9000 + k, type: 'asteroid_impact', targetStarId: ps.id, scheduledTick: e.tick, warningTick: e.tick, resolved: false, smited: false }, ps);
    if (!home.hasLife) throw new Error('four impacts marked the living home world lifeless');
    // A save broken by the old impact heals: the life world is alive again and its biosphere regrows.
    home.hasLife = false; home.biosphere = 0;
    for (let i = 0; i < 200; i++) e.update();
    if (!home.hasLife || !(home.biosphere > 0)) throw new Error(`a broken home world did not heal (hasLife ${home.hasLife}, biosphere ${home.biosphere})`);
    // The era clock: an odd age against an even rate must still strike (age grows by 2 a tick).
    if (runtimeState.playerNations) runtimeState.playerNations = null;
    Object.assign(ps, { biologyPhase: 'intelligent', civLevel: 0, hasLife: true });
    e.update();                                   // its culture now exists (it changes the rate)
    ps.civLevel = 0;
    const step = Math.max(1, Math.floor(e.civAdvanceRate(ps)));
    // Land the age just before a multiple with the parity that the old
    // `age % step === 0` could never meet (age grows by 2 a tick).
    ps.nextEraAge = undefined;
    ps.age = step * 3 - 3 + (step % 2 === 0 ? 0 : 1);
    if (step % 2 === 0 && ps.age % 2 === 0) ps.age -= 1;
    for (let i = 0; i < 4 && ps.civLevel === 0; i++) e.update();
    if (ps.civLevel < 1) throw new Error(`the first era never came (age ${ps.age}, step ${step}, next ${ps.nextEraAge})`);
  } catch (err) { detail = (err as Error).message; }
  if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
}

// ── Scenario: the player's era and its nations stay one record (#9, #21) ────
{
  const r: Rule = { name: "scenario: a war won, a merged world, a catastrophe and Creative leaps keep era and nations one record", check: () => null };
  rules.push(r);
  let detail: string | null = null;
  try {
    resetGameState('Inv_progression');
    gameState.skipFormation = true;
    const e = new BigBangEngine(makeCanvas()) as any;
    e.init(SEEDS[0].stats, 'inv_progression');
    for (let i = 0; i < 2_100; i++) e.update();
    const ps = e.getPlayerStar();
    if (!e.leapToEra(2)) throw new Error('could not leap to the Medieval age');
    const ns = () => runtimeState.playerNations!;
    const agree = (when: string) => {
      const p = e.progressionOf(ps);
      if (ps.civLevel !== Math.min(ns().maxEra, TECH_LEVELS.length - 1)) throw new Error(`${when}: civLevel ${ps.civLevel} vs nations ${ns().maxEra}`);
      if (p.era !== ps.civLevel || p.eraName !== e.eraNameOf(ps)) throw new Error(`${when}: progression "${p.eraName}" vs "${e.eraNameOf(ps)}"`);
    };
    agree('after the leap');
    // The spoils of a war: the era jumps from outside; the nations learn up to it.
    const before = ns().maxEra;
    e.shiftEra(ps, ps.civLevel + 2, 'the spoils of a war won');
    agree('after a war won');
    if (!(ns().maxEra >= before + 2)) throw new Error(`nations did not learn up to the new era (${before} → ${ns().maxEra})`);
    if (!ns().nations.some((n: any) => n.history.some((h: any) => h.because?.includes('the spoils of a war won')))) throw new Error('the nations do not remember why they learned');
    // A raw write from outside (an old code path) is reconciled by the next tick.
    ps.civLevel += 1;
    e.update();
    agree('one tick after a raw era write');
    // A catastrophe: the era drops, the nations forget past it.
    e.shiftEra(ps, ps.civLevel - 3, 'an asteroid struck the world');
    agree('after a catastrophe');
    // Creative leaps both ways.
    e.leapToEra(6); agree('after a leap up');
    e.leapToEra(1); agree('after a leap down');
    for (let i = 0; i < 300; i++) e.update();
    agree('300 ticks later');
  } catch (err) { detail = (err as Error).message; }
  if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
}

// ── Scenario: the grid collision pass equals the all-pairs one (#116) ───────
// The close-approach pass tests each star only against its grid neighbours
// (it was all pairs, and the main cost of a long game). Crowd the stars so
// many touch, then run the grid pass on one copy of the world and the old
// all-pairs loop on another: the same merges, the same orbit drift.
{
  const r: Rule = { name: 'scenario: the grid collision pass matches the all-pairs pass on a crowded sky', check: () => null };
  rules.push(r);
  let detail: string | null = null;
  try {
    const CAP = 48, MERGE = 22;
    const brute = (eng: any, active: any[]) => {
      for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        if (a.isDead || b.isDead) continue;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const contact = Math.max(MERGE, (a.radius + b.radius) * 1.15);
        if (dist < contact) { eng.mergeStars(a, b); continue; }
        if (dist < CAP && a.galaxyId != null && a.galaxyId === b.galaxyId && a.orbitRadius != null && b.orbitRadius != null) {
          const mid = (a.orbitRadius + b.orbitRadius) * 0.5;
          a.orbitRadius += (mid - a.orbitRadius) * 0.003;
          b.orbitRadius += (mid - b.orbitRadius) * 0.003;
        }
      }
    };
    for (const k of [0.15, 0.3, 0.6]) {
      resetGameState('Inv_grid');
      const e = new BigBangEngine(makeCanvas()) as any;
      e.init(SEEDS[0].stats, 'inv_grid');
      for (let i = 0; i < 3_000; i++) e.update();
      // Pull every star toward the middle: a crowded sky with many contacts.
      const cx = WORLD_SIZE / 2, cy = WORLD_SIZE / 2;
      for (const st of e.stars) { st.x = cx + (st.x - cx) * k; st.y = cy + (st.y - cy) * k; }
      const snap = JSON.parse(JSON.stringify(e.serialize()));
      const e2 = new BigBangEngine(makeCanvas()) as any;
      e2.init(SEEDS[0].stats, 'inv_grid');
      e2.loadState(JSON.parse(JSON.stringify(snap)));
      e.loadState(JSON.parse(JSON.stringify(snap)));
      const alive = (x: any) => x.stars.filter((st: any) => !st.isDead);
      e.resolveCloseApproaches(alive(e));
      brute(e2, alive(e2));
      const a = JSON.stringify(e.serialize().stars ?? e.serialize()), b = JSON.stringify(e2.serialize().stars ?? e2.serialize());
      const merged = alive(e2).length;
      if (a !== b) { detail = `crowded x${k}: grid and all-pairs passes disagree (${alive(e).length} vs ${merged} stars left)`; break; }
    }
  } catch (err) { detail = (err as Error).message; }
  if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
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


// ── Scenario: overlapping systems work on each other's planets (#115) ───────
{
  const scen = (name: string, run: () => string | null) => {
    const r: Rule = { name: `scenario: ${name}`, check: () => null };
    rules.push(r);
    let detail: string | null;
    try { detail = run(); } catch (err) { detail = `threw: ${(err as Error).message}`; }
    if (detail) { failures.set(r, { seed: 'scenario', tick: 0, detail }); failCount.set(r, 1); }
  };
  const { systemReach, TIDE_REACH } = await import('../src/simulation/SystemEncounters');
  resetGameState('Inv_encounters');
  const e = new BigBangEngine(makeCanvas()) as any;
  e.init(SEEDS[0].stats, 'inv_encounters');
  for (let i = 0; i < 2_000; i++) e.update();
  const npc = (e.stars as Star[]).filter(s => !s.isDead && !s.isPlayerStar && !s.formationStage && !s.hasLife && s.planets.length >= 3);
  /** Park `intruder` on `host`'s second orbit and run encounter passes (the stars hold still). */
  const overlap = (host: Star, intruder: Star, passes: number) => {
    intruder.x = host.x + host.planets[1].orbitalRadius; intruder.y = host.y;
    for (let i = 0; i < passes; i++) { e.tick += 20; e.updateSystemEncounters(); }
  };

  scen('a star inside another system strips it from the outside in; the inhabited world stays', () => {
    const [h, i] = npc;
    if (!h || !i) return 'no two lifeless NPC systems with 3+ planets';
    h.hasLife = true; h.bestPlanetIndex = 0; h.planets[0].hasLife = true;
    const home = h.planets[0], before = h.planets.length, total = before + i.planets.length;
    e.encounterTally = {};
    overlap(h, i, 15_000);
    const t = e.encounterTally, taken = (t.captured ?? 0) + (t.ejected ?? 0) + (t.swallowed ?? 0) + (t.absorbed ?? 0) + (t.shattered ?? 0);
    if (h.planets[0] !== home) return 'the inhabited world was moved or removed';
    if (h.planets.length >= before) return `host kept all ${before} planets (${JSON.stringify(t)})`;
    if (!taken) return `nothing was captured, ejected, swallowed or destroyed (${JSON.stringify(t)})`;
    if (h.planets.length + i.planets.length > total) return 'planets were created';
    const d = Math.hypot(i.x - h.x, i.y - h.y);
    if (h.planets.length > 1 && systemReach(h) * TIDE_REACH > d) return `still overlapping: ${h.planets.map(p => p.orbitalRadius.toFixed(0) + '/' + (p.eccentricity ?? 0).toFixed(2)).join(' ')} at d=${d.toFixed(0)} (${JSON.stringify(t)})`;
    return null;
  });

  scen('a colony or an ark target is never taken by an encounter', () => {
    const [, , h, i] = npc;
    if (!h || !i) return 'not enough lifeless NPC systems';
    const last = h.planets.length - 1, outer = h.planets[last], count = h.planets.length;
    e.fleets.push({ id: -1, fromStarId: i.id, toStarId: h.id, x: 0, y: 0, progress: 0, hostile: false, isPlayerFleet: false,
      ark: { planetIndex: last, name: 'Test ark', suitability: 0.5, byPlayer: false } });
    overlap(h, i, 2_000);
    e.fleets = e.fleets.filter((f: any) => f.id !== -1);
    if (h.planets.length !== count || h.planets[last] !== outer) return `the ark's world (orbit ${last + 1}) was taken`;
    return null;
  });

  scen("the player's system keeps every world until the Space Age, then encounters can reach it", () => {
    const ps = e.getPlayerStar() as Star | undefined;
    const intruder = npc[4] ?? npc[1];
    if (!ps || !intruder || ps.planets.length < 2) return 'no player system with 2+ planets, or no intruder';
    const was = { level: ps.civLevel, formation: ps.formationStage, x: intruder.x, y: intruder.y };
    ps.formationStage = null;
    // A heavy intruder on the home system's second orbit: the worst case.
    intruder.mass = Math.max(intruder.mass, ps.mass * 2);
    ps.civLevel = TECH_LEVELS.indexOf('Space Age') - 1;
    const roster = [...ps.planets];
    overlap(ps, intruder, 6_000);
    const kept = ps.planets.length >= roster.length && roster.every((p, k) => ps.planets[k] === p);
    ps.civLevel = TECH_LEVELS.indexOf('Space Age');
    overlap(ps, intruder, 15_000);
    const after = ps.planets.filter(p => roster.includes(p)).length;
    Object.assign(ps, { civLevel: was.level, formationStage: was.formation });
    intruder.x = was.x; intruder.y = was.y;
    if (!kept) return `before the Space Age the home system went from ${roster.length} to ${ps.planets.length} worlds`;
    if (roster.length > 1 && after >= roster.length && roster.slice(1).some(p => !p.hasLife)) {
      return `at the Space Age nothing was ever taken from the home system (${JSON.stringify(e.encounterTally)})`;
    }
    if (!ps.planets.includes(roster[e.homeIndexOf(ps)] ?? roster[0])) return 'the home world itself was taken';
    return null;
  });

  scen("an encounter carries a world's history with it, or takes it away (#89 × #115)", () => {
    const [h, o] = npc;
    if (!h || !o) return 'no two NPC systems';
    const hist = e.worldHistory as Record<string, any[]>;
    const last = h.planets.length - 1;
    hist[`${h.id}:${last}`] = [{ tick: 1, text: 'a colony was here' }];
    // Captured: the log moves to the captor's new slot, with a line added.
    const moved = h.planets.pop()!; o.planets.push(moved);
    e.carryWorldHistory({ kind: 'captured', host: h, other: o, planet: moved.name, planetIndex: last, toIndex: o.planets.length - 1 });
    const there = hist[`${o.id}:${o.planets.length - 1}`];
    if (hist[`${h.id}:${last}`]) return 'the log stayed at the old slot after a capture';
    if (!there || there[0]?.text !== 'a colony was here' || there.length !== 2) return 'the captured world lost its log';
    // Gone (swallowed, ejected, absorbed, shattered): no log left for a later world in that slot.
    const gone = o.planets.length - 1;
    o.planets.pop();
    e.carryWorldHistory({ kind: 'ejected', host: o, other: h, planet: moved.name, planetIndex: gone });
    if (hist[`${o.id}:${gone}`]) return 'a world flung out left its log for the next world in its slot';
    return null;
  });

  scen('encounters replay identically from the same state', () => {
    const run = () => {
      resetGameState('Inv_encounters_det');
      const x = new BigBangEngine(makeCanvas()) as any;
      x.init(SEEDS[0].stats, 'inv_encounters_det');
      for (let k = 0; k < 2_000; k++) x.update();
      const s = (x.stars as Star[]).filter(q => !q.isDead && !q.isPlayerStar && !q.formationStage && !q.hasLife && q.planets.length >= 3);
      if (s.length < 2) return 'none';
      s[1].x = s[0].x + s[0].planets[1].orbitalRadius; s[1].y = s[0].y;
      for (let k = 0; k < 1_500; k++) { x.tick += 20; x.updateSystemEncounters(); }
      return JSON.stringify([s[0].planets, s[1].planets].map(r => r.map(p => [p.name, p.orbitalRadius.toFixed(3), (p.eccentricity ?? 0).toFixed(3)])));
    };
    const a = run(), b = run();
    return a === b ? null : 'two runs from the same seed differ';
  });
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
