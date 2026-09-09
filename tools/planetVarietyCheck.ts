/**
 * Does the generator actually make different worlds?
 *
 * Two modes:
 *   --control   assert the spread is NARROW. Passes on today's generator.
 *               This is what proves the metric can detect the bug.
 *   (default)   assert the spread is WIDE. Fails until archetypes land.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/planetVarietyCheck.ts --bundle \
 *     --platform=node --format=esm --outfile=/tmp/variety.mjs && node /tmp/variety.mjs
 */
const { generatePlanetGrid, isWater, GRID_SIZE } =
  await import('../src/simulation/PlanetGrid');

const CONTROL = process.argv.includes('--control');
const SEEDS = 24;
const TYPE = 'ocean';

/** Fraction of cells above sea level. */
function landFrac(grid: any): number {
  let land = 0;
  for (let r = 0; r < GRID_SIZE; r++)
    for (let c = 0; c < GRID_SIZE; c++)
      if (!isWater(grid[r][c].biome)) land++;
  return land / (GRID_SIZE * GRID_SIZE);
}

/** Share of all land held by the single biggest connected landmass. */
function biggestMassShare(grid: any): number {
  const seen = new Uint8Array(GRID_SIZE * GRID_SIZE);
  let best = 0, total = 0;
  const stack: number[] = [];
  for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
    const i = r * GRID_SIZE + c;
    if (seen[i] || isWater(grid[r][c].biome)) continue;
    let size = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const jr = (j / GRID_SIZE) | 0, jc = j % GRID_SIZE;
      size++;
      for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nr = jr + dr, nc = (jc + dc + GRID_SIZE) % GRID_SIZE; // x wraps
        if (nr < 0 || nr >= GRID_SIZE) continue;
        const k = nr * GRID_SIZE + nc;
        if (seen[k] || isWater(grid[nr][nc].biome)) continue;
        seen[k] = 1; stack.push(k);
      }
    }
    total += size;
    if (size > best) best = size;
  }
  return total > 0 ? best / total : 0;
}

/** Coast cells per unit of land — high means fragmented, low means blobby. */
function coastRatio(grid: any): number {
  let coast = 0, land = 0;
  for (let r = 1; r < GRID_SIZE - 1; r++) for (let c = 0; c < GRID_SIZE; c++) {
    if (isWater(grid[r][c].biome)) continue;
    land++;
    const l = grid[r][(c - 1 + GRID_SIZE) % GRID_SIZE].biome;
    const rr = grid[r][(c + 1) % GRID_SIZE].biome;
    if (isWater(l) || isWater(rr) ||
        isWater(grid[r - 1][c].biome) || isWater(grid[r + 1][c].biome)) coast++;
  }
  return land > 0 ? coast / land : 0;
}

const rows: Array<{ seed: number; land: number; big: number; coast: number }> = [];
for (let s = 0; s < SEEDS; s++) {
  const grid = generatePlanetGrid(TYPE, 1000 + s * 7919, null);
  rows.push({ seed: 1000 + s * 7919, land: landFrac(grid),
              big: biggestMassShare(grid), coast: coastRatio(grid) });
}

const spread = (get: (r: typeof rows[0]) => number): number => {
  const v = rows.map(get);
  return Math.max(...v) - Math.min(...v);
};
const landSpread  = spread(r => r.land);
const bigSpread   = spread(r => r.big);
const coastSpread = spread(r => r.coast);

console.log(`\n  ${SEEDS} '${TYPE}' worlds, distinct seeds\n`);
console.log('  metric              min     max     spread');
const line = (n: string, get: (r: typeof rows[0]) => number) => {
  const v = rows.map(get);
  console.log(`  ${n.padEnd(18)} ${Math.min(...v).toFixed(3)}   ${Math.max(...v).toFixed(3)}   ${(Math.max(...v)-Math.min(...v)).toFixed(3)}`);
};
line('land fraction', r => r.land);
line('biggest mass share', r => r.big);
line('coast / land', r => r.coast);

// Thresholds. A generator that makes genuinely different worlds should easily
// clear these; today's single-recipe generator cannot get near them.
const WANT_LAND = 0.35, WANT_BIG = 0.45, WANT_COAST = 0.30;

let failed = 0;
function assert(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!ok) failed++;
}

if (CONTROL) {
  console.log('\n  CONTROL MODE — asserting the spread is NARROW.');
  console.log('  This must PASS on the current generator. If it fails, the');
  console.log('  metric is measuring the wrong thing.\n');
  assert('land fraction is narrow',  landSpread  < WANT_LAND,  `${landSpread.toFixed(3)} < ${WANT_LAND}`);
  assert('biggest mass is narrow',   bigSpread   < WANT_BIG,   `${bigSpread.toFixed(3)} < ${WANT_BIG}`);
  assert('coast ratio is narrow',    coastSpread < WANT_COAST, `${coastSpread.toFixed(3)} < ${WANT_COAST}`);
} else {
  console.log('\n  Asserting the spread is WIDE. Expected to FAIL until');
  console.log('  terrain archetypes land.\n');
  assert('land fraction varies',  landSpread  >= WANT_LAND,  `${landSpread.toFixed(3)} >= ${WANT_LAND}`);
  assert('biggest mass varies',   bigSpread   >= WANT_BIG,   `${bigSpread.toFixed(3)} >= ${WANT_BIG}`);
  assert('coast ratio varies',    coastSpread >= WANT_COAST, `${coastSpread.toFixed(3)} >= ${WANT_COAST}`);
}

process.exit(failed === 0 ? 0 : 1);
