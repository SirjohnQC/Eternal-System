/**
 * Does the weather read the world?
 *
 * Every claim has a control that must FAIL: an ablation (the same sim with the
 * term under test switched off) or a stand-in for today's behaviour. A metric
 * that cannot fail on its control is measuring something else.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/weatherCheck.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/wx.mjs" --log-level=error && node --expose-gc "$TEMP/wx.mjs" [--quick]
 */
import { generatePlanetGrid, GRID_SIZE, type PlanetGrid } from '../src/simulation/PlanetGrid';
import {
  WX_NX, WX_NY, WX_N, buildClimate, personalityFor, type ClimateInput,
} from '../src/rendering/weather/WeatherClimate';

const QUICK = process.argv.includes('--quick');
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
  if (!ok) failed++;
}
const SEEDS = QUICK ? [1, 7, 42] : [1, 7, 42, 99, 123, 256, 511, 777, 1001, 2024, 4242, 9001];

function input(grid: PlanetGrid, planetType: string, seed: number, over: Partial<ClimateInput> = {}): ClimateInput {
  return {
    grid, planetType, seed, lush: 0.5, extinctionPressure: 0.1, oxygenLevel: 0.6,
    civLevel: 0, inNebula: false, ...over,
  };
}
const mean = (f: Float32Array) => f.reduce((a, b) => a + b, 0) / f.length;

// ─── 1. Climate sources ────────────────────────────────────────────────────────
console.log('\n  CLIMATE');
{
  const g = generatePlanetGrid('ocean', 7 * 7777, null, null);
  const ocean = buildClimate(input(g, 'ocean', 7));
  const ice = buildClimate(input(g, 'ice', 7));
  const lava = buildClimate(input(generatePlanetGrid('lava', 7 * 7777, null, null), 'lava', 7));
  const desert = buildClimate(input(generatePlanetGrid('desert', 7 * 7777, null, null), 'desert', 7));
  check('ice is colder than ocean', mean(ice.temp) < mean(ocean.temp) - 0.15,
    `ice ${mean(ice.temp).toFixed(2)} ocean ${mean(ocean.temp).toFixed(2)}`);
  check('desert is hotter than ocean', mean(desert.temp) > mean(ocean.temp) + 0.1,
    `desert ${mean(desert.temp).toFixed(2)}`);
  check('magma does not evaporate water', mean(lava.water) === 0, `lava water ${mean(lava.water).toFixed(3)}`);
  check('ocean world has evaporating water', mean(ocean.water) > 0.05, `${mean(ocean.water).toFixed(3)}`);
  const ventCells = lava.ashEmit.filter(v => v > 0).length / WX_N;
  check('lava ash comes from vents, not a floor', ventCells > 0.01 && ventCells < 0.15,
    `${(ventCells * 100).toFixed(1)}% of cells emit`);
  check('no ash on an ocean world', mean(ocean.ashEmit) === 0, `${mean(ocean.ashEmit)}`);
  check('no smog below civ 4', mean(ocean.smogEmit) === 0, `${mean(ocean.smogEmit)}`);
  const a = personalityFor(1), b = personalityFor(2), a2 = personalityFor(1);
  check('personality is deterministic', JSON.stringify(a) === JSON.stringify(a2), '');
  check('personality differs by seed', JSON.stringify(a) !== JSON.stringify(b), '');
  // Review focus 4: pre-life world, nothing known.
  const bare = buildClimate(input(g, 'rocky', 3, { lush: 0, extinctionPressure: 0, oxygenLevel: 0, civLevel: 0 }));
  const finite = [bare.water, bare.temp, bare.elev, bare.landMoist, bare.ashEmit, bare.smogEmit]
    .every(f => f.every(Number.isFinite));
  check('pre-life world builds, all finite', finite && Number.isFinite(bare.stormPressure), '');
}

console.log(failed === 0 ? '\n  all weather checks passed\n' : `\n  ${failed} weather check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
