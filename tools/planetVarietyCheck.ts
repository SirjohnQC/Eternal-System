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

/** Distinct connected landmasses of at least `minCells` cells. Specks are noise. */
function landmassCount(grid: any, minCells = 40): number {
  const seen = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const stack: number[] = [];
  let n = 0;
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
    if (size >= minCells) n++;
  }
  return n;
}

const rows: Array<{ seed: number; land: number; big: number; coast: number; masses: number }> = [];
for (let s = 0; s < SEEDS; s++) {
  const grid = generatePlanetGrid(TYPE, 1000 + s * 7919, null);
  rows.push({ seed: 1000 + s * 7919, land: landFrac(grid),
              big: biggestMassShare(grid), coast: coastRatio(grid),
              masses: landmassCount(grid) });
}

const spread = (get: (r: typeof rows[0]) => number): number => {
  const v = rows.map(get);
  return Math.max(...v) - Math.min(...v);
};
const coastSpread = spread(r => r.coast);
const maxMasses   = Math.max(...rows.map(r => r.masses));

console.log(`\n  ${SEEDS} '${TYPE}' worlds, distinct seeds\n`);
console.log('  metric              min     max     spread');
const line = (n: string, get: (r: typeof rows[0]) => number) => {
  const v = rows.map(get);
  console.log(`  ${n.padEnd(18)} ${Math.min(...v).toFixed(3)}   ${Math.max(...v).toFixed(3)}   ${(Math.max(...v)-Math.min(...v)).toFixed(3)}`);
};
line('land fraction', r => r.land);          // diagnostic only — see below
line('biggest mass share', r => r.big);      // diagnostic only — see below
line('coast / land', r => r.coast);
line('landmasses >=40', r => r.masses);

// Measured on the current generator across these 24 'ocean' seeds:
//   land fraction      0.502 - 0.878  (spread 0.376)
//   biggest mass share 0.523 - 1.000  (spread 0.477)
//   coast / land       0.013 - 0.050  (spread 0.037)
//   landmasses >=40    1 - 7          (17 of 24 seeds have 1 or 2)
//
// Land fraction and biggest-mass share ALREADY vary widely today, so they are
// printed as diagnostics and deliberately NOT asserted. They measure how much
// land a world has and how consolidated it is — not what SHAPE it is, and shape
// is the actual defect. Asserting on metrics that already vary would make this
// instrument unfalsifiable: its control could never pass.
//
// The two that do discriminate are landmass COUNT (an archipelago has dozens;
// this generator tops out at 7) and coastline character (uniformly smooth and
// blobby, 0.013-0.050 on every world).
const WANT_MASSES = 40;   // an archipelago world must be reachable at all
const WANT_COAST  = 0.15; // coastline character must genuinely differ

let failed = 0;
function assert(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!ok) failed++;
}

if (CONTROL) {
  console.log('\n  CONTROL MODE — asserting the generator makes ONE SHAPE.');
  console.log('  This must PASS on the current generator. If it fails, the');
  console.log('  metric is measuring the wrong thing.\n');
  assert('landmass count stays low', maxMasses <= 12, `${maxMasses} <= 12`);
  assert('coastline character is uniform', coastSpread < WANT_COAST,
    `${coastSpread.toFixed(3)} < ${WANT_COAST}`);
} else {
  console.log('\n  Asserting worlds are structurally different. Expected to');
  console.log('  FAIL until terrain archetypes land.\n');
  assert('archipelago worlds are reachable', maxMasses >= WANT_MASSES,
    `${maxMasses} >= ${WANT_MASSES}`);
  assert('coastline character varies', coastSpread >= WANT_COAST,
    `${coastSpread.toFixed(3)} >= ${WANT_COAST}`);
}

process.exit(failed === 0 ? 0 : 1);
