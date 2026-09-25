# Under-Crust Hero — Design

**Status:** built (uncommitted), measured — see "Build notes" at the end
**Origin:** the 2026-09-14 art-direction session (memory: `planet-look-decisions`),
which settled the under-crust look by looking at renders in Chrome. Nothing was
built and no spec existed: grepping `src/rendering/` for
`cavern|geode|coreLit|circulatory` returned zero hits on 2026-09-24.

## The problem

The keel under every habitable world is the same object: tan-to-brown strata
banded on absolute screen Y, a per-pixel `grain * streak` noise, and ~1.4% of
deep pixels swapped for an `emberHot` speck (`paintCutawayCrust`,
`HabitableCutawayEngine.ts`). Looked at in the browser at 480px it reads as
brown mud with sparks on it:

- **No rock character.** The grain is continuous, so a band holds hundreds of
  near-identical colours. It is not a ramp and it is not pixel art.
- **Emission lights nothing.** An ember is a lit pixel on unlit rock. Nothing
  around it responds.
- **No interior.** The keel is a solid silhouette. There is nothing inside it
  to look into.
- **Every world is the same underworld.** The keel varies only by its seeded
  silhouette.

## Decisions taken (2026-09-14, not up for renegotiation)

- The underworld has three things in it: **caverns, veins, a living core.**
- **One hero is rolled per world from `genomeSeed`**: `coreLit` / `geode` /
  `circulatory`, at roughly **15% none, 70% one, 15% two**. Not one fixed look.
- Craft requirements are requirements:
  - a **6-step quantised rock ramp with ordered dithering**;
  - emission that **lights the surrounding rock**, not just glowing pixels;
  - caverns **with interiors**;
  - hue **derived from the genome**.
- **Current crust proportions are correct.** A spike raising `WALL_RATIO`
  0.38 to 0.62 was reverted. The gap is rock *character* — jagged, lit — and the
  atmosphere enclosing the whole drum. **Wall height does not change.**

## Non-goals

- **No change to `WALL_RATIO`, `crustH`, or the keel silhouette.** The hero is
  painted inside the silhouette the smoothing chain already produces
  (per-column profile, 2 box-blur passes, terrace, median-3). The metric asserts
  the alpha mask is unchanged.
- **Not the atmosphere around the drum.** Named in the same decision as the
  other half of the gap; it is its own job and touches `paintAtmosphere`, not
  the crust painter.
- **Not gas giants.** `2026-09-14-gas-giants-design.md` gates the crust painter
  OFF for `gas` and replaces it with nested shells. The hero is skipped for
  `planetType === 'gas'` so it cannot leak into that work.
- **No simulation state.** The hero is a pure function of `genomeSeed`. No
  field on `Planet`, no save format change, nothing to reset on a new game.
- **No animation in this pass.** Everything is baked once with the crust.
  Pulsing veins and a breathing core are natural follow-ups and need a
  per-frame overlay, which the crust layer is not.

## Architecture

New module `src/rendering/UnderCrust.ts` — pure, no DOM, imported by
`HabitableCutawayEngine.ts`.

```ts
export type UnderCrustHero = 'coreLit' | 'geode' | 'circulatory';

export interface UnderCrustRoll {
  heroes: UnderCrustHero[];          // length 0, 1 or 2, no repeats
  hue: Record<UnderCrustHero, number>; // degrees, one per hero rolled
  glitch: boolean;                   // hue rolled outside its family
}

export function rollUnderCrust(genomeSeed: number): UnderCrustRoll;

/** 4x4 Bayer threshold at a pixel, in [0,1). Absolute screen coordinates. */
export function bayer4(x: number, y: number): number;

/** Continuous level 0..5 → ramp index 0..5, ordered-dithered at (x,y). */
export function rampIndex(level: number, x: number, y: number): number;
```

`CutawayBakeOpts` gains an optional `genomeSeed?: number`. `IsoDioramaRenderer`
passes `this.planet?.genomeSeed` (the value it already passes as `decalSeed`).
Absent the field the painter falls back to `decalSeed`, then to "no hero", so
every existing caller and check keeps working.

`paintCutawayCrust` keeps its wall pass and its keel silhouette code verbatim.
What changes is the keel **fill**: instead of `fillRect` per pixel with a
continuous shade, the keel is filled into an `ImageData` of its bounding box in
three passes:

1. **Mask and base level.** For every keel pixel, the existing strata band
   (`bandPos`, absolute-Y banding, untouched) and a continuous light level from
   the existing `lit * ao` term plus a *facet* term (below).
2. **Hero plan and light field.** The rolled heroes stamp emitter pixels and
   accumulate a light field `L(x,y)` over the keel's bounding box.
3. **Quantise and write.** Each pixel's level is raised by `L`, then quantised
   to the 6-step ramp with ordered dithering; tint toward the emitter colour is
   quantised to four steps. Emitters, crystals and vein fluid write their own
   small palettes on top.

### The rock ramp — 6 steps, ordered dither

Per strata band colour `C`, six steps with hue-shifted shadows:

| step | value factor | hue lean |
|---|---|---|
| 0 | 0.40 | toward 250 deg (cool) by 14 deg |
| 1 | 0.54 | toward 250 deg by 8 deg |
| 2 | 0.68 | — |
| 3 | 0.83 | — |
| 4 | 1.00 | toward 50 deg (warm) by 6 deg |
| 5 | 1.18 | toward 50 deg by 12 deg |

The continuous level `0..5` comes from `(lit * ao * facet − 0.40) / 0.78 * 5`.
`rampIndex` adds the 4x4 Bayer threshold at the pixel's **absolute screen**
coordinate and floors. Absolute coordinates matter for the same reason strata
band on absolute Y: a per-column origin makes the dither pattern shear at every
column and read as noise.

The old per-pixel `grain` and `streak` noise are removed from the keel — they
are exactly the continuous variation the ramp exists to replace. Character comes
from **facets** instead: a coarse jagged cell field (cells ~7x5 px, sheared)
gives each cell a flat brightness offset of up to ±0.6 of a ramp step, with a
one-step-darker seam on the cell's lower edge. Rock reads as fractured planes.

### Emission that lights the rock

Every emitter pixel adds `I * r² / (r² + d²)` to `L` for pixels within `3r`,
where `r` is the hero's light radius. `L` raises the ramp level (so lit rock is
*brighter steps*, still dithered) and sets the tint: `t = quantise(min(0.75,
L * 0.6), 0.25)`, rock colour blended toward the emitter colour by `t`. Light is
occluded by nothing — the keel is thin, and occlusion costs more than it shows
at this size.

"Lights the surrounding rock" is measured as a halo: rock pixels near an
emitter are brighter and warmer than rock far from any emitter, and the lit
area is several times the emitter area (see The metric).

### The three heroes

All geometry is planned from `genomeSeed` against the keel's own column
profile, so it always sits inside rock with at least 2 px of rock around it.

- **coreLit — the living core.** A lens of molten/luminous matter embedded low
  in the deepest part of the keel: centre at the column of maximum depth,
  60–75% of the way down; radii `0.10–0.14 rx` wide, 0.55–0.70 of that tall, placed at the thickest low rock by a distance field. Three-step
  emission palette (hot centre, body, rim). Light radius `0.30 rx`, intensity
  1.6 — it lights a wide dome of rock and spills to the keel tips below it.
- **geode — caverns with interiors.** 2–5 elliptical caverns, radii 4–11 px by
  3–7 px, placed in the keel's upper two thirds. Each has an **interior**:
  - back wall: rock at steps 0–1, darker toward the top (overhang shadow);
  - floor: a flat 1–2 px ledge at step 2–3, lit by the crystals;
  - lining: crystal teeth 1–3 px long growing inward from the rim, in the
    hero hue, with a one-pixel highlight on the upper-left face.
  The crystals are the emitters (light radius 7 px, intensity 0.9), so the
  cavern interior and the rock just outside its mouth are lit, and the deep
  rock between caverns is not.
- **circulatory — veins.** A branching network grown from a root near the keel
  bottom (the core, if `coreLit` is also rolled): a trunk (bright 1 px lumen plus a dark, non-emitting 1 px vessel wall) climbing
  toward the wall, branching 3–6 times with 1 px branches, each segment a short
  jittered walk. Small 2–3 px nodes where branches split. Vein fluid is a
  two-step palette in the hero hue; light radius 5 px, intensity 0.7. Veins
  must not cross caverns (they route around the cavern mask).

Two heroes compose: `coreLit + circulatory` roots the veins in the core;
`geode + coreLit` lights the lower caverns from below as well as from their
crystals; `geode + circulatory` routes veins between caverns.

### Hue from the genome

Each hero rolls its own hue from `genomeSeed` within a family, so a world's
underworld is recognisably *its own*:

| hero | family (deg) | reads as |
|---|---|---|
| coreLit | 8–48 | magma, ember, molten gold |
| geode | any of 275–320, 185–215, 120–150, 45–60 | amethyst, sapphire, emerald, citrine |
| circulatory | 165–200 or 80–110 or 330–355 | bioluminescent cyan, toxic green, blood-crimson |

**The glitch.** With probability 0.06 per world, one rolled hero takes a hue
from outside its family (a green core, a blood-red geode). Lawful everywhere
else, occasionally wrong — the owner's "random but coherent, with occasional
glitches in the matrix". It is still a deterministic function of the seed.

### The roll

`rollUnderCrust(genomeSeed)`: `u = hash(seed, 1)`; `u < 0.15` → none,
`u < 0.85` → one, else two. Heroes drawn without replacement, equal weight.
Salted hashes (not `genomeSeed` itself) so the roll is independent of the
terrain archetype roll, which also reads `genomeSeed`.

## The metric

`tools/underCrustCheck.ts`, headless, over the real `paintCutawayCrust` at
the real render size (`habitableGeom(480, 320)`: rx 105, wall 40), rasterised
with `tools/lib/softCanvas.ts`.

### The control, written first

`--control` runs every gate against a frozen copy of today's crust painter
(`tools/lib/legacyCrust.ts`) and exits 0 only if the metric REJECTS it. Every
gate below must be capable of failing on that painter for a reason that is the
requirement, not an accident:

| gate | asserts | why the legacy painter fails it |
|---|---|---|
| roll | over 4000 seeds: none 15±3%, one 70±4%, two 15±3%; each hero 1/3±5% of appearances | it has no hero at all |
| hero presence | over 48 rendered worlds, a keel with a rolled hero holds emissive pixels on >= 90% of hero worlds, and a hero-less keel holds almost none | embers exist on every world regardless |
| ramp | on hero-less worlds, the 6 x bands most common colours cover >= 90% of keel pixels | continuous grain: hundreds of colours per band |
| ordered dither | of 4x4 screen-aligned keel blocks holding exactly two ramp colours, >= 70% form a Bayer threshold set; such blocks are >= 10% of full blocks | no two-step blocks, and those that exist are random |
| lights the rock | rock 2-6 px from emitters is >= 1.25x the luminance of row-matched rock >= 16 px away (strata band on Y, so rows are the fair baseline), and the EXCESS brightened area within 10 px (over the far-field rate) is >= 6x the emitter area | an ember speck brightens nothing: ratio 0.93 measured |
| interiors | every planned cavern has >= 3 distinct colours inside it, back wall darker than the floor, and crystal pixels on its rim | there are no caverns |
| hue from genome | across worlds rolling the same hero, emission hue spans >= 60 deg; same seed twice gives identical pixels | one fixed ember colour |
| proportions | keel + wall alpha mask identical to the legacy painter's on every world | (control passes this one — it is a guard against the work, not a feature) |

### Looking

Green gates are not "it looks right". The work is not done until the keel has
been seen in the diorama preview at the real 480px render — each hero, both
two-hero combinations that are most different, and a none world — and a crop at
3x has been read for: dither that reads as texture rather than noise, halos that
read as light rather than as a coloured blob, cavern interiors that read as
depth.

## Risks

- **Dither at 480px may read as noise at 1x.** Bayer at a 4-pixel period on a
  ~3x upscale is a 12-screen-pixel pattern; that is visible. If it reads as
  noise, drop to dithering only the transition between adjacent steps (already
  the case) and widen facets, not remove the dither.
- **Halo tint can wash strata out.** The tint cap (0.75, four steps) keeps the
  band structure visible under the core. If the core's dome erases the bands,
  lower the cap, not the light radius.
- **Emitter pixels could be mistaken for embers.** The legacy ember specks are
  kept on hero-less worlds only; on hero worlds the hero replaces them, so the
  presence gate stays meaningful.
- **Cost.** One `ImageData` over the keel bbox (~210x92 at 480px) plus a light
  field stamped per emitter. Measured in Build notes.

## Build notes

Built 2026-09-24/25 in `src/rendering/UnderCrust.ts` (roll, ramp, dither,
hero planning, light field, keel fill) and `paintCutawayCrust`
(`HabitableCutawayEngine.ts`), which now hands its unchanged silhouette to
`fillKeel`. Not committed.

### Measured (tools/underCrustCheck.ts, 480x320, rx 105, wall 40)

| gate | legacy painter (control) | built |
|---|---|---|
| roll | none 100% | none 13.9 / one 70.2 / two 16.0%; heroes 33/33/33% |
| hero presence | 0 hero worlds | 40/44 hero worlds >= 1% emissive; plain worlds 0.00% |
| ramp (top-36 colours) | 30.3% | 100.0% on every plain world |
| ordered dither | 0.0% two-step blocks | ~36% two-step, ~77% of them ordered |
| lights the rock | 0/48, near-ratio 0.62 | 237/242 hero worlds over six world sets, near-ratio median 2.4-3.2 |
| cavern interiors | 0 caverns | 68/68 |
| hue from genome | none | core 34 deg span, geode 272, circulatory 227; deterministic |
| silhouette | — | 0 alpha-mask pixels differ from legacy over 16 worlds |

The control (`--control`) fails 7 of 7 feature gates on the frozen pre-hero
painter (`tools/lib/legacyCutawayEngine.ts`) and passes the silhouette guard,
as designed. All gates pass on six independent 48-world sets
(`--offset=1000,5000,9000,13000,17000,21000`); a single set is not evidence.

### Metric corrections, each found by measurement

- **Keel definition.** The first cut (one row below the wall) admitted 16 rows
  of the wall's continuous water gradient into the ramp and dither gates on both
  painters. Keel is now per-column below `frontY + wall + 3`.
- **Ramp gate K.** Every palette has 6 strata bands, not 5: the gate is the
  top 36 colours (6 steps x 6 bands).
- **Dither test.** A clean Bayer threshold set rejects ordered dither under the
  light gradients this spec asks for. Replaced with a rank test (AUC >= 0.9 of
  Bayer rank between the two colours), with synthetic controls in the tool:
  Bayer-dithered gradients pass 100%, random dither passes 4%.
- **Halo.** Counting single pixels > 1.2x their row mean counted dither (30% of
  far-field rock cleared it; legacy embers scored 9.3). Replaced by a radial
  profile: mean luminance ratio per 1 px shell from shell 2, halo radius = last
  contiguous shell >= 1.15x. A compact emitter cannot have 6x its area of keel
  around it, so a halo radius >= 1.5x the emitter's equivalent radius also
  passes. Rows whose whole width is lit borrow the nearest row's far baseline;
  they were previously unmeasured and read as "unlit". Cavern voids are masked
  out of the profile (their back wall must be dark).
- **Hue span.** The coreLit family is 40 deg wide, so a flat 60 deg span could
  never pass; the gate is min(60, 0.6 x family extent).

### Art changes the metric and the renders forced

- The keel sits one ramp step darker than the wall (it is in the board's
  shadow), so heroes have headroom to light pale strata (desert, ice, toxic).
- Placement reads a distance field over the keel: cores and vein roots go to
  the thickest rock, not into a spike tip; vein roots avoid caverns (a
  circulatory+geode world grew no veins before this).
- Light is bounded (`I * (1 - d/reach)^2`), lifts the ramp step first and tints
  second (cap 0.30, dithered in 0.15 steps). An undithered, higher tint drew
  flat coloured discs with contour rings.
- Facet cells are built from whole 4x4 dither blocks, sheared into staircases,
  so fracture edges never cut through a dither block.
- The legacy deep ember specks were removed: they were glowing pixels that lit
  nothing. The bottom edge is ramp step 0 instead of two alpha-blended fills.
- No `getImageData`: the keel is written into a fresh `ImageData` and put
  before the wall is painted (`tools/habitableDioramaCheck.ts` forbids read-back).

### Open

- Geode halos still read as roughly circular per cavern; acceptable at 1x,
  visible at 3x.
- Not animated (non-goal of this pass). Pulsing veins and a breathing core need
  a per-frame overlay, not the baked crust layer.
- The roll is a pure function of `genomeSeed` in rendering; if other systems
  ever need to know a world's hero, it should move into `PlanetGenome` as a
  channel, with this function as its source.
