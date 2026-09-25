/**
 * Species range — does the evolved biosphere actually hold ground, lawfully?
 *
 * The diorama read as a monoculture: one lineage held nearly every cell while
 * the others held none. The first diagnosis blamed the `(0.35 + population)`
 * factor in SpeciesDistribution.score(). Measurement did not support that —
 * removing population entirely moves diversity by ~0.1. The real causes were:
 *
 *   1. The preview harness gave life only to `isHabitable` cells, and
 *      `isHabitable` is `!isWater && ...`, so every ocean was dead and every
 *      aquatic lineage looked homeless. That was a measurement artifact.
 *   2. `fitness()` in EvolutionEngine never reads locomotion, while
 *      `archetypeFit` in SpeciesDistribution scores a swimmer on land at 0.25.
 *      `isCoherent` banned walking-in-ocean and aerial-non-fliers but NOT
 *      land-swimmers or ocean-fliers, so the engine bred organisms it called
 *      thriving that the map correctly gave nowhere to stand.
 *   3. `createFoundingSpecies` never called `repair`, so 13.4% of founding
 *      organisms were born incoherent (photosynthetic in the deep sea).
 *
 * WHY THE OBVIOUS GATE IS WRONG: "median species holding cells >= 2" cannot
 * fail. The pre-fix build already scores 2 on the land-only preview and 3 with
 * water life. A gate that passes on the broken build measures nothing. The
 * gates below were each chosen because a named control fails them.
 *
 * Gates, and the control that must fail each:
 *   G1 diversity   — median inverse-Simpson D >= 1.8   (--control=legacy fails)
 *   G2 lawfulness  — median same-owner neighbours >= 0.93 (--control=scatter fails)
 *   G3 population  — median Spearman(pop, cells) >= 0.6   (--control=nopop fails)
 *   G4 no erasure  — <= 25% of living species hold < 1% of cells (guard)
 *
 * G2 exists because G1 alone rewards noise: random scatter reaches D ~ 3 while
 * destroying every spatial pattern. A world is only correct if it is BOTH
 * diverse and lawful.
 *
 * Usage:
 *   npx tsx tools/speciesRangeCheck.ts
 *   npx tsx tools/speciesRangeCheck.ts --control=legacy
 *   npx tsx tools/speciesRangeCheck.ts --control=scatter
 *   npx tsx tools/speciesRangeCheck.ts --control=nopop
 *   npx tsx tools/speciesRangeCheck.ts --seeds=40
 */

import type { SpeciesGenome } from '../src/simulation/SpeciesGenome';

const args = process.argv.slice(2);
/**
 * 60, not 24. At 24 seeds this check reported the coherence fix raising median
 * D from 1.52 to 1.78; at 60 seeds the same comparison is 1.68 to 1.57 — the
 * opposite sign. Both readings were noise at that sample size, in both
 * directions, and the smaller run flattered whichever build it was pointed at.
 * Do not lower this to make a run finish sooner: see the "a single-seed
 * assertion cannot tell broken from unlucky" entry in the project memory.
 */
const SEEDS = Number(args.find(a => a.startsWith('--seeds='))?.split('=')[1] ?? 60);
const CONTROL = args.find(a => a.startsWith('--control='))?.split('=')[1] ?? null;

if (CONTROL && !['legacy', 'scatter', 'nopop', 'oldrender'].includes(CONTROL)) {
  console.error(`unknown control "${CONTROL}" — expected legacy, scatter, nopop or oldrender`);
  process.exit(2);
}

const { SeedRNG } = await import('../src/utils/SeedRNG');
const { DEFAULT_BIOSPHERE } = await import('../src/simulation/SpeciesGenome');
const { generatePlanetGrid, isHabitable, isWater, GRID_SIZE } =
  await import('../src/simulation/PlanetGrid');
const { inhabitsWater } = await import('../src/simulation/SpeciesGenome');

/**
 * The renderer's own water gate. `oldrender` restores the pre-fix locomotion
 * test, which hid every aquatic organism that neither swims nor flies.
 */
const drawableOnWater = CONTROL === 'oldrender'
  ? (g: SpeciesGenome) => g.dna.locomotion === 'swimming' || g.dna.locomotion === 'flying'
  : inhabitsWater;
const { assignDominantSpecies, speciesRangeCounts } =
  await import('../src/simulation/SpeciesDistribution');

// The control swaps the ENGINE, not the measurement: a frozen pre-fix copy
// taken from HEAD, without the locomotion/environment rules and without the
// founding repair.
const engine = CONTROL === 'legacy'
  ? await import('./lib/legacyEvolutionEngine')
  : await import('../src/simulation/EvolutionEngine');
const { initPlayerSpecies, stepEvolution } = engine as {
  initPlayerSpecies: (tick: number, rng: InstanceType<typeof SeedRNG>) => SpeciesGenome[];
  stepEvolution: (...a: never[]) => { updatedSpecies: SpeciesGenome[]; updatedBiosphere: unknown };
};

const PHASES = ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'];
const STEPS_PER_PHASE = 30;

// ─── World construction ───────────────────────────────────────────────────────

interface World { seed: number; species: SpeciesGenome[] }

function evolveWorlds(): World[] {
  const out: World[] = [];
  for (let seed = 0; seed < SEEDS; seed++) {
    const rng = new SeedRNG(`rangecheck_${seed}`);
    let species = initPlayerSpecies(0, new SeedRNG(`founder_rc_${seed}`));
    let bio: unknown = { ...DEFAULT_BIOSPHERE };
    let tick = 0;
    for (const phase of PHASES) {
      for (let i = 0; i < STEPS_PER_PHASE; i++) {
        tick += 2000;
        const r = stepEvolution(...([phase, {}, species, bio, rng, tick, []] as never[]));
        species = r.updatedSpecies; bio = r.updatedBiosphere;
      }
    }
    out.push({ seed, species: species.filter(s => !s.isExtinct && s.population > 0.01) });
  }
  return out;
}

/**
 * Build the grid the way the game does, not the way the old preview did:
 * water is alive. `isHabitable` excludes water, mountain and volcanic — only
 * the last two should be dead.
 */
function buildGrid(seed: number) {
  const grid = generatePlanetGrid('ocean', seed * 7777, null, null);
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const cell = grid[r][c];
      const alive = isHabitable(cell.biome) || isWater(cell.biome);
      cell.lifeDensity = alive ? Math.min(1, cell.fertility * 1.4) : 0;
    }
  }
  return grid;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

/** Inverse Simpson over cell shares: an "effective number of species", 1..N. */
function inverseSimpson(counts: Map<string, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  if (total === 0) return 0;
  let sumSq = 0;
  for (const n of counts.values()) { const p = n / total; sumSq += p * p; }
  return sumSq > 0 ? 1 / sumSq : 0;
}

/**
 * Lawfulness: of owned cell pairs two apart, how many share an owner? A world
 * where species occupy coherent territory scores high; random scatter collapses
 * toward the chance level.
 */
function sameOwnerNeighbours(grid: ReturnType<typeof buildGrid>): number {
  let pairs = 0, same = 0;
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const a = grid[r][c].dominantSpeciesId;
      if (!a) continue;
      for (const [dr, dc] of [[0, 2], [2, 0]] as const) {
        const r2 = r + dr, c2 = c + dc;
        if (r2 >= GRID_SIZE || c2 >= GRID_SIZE) continue;
        const b = grid[r2][c2].dominantSpeciesId;
        if (!b) continue;
        pairs++; if (a === b) same++;
      }
    }
  }
  return pairs > 0 ? same / pairs : 1;
}

/** Spearman rank correlation, ties averaged. */
function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]): number[] => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const n = xs.length;
  if (n < 3) return NaN;
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx, b = ry[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

function median(v: number[]): number {
  const s = v.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const worlds = evolveWorlds();
const Ds: number[] = [], laws: number[] = [], rhos: number[] = [], hidden: number[] = [];
let livingTotal = 0, erased = 0, speciesPerWorld: number[] = [];

for (const w of worlds) {
  if (w.species.length === 0) continue;
  const grid = buildGrid(w.seed);

  if (CONTROL === 'scatter') {
    // Placement by lottery: same species, no terrain reasoning at all.
    const rng = new SeedRNG(`scatter_${w.seed}`);
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const cell = grid[r][c];
        cell.dominantSpeciesId = cell.lifeDensity > 0.3
          ? w.species[rng.nextInt(0, w.species.length - 1)].id : null;
      }
    }
  } else if (CONTROL === 'nopop') {
    // Place with population flattened, then measure against the TRUE
    // populations — "what if placement ignored population?"
    const flat = w.species.map(s => ({ ...s, population: 1 }));
    assignDominantSpecies(grid, flat as SpeciesGenome[], 2);
  } else {
    assignDominantSpecies(grid, w.species, 2);
  }

  const counts = speciesRangeCounts(grid);
  let occupied = 0;
  for (const n of counts.values()) occupied += n;
  if (occupied === 0) continue;

  Ds.push(inverseSimpson(counts));
  laws.push(sameOwnerNeighbours(grid));
  speciesPerWorld.push(w.species.length);

  // Visibility: an occupied WATER cell whose owner the renderer refuses to draw
  // is a cell of life the player sees as empty sea. Biome stands in for the
  // renderer's drawn-elevation test, which needs the full bake.
  const byId = new Map(w.species.map(s => [s.id, s]));
  let occ = 0, unseen = 0;
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const cell = grid[r][c];
      const owner = cell.dominantSpeciesId ? byId.get(cell.dominantSpeciesId) : undefined;
      if (!owner) continue;
      occ++;
      if (isWater(cell.biome) && !drawableOnWater(owner)) unseen++;
    }
  }
  if (occ > 0) hidden.push((100 * unseen) / occ);

  if (w.species.length >= 3) {
    rhos.push(spearman(
      w.species.map(s => s.population),
      w.species.map(s => counts.get(s.id) ?? 0),
    ));
  }
  for (const s of w.species) {
    livingTotal++;
    if ((counts.get(s.id) ?? 0) / occupied < 0.01) erased++;
  }
}

const mD = median(Ds), mLaw = median(laws), mRho = median(rhos), mHidden = median(hidden);
const erasedPct = livingTotal > 0 ? (100 * erased) / livingTotal : 0;

const label = CONTROL ? `CONTROL: ${CONTROL}` : 'current engine';
console.log(`\n=== Species range — ${label}, ${worlds.length} worlds, ocean, water life on ===`);
console.log(`  worlds measured ${Ds.length} | living species/world median ${median(speciesPerWorld).toFixed(1)}\n`);

interface Gate { id: string; label: string; value: number; gate: number; pass: boolean; targetOf: string | null; detail: string }
const gates: Gate[] = [
  { id: 'G1', label: 'diversity (inverse Simpson)', value: mD,  gate: 1.8,
    pass: mD >= 1.8,  targetOf: 'legacy',
    detail: `median D ${mD.toFixed(2)} (gate >= 1.80)` },
  { id: 'G2', label: 'lawfulness (same-owner nbrs)', value: mLaw, gate: 0.93,
    pass: mLaw >= 0.93, targetOf: 'scatter',
    detail: `median ${mLaw.toFixed(3)} of stride-2 owned pairs share an owner (gate >= 0.930)` },
  { id: 'G3', label: 'population predicts range',    value: mRho, gate: 0.6,
    pass: Number.isFinite(mRho) && mRho >= 0.6, targetOf: 'nopop',
    detail: `median Spearman(pop, cells) ${Number.isFinite(mRho) ? mRho.toFixed(2) : 'n/a'} over ${rhos.length} worlds with >=3 species (gate >= 0.60)` },
  { id: 'G4', label: 'no erasure',                   value: erasedPct, gate: 25,
    pass: erasedPct <= 25, targetOf: null,
    detail: `${erased}/${livingTotal} living species hold < 1% of cells = ${erasedPct.toFixed(1)}% (gate <= 25%)` },
  { id: 'G5', label: 'occupied cells are visible',   value: mHidden, gate: 5,
    pass: mHidden <= 5, targetOf: 'oldrender',
    detail: `median ${mHidden.toFixed(1)}% of occupied cells hold life the renderer will not draw (gate <= 5%)` },
];

for (const g of gates) console.log(`  ${g.pass ? 'ok  ' : 'FAIL'}  ${g.id} ${g.label.padEnd(30)} ${g.detail}`);

if (!CONTROL) {
  const failed = gates.filter(g => !g.pass);
  console.log(failed.length === 0 ? '\nall gates passed\n' : `\n${failed.length} gate(s) failed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// A control is only useful if it fails the gate it was built to break.
const target = gates.find(g => g.targetOf === CONTROL)!;
if (!target.pass) {
  console.log(`\nCONTROL OK — "${CONTROL}" fails ${target.id} (${target.label}), so that gate bites.\n`);
  process.exit(0);
}
console.log(`\nCONTROL USELESS — "${CONTROL}" still PASSES ${target.id}. The gate cannot detect what it was written for; fix the metric, not the code.\n`);
process.exit(1);
