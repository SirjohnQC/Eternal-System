# Orbit Sky — the home world visibly goes round its sun

Date: 2026-09-28. Branch: `feat/orbit-sky` (from `feat/surface-decals`, which
carries the merged weather sim).

## Intent

Sirjohn's words: "having the sense of the planet actually floating around the
sun". Agreed shape, in his choices:

- **The sky turns with the day** — the sun travels the sky in step with the lit
  side you already see; moons and sibling planets are lit from where it really is.
- **The year shows** — the backdrop slides slowly through the year; the sun's
  apparent size changes with real distance.
- **A bit of the orbit** — a faint orbit arc across the sky that the sun and the
  sibling planets ride.
- **The year is the simulation's real orbit** (`planetOffsetFromStar`), not a
  visual-only cycle. At current constants that is about a 3-minute year against a
  30-60 s day.
- **Camera model A:** bodies (sun, siblings, arc) move with the day; the backdrop
  does not spin daily, it only slides with the year.
- **Seasons: weather-only in this pass.** Full seasons (painted ice caps and
  vegetation) belong to the later zoom-detail pass.

Out of scope: zooming out to show the orbit from outside; the zoom-detail pass;
under-crust variation (deferred by Sirjohn).

## What is on screen today (the problems)

- `drawStarBloom` pins the sun top-left with a small wobble, while the lighting
  (`dayAngle`) swings round the disc once per day, and the weather sim now follows
  that lighting. The sun and its light disagree.
- `bakeBackground` bakes the starfield and nebula once; nothing behind the planet
  moves.
- `drawSiblings` spins sibling planets with the day plus an invented drift
  (`spin + orbitalAngle + t * orbitalSpeed * 3.5/(1+distN) + i*1.9`); their sky
  positions are not their real ones.
- `drawMoons` always darkens the same side of each moon.

Verified while designing: opening the home world does not stop the engine loop
(`BigBangEngine.loop` keeps calling `render`, which advances `animTick` every
frame regardless of game speed), so the real orbit keeps moving in the diorama.
`currentAnimTick` is public.

## Design

### 1. Sky model — `src/rendering/sky/OrbitSky.ts` (pure, no DOM)

```ts
interface SkyInput {
  animTick: number;
  home: Planet;                 // the planet the diorama shows
  siblings: Planet[];           // every other planet of the star
  starTemperature: number;
  dayAngle: number;             // the diorama's existing local solar azimuth
}
interface SkyBody { az: number; elev: number; visible: boolean; litFraction: number; litSide: number; }
interface SkyState {
  sun: { az: number; elev: number; visible: boolean; sizeScale: number; horizonWarm: number };
  siblings: Array<SkyBody & { planet: Planet }>;
  yearPhase: number;            // 0..1 through the orbit
  declination: number;          // subsolar latitude, radians (seasons)
}
function orbitSky(input: SkyInput): SkyState;
function axialTilt(genomeSeed: number): number;   // 0..35 deg, deterministic
```

- **Sky azimuth.** Sun: `az = pi/2 - dayAngle` — at dayAngle 0 the sun is on the
  +x horizon (the lit +x limb), at pi/2 overhead behind the dome, at pi on the -x
  horizon, below the horizon at night. `elev = cos(az)`, visible when `elev > 0`
  (faded near 0).
- **Everything else** is placed relative to the sun: `az = sunAz + (lonBody - lonSun)`,
  where `lon` is the direction from the home planet in the orbital plane, computed
  from `planetOffsetFromStar(p, animTick)` for home and each sibling (sun direction
  = minus home's offset). So the angle between two bodies in the sky is their real
  angle as seen from home.
- **Sun size:** `sizeScale = mean(r) / r(now)`, `mean(r)` = orbitalRadius. Near
  circular orbits change by < 2%, which is correct.
- **Phases:** a sibling's lit fraction is `(1 + cos(elongation)) / 2`, where
  elongation is its sky angle from the sun; `litSide` is the sign toward the sun.
- **Year phase:** the home planet's mean anomaly `orbitalAngle + animTick *
  orbitalSpeed`, wrapped, over 2 pi.
- **Seasons:** `declination = tilt * sin(2 pi * yearPhase)`, `tilt = axialTilt(genomeSeed)`.
- Holds no state; a new planet or a reset clock simply gives a new answer.

### 2. Sky track and orbit arc

All bodies share one elliptical sky track arching behind the diorama, the shape
`drawSiblings` uses today: `x = cx + sin(az) * A`, `y = horizonY - cos(az) * B`,
with the horizon at the diorama body's top. The track is the orbital plane seen
from the ground, so it is also the orbit arc: a dotted 1 px line, ~12% alpha,
fading into the horizon at both ends, slightly brighter for a short span either
side of the sun.

### 3. Rendering (`IsoDioramaRenderer`)

- `drawSky(g)` replaces `drawStarBloom` and `drawSiblings` inside `drawFarSpace`:
  arc, then siblings, then the sun.
- **Sun:** a hard-edged pixel disc 4-8 px by `sizeScale`, colour from
  `tempToRGB(temperature)`; bloom radius scales with `sizeScale`; the existing
  lens-flare cross moves with it; warms toward orange and fades near the horizon;
  hidden below it.
- **Siblings:** pixel discs sized as now, drawn with their phase (lit part toward
  the sun). Only the siblings above the horizon are drawn.
- **Moons:** the terminator offset takes its sign from the sun's side instead of
  a constant.
- **Backdrop:** `bakeBackground` bakes a panorama three screens wide; nebula blobs
  near an edge are drawn again one panorama-width over so it wraps with no seam.
  Each frame draws it with horizontal offset `yearPhase * panoramaWidth`
  (two blits across the wrap). The panorama width is fixed per bake, so a resize
  re-bakes it as today.
- **Clock:** `setClock(fn: () => number)` on the renderer. `main.ts` passes
  `() => engine.currentAnimTick`; without a clock the renderer counts frames
  itself (dev preview). The preview gets realistic orbital speeds and a
  `?year=N` multiplier to watch a year quickly.

### 4. Seasons in the weather sim

- `WeatherSim.sunLat` (radians), set by the engine from `declination` each frame
  like `sunLon`; standalone it stays 0 unless a test sets it.
- Daily heating uses the subsolar point's latitude:
  `sunCos = cos(lat) cos(sunLat) cos(lon - sunLon) + sin(lat) sin(sunLat)`, and the
  tropical weighting centres on `sunLat` instead of the equator.
- Snow: effective temperature for the snow decision shifts with season,
  `T_snow = T + SEASON_T * sin(lat) * sin(sunLat) / sin(35 deg)` — summer
  hemisphere warmer, winter colder. `SEASON_T` tuned against the picture.
- `HabitableCutawayEngine` receives the declination through the frame input
  (`sunLat?: number`, default 0), next to `sunAzimuth`.

## Checks

New `tools/skyCheck.ts` (pure model), each claim with a control that must fail:

1. **Sun on the lit side:** over a day, the sun is above the horizon exactly
   when the lit limb faces the viewer, on that limb's side. Control: the old
   pinned position fails.
2. **Siblings at their real positions:** at many clock values, the sky angle
   between any two bodies equals the angle between their `planetOffsetFromStar`
   directions from home, within 0.01 rad. Control: the old `drawSiblings`
   formula fails.
3. **The year turns the backdrop:** one full panorama per orbital period.
   Control: a frozen backdrop fails.
4. **Sun size follows distance:** correlation with `1/r` over a year >= 0.99 on
   an eccentric orbit; < 2% variation on a circular one.
5. **Phases:** a sibling within 30 deg of the sun is < 20% lit; within 30 deg of
   opposition > 80%. Control: always-full fails.
6. **Moons shaded away from the sun** for every sun position.

Added to `tools/weatherCheck.ts`:

7. **Snow alternates hemispheres:** at one solstice northern snow share >= 2x
   southern, reversed at the other. Control: tilt 0 stays within 1.5x.
8. **Storm belt follows the sun:** mean latitude of tropical rain moves toward
   the summer hemisphere between solstices. Control: tilt 0 shows no shift.
9. Every existing weather check still passes.

Budget, measured in the live preview: `drawSky` <= 0.3 ms per frame; weather
step stays <= 0.5 ms. Pixels: the preview through a day and a sped-up year
(including an eccentric seed), and the real game via `?dev=1&view=home`,
confirming the orbit advances there.

## Edge cases

- No star / planet yet, or no siblings: sun only, defaults (circular orbit,
  tilt 0).
- Old saves without eccentricity: `planetOffsetFromStar` already defaults it.
- New game: the engine clock restarts; the sky model is stateless, so the sky
  jumps to the new world's real position with nothing carried over.
- Gas giant home view: same sky; no weather, so no seasons.
