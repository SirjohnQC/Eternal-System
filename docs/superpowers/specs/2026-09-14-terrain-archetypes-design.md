# Terrain Archetypes — Design

**Status:** design, not yet planned
**Origin:** the visual companion from 2026-09-08,
`.superpowers/brainstorm/17325-1788911701/content/terrain-archetypes-v3.html`,
whose closing question — which archetypes earn their place — was never answered
until now.

## The problem

Every world in the game is the same recipe: `fbm(nx * 4, ny * 4)` with a
sea-level offset from `dnaToGridParams`. Different seeds therefore give
different *shuffles of one centred blob*, not different worlds. Two ocean
planets are the same planet with the continents stirred.

This is also why `tools/planetVarietyCheck.ts` has been failing by design since
2026-09-08: it measures landmass count and coastline character, and a single
generator cannot produce that spread. The failure was left standing as the
baseline the archetype work must beat.

## Decisions taken

- **All six archetypes earn their place** — supercontinent, archipelago,
  hemispheric dichotomy, equatorial belt, craterworld, rift/shattered.
- **This spec covers the first three**: supercontinent, archipelago,
  hemispheric. They are noise-shaped and share machinery. Equatorial belt,
  craterworld and rift are structural rather than noise-shaped and get their
  own spec once this frame is proven.
- **Archetype is rolled from `genomeSeed` and is NOT constrained by planet
  type.** An archipelago lava world is rock islands in a magma sea — coherent,
  because the archetype shapes the elevation field while palette and biome
  still come from the type.
- **Archetype and sea level stay orthogonal.** The archetype defines the shape
  of the elevation field; `oceanCoverage` (from the player's `PlanetDNA`
  `oceans` choice) sets the level that cuts it. `barren` + archipelago is a
  broken plateau of exposed peaks; `ocean_world` + supercontinent is a smaller
  continent. The player's DNA choice keeps meaning what it says.

## Non-goals

- **Not the remaining three archetypes.** Equatorial, craterworld and rift are
  named here so the union and the metric are designed for six, but only three
  are implemented.
- **No change to moisture, temperature, `classifyBiome` or fertility.** Those
  fields work; coupling them to the archetype triples the surface area for no
  visible gain. The archetype owns elevation only.
- **No change to the diorama renderer.** Archetypes change what is generated,
  not how it is drawn.
- **No voxel Z-axis.** That is ROADMAP M21 and a different project.

## Architecture

New module `src/simulation/TerrainArchetypes.ts` — pure, no rendering imports,
same discipline as `PlanetGenome.ts`.

```ts
export type TerrainArchetype =
  | 'supercontinent' | 'archipelago' | 'hemispheric'
  | 'equatorial' | 'craterworld' | 'rift';

/** The three this spec implements. The union carries all six so the roll and
 *  the metric are designed for the finished set. */
export const IMPLEMENTED: readonly TerrainArchetype[];

export function elevationFor(
  archetype: TerrainArchetype,
  nx: number, ny: number,      // normalised grid coords, as today
  seed: number,
): number;                      // 0..1, same contract as today's fbm call

export function rollArchetype(genomeSeed: number): TerrainArchetype;
```

`generatePlanetGrid` calls `elevationFor` where it currently calls
`fbm(nx * 4, ny * 4)`. Everything downstream is untouched.

**Assignment threading.** `generatePlanetGrid(type, seed, dna)` receives a GRID
seed (`star.id * 7777 + planetIndex * 131`), not `genomeSeed`. The archetype is
therefore passed in as an explicit optional parameter by the caller, which
reads it from the planet's genome. This keeps `PlanetGrid` pure and lets checks
drive any archetype directly rather than hunting for a seed that produces one.
Absent the parameter, behaviour is today's generator — so every existing call
site and check keeps working unchanged until it is migrated.

### The three generators

Each is genuinely different in construction. They may share noise helpers; they
must not share a recipe, or they become the same field masked three ways — the
exact failure this work exists to end.

- **Supercontinent** — a low-frequency dome with an offset centre, warped by
  mid-frequency noise, with an inland sea carved by a second low-frequency lobe
  subtracted from the interior. Produces one dominant mass running off the rim.
- **Archipelago** — ridged noise (`1 - |fbm|`) at high frequency, raised so only
  the ridge peaks clear sea level. No continental term at all.
- **Hemispheric** — a linear gradient across the disc at a seeded angle, with a
  noisy boundary band so the coast is ragged rather than straight. One half
  land, one half ocean.

## The metric

`tools/planetVarietyCheck.ts` is rewritten. Its current assertions —
`landmasses >= 40` and `coastSpread >= 0.15` for every world — are not merely
unsatisfiable, they are **wrong**: they demand archipelago-ness of every world,
so satisfying them would replace one monoculture with another.

### Per-archetype signatures

Each measures the claim that archetype actually makes:

| archetype | asserts |
|---|---|
| archipelago | many landmasses; small biggest-mass share; **no land cell far from water** (its promise is "every settlement is coastal") |
| supercontinent | few landmasses; large biggest-mass share; **max distance-to-water is high** (its promise is "the interior is genuinely far from water") |
| hemispheric | land concentrated in one half of the disc; **a coast that wanders off the dividing plane** (one long ragged coast) |

Distance-to-water is the discriminator that matters most: it is the one
property today's centred blob cannot fake in either direction.

**Corrected 2026-09-15, by measurement.** This section originally asked
hemispheric for "high coastline length relative to land area". That is the wrong
dimension: a clean hemisphere is the most COMPACT arrangement of land available,
so it scores LOW (coast/sqrt(land) = 5.3) and the old lake-riddled blob beats it
(8.5). Satisfying it would have meant making the hemisphere ragged in the wrong
way. What the claim actually promises is a boundary that wanders rather than one
drawn with a ruler, so the implemented metric is the spread of the coast about
the dividing plane — ~0 for a straight split, 0.13 measured. Same class of error
as the variety check that measured land AREA when the defect was land SHAPE.

**Added 2026-09-15:** a fourth claim on every archetype — the share of land that
classifies as mountain, snow or volcanic must stay under 0.35. The spec argued
for this ("a white mountain continent and a green plains continent have
identical landmass counts") without putting it in the table. It caught the
supercontinent dome, which was building a grey massif across its own interior
while passing all four structural claims.

### Cross-archetype distinguishability

The assertion that proves the thesis rather than assuming it: compute each
archetype's signature vector over the seed sweep, and assert each archetype's
median sits closer to its own cluster centroid than to either other's. "The
worlds vary" is weaker than "these are structurally different generators", and
only the second is what was promised.

### The control, written first

Run all three signature tests against **today's single `fbm` generator** and
require every one to FAIL. If the existing blob can pass the supercontinent
signature, the signature is not measuring supercontinent-ness.

**Write this control before writing a single generator, and prove it fails.**
This project has shipped a variety check that measured land AREA when the
defect was land SHAPE, an atmosphere check that measured hue ANGLE and rewarded
rotating hue until a lava sky went pink, a gate that rendered only ocean while
guarding a lava bug, and — in the decal work last week — an assertion whose
verdict depended on where the camera happened to point, plus a snow-line check
with the same constant on both sides of the comparison. The pattern is
consistent enough to plan around.

### Distribution, not one world

Every assertion runs over a seed sweep (at least 8 grid seeds per archetype)
and asserts on the distribution — median plus a pass rate — with thresholds
derived from measurement. A single-seed assertion cannot tell "broken" from
"unlucky"; this codebase has that lesson written down twice already.

## What a throwaway spike already established (2026-09-14)

Three generators were prototyped and viewed in the browser at the real render
size before this spec was planned. Two findings are design constraints, not
tuning trivia, and the plan should carry them as requirements:

1. **Ridged noise must be raised to a power, or archipelago is not an
   archipelago.** A straightforward `1 - |2v-1|` ridge field averages around
   0.5, clears `SEA_LEVEL` (0.48) over most of the world, and the ridges
   connect — producing a continuous mountainous landmass with lakes, which is
   the exact opposite of the archetype. Raising the crest to ~4.5 gives
   scattered islands.
2. **Land must sit just above sea level, not near the top of the range.** Both
   land generators first ran to ~0.85, which pushed nearly every land cell into
   the mountain and snow classifications — a temperate world rendered white.
   Land wants to sit mostly in roughly 0.50-0.70 with highlands as the
   exception.

Both were found by looking, not by measurement, and neither would have been
caught by a landmass-count metric: a white mountain continent and a green
plains continent have identical landmass counts. This is the argument for the
legibility assertion below rather than only structural ones.

## Risks

- **The archetypes may not be visually distinct at the size the game renders.**
  The diorama pins its long edge to 480 virtual pixels (`rx` ~= 105), and the
  mockups were drawn much larger. A metric can call two generators distinct
  while the player cannot. **Verification must include looking at all three at
  480px, in the browser, not only at a comfortable render size** — the decal
  work was calibrated at rx=262 and the error was invisible until it was seen
  in Chrome.
- **`dnaToGridParams` clamps `oceanCoverage` per planet type**
  (`PlanetGrid.ts:156`, "soft cap on oceanCoverage per planet type"). An
  archipelago on a type whose cap forces low ocean coverage may drown or emerge
  entirely. Measure the interaction across types before assuming orthogonality
  holds in practice.

  **Measured 2026-09-15** (`planetVarietyCheck --measure --type=X`, medians over
  12 seeds). It does not hold on dry types, and that is pre-existing rather than
  caused by the archetypes:

  | type | legacy land | supercontinent | archipelago | hemispheric |
  |---|---|---|---|---|
  | ocean | 0.72 | 0.35 | 0.10 | 0.55 |
  | rocky | 0.77 | 0.40 | 0.11 | 0.57 |
  | lava | 0.88 | 0.52 | 0.14 | 0.63 |
  | ice | **1.00** | **1.00** | 0.34 | **1.00** |
  | desert | **1.00** | **1.00** | **1.00** | **1.00** |

  On `ice` and `desert` the type's ocean cap lifts the whole field above sea
  level, so those worlds have no water at all — today, with the legacy
  generator, as well. Every archetype washes out into the same all-land world;
  only archipelago survives on ice, because its sea floor sits low enough to
  stay under the cut. Archetype and sea level are orthogonal only where the
  type leaves some sea to cut with.

  Open decision, not taken here: whether dry types should keep a little water
  (which would make archetypes visible on them and change every existing desert
  and ice world), or whether those types get structural archetypes — crater,
  rift — instead of the noise-shaped three.
- **Settlement placement assumes reachable land.** `tools/settlementInlandCheck.ts`
  exists and should be run: an archipelago world has no inland, so any rule
  that wants settlements away from coast has nothing to choose.
- **Save compatibility.** Grids are regenerated rather than stored, so a world
  whose archetype parameter is absent regenerates as today's blob. That is the
  intended fallback, but it means an existing save's home world does not gain an
  archetype until the caller passes one.
