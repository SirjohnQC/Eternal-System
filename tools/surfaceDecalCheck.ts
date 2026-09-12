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
const { generatePlanetGrid, SEA_LEVEL, GRID_SIZE, isWater } =
  await import('../src/simulation/PlanetGrid');
const { habitableGeom } = await import('../src/rendering/HabitableCutawayEngine');
const { planSurfaceDecals, DECAL_SNOW_LINE, DECAL_BUDGET, PAINTER_SNOW_ELEVATION } =
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
// Land-finding focus: same search as tools/habitableDioramaCheck.ts:250-270.
// An arbitrary camera focus (e.g. (0.2, 1.1)) can land mostly over ocean, so a
// "dead world has no decals" check against it proves nothing about placement
// under the focus the game actually uses (IsoDioramaRenderer's computeFocus
// centres on land the same way).
//
// A FUNCTION, not a one-off: the seed sweep below needs the same focus search
// per grid, and a focus computed for one grid is meaningless on another.
function landFocusFor(g2: any) {
  let bestScore = -1, bestRow = GRID_SIZE >> 1, bestCol = 0;
  const STRIDE = 8, RAD = 3;
  for (let row = STRIDE * RAD; row < GRID_SIZE - STRIDE * RAD; row += STRIDE) {
    const latW = 1 - Math.abs(row / (GRID_SIZE - 1) - 0.5) * 1.4;
    if (latW <= 0) continue;
    for (let col = 0; col < GRID_SIZE; col += STRIDE) {
      let score = 0;
      for (let dr = -RAD; dr <= RAD; dr++) for (let dc = -RAD; dc <= RAD; dc++) {
        const cell = g2[row + dr * STRIDE]?.[(col + dc * STRIDE + GRID_SIZE) % GRID_SIZE];
        if (cell && !isWater(cell.biome)) score += 1 + cell.fertility;
      }
      score *= latW;
      if (score > bestScore) { bestScore = score; bestRow = row; bestCol = col; }
    }
  }
  return makeProjection(
    (0.5 - bestRow / (GRID_SIZE - 1)) * Math.PI, (bestCol / GRID_SIZE) * Math.PI * 2);
}
const discToGrid = landFocusFor(grid);

const opts: any = {
  w: VW, h: VH, cx: geom.cx, cyTop: geom.cyTop, cyBody: geom.cyBody,
  R: geom.R, rx: geom.rx, ry: geom.ry, wall: geom.wall,
  seed: 0xbeef, grid, planetType: 'ocean',
  discToGrid, rimFalloff, liftOf, smoothElevation,
  maxLift: 9,
};

const dead = planSurfaceDecals(opts, 0.04, 0xC0FFEE);
const mid  = planSurfaceDecals(opts, 0.45, 0xC0FFEE);
const lush = planSurfaceDecals(opts, 0.92, 0xC0FFEE);
console.log(`\n  sites: dead ${dead.length}  mid ${mid.length}  lush ${lush.length}\n`);

// Rock is not life and is exempt from the life floor by design (bare crags
// belong on a lifeless world); every other kind IS vegetation and must not
// appear at all when lush is near zero.
const livingDead = dead.filter(s => s.kind !== 'rock').length;
check('dead world grows nothing living', livingDead === 0,
      `${livingDead} (rock ${dead.length - livingDead})`);
// `dead < mid` was implied by the detail string but never asserted. Assert it.
check('readout is monotonic',
      dead.length < mid.length && mid.length > 0 && lush.length > mid.length,
      `${dead.length} < ${mid.length} < ${lush.length}`);

const woody = (a: any[]) =>
  a.filter(s => s.kind === 'conifer' || s.kind === 'broadleaf').length / Math.max(1, a.length);
// Density, composition and clumping are asserted over a SEED SWEEP further
// down, not on this one world — see the "seed sweep" section. A single-seed
// assertion on a stochastic generator cannot tell "broken" from "unlucky".

// ─── the snow-line coupling ───────────────────────────────────────────────────
//
// The old assertion here compared `cell.elevation > DECAL_SNOW_LINE` — the very
// constant `planSurfaceDecals` skips on. Same value on both sides, so it was
// green for ANY value (proven: DECAL_SNOW_LINE = 9.0 left it green) and guarded
// nothing. What it is supposed to guard is the invisible coupling to
// `paintCutawaySurface`, which re-classifies `mountain` cells above
// PAINTER_SNOW_ELEVATION as snow LOCALLY without writing `cell.biome`. So
// assert the PAINTER's condition instead: it is independent of the decal
// constant and goes red the moment the margin is lost.
let offFace = 0, onPainterSnow = 0, inWater = 0;
for (const s of lush) {
  const dx = (s.x - geom.cx) / geom.rx, dy = (s.y - geom.cyTop) / geom.ry;
  if (Math.hypot(dx, dy) > 1) offFace++;
  const cell = grid[s.row]?.[s.col];
  if (!cell) continue;
  if (cell.biome === 'mountain' && cell.elevation > PAINTER_SNOW_ELEVATION) onPainterSnow++;
  if (cell.elevation < SEA_LEVEL) inWater++;
}
check('no decals off the face', offFace === 0, `${offFace}`);
check('no decals on the painter\'s snow caps', onPainterSnow === 0,
      `${onPainterSnow} sites above PAINTER_SNOW_ELEVATION ${PAINTER_SNOW_ELEVATION}`);
check('no decals on water cells', inWater === 0, `${inWater}`);

// CONTROL for the assertion directly above. A zero is only meaningful if a
// non-zero were reachable, and "the planner produced none" is not proof the
// PREDICATE would notice one. So run the same predicate over sites that are
// deliberately placed on cells the painter WILL render white.
//
// This control matters more than usual here, because of what was measured
// while verifying this check (see the report): raising DECAL_SNOW_LINE from
// 0.78 to 0.92 — above the painter's threshold — does NOT turn the assertion
// red. Mountain cells carry fertility 0, so `life` is 0 on them, and the
// `!woody && sward < 0.58` cutoff rejects every high-mountain candidate on
// its own. Both mutations together are needed to land a decal on snow (that
// experiment produced 12 on grid seed 7777). The snow-line guard is therefore
// largely REDUNDANT with the sward cutoff on the worlds measured — worth
// knowing, and exactly the kind of thing a bare green tells you nothing about.
const snowCells: Array<{ row: number; col: number }> = [];
for (let r = 0; r < GRID_SIZE && snowCells.length < 3; r++) {
  for (let c = 0; c < GRID_SIZE && snowCells.length < 3; c++) {
    const cell = grid[r]?.[c];
    if (cell && cell.biome === 'mountain' && cell.elevation > PAINTER_SNOW_ELEVATION) {
      snowCells.push({ row: r, col: c });
    }
  }
}
check('control: painter-snow cells exist to be caught', snowCells.length === 3,
      `${snowCells.length} mountain cells above ${PAINTER_SNOW_ELEVATION}`);
const onPainterSnowOf = (sites: Array<{ row: number; col: number }>): number =>
  sites.filter(s => {
    const cell = grid[s.row]?.[s.col];
    return !!cell && cell.biome === 'mountain' && cell.elevation > PAINTER_SNOW_ELEVATION;
  }).length;
check('control: the predicate flags a decal on snow',
      onPainterSnowOf(snowCells) === snowCells.length,
      `${onPainterSnowOf(snowCells)} of ${snowCells.length} synthetic snow sites detected`);
check('control: and clears the real sites', onPainterSnowOf(lush as any) === 0,
      `${onPainterSnowOf(lush as any)} of ${lush.length} real sites`);

// The coupling itself must stay finite and derived. `PAINTER_SNOW_ELEVATION`
// used to live in HabitableCutawayEngine.ts and be imported back into
// SurfaceDecals.ts, closing a runtime import cycle: under one module order the
// binding read `undefined`, making DECAL_SNOW_LINE NaN — and since every `>`
// against NaN is false, the placement guard would stop skipping AND every
// assertion would stay green. Two lines that turn that into a visible failure.
check('snow line is finite', Number.isFinite(DECAL_SNOW_LINE), `${DECAL_SNOW_LINE}`);
check('snow line is derived from the painter\'s',
      Math.abs(DECAL_SNOW_LINE - (PAINTER_SNOW_ELEVATION - 0.04)) < 1e-9,
      `${DECAL_SNOW_LINE.toFixed(4)} == ${PAINTER_SNOW_ELEVATION} - 0.04`);

// ─── budget ───────────────────────────────────────────────────────────────────
//
// `lush.length <= DECAL_BUDGET` alone is vacuous: DECAL_BUDGET is 900 and the
// most any measured seed pair produces is ~430, so the clamp at the bucket
// sort is never reached and deleting it would not turn this red. Exercise the
// clamp with a budget the planner must actually hit.
check('budget is respected', lush.length <= DECAL_BUDGET, `${lush.length} <= ${DECAL_BUDGET}`);
const clamped = planSurfaceDecals(opts, 0.92, 0xC0FFEE, 50);
check('the budget clamp actually clamps', clamped.length === 50, `${clamped.length} sites at budget 50`);
check('...and 50 was a real constraint', lush.length > 50,
      `unclamped ${lush.length} > 50`);

const again = planSurfaceDecals(opts, 0.92, 0xC0FFEE);
check('placement is deterministic', JSON.stringify(again) === JSON.stringify(lush),
      `${again.length} vs ${lush.length}`);
const other = planSurfaceDecals(opts, 0.92, 0xBADF00D);
check('a different genome is a different forest',
      JSON.stringify(other) !== JSON.stringify(lush), `${other.length} sites`);

// Clumping on the real generator is asserted over the seed sweep below, not
// on this single world.

const { stampDecals } = await import('../src/rendering/SurfaceDecals');

// A fake land buffer: fully painted, mid-green, so every site has ground.
const bw = 200, bh = 120;
const buf = new Uint8ClampedArray(bw * bh * 4);
for (let i = 0; i < bw * bh; i++) {
  buf[i * 4] = 60; buf[i * 4 + 1] = 120; buf[i * 4 + 2] = 55; buf[i * 4 + 3] = 255;
}
const before = buf.slice();
const fakeSites: any[] = [
  { x: 50, y: 60, kind: 'conifer', scale: 1, row: 0, col: 0 },
  { x: 90, y: 70, kind: 'scrub',   scale: 1, row: 0, col: 0 },
];
const drawn = stampDecals(buf, bw, bh, 0, 0, fakeSites, null);
check('stamps without an atlas (procedural fallback)', drawn === 2, `${drawn} drawn`);
let changed = 0;
for (let i = 0; i < buf.length; i += 4) if (buf[i] !== before[i]) changed++;
check('stamping changes pixels', changed > 20, `${changed} px changed`);

// Transparent ground must be left alone: no decal may invent land.
const hole = new Uint8ClampedArray(bw * bh * 4);
const drawnHole = stampDecals(hole, bw, bh, 0, 0, fakeSites, null);
check('never draws on unpainted pixels', drawnHole === 0, `${drawnHole} drawn on a hole`);

// The neighbour guard itself, not just the fully-transparent case above: that
// case is already caught by the footprint-alpha check alone and proves
// nothing about the neighbour reads, which is the part the guard's own
// comment claims to protect ("or decals hang off coasts").
const paintedBuf = () => {
  const b = new Uint8ClampedArray(bw * bh * 4);
  for (let i = 0; i < bw * bh; i++) {
    b[i * 4] = 60; b[i * 4 + 1] = 120; b[i * 4 + 2] = 55; b[i * 4 + 3] = 255;
  }
  return b;
};
const guardSite: any = { x: 100, y: 60, kind: 'rock', scale: 1, row: 0, col: 0 };

// Right-neighbour hole (bx+1): the horizontal half of the guard.
const rightHole = paintedBuf();
rightHole[(60 * bw + 101) * 4 + 3] = 0;
const drawnRightHole = stampDecals(rightHole, bw, bh, 0, 0, [guardSite], null);
check('hole beside the footprint skips the site', drawnRightHole === 0,
      `${drawnRightHole} drawn with a punched neighbour`);

// Below-neighbour hole (by+1): the vertical half of the guard — the decal's
// base must stand on paint or it reads as floating.
const belowHole = paintedBuf();
belowHole[(61 * bw + 100) * 4 + 3] = 0;
const drawnBelowHole = stampDecals(belowHole, bw, bh, 0, 0, [guardSite], null);
check('hole below the footprint skips the site', drawnBelowHole === 0,
      `${drawnBelowHole} drawn with a hole underfoot`);

// Mirror: footprint and every guarded neighbour painted -> the site IS drawn.
// A guard that always skips (or was deleted and always draws) would pass the
// two checks above in one direction or the other and hide here.
const intact = paintedBuf();
const drawnIntact = stampDecals(intact, bw, bh, 0, 0, [guardSite], null);
check('fully painted neighbourhood draws', drawnIntact === 1,
      `${drawnIntact} drawn with neighbours intact`);

// ─── re-bake threshold ────────────────────────────────────────────────────────
//
// This is also the sub-threshold / supra-threshold proof for the passive gate
// wired into IsoDioramaRenderer.setLiveData(): a sub-threshold nudge must NOT
// ask for a re-bake, a supra-threshold one must. Asserted directly on
// decalRebakeNeeded rather than through a live setLiveData() call, because
// IsoDioramaRenderer itself pulls in a much larger canvas surface (background
// starfield, atmosphere, wisps) than this file's minimal stub supports — the
// call-site WIRING in setLiveData()/main.ts (which lines call setLiveData
// unconditionally vs. behind the gate) is therefore NOT exercised by
// automation and was verified by direct code reading instead.
const { decalRebakeNeeded } = await import('../src/rendering/SurfaceDecals');
check('first bake always needed', decalRebakeNeeded(null, { lush: 0.2, biodiversity: 1 }), 'null prev');
check('tiny lush drift does not re-bake',
      !decalRebakeNeeded({ lush: 0.400, biodiversity: 3 }, { lush: 0.430, biodiversity: 3 }), '0.03');
check('material lush change re-bakes',
      decalRebakeNeeded({ lush: 0.40, biodiversity: 3 }, { lush: 0.48, biodiversity: 3 }), '0.08');
check('a new species re-bakes',
      decalRebakeNeeded({ lush: 0.40, biodiversity: 3 }, { lush: 0.405, biodiversity: 4 }), 'biodiversity 3->4');

// THE GATE SATURATES — and this is why it must never be the sole passive
// trigger for a surface re-bake.
//
// `biodiversity` is capped at 10 (EvolutionEngine.ts) and the lushness term is
// 0..1, so on a thriving world `lush` pins at 1.0 and `floor(biodiversity)` at
// 10, and this function returns false FOREVER after. That is correct for
// decals — nothing about the forest changes once both saturate — but
// `surfaceDirty` also drives buildCityDots() and buildInhabitants(), which
// read cell.civId, cell.dominantSpeciesId and star.biologyPhase. None of those
// are in this tuple. A build that removed main.ts's unconditional
// markSurfaceDirty() calls and leaned on this gate alone would stop picking up
// new settlements and creatures for the entire civilisation phase — exactly
// when a player is watching for them. That regression happened once; this
// assertion is what makes its premise visible.
const saturated = decalRebakeNeeded(
  { lush: 1.0, biodiversity: 10 }, { lush: 1.0, biodiversity: 10 });
check('the gate saturates on a thriving world', saturated === false,
      'lush 1.0 / biodiversity 10 -> no further re-bake, ever');
// Even a large biodiversity "gain" past the cap is invisible to it, because the
// cap means the value never actually gets there.
const pastCap = decalRebakeNeeded(
  { lush: 1.0, biodiversity: 10 }, { lush: 1.0, biodiversity: 10.9 });
check('...and cannot see change within the capped bucket', pastCap === false,
      'biodiversity 10 -> 10.9 (same floor) -> false');

// ─── minimal canvas 2D stub, so a real HabitableCutawayEngine can be built ────
//
// Only the operations paintCutawayCrust / paintCutawaySurface / makeWispSprite
// actually call. putImageData/getImageData are backed by a real per-canvas
// pixel buffer (not just a coverage mask) so the check below can read back
// exactly what was painted, at whatever offset the paint functions used.
class StubCtx {
  buf: Uint8ClampedArray;
  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  constructor(public w: number, public h: number) {
    this.buf = new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4);
  }
  clearRect(x = 0, y = 0, w = this.w, h = this.h): void {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w)), y1 = Math.min(this.h, Math.round(y + h));
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
      const o = (py * this.w + px) * 4;
      this.buf[o] = this.buf[o + 1] = this.buf[o + 2] = this.buf[o + 3] = 0;
    }
  }
  // No-op: this assumes the land canvas (the one this check inspects) is
  // written only via putImageData, never via fillRect/path fills/drawImage.
  // paintCutawaySurface confirms that today (createImageData + putImageData
  // only) — if that changes, these no-ops would silently under-count what
  // was actually painted, since they never touch `buf`.
  fillRect(): void {}
  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  ellipse(): void {}
  rect(): void {}
  fill(): void {}
  stroke(): void {}
  save(): void {}
  restore(): void {}
  clip(): void {}
  drawImage(): void {}
  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
  createImageData(w: number, h: number) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData(
    img: { width: number; height: number; data: Uint8ClampedArray }, dx: number, dy: number,
  ): void {
    for (let y = 0; y < img.height; y++) {
      const py = dy + y;
      if (py < 0 || py >= this.h) continue;
      for (let x = 0; x < img.width; x++) {
        const px = dx + x;
        if (px < 0 || px >= this.w) continue;
        const so = (y * img.width + x) * 4, o = (py * this.w + px) * 4;
        this.buf[o] = img.data[so]; this.buf[o + 1] = img.data[so + 1];
        this.buf[o + 2] = img.data[so + 2]; this.buf[o + 3] = img.data[so + 3];
      }
    }
  }
  getImageData(x = 0, y = 0, w = this.w, h = this.h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let py = 0; py < h; py++) {
      const sy = y + py;
      if (sy < 0 || sy >= this.h) continue;
      for (let px = 0; px < w; px++) {
        const sx = x + px;
        if (sx < 0 || sx >= this.w) continue;
        const so = (sy * this.w + sx) * 4, o = (py * w + px) * 4;
        out[o] = this.buf[so]; out[o + 1] = this.buf[so + 1];
        out[o + 2] = this.buf[so + 2]; out[o + 3] = this.buf[so + 3];
      }
    }
    return { width: w, height: h, data: out };
  }
}
function makeStubCanvas(): any {
  const c: any = { width: 1, height: 1, style: {} };
  c.getContext = () => {
    if (!c._ctx || c._ctx.w !== c.width || c._ctx.h !== c.height) {
      c._ctx = new StubCtx(c.width, c.height);
    }
    return c._ctx;
  };
  return c;
}
(globalThis as any).document = { createElement: () => makeStubCanvas() };

// A partial re-bake must see the CURRENT lushness, not the one frozen into the
// options at the last full bake. Without updateSurfaceOpts this check fails:
// the second paint reproduces the first exactly.
//
// The 0.05 / 0.95 endpoints are LOAD-BEARING: narrowing them silently breaks
// assertion (C) below, whose floor was measured at exactly these values. Do
// not "tidy" them toward the middle of the range without re-measuring.
const { HabitableCutawayEngine } = await import('../src/rendering/HabitableCutawayEngine');
const engine: any = new HabitableCutawayEngine();
engine.bake({
  w: 480, h: 320, seed: 0xbeef, grid, planetType: 'ocean',
  discToGrid, rimFalloff, liftOf, smoothElevation, maxLift: 9,
  lush: 0.05, decalSeed: 0xC0FFEE,
});
const snapshot = (): { width: number; height: number; data: Uint8ClampedArray } => {
  const g2: any = engine.land.getContext('2d');
  return g2.getImageData(0, 0, engine.w, engine.h);
};
const countPainted = (img: { data: Uint8ClampedArray }): number => {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) n++;
  return n;
};
// Pixels whose colour differs, ignoring alpha — this is what a naive "did the
// paint change" check would use, and it is a TRAP on its own: the vegetation
// tint recolours already-painted ground every time lush changes, regardless
// of whether a single decal was ever placed. A regression that deleted decal
// placement entirely would still pass a bare RGB-diff check. It is kept below
// only as assertion (A), proving live lushness reached the painter at all;
// assertion (B) is the one that actually defends the decal feature.
const diffRGB = (a: { data: Uint8ClampedArray }, b: { data: Uint8ClampedArray }): number => {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
  }
  return n;
};

const beforeImg = snapshot();
const bare = countPainted(beforeImg);
engine.updateSurfaceOpts({ lush: 0.95 });
engine.rebakeSurface();
const afterImg = snapshot();
const lushly = countPainted(afterImg);

// (A) propagation — live lushness reached the painter, and moved it a lot,
// not by some rounding-error sliver.
const tintDelta = diffRGB(beforeImg, afterImg);
check('lushness change propagates into the paint', tintDelta > 2000, `${tintDelta} px recoloured`);

// (B) decal-specific — hold lushness fixed and vary ONLY decalSeed (terrain
// tint depends solely on lush, not on decalSeed, so every differing pixel
// here is attributable to decal placement, not to the tint). This is what
// actually proves decals — not just the tint — track the live bake.
const engineAltSeed: any = new HabitableCutawayEngine();
engineAltSeed.bake({
  w: 480, h: 320, seed: 0xbeef, grid, planetType: 'ocean',
  discToGrid, rimFalloff, liftOf, smoothElevation, maxLift: 9,
  // decalSeed intentionally omitted. That gives NO decals at all, not merely a
  // different layout — so every pixel of difference below is decal coverage
  // appearing/disappearing, which makes this assertion STRONGER than a
  // layout-vs-layout comparison, not weaker.
  lush: 0.95,
});
const altImg = (() => {
  const g2: any = engineAltSeed.land.getContext('2d');
  return g2.getImageData(0, 0, engineAltSeed.w, engineAltSeed.h);
})();
const decalDelta = diffRGB(afterImg, altImg);
check('decal placement is decal-seed-specific, not just tint', decalDelta > 50,
      `${decalDelta} px differ by decal seed alone`);

// (C) silhouette — a measured floor, not just "> 0": at ~1.3 new-alpha px per
// site, a regression that cut decal placement by 75% could still slip past a
// bare `>` at these endpoints. Re-measure this floor if 0.05/0.95 ever change.
check('a re-bake reflects the new biosphere', lushly - bare >= 10,
      `painted px ${bare} -> ${lushly} (+${lushly - bare})`);

// ─── planet-type bound on decal kind ──────────────────────────────────────────
//
// A rule validated on one planet type is not validated. Desert and lava worlds
// must not grow temperate forest however wet an individual cell classifies.
const typeOpts = (planetType: string, g2: any) => ({
  ...opts, planetType, grid: g2,
});
const desertGrid = generatePlanetGrid('desert', 7777, null);
const lavaGrid = generatePlanetGrid('lava', 7777, null);
const desertSites = planSurfaceDecals(typeOpts('desert', desertGrid) as any, 0.92, 0xC0FFEE);
const lavaSites = planSurfaceDecals(typeOpts('lava', lavaGrid) as any, 0.92, 0xC0FFEE);
const woodyOf = (a: any[]) =>
  a.filter(s => s.kind === 'conifer' || s.kind === 'broadleaf').length;

check('a desert world grows no forest', woodyOf(desertSites) === 0,
      `${woodyOf(desertSites)} trees of ${desertSites.length} decals`);
check('a desert world is not bare either', desertSites.length > 20,
      `${desertSites.length} decals`);
check('a lava world grows nothing but rock',
      lavaSites.every(s => s.kind === 'rock'),
      `${lavaSites.length} decals, kinds ${[...new Set(lavaSites.map(s => s.kind))].join(',')}`);
// The temperate case must NOT regress: ocean keeps its forest. That control
// used to live here as a second, literally identical copy of the deleted
// `woodland dominates a lush world` assertion — same expression, same single
// seed. It is now the sweep's `lush-woody` column, over 24 worlds.

// ─── seed sweep: density, composition and clumping over MANY worlds ───────────
//
// This project's own lesson: a single-seed assertion cannot tell "broken" from
// "unlucky". Density (mid-woody), composition (lush-woody) and clumping were
// all asserted on grid seed 7777 / genome seed 0xC0FFEE alone. Swept over 8
// grid seeds x 3 genome seeds they are NOT uniformly true, so asserting them
// as universals asserts something false.
//
// So: assert the DISTRIBUTION. Median, plus the share of worlds satisfying the
// per-world bound. Thresholds are set from what this sweep MEASURES, not from
// what would be nice — and the full table prints either way, so the real
// behaviour stays visible rather than collapsing to a pass/fail bit.
//
// DELIBERATELY NOT RETUNING the placement constants to make these prettier.
// Retuning needs a visual pass across several worlds; the job here is to make
// the check tell the truth. Where the measured behaviour is weaker than the
// feature's stated intent, that is recorded as a finding, not tuned away.
const GRID_SEEDS = [7777, 1234, 4242, 90210, 31337, 5150, 8675309, 2024];
const GENOME_SEEDS = [0xC0FFEE, 0xBADF00D, 0x5EED];

interface SweepRow {
  gridSeed: number; genomeSeed: number;
  midN: number; lushN: number;
  midWoody: number; lushWoody: number; clump: number;
  onSnow: number;
}
const sweep: SweepRow[] = [];
for (const gs of GRID_SEEDS) {
  const g2 = generatePlanetGrid('ocean', gs, null);
  const proj = landFocusFor(g2);
  for (const ds of GENOME_SEEDS) {
    const o: any = { ...opts, grid: g2, discToGrid: proj };
    const m = planSurfaceDecals(o, 0.45, ds);
    const l = planSurfaceDecals(o, 0.92, ds);
    sweep.push({
      gridSeed: gs, genomeSeed: ds,
      midN: m.length, lushN: l.length,
      midWoody: woody(m), lushWoody: woody(l),
      clump: clumpiness(l.map(s => ({ x: s.x, y: s.y }))),
      // The painter-snow invariant is checked on every swept world too, not
      // only on grid seed 7777 — high mountains are simply absent from some
      // worlds' focused disc (measured: 0 in view on seeds 5150 and 8675309),
      // so a single-world scan can be green for want of anything to catch.
      onSnow: l.filter(s => {
        const cell = g2[s.row]?.[s.col];
        return !!cell && cell.biome === 'mountain' && cell.elevation > PAINTER_SNOW_ELEVATION;
      }).length,
    });
  }
}

const median = (xs: number[]): number => {
  const a = [...xs].sort((p, q) => p - q);
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
};
const rate = (xs: number[], ok: (v: number) => boolean): number =>
  xs.filter(ok).length / xs.length;

console.log(`\n  seed sweep — ${GRID_SEEDS.length} grid seeds x ${GENOME_SEEDS.length} genome seeds`
  + ` = ${sweep.length} worlds\n`);
console.log('    grid      genome      midN  lushN   mid-woody  lush-woody   clump  onSnow');
for (const r of sweep) {
  console.log(`    ${String(r.gridSeed).padStart(8)}  0x${r.genomeSeed.toString(16).toUpperCase().padEnd(8)}`
    + `  ${String(r.midN).padStart(4)}  ${String(r.lushN).padStart(5)}`
    + `       ${r.midWoody.toFixed(3)}       ${r.lushWoody.toFixed(3)}   ${r.clump.toFixed(3)}`
    + `  ${String(r.onSnow).padStart(6)}`);
}

const midW = sweep.map(r => r.midWoody);
const lushW = sweep.map(r => r.lushWoody);
const clumps = sweep.map(r => r.clump);
const MID_WOODY_MAX = 0.15, LUSH_WOODY_MIN = 0.50;
// Per-world bounds above; the share of worlds that must satisfy them below.
// MEASURED on this sweep (24 worlds), and each rate threshold is set one world
// below the measured rate — a real bound with a single world of tolerance, not
// a number chosen to sit exactly on today's result:
//   mid-woody  < 0.15   20/24 = 83%   -> require 75% (allows 18/24)
//   lush-woody > 0.50   24/24 = 100%  -> require 90% (allows 22/24)
//   clump      >= 0.45  18/24 = 75%   -> require 70% (allows 17/24)
// FINDING, recorded rather than tuned away: clumping is much the weakest of
// the three. Six of 24 worlds fall below CLUMP_MIN and the median (0.478) sits
// just over it, where the other two metrics clear their bounds comfortably.
// Raising it means retuning the grove/sward noise, which needs a visual pass
// across several worlds — deliberately out of scope for this wave.
const MID_WOODY_RATE = 0.75, LUSH_WOODY_RATE = 0.90, CLUMP_RATE = 0.70;
console.log(`\n    median  mid-woody ${median(midW).toFixed(3)}`
  + `   lush-woody ${median(lushW).toFixed(3)}   clump ${median(clumps).toFixed(3)}`);
console.log(`    pass    mid-woody<${MID_WOODY_MAX} ${(rate(midW, v => v < MID_WOODY_MAX) * 100).toFixed(0)}%`
  + ` (need ${MID_WOODY_RATE * 100}%)`
  + `   lush-woody>${LUSH_WOODY_MIN} ${(rate(lushW, v => v > LUSH_WOODY_MIN) * 100).toFixed(0)}%`
  + ` (need ${LUSH_WOODY_RATE * 100}%)`
  + `   clump>=${CLUMP_MIN} ${(rate(clumps, v => v >= CLUMP_MIN) * 100).toFixed(0)}%`
  + ` (need ${(CLUMP_RATE * 100).toFixed(0)}%)\n`);

// Ground cover precedes woodland. Holds on the clear majority of worlds.
check('sweep: median mid-woody stays low', median(midW) < MID_WOODY_MAX,
      `median ${median(midW).toFixed(3)} < ${MID_WOODY_MAX}`);
check('sweep: most worlds keep mid-woody low',
      rate(midW, v => v < MID_WOODY_MAX) >= MID_WOODY_RATE,
      `${(rate(midW, v => v < MID_WOODY_MAX) * 100).toFixed(0)}% >= ${MID_WOODY_RATE * 100}%`);

// Woodland dominates a lush world.
check('sweep: median lush-woody dominates', median(lushW) > LUSH_WOODY_MIN,
      `median ${median(lushW).toFixed(3)} > ${LUSH_WOODY_MIN}`);
check('sweep: most worlds reach woodland dominance',
      rate(lushW, v => v > LUSH_WOODY_MIN) >= LUSH_WOODY_RATE,
      `${(rate(lushW, v => v > LUSH_WOODY_MIN) * 100).toFixed(0)}% >= ${LUSH_WOODY_RATE * 100}%`);

// Groves and clearings, not an even scatter.
check('sweep: median placement clumps', median(clumps) >= CLUMP_MIN,
      `median ${median(clumps).toFixed(3)} >= ${CLUMP_MIN}`);
check('sweep: most worlds clump',
      rate(clumps, v => v >= CLUMP_MIN) >= CLUMP_RATE,
      `${(rate(clumps, v => v >= CLUMP_MIN) * 100).toFixed(0)}% >= ${(CLUMP_RATE * 100).toFixed(0)}%`
      + `  (weakest of the three — see the note at CLUMP_RATE)`);

// Monotonicity is not a distribution question — it must hold on EVERY world,
// and it is what makes the surface a readout at all.
const nonMono = sweep.filter(r => r.lushN <= r.midN).length;
check('sweep: every world is monotonic', nonMono === 0,
      `${nonMono} of ${sweep.length} worlds with lushN <= midN`);

// Nor is the snow invariant a distribution question: no world may stamp a
// decal onto a cap the painter renders white.
const snowTotal = sweep.reduce((a, r) => a + r.onSnow, 0);
check('sweep: no world stamps onto painter snow', snowTotal === 0,
      `${snowTotal} sites across ${sweep.length} worlds`);

// ─── per-frame cost bound ──────────────────────────────────────────────────────
//
// Bake cost may rise; per-frame cost may not. Decals live in the baked land
// canvas, so `frame()` must not know they exist.
const t0 = performance.now();
for (let i = 0; i < 30; i++) planSurfaceDecals(opts, 0.92, 0xC0FFEE);
const planMs = (performance.now() - t0) / 30;
console.log(`\n  planning cost ${planMs.toFixed(1)}ms (bake-time only)`);
check('planning stays off the frame budget', planMs < 25, `${planMs.toFixed(1)}ms < 25ms`);

// The timing bound above does NOT guard the structural property. `planMs < 25`
// stays green if someone calls planSurfaceDecals from frame() — it measures the
// function, not who calls it. The real constraint is reachability: surface
// painting and decal planning are bake-time work and must be unreachable from
// the per-frame path. Asserted on the SOURCE, which is where that property
// lives.
const { readFileSync, existsSync } = await import('node:fs');
const { resolve } = await import('node:path');
const enginePath = resolve(process.cwd(), 'src/rendering/HabitableCutawayEngine.ts');
check('engine source is readable for the frame() scan', existsSync(enginePath),
      enginePath);
if (existsSync(enginePath)) {
  const src = readFileSync(enginePath, 'utf8');
  // The method, not the interface field or any of the prose: match at method
  // indentation with a body brace.
  const m = /\n  frame\s*\([^)]*\)\s*:\s*void\s*\{/.exec(src);
  check('frame() method was located in source', !!m, m ? `at index ${m.index}` : 'NOT FOUND');
  if (m) {
    // Brace-match from the body's opening brace to its close.
    let i = m.index + m[0].length - 1, depth = 0, end = -1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = end > 0 ? src.slice(m.index, end + 1) : '';
    check('frame() body was delimited', body.length > 0, `${body.length} chars`);
    check('frame() never paints the surface', !body.includes('paintCutawaySurface'),
          `body ${body.length} chars`);
    check('frame() never plans decals', !body.includes('planSurfaceDecals'),
          `body ${body.length} chars`);
    // Control: the scan must be able to SEE these names, or the two assertions
    // above are green because the extraction failed, not because the code is
    // clean. Both appear elsewhere in the same file.
    check('control: the scan can see those names at all',
          src.includes('paintCutawaySurface') && src.includes('planSurfaceDecals'),
          'both present in the file, absent from frame()');
  }
}

console.log(failed === 0 ? '\n  all decal checks passed' : `\n  ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
