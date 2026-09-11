/**
 * Do surface decals cluster into groves and clearings, or scatter evenly?
 *
 * The metric is nearest-neighbour distance dispersion: for each point, the
 * distance to its closest neighbour; clumpiness is the coefficient of variation
 * (stdev / mean) of those distances. An even lattice has near-zero dispersion;
 * clustered points have high dispersion because within-grove neighbours are
 * close and isolated points are far.
 *
 * Two controls run first and MUST both behave as stated, or the metric is
 * wrong and nothing downstream can be trusted:
 *   even   — a jittered lattice, must score LOW
 *   clumpy — gaussian blobs, must score HIGH
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/surfaceDecalCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=%TEMP%/decal.mjs && node %TEMP%/decal.mjs
 */
export interface Pt { x: number; y: number; }

export function clumpiness(pts: Pt[]): number {
  if (pts.length < 8) return 0;
  const nn: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    let best = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    nn.push(Math.sqrt(best));
  }
  const mean = nn.reduce((a, b) => a + b, 0) / nn.length;
  if (mean <= 0) return 0;
  const varr = nn.reduce((a, b) => a + (b - mean) * (b - mean), 0) / nn.length;
  return Math.sqrt(varr) / mean;
}

let failed = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
  if (!ok) failed++;
}

// Deterministic PRNG so the controls do not flake.
let s = 12345;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// CONTROL A — jittered lattice: what "even scatter" looks like.
const even: Pt[] = [];
for (let y = 0; y < 20; y++) {
  for (let x = 0; x < 20; x++) {
    even.push({ x: x * 12 + rnd() * 3, y: y * 12 + rnd() * 3 });
  }
}
// CONTROL B — gaussian blobs: what "groves and clearings" looks like.
const clumpy: Pt[] = [];
for (let g = 0; g < 12; g++) {
  const gx = rnd() * 240, gy = rnd() * 240;
  for (let i = 0; i < 33; i++) {
    const a = rnd() * Math.PI * 2, r = (rnd() + rnd() + rnd()) * 5;
    clumpy.push({ x: gx + Math.cos(a) * r, y: gy + Math.sin(a) * r });
  }
}

const CLUMP_MIN = 0.45;
const cEven = clumpiness(even), cClump = clumpiness(clumpy);
console.log(`\n  clumpiness: even ${cEven.toFixed(3)}   clumpy ${cClump.toFixed(3)}`
  + `   threshold ${CLUMP_MIN}\n`);
check('control: even scatter scores LOW', cEven < CLUMP_MIN, `${cEven.toFixed(3)} < ${CLUMP_MIN}`);
check('control: clustered scores HIGH', cClump >= CLUMP_MIN, `${cClump.toFixed(3)} >= ${CLUMP_MIN}`);
check('metric separates them', cClump > cEven * 1.8,
      `${cClump.toFixed(3)} > ${(cEven * 1.8).toFixed(3)}`);

// ─── placement invariants, against the real engine ───────────────────────────
const { generatePlanetGrid, SEA_LEVEL, GRID_SIZE } =
  await import('../src/simulation/PlanetGrid');
const { habitableGeom } = await import('../src/rendering/HabitableCutawayEngine');
const { planSurfaceDecals, DECAL_SNOW_LINE, DECAL_BUDGET } =
  await import('../src/rendering/SurfaceDecals');

const VW = 1200, VH = 800;
const geom: any = habitableGeom(VW, VH);
const grid = generatePlanetGrid('ocean', 7777, null);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampAbs = (v: number, m: number) => (v < -m ? -m : v > m ? m : v);
const liftOf = (e: number) => (e < SEA_LEVEL ? 0 : e > 0.72 ? 9 : e > 0.58 ? 5 : 2);
const rimFalloff = (r: number) => { const t = clamp01((r - 0.34) / 0.66); return t * t * 0.30; };
function smoothElevation(g2: any, row: number, col: number): number {
  let sum = 0, n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    const r2 = row + dr;
    if (r2 < 0 || r2 >= GRID_SIZE) continue;
    for (let dc = -1; dc <= 1; dc++) {
      const cell = g2[r2]?.[(col + dc + GRID_SIZE) % GRID_SIZE];
      if (!cell) continue;
      const wt = dr === 0 && dc === 0 ? 4 : 1;
      sum += cell.elevation * wt; n += wt;
    }
  }
  return n > 0 ? sum / n : 0;
}
function makeProjection(focusLat: number, focusLon: number) {
  return (dx: number, dy: number): { row: number; col: number } | null => {
    const r = Math.hypot(dx, dy);
    if (r > 1) return null;
    const c = r * (Math.PI / 2);
    const sinC = Math.sin(c), cosC = Math.cos(c);
    const sinF = Math.sin(focusLat), cosF = Math.cos(focusLat);
    const ny = -dy;
    const lat = r < 1e-6 ? focusLat
      : Math.asin(clampAbs(cosC * sinF + (ny * sinC * cosF) / r, 1));
    const lon = focusLon + Math.atan2(dx * sinC, r * cosF * cosC - ny * sinF * sinC);
    const v = 0.5 - lat / Math.PI;
    const u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;
    return {
      row: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)))),
      col: Math.min(GRID_SIZE - 1, Math.floor(u * GRID_SIZE)),
    };
  };
}
const opts: any = {
  w: VW, h: VH, cx: geom.cx, cyTop: geom.cyTop, cyBody: geom.cyBody,
  R: geom.R, rx: geom.rx, ry: geom.ry, wall: geom.wall,
  seed: 0xbeef, grid, planetType: 'ocean',
  discToGrid: makeProjection(0.2, 1.1), rimFalloff, liftOf, smoothElevation,
  maxLift: 9,
};

const dead = planSurfaceDecals(opts, 0.04, 0xC0FFEE);
const mid  = planSurfaceDecals(opts, 0.45, 0xC0FFEE);
const lush = planSurfaceDecals(opts, 0.92, 0xC0FFEE);
console.log(`\n  sites: dead ${dead.length}  mid ${mid.length}  lush ${lush.length}\n`);

check('dead world has no decals', dead.length === 0, `${dead.length}`);
check('readout is monotonic', mid.length > 0 && lush.length > mid.length,
      `${dead.length} < ${mid.length} < ${lush.length}`);

const woody = (a: any[]) =>
  a.filter(s => s.kind === 'conifer' || s.kind === 'broadleaf').length / Math.max(1, a.length);
check('ground cover precedes woodland', woody(mid) < 0.15, `mid woody ${woody(mid).toFixed(2)}`);
check('woodland dominates a lush world', woody(lush) > 0.50, `lush woody ${woody(lush).toFixed(2)}`);

let offFace = 0, aboveSnow = 0, inWater = 0;
for (const s of lush) {
  const dx = (s.x - geom.cx) / geom.rx, dy = (s.y - geom.cyTop) / geom.ry;
  if (Math.hypot(dx, dy) > 1) offFace++;
  const cell = grid[s.row]?.[s.col];
  if (!cell) continue;
  if (cell.elevation > DECAL_SNOW_LINE) aboveSnow++;
  if (cell.elevation < SEA_LEVEL) inWater++;
}
check('no decals off the face', offFace === 0, `${offFace}`);
check('no decals above the snow line', aboveSnow === 0, `${aboveSnow}`);
check('no decals on water cells', inWater === 0, `${inWater}`);
check('budget is respected', lush.length <= DECAL_BUDGET, `${lush.length} <= ${DECAL_BUDGET}`);

const again = planSurfaceDecals(opts, 0.92, 0xC0FFEE);
check('placement is deterministic', JSON.stringify(again) === JSON.stringify(lush),
      `${again.length} vs ${lush.length}`);
const other = planSurfaceDecals(opts, 0.92, 0xBADF00D);
check('a different genome is a different forest',
      JSON.stringify(other) !== JSON.stringify(lush), `${other.length} sites`);

const cl = clumpiness(lush.map(s => ({ x: s.x, y: s.y })));
check('real placement clumps', cl >= CLUMP_MIN, `${cl.toFixed(3)} >= ${CLUMP_MIN}`);

console.log(failed === 0 ? '\n  all decal checks passed' : `\n  ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
