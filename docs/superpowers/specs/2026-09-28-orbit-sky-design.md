# Orbit Sky — the home world visibly goes round its sun

Date: 2026-09-28. Branch: `feat/orbit-sky` (from `feat/surface-decals`, which
carries the merged weather sim). Revised the same day after a review by Fable;
the review's findings are folded in and listed at the end.

## Intent

Sirjohn's words: "having the sense of the planet actually floating around the
sun". His choices:

- **The sky turns with the day** — the sun travels the sky in step with the
  disc's lighting; moons and sibling planets are lit from where it really is.
- **The year shows** — the backdrop slides slowly through the year.
- **A bit of the orbit** — a faint orbit arc across the sky that the sun and the
  sibling planets ride.
- **The year is the simulation's real orbit** (`planetOffsetFromStar`), not a
  visual-only cycle.
- **Camera model A** — bodies move with the day; the backdrop does not spin
  daily, it only slides with the year.
- **Soft night** — when the sun is below the horizon the whole face darkens, but
  capped (~60%) so the world stays readable.
- **Sun size is true** — real distance only. On his own world (eccentricity
  0-0.08) that is at most +/-8%, under a pixel: the year shows through the
  backdrop, the arc and the seasons, not the sun's size. Other worlds on oval
  orbits show it.
- **Seasons: weather-only in this pass.** Full seasons (painted ice caps,
  vegetation) belong to the later zoom-detail pass.

Out of scope: zooming out to see the orbit from outside; the zoom-detail pass;
under-crust variation (deferred).

## Facts this design rests on (verified in code)

- The engine loop keeps running while the diorama is open: `BigBangEngine.loop`
  calls `render`, which advances `animTick` every frame regardless of game speed
  (BigBangEngine.ts:2914), so **the year keeps running even when the game is
  paused**. `currentAnimTick` is public (:3008).
- `enterUniverse` (main.ts:~960) replaces the engine; the new one's `animTick`
  restarts at 0, while the diorama renderer lives all session.
- Day length: `dayPeriod = max(16, 18 + radius * 5.5)` — 20-27 s on rocky worlds.
  At the current `PLANET_ORBIT_MU` the home year is ~3 min, so ~3-9 days per year;
  the sun visibly moves against the siblings within a day.
- Today the disc can't tell noon from midnight: `paintDayNight`
  (HabitableCutawayEngine.ts:1484), `paintAtmosphere` (:1379),
  `WeatherPainter.paintShadows`/`paintClouds` and the city-light `nightBias`
  (IsoDioramaRenderer.ts:2581) use only `cos(sunAzimuth)`, identical at pi/2 and
  3pi/2. The weather sim, by contrast, already treats pi/2 as local noon.
- `drawStarBloom` pins the sun top-left; `drawSiblings` uses an invented drift
  (IsoDioramaRenderer.ts:2434) and caps at 4 siblings; `drawMoons` always
  darkens the -x side (:2498).

## Design

### 1. Sun direction, one definition — `src/rendering/sky/SunLight.ts` (pure)

With `d` the existing `dayAngle` (sunAzimuth):

- Sun sky azimuth `az = pi/2 - d`; elevation `elev = sin(d)` (= cos(az)).
  d = 0: sun on the +x horizon; pi/2: overhead behind the dome (local noon);
  pi: on the -x horizon; 3pi/2: lowest (local midnight).
- `sunLit(dx, d) = clamp01(0.38 + 0.9 * dx * cos(d) + ELEV_LIGHT * sin(d))`,
  where `dx` is disc x in -1..1. Noon lights the whole face, midnight darkens
  all of it.
- **Soft night:** every consumer caps darkness at `NIGHT_MAX` = 0.58 alpha,
  the maximum today's veil already uses (~60%).
- Used by all four lighting consumers: `paintDayNight`, `paintAtmosphere`,
  `WeatherPainter` (shadows, cloud-top lighting) and city-light night bias.
  Pure module: the weather painter may import it (it must not import the engine).
- `ELEV_LIGHT` is tuned against the picture; the check below guards it.

### 2. Sky model — `src/rendering/sky/OrbitSky.ts` (pure, stateless)

```ts
interface SkyInput {
  animTick: number;
  home: Planet;
  planets: Planet[];            // all planets of the star; siblings = p !== home
  dayAngle: number;
}
interface SkySibling { planet: Planet; az: number; elev: number; phaseAngle: number; litFraction: number; }
interface SkyState {
  sun: { az: number; elev: number; sizeScale: number };
  siblings: SkySibling[];       // every sibling, no cap; renderer culls by elev
  sunLongitude: number;         // true ecliptic longitude of the sun seen from home, radians
  declination: number;          // subsolar latitude, radians
}
function orbitSky(input: SkyInput): SkyState;
function axialTilt(genomeSeed: number): number;        // 0..35 deg
function seasonZero(genomeSeed: number): number;       // lambda0, 0..2pi
```

- Offsets from `planetOffsetFromStar(p, animTick)` for home (`h`) and each
  sibling (`s`). **Sun longitude** `lambdaSun = atan2(-h.y, -h.x)` — the TRUE
  direction, not mean anomaly (the two branches of `planetOffsetFromStar` use
  different references, and mean anomaly drifts up to 2e from the sky).
- **Sibling longitude** `lambda = atan2(s.y - h.y, s.x - h.x)`.
- **Sky azimuth, signed:** `az = sunAz + wrap(lambda - lambdaSun)`. The sign
  convention is fixed: a body at +90 deg longitude from the sun (counter-orbital
  direction) sits at az = sunAz + pi/2, i.e. it rises a quarter day after the sun.
- **Phase:** the phase angle at the sibling, `alpha = angle between (-s) and
  (h - s)` (sun seen from the sibling vs home seen from the sibling);
  `litFraction = (1 + cos(alpha)) / 2`. Outer planets are therefore always
  nearly full (a sibling at 2a stays >= 93% lit); inner planets show crescents.
  The lit side points toward the sun in the sky.
- **Sun size:** `sizeScale = a / r`, `a` = home orbitalRadius, `r` = |h|.
- **Seasons:** `declination = asin(sin(tilt) * sin(lambdaSun - lambda0))`, with
  `tilt = axialTilt(genomeSeed)` and a seeded `lambda0`.
- No star/planet: sun only, circular defaults, tilt 0.

### 3. Sky track and orbit arc

One elliptical track arches behind the diorama:
`x = cx + sin(az) * A`, `y = horizonY - cos(az) * B`, with
`horizonY = geom.cyTop`, `A = min(VW / 2 - 8, max(1.25 * rx, 0.42 * VW))`,
`B = horizonY - 12` (apex 12 px below the top edge). Works down to the
portrait width of 200 px. Bodies are drawn only when `elev > 0`, faded over
`0 < elev < 0.15`. The track is the orbital plane seen from the ground, so it is
also the orbit arc: a dotted 1 px line, ~12% alpha, fading at the horizon,
slightly brighter within +/-0.3 rad of the sun.

### 4. Rendering

- **Frame input:** `HabitableFrameInput.bg: HTMLCanvasElement` becomes
  `drawBackdrop: (g) => void`, so the host can blit a sliding panorama (the engine
  currently blits `bg` at 0,0 itself, HabitableCutawayEngine.ts:~1949).
- `drawSky(g)` replaces `drawStarBloom` + `drawSiblings` inside `drawFarSpace`:
  arc, then siblings, then the sun.
- **Sun:** hard-edged pixel disc, 5 px at `sizeScale` 1 (4-8 px range), colour
  `tempToRGB(temperature)`; bloom radius x `sizeScale`; the lens-flare cross moves
  with it; warms toward orange and fades as `elev -> 0`.
- **Siblings:** pixel discs sized as now; the phase drawn as a shaded disc offset
  toward the side away from the sun, amount from `litFraction`.
- **Moons:** continuous terminator — shadow offset `-0.3 * r * cos(d)`
  horizontally and depth by `sunLit` at the moon, not a sign flip.
- **Backdrop panorama:** `bakeBackground` bakes width `W = 3 * VW`, designed to
  tile in x: a vertical-only gradient; the nebula band's centre line is
  `y = y0 + amp * sin(2pi * x / W + phase)` (periodic), each blob also drawn at
  x +/- W; stars placed on the panorama's area (`W * VH / 900`) with bright-star
  crosses wrapped modulo W.
- **Slide:** offset `round(W * wrap01(lambdaSun / 2pi))` px; the panorama moves
  LEFT as the sun's longitude increases; two blits across the wrap. Whole-pixel
  offsets only.
- **Clock:** `IsoDioramaRenderer.setClock(fn: () => number)`. `main.ts` passes
  `() => engine?.currentAnimTick ?? 0`, reading the live module-level `engine`
  binding, never a captured instance. Without a clock the renderer counts
  nominal 60 Hz frames (dev preview). The preview gets realistic orbital speeds
  (derived from `PLANET_ORBIT_MU`) and `?year=N` to multiply the clock.

### 5. Seasons in the weather sim

- `WeatherSim.sunLat` (radians). The engine sets it from `declination` each
  frame next to `sunLon`, and **before `warmUp` at bake** (bake gets
  `sunLat?: number`; frame input gets `sunLat?: number`, default 0).
- Heating: `sunCos = cos(lat)cos(sunLat)cos(lon - sunLon) + sin(lat)sin(sunLat)`.
  The tropical weighting centres on `sunLat`: weight
  `max(0, 1 - |lat - sunLat| / 30 deg)`. These sunLat-dependent row terms are
  computed **every step** — `buildRows` only reruns when the climate object
  changes, so caching them there would make seasons silently do nothing.
- Snow: `T_snow = T + SEASON_T * sin(lat) * sin(sunLat) / sin(35 deg)`; the
  summer hemisphere is warmer, the winter one colder. `SEASON_T` tuned against
  the picture.
- When the host drives the sun, the sim's own per-step `sunLon` advance is
  overwritten each frame; the drift between frames is under one step.
- Stylisation, documented: the sky puts the noon sun overhead for the viewed
  face; the weather's subsolar point is at `sunLat`.
- On a world whose grid east maps to -x (`weatherEast = -1`) the sun rises in
  the grid's west; harmless, documented.

## Checks

New `tools/skyCheck.ts`. Every claim is checked against an independent fixture
or a rendered output, never against the value it was computed from, and each
has a control that must fail.

1. **Disc light follows the sun's elevation (soft night).** Rendered
   `paintDayNight` mean brightness over the face correlates with `sin(d)` over a
   day (r >= 0.9); midnight darker than noon by a clear margin; darkest veil
   alpha <= `NIGHT_MAX`. Control: today's cos-only veil (identical at pi/2 and
   3pi/2) fails.
2. **Sun screen position matches the light.** Using the renderer's track
   mapping: `sign(sunX - cx) == sign(cos d)` and `visible <=> sin d > 0`, over a
   day. Control: the pinned top-left sun fails.
3. **Siblings at their real, signed positions.** Fixtures with known geometry
   (home on the x axis, sibling placed at a known longitude): the signed sky
   offset from the sun equals the known longitude difference within 0.01 rad; a
   sibling at +90 deg rises a quarter day after the sun. Also random clock values
   against a second, independent computation from the raw offsets. Control: the
   old `drawSiblings` formula, and a mirrored sign, both fail.
4. **Phases.** Against an independently computed phase angle: an inner-planet
   fixture near inferior conjunction is < 20% lit; the same planet near superior
   conjunction > 80%; an outer planet at 2a is >= 90% lit at every position.
   Control: `(1 + cos(elongation)) / 2` fails.
5. **Sun size.** Rendered sun diameter on an e = 0.3 fixture: periapsis vs
   apoapsis ratio within 1 px of `(1+e)/(1-e)`; e = 0 fixture varies by 0 px.
   Control: constant size fails.
6. **The backdrop tiles and turns once per year.** Seam metric: difference
   between the panorama's first and last columns is no larger than the median
   difference between adjacent interior columns. Control: today's bake stretched
   to 3 x VW fails. Turn: over one orbital period (fixture `2pi / orbitalSpeed`
   ticks) the rendered offset advances exactly W, leftward. Control: frozen
   offset fails.
7. **Moons shaded away from the sun:** the dark side of a rendered moon is on
   the side opposite the sun, for sun positions around the day.

Added to `tools/weatherCheck.ts`, across several seeds of worlds that have cells
near `COLD` (lava and desert excluded):

8. **Snow follows the seasons.** For the same hemisphere, snow share at its
   winter solstice minus at its summer solstice. Threshold: >= 3x the tilt-0
   noise floor (the same difference measured with tilt 0 across the same
   seeds) and >= an absolute minimum. Control: tilt 0.
9. **Storm belt follows the sun.** Mean latitude of convective rain, northern
   summer minus southern summer, over the same seeds. Threshold >= 3x the tilt-0
   noise floor. Control: tilt 0.
10. **Nothing else breaks.** The existing weather suite also runs at maximum
    tilt at a solstice, not only at `sunLat = 0`.

Budget, measured in the live preview: `drawSky` <= 0.3 ms per frame; weather
step stays <= 0.5 ms; panorama is ~1.5 MB of pixels at 480 px. Pixels: the
preview through a day and a sped-up year (including an e = 0.3 fixture), and the
real game via `?dev=1&view=home`, confirming the orbit advances there and after
a new game.

## Edge cases

- No star / planet / siblings: sun only, defaults.
- Old saves without eccentricity: `planetOffsetFromStar` defaults it.
- New game: new engine, clock restarts; the renderer reads the live binding and
  the sky model is stateless, so the sky jumps to the new world's real position.
- Siblings are excluded by identity (`p !== home`), not by index, so a merger
  cannot make the home world its own sibling.
- Gas giant home view: the same sky (every body goes through the cutaway path);
  no weather, so no seasons.
- Game paused: the year keeps running (see Facts).

## Review findings folded in (Fable, 2026-09-28)

Blocking: disc lighting had no elevation term (section 1); phase formula was
inverted and physically wrong (section 2). Should-fix: checks that passed by
construction (Checks); backdrop seam (section 4); unspecified slide direction,
backdrop draw site, track size, sibling cap, moon terminator (sections 3-4); mean
vs true longitude (section 2); cached season terms and warm-up sunLat
(section 5); fragile season checks (checks 8-10); invisible sun size and the
day-length figure (Intent, Facts); stale clock and index-based sibling
exclusion (section 4, Edge cases).
