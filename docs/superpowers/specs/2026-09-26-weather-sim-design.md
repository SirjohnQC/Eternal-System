# Weather sim — design

Date: 2026-09-26. Sub-project 2 of 2 of the atmosphere + weather rework.
Sub-project 1 is `2026-09-25-atmosphere-pass-design.md` and is built first:
the weather composites inside the dome and fades with the same haze term.

## Intent

Decided with Sirjohn, 2026-09-25/26:

- **Purpose: read the world.** Weather is a readout of true state, visible at
  a glance — cloud where there is moisture, rain shadows behind mountains, snow
  at the poles, smog over cities, ash over volcanoes, storms that grow as the
  biosphere comes under stress. Realism serves legibility.
- **Full sim, visual only.** Driven by grid, biosphere and civ state; feeds
  nothing back into the simulation. Smoke test and balance untouched.
- **Model: a coarse sim on the planet grid, projected to the disc** (chosen
  over a visible-disc-only sim and over stateless masks x noise).
- **Look: a density-field layer** (chosen over sprites and a hybrid) — one
  pixel-art cloud layer plus a cloud-shadow layer, not individual sprites.
- **Every world has its own weather personality**, derived from its
  `genomeSeed`, the same each time it is visited.

Success: on every non-gas type the weather reads as that world's weather in a
still frame, the patterns come from the physics (proved by ablation), the
terrain stays readable, and the frame cost is within budget with no per-frame
allocation.

## What exists today (and goes)

- The only live weather is 5-8 `makeWispSprite` streaks in
  `HabitableCutawayEngine`, drifting horizontally, differing by tint only;
  kinds are picked by weighted dice from `cloudMixFor`, with no location.
- The legacy cloud path in `IsoDioramaRenderer` — `buildClouds`, `drawClouds`,
  `makeCloudSprite`, precipitation, lightning — is dead: `buildClouds` returns
  early because `usesCutaway` is always true. `weatherSummary` has no callers.

All of it is **deleted**, not left dormant: `buildClouds`, `drawClouds`,
`makeCloudSprite`, `CLOUD_PROFILES` (as code), `weatherSummary`,
`makeWispSprite`, `rebuildWisps`, `drawWisps`, `WISP_COLOURS`, `wispScratch`,
and `airMask` + `bakeAirMask` if nothing else reads them after the atmosphere
pass. `cloudMixFor`'s per-type knowledge moves into the climate sources. The
good legacy data carries over as data: kind palettes (body/under), the four
`PRECIP_STYLE`s, and the lightning rates.

## Prototype findings (2026-09-26)

A throwaway prototype of this design ran over the real diorama preview (real
grid, projection and sun). It is not kept. What it established:

1. **The canvas is ~480 virtual px wide**, scaled with pixelated rendering —
   not 1200x800. The face is ~30k pixels. Paint at native virtual pixels.
2. **Condensation alone gives uniform grey.** With only temperature-driven
   capacity, cloud settled at ~0.30 on every latitude. A vertical-motion term
   (Hadley/Ferrel cells + travelling mid-latitude waves) produced real
   structure: cells ranged 0.00-0.68.
3. **The field needs advected low-frequency detail.** 64x32 over the planet is
   ~7 px per cell on the disc: bilinear alone is soft blobs; high-frequency
   detail reads as TV static. Low-frequency noise (~1-4 features per cell)
   advected with the band wind reads as cloud. Its stretch along longitude
   must stay modest — at 0.9 vs 1.6 the far-rim bands read as smears.
4. **Emitters must be point-like.** Smog weighted by civ *territory* blanketed
   the planet (the preview marks 40k of 65k cells as civ); ash with a
   planet-wide floor on lava hid the whole face.
5. **Solid bodies, narrow dither.** Full-range Bayer dither across four levels
   reads as static; solid levels with a dither band only at each step edge
   read as pixel-art cloud.
6. **Cost.** Existing frame 4.2 ms median; the prototype's painter added
   3.2 ms (+76%) and allocated ~100k small arrays per frame (GC hitching); a
   sim step cost 0.3 ms. The painter, not the sim, is the budget problem.
7. **Storm legibility.** Rain and lightning were too small and brief to read
   in a still frame; a storm world must read as a storm without waiting.

## Architecture

Four units. The first three are pure TypeScript (no DOM), so every metric runs
headless in `tools/`.

| unit | file | job |
|---|---|---|
| Climate sources | `src/rendering/weather/WeatherClimate.ts` | Collapse the 256x256 grid, biosphere, civ level, planet type and genome seed into per-cell source maps on the 64x32 field: ocean fraction, temperature, elevation, land moisture, ash emitters, smog emitters, storm pressure, and the planet's weather personality. |
| Sim | `src/rendering/weather/WeatherSim.ts` | Hold channels `vapour`, `cloud`, `ash`, `smog` plus derived `precip` and `convection`; step at a fixed 0.25 s. Seeded, deterministic, resettable. |
| Painter | `src/rendering/weather/paintWeather.ts` | Draw the sim through a projection lookup into an `ImageData`: cloud layer, precipitation, lightning; write cloud shadows into the day/night image. |
| Host glue | `HabitableCutawayEngine`, `IsoDioramaRenderer` | Engine bakes the lookup alongside the pick buffer and calls the painter per frame; host builds climate sources when the grid changes. |

**Flow.** Grid change (existing throttled surface rebake) → rebuild climate
sources. The sim steps at 4 Hz from real elapsed time; each frame paints with
channels interpolated between the last two states. Painting uses a typed-array
lookup (field index + bilinear weights + terrain-top y per face pixel), a
detail-noise texture pre-baked once per planet, and preallocated buffers:
**zero allocations per frame**.

**Lifecycle.** Seeded from `genomeSeed` (falling back to `planetSeed`). Fully
reset when the planet changes. Warmed up ~200 steps at bake so the sky never
starts empty. Never saved. The lookup is rebuilt whenever the projection
changes — at bake today, and on every focus change once the planned
spin-the-planet control exists.

**Gas giants excluded** — their bands are their weather (gas-giant spec).

## Physics

Field 64x32 in longitude x latitude over the whole planet; longitude wraps,
latitude clamps.

**Wind.** Easterly trades below 30 deg, westerlies 30-60, weak polar
easterlies above; a small equatorward drift in the tropics. A feature crosses
the visible disc in ~60-90 s. A slow perturbation bends the bands.
Semi-Lagrangian advection (backtrace + bilinear) — unconditionally stable.

**Vertical motion** (finding 2). Rising air at the equator and ~60 deg, sinking
at ~30 deg and the poles (`cos(6·lat)`-shaped), plus travelling mid-latitude
waves (fronts/cyclones) and a weak cross-wave term. Rising air lowers vapour
capacity; sinking air raises it and clears cloud.

**Water cycle.**
- Evaporation: ocean fraction x temperature, plus a smaller land-moisture x
  biosphere-lushness term.
- Capacity rises with temperature and falls with uplift — vertical motion,
  orographic lift (wind blowing up the elevation gradient), and convection
  (heat x moisture, scaled up by storm pressure).
- Above capacity, vapour condenses to cloud; below, cloud evaporates back.
- Dense cloud precipitates and loses water — air that crossed a range arrives
  dry, so rain shadows emerge. Below a cold threshold precipitation is snow.

**Particulates** (finding 4).
- `ash`: emitted at volcanic-biome cells and at the lava world's volcano
  chimney sites (`planVolcanoChimneys`), never as a planet-wide floor. Drifts,
  settles as ashfall, triggers volcanic lightning when dense.
- `smog`: emitted by settlement *density* — civ-cell fraction squared within
  the coarse cell, so dense cores emit and territory edges barely do — only at
  civ level ≥ 4, scaled by level. Drifts, decays slowly, washed out by rain.

**Storms.** Dense cloud with strong convection. Biosphere extinction pressure
scales convection; the `storm` type starts high.

**Planet-wide tints.** Acid (toxic worlds, or oxygen < 0.42 — today's rule):
yellow-green cloud, acid rain. Nebula glow on cloud tops for `inNebula` worlds;
a faint version on crystal. Carbon: weak soot emitters everywhere, well below
the level that hides the face.

**Kinds fall out of channels.** Ash-dominant → ash plume; smog-dominant → smog;
dense convective cloud → storm (rain + lightning); cold cloud → ice haze
(snow); else cumulus. No weighted dice.

**Per-world personality** (from `genomeSeed`): band strengths and phases,
number (4-7) and speed of mid-latitude waves, detail-noise offset, anomaly
schedule. Same seed → same weather; different seeds on the same grid →
different weather.

**Rare anomalies** (Sirjohn's "occasional glitches in the matrix"): a seeded,
rate-limited event every ~5-10 min — a rogue supercell, a briefly reversed
band, or a sudden clear hole.

## Rendering

- **Lookup**, baked with the pick buffer: per face pixel, the field position
  from `discToGrid` and the terrain-top y from `liftOf`. The host's projection
  callbacks remain the only projection code.
- **Cloud layer** (own `ImageData`, `putImageData` only). Four steps — clear,
  thin, mid, dense — as solid fills with a Bayer dither band only at each step
  edge (finding 5). Colour from the kind palettes; body vs underside chosen by
  the density gradient toward the sun. Drawn lifted above the tallest terrain
  (`maxLift` + a few px), so clouds float and rise into the dome at the far
  rim. Brightness follows the same sun term as `paintDayNight`. Fades with
  `atmoHazeAmount(viewZoom)`.
- **Cloud shadows** written into the image `paintDayNight` already fills:
  density sampled one cloud-lift toward the sun, darkened toward blue-black,
  day side only.
- **Precipitation**: a preallocated pool (~300). Spawned per step at blocks
  above a rain-rate threshold, at cloud altitude; falls straight down and dies
  at that pixel's terrain-top y — rain always lands under its cloud. Styles
  from `PRECIP_STYLE`. Storm rain is dense and long enough to read in a still
  frame (finding 7).
- **Lightning**: storm and dense-ash blocks, carried-over rates; ~90 ms flash —
  cloud brightens, a 1-px jagged bolt to the terrain top, a small ground flash.
  Frequent enough on a storm world that one is usually visible within a few
  seconds.
- **Composite order** — one interface change: the host's `drawOverlays` splits
  so UI is never under weather:
  1. crust, land, fluids, day/night (+ cloud shadows)
  2. `drawSurfaceOverlays` — city lights, inhabitants
  3. cloud layer (precipitation, cloud, lightning)
  4. atmosphere
  5. `drawUiOverlays` — tile markers, divine effects
  6. rings (gas), near moons, vignette

## Measurement

`tools/weatherCheck.ts`, headless on the pure units. Controls are **ablations**
(the same sim with the term under test switched off — the metric must fail)
and a **null model** (masks x scrolling noise — the "read the world" metrics
must fail on it). Each control is run and shown failing before the physics it
guards is written.

| claim | metric | control that must fail |
|---|---|---|
| rain shadows | synthetic grid, ocean upwind of a ridge across the westerlies: mean precip 6 cells upwind / 6 downwind ≥ 2; real grids, 12 seeds, median ≥ 1.5 | uplift ablated; null model |
| wet vs dry | median cloud cover over 12 seeds per type ordered storm ≥ ocean > rocky > desert | today's wisps (count 5-8 regardless of type); null model |
| poles snow | ocean worlds: snow share of precip above 60 deg ≥ 5x below 30 deg | cold threshold ablated |
| smog where cities are | smog over settlement-dense cells + 3 cells downwind ≥ 3x far cells; zero below civ 4 | uniform/territory emitters; today's global pick |
| ash where volcanoes are | same shape, around volcanic cells and chimney sites | uniform emitters |
| storms follow stress | same seed: storm-cell fraction at pressure 0.8 ≥ 2x at 0 | stress term ablated |
| structure, not uniform grey | per-latitude-band cloud range (max - min) ≥ 0.3 in the majority of bands | vertical motion ablated (prototype: uniform ~0.30) |
| terrain stays readable | per type, 12 seeds: share of face pixels at the mid or dense step ≤ 55% median and ≤ 70% on every seed; ocean ≥ 10% so the sky is not empty | planet-wide ash floor on lava (prototype) |
| storm reads in a still | storm type steady state: ≥ 40 live rain particles in any sampled frame, and ≥ 1 lightning flash per 5 s on average | storm with ocean-world convection |
| moves with the wind | displacement peak between t and t+10 s points the band's way, per band | zero wind |
| per-world personality | same grid, two seeds: field correlation after warm-up < 0.5; same seed twice: identical | seed ignored |
| stable over hours | 20k steps, 10 types x 6 seeds: no NaN, channels in range, cover 2-75% after warm-up, not frozen (60 s correlation < 0.95) | invariant |
| rare anomalies | 12-24 per 2 simulated hours per seed; deterministic | invariant |
| no state leaks | bake A, run, bake B == fresh bake B | invariant (the repo's recurring leak) |
| rain lands on the ground | every particle dies at its pixel's terrain-top y | invariant |
| painter stays in bounds | no pixel outside the face + cloud-lift band | invariant |

**Budget** (finding 6), measured in the preview at the real ~480 px canvas,
same method as the prototype's numbers:

- painter ≤ **1.0 ms** median per frame; sim step ≤ **0.5 ms**;
- **no per-frame allocation**: headless, heap growth over 1,000 painted frames
  with no GC in between < 64 KB (run under `node --expose-gc`, `gc()` before);
- `habitableDioramaCheck` keeps no-readback and `putImageData`-only green;
  `atmosphereCheck` and the smoke test unchanged.

**Pixels.** Preview, two seeds each: ocean, rocky, ice, lava, desert, storm,
toxic, carbon, crystal. A mountainous seed must show a rain shadow; with civ on,
smog sits over the cities; a storm world reads as a storm in one screenshot.
Tuning is done against the picture; the metrics guard it.

## Out of scope

- Feeding weather back into the simulation.
- Gas-giant weather.
- The drag controls (spin the planet / pan the view) — their own spec; this
  one only requires the lookup to be rebuildable on a projection change.

## Amendments (2026-09-26, measured while planning)

These override the sections above where they conflict. Details and numbers are
in `docs/superpowers/plans/2026-09-26-weather-sim.md`.

1. **Planet type enters through an explicit per-type climate table.** The
   grid's `temperature` and `moisture` do not depend on type (identical means on
   ocean, ice, lava and desert for one seed); type shows only in
   `classifyBiome`. "Types show up mostly through the grid's own maps" was wrong.
2. **Ash emitters are vents** — volcanic cells at elevation >= 0.70 on a 3x3
   local peak, hash-thinned — because 65% of a lava world is `volcanic` biome.
   Chimney screen sites are not an input.
3. **Rain-shadow metric is relative** to a flat twin grid (synthetic) and to
   the uplift-ablated run (real grids): lee cells are farther from the coast and
   drier even without a ridge.
4. **Wet-vs-dry is controlled by today's wisps only**; the null model shares the
   ordering it would be tested on.
5. **Structure metric is the spread of latitude-band means (>= 0.15).**
