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
// Land-finding focus: same search as tools/habitableDioramaCheck.ts:250-270.
// An arbitrary camera focus (e.g. (0.2, 1.1)) can land mostly over ocean, so a
// "dead world has no decals" check against it proves nothing about placement
// under the focus the game actually uses (IsoDioramaRenderer's computeFocus
// centres on land the same way).
let bestScore = -1, bestRow = GRID_SIZE >> 1, bestCol = 0;
const STRIDE = 8, RAD = 3;
for (let row = STRIDE * RAD; row < GRID_SIZE - STRIDE * RAD; row += STRIDE) {
  const latW = 1 - Math.abs(row / (GRID_SIZE - 1) - 0.5) * 1.4;
  if (latW <= 0) continue;
  for (let col = 0; col < GRID_SIZE; col += STRIDE) {
    let score = 0;
    for (let dr = -RAD; dr <= RAD; dr++) for (let dc = -RAD; dc <= RAD; dc++) {
      const cell = grid[row + dr * STRIDE]?.[(col + dc * STRIDE + GRID_SIZE) % GRID_SIZE];
      if (cell && !isWater(cell.biome)) score += 1 + cell.fertility;
    }
    score *= latW;
    if (score > bestScore) { bestScore = score; bestRow = row; bestCol = col; }
  }
}
const discToGrid = makeProjection(
  (0.5 - bestRow / (GRID_SIZE - 1)) * Math.PI, (bestCol / GRID_SIZE) * Math.PI * 2);

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
  lush: 0.95, // decalSeed intentionally omitted -> a different decal layout
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
// The temperate case must NOT regress: ocean keeps its forest.
check('an ocean world still grows forest', woody(lush) > 0.50,
      `lush woody ${woody(lush).toFixed(2)}`);

console.log(failed === 0 ? '\n  all decal checks passed' : `\n  ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
