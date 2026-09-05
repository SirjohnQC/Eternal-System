/**
 * Dev-only: is there enough elevation range on a generated planet for extruded
 * terrain to read as mountains, and how tall does the diorama actually lift it?
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/reliefCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/relief.mjs && node $TMP/relief.mjs
 */
import { generatePlanetGrid, SEA_LEVEL, GRID_SIZE } from '../src/simulation/PlanetGrid';

// Mirrors IsoDioramaRenderer: rx = min(VW*0.30, VH*0.42) at 480x320.
const RX = Math.round(Math.min(480 * 0.30, 320 * 0.42));
const LIFT_STEP = 3;
const MAX_LIFT = Math.max(LIFT_STEP, Math.round(RX * 0.11));
const RY = Math.max(6, Math.round(RX * 0.30));

/** Mirrors IsoDioramaRenderer.liftOf — keep in step with it. */
function liftOf(elev: number): number {
  if (elev < SEA_LEVEL) return 0;
  const t = Math.min(1, Math.max(0, (elev - SEA_LEVEL) / (1 - SEA_LEVEL)));
  const raw = MAX_LIFT * Math.pow(t, 1.15);
  return Math.round(raw / LIFT_STEP) * LIFT_STEP;
}

console.log(`\n  face: rx=${RX} ry=${RY}  maxLift=${MAX_LIFT}px (${(MAX_LIFT / RY * 100).toFixed(0)}% of face depth)\n`);
console.log('  type    land%   elev p50   p90   p99   max    lift p50  p90  p99  max   distinct');

for (const type of ['ocean', 'rocky', 'ice', 'lava'] as const) {
  const grid = generatePlanetGrid(type, 3, null);
  const land: number[] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const e = grid[r][c].elevation;
      if (e >= SEA_LEVEL) land.push(e);
    }
  }
  land.sort((a, b) => a - b);
  const q = (p: number) => land.length ? land[Math.min(land.length - 1, Math.floor(p * land.length))] : 0;
  const lifts = land.map(liftOf);
  lifts.sort((a, b) => a - b);
  const lq = (p: number) => lifts.length ? lifts[Math.min(lifts.length - 1, Math.floor(p * lifts.length))] : 0;
  const distinct = new Set(lifts).size;
  const total = GRID_SIZE * GRID_SIZE;
  console.log(
    `  ${type.padEnd(7)} ${((land.length / total) * 100).toFixed(1).padStart(5)}%   ` +
    `${q(0.5).toFixed(3)} ${q(0.9).toFixed(3)} ${q(0.99).toFixed(3)} ${q(1).toFixed(3)}   ` +
    `${String(lq(0.5)).padStart(6)} ${String(lq(0.9)).padStart(4)} ${String(lq(0.99)).padStart(4)} ${String(lq(1)).padStart(4)}   ${distinct}`,
  );
}
console.log('');
