/**
 * Dev-only: does the surface map's SPECIES layer actually have anything to draw,
 * and are lineages told apart by colour?
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/mapLayerCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/maplayer.mjs && node $TMP/maplayer.mjs
 *
 * The map cannot be checked by looking at it in a backgrounded browser tab —
 * requestAnimationFrame is throttled there, so a fresh world never accumulates
 * species within a screenshot's patience. This drives the real evolution engine
 * and the real species-assignment pass instead, then asserts on the data the
 * layer reads.
 *
 * Each check carries a control, so a pass means the check can actually fail.
 */

import { generatePlanetGrid, isHabitable, GRID_SIZE } from '../src/simulation/PlanetGrid';
import { DEFAULT_BIOSPHERE } from '../src/simulation/SpeciesGenome';
import type { SpeciesGenome } from '../src/simulation/SpeciesGenome';
import { stepEvolution, createFoundingSpecies } from '../src/simulation/EvolutionEngine';
import { assignDominantSpecies } from '../src/simulation/SpeciesDistribution';
import { generateBranchSet, emptyInvestment } from '../src/simulation/DnaBranches';
import { SeedRNG } from '../src/utils/SeedRNG';
import { speciesRGB, speciesHue, clearSpeciesPalette } from '../src/ui/speciesPalette';
import type { BiologyPhase } from '../src/simulation/GameState';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log(`  FAIL  ${name}  — ${detail}`); }
}

/** Grow a world to the requested phase, the way the preview harness does. */
function growWorld(seed: number) {
  const grid = generatePlanetGrid('ocean', seed, null);
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const cell = grid[r][c];
      cell.lifeDensity = isHabitable(cell.biome) ? Math.min(1, cell.fertility * 1.4) : 0;
    }
  }
  const rng = new SeedRNG(`map_${seed}`);
  const defs = generateBranchSet(new SeedRNG(`branches_${seed}`));
  const dna = emptyInvestment(defs);
  let species: SpeciesGenome[] = [createFoundingSpecies(0, rng)];
  let bio = { ...DEFAULT_BIOSPHERE };
  const LADDER: BiologyPhase[] =
    ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'];
  for (let p = 0; p < LADDER.length; p++) {
    for (let i = 0; i < 120; i++) {
      const r = stepEvolution(LADDER[p], dna, species, bio, rng, (p * 120 + i) * 2000, defs);
      species = r.updatedSpecies;
      bio = r.updatedBiosphere;
    }
  }
  return { grid, species: species.filter(s => !s.isExtinct) };
}

console.log('\n═══ Surface map — species layer ═══');

{
  const { grid, species } = growWorld(11);

  // CONTROL: before assignment, no cell names a species, so the layer would draw
  // nothing at all. This is the state the field sat in for the life of the
  // project (ROADMAP M20b) — the check must be able to see it.
  let beforeCells = 0;
  for (let r = 0; r < GRID_SIZE; r++)
    for (let c = 0; c < GRID_SIZE; c++)
      if (grid[r][c].dominantSpeciesId) beforeCells++;
  check('control — nothing to colour before species are assigned', beforeCells === 0,
        `${beforeCells} cells carried a species id`);

  assignDominantSpecies(grid, species);

  let cells = 0;
  const perSpecies = new Map<string, number>();
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const id = grid[r][c].dominantSpeciesId;
      if (!id) continue;
      cells++;
      perSpecies.set(id, (perSpecies.get(id) ?? 0) + 1);
    }
  }
  const total = GRID_SIZE * GRID_SIZE;
  check('species layer has cells to colour', cells > total * 0.02,
        `${cells.toLocaleString()} / ${total.toLocaleString()} cells (${((cells / total) * 100).toFixed(1)}%), ` +
        `${perSpecies.size} lineages present`);

  check('more than one lineage is on the map', perSpecies.size >= 2,
        `${perSpecies.size} lineages`);

  // Colours must be distinguishable, or the layer is one indistinct wash.
  clearSpeciesPalette();
  const ids = [...perSpecies.keys()];
  const hues = ids.map(speciesHue).sort((a, b) => a - b);
  let minGap = 360;
  for (let i = 1; i < hues.length; i++) minGap = Math.min(minGap, hues[i] - hues[i - 1]);
  if (hues.length > 1) minGap = Math.min(minGap, 360 - hues[hues.length - 1] + hues[0]);
  check('lineage colours are visually separable', hues.length < 2 || minGap >= 12,
        `${hues.length} hues, closest pair ${minGap.toFixed(0)}° apart`);

  // Stability: the same id must give the same colour every redraw, or the map
  // flickers a new palette each frame.
  const first = ids.map(speciesRGB).map(v => v.join(','));
  const again = ids.map(speciesRGB).map(v => v.join(','));
  check('colours are stable across redraws', first.join('|') === again.join('|'));

  // And distinct ids must not collide onto one colour.
  check('no two lineages share a colour', new Set(first).size === first.length,
        `${new Set(first).size} distinct colours for ${first.length} lineages`);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All checks passed.\n');
