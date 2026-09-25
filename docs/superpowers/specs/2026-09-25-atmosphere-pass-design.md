# Atmosphere pass — design

Date: 2026-09-25. Sub-project 1 of 2 of the atmosphere + weather rework.
Sub-project 2 (a visual weather sim driven by real grid state) gets its own
spec; it renders inside the dome and is masked by `airMask`, so the dome's
geometry is settled here first.

## Intent

Keep the half-dome silhouette (decided 2026-09-25 over "wrap the whole drum"
and "thin shell, no dome"), but fix the three things that make it read as a
broken bell jar rather than air:

1. a hard horizontal shelf where the limb glow stops at rim height;
2. the dome's top clipped by the canvas;
3. every world of a type having identical air, because the per-world genome
   atmosphere is never used.

Success: on every type and on several seeds of the same type, the limb glow
runs continuously round the front of the rim, the whole dome is on canvas, two
worlds of one type have visibly different air, and the four existing
atmosphere metrics stay green. Checked by metric AND by looking at pixels.

## Findings this design rests on

- **Shelf.** `ozoneAt` (`HabitableCutawayEngine.ts`) returns null below `cy`
  for any pixel outside the top-face ellipse (`if (y > cy && face > 1)`). The
  limb's outer fade band — pixels between `rx` and `rx + localFade` from the
  dome centre — therefore ends on the horizontal line `y = cy`.
- **Clipping is structural.** `habitableGeom` reserves room for `T` above the
  body, not for the dome. The dome top is at `cyTop - rx - fadeMax`. With `R`
  at its `0.36·VH` cap: `cyTop ≥ 0.56·VH - 0.67·0.36·VH ≈ 0.319·VH` and
  `rx = 0.91·R ≈ 0.328·VH`, so the dome top sits at about `-0.01·VH` before
  the fade band is even counted. It clips on every viewport where the height
  cap binds.
- **Genome air is dead code.** `rollPlanetGenome` is called nowhere in `src/`.
  `paintAtmosphere` is called with no `air` argument and falls back to
  `genomeFromLegacy(planetType, 0).atmosphere` — one air per type. This is the
  repo's recurring "declared and never written" pattern.

## Design

### 1. The limb wraps the rim

Below `cy`, stop cutting at the face ellipse. Measure an outward fade band from
the **rim ellipse** (`face` in ellipse-normalised units, converted to pixels
along the ellipse normal) instead of from the dome circle, so the limb glow
follows the rim round the front of the disc.

- At `y = cy` the band must meet the dome's band with no step: the two
  distance measures coincide there (the rim ellipse's extreme x is `rx`, the
  dome circle's radius), so blend them over a few pixels either side of `cy`.
- The band thins toward the front-most point of the ellipse — less air along
  the line of sight there — and reaches zero before it gets there. (Amended
  while planning: a non-zero floor would run into the kept pancake-only cut at
  `y > cy + ry` and make a new shelf at the front.) The band's whole glow, not
  only its limb term, fades with distance from the rim, so it ends in a fade
  rather than a cut.
- Unchanged: no air under the tabletop (`y > cy + ry` still returns null — the
  pancake-only line and its comment stay; they go with the pancake).
- `bakeAirMask` uses `ozoneAt`, so the wisp mask follows automatically. Check
  it: wisps must not start drawing in the new rim band below `cy`. If they do,
  the mask gets its own `below-cy` cut; clouds belong to sub-project 2.

### 2. The dome fits the frame

`habitableGeom` gains a real framing constraint:

- dome top including the fade band, `cyTop - rx - fadeMax`, must be `≥ 4px`;
- the keel's lowest painted pixel (measured on the baked crust layer, since the keel is procedural) must be `≤ VH - 4px`.

Satisfy the first by moving `cyBody` down (there is empty space under the keel
in every current screenshot), and only shrink `R` if moving it would push the
keel off canvas. `fadeMax` depends on the atmosphere channel's `thicknessPx`;
the geometry uses the channel's upper bound (13px from `rollPlanetGenome`,
times the 1.6 wobble factor, plus 2) so the frame does not re-layout per
planet.

Everything positioned from `habitableGeom` (pick buffer, tile markers,
settlements, divine effects, moons) moves with it — they already read the
geometry rather than hardcoding positions. Verify with the existing
`habitableDioramaCheck` and a click-to-tile check in the preview.

### 3. Per-world air

`IsoDioramaRenderer` computes
`rollPlanetGenome(planet.genomeSeed, planetType).atmosphere` once, caches it
keyed by `(genomeSeed, planetType)`, and passes it on `HabitableFrameInput` as
a new optional `air` field. `HabitableCutawayEngine.frame` forwards it to
`paintAtmosphere`'s existing `air` parameter.

- Type still sets the colour family; the seed sets the drift (±22° hue,
  ±18% saturation, thickness 6-13px, density). Terraforming changes type, so
  the air follows it, without rerolling the world's identity — the seed is
  unchanged.
- Gas giants keep their band-average `tint` override.
- No planet (preview with no star) falls back to today's legacy channel.

### 4. Measurement — control first

Every new metric is run against today's renderer BEFORE any change, and must
fail there. If it cannot fail on the broken code, the metric is wrong.

Added to `tools/atmosphereCheck.ts` (or a sibling if it grows unwieldy):

| metric | definition | today (control) | target |
|---|---|---|---|
| shelf | largest row-to-row alpha drop, sampled along the outer limb band on both sides, across `y = cy ± 6` | a step to 0 — must FAIL | no step above the band's own row-to-row gradient elsewhere |
| framing | topmost row with alpha > 2 is ≥ 0, and keel bottom ≤ VH, at 1200×800, the preview's default canvas size, and a 390×844 phone viewport | dome top < 0 — must FAIL | on canvas at every size |
| genome reach | two seeds of one type rendered through the real `frame()` input path: sunlit-limb mean colour distance | 0 — must FAIL | above a threshold set from the roll's minimum hue spread |

Also:

- **Run the existing four metrics over rolled genomes**, not only
  `genomeFromLegacy(type, 0)`: ocean, lava and desert across 12 seeds each, as a
  distribution. The roll drifts hue and thins density, and a single seed cannot
  tell a broken roll from an unlucky one. The hue-drift guard is the one most
  likely to trip; if the roll's ±22° is outside `MAX_HUE_DRIFT`, that is a
  finding to report, not a threshold to loosen.
- **Frame cost**: `paintAtmosphere` at 1200×800 must stay within +10% of
  today's time, measured before and after on the same machine in one session.
- **Pixels**: render ocean, lava, desert, storm and gas in the preview, two
  seeds each, and look at the limb, the rim and the top of the dome before
  reporting done. `atmosphereCheck` has passed a pink lava sky before.

## Out of scope

- Clouds, wisps, precipitation, the dead legacy `buildClouds` branch — all
  sub-project 2.
- The sphere composition, and gas-giant nested shells
  (`docs/superpowers/specs/2026-09-14-gas-giants-design.md`).
- The preview's frame rate beyond the +10% budget above.
