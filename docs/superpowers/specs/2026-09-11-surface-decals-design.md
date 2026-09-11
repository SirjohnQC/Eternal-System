# Surface Decals — Design

**Status:** design, not yet planned
**Prototype:** validated 2026-09-11 against the real engine (numbers below)

## The problem

The habitable diorama renders land as flat biome colour bands. It is readable
and it is dull, and — more importantly — it barely moves as the biosphere
evolves. A world with no life and a world with a full forest differ only by a
vegetation tint on the same bands, so the player's main feedback loop, *life
advancing on my world*, is nearly invisible at the exact moment they are
looking at their world.

Surface decals — trees, scrub, cacti, rocks stamped onto the surface — fix both
at once, provided placement is driven by simulation data rather than decoration.

## Goals

1. The surface reads as terrain rather than a choropleth map.
2. A glance tells the player how alive their world is. Dead is bare; microbial
   is bare; ground cover comes first; woodland comes later and only where the
   world can carry it.
3. Zero per-frame cost for the bulk of it. The renderer is already the
   bottleneck (`paintAtmosphere` alone runs ~1.4–1.6x what it did pre-rebuild).
4. Deterministic. The same world is the same forest across saves, re-bakes and
   sessions.

## Non-goals

- **Not a tile engine.** The surface stays procedural. Decals are stamped on
  top of it; they do not replace terrain rendering. (See the 2026-09-10 spike:
  sprite-sheet planets cost per-planet uniqueness, which is the thing worth
  keeping.)
- **Home world only, for now.** Detailed biosphere state exists for the
  player's world. Colonised and probed planets are the intended next step and
  the data source is designed to be swappable, but no second source is built
  here.
- **No new interaction.** Decals do not become entities, do not get their own
  hit-testing, and do not change what a click selects.
- **No decal art authored in this phase beyond a first working set.** The
  pipeline and the rules are the deliverable; art volume grows afterwards.

## Architecture

A new module, `src/rendering/SurfaceDecals.ts`. Not more code in
`HabitableCutawayEngine.ts`, which is already ~1900 lines carrying terrain,
crust, atmosphere, fluids and the engine class. Decals are separable and get
their own file.

### `planSurfaceDecals(opts, bio, budget) → DecalSite[]`

Pure. No canvas, no DOM, no time. Takes the existing `CutawayBakeOpts` plus the
biosphere, returns `{ x, y, kind, scale, row, col }[]` sorted back-to-front by
`y`. Mirrors `planVolcanoChimneys`, which is the established pattern for
deterministic prop placement in this engine.

Seeded from `planet.genomeSeed` — not from `planet.type`, which terraforming
mutates, and not from the bake seed, which is per-render.

### `stampDecals(imageData, sites, atlas)`

Runs at the end of the surface bake, after terrain has stamped `occupancy` and
`pick`. Writes into the same `ImageData` the surface painter already builds, so
there is no extra canvas and no extra composite. Skips any site whose footprint
pixel is unpainted or marked as live-fluid occupancy, so decals cannot land in
water the fluid layer will animate over, and cannot overhang the coastline.

### `animatedDecals(sites, focus, cap) → DecalSite[]`

Selects at most `cap` sites nearest the camera focus for the live layer to draw
with a sway. **`cap` is a count, not a fraction**, so cost is bounded no matter
how lush the world becomes. Suggested starting cap: 32.

### Re-bake

Uses the existing `rebakeSurface()`, already wired to biosphere changes at
`IsoDioramaRenderer.ts:1119`. The only addition is a threshold on the caller:
re-bake when `lush` moves more than 0.05 or `biodiversity` crosses an integer.
Without it, a per-tick biosphere nudge would re-bake the world continuously.

## Placement rules

Driven by fields that already exist on `GridCell`: `biome`, `elevation`,
`fertility` ("how well life can grow here, 0 in water/volcanic"), and
`lifeDensity` ("current life coverage, updated by EvolutionEngine"), combined
with the planet-wide `lush` already computed at `IsoDioramaRenderer.ts:1109`.

**Carrying capacity.** `life = lifeDensity * 0.55 + fertility * lush * 0.85`,
and a cell below ~0.12 gets nothing. This is what makes the surface a readout:
a world with no life has no decals regardless of how fertile its rock is.

**Kind** comes from `biome` first: forest and jungle get canopy, tundra gets
scrub with occasional conifer, desert gets cacti and rock and only where
`fertility` clears a bar, mountain gets rock and alpine scrub, plains and
grassland stay mostly open with trees only where `life` is high. Volcanic,
snow and beach get nothing.

**Woody growth is gated on `life`.** Below ~0.30 a site that would have been a
tree becomes scrub. This produces the correct evolutionary read for free:
ground cover spreads first, woodland follows. It was not scripted — it fell out
of the rule, and the prototype's counts confirm it (mid: 179 scrub, 3 trees;
lush: 159 scrub, 319 trees).

**Clumping needs two noise fields, not one.** Woodland clumps at ~50px, ground
cover in broader ~88px swathes. The prototype originally shared one field and
scrub carpeted wherever trees thinned — the opposite of how it should read.
Each gets its own value-noise field and its own threshold.

**The snow line must mirror the painter, not the biome.** `paintCutawaySurface`
re-classifies `mountain` cells above `elevation > 0.82` as snow *locally*,
without touching `cell.biome`. A planner reading `cell.biome` alone therefore
puts scrub on the white cap. Decals stop at `elevation > 0.78`. **If that
constant changes in the painter, this one must change with it** — the two are
coupled and the coupling is invisible.

**Spacing uses a bucket grid, not pairwise rejection.** `planVolcanoChimneys`
rejects with `sites.some(...)`, O(n²) — fine for a dozen cones, quadratic for
several hundred decals. Bucket on `(x / BUCKET | 0, y / BUCKET | 0)` in a Set.

**The budget is a target count, not a per-cell probability.** Candidates are
scored, sorted, and taken until the budget is met. A probability per cell makes
density swing with grid resolution and viewport size; a count does not.

## Decal art

Bespoke, authored against the game's own look rather than sliced from the AI
reference sheet — the sheet is painterly and anti-aliased, and stamping it onto
the procedural surface risks a visible style seam.

**Colour is derived at stamp time, not authored.** Each decal samples the
terrain pixel beneath it and shades relative to it (canopy lit / canopy shadow /
trunk as multipliers plus small offsets). This is the single most valuable thing
the prototype found: it removes the style seam by construction, and it means one
authored shape works on every planet type and under any terrain tint without
re-authoring. Decal art therefore stores **shape and shading mask**, not colour.

**Format** follows the existing convention (`public/assets/ships/ships.json`):
one atlas PNG plus a JSON manifest of named entries with frame rects. Assets
live in `assets/pixel/decals/` and are mirrored to `public/assets/pixel/decals/`
by the existing slice tooling.

**First set** (enough to cover the rules above): conifer, broadleaf, scrub,
cactus, rock. Two or three silhouette variants each so a grove is not a stamp
repeated. Sized 8–16px tall at `rx = 262`.

## Measurement

This codebase has repeatedly shipped green metrics that measured the wrong
dimension. Every assertion below is paired with a control that must pass on the
*pre-decal* build, and the metrics are written first.

`tools/surfaceDecalCheck.ts`, over the real engine and a real `PlanetGrid`:

1. **Readout is monotonic.** Site count at `lush` 0.04 / 0.45 / 0.92 must be
   strictly increasing, and the dead case must be exactly 0. Control: with
   placement forced to ignore `life`, the counts flatten.
2. **Ground cover precedes woodland.** Woody fraction at mid must be below
   0.15 and at lush above 0.50. This is the evolutionary read, and it is the
   assertion most likely to break silently when constants move.
3. **Clumping, not scatter.** Nearest-neighbour distance distribution must have
   a coefficient of variation above a threshold — an even scatter has a low one.
   *This is the metric to write first and prove against a deliberately even
   placement*, because "it looks clumped" is exactly the kind of claim that has
   passed on the wrong measurement here before.
4. **Nothing lands wrong.** Zero decals on unpainted pixels, zero on
   `occupancy` water, zero above the snow line, zero outside the face ellipse.
5. **Determinism.** Same seed and same biosphere produce a byte-identical site
   list across two calls and across a save/load round trip.
6. **Budget holds.** Site count never exceeds the budget at any lushness.
7. **Per-frame cost unchanged.** Frame time with decals baked must match the
   pre-decal build within noise; only bake time may rise.

## Prototype evidence

Measured 2026-09-11 against `paintCutawaySurface` with
`generatePlanetGrid('ocean', 7777)` at 1200x800, `rx = 262`:

| biosphere | sites | composition |
|---|---|---|
| dead (`lush` 0.04) | 0 | — |
| mid (`lush` 0.45) | 185 | 179 scrub, 3 trees, 3 rock |
| lush (`lush` 0.92) | 483 | 159 scrub, 319 trees, 5 rock |

Cost: planning 4.7ms, stamping 1.0ms, both bake-time only. Per-frame cost zero.

## Risks

- **The snow-line coupling described above is invisible.** A comment in both
  places is the mitigation; a shared exported constant would be better and is
  worth considering during planning.
- **Decal density vs. zoom.** The diorama zooms. At high zoom, 8–16px decals
  will be large and sparse; at low zoom they may turn to noise. The plan needs
  a zoom response — likely a density scale on the animated layer and a decision
  about whether to re-bake on large zoom changes.
- **Re-bake churn.** The threshold is a guess until measured against a real
  game session's biosphere curve.
- **`lifeDensity` being a declared-but-unwritten field.** Checked, because this
  project has form here — `dominantSpeciesId` sat null on all 65k cells for the
  life of the project. `lifeDensity` is not that: it is written by the spread
  functions in `PlanetGrid.ts:431-451`, by terraforming and life-seeding in
  `main.ts` (`:1135`, `:4420`, `:4478`), and it is already read by the surface
  painter for vegetation tint (`HabitableCutawayEngine.ts:836`). The field is
  live.

  What is *not* yet established is its distribution during real play — the
  related `stepLifeSpread` bug (rate constants sized for the wrong cadence, so
  life never spread) is exactly the failure that would leave this field
  technically written and practically zero. The plan's first task must measure
  `lifeDensity` across a real engine run before any placement work depends on
  it. If it is near-zero in practice, the readout collapses to `fertility *
  lush` — still workable, but a different design, and better known up front.
