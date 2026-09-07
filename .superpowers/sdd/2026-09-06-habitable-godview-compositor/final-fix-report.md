# Habitable God-View Compositor: Final Fix Report

## Scope

Fixed the review findings for the habitable (`ocean` and `rocky`) compositor only. Lava, ice, and gas remain on their existing legacy paths.

## Fixes

- Water now samples baked occupancy at `py - layerBob` and uses the same integer bob for its ellipse, keeping fluids attached to the moving tabletop.
- Habitable inhabitants, settlements, and city lights add the live compositor bob when drawn.
- Divine-effect clipping uses the habitable body radius `R`; beams begin at the visible top of that body.
- The four-second surface refresh now repaints only land, occupancy, and pick data. It preserves crust, elapsed time, and wisps.
- Atmosphere and fluid `ImageData` are allocated with scratch-canvas resize and cleared/reused per frame.
- Front-wall material samples the nearest in-ellipse rim pixel, including at the limb.
- Habitable moons now use the same multiplier (`12`) as every other world.
- Geometry comments now correctly distinguish body radius `R` from top-face radius `rx`.

## Regression coverage

`tools/habitableDioramaCheck.ts` now verifies:

- fluid pixels move from their baked occupancy coordinate by the integer bob;
- `hitTest` maps bobbed coordinates to the baked rest cell;
- repeated frames allocate no live `ImageData`;
- a surface-only rebake preserves the current bob;
- a water cell at the limb produces a water wall, rather than a false land cliff.

## Verification

- `node_modules/.bin/esbuild tools/habitableDioramaCheck.ts --bundle --platform=node --format=esm --outfile=$env:TEMP/habcheck.mjs; node $env:TEMP/habcheck.mjs` — passed for ocean and rocky fixtures.
- `npx tsc --noEmit` — passed (npm emitted its existing `Unknown env config "devdir"` warning).
