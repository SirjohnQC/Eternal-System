/**
 * Headless pixel harness for the zoom camera checks. A minimal canvas shim that
 * RECORDS colours (habitableDioramaCheck's shim records coverage only), so layer
 * images can be hashed and measured.
 *
 * ── renderLayers: what it reads ──────────────────────────────────────────────
 * `renderLayers(type, seed)` drives the REAL engine and painters at 480x320 at
 * the identity view (viewZoom 1) and returns one RGBA buffer per layer. It reads
 * these engine internals through `(engine as any)`:
 *   - `crust`, `land`     private PixelCanvas layers baked by `bake()`; their `.data`
 *   - `atmoImage`         private ImageData, holds the atmosphere after `frame()`
 *   - `weatherImage`      private ImageData, holds precipitation + clouds + lightning
 *                         after `frame()` (stays empty for gas: no weather painter)
 *   - `fluidImage`        private ImageData; after `frame()` it holds the day/night
 *                         veil PLUS cloud shadows (`paintShadows`) — the `shadows` layer
 *   - `geom`, `occupancy`, `shoreDist` (public) — fed to direct `paintFluids` /
 *                         `paintDayNight` calls into fresh images
 * `fluids`, `dayNight`, `sky` and `backdrop` are painted directly by the harness
 * with the same inputs the game passes, into fresh zeroed images.
 *
 * ── Fixtures (the same every run) ────────────────────────────────────────────
 *   grid         generatePlanetGrid(type, seed * 7777, null, null)
 *   projection   IsoDioramaRenderer.discToGrid / computeFocus, copied verbatim
 *   relief       rimFalloff, smoothElevation copied verbatim; liftOf = habitable
 *                tiers 3/6/9/13/18, maxLift 18 (IsoDioramaRenderer, habitable path)
 *   bake         seed = decalSeed = climate seed = `seed`; lush 0.6; decalAtlas null
 *                (the procedural decal fallback — the game's first bake before the
 *                atlas loads); weather = buildClimate(...) except gas (null); sunLat 0
 *   frame        elapsed 10, dt 1/60, sunAzimuth 0.6, viewZoom 1, air omitted (the
 *                per-type default), no-op backdrop and overlays
 *   fluids       paintFluids(img, geom, occupancy, type, 10, 0, shoreDist)
 *   dayNight     paintDayNight(img, geom, 0.6, 0)
 *   sky          paintSky(img, skyLayout(geom, 480, 320), orbitSky({ animTick: 1000,
 *                home: P(40, 0.3), planets: [home, P(70, 1.2)], dayAngle: 0.6 })),
 *                sun rgb (255,236,180) (the renderer's no-star default), sibling
 *                radius 3 px, rgb (70,140,210) — skyCheck's drawOf fixture
 *   backdrop     bakeBackdrop(1440x320 image, { seed: 7, vw: 480 })
 *
 * ── Determinism ──────────────────────────────────────────────────────────────
 * No engine or painter on this path reads wall-clock time. `WeatherSim` declares
 * `anomalyRng = Math.random` but `reset()` (run by its constructor) replaces it
 * with a seeded stream before any use. As a guard, `renderLayers` swaps
 * Math.random for a fixed-seed LCG for its duration and counts the calls
 * (`lastRandomCalls`); zoomGoldens prints that count (0 = nothing reached it).
 *
 * The canvas shim: `fillRect` source-over composites a parsed `rgb()/rgba()/#rrggbb`
 * colour (gradients and other styles count as transparent); `putImageData`
 * replaces; `drawImage` source-over composites another PixelCanvas at integer
 * offset (other sources are ignored); path ops (arc/ellipse/stroke/fill) are
 * counted, not rasterised. Gas rings and the vignette are therefore invisible to
 * this harness; neither is in a returned layer.
 */
export class PixelCtx {
  fillStyle: unknown = '#000'; strokeStyle: unknown = '#000'; lineWidth = 1;
  globalAlpha = 1; globalCompositeOperation = 'source-over'; imageSmoothingEnabled = false;
  pathOps = 0;
  constructor(readonly canvas: PixelCanvas) {}
  private parse(c: unknown): [number, number, number, number] {
    if (typeof c !== 'string') return [0, 0, 0, 0];
    let m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255, 1]; }
    return [0, 0, 0, 0];
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    const [r, g, b, a0] = this.parse(this.fillStyle);
    const a = a0 * this.globalAlpha, W = this.canvas.width, H = this.canvas.height, d = this.canvas.data;
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(H, Math.round(y + h)); yy++)
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(W, Math.round(x + w)); xx++) {
        const o = (yy * W + xx) * 4, da = d[o + 3] / 255, oa = a + da * (1 - a);
        if (oa <= 0) continue;
        d[o] = (r * a + d[o] * da * (1 - a)) / oa; d[o + 1] = (g * a + d[o + 1] * da * (1 - a)) / oa;
        d[o + 2] = (b * a + d[o + 2] * da * (1 - a)) / oa; d[o + 3] = oa * 255;
      }
  }
  clearRect(): void { this.canvas.data.fill(0); }
  createImageData(w: number, h: number) {
    // Browsers throw IndexSizeError on an empty image; so does the shim.
    if (!(w > 0) || !(h > 0)) throw new Error(`IndexSizeError: createImageData(${w}, ${h})`);
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  getImageData(x = 0, y = 0, w = this.canvas.width, h = this.canvas.height) {
    const out = this.createImageData(w, h), W = this.canvas.width;
    for (let yy = 0; yy < h; yy++) out.data.set(this.canvas.data.subarray(((y + yy) * W + x) * 4, ((y + yy) * W + x + w) * 4), yy * w * 4);
    return out;
  }
  putImageData(img: { width: number; height: number; data: Uint8ClampedArray }, dx: number, dy: number): void {
    const W = this.canvas.width, H = this.canvas.height;
    for (let y = 0; y < img.height; y++) {
      const ty = dy + y; if (ty < 0 || ty >= H) continue;
      for (let x = 0; x < img.width; x++) {
        const tx = dx + x; if (tx < 0 || tx >= W) continue;
        const s = (y * img.width + x) * 4, t = (ty * W + tx) * 4;
        for (let c = 0; c < 4; c++) this.canvas.data[t + c] = img.data[s + c];
      }
    }
  }
  drawImage(src: unknown, ...a: number[]): void {
    if (!(src instanceof PixelCanvas)) return;
    // Scaled forms (5 and 9 arguments): nearest-neighbour, sampled at each
    // destination pixel's centre — what imageSmoothingEnabled = false draws.
    if (a.length === 4 || a.length === 8) {
      const [sx, sy, sw, sh, ddx, ddy, dw, dh] = a.length === 4
        ? [0, 0, src.width, src.height, a[0], a[1], a[2], a[3]] : a;
      const W = this.canvas.width, H = this.canvas.height, d = this.canvas.data, s = src.data;
      for (let Y = Math.max(0, Math.floor(ddy)); Y < Math.min(H, Math.ceil(ddy + dh)); Y++) {
        if (Y + 0.5 < ddy || Y + 0.5 >= ddy + dh) continue;
        const syi = Math.floor(sy + (Y + 0.5 - ddy) * (sh / dh));
        if (syi < 0 || syi >= src.height) continue;
        for (let X = Math.max(0, Math.floor(ddx)); X < Math.min(W, Math.ceil(ddx + dw)); X++) {
          if (X + 0.5 < ddx || X + 0.5 >= ddx + dw) continue;
          const sxi = Math.floor(sx + (X + 0.5 - ddx) * (sw / dw));
          if (sxi < 0 || sxi >= src.width) continue;
          const si = (syi * src.width + sxi) * 4, o = (Y * W + X) * 4, al = s[si + 3] / 255;
          if (al <= 0) continue;
          const da = d[o + 3] / 255, oa = al + da * (1 - al);
          for (let c = 0; c < 3; c++) d[o + c] = (s[si + c] * al + d[o + c] * da * (1 - al)) / oa;
          d[o + 3] = oa * 255;
        }
      }
      return;
    }
    const dx = a[0] ?? 0, dy = a[1] ?? 0;
    const img = { width: src.width, height: src.height, data: src.data };
    // Source-over composite of a same-size or smaller canvas.
    const W = this.canvas.width, H = this.canvas.height, d = this.canvas.data;
    for (let y = 0; y < img.height; y++) {
      const ty = Math.round(dy) + y; if (ty < 0 || ty >= H) continue;
      for (let x = 0; x < img.width; x++) {
        const tx = Math.round(dx) + x; if (tx < 0 || tx >= W) continue;
        const s = (y * img.width + x) * 4, o = (ty * W + tx) * 4, a = img.data[s + 3] / 255;
        if (a <= 0) continue;
        const da = d[o + 3] / 255, oa = a + da * (1 - a);
        for (let c = 0; c < 3; c++) d[o + c] = (img.data[s + c] * a + d[o + c] * da * (1 - a)) / oa;
        d[o + 3] = oa * 255;
      }
    }
  }
  save(): void {} restore(): void {} clip(): void {} beginPath(): void {} closePath(): void {}
  moveTo(): void {} lineTo(): void {} arc(): void {} ellipse(): void {} rect(): void {}
  fill(): void { this.pathOps++; } stroke(): void { this.pathOps++; }
  translate(): void {} scale(): void {} rotate(): void {} setTransform(): void {}
  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
}

export class PixelCanvas {
  data: Uint8ClampedArray; style: Record<string, string> = {};
  private ctx: PixelCtx | null = null;
  constructor(private w = 1, private h = 1) { this.data = new Uint8ClampedArray(w * h * 4); }
  get width() { return this.w; } set width(v: number) { this.w = v; this.data = new Uint8ClampedArray(this.w * this.h * 4); }
  get height() { return this.h; } set height(v: number) { this.h = v; this.data = new Uint8ClampedArray(this.w * this.h * 4); }
  getContext(): PixelCtx { return (this.ctx ??= new PixelCtx(this)); }
}

export function installDom(): void {
  (globalThis as any).document = { createElement: () => new PixelCanvas() };
  (globalThis as any).ImageData = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} };
}

export function hashImage(d: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ─── Identity render of every layer ───────────────────────────────────────────
//
// The engine and painters are imported dynamically AFTER installDom(), so the
// engine's canvases are PixelCanvases. Top-level await: importing this module
// installs the DOM shim and loads the engine; renderLayers is then synchronous.

installDom();
const { generatePlanetGrid, SEA_LEVEL, GRID_SIZE, isWater } = await import('../src/simulation/PlanetGrid');
const { HabitableCutawayEngine, paintFluids, paintDayNight } = await import('../src/rendering/HabitableCutawayEngine');
const { buildClimate } = await import('../src/rendering/weather/WeatherClimate');
const { paintSky, skyLayout } = await import('../src/rendering/sky/SkyPainter');
const { orbitSky } = await import('../src/rendering/sky/OrbitSky');
const { bakeBackdrop } = await import('../src/rendering/sky/Backdrop');
type Grid = ReturnType<typeof generatePlanetGrid>;
type EngineType = import('../src/rendering/HabitableCutawayEngine').HabitableType;

export const VW = 480, VH = 320;
/** IsoDioramaRenderer.maxLift on the habitable path. */
export const MAX_LIFT = 18;
export const LAYERS = ['crust', 'land', 'fluids', 'dayNight', 'shadows', 'atmosphere', 'weather', 'sky', 'backdrop'] as const;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampAbs = (v: number, m: number) => (v < -m ? -m : v > m ? m : v);

/** IsoDioramaRenderer.rimFalloff. */
export function rimFalloff(r: number): number {
  const t = clamp01((r - 0.34) / 0.66);
  return t * t * 0.30;
}

/** IsoDioramaRenderer.liftOf, habitable branch. */
export function liftOf(elev: number): number {
  if (elev < SEA_LEVEL) return 0;
  if (elev > 0.80) return 18;
  if (elev > 0.70) return 13;
  if (elev > 0.62) return 9;
  if (elev > 0.54) return 6;
  return 3;
}

/** IsoDioramaRenderer.smoothElevation. */
export function smoothElevation(grid: Grid, row: number, col: number): number {
  let sum = 0, n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    const r2 = row + dr;
    if (r2 < 0 || r2 >= GRID_SIZE) continue;
    for (let dc = -1; dc <= 1; dc++) {
      const c2 = (col + dc + GRID_SIZE) % GRID_SIZE;
      const cell = grid[r2]?.[c2];
      if (!cell) continue;
      const wt = (dr === 0 && dc === 0) ? 4 : 1;
      sum += cell.elevation * wt; n += wt;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** IsoDioramaRenderer.computeFocus: the most land-surrounded mid-latitude cell. */
export function computeFocus(grid: Grid): { lat: number; lon: number } {
  const STRIDE = 8, R = 3;
  let bestScore = -1, bestRow = GRID_SIZE >> 1, bestCol = 0;
  for (let row = STRIDE * R; row < GRID_SIZE - STRIDE * R; row += STRIDE) {
    const latWeight = 1 - Math.abs(row / (GRID_SIZE - 1) - 0.5) * 1.4;
    if (latWeight <= 0) continue;
    for (let col = 0; col < GRID_SIZE; col += STRIDE) {
      let score = 0;
      for (let dr = -R; dr <= R; dr++) {
        for (let dc = -R; dc <= R; dc++) {
          const cell = grid[row + dr * STRIDE]?.[(col + dc * STRIDE + GRID_SIZE) % GRID_SIZE];
          if (cell && !isWater(cell.biome)) score += 1 + cell.fertility;
        }
      }
      score *= latWeight;
      if (score > bestScore) { bestScore = score; bestRow = row; bestCol = col; }
    }
  }
  return { lat: (0.5 - bestRow / (GRID_SIZE - 1)) * Math.PI, lon: (bestCol / GRID_SIZE) * Math.PI * 2 };
}

/** IsoDioramaRenderer.discToGrid for a given focus. */
export function makeDiscToGrid(focusLat: number, focusLon: number) {
  return (dx: number, dy: number): { row: number; col: number } | null => {
    const r = Math.hypot(dx, dy);
    if (r > 1) return null;
    const c = r * (Math.PI / 2);
    const sinC = Math.sin(c), cosC = Math.cos(c);
    const sinF = Math.sin(focusLat), cosF = Math.cos(focusLat);
    const ny = -dy;
    const lat = r < 1e-6 ? focusLat : Math.asin(clampAbs(cosC * sinF + (ny * sinC * cosF) / r, 1));
    const lon = focusLon + Math.atan2(dx * sinC, r * cosF * cosC - ny * sinF * sinC);
    const v = 0.5 - lat / Math.PI;
    const u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;
    return {
      row: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)))),
      col: Math.min(GRID_SIZE - 1, Math.floor(u * GRID_SIZE)),
    };
  };
}

/**
 * IsoDioramaRenderer.discToGridF: the same projection as discToGrid, returning
 * the FRACTIONAL position `row = v * (GRID_SIZE - 1)`, `col = u * GRID_SIZE`.
 */
export function makeDiscToGridF(focusLat: number, focusLon: number) {
  return (dx: number, dy: number): { row: number; col: number } | null => {
    const r = Math.hypot(dx, dy);
    if (r > 1) return null;
    const c = r * (Math.PI / 2);
    const sinC = Math.sin(c), cosC = Math.cos(c);
    const sinF = Math.sin(focusLat), cosF = Math.cos(focusLat);
    const ny = -dy;
    const lat = r < 1e-6 ? focusLat : Math.asin(clampAbs(cosC * sinF + (ny * sinC * cosF) / r, 1));
    const lon = focusLon + Math.atan2(dx * sinC, r * cosF * cosC - ny * sinF * sinC);
    const v = 0.5 - lat / Math.PI;
    const u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;
    return { row: v * (GRID_SIZE - 1), col: u * GRID_SIZE };
  };
}

/**
 * IsoDioramaRenderer.elevationAt: smoothElevation interpolated bilinearly
 * between the 4 cell centres around the fractional grid position. Row i's
 * centre is at row i (discToGrid rounds); column j's centre is at col j + 0.5
 * (discToGrid floors). Columns wrap, rows clamp.
 */
export function makeElevationAt(grid: Grid, focusLat: number, focusLon: number) {
  const toF = makeDiscToGridF(focusLat, focusLon), atGrid = makeElevationAtGrid(grid);
  return (dx: number, dy: number): number | null => {
    const f = toF(dx, dy);
    return f ? atGrid(f.row, f.col) : null;
  };
}

/** IsoDioramaRenderer.elevationAtGrid: the same interpolation at a fractional grid position. */
export function makeElevationAtGrid(grid: Grid) {
  return (row: number, col: number): number => {
    const rr = Math.max(0, Math.min(GRID_SIZE - 1, row));
    const r0 = Math.min(GRID_SIZE - 2, Math.floor(rr)), tr = rr - r0;
    const cc = col - 0.5;
    const c0f = Math.floor(cc), tc = cc - c0f;
    const c0 = ((c0f % GRID_SIZE) + GRID_SIZE) % GRID_SIZE, c1 = (c0 + 1) % GRID_SIZE;
    const e00 = smoothElevation(grid, r0, c0), e01 = smoothElevation(grid, r0, c1);
    const e10 = smoothElevation(grid, r0 + 1, c0), e11 = smoothElevation(grid, r0 + 1, c1);
    const top = e00 + (e01 - e00) * tc, bot = e10 + (e11 - e10) * tc;
    return top + (bot - top) * tr;
  };
}

/** skyCheck's orbit fixture: speed 0 freezes it at mean anomaly `angle`. */
const P = (r: number, angle: number) =>
  ({ orbitalRadius: r, orbitalAngle: angle, orbitalSpeed: 0, eccentricity: 0, periapsisAngle: 0, genomeSeed: 1 });

const blank = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

/** Math.random calls observed during the last renderLayers (guarded; see header). */
export let lastRandomCalls = 0;

export const ELAPSED = 10, DT = 1 / 60, SUN_AZ = 0.6;

export interface RenderOpts {
  /** Added to rimFalloff — the identity check's control (default 0). */
  rimPerturb?: number;
  /**
   * Render through this camera: `engine.setCamera(cam)` and `showCamera = true`
   * after the identity bake, so every returned layer is the CAMERA set
   * (crust/land from the camera canvases; fluids/dayNight painted on the camera
   * geometry, occupancy and shore distance). Omitted: the identity set.
   */
  cam?: import('../src/rendering/ZoomCamera').Camera;
  /** Force the atmosphere / cloud intensity (engine.hazeOverride); omitted: atmoHazeAmount(zoom). */
  haze?: number;
}

/** The fixtures behind one bake, for checks that need more than pixels. */
export interface BakedEngine {
  engine: InstanceType<typeof HabitableCutawayEngine>;
  grid: Grid;
  focus: { lat: number; lon: number };
  discToGrid: ReturnType<typeof makeDiscToGrid>;
  elevationAt: ReturnType<typeof makeElevationAt>;
  rim: (r: number) => number;
}

/** Bake the REAL engine at the identity view with the standard fixtures (see header). */
export function bakeEngine(type: string, seed: number, ro: RenderOpts = {}): BakedEngine {
  const planetType = type as EngineType;
  const grid = generatePlanetGrid(type, seed * 7777, null, null);
  const focus = computeFocus(grid);
  const discToGrid = makeDiscToGrid(focus.lat, focus.lon);
  const perturb = ro.rimPerturb ?? 0;
  const rim = perturb === 0 ? rimFalloff : (r: number) => rimFalloff(r) + perturb;
  // Passed as the renderer passes it; dormant at identity (no cameraZoom, Ruling 11).
  const elevationAt = makeElevationAt(grid, focus.lat, focus.lon);
  const engine = new HabitableCutawayEngine();
  engine.bake({
    w: VW, h: VH, seed, grid, planetType,
    discToGrid, discToGridF: makeDiscToGridF(focus.lat, focus.lon), rimFalloff: rim, liftOf, smoothElevation, elevationAt,
    maxLift: MAX_LIFT, lush: 0.6, decalSeed: seed, decalAtlas: null,
    weather: type === 'gas' ? null : buildClimate({
      grid, planetType: type, seed, lush: 0.6, extinctionPressure: 0.1,
      oxygenLevel: 0.6, civLevel: 0, inNebula: false,
    }),
  });
  return { engine, grid, focus, discToGrid, elevationAt, rim };
}

export function renderLayers(type: string, seed: number, ro: RenderOpts = {}): Record<string, Uint8ClampedArray> {
  const realRandom = Math.random;
  let s = 0x2545f491, calls = 0;
  Math.random = () => { calls++; s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  try {
    const planetType = type as EngineType;
    const { engine } = bakeEngine(type, seed, ro);
    if (ro.cam) {
      engine.setCamera(ro.cam);
      engine.showCamera = true;
    }
    if (ro.haze !== undefined) engine.hazeOverride = ro.haze;

    const frameCanvas = new PixelCanvas(VW, VH);
    const noop = () => {};
    engine.frame({
      g: frameCanvas.getContext() as unknown as CanvasRenderingContext2D,
      dt: DT, elapsed: ELAPSED, sunAzimuth: SUN_AZ, viewZoom: 1,
      drawBackdrop: noop, drawFarSpace: noop, drawSurfaceOverlays: noop,
      drawUiOverlays: noop, drawNearMoons: noop,
    });

    const e = engine as any;
    const cs = ro.cam ? e.camSet : null;
    const geom = cs ? engine.activeGeom : engine.geom;

    const fluids = blank(VW, VH);
    paintFluids(fluids as unknown as ImageData, geom, engine.occupancy, planetType, ELAPSED, 0, engine.shoreDist, cs ? cs.camera.zoom : 1);
    const dayNight = blank(VW, VH);
    paintDayNight(dayNight as unknown as ImageData, geom, SUN_AZ, 0);

    const sky = blank(VW, VH);
    const home = P(40, 0.3), sibling = P(70, 1.2);
    const st = orbitSky({ animTick: 1000, home, planets: [home, sibling], dayAngle: SUN_AZ });
    paintSky(sky, skyLayout(geom, VW, VH), {
      sunAz: st.sun.az, sunElev: st.sun.elev, sunSizeScale: st.sun.sizeScale,
      sunRgb: [255, 236, 180],
      siblings: st.siblings.map(b => ({
        az: b.az, elev: b.elev, litFraction: b.litFraction, radiusPx: 3, rgb: [70, 140, 210] as [number, number, number],
      })),
    });

    const backdrop = blank(VW * 3, VH);
    bakeBackdrop(backdrop, { seed: 7, vw: VW });

    return {
      crust: ((cs ? cs.crust : e.crust) as PixelCanvas).data.slice(),
      land: ((cs ? cs.land : e.land) as PixelCanvas).data.slice(),
      fluids: fluids.data,
      dayNight: dayNight.data,
      shadows: (e.fluidImage as { data: Uint8ClampedArray }).data.slice(),
      atmosphere: (e.atmoImage as { data: Uint8ClampedArray }).data.slice(),
      weather: (e.weatherImage as { data: Uint8ClampedArray }).data.slice(),
      sky: sky.data,
      backdrop: backdrop.data,
    };
  } finally {
    lastRandomCalls = calls;
    Math.random = realRandom;
  }
}


// ─── The real IsoDioramaRenderer, headless ───────────────────────────────────
//
// For the Task 6 placement checks (city lights, settlements, creatures, divine
// effects, moons, tile markers, sky). `init` runs against a stub mount of
// 960x640 CSS px (virtual 480x320); the decal atlas fetch fails in node and the
// procedural decal fallback is used, as in the engine fixture. The grid gets a
// civilisation on ~30% of its land cells and one founding species on the rest,
// so every placement kind has candidates. Fixed clock (animTick 1000).

const { IsoDioramaRenderer } = await import('../src/rendering/IsoDioramaRenderer');
const { initPlayerSpecies } = await import('../src/simulation/EvolutionEngine');
const { DEFAULT_BIOSPHERE } = await import('../src/simulation/SpeciesGenome');
const { SeedRNG } = await import('../src/utils/SeedRNG');

export const RENDERER_MOONS = [
  { name: 'm0', radius: 0.8, orbitalRadius: 4, orbitalAngle: 0.4, orbitalSpeed: 0, color: '#c8c0b0', kind: 'rock', habitability: 0, colonised: true, colonisedTick: 0 },
  { name: 'm1', radius: 0.5, orbitalRadius: 6, orbitalAngle: 3.6, orbitalSpeed: 0, color: '#b0d8f0', kind: 'ice', habitability: 0, colonised: false, colonisedTick: null },
];

/** A headless IsoDioramaRenderer baked for `type`/`seed` (see above). Returns it as `any` for private access. */
export async function makeRenderer(type: string, seed: number): Promise<any> {
  const grid = generatePlanetGrid(type, seed * 7777, null, null);
  const species = initPlayerSpecies(0, new SeedRNG(`founder_zoom_${seed}`));
  const sid = species[0].id;
  for (let row = 0; row < GRID_SIZE; row++) for (let col = 0; col < GRID_SIZE; col++) {
    const cell = grid[row][col];
    if (isWater(cell.biome)) continue;
    const h = ((Math.imul(row * 928371 + col * 12345 + seed, 2654435761) >>> 0) % 1000) / 1000;
    if (h < 0.3) cell.civId = 'civ0';
    else { cell.dominantSpeciesId = sid; cell.lifeDensity = 0.6; }
  }
  const home: any = { ...P(40, 0.3), radius: 5, type, name: `Zoomworld${seed}`, moons: RENDERER_MOONS, hasLife: true, biosphere: 0.5, color: '#fff', genomeSeed: seed };
  const sibling: any = { ...P(70, 1.2), radius: 7, type: 'gas', name: 'Sib', moons: [], hasLife: false, biosphere: 0, color: '#fff' };
  const star: any = { x: 0, y: 0, temperature: 5800, civLevel: 3, biologyPhase: 'intelligent', planets: [home, sibling] };
  const mount: any = {
    style: {}, clientWidth: 960, clientHeight: 640,
    appendChild() {}, addEventListener() {}, removeEventListener() {}, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 640 }),
  };
  const r: any = new IsoDioramaRenderer();
  r.setClock(() => 1000);
  await r.init(mount);
  r.refreshData(grid, { ...DEFAULT_BIOSPHERE }, species, home, star, 0);
  r.elapsed = ELAPSED;
  r.sky = r.skyNow();
  return r;
}
