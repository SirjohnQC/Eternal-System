/**
 * Headless smoke test for the whole simulation.
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
console.log('\n═══ 1. Planet grid ═══');
{
  const grid = generatePlanetGrid('ocean', 12345, null);
  check('grid dimensions', grid.length === GRID_SIZE && grid[0].length === GRID_SIZE,
    `${grid.length}×${grid[0].length}`);

  const grid2 = generatePlanetGrid('ocean', 12345, null);
  let identical = true;
  for (let r = 0; r < GRID_SIZE && identical; r += 17)
    for (let c = 0; c < GRID_SIZE; c += 17)
      if (grid[r][c].biome !== grid2[r][c].biome) { identical = false; break; }
  check('grid generation is deterministic', identical);

  // The longitude seam: column 0 and column GRID_SIZE-1 are neighbours on the
  // real planet, so their fields must be close. Plain fbm left a hard edge here.
  // Compare the wrap's AVERAGE jump down all rows with the roughest interior
  // column pairs: a coast that happens to cross the wrap is a big jump on a few
  // rows (as it is anywhere inland), a seam is a jump on every row. (Comparing
  // the wrap's single worst row against one interior column failed whenever
  // that column lay in flat open sea.)
  const colMean: number[] = [];
  for (let c = 0; c < GRID_SIZE; c++) {
    let sum = 0;
    for (let r = 0; r < GRID_SIZE; r++) sum += Math.abs(grid[r][c].elevation - grid[r][(c + 1) % GRID_SIZE].elevation);
    colMean.push(sum / GRID_SIZE);
  }
  const wrapMean = colMean[GRID_SIZE - 1];
  const interior = colMean.slice(0, GRID_SIZE - 1).sort((a, b) => a - b);
  const p95 = interior[Math.floor(interior.length * 0.95)];
  check('no longitude seam', wrapMean <= p95 * 1.5,
    `wrap ${wrapMean.toFixed(4)} vs 95th-percentile neighbour ${p95.toFixed(4)}`);

  const lf = landFraction(grid);
  check('ocean world has plausible land fraction', lf > 0.05 && lf < 0.75, `${(lf * 100).toFixed(1)}% land`);

  const dry = generatePlanetGrid('rocky', 999, { climate: 'desert', oceans: 'barren', chaos: 'serene' });
  const wet = generatePlanetGrid('rocky', 999, { climate: 'temperate', oceans: 'ocean_world', chaos: 'serene' });
  check('planet DNA changes ocean coverage', landFraction(dry) > landFraction(wet),
    `barren ${(landFraction(dry) * 100).toFixed(0)}% land vs ocean_world ${(landFraction(wet) * 100).toFixed(0)}%`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 2. Habitability model ═══');
{
  const ideal = planetHabitability({ planetType: 'ocean', orbitalRadius: 12 + (5800 - 3000) / 27000 * 34, starTemperature: 5800 });
  const farOut = planetHabitability({ planetType: 'ocean', orbitalRadius: 120, starTemperature: 5800 });
  const molten = planetHabitability({ planetType: 'lava', orbitalRadius: 12 + (5800 - 3000) / 27000 * 34, starTemperature: 5800 });
  check('goldilocks orbit scores highest', ideal > 0.8, `ideal=${ideal.toFixed(2)}`);
  check('distant orbit is hostile', farOut < 0.35, `far=${farOut.toFixed(2)}`);
  check('lava world worse than ocean at same orbit', molten < ideal, `lava=${molten.toFixed(2)} ocean=${ideal.toFixed(2)}`);
  check('all archetypes have a defined ceiling',
    Object.values(ARCHETYPES).every(a => BIO_PHASE_SEQUENCE.includes(a.ceiling)));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 3. Engine — long run, all systems ═══');
let savedSnapshot: any = null;
let savedTick = 0;
{
  resetGameState('SmokeWorld');
  const engine = new BigBangEngine(makeCanvas());

  const seen = {
    civEvent: 0, lifeEvent: 0, war: 0, cosmic: 0, signal: 0,
    bioAdvance: 0, codex: 0, leader: 0, religion: 0,
  };
  engine.onCivEvent      = () => { seen.civEvent++; };
  engine.onLifeEvent     = () => { seen.lifeEvent++; };
  engine.onWarStart      = () => { seen.war++; };
  engine.onCosmicEvent   = () => { seen.cosmic++; };
  engine.onCosmicSignal  = () => { seen.signal++; };
  engine.onBioPhaseAdvance = () => { seen.bioAdvance++; };
  engine.onCodexMilestone  = () => { seen.codex++; };
  engine.onLeaderMessage   = () => { seen.leader++; };
  engine.onReligionEvent   = () => { seen.religion++; };

  engine.init({ life: 15, evolution: 13, hostility: 12, entropy: 11, divine: 10 }, 'smoke_main');
  // Stars that exist at the start; anything with a higher id was born during the run.
  // (Read, not assumed: the starting count comes from the life stat.)
  const maxInitialId = Math.max(...(engine as any).stars.map((s: any) => s.id));

  const ps0 = engine.getPlayerStar()!;
  const homeIdx = ps0.planets.findIndex(p => p.discovery === 'landing');
  check('player home world exists', homeIdx >= 0, `orbit ${homeIdx + 1}`);
  check('player home world is habitable type',
    ps0.planets[homeIdx]?.type === 'ocean' || ps0.planets[homeIdx]?.type === 'rocky',
    ps0.planets[homeIdx]?.type);
  check('player world starts with life', ps0.hasLife && ps0.biologyPhase === 'microbial');
  check('player biochemistry is carbon/water', ps0.lifeArchetype === 'carbon_water');
  // The home world sits at its star's goldilocks radius, so the only thing
  // holding it below 1.0 is planet type — a rocky home world caps at 0.86.
  check('player world habitability is high', engine.habitabilityOf(ps0) > 0.8,
    `${engine.habitabilityOf(ps0).toFixed(2)} (${ps0.planets[homeIdx]?.type})`);

  let threw: string | null = null;
  const t0 = Date.now();
  try {
    for (let i = 0; i < 400_000; i++) engine.update();
  } catch (err) { threw = (err as Error).message; }
  const elapsed = Date.now() - t0;

  check('400k ticks without throwing', threw === null, threw ?? `${elapsed}ms`);

  const stars = (engine as any).stars.filter((s: any) => !s.isDead);
  const living = stars.filter((s: any) => s.hasLife);

  // Universe shape
  const radii = stars.map((s: any) => Math.hypot(s.x - WORLD_SIZE / 2, s.y - WORLD_SIZE / 2));
  const pinned = radii.filter((r: number) => r > UNIVERSE_RADIUS - 1).length;
  check('no stars pinned to the universe boundary', pinned === 0, `${pinned} pinned`);

  // Life spread
  const phases = new Set(living.map((s: any) => s.biologyPhase));
  check('life exists', living.length > 0, `${living.length} living of ${stars.length} stars`);
  check('life occupies more than one phase', phases.size >= 2,
    [...phases].join(', '));
  const chems = new Set(living.map((s: any) => s.lifeArchetype));
  check('more than one biochemistry in the universe', chems.size >= 2, [...chems].join(', '));
  check('every living world has tempo + chemistry set',
    living.every((s: any) => s.bioTempo != null && s.lifeArchetype != null));

  // Civilisation
  const civs = living.filter((s: any) => s.biologyPhase === 'intelligent');
  check('some civilisations emerged', civs.length > 0, `${civs.length} intelligent`);
  check('not every world woke up', civs.length < living.length,
    `${civs.length} of ${living.length}`);

  // Callbacks
  check('civ events fired', seen.civEvent > 0, String(seen.civEvent));
  check('life events (filters/catastrophes) fired', seen.lifeEvent > 0, String(seen.lifeEvent));
  check('cosmic events fired', seen.cosmic > 0, String(seen.cosmic));
  check('wars fired', seen.war > 0, String(seen.war));

  // Player progression
  //
  // NOTE: this deliberately does NOT assert that the player's world climbed the
  // biology ladder. Whether one seed advances is a coin flip — measured across
  // 10 seeds, 5 do — so a single-seed assertion cannot tell "the model is
  // broken" from "this universe was unlucky", and it passed for a long time
  // while only 2 seeds in 12 actually advanced. That claim belongs to
  // `tools/playerProgressCheck.ts`, which asserts on the distribution.
  //
  // What must hold on EVERY seed is that the player still has a world at all.
  const ps = engine.getPlayerStar();
  check('the player still has a home world', ps != null,
    ps ? ps.civName : 'playerStarId points at a dead star');
  check('the player world is in a coherent state', ps != null &&
    BIO_PHASE_SEQUENCE.indexOf(ps.biologyPhase) >= 0 && ps.planets.length > 0,
    ps ? `${ps.biologyPhase}, ${ps.planets.length} planets` : '-');
  check('player bio phase advance callback fired', seen.bioAdvance > 0, String(seen.bioAdvance));

  // Stars are lost to mergers and supernovae; star formation is what stops a
  // long game decaying to a single star.
  const newborns = stars.filter((s: any) => s.id > maxInitialId).length;
  check('new stars formed during the run', newborns > 0, `${newborns} newborn stars`);
  check('universe did not collapse to a handful of stars', stars.length >= 12,
    `${stars.length} stars remain (${maxInitialId + 1} at the start)`);

  savedSnapshot = engine.serialize();
  savedTick = (engine as any).tick;
  console.log(`        (${(elapsed / 1000).toFixed(1)}s for 400k ticks — ` +
              `${(elapsed / 400).toFixed(2)}ms per 1k ticks)`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 4. Save / load round trip ═══');
{
  const json = JSON.stringify(savedSnapshot);
  const restored = JSON.parse(json);

  const engine2 = new BigBangEngine(makeCanvas());
  engine2.init({ life: 15, evolution: 13, hostility: 12, entropy: 11, divine: 10 }, 'smoke_main');
  engine2.onCivEvent = () => {};
  engine2.onLifeEvent = () => {};
  engine2.loadState(restored);

  check('tick restored', (engine2 as any).tick === savedTick, String((engine2 as any).tick));

  const a = (savedSnapshot.stars as any[]).filter(s => !s.isDead);
  const b = (engine2 as any).stars.filter((s: any) => !s.isDead);
  check('star count restored', a.length === b.length, `${a.length} vs ${b.length}`);
  check('life model fields survive serialisation',
    b.filter((s: any) => s.hasLife).every((s: any) => s.lifeArchetype != null && s.bioTempo != null));

  let threw: string | null = null;
  try { for (let i = 0; i < 20_000; i++) engine2.update(); }
  catch (err) { threw = (err as Error).message; }
  check('resumes cleanly after load', threw === null, threw ?? 'ran 20k more ticks');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 5. Backward compatibility with pre-LifeSystem saves ═══');
{
  // Strip every field the life model added, exactly as an old save would lack them.
  const legacy = JSON.parse(JSON.stringify(savedSnapshot));
  for (const s of legacy.stars) {
    delete s.habitability; delete s.bestPlanetIndex; delete s.lifeArchetype;
    delete s.bioTempo; delete s.bioStalls; delete s.extinctions; delete s.lifeFirstTick;
  }

  const engine3 = new BigBangEngine(makeCanvas());
  engine3.init({ life: 15, evolution: 13, hostility: 12, entropy: 11, divine: 10 }, 'smoke_legacy');
  engine3.onCivEvent = () => {};
  engine3.onLifeEvent = () => {};

  let threw: string | null = null;
  try {
    engine3.loadState(legacy);
    for (let i = 0; i < 30_000; i++) engine3.update();
  } catch (err) { threw = (err as Error).message; }
  check('old save loads and runs', threw === null, threw ?? 'ran 30k ticks');

  const living = (engine3 as any).stars.filter((s: any) => !s.isDead && s.hasLife);
  check('legacy worlds keep evolving', living.length > 0, `${living.length} living`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 6. Evolution produces a legible biosphere ═══');
{
  const rng = new SeedRNG('evo_smoke');
  let species = [createPrimordialSpecies(0)];
  let bio = { ...DEFAULT_BIOSPHERE };
  const dna = {
    intelligence: 40, aggression: 30, adaptation: 50, social: 30,
    mobility: 40, sensory: 40, longevity: 20, size: 30,
  };
  const LADDER = ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'] as const;
  for (let ph = 0; ph < LADDER.length; ph++) {
    for (let i = 0; i < 120; i++) {
      const r = stepEvolution(LADDER[ph], dna, species, bio, rng, (ph * 120 + i) * 2000);
      species = r.updatedSpecies;
      bio = r.updatedBiosphere;
    }
  }
  const live = species.filter(sp => !sp.isExtinct);

  check('speciation happened', live.length > 1, `${live.length} living species`);

  // ── Life has to actually colonise the planet ──────────────────────────────
  // `stepLifeSpread` runs once per EVOLUTION_TICK_RATE (2000 ticks), but its
  // coefficients were sized for a per-tick call, and water was given zero
  // fertility while the microbial phase spreads ONLY in water. Between them,
  // lifeDensity sat at ~0.02 after 160k ticks: nothing to render or inspect.
  {
    const lg = generatePlanetGrid('ocean', 777, null);
    const callsPerPhase = 12;   // BIO_PHASE_TICKS / EVOLUTION_TICK_RATE

    const maxDensity = () => {
      let m = 0;
      for (let r = 0; r < GRID_SIZE; r += 3)
        for (let c = 0; c < GRID_SIZE; c += 3) m = Math.max(m, lg[r][c].lifeDensity);
      return m;
    };
    const coverage = (min: number) => {
      let hit = 0, tot = 0;
      for (let r = 0; r < GRID_SIZE; r += 3)
        for (let c = 0; c < GRID_SIZE; c += 3) { tot++; if (lg[r][c].lifeDensity > min) hit++; }
      return hit / tot;
    };

    let waterFert = 0;
    for (let r = 0; r < GRID_SIZE; r += 5)
      for (let c = 0; c < GRID_SIZE; c += 5)
        if (isWater(lg[r][c].biome)) waterFert = Math.max(waterFert, lg[r][c].fertility);
    check('water cells have fertility', waterFert > 0.2, `max water fertility ${waterFert.toFixed(2)}`);

    for (let i = 0; i < callsPerPhase; i++) stepLifeSpread(lg, 'microbial', 0.1, null);
    const afterMicrobial = maxDensity();
    check('microbial life spreads through one phase', afterMicrobial > 0.5,
      `peak density ${afterMicrobial.toFixed(2)} after ${callsPerPhase} steps`);

    for (const ph of ['multicellular', 'complex', 'primitive'])
      for (let i = 0; i < callsPerPhase; i++) stepLifeSpread(lg, ph, 0.1, '0');
    check('life covers a meaningful share of the world', coverage(0.35) > 0.25,
      `${(coverage(0.35) * 100).toFixed(0)}% of sampled cells above 0.35`);

    let civCells = 0;
    for (let r = 0; r < GRID_SIZE; r += 3)
      for (let c = 0; c < GRID_SIZE; c += 3) if (lg[r][c].civId != null) civCells++;
    check('civilisation claims territory', civCells > 100, `${civCells} sampled cells claimed`);
  }

  // Names used to be built by prefixing the PARENT'S NAME string, so every
  // descendant stayed a "Primordial Microbe" variant no matter how far it had
  // diverged, and the prefix ran into the noun ("ArchiPrimordial Microbe").
  const derived = live.filter(sp => sp.ancestorId !== null);
  check('descendant names are derived from genome, not parent name',
    derived.length > 0 && derived.every(sp => !sp.name.includes('Primordial Microbe')),
    derived.map(sp => sp.name).slice(0, 4).join(', ') || 'no descendants');
  check('no prefix ran into the noun',
    live.every(sp => !/^(Neo|Para|Proto|Xeno|Hyper|Sub|Archi)[A-Z]/.test(sp.name)));

  // physicalTraits.size was never mutated, so nothing ever grew past microscopic
  // and five of the six size classes were unreachable.
  const sizes = new Set(live.map(sp => sp.physicalTraits.size));
  check('body size actually evolves', !(sizes.size === 1 && sizes.has('microscopic')),
    [...sizes].join(', '));

  // dominantSpeciesId was declared on every cell and never written by anything,
  // so the simulation knew its species but not where any of them lived.
  const g2 = generatePlanetGrid('ocean', 4242, null);
  for (let r = 0; r < GRID_SIZE; r++)
    for (let c = 0; c < GRID_SIZE; c++)
      g2[r][c].lifeDensity = isWater(g2[r][c].biome) ? 0.6 : 0.5;
  assignDominantSpecies(g2, species);
  let occupied = 0;
  const occupants = new Set<string>();
  for (let r = 0; r < GRID_SIZE; r++)
    for (let c = 0; c < GRID_SIZE; c++) {
      const id = g2[r][c].dominantSpeciesId;
      if (id) { occupied++; occupants.add(id); }
    }
  check('species are placed on the terrain', occupied > 1000,
    `${occupied} cells occupied by ${occupants.size} species`);
  check('more than one species holds territory', occupants.size > 1);
}

console.log('\n═══ 7. Determinism ═══');
{
  const run = (seed: string) => {
    resetGameState('DetWorld');
    const e = new BigBangEngine(makeCanvas());
    e.onCivEvent = () => {}; e.onLifeEvent = () => {};
    e.init({ life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 }, seed);
    for (let i = 0; i < 60_000; i++) e.update();
    const stars = (e as any).stars.filter((s: any) => !s.isDead);
    return stars.map((s: any) =>
      `${s.id}:${s.x.toFixed(3)},${s.y.toFixed(3)},${s.biologyPhase},${s.civLevel},${s.lifeArchetype ?? '-'}`
    ).join('|');
  };
  const a = run('determinism_seed');
  const b = run('determinism_seed');
  const c = run('different_seed');
  check('same seed → identical universe', a === b);
  check('different seed → different universe', a !== c);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ Great Filter is never absorbing ═══');
{
  // BUG: "primary species is stuck on primitive no matter how many DNA points we
  // give". `filterChance` multiplied five factors and clamped at 1.0, so a world
  // could reach P(fail) = 1 — an absorbing state no player lever could escape.
  const ARCH = Object.keys(ARCHETYPES) as (keyof typeof ARCHETYPES)[];
  const PHASES = ['microbial', 'multicellular', 'complex', 'primitive'] as const;

  let worst = 0, worstDesc = '';
  for (const arch of ARCH) {
    for (const phase of PHASES) {
      for (let hab = 0.05; hab <= 1.0001; hab += 0.05) {
        for (const stalls of [0, 1, 3, 6, 20]) {
          for (const assistance of [0, 0.45, 0.9]) {
            const p = filterChance({ phase, habitability: hab, archetype: arch, stalls, assistance });
            if (p > worst) {
              worst = p;
              worstDesc = `${arch}/${phase} hab=${hab.toFixed(2)} stalls=${stalls} assist=${assistance}`;
            }
          }
        }
      }
    }
  }
  check('no filter configuration is certain to fail', worst <= MAX_FILTER_CHANCE + 1e-9,
        `worst P(fail)=${(worst * 100).toFixed(2)}% at ${worstDesc}`);

  // Behavioural control: the worst case must still actually advance sometimes.
  const rngAbs = new SeedRNG('absorbing_control');
  let adv = 0;
  const N = 200_000;
  for (let i = 0; i < N; i++) {
    const o = resolveTransition({
      phase: 'primitive', habitability: 0.2, archetype: 'lithic_endolith',
      stalls: 20, assistance: 0,
    }, rngAbs);
    if (o === 'advance' || o === 'burst') adv++;
  }
  check('worst-case transition still advances sometimes', adv > 0,
        `${adv} advances in ${N.toLocaleString()} rolls`);

  // And the player's assistance must measurably help, or the DNA lab is a lie.
  const pNone = filterChance({ phase: 'primitive', habitability: 0.5, archetype: 'carbon_water', stalls: 2, assistance: 0 });
  const pMax  = filterChance({ phase: 'primitive', habitability: 0.5, archetype: 'carbon_water', stalls: 2, assistance: 0.9 });
  check('assistance measurably lowers the filter', pMax < pNone - 0.05,
        `P(fail) ${(pNone * 100).toFixed(1)}% → ${(pMax * 100).toFixed(1)}%`);
}



// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All checks passed.\n');
