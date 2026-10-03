# Habitable God-View Diorama Compositor — Design

**Date:** 2026-09-06
**Status:** approved
**Supersedes (visual language only):** the snow-globe / thin-shell pass in
`docs/superpowers/plans/2026-09-06-habitable-diorama-engine.md`. That plan's
file split (engine + host + preview + smoke) still stands; the silhouette,
atmosphere, and fluids do not.

---

## Purpose

The habitable planet diorama should feel like a god looking down at a living
world. `diorama_test.html` is the north star for camera, atmosphere, and motion.
The current `HabitableCutawayEngine` crust paint (layered rock, key light, ember)
is the north star for the cutaway rock. The tabletop is the real simulated
planet (`PlanetGrid`), not invented continents.

Today those two references are mixed in `IsoDioramaRenderer`. Atmosphere is a
4.5% hairline (the HTML shell is 25% of radius), water is a weak shimmer on a
baked ocean, and the body is a snow-globe compromise. It does not feel alive.

## Scope

**In:** ocean and temperate rocky worlds only. Thin-host wiring. New silhouette
ratios. Thick live atmosphere. Live glittering water. Crust reshape (keep the
geological paint, clip it to the new sphere + sheer wall). Clouds clipped to
the shell. Bob. Picking that accounts for bob. Preview + in-game home world.

**Out:** lava / ice / gas rewrite; test-file meteors, solar wind, and subsurface
leviathan; `PlanetGrid` changes; authored planet PNGs; glass dome; the old
pulsing mega-halo on habitable worlds.

---

## Decisions taken

1. **North star is `diorama_test.html` for view and life, new engine for crust.**
   The PNG snow-globe mockup is not the camera. Do not reintroduce a thin halo,
   a glass dome, or a water-filled lower hemisphere.
2. **Visual-first on habitable, then copy the language to other types later.**
3. **Real planet on the board now.** Biomes, settlements, and tile picking stay.
4. **Thin host.** `IsoDioramaRenderer` keeps lifecycle, overlay *data*, and the
   legacy lava/ice/gas path. For habitable worlds it does not invent geometry or
   a second draw stack — it calls `HabitableCutawayEngine.frame()`.
5. **Water is faster and more glittery than the HTML**, same four bands.
6. **Whole body bobs 1–2 virtual pixels.** Hit-testing subtracts bob.
7. **Camera is mockup A** — pancake / god looking straight down, copied from
   `diorama_test.html`. Not the rounder dish (B) or globe window (C).
8. **Atmosphere is the HTML shell, not mockup A’s hairline.** Thickness is
   `max(14px, 0.25 R)`. A 2–4px rim is a bug. Mockup A under-drew this; the
   live HTML (16px on R=64) is the pass/fail picture.

---

## Architecture

### Thin host — `IsoDioramaRenderer`

Keeps:

- Canvas init, resize, start / pause / resume
- `refreshData` (grid, biosphere, species, planet, star)
- Overlay *state*: inhabitants, tile markers, divine effects, moons, star bloom,
  siblings, space `bgLayer`
- Legacy `frame()` for lava / ice / gas (untouched)
- Projection helpers used to *place* overlays (`discToGrid` / `gridToDisc`)

For `planetType === 'ocean' | 'rocky'` the host `frame()` is:

1. Ask the engine for current geom (including bob)
2. Call `engine.frame(input)` which paints the whole habitable picture
3. Blit the low-res buffer to the display canvas

No habitable branches inside bake-crust, bake-surface, halo, dome, or cloud
construction. Those functions either disappear from the habitable path or stay
legacy-only.

### Compositor — `HabitableCutawayEngine`

Owns:

- All habitable geometry constants and `bob(elapsed)`
- Bake: crust, land (no water pixels), water occupancy mask, pick buffer
- Live: atmosphere shell, fluids, clouds (wisps clipped to the shell)
- Draw order
- Hit-test that subtracts bob and reads the pick buffer

Grows from a bake-only module into a small class with `bake`, `frame`, and
`hitTest`. Free functions (`paintCutawayCrust`, `makeWispSprite`, smoke wrapper)
may remain underneath so the existing check can still call them.

### Overlay handoff

The engine does not own settlement / creature / divine *logic*. The host passes
draw callbacks, invoked at the right stack slot, with geom already bobbed:

```ts
interface HabitableFrameInput {
  g: CanvasRenderingContext2D;
  dt: number;
  elapsed: number;
  bg: HTMLCanvasElement;
  drawFarSpace: (g: CanvasRenderingContext2D) => void;  // star bloom, siblings, far moons
  drawOverlays: (g: CanvasRenderingContext2D) => void; // settlements, creatures, markers, divine
  drawNearMoons: (g: CanvasRenderingContext2D) => void;
  weatherMix: Array<{ kind: string; weight: number }>;
}
```

Host overlay drawing uses `engine.geom` (cx, cyTop, rx, ry, bob) so sprites sit
on the moving board. The engine does not re-project the grid.

---

## Geometry

Virtual resolution stays as today: long edge ≈ 480, nearest-neighbour upscale.

Ratios locked to `diorama_test.html` (mockup A). The board is a pancake you look
straight down on; the sphere is a pedestal under it, not a globe you orbit.

| Quantity | Value | HTML @ 160×240 |
|---|---|---|
| Board squash `ry / rx` | **0.52** | 30/58 |
| Board width `rx / R` | **0.91** | 58/64 |
| Sheer wall `wall / rx` | **0.38** | 22/58 |
| Atmosphere thickness | **`max(14px, 0.25 R)`** | 16px on R=64 |
| Board centre vs body | `cyTop = cyBody − 0.67 R` | 92 vs 135 |
| Far rim vs crest | pancake **overhangs** ~`0.14 R` above crest | 62 vs 71 |
| Bob amplitude | `max(1, round(R / 48))` px | 1.5 @ R=64 |
| Bob frequency | `sin(elapsed * 0.7)` | same |

Derived placement (all integers after rounding):

- `cx = VW / 2`
- `R = min(VW * 0.40, VH * 0.28)` — atmosphere radius `R + T` (`T ≥ 0.25 R`)
  must fit in the buffer with a few pixels of space on every side. If the shell
  would clip, shrink `R` — do not shrink `T` below the 14px floor.
- `cyBody = VH * 0.56`
- `rx = 0.91 R`, `ry = 0.52 rx`
- `cyTop = cyBody - 0.67 R`

Delete `CUTAWAY_FACE_DROP`, `CUTAWAY_FACE_SQUASH = 0.50`, and
`cutawayBodyCy` / `cutawayFaceCy` as the habitable source of truth. One geom
object, owned by the engine.

ASCII:

```
        ╭──── pancake board ────╮   ← you look straight down
       /    land / live water     \
      |___________________________|  ← front rim + sheer wall
      |     geological crust       |
       \        sphere            /
        ╰──── atmo wraps R ──────╯
```

The living board leads. Do not pull it down into a 3/4 globe or leave a rock
cap above the far rim — that is mockup B/C, which was rejected. Atmosphere is a
thick shell around the sphere (`0.25 R`), including above the overhang. The
lower hemisphere is rock, not a water bowl.

---

## Layer stack (back to front)

Every habitable tick:

| # | What | Live / bake |
|---|---|---|
| 1 | Space `bgLayer` | blit (host-baked) |
| 2 | Star bloom, siblings, far moons | host callback |
| 3 | Atmosphere ring + limb tint | **live** |
| 4 | Crust (sphere rock + sheer wall) | blit, `+ bob` |
| 5 | Land tabletop (biomes, cliffs) | blit, `+ bob` |
| 6 | Water / future magma | **live**, `+ bob` |
| 7 | Host overlays | callback (already bobbed) |
| 8 | Clouds, clipped to atmosphere | **live** |
| 9 | Near moons | host callback |
| 10 | Light vignette centred on `cyBody + bob` | live |

Bake when seed, type, grid, or size changes. Surface may rebake on its existing
throttle; crust does not.

---

## Crust

Keep the current geological language: quantised key light from the upper right,
horizontal strata, jagged profile, ember flecks at depth. Change the *shape*:

1. Fill the **sphere** `R` with strata, except the interior of the tabletop
   ellipse (left transparent for land + water). Skip sphere pixels in the
   pancake region the way the HTML does (`y` above the front-mid of the ellipse).
2. No far-side rock cap above the board. Air above the pancake is atmosphere.
3. Under the front ellipse rim, a **sheer wall** of height `0.38 rx` with a
   jagged seabed, matching the HTML cut: water facets where the rim cell is
   ocean, cliff stripes where it is land.
4. No water-filled lower hemisphere. No cage lines through a hollow bowl.
5. Hard silhouette against space. No soft glow on the crust edge (atmosphere
   owns the wrap).

This is a rewrite of `paintCutawayCrust`, not a second crust renderer.

---

## Tabletop

`paintCutawaySurface` still projects `PlanetGrid` onto the ellipse (same
azimuthal helpers the host already uses, passed in as today). Changes:

- **Do not paint water.** Ocean / lake cells stay 0-alpha on the land canvas.
  Write those pixels into a `Uint8Array` occupancy mask (`1` = fluid).
- Land keeps terraced lift and biome colours (punchy palettes already in the
  engine).
- Pick buffer is written during this bake at bob-zero coordinates.

---

## Atmosphere

Port the HTML shell. This is a volume of air around the planet, not a stroke.

**Wrong:** mockup A’s thin bright rim, the current engine’s `0.045 R` hairline,
a glass dome, or a 1.45× pulsing halo.

**Right:** `diorama_test.html` terra — on R=64 the shell is 16px. You can see
air on the sun side as a fat luminous ring, dimmer on the shadow side, wrapping
the limb.

- Thickness `T = max(14, round(0.25 * R))`. The floor exists so a small buffer
  cannot collapse the shell back to a rim. At game virtual res this should read
  as tens of pixels, not two.
- Colour: existing `atmo` (ocean `(65,165,255)`, rocky a little greyer).
- Ring (drawn live, outside the sphere): for each pixel with
  `R < dist <= R + T`:
  `falloff = (1 - (dist - R) / T) ^ 1.6`
  `glow = falloff * (dx / (R + T) > -0.1 ? 0.85 : 0.28)`
  blend `atmo` by `glow`.
- Limb wrap: last `max(5, round(0.08 * R))` pixels of the sphere blend `atmo`
  at ~0.22 alpha so rock does not sit in vacuum.
- Smoke check: atmosphere ring wider than 12px at the current virtual `R`.
  Under that, the bake is wrong.

---

## Fluids

Port the HTML wave, then speed it up and add glitter.

```
wave = sin(r² * 12 - t * 3.2) + cos(px * 0.12 + py * 0.1 + t * 1.4) * 0.4
```

(`t` is the HTML `time` analogue; 3.2 / 1.4 replace 1.8 / 0.8.)

Bands, from `waterSurf`:

| Condition | Band |
|---|---|
| `wave > 0.48` | glint (HTML was 0.65) |
| `wave > 0.12` | light (HTML was 0.20) |
| `wave < -0.55` | deep |
| else | mid |

Ellipse rim (`r² > 0.94`) adds a foam lift `(+45, +45, +55)` clamped to 255.

Only pixels where the occupancy mask is set, inside the ellipse, after bob.

Rocky worlds use the same shader on their lakes. Magma is not in this pass.

Replace `drawOceanShimmer` on the habitable path. Do not paint water into the
land bake and then overlay a second shimmer.

---

## Clouds

Biosphere weather mix stays (host already computes it). Drawing moves into the
engine:

- Wisp sprites (`makeWispSprite`), not dome cumulus.
- Positions drift; wrap against the atmosphere circle, not the ellipse.
- Clip: a cloud pixel draws only if it sits inside `dist <= R + thickness`.
- Rebuild when the weather mix signature changes, same as today.

---

## Picking and overlays

- Pick buffer is baked at bob-zero.
- `hitTest(px, py)` samples `pickBuf[(py - bob) * w + px]`.
- Host `pickAt` / mouse mapping calls `engine.hitTest` for habitable worlds.
- Overlay sprites add `geom.bob` to their baked disc Y.

If bob is 2px and picking ignores it, clicks miss the cell under the cursor.
That is a required check, not a nice-to-have.

---

## Files

| File | Change |
|---|---|
| `src/rendering/HabitableCutawayEngine.ts` | Geom source of truth; crust reshape; land without water; occupancy mask; live atmo + fluids + clouds; `frame` + `hitTest` |
| `src/rendering/IsoDioramaRenderer.ts` | Habitable `frame` / bake / halo / dome / shimmer / cloud branches collapse to engine calls; picking delegates; legacy path untouched |
| `src/dev/dioramaPreview.ts` | No behaviour change required beyond exercising ocean + rocky |
| `tools/habitableDioramaCheck.ts` | Smoke: bake still non-empty; occupancy mask has both land and water; atmosphere ring **≥ 12px** thick |
| `diorama_test.html` | Reference only — do not import it into the game |

---

## Testing

1. `/diorama-preview.html?type=ocean` — pancake god-view (board leads, you look
   straight down), thick atmo shell, glittering water, geological crust (not a
   dirt bowl), 1–2px bob, wispy clouds.
2. `/diorama-preview.html?type=rocky` — same language, lakes animate, more land.
3. In-game home world — same picture; settlements sit on land; tile hover /
   click still hits the cell under the cursor while bobbing; divine overlays land
   on the board.
4. Lava / ice / gas preview types — visually unchanged.
5. `npx tsx tools/habitableDioramaCheck.ts` (or the project's existing smoke
   command) passes.

Success is visual: staring at the ocean preview should feel like the HTML file
(god's eye, alive), with better rock and the real continents.

---

## Non-goals (this pass)

- Lava / ice / gas god-view (copy this language later)
- HTML meteors, solar wind, leviathan
- Changing `PlanetGrid` or biome classification
- Authored PNG planet bodies
- Performance rewrite of the legacy disc renderer
