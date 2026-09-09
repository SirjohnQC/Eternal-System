# Procedural Planet Genome — Design

**Date:** 2026-09-08
**Status:** draft — awaiting review
**Relates to:** `DIORAMA.md` (north star), `docs/superpowers/specs/2026-09-06-habitable-godview-compositor-design.md` (the compositor this builds on)
**Corrects:** `cursor.md`, which states only ocean + rocky use the cutaway engine and that the snow-globe was dropped. Neither is true in the code: `IsoDioramaRenderer.usesCutaway` (`:537`) returns `true` unconditionally and its own doc comment describes the current geometry as "the pancake cutaway + soft ozone half-dome."

---

## Purpose

Every planet in the game currently looks like the same planet. This is not a
polish problem — it is structural, and it has a single measurable cause.

`generatePlanetGrid` (`src/simulation/PlanetGrid.ts:282`) builds **every world in
the cosmos** from one recipe: `fbmWrapX(nx*4, ny*4, …)` for elevation, the same
FBM at 3–3.5 for moisture, latitude plus noise for temperature. Exactly two
scalars vary per planet — `oceanBias` (from `TYPE_OCEAN_COVERAGE`) and
`tempBias`. `classifyBiome` then applies hand-written threshold blocks per
planet type, so all nine toxic worlds in a galaxy are the same toxic world with
a different seed.

Measured, not asserted: rendering `ocean` at seeds 1, 7 and 23 through
`/diorama-preview.html` produces three different outlines of the *same thing* —
one landmass, centred, roughly 55% of the disc, ringed by ocean, one grey ridge.
Rendering `ocean`, `lava`, `toxic` and `crystal` at the same seed produces an
identical silhouette in all four, with the crust stalactites hanging at the same
x-positions, distinguished only by hue.

This design replaces the two scalars with a **planet genome**: a per-planet
identity that drives terrain structure, materials, fluids, interior, and the
marks civilization leaves on the surface.

## Scope

**In:** the genome module and its data model; six terrain archetypes; the
material/fluid channel system; the sphere composition and rebuilt atmosphere;
civilization earthworks as a persisted works list; the discovery-tier fidelity
ladder; performance budget and verification tooling.

**Out:** the species/life engine (its own cycle — this design only exposes the
hooks it will need); LLM-generated culture; the Z-axis voxel planet (ROADMAP M21).

**Deferred with the decision written down, not guessed:** under-crust visual
execution, and the "alive" motion layer. See [Deferred decisions](#deferred-decisions).

---

## The core change

```
PlanetBody.genomeSeed  (one number, serialized with stars)
        │
        ▼
  rollPlanetGenome(genomeSeed, type, dna, star)     pure · memoized · no rendering imports
        │
        ├─► identity   : archetype, worldScale, axialTilt, tidalLock
        ├─► materials  : vegetation · water · rock · atmosphere
        ├─► fluid      : viscosity · waveProfile · emission · skin
        ├─► interior   : strataProfile, faults, voids, coreHeat
        └─► anomaly    : null | { kind, params }              ~3% roll
        │
        ├──────────────► generatePlanetGrid(genome, dna?)     → GridCell[][]  (runtime)
        │                          ▲
        │                  works[] replayed on top            (persisted, sparse)
        │
        ├──────────────► PlanetRenderer          (telescope tier: silhouette + palette)
        ├──────────────► HabitableCutawayEngine  (materials, strata, atmosphere, fluids)
        └──────────────► IsoDioramaRenderer      (features, anomaly, live layers)
```

**New module:** `src/simulation/PlanetGenome.ts`. Pure functions, no imports from
`src/rendering/`. It is the only thing in the codebase that decides what makes a
planet distinct.

### Why a seed and not a stored genome

`serialize()` (`BigBangEngine.ts:5343`) saves `stars` wholesale and gzips it, so
anything added to `PlanetBody` persists automatically. Storing the whole genome
would work but bloats every save by ~100–500 planets' worth of struct.

More importantly, the genome must **not** be derived from `planet.type`.
Terraforming mutates the type (`TERRAFORM_SEQUENCES`, `BigBangEngine.ts:4402`);
a type-derived genome would silently reroll a world's identity the moment you
terraformed it — you would terraform Kepler-9b and get a different planet back.

So: one `genomeSeed: number` on `PlanetBody`, assigned at planet creation
(`BigBangEngine.ts:4992`, where `discovery: 'none'` is set today). Type and DNA
are *inputs that bias the roll*, and terraforming modulates the **expression** of
a fixed identity rather than replacing it.

---

## 1 · Terrain archetypes

Six generators, each a structurally different noise composition — not one FBM
thresholded differently. All six were prototyped and verified to produce
visually distinct worlds from the *same seed*.

| Archetype | Generator | Consequence for the sim |
|---|---|---|
| `supercontinent` | low-frequency FBM (3 octaves) + gaussian inland sea + rim falloff | interior genuinely far from water; long overland routes |
| `archipelago` | ridged multifractal, high frequency, high exponent — only peaks clear sea level | no mainland; every settlement coastal; ports dominate |
| `dichotomy` | noisy hemisphere split with a graded boundary | one long coast; everything crowds it |
| `belt` | gaussian band in latitude + FBM | climate-defined; polar oceans |
| `crater` | flat base minus overlapping impact bowls with raised rims | no coherent continents; water ponds in basins |
| `rift` | FBM minus linear chasms along seeded lines | land in slabs; chasms are natural borders |

`crater` and `rift` change what the *game* feels like, not only what the planet
looks like — a craterworld has no continuous landmass for a civilization to
spread across, and a rift world's chasms partition it. Both need rules in the
life/civ layer, tracked as a dependency for the species engine cycle.

Planet *types* become genome **weightings** over these six, not switch cases.
`toxic` biases the roll; it does not dictate the output. The nine hand-written
blocks in `classifyBiome` become a threshold table the roll produces.

---

## 2 · Materials and fluids

The current failure is sharper than "palettes are per-type constants": **one hue
is applied to every layer at once**, so a toxic world is green water, green rock,
green strata and green sky. It reads as a filter over one planet, not as a
different planet.

### Four material channels, rolled independently

| Channel | Fields | Notes |
|---|---|---|
| `vegetation` | hue, saturation, density | green is one option among many. **This is the hook the species engine plugs into** — biochemistry archetype → pigment is a one-line mapping once the channel exists |
| `water` | hue, saturation, turbidity | turbidity drives both color depth-ramp and whether the seabed is visible |
| `rock` | family, hue, saturation | basalt / iron / chalk / granite / sulfur / sandstone |
| `atmosphere` | hue, saturation, thickness | drives the rim *and* aerial perspective on terrain near the limb |

Six families were validated as a starting set and all six are in:
`terran`, `iron`, `violet`, `sulfur`, `anoxic`, `ash`.

**Known flaw to fix in implementation, found during prototyping:** deriving the
high-elevation color as a fixed desaturated near-white gives every world
brilliant snow-capped peaks, including an ash world that has no business with
them. Peak color must derive from the rock family *and* climate, not a constant.

### Fluid behaviour is its own channel

Today there are exactly two hardcoded fluid paths — a caustic water path and a
magma path (`HabitableCutawayEngine.ts:1392`) — with module-level constants
(`SWELL_K`, `SWELL_DISP_SHORE_PX`, …) sized for one liquid. Every non-magma
world animates identically.

Fluids get a genome channel:

| Field | Effect |
|---|---|
| `viscosity` | wave speed and amplitude; sludge barely moves, water is quick and small-scale, magma undulates slowly and heavily |
| `specular` | water glitters (reflective); magma **emits** (lights surrounding terrain); oil has an iridescent sheen; slush has none |
| `skin` | magma forms a dark cooling crust that cracks; anoxic water grows scum mats; water foams at coasts |
| `opacity` | clear water shelves visibly over the seabed; turbid hides it entirely |
| `emission` | feeds the same light-field the interior uses, so a magma sea lights its own cliffs |

The existing swell constants become per-fluid profile fields. This is the same
class of bug as the recurring "rate constants sized for the wrong cadence" —
one liquid's constants applied to all liquids.

---

## 3 · Composition and the vertical stack

The shipped diorama has drifted from `assets/mockups/habitable-diorama-target.png`.
The mockup is a **sphere** — land on a globe, ragged crust contained *within* the
silhouette, a thin atmosphere rim. What renders is a **cone under a bell jar** —
the body tapers past the sphere line to a point, stalactites hang in empty space,
and a glass dome caps the top, desaturating the terrain exactly where the detail
lives.

| Band | Now | Becomes |
|---|---|---|
| Atmosphere | flat annulus, hard terminator | smooth two-tone scatter, noise-perturbed thickness, inward aerial-perspective gradient |
| Tabletop | flat biome paint | `diorama_test`'s extruded elevation — plateaus with cliff edges, coastline shelves |
| Water column | acceptable | keep; fluid channel sets depth, turbidity, facets |
| Under-crust | flat two-tone disc | procedural — see [Deferred](#deferred-decisions) |
| Silhouette | cone + drips in empty space | sphere; everything contained, proportion genome-driven |

### Why the current atmosphere reads as pasted on

Four specific causes in `diorama_test.html:404-420`, all cheap to fix:

1. `sunFacing > -0.1 ? 0.85 : 0.28` — a **hard branch** at the terminator.
   Intensity jumps with no gradient. This is the biggest tell.
2. One flat `atmoColor` at two intensities. Real haze splits by wavelength —
   warm where lit, deep blue where not.
3. Constant `atmoThickness` draws a geometric annulus. It reads as an outline
   because it is one.
4. It only glows outward. The inward pass is a flat `0.22` tint over the last
   5px (`:439`) — a hard-edged band. Air sells itself through **aerial
   perspective**: terrain desaturating and lifting into haze toward the limb.

A prototype with a smooth terminator, two-tone scatter, and real inward
gradient confirmed the fix works. Remaining issue: the falloff was too wide and
read as a glow blob rather than a rim. Tighten to hug the silhouette.

---

## 4 · Civilization earthworks

Settlements today are **sprites standing on terrain** (`bakeSettlementSprite`,
`IsoDioramaRenderer.ts:498`) and never touch it. The only code in the engine that
writes elevation is the player's divine terraform (`main.ts:1154`, `:1161`),
which raises/lowers cells and reclassifies the biome (`:1192`).

Intelligent species should reshape their world. Civ earthworks are that same
operation, driven by the simulation.

### This amends the persistence decision

Live re-derivation was chosen on the basis that nothing extra needed storing.
Earthworks are accumulated history — re-deriving from the genome alone would
erase every road and harbour on the next visit.

**Resolution:** genome (immutable, one number) **+ works list** (persisted, sparse).

```ts
works: [
  { kind:'platform', at:[0.31,-0.12], r:0.09,           tick: 41200 },
  { kind:'terrace',  at:[0.44,-0.30], r:0.11, steps:5,  tick: 58900 },
  { kind:'road',     path:[[0.31,-0.12],[0.05,0.18]],   tick: 62400 },
  { kind:'harbour',  at:[-0.55,0.04], r:0.07, mole:true,tick: 71000 },
  { kind:'reclaim',  at:[0.36,-0.05], r:0.10,           tick: 94500 },
  { kind:'canal',    path:[[0.18,0.02],[-0.10,0.10]],   tick:112000 },
]
```

Storing *works* rather than modified cells is the load-bearing choice: a few
hundred bytes per inhabited world instead of a 65k-cell diff, replayable at any
grid resolution, and legible as history — "when was this canal cut" has an answer.

### Operations

`platform` (level a building site) · `terrace` (quantize slope to steps) ·
`road` (graded route: cut through hills, embank across valleys) · `harbour`
(dredge below sea level, optional breakwater) · `clear` (biome → cropland) ·
`canal` / `reclaim` / `causeway` (high tech).

Roads take the least-cost path over the elevation field. This is the one piece
with real algorithmic cost (Dijkstra/A* over the grid) and it runs at work-creation
time, not per frame.

Each archetype forces different engineering — archipelago is ports and
causeways, rift worlds need bridges or stay fragmented, craterworld settlements
ring the basin rims. The archetype choice pays off twice.

**This is the strongest "alive" signal available**, because unlike weather it is
cumulative and irreversible. It is also DIORAMA.md §35's "evolution test."

---

## 5 · Discovery tiers

The mechanic already exists and is already the information-gating spine of the
planet UI. `PlanetDiscovery` (`BigBangEngine.ts:83`); player fleet arrival grants
it (`:2830`); own-system tech ladder advances it (`:4518`); habitability is
already gated on it (`main.ts:1421`). The only thing not on the ladder is the
diorama, which is hard-gated on `target.isPlayerStar` (`main.ts:1029`).

| Tier | Fidelity |
|---|---|
| `none` | unresolved dot |
| `telescope` | sphere only — silhouette and dominant color. You can tell it's a *violet* world, nothing more |
| `probe` | diorama unlocks: terrain, biomes, materials, macro features. No life/civ layer. Rendered with incomplete-data chrome |
| **`survey`** *(new)* | player-driven, DP-costed deep scan. Reveals interior and anomaly |
| `landing` / `colonised` | full diorama — settlements, earthworks, wildlife, weather, divine FX |

The genome is rolled at planet **creation**, not at view time: `telescope` needs
the material palette before any grid exists.

This bounds the performance problem — the diorama-eligible set is "planets you
have probed," which grows at the speed of your fleets, not "every planet in the
cosmos."

---

## 6 · Performance

Full diorama for probed planets means grid generation (65k cells × multi-octave
noise) plus a bake, per newly-unlocked world.

- Grid generation stays runtime-only and off the save, per the existing rule at
  the top of `PlanetGrid.ts`.
- Non-home worlds render at `GRID_SIZE / 2` (128) unless measurement shows full
  resolution is affordable; the works list replays at any resolution, so this
  costs nothing in fidelity of history. The player's home world stays at 256.
- **The budget is set in Phase 1 by measuring the current generator**, not
  guessed: `genomeBudgetCheck` records today's grid-gen + bake cost as the
  baseline, and the gate is that a genome world costs no more than 2x that at
  equal resolution. Cache policy (if any) is decided from the same measurement.
- Note: `/diorama-preview.html` currently reports `1 fps`. Confirm this is the
  harness baking once and idling, and not a real frame cost, **before** making
  generation more expensive.

---

## 7 · Verification

Per project convention, each guard ships with a **control that proves the measure
detects the bug** — a measure that passes on the current broken generator is not
a measure.

| Tool | Asserts | Control |
|---|---|---|
| `tools/planetVarietyCheck.ts` | across N seeds, the distribution of land fraction, largest-landmass share, coastline-to-area ratio, landmass count and palette hue spread is **wide** | run against the *current* generator; it must FAIL (narrow distribution). If it passes, the metric is wrong |
| `tools/archetypeIdentityCheck.ts` | each of the six archetypes is separable from the other five on those metrics at a fixed seed | collapse all six to plain FBM; must fail |
| `tools/worksReplayCheck.ts` | genome + works replays bit-identically; survives a `serialize()` round trip; terraforming a planet does not change its `genomeSeed` | — |
| `tools/fluidProfileCheck.ts` | the six material families produce distinguishable fluid animation parameters | force one profile for all; must fail |
| `tools/genomeBudgetCheck.ts` | grid gen + bake per planet ≤ 2x the Phase-1 baseline at equal resolution | records the pre-genome baseline itself, so the gate cannot drift |
| `tools/habitableDioramaCheck.ts` | extended: silhouette is contained in the sphere; no geometry outside it | assert against the current cone; must fail |

A single-seed assertion cannot distinguish "broken" from "unlucky" — every
stochastic assertion here is on a distribution across seeds.

---

## 8 · Breaking changes

`generatePlanetGrid(type, seed, dna)` → `generatePlanetGrid(genome, dna?)`.

Nine call sites pass a bare type string: `src/main.ts:1013`,
`src/dev/dioramaPreview.ts:68`, and `tools/` — `archetypePlacementCheck.ts:90`,
`habitableDioramaCheck.ts:246,650`, `mapLayerCheck.ts:37`, `reliefCheck.ts:29`,
`settlementInlandCheck.ts:6`, `smokeTest.ts:91,95,115,116,322,378`.

Ship `genomeFromLegacy(type, seed)` so existing guards keep running unchanged
rather than rewriting all nine up front. Migrate them per phase.

Saves: `genomeSeed` absent on old saves → derive once from `star.id` and planet
index on load and write it back. Old saves have no `works`, which is correct —
they had no earthworks.

---

## Deferred decisions

Written down rather than guessed at. Each gets its own decision point.

**Under-crust execution.** Direction chosen: spectacle (caverns, veins, a living
core) over pure geological legibility — but the prototype that won was crude and
the final treatment is unsettled. Three executions were explored (core-lit,
geode, circulatory); circulatory read strongest, geode weakest *as drawn*, which
may be an execution failure rather than a verdict on the idea. Open: which
execution, and how much visible strata banding survives underneath the spectacle
— the quantized prototype lost nearly all layering, which is a regression.

**The alive layer.** Weather, day/night, seasons, growth. Wanted, not yet
designed. Sequenced after the surface lands, because it modulates the surface
rather than defining it. Earthworks already deliver the strongest aliveness
signal, which lowers the urgency.

---

## Phasing

1. `PlanetGenome.ts` + `genomeFromLegacy` + `genomeSeed` on `PlanetBody`. No visual change. Guards green.
2. Six archetypes behind the genome. `planetVarietyCheck` + `archetypeIdentityCheck` land here — with their controls.
3. Material channels; retire the one-hue-per-type path. Fix peak color derivation.
4. Composition: sphere silhouette, rebuilt atmosphere, `diorama_test` tabletop.
5. Fluid channel; retire the two hardcoded paths and the global swell constants.
6. Discovery-tier fidelity + the `survey` tier and its DP action.
7. Earthworks: works list, replay, the six operations, road pathfinding.

Phases 1–2 are the load-bearing ones: everything else assumes the genome exists
and that variety is measurable.

This is more than one implementation plan's worth of work. Expect `writing-plans`
to split it — phases 1–3 (genome, archetypes, materials) are one plan; 4–5
(composition, fluids) a second; 6–7 (discovery tiers, earthworks) a third.
