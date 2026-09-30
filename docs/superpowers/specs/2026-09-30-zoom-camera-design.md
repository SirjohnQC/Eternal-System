# Zoom Camera — crisp pixel art at every zoom (zoom-detail sub-project 1 of 6)

Date: 2026-09-30. Branch to create: `feat/zoom-camera` from `feat/surface-decals`
(which carries the merged weather sim and orbit sky).

## Intent

Sirjohn: "detailed world when we zoom in, currently it just looks like well heavy
pixel". His choices:

- **Crisp pixel art at every zoom** — pixels stay the same size on screen; zooming
  in shows more pixels, never bigger ones.
- All four layer families should eventually gain detail (terrain, vegetation and
  props, settlements and creatures, water and weather). Split into six
  sub-projects, in this order: **1. zoom camera (this spec)**, 2. terrain surface
  detail, 3. vegetation and props, 4. settlements and creatures, 5. water and
  weather detail, 6. full seasons (ice caps and vegetation through the year).
- **Progressive zoom** — during a wheel/drag gesture the view keeps today's
  instant CSS scaling; ~150 ms after the gesture stops the view re-renders at full
  resolution and snaps sharp.
- He approved the architecture (section 1) and the scale/stroke rule (section 2),
  and delegated the rest: "let's try this, show me when it's ready".

**What this sub-project does and does not deliver** (stated to Sirjohn): every
per-pixel layer becomes crisp at zoom — coast and terrace edges, relief,
water, atmosphere, day/night, clouds, rain, shadows, sky, dome. Terrain grid cells
(the 256x256 planet grid) stay the same size on screen — finer terrain is
sub-project 2. Hand-made sprites (creatures, settlements, decals) are drawn at an
integer multiple of their size and stay blocky until sub-projects 3-4.

## What is there today (verified)

- `IsoDioramaRenderer.resize()` fixes the virtual canvas at 480 px on the long
  edge; the display canvas is CSS-stretched to the mount (~2.4 screen px per
  virtual px).
- Zoom is `viewZoom` (1..4) plus `viewPanX/Y` (screen px), applied only as a CSS
  transform on the display canvas (`applyViewTransform`), with the wheel
  anchored at the cursor and pan clamped so the view never leaves the scene.
  At 4x a virtual pixel is ~10 screen px.
- All geometry flows from `habitableGeom(VW, VH)` built in
  `HabitableCutawayEngine.bake()`; the renderer's `cx/cy/rx/ry/bodyCy` getters,
  the weather lookup (`buildWeatherLut`), `skyLayout`, overlays and the pick
  buffer derive from it. `discToGrid` works in normalised disc coordinates.
- Clicks map through `display.getBoundingClientRect()`, which includes the CSS
  transform, so picking is already correct under a CSS zoom.
- `cutaway.bake()` deliberately creates a FRESH weather sim (no sky may leak
  between planets). A camera change must not go through it.
- Pixel positions are cached at build time for city lights (`buildCityDots`),
  inhabitants and settlements (`buildInhabitants`), ripples (`buildRipples`),
  embers, and divine effects (stored as x/y px when cast).
- Many constants are in screen pixels: `maxLift` (18) and `liftOf` terraces,
  water `SWELL_K` (radians per px of shore distance), `FOAM_REACH` (px),
  `SWELL_DISP_PX`, `CAUSTIC_FADE`, cloud lift (`maxLift + 6`), rain speeds and
  lengths (`P_SPEED`, `P_LEN`), sun disc (5 px), sky track size, moon orbit
  radii, sprite sizes.

## Design

### 1. Camera

New pure module `src/rendering/ZoomCamera.ts` (no DOM):

```ts
export interface Camera { zoom: number; fx: number; fy: number }  // focus in BASE virtual px
export const IDENTITY_CAMERA: Camera;                              // { zoom: 1, fx: VW/2, fy: VH/2 } per size
export function applyCamera(base: HabitableGeom, cam: Camera, VW: number, VH: number): HabitableGeom;
export function worldToScreen(cam: Camera, VW: number, VH: number, x: number, y: number): { x: number; y: number };
export function screenToWorld(cam: Camera, VW: number, VH: number, x: number, y: number): { x: number; y: number };
export function cameraFromView(zoom: number, panX: number, panY: number, rect: { width: number; height: number }, VW: number, VH: number): Camera;
export function farScale(zoom: number): number;                    // 1 + FAR_PARALLAX * (zoom - 1), FAR_PARALLAX = 0.1
```

- `applyCamera` scales every length in the geometry (`R, rx, ry, wall, T`) by
  `zoom` and maps the centres (`cx, cyTop, cyBody`) through `worldToScreen`:
  `x' = (x - fx) * zoom + VW / 2`. At `zoom = 1`, focus at the canvas centre, it
  returns the base geometry unchanged (identity).
- The canvas stays 480 px on the long edge; at zoom z the view shows 1/z of the
  scene at z times the detail, so per-frame work stays roughly constant.
- `cameraFromView` converts today's gesture state (`viewZoom`, `viewPanX/Y` in
  screen px, the mount rect) into a camera, so the existing wheel/drag code and
  pan clamping stay as they are.

### 2. What scales and what stays one pixel

Let `k = camera.zoom`.

- **World sizes scale by k** — things with a physical size in the scene: relief
  (`maxLift`, `liftOf` terrace heights), crust wall and keel, atmosphere shell
  thickness, cloud lift and cloud-shadow offset, moon orbit radii and moon size,
  sprite sizes, ripple and ember positions/sizes, rain FALL distance (speeds in
  px/s scale; they are world distances per second).
- **Sprites** (settlements, creatures, decals, moon craters) scale by the integer
  `round(k)` (nearest-neighbour), so they stay pixel-exact.
- **Pixel strokes stay 1 px** — outlines, terrace edge lines, dither patterns,
  water shimmer dashes and foam dots, rain streak width and LENGTH in px
  (a 3-px streak stays a 3-px streak), lightning bolt width, orbit-arc dots, star
  points, flare line width.
- **Per-pixel effects resample** automatically (atmosphere, day/night, cloud
  layer, water colour, sun glow, crust strata).
- **Texture frequencies are world-anchored.** Any noise or distance constant
  expressed "per px" (water `SWELL_K`, `FOAM_REACH`, `SWELL_DISP_PX`,
  `CAUSTIC_FADE`, crust strata spacing, shore-distance thresholds) is converted
  so it reads the same at every zoom: distances divide by k before use (or the
  constant multiplies by k). Otherwise waves and strata would shrink as you zoom.
- **Far layers** — the backdrop panorama and the sky (track, sun, siblings,
  arc) are far away: they scale by `farScale(k)` around the focus (a mild
  parallax), not by k. The dome and atmosphere are part of the body and scale by k.

An inventory of every fixed-pixel constant in `IsoDioramaRenderer`,
`HabitableCutawayEngine`, `SurfaceDecals`, `WeatherPainter` and `SkyPainter`,
each marked *world (k)*, *sprite (round k)*, *stroke (1 px)*, *per-pixel*, or
*far (farScale)*, is written as the plan's first task and committed to
`docs/superpowers/specs/2026-09-30-zoom-camera-inventory.md`; every later task
works through its rows.

### 3. Progressive re-render

- The renderer tracks two cameras: **rendered** (what the canvas currently
  shows) and **target** (from the live gesture state).
- **During a gesture** the display's CSS transform expresses only the DELTA from
  the rendered camera to the target (so a sharp zoom-2 render being zoomed to 3
  is CSS-scaled by 1.5, not by 3). Nothing re-bakes.
- **Settle**: 150 ms after the last wheel/pointer event (debounced), if the target
  differs from the rendered camera: set rendered = target, re-bake the
  camera-dependent layers, and reset the CSS transform to identity in the same
  frame. A world point's screen position before and after the settle differs by
  at most 1 screen px (no visible jump, only sharpening).
- **Camera re-bake** (`cutaway.setCamera(cam)` and a renderer
  `rebakeForCamera()`), distinct from `bake()`:
  - re-bakes crust, surface, occupancy, shore distance and pick buffer for the
    new geometry;
  - rebuilds the weather painter's lookup and clears its screen-space particles,
    but KEEPS the weather sim (clouds, showers, seasons, clock) — no sky reset;
  - keeps `elapsed`, the day angle, the orbit clock, selections;
  - rebuilds the renderer's cached pixel positions (city dots, inhabitants,
    ripples, embers); divine effects are stored in world (base virtual)
    coordinates and mapped through the camera each frame instead of cached px.
- **Bounded to the view**: every bake and per-frame loop clamps its bounding box
  to the canvas (at 4x the disc is 4x the canvas). `buildWeatherLut` and the
  surface/crust bakes must not iterate off-screen pixels.
- **Resize** re-bakes as today and keeps the camera (focus re-clamped).
- **New planet** (`bake()`): camera resets to identity.
- Zoom range 1..4 and pan limits unchanged. Atmosphere haze keeps thinning with
  zoom (`atmoHazeAmount(rendered.zoom)`).

## Checks

New `tools/zoomCheck.ts`, every claim against an independent fixture or rendered
pixels, with a control that must fail:

1. **Identity at zoom 1.** Every layer image (crust, surface, fluids, day/night,
   atmosphere, weather clouds, sky) rendered with the identity camera is
   bit-identical to the pre-change render. Control: a camera with zoom 1.001
   differs.
2. **Crisp, not magnified.** At zoom 4, for the per-pixel layers (atmosphere,
   day/night, fluids, clouds, crust strata), the share of 4x4-aligned pixel blocks
   that are uniform is below 60%. Control: the zoom-1 render magnified 4x
   nearest-neighbour (what CSS zoom shows today) reads ~100% uniform blocks.
3. **World sizes scale, strokes do not.** At zoom 4 vs 1: a peak's rendered
   relief height scales by 4 (+/- 1 px); crust depth scales by 4; cloud lift
   scales by 4; rain streak length and terrace edge line width stay the same in
   px. Control: the unconverted constants (relief not scaled) fail.
4. **World-anchored texture.** The water-swell wavelength measured in world units
   is the same at zoom 1 and 4 (+/- 10%). Control: unconverted `SWELL_K`
   gives a 4x shorter wavelength.
5. **Geometry agrees.** For 200 sample world points, the pick buffer at zoom 2
   and 4 (with random focus) returns the same grid cell as zoom 1 at the
   corresponding point (ignoring cell-boundary pixels). Weather lookup, sky
   layout and overlay positions map through the same camera.
6. **Camera change keeps state.** `setCamera` leaves the weather sim's cloud field,
   anomaly, clock and the renderer's `elapsed` untouched; `bake()` still resets
   them (control).
7. **Bounded cost.** Headless: settle re-bake at zoom 4 costs at most 1.5x the
   zoom-1 re-bake; per-frame layer work at zoom 4 at most 1.2x zoom 1. Control:
   an unclamped weather lookup at zoom 4 builds ~16x the entries.
8. **Progressive gesture.** Driving the input handlers headlessly: no re-bake
   during a gesture; exactly one re-bake after the settle delay; CSS transform is
   identity after settle; a world point's screen position across the settle moves
   at most 1 screen px.
9. **Far layers.** Backdrop and sky scale by `farScale(k)`, not k.

Existing suites stay green: `skyCheck`, `weatherCheck` (quick + full),
`habitableDioramaCheck`, `atmosphereCheck`, `surfaceDecalCheck` (its 64% clump
baseline unchanged), `smokeTest` (49/3 baseline), tsc at 2.

Live preview, before calling it done: zoom 1 looks exactly as today; zoom 2 and 4
on ocean, storm, lava and gas — crisp edges, water, clouds, sky; no jump at
settle; pan and click still select the right tile; frame time at zoom 4 within
the zoom-1 budget.

## Edge cases

- Zoom back to 1: identity camera, bit-identical to today.
- Settle during an ongoing weather step or rebake: settle runs on the next frame
  boundary, never mid-frame.
- Tab refocus / huge dt: unchanged (camera is independent of time).
- Portrait layouts: same rules; focus clamped so the view never leaves the scene.
- Gas giant home: same camera; no weather.
- Divine effect cast before a zoom: stays on the same spot of the world after it.
