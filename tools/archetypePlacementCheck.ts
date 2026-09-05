/**
 * Dev-only: does the KIND of creature decide where it lives?
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/archetypePlacementCheck.ts --bundle \
 *     --platform=node --format=esm --outfile=$TMP/arch.mjs && node $TMP/arch.mjs
 *
 * `assignDominantSpecies` used to score a species against a cell using only
 * `dna.environment` — ocean / coastal / land / aerial. Every land creature
 * therefore scored identically on every land tile, so a grazing herd, a shore
 * reptile and a rooted photosynthesiser were scattered at random across the same
 * ground. `archetypeFit` reads locomotion, diet, size, metabolism and heat
 * tolerance as well.
 *
 * This drops hand-built archetypes onto one real planet and reports where each
 * ends up. Two controls keep it honest: every archetype must find somewhere to
 * live at all, and two land-dwellers must occupy measurably different country
 * (total-variation distance between their biome distributions). The second is
 * the one that fails if scoring reverts to environment-only — every land
 * creature then lands on an identical distribution.
 */

import { generatePlanetGrid, isHabitable, isWater, GRID_SIZE } from '../src/simulation/PlanetGrid';
import type { BiomeType, GridCell } from '../src/simulation/PlanetGrid';
import { assignDominantSpecies } from '../src/simulation/SpeciesDistribution';
import type { SpeciesGenome } from '../src/simulation/SpeciesGenome';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log(`  FAIL  ${name}  — ${detail}`); }
}

function makeSpecies(
  id: string, name: string, over: Partial<SpeciesGenome['dna']>,
  size: SpeciesGenome['physicalTraits']['size'], heat = 'temperate',
): SpeciesGenome {
  return {
    id, name, originTick: 0, population: 0.9, isExtinct: false, ancestorId: null,
    dna: {
      metabolism: 'heterotrophic', locomotion: 'walking', environment: 'land',
      reproduction: 'sexual', diet: 'omnivore', respiration: 'aerobic',
      intelligence: 3, social: 3, aggression: 3, adaptability: 6, ...over,
    },
    physicalTraits: {
      size, bodyStructure: 'vertebrate', mobilityType: 'legs', sensorySystem: 'vision',
    },
    habitat: { biome: 'varied', temperatureRange: heat },
    evolutionaryPotential: { landTransition: 1, intelligenceGrowth: 0.2, toolUse: 0 },
  };
}

// The archetypes IDEA.md names, plus a couple that should be unmistakable.
const CAST: Array<{ sp: SpeciesGenome; expect: BiomeType[]; label: string }> = [
  {
    label: 'savanna hunter (lion-like: large, walking, carnivore)',
    sp: makeSpecies('sp_lion', 'Savanna Hunter',
      { locomotion: 'walking', diet: 'carnivore', environment: 'land' }, 'large'),
    expect: ['savanna', 'grassland', 'plains'],
  },
  {
    label: 'shore reptile (crawling, coastal)',
    sp: makeSpecies('sp_reptile', 'Shore Reptile',
      { locomotion: 'crawling', diet: 'carnivore', environment: 'coastal' }, 'medium'),
    expect: ['beach', 'shallow'],
  },
  {
    label: 'open-ocean swimmer',
    sp: makeSpecies('sp_fish', 'Deep Swimmer',
      { locomotion: 'swimming', diet: 'carnivore', environment: 'ocean' }, 'medium'),
    expect: ['ocean', 'deep_ocean', 'shallow'],
  },
  {
    label: 'rooted photosynthesiser',
    sp: makeSpecies('sp_tree', 'Sunlit Grove',
      { locomotion: 'stationary', diet: 'producer', metabolism: 'photosynthetic',
        environment: 'land' }, 'medium'),
    expect: ['jungle', 'forest', 'grassland', 'plains', 'savanna'],
  },
  {
    label: 'mountain flier',
    sp: makeSpecies('sp_bird', 'Ridge Flier',
      { locomotion: 'flying', diet: 'carnivore', environment: 'aerial' }, 'small'),
    expect: ['mountain', 'forest', 'jungle', 'grassland', 'plains', 'savanna', 'desert', 'tundra', 'snow', 'beach'],
  },
];

// ── Build one planet and put life everywhere it can live ────────────────────
const grid = generatePlanetGrid('ocean', 42, null);
for (let r = 0; r < GRID_SIZE; r++) {
  for (let c = 0; c < GRID_SIZE; c++) {
    const cell = grid[r][c];
    cell.lifeDensity = isHabitable(cell.biome) || isWater(cell.biome)
      ? Math.max(0.35, Math.min(1, cell.fertility * 1.4)) : 0;
  }
}

const species = CAST.map(x => x.sp);
assignDominantSpecies(grid, species);

/** Which biomes did each species end up holding? */
function tally(): Map<string, Map<BiomeType, number>> {
  const out = new Map<string, Map<BiomeType, number>>();
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const id = grid[r][c].dominantSpeciesId;
      if (!id) continue;
      let m = out.get(id);
      if (!m) { m = new Map(); out.set(id, m); }
      const b = grid[r][c].biome;
      m.set(b, (m.get(b) ?? 0) + 1);
    }
  }
  return out;
}

const held = tally();

console.log('\n═══ Where each archetype settled ═══\n');
for (const { sp, expect, label } of CAST) {
  const m = held.get(sp.id);
  const total = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
  const top = m
    ? [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([b, n]) => `${b} ${((n / total) * 100).toFixed(0)}%`).join(', ')
    : '(nowhere)';
  console.log(`  ${label}`);
  console.log(`    ${total.toLocaleString()} cells — ${top}`);

  const inExpected = m
    ? [...m.entries()].filter(([b]) => expect.includes(b)).reduce((a, [, n]) => a + n, 0)
    : 0;
  const share = total > 0 ? inExpected / total : 0;
  check(`  → mostly in ${expect.slice(0, 3).join('/')}`, total > 0 && share >= 0.6,
        `${(share * 100).toFixed(0)}% of its range`);
}

// ── Control: every archetype must not simply take the same ground ───────────
{
  const ranges = CAST.map(x => held.get(x.sp.id)?.size ?? 0);
  check('every archetype found somewhere to live', ranges.every(n => n > 0),
        `ranges: ${ranges.join(', ')} distinct biomes`);

  // The land-dwellers must occupy measurably DIFFERENT country. Comparing the
  // single top biome is the wrong test: grassland is by far the most abundant
  // land biome, so two very differently distributed lineages can both peak
  // there. Total-variation distance between their biome distributions is the
  // honest measure — 0 means identical, 1 means no overlap at all.
  const dist = (id: string): Map<BiomeType, number> => {
    const m = held.get(id) ?? new Map<BiomeType, number>();
    const total = [...m.values()].reduce((a, b) => a + b, 0) || 1;
    const out = new Map<BiomeType, number>();
    for (const [b, n] of m) out.set(b, n / total);
    return out;
  };
  const tv = (a: Map<BiomeType, number>, b: Map<BiomeType, number>): number => {
    let sum = 0;
    for (const k of new Set([...a.keys(), ...b.keys()])) {
      sum += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
    }
    return sum / 2;
  };
  const d = tv(dist('sp_lion'), dist('sp_tree'));
  check('land archetypes occupy different country',
        d >= 0.25, `total-variation distance ${d.toFixed(2)} (0 = identical range)`);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All checks passed.\n');
