# Zoom Camera — crisp pixel art at every zoom (zoom-detail sub-project 1 of 6)

Date: 2026-09-30. Branch: `feat/zoom-camera` from `feat/surface-decals` (which
carries the merged weather sim and orbit sky). Revised the same day after a
review by Fable; the findings are folded in and listed at the end.

## Intent

Sirjohn: "detailed world when we zoom in, currently it just looks like well heavy
pixel". His choices:

- **Crisp pixel art at every zoom** — pixels stay the same size on screen; zooming
  in shows more pixels, never bigger ones.
- Six sub-projects, in order: **1. zoom camera (this spec)**, 2. terrain surface
  detail, 3. vegetation and props, 4. settlements and creatures, 5. water and
  weather detail, 6. full seasons.
- **Progressive zoom** — during a wheel/drag gesture the view keeps today's
  instant CSS scaling; ~150 ms after the gesture stops it re-renders sharp.
- He approved the architecture and the scale/stroke rule and delegated the rest:
  "let's try this, show me when it's ready".

**Deliverable** (revised after review): at zoom, every per-pixel layer is
re-rendered at full resolution — coastlines and terrace edges (via sub-cell
elevation sampling, section 4), relief, water, atmosphere, day/night, clouds,
rain, shadows, sky, dome. Biome COLOURS stay per grid cell (textured ground is
sub-project 2). Sprites (creatures, settlements, decals) are integer-scaled and
stay blocky until sub-projects 3-4. Grid cells grow on screen with zoom as they
do today; what changes is that their EDGES are no longer stair-stepped blocks.

## What is there today (verified)

- `IsoDioramaRenderer.resize()` fixes the virtual canvas at 480 px on the long
  edge; the display canvas is CSS-stretched (~2.4 screen px per virtual px).
- Zoom = `viewZoom` (1..4) + `viewPanX/Y` (screen px), a CSS transform only
  (`applyViewTransform`); wheel anchored at the cursor; pan clamped.
- Geometry flows from `habitableGeom(VW, VH)` built in `HabitableCutawayEngine.bake()`.
  Clicks map through `display.getBoundingClientRect()` (includes the CSS transform).
- `cutaway.bake()` creates a fresh weather sim; `resize()` calls `bakeAll()` ->
  `bake()`, so a resize already resets the weather today.
- A grid cell is ~1.4 x 0.7 virtual px at zoom 1 (rx ~88 at 480x270); the surface
  bake, occupancy and weather lookup sample the NEAREST cell — edges are
  cell-sized stair steps at any zoom.
- Placement is screen-lattice based: `buildCityDots`, `buildInhabitants`,
  `planSurfaceDecals`, `planVolcanoChimneys` sample a 2-3 px lattice, hash on px,
  and cap counts.
- `bake()` paints the crust while `occupancy` is still all zeros, then the surface.
- Ripples, embers, `drawOceanShimmer`, `drawDome` belong to the dead legacy
  Canvas path (`usesCutaway` is always true) — out of scope.

## Design

### 1. Camera

New pure module `src/rendering/ZoomCamera.ts`:

```ts
export interface Camera { zoom: number; fx: number; fy: number }   // focus in BASE virtual px
export function identityCamera(VW: number, VH: number): Camera;     // { zoom: 1, fx: VW/2, fy: VH/2 }
export function isIdentity(cam: Camera, VW: number, VH: number): boolean;
export function applyCamera(base: HabitableGeom, cam: Camera, VW: number, VH: number): HabitableGeom;
export function worldToScreen(cam, VW, VH, x, y): { x: number; y: number };   // x' = (x - fx) * zoom + VW/2
export function screenToWorld(cam, VW, VH, x, y): { x: number; y: number };
export function cameraFromView(zoom, panX, panY, rect, VW, VH): Camera;       // snapped: fx, fy to 1/zoom px
export function farScale(zoom: number): number;                               // 1 + 0.1 * (zoom - 1)
```

`applyCamera` scales `R, rx, ry, wall, T` by zoom and maps `cx, cyTop, cyBody`
through `worldToScreen`. Identity camera returns the base geometry unchanged. The
focus is snapped so geometry centres land on whole virtual pixels (layoutAt
rounds).

### 2. What scales and what stays one pixel (k = camera zoom)

- **World (x k):** relief — `liftOf`'s terrace heights (3/6/9/13/18) and `maxLift`
  (also used by the weather lookup's ground lift, chimney heights, and the
  surface/crust bounding boxes); crust wall, keel depth, crust feature sizes
  (ridge amplitude, water band minimum, ledge quantum, lip rows); atmosphere fade
  (`chan.thicknessPx * k`, but the wobble seed keeps the unscaled value;
  `localFade` floor 3 and `ozoneFadeMax`'s +2 scale); cloud lift; moon orbit
  radius and size; tile-marker size cap; effect reach, mote offsets and speeds.
- **Sprite (x round(k), nearest-neighbour):** settlements, creatures, decals.
- **Stroke (1 px):** outline and 1-px edge lines, dither, water glints and foam
  dots, rain streak width and length, lightning width, orbit-arc dots, star
  points, flare lines, gas-ring stroke width (ring SPACING scales, count does not
  — rings are drawn per base-space ring, at most as many strokes as at k = 1).
- **World-anchored texture:** every noise frequency or distance expressed per px
  converts (`value / k` for frequencies-per-px, `value * k` for px distances):
  water `SWELL_K`, `FOAM_REACH`, `SWELL_DISP_PX`, `CAUSTIC_FADE`, `cellScale`,
  grain/blob frequencies, depth ramp; crust ridge/strata/keel jag frequencies;
  surface grain. Hashes keyed on screen px or on clamped column indices are
  re-keyed on world coordinates (`screenToWorld` then floor at base resolution),
  so panning does not shift them. Thresholds that define 1-px lines (water
  `WEB_GLINT`, halo, the coast outline band, the rim foam ring) divide by k so
  lines stay 1 px.
- **Screen-space (unchanged):** the vignette (fixed to the canvas), UI overlays'
  text and chrome.
- **Far (x farScale(k) around the focus):** backdrop and sky. `skyLayout` is
  computed from the BASE geometry and then transformed by farScale; the backdrop
  panorama is re-baked at the far scale on settle (1-px stars stay 1 px), not
  drawImage-scaled.

The plan's first task writes the full row-by-row inventory to
`docs/superpowers/specs/2026-09-30-zoom-camera-inventory.md` (every constant in
IsoDioramaRenderer, HabitableCutawayEngine, SurfaceDecals, WeatherPainter,
SkyPainter, Backdrop, with its class above); later tasks work through its rows.

### 3. Stable placement

Anything placed by sampling (city dots, inhabitants and settlements, decals,
volcano chimneys) is planned ONCE per planet bake at the identity camera and
stored in base-world coordinates (plus the grid cell it stands on). Drawing and
stamping map through the camera (`worldToScreen`, sizes x k or x round(k)). A
camera change never re-plans, so nothing appears, vanishes or moves when zooming.
Divine effects store their centre, reach, mote offsets and velocities in world
units at cast time.

### 4. Sub-cell elevation

The surface bake, the occupancy (land/water) test, relief and the weather
lookup's ground lift sample elevation at the pixel's FRACTIONAL grid position
(bilinear over the 4 surrounding cells of the existing smoothed elevation)
instead of the nearest cell. At zoom 1 a cell is ~1.4 x 0.7 px, so this is
invisible there (check 1 accepts it as a declared, measured change — see checks);
at zoom 4 coastlines and terrace edges become smooth pixel curves. Biome colour
and decal/settlement placement stay per cell. `discToGrid` gains a fractional
variant; the nearest-cell one stays for picking.

### 5. Progressive re-render

- The engine keeps two layer sets: **identity** (baked by `bake()` as today) and
  **camera** (baked for the rendered camera; absent at zoom 1).
- **During a gesture** the frame draws the identity layers with today's full CSS
  transform (exactly today's look — no blank areas). Nothing re-bakes.
- **Settle**: 150 ms after the last wheel/pointer event, if the target camera is
  not identity: re-bake the camera layers, switch the frame to them, and set the
  CSS transform to identity — in one frame. A world point's screen position moves
  by at most 0.5 virtual px across the settle. Back at zoom 1: drop the camera
  layers, identity path.
- **Camera re-bake** (`cutaway.setCamera(cam)`), distinct from `bake()`:
  zero occupancy, then crust, then surface (same order and inputs as `bake()`),
  then shore distance, pick buffer, stamp the stored decals and chimneys; update
  `surfaceBakeOpts` to the camera geometry; build a NEW weather painter (lookup
  for the camera geometry, cloud lift x k; it re-primes); KEEP the weather sim,
  `elapsed`, day angle, orbit clock, selections.
- **Throttled surface rebake** (every 4 s) paints both layer sets from their own
  stored options; if a settle is pending in the same frame, the two merge into
  one re-bake.
- **Resize**: its own path — recompute the base geometry and identity layers,
  keep the camera (focus re-clamped), re-bake camera layers if not identity. The
  weather sim is kept (today's reset on resize is a side effect of `bake()`; the
  planet has not changed). **New planet** (`bake()` via refreshData): camera
  resets to identity, fresh sim as today.
- **Bounded to the view**: every bake and per-frame loop clamps to the canvas
  plus the relief margin (`y1 = VH - 1 + maxLift * k`, rows below the canvas
  whose peaks rise into view). The cliff fill uses a per-column near-to-far
  depth pass instead of O(lift) per pixel. `buildWeatherLut`, shore distance
  (baked with a margin of `FOAM_REACH * k` beyond the canvas so edge water gets
  correct distances), chimneys and decal stamping clamp likewise.
- Atmosphere haze uses the RENDERED camera zoom (`atmoHazeAmount(rendered.zoom)`).

## Checks

New `tools/zoomCheck.ts`; each claim against an independent fixture or rendered
pixels, with a control that must fail:

1. **Identity is today.** Golden hashes of every layer at zoom 1 (crust, surface,
   fluids, day/night, atmosphere, weather clouds, sky, backdrop) for 3 planet
   types, captured from the pre-change commit by the plan's first task and
   stored in the check. After the change: all identical EXCEPT the layers
   section 4 changes, whose differing-pixel share must be < 2% and confined to
   coast/terrace boundary pixels (measured). Control: a camera at zoom 1.001
   differs everywhere.
2. **Crisp, not magnified.** At zoom 4 with atmosphere intensity forced to 1:
   along the limb, the day/night terminator and the coastline, the mean length
   of straight horizontal/vertical runs (stair steps) is at most 2 px; counted
   only on pixels non-empty at zoom 1. Control: the zoom-1 render magnified 4x
   nearest-neighbour has runs >= 4 px.
3. **World sizes scale, strokes do not.** A peak's relief height scales by 4
   (+/- 1 px); crust depth by 4; cloud lift by 4; a rain streak stays 3 px; a
   water glint stays 1 px wide. Control: relief with unscaled `liftOf` fails.
4. **World-anchored texture.** Swell wavelength in world units equal at zoom 1
   and 4 (+/- 10%); a surface/crust hash sampled at a world point is identical
   after a pan. Control: unconverted `SWELL_K` gives a 4x shorter wavelength.
5. **Stable placement.** City dots, settlements, creatures, decals and chimneys:
   the set of world positions is identical at zoom 1, 2 and 4 and after a pan.
   Control: re-planning per camera changes the set.
6. **Geometry agrees.** 200 world points: the pick at zoom 2 and 4 (random focus)
   returns the same grid cell as zoom 1 (ignoring boundary pixels); weather
   lookup and overlays map through the same camera; the sky uses farScale.
7. **Camera change keeps state.** `setCamera` leaves the weather sim's fields,
   anomaly and clock and the renderer's `elapsed` untouched; `bake()` resets them
   (control); resize keeps them.
8. **Bounded work.** Per layer, pixels iterated at zoom 4 <= canvas area plus the
   relief margin; weather lookup entries <= canvas area. Control: an unclamped
   lookup at zoom 4 has ~16x the entries.
9. **Progressive gesture.** Headless input: no re-bake during a gesture; exactly
   one after the settle delay; CSS identity after settle; a world point moves at
   most 0.5 virtual px across the settle.

Existing suites stay green: `skyCheck`, `weatherCheck` (quick + full),
`habitableDioramaCheck`, `atmosphereCheck`, `surfaceDecalCheck` (64% clump
baseline unchanged), `smokeTest` (49/3), tsc at 2.

Live preview before done: zoom 1 indistinguishable from today; zoom 2 and 4 on
ocean, storm, lava, gas — smooth coasts and terraces, crisp water, clouds, sky;
nothing appears or moves on zoom; no jump at settle; no blank areas while
gesturing; clicks select the right tile; frame time at zoom 4 within budget.

## Edge cases

- Zoom back to 1: identity layers, identical to today (plus section 4's declared
  sub-pixel change).
- Settle and the 4 s rebake in the same frame: one merged re-bake.
- Resize mid-gesture: the gesture continues on the new identity layers; settle
  re-bakes the camera layers at the new size.
- Portrait layouts, gas giant home: same rules; the gas giant has no weather.
- Tab refocus: camera is independent of time.

## Review findings folded in (Fable, 2026-09-30)

Blocking: re-planned placement would reshuffle the world (section 3); CSS delta
exposed blank canvas (section 5, identity layers during gestures); vignette
inverts (screen-space); sky layout contradiction (farScale after base layout,
backdrop re-bake); stale `surfaceBakeOpts` and crust/occupancy order (section 5);
resize vs bake conflict (own path). Should-fix: missed constants (section 2);
unclamped loops and the O(lift) cliff fill (section 5); grid cells defeat "crisp
coasts" (section 4, sub-cell elevation); checks rebuilt (goldens from the
pre-change commit, stair-step metric, iteration counts instead of timings,
0.5 virtual px settle tolerance). Nits: legacy-path items dropped; haze uses the
rendered zoom; new painter instead of swapping its lookup; ring strokes bounded.
