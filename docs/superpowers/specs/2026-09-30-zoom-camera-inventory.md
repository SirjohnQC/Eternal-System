# Zoom camera — constant inventory

Companion to `2026-09-30-zoom-camera-design.md` (section 2). Written by plan
Task 1 against commit `0670253` (pre-change code); line numbers refer to that
commit. Every fixed-pixel constant, per-px frequency, px-keyed hash and geometry
computation that bypasses `HabitableGeom` on the habitable (cutaway) path, with
the scale class it belongs to and the task that converts it.

**Classes** (k = rendered camera zoom; Global Constraints of the plan):

| class | conversion |
|---|---|
| world | x k |
| sprite | x round(k), nearest-neighbour |
| stroke | stays 1 px (or its fixed px) |
| per-pixel | resamples: the loop runs per output pixel of the camera geometry, bounded to canvas + relief margin (`y <= VH - 1 + maxLift * k`) |
| world-anchored texture | per-px frequencies / k; px distances x k; 1-px-line thresholds / k; hashes re-keyed on world coords (`screenToWorld`, floored at base resolution) |
| screen | unchanged (canvas coordinates) |
| far | x `farScale(k) = 1 + 0.1 (k - 1)` about the focus (backdrop, sky) |

Where a value is expressed in disc-normalised units (`dx = (px - cx) / rx`,
`r`, band fractions) it already follows the camera geometry and needs no code
change; those rows say "none (disc-normalised)" so the reviewer can see they
were considered.

**Owning task**: 3 sub-cell elevation; 4 crust / surface / shore / pick;
5 fluids / day-night / atmosphere / weather / vignette / gas rings;
6 placement / sky / moons / markers / effects. `—` = no conversion (kept for
completeness). Rows marked **(flag)** are judgement calls or items the spec
does not name; see the notes at the end.

---

## Out of scope

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| IsoDioramaRenderer 476-478 (+ every `!this.habitable` branch) | legacy Canvas path: `usesCutaway` is always `true`, so these never run — non-habitable `bakeCrust` (1196+), `bakeSurface` (1468+), `bakeGasGiant` (1718), the non-habitable half of `frame()` (2268-2361: halo, `drawOceanShimmer` 2514, `drawEmbers` 2708 (uses `Math.random`), `drawDome` 2773, `drawHaze` 2857, legacy vignette), `buildRipples` (2210; built on the habitable path but only read by `drawOceanShimmer`), `cutH`/`crustH` (541/543), `LIFT_STEP` (88) and the legacy branches of `maxLift` (1013) / `liftOf` (1042-1049), `PALETTES` | — | out of scope | none | — |

---

## HabitableCutawayEngine.ts

### Geometry and layout

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 133-138 | `BOARD_SQUASH`, `BOARD_WIDTH`, `WALL_RATIO`, `ATMO_RATIO`, `ATMO_MIN_PX`, `CY_TOP_DROP` | 0.52, 0.91, 0.38, 0.25, 14 px, 0.67 | world | none in place: they lay out the BASE geometry; `applyCamera` scales the result (`R, rx, ry, wall, T` x k) | 4 |
| 141 | `FRAME_MARGIN_PX` | 4 px | world | none: base layout only (`layoutAt`, `habitableGeom`) | — |
| 183-216 | `layoutAt` / `habitableGeom` | base geometry | world | camera geometry = `applyCamera(habitableGeom(VW, VH), cam)`; never re-run `habitableGeom` for a camera | 4 |
| 148 | `ozoneFadeMax(t)` | `t * 1.6 + 2` | world | called with `thicknessPx * k`; the `+2` feather x k (spec 2) | 5 |
| 153 | `crustDepthOf(rx)` | `max(8, round(rx * 0.88))` | world | rx is camera rx; floor 8 x k | 4 |
| 158 | `keelBottomOf` | `+ 3` ridge allowance | world | base layout only; x k if ever used on camera geometry | — |
| 1091-1092 | `paintCutawayCrust`: `fallback = habitableGeom(VW, VH)` for `wall` | geometry bypass | world | always pass the camera `wall` in opts; drop the fallback on the camera path | 4 |
| 1095 | crust early-out | `rx < 8` | world | 8 x k (or test base rx) | 4 |
| 1235-1239 | `cakeAirLimit` inset | 1.25 px | stroke | no callers in `src/` (dead export); leave | — |

### Top face (`paintCutawaySurface`, 768-1002)

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 775-778 | face bounding box `x0,x1,yFace0,y1` | ellipse box clamped to canvas | per-pixel | clamp to canvas + relief margin (`y1 = VH - 1 + maxLift * k`) | 4 |
| 782 | `yTop = yFace0 - opts.maxLift` | maxLift 18 | world | `maxLift * k` (wrapped opts) | 4 |
| 873-878 | nearest-cell `discToGrid` + `cell.elevation - rimFalloff(r)` for land/water | nearest cell | per-pixel | `elevationAt(dx, dy)` (bilinear sub-cell) for the land/water decision; biome colour stays nearest cell | 3 |
| 822-823 | gas turbulence `latN*7.5 + dx*1.6`, `latN*22 + dx*4.0` | disc units | world-anchored texture | none (disc-normalised) | — |
| 830 | gas curl `latN*60 + dx*9` | disc units | world-anchored texture | none (disc-normalised) | — |
| 828, 834 | gas band edge `ft0 < 0.16 / > 0.84` blend, `ft0 < 0.08` dark edge line | ~1.2 px line at k=1 | world-anchored texture | 0.08 is a 1-px-line threshold: `/ k` so the band edge stays 1 px **(flag)** | 4 |
| 837, 923 | rim occlusion `(r - 0.70) / 0.30` | disc units | world | none (disc-normalised) | — |
| 919, 921 | relief/key quantise steps | colour | — | none | — |
| 915-916 | relief slope neighbours `col + 2`, `row - 2` | grid cells | — | none (grid space) | — |
| 924 | surface grain `hash1(px * 911 + py * 31, seed)` | px-keyed hash | world-anchored texture | re-key on `screenToWorld(px, py)` floored at base resolution | 4 |
| 930-935 | rim foam ring `r > 0.972` (0.42), `r > 0.988` (0.85) | ~3 px + ~1.3 px ring at rx 105 | world-anchored texture | 1-px-line thresholds: `1 - (1 - 0.972) / k`, `1 - (1 - 0.988) / k` (spec 2 "rim foam ring") | 4 |
| 943 | coast outline band `SEA_LEVEL - 0.009 .. SEA_LEVEL + 0.014` | elevation band ~1 px wide | world-anchored texture | band / k (spec 2 "coast outline band"); evaluated on `elevationAt` after Task 3 | 4 |
| 949 | `lift = liftOf(smoothElevation(row,col) - rimFalloff(r))` | 3/6/9/13/18 | world | lift x k (wrapped `liftOf`); input from `elevationAt` | 3 (input), 4 (x k) |
| 957-964 | cliff fill `for k = 1..lift` + `shadeK = 0.78 + 0.14 k/lift` | O(lift) per pixel | per-pixel | per-column near-to-far depth pass, each pixel written once; shade ramp follows the scaled lift | 4 |
| 966 | sunward plate `dx > 0.05` | disc units | — | none | — |
| 980-988 | cliff punch loop over `yTop..y1` | full box | per-pixel | bounded like the face box | 4 |
| 992-995 | `planSurfaceDecals` + `stampDecals` per bake | planned per bake in screen px | sprite | plan ONCE at identity, store world coords; stamp through `worldToScreen`, sprite x round(k) | 6 (Task 4 re-stamps the identity plan until 6 lands) |
| 999-1001 | `paintVolcanoChimneys(planVolcanoChimneys(opts))` per bake | planned per bake | sprite | plan once, store world; paint through camera | 6 |

### Volcano chimneys (1016-1078)

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 1020-1021 | chimney scan box | ellipse box, `yFace1` clamped to `VH-1` | per-pixel | identity plan only | 6 |
| 1022, 1024 | lattice `py += 2`, `px += 2` | 2 px screen lattice | world | identity plan only (stored), never re-run per camera | 6 |
| 1027, 1033 | `r > 0.88 / < 0.12`, `elev < 0.70` | disc / elevation | — | none | — |
| 1034 | `hash1(px * 733 + py * 197 + seed, seed ^ 0x71) < 0.955` | px-keyed hash | world-anchored texture | identity plan only (stored) | 6 |
| 1036 | spacing `rx * 0.14` | rx-relative | world | identity plan (base rx) | 6 |
| 1038 | `h = max(6, 5 + floor(lift*0.7) + floor(hash(px+py)*4))` | px | world | stored in base px, drawn x k (spec 2 "chimney heights") | 6 |
| 1039 | `w = 2 + floor(hash*2)` | 2-3 px | world | stored base px, drawn x k | 6 |
| 1040 | `y: py - lift` | screen y | world | store world y (base lift) | 6 |
| 1041 | cap `sites.length >= 10` | count | — | none (identity plan) | — |
| 1057, 1060 | cone half-width, 1-row fills | px rows | world | rows x k (cone is world-sized) | 6 |
| 1063 | lit right flank `fillRect(x+half-1, y, 1, 1)` | 1 px | stroke | stays 1 px | 6 |
| 1066-1076 | crater rim 5x2, throat 3x2, core 1x2, plume stubs 1x3 / 1x2 at `tipY-1..-8` | fixed px | sprite | x round(k) **(flag: could be world)** | 6 |

### Crust (`paintCutawayCrust`, 1087-1218)

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 1097-1098 | `rimX0/rimX1` columns | clamped to canvas | per-pixel | bounded; column index `i` must not key any hash (see 1152, 1168) | 4 |
| 1108 | wall ridge `fbm1(x * 0.075, seed+77, 3) - 0.5) * 5` | freq 0.075/px, amplitude 5 px | world-anchored texture | key on world x (freq / k); amplitude 5 x k (spec 2 "ridge amplitude") | 4 |
| 1110 | `waterBand = max(6, round(wall * 0.40))` | floor 6 px | world | floor 6 x k (spec 2 "water band minimum") | 4 |
| 1113-1114 | water test reads `occupancy[rimY*VW + x]` | reads occupancy | per-pixel | `bake()` paints the crust while occupancy is all zeros, so at identity the wall is rock below the band everywhere; the camera re-bake keeps the order: zero occupancy, crust, surface | 4 |
| 1116-1119 | front-wall pixel loop | per column `ceil(frontY)..floor(bottomY)` | per-pixel | bounded to canvas | 4 |
| 1125 | wall facet stripe `x % 14 === 0` | px-keyed stripe, 1 px wide | world-anchored texture | key on world x (every 14 base px), stripe width stays 1 px | 4 |
| 1147 | keel bowl `(1 - dxn^2)^1.35` | disc units | — | none | — |
| 1148-1150 | keel jag `fbm1((x-cx)*0.038)`, `*0.14`, `*0.48` | per-px freqs | world-anchored texture | freq / k (key on world x) (spec 2 "keel jag frequencies") | 4 |
| 1151 | spur `fbm1((x-cx)*0.048)` | per-px freq | world-anchored texture | freq / k | 4 |
| 1152 | cleft `hash1(i * 17, seed + 5) > 0.82` | keyed on clamped column index | world-anchored texture | re-key on world column (spec 2 "clamped column indices") | 4 |
| 1160-1166 | profile smoothing, 2 passes of `[1,2,1]/4` over columns | kernel in px | world-anchored texture | kernel radius x k (or smooth at base resolution, then resample) **(flag)** | 4 |
| 1168-1169 | ledge quantum `2 + round(fbm1(i * 0.035) * 3)` | 2-5 px, keyed on column index | world-anchored texture | quantum x k; freq keyed on world column (spec 2 "ledge quantum") | 4 |
| 1172-1175 | median-of-3 over columns | 1-column window | world-anchored texture | window x k **(flag)** | 4 |
| 1178 | `strataSpan = ry + wall + crustH` | geometry | world | none (follows camera geometry) | — |
| 1182 | skip `depth < 2` | 2 px | world | 2 x k | 4 |
| 1185 | keel light `0.55 + 0.62 * clamp01(dxn*0.9 + 0.45)` | disc units | — | none | — |
| 1187-1192 | keel pixel loop `y < depth` | per column | per-pixel | bounded to canvas | 4 |
| 1195-1196 | strata wave `fbm1(x * 0.022)`, `fbm1(x * 0.075)` | per-px freqs | world-anchored texture | freq / k (spec 2 "strata") | 4 |
| 1199 | lip rows `y < 3 ? (3 - y) / 3` | 3 px | world | 3 x k (spec 2 "lip rows") | 4 |
| 1200 | rock grain `hash1(x * 733 + y * 13, seed)` | px-keyed hash (y = row below wall) | world-anchored texture | re-key on world (x, y) | 4 |
| 1201 | streak `fbm1(x * 0.09 + y * 1.7)` | per-px freqs | world-anchored texture | freq / k | 4 |
| 1204-1205 | strata edge `frac < 0.07` dark, `< 0.16` bright | ~2 px / ~3 px at k=1 | world | none (band-fraction, grows with the band) **(flag: not a 1-px line at k=1)** | 4 |
| 1206 | ember `t > 0.78 && hash1(x*179 + y*991, seed+19) > 0.986` | px-keyed hash, 1-px dot | world-anchored texture | re-key on world; dot stays 1 px (stroke) | 4 |
| 1211-1213 | ember glow under keel `fillRect(x, top+depth-2, 1, 2)` | 2 px | world | 2 x k | 4 |
| 1215-1216 | keel underside outline `fillRect(x, top+depth-1, 1, 1)` | 1 px | stroke | stays 1 px | 4 |

### Shore distance and pick

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 1508-1526 | `bakeShoreDistance` seed + BFS over `w*h` | distances in screen px | per-pixel | bake on the canvas plus a margin of `FOAM_REACH * k` so edge water gets true distances; consumers convert px (see fluids) | 4 |
| 1540 | diagonal step 1.414 / 1 | px metric | — | none (metric is per screen px; consumers divide by k) | — |
| 1546-1560 | 2 blur passes `(2c + 4 neighbours) / 6` | 1-px kernel | world-anchored texture | passes x k or blur at base resolution **(flag)** | 4 |
| 1874, 2059-2065 | `pick` buffer / `hitTest(px, py)` | screen px of the rendered layer set | per-pixel | camera set has its own pick; `hitTest` reads the ACTIVE set | 4 |

### Atmosphere (`paintAtmosphere`, 1363-1463)

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 1226-1229 | `atmoHazeAmount(viewZoom)` `(z - 1) / 1.5` | CSS zoom | — | pass the RENDERED camera zoom when the camera set is shown (spec 5) | 5 |
| 1381 | `fade = chan.thicknessPx` | 8-? px per genome | world | `thicknessPx * k` | 5 |
| 1388 | `wobbleSeed = hue * 7.13 + thicknessPx * 31.7` | seed | — | keep the UNSCALED thickness (spec 2) | 5 |
| 1391 | `fadeMax = ozoneFadeMax(fade)` | `+2` px | world | `+2` x k (row 148) | 5 |
| 1392 | `aerialReach = rx * 0.35` | rx-relative | world | none (follows camera rx) | — |
| 1393-1396 | dome box `x0..x1, y0..y1` | clamped to canvas | per-pixel | bounded | 5 |
| 1415 | `localFade = max(3, fade * (1 + n * WOBBLE_AMP))` | floor 3 px | world | floor 3 x k (spec 2) | 5 |
| 1425 | `sigmaL = localFade * 1.15` | derived | world | none | — |
| 1430 | face blend `(face - 0.82) / 0.36` | disc units | — | none | — |
| 1448-1450 | band blend-in over `(y - cy) / 6` rows | 6 px | world | 6 x k **(flag: not named in spec)** | 5 |
| 1255-1305 | `ozoneAt`, `rimBandAt`, `rimTaper` | from geom | per-pixel | none (read camera geometry) | — |

### Day/night (`paintDayNight`, 1469-1494)

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 1477-1480 | face box, per-pixel terminator | disc units | per-pixel | none beyond camera geometry + bounds; terminator resamples crisp | 5 |

### Fluids (`paintFluids`, 1625-1792) and water constants

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 1598 | `SWELL_K` | 0.30 rad/px (~21 px wavelength) | world-anchored texture | / k | 5 |
| 1599 | `SWELL_W` | 1.6 rad/s | — | none (time) | — |
| 1600 | `SWELL_DISP_PX` | 1.4 px | world-anchored texture | x k | 5 |
| 1601 | `SWELL_DISP_SHORE_PX` | 2.8 px | world-anchored texture | x k | 5 |
| 1604 | `FOAM_REACH` | 5 px | world-anchored texture | x k (also the shore-bake margin) | 5 |
| 1606 | `CAUSTIC_FADE` | 14 px | world-anchored texture | x k | 5 |
| 1607 | `WEB_GLINT` | 0.028 (1-px glint line) | world-anchored texture | / k | 5 |
| 1608 | `WEB_HALO` | 0.055 | world-anchored texture | / k (spec 2 "halo") | 5 |
| 1636-1639 | fluid box | clamped to canvas | per-pixel | bounded | 5 |
| 1649 | `cellScale` | 0.042 ice / 0.055 desert / 0.048 other, per px | world-anchored texture | / k | 5 |
| 1666 | `lx = px - cx + 4096`, `ly = sourceY - cyTop + 4096` | body-relative SCREEN px | world-anchored texture | body-relative WORLD coords: `(px - cx) / k + 4096` | 5 |
| 1702 | fallback `toward = rl * rx` | camera px | world | none (consistent with `SWELL_K / k`) | — |
| 1707 | `detail` `shore - FOAM_REACH * 0.35`, `/ CAUSTIC_FADE` | px | world-anchored texture | via the converted constants | 5 |
| 1714 | `nearShore = 1 - shore / FOAM_REACH` | px | world-anchored texture | via `FOAM_REACH * k` | 5 |
| 1734 | grain `noise2(lx * 0.23, ly * 0.23)` | per-px freq | world-anchored texture | / k (via world `lx, ly`) | 5 |
| 1738 | blob `noise2(lx * 0.07 + 3.1, ly * 0.07 + blobY)` | per-px freq | world-anchored texture | / k | 5 |
| 1743 | `glintCut = WEB_GLINT + swell*0.25 + (1-detail)*0.045` | 1-px line threshold | world-anchored texture | whole threshold / k | 5 |
| 1749 | depth ramp `(shore - 2.5) / 16` | 2.5 px, 16 px | world-anchored texture | x k (spec 2 "depth ramp") | 5 |
| 1757 | whisper web `WEB_GLINT + 0.012 + swell*0.15` | 1-px line threshold | world-anchored texture | / k | 5 |
| 1764-1766 | shore foam dither `(grain - 0.5) * 0.55` | via grain | world-anchored texture | follows world grain | 5 |
| 1771 | magma drift `sin(lx*0.055 - ly*0.04) * 2.4` | per-px freqs, 2.4 px | world-anchored texture | freq / k, amplitude x k | 5 |
| 1772-1773 | magma wave `(toward + drift) * 0.22`, `* 0.09` | per-px freqs | world-anchored texture | / k | 5 |
| 1780-1784 | fluid rim brighten `r2 > 0.94` | ~3 px ring | world-anchored texture | 1-px-line rule: `1 - (1 - 0.94) / k` in r2 terms (spec 2 "rim foam ring") **(flag: ~3 px, not 1 px)** | 5 |

### Frame, weather hookup, vignette, gas rings

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 1883-1892 | `bake()` order: `surfaceBakeOpts = bakeOpts` (identity geom), crust painted while `occupancy` is all zeros, then surface | identity only | world | camera re-bake (`setCamera`) keeps the order (zero occupancy, crust, surface, shore, pick) with its OWN stored opts at the camera geometry | 4 |
| 1922-1926, 1937-1940 | `rebakeSurface()` / `updateSurfaceOpts()` repaint from the stored identity `surfaceBakeOpts` | identity only | world | repaint BOTH sets from their own stored opts; merge the patch into both (spec review: stale `surfaceBakeOpts`) | 4 |
| 1894-1918 | `bake()` builds a fresh `WeatherSim` (also on resize, via `bakeAll`) | per bake | — | `setCamera` and resize keep the sim; only a new planet resets it (Task 7 wiring) | 4 |
| 1901-1902 | `buildWeatherLut(this.geom, discToGrid, liftOf(smoothElevation - rimFalloff))` | full geom, nearest-cell lift | per-pixel | camera geometry, clamped lookup; ground lift from `elevationAt` (3) x k (5) | 3, 5 |
| 1917 | `new WeatherPainter(lut, climate, (maxLift ?? 18) + 6, seed)` | cloud lift 24 px | world | `(maxLift + 6) * k`; a NEW painter per camera set (spec 5) | 5 |
| 1959-1960, 1968, 1988, 1999, 2012 | `drawImage` of crust/land/fluid/weather/atmo at `(0, layerBob)` | identity set | per-pixel | draw the ACTIVE set | 5 |
| 1985, 1992 | `atmoHazeAmount(input.viewZoom ?? 1)` | CSS zoom | — | rendered zoom when the camera set is shown | 5 |
| 2018-2025 | vignette centre `(geom.cx, geom.cyBody)`, inner `rx * 0.7`, outer `max(w,h) * 0.75` | engine geom | screen | compute from the BASE geometry, never the camera geometry | 5 |
| 2037 | rings `ringInner = rx*1.28`, `ringOuter = rx*1.92`, `ringRy = 0.20` | rx-relative | world | none (follows camera rx) | — |
| 2044 | ring step `rr += 1` | 1 px spacing | world | spacing x k (iterate base-space rings: count unchanged) | 5 |
| 2051 | ring `lineWidth = 1` | 1 px | stroke | stays 1 px | 5 |
| 2042 | ring clip rect split at `cy` | geom | — | none | — |

---

## IsoDioramaRenderer.ts (habitable path only)

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 390-391 | `MIN_ZOOM`, `MAX_ZOOM` | 1, 4 | — | none | — |
| 613 | `targetLong` | 480 px | screen | none (canvas stays 480) | — |
| 649, 673, 711-712, 717-720 | wheel factor 0.86/1.16, drag slop 36 px², pan clamp, CSS `translate() scale()` | screen px | screen | none; Task 7 derives the camera via `cameraFromView` and sets CSS identity after settle | — |
| 485-527 | `cx`, `cy`, `rx`, `ry`, `bodyCy` getters read `cutaway.drawGeom` | engine geometry | world | placement/sky must read the BASE geometry; draws read the ACTIVE geometry — split once `drawGeom` exposes the camera set (Task 4) | 6 |
| 895-919 | `discToGrid` nearest cell (`round` row, `floor` col) | nearest | per-pixel | add fractional `discToGridF`; nearest stays for picking and biome | 3 |
| 1060-1076 | `smoothElevation` 3x3, centre weight 4 | per cell | per-pixel | `elevationAt(dx, dy)`: bilinear over 4 cells of the smoothed field | 3 |
| 994-997 | `rimFalloff` `(r - 0.34) / 0.66`, `* 0.30` | disc units | — | none | — |
| 1007-1012 | `maxLift` | 18 px | world | x k (spec 2: also bounds the surface/crust boxes, weather ground lift, chimneys) | 4 |
| 1033-1039 | `liftOf` habitable tiers | 3 / 6 / 9 / 13 / 18 px | world | x k via the wrapped bake `liftOf` | 4 |
| 1078-1080 | `liftAtCell` for props | tiers | world | placement stores base lift; draw x k | 6 |
| 954-961 | `pickTile`: `px = round((clientX - rect.left) * VW / rect.width)` → `hitTest` | virtual px of the CSS-transformed canvas | per-pixel | after settle CSS is identity and `hitTest` reads the camera pick (Task 4); wiring in Task 7 | 4 |
| 1134-1138 | bake opts `discToGrid`, `liftOf`, `maxLift: this.maxLift` | callbacks | world | add `elevationAt` (3); engine wraps `liftOf`/`maxLift` by k (4) | 3, 4 |
| 1185-1190 | `bakeBackground`: `bakeBackdrop(img, { seed, vw: VW })` into `backdropWidth(VW)` | identity panorama | far | re-bake at `farScale(k)` on settle; identity keeps today's | 6 |
| 1902-1903 | `buildCityDots`: `MAX = 55`, lattice `step = 2` | 2 px screen lattice | world | plan once at identity, store `wx, wy` + cell | 6 |
| 1910 | city dot disc limit `> 0.98` | disc units | — | none | — |
| 1918 | `y: py - liftAtCell(...)` | screen y | world | store world y | 6 |
| 2556-2569 | `drawCityLights`: `fillRect(dot.x, dot.y + layerBob, 1, 1)`, glow `3x1`, `1x3` | 1 px / 3 px cross | stroke | position via `worldToScreen`; sizes stay | 6 |
| 2561 | `dx = (dot.x - cx) / rx` night bias | disc units | — | none, but use matching (world, base) coords | 6 |
| 1963-1964 | `MAX_CREATURES = 42`, `MAX_SETTLEMENTS = 13` | counts | — | none (identity plan) | — |
| 1978-1981 | inhabitant lattice `step = 3`, `sampleKey = round(px/3),round(py/3)` | 3 px screen lattice, px-keyed | world | identity plan only, stored world coords | 6 |
| 1987 | `r > 0.97` | disc units | — | none | — |
| 2001, 2017 | `y: py - lift` | screen y | world | store world y (base lift) | 6 |
| 2033-2052 | `scatter` shuffle from `Stream(planetSeed ^ 0x5bf03635)` | seeded | — | identity plan only | 6 |
| 2055 | creature min spacing `rx * 0.075` | rx-relative | world | identity plan (base rx) | 6 |
| 2062, 2120 | `depth = (spot.y - (cy - ry)) / (ry * 2)` | screen px | world | compute from stored world y + base geom | 6 |
| 2063 | `dioramaCreatureSprite(genome, phase, depth)` baked at on-screen size | sprite px | sprite | x round(k), nearest-neighbour | 6 |
| 2077-2078 | coast search `rad < 48`, `16` directions, in lattice steps | lattice units | world | identity plan only | 6 |
| 2098, 2111, 2113 | `dCoast / 6`, `dCoast >= 2`, pool `max(60, n >> 2)` | lattice units / counts | — | identity plan only | 6 |
| 2116 | settlement min spacing `rx * 0.13` | rx-relative | world | identity plan (base rx) | 6 |
| 2119-2126 | settlement `target = (5 + min(civ,6)*0.7) * (0.85 + depth*0.3)`, `max(3, ...)` | px | sprite | x round(k), nearest-neighbour | 6 |
| 2144 | inhabitants clip `ellipse(cx, cy, rx, ry)` | active geom | world | active (camera) geometry | 6 |
| 2151 | idle bob `sin(...) * 0.6` | 0.6 px | sprite | x round(k) | 6 |
| 2152-2156, 2201-2204 | `drawImage(sprite, round(x - w/2), round(y + layerBob - h), w, h)` | 1:1 blit | sprite | position via `worldToScreen`; size x round(k), no smoothing | 6 |
| 2176, 2197 | waterline `round(h * (1 - submersion))`; meniscus `fillRect(dx, sunk + line, w, 1)` | 1 px line | stroke | waterline scales with sprite; meniscus stays 1 px | 6 |
| 2246 | `viewZoom: this.viewZoom` into `cutaway.frame` | CSS zoom | — | engine chooses rendered vs CSS zoom (row 1985) | 5 |
| 2250, 2261 | moon angle `elapsed * 2pi / 60` | time | — | none | — |
| 2364-2369 | `drawBackdropPanorama`: `backdropOffset(sunLongitude, W)`, `drawImage(bgLayer, -off, 0)` | panorama px | far | offset in the far-scaled panorama; about the focus | 6 |
| 2382-2402 | `drawSunWash`: `R = L.bloom * bloomScale(...)`, box clamp to VW/VH | far layout | far | uses `farLayout(L, cam)` | 6 |
| 2408-2411 | `drawSky`: `geom = this.cutaway.drawGeom`; `L = skyLayout(geom, VW, VH)` | geometry bypass (active geom) | far | `skyLayout(BASE geom)` then `farLayout(L, cam, VW, VH)` | 6 |
| 2421 | sibling `radiusPx = max(1.2, (2.2 + radius*0.20) / (1 + distN*0.7))` | px | far | x farScale(k) | 6 |
| 2459-2463 | moon orbit `x = cx + cos(a) * rx * (1.55 + i*0.34)`, `y = cyTop - ry*1.35 + sin(a) * R*0.38` | geometry-relative | world | none beyond the active geometry (x k via rx, ry, R) (spec 2 "moon orbit radius") | 6 |
| 2466 | moon radius `max(2, rx*0.05 + m.radius*3.2)` | floor 2 px, `3.2` px per unit | world | floor and `m.radius*3.2` term x k (spec 2 "moon size") | 6 |
| 2471 | halo `r * 1.9` | derived | world | none | — |
| 2484, 2497 | detail radius floors `max(0.6, ...)` | 0.6 px | world | x k | 6 |
| 2488, 2508 | crack / colony ring `lineWidth = 1` | 1 px | stroke | stays 1 px | 6 |
| 2505 | colony lights `fillRect(..., 1, 1)` | 1 px | stroke | stays 1 px | 6 |
| 2584, 2593 | effect `reach = rx * 0.85` / `rx * 0.28` | active rx at cast | world | store in world units (base rx) at cast time | 6 |
| 2586-2592 | effect centre `cx + d.dx * rx`, `cy + d.dy * ry - liftAtCell` | active geom at cast | world | store world centre (spec 3) | 6 |
| 2602 | mote radius `sqrt(u) * reach * 0.8` | reach-relative | world | follows stored reach | 6 |
| 2608 | falling mote start `- s.range(10, 34)` | px | world | x k (store world) | 6 |
| 2609 | mote `vx` `4..10` falling, `1..4` rising px/s | px/s | world | x k | 6 |
| 2610 | mote `vy` `10..24` falling, `9..22` rising px/s | px/s | world | x k | 6 |
| 2641 | effect clip `arc(cx, bodyCy, R - 1)` | active geom, `-1` px | world | active geometry; `-1` stays | 6 |
| 2650 | wash radius `reach * (1 + t * 1.6)` | reach-relative | world | none beyond reach | 6 |
| 2663-2664 | beam `beamW = max(3, reach * 0.28)`, `beamTop = bodyCy - R + 1` | floor 3 px | world | floor x k | 6 |
| 2678, 2683 | ring `rr = reach * rt`, `rr * (ry / rx)` | reach-relative | world | none | 6 |
| 2681 | ring `lineWidth = max(1, 2 * (1 - rt))` | 1-2 px | stroke | stays | 6 |
| 2693 | mote swirl `sin(mt*3 + swirl) * 3` | 3 px | world | x k | 6 |
| 2698-2699 | mote `fillRect(px, py, 1, 1)` (+1 row above) | 1 px | stroke | stays | 6 |
| 2744-2745 | tile marker centre `cx + p.dx * rx`, `cy + p.dy * ry` | active geom | world | active geometry (no lift today) | 6 |
| 2750 | marker span `max(2, abs(dn.dx) * rx * 1.2)` else `3` | px floors | world | floors x k | 6 |
| 2751 | marker `w = min(14, max(2.5, span))` | cap 14 px, floor 2.5 px | world | cap and floor x k (spec 2 "tile-marker size cap") | 6 |
| 2752 | marker `h = max(1.5, w * 0.42)` | floor 1.5 px | world | x k | 6 |
| 2765, 2768 | marker `lineWidth` 1 (hover), 1.5 (selection) | px | stroke | stays | 6 |

---

## SurfaceDecals.ts

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 54 | `DECAL_BUDGET` | 900 sites | — | none (identity plan) | — |
| 62 | `BUCKET` | 11 px at `REF_RX` | world | identity plan only (base rx) | 6 |
| 75 | `REF_RX` | 262 px | world | identity plan only | 6 |
| 134-135 | `sc = max(0.25, rx / REF_RX)`, `bucket = max(3, round(BUCKET * sc))` | rx-relative | world | must receive the BASE geometry (plan once) | 6 |
| 141, 143 | lattice `py += 2`, `px += 2` | 2 px screen lattice | world | identity plan only | 6 |
| 147 | `bx = px - cx + 4096`, `by = py - cyTop + 4096` | body-relative screen px | world-anchored texture | identity plan only (these ARE base-world coords at identity) | 6 |
| 149 | `r > 0.94` rim keep-off | disc units | — | none | — |
| 182-185 | groves `vnoise(bx, by, 52*sc)`, `19*sc`, sward `88*sc`, `27*sc` | px cells | world-anchored texture | identity plan only | 6 |
| 197-237 | `hash1(bx*31 + by)`, `(bx*7 + by)`, `(bx + by*17)`, `(bx*13 + by*5)`, `(bx*5 + by*11)`, `(bx*17 + by*3)`, `(bx*977 + by*31)` | px-keyed hashes | world-anchored texture | identity plan only | 6 |
| 232-235 | site `x: px`, `y: py - lift` | screen px | world | store world coords (+ row, col) | 6 |
| 235 | `scale: 0.75 + (1 - r) * 0.45` | multiplier | sprite | sprite size x round(k) on top | 6 |
| 252 | bucket key on `c.x - cx + 4096`, `c.y - cyTop + 4096` | px buckets | world | identity plan only | 6 |
| 291 | stamp `bx = round(s.x) - x0`, `by = round(s.y) - yTop` | screen px | world | `worldToScreen(site)` then round | 6 |
| 294-305 | footing tests at `bx ± 1`, `by + 1`, border `bx < 1` | 1 px neighbours | stroke | stays (tests the rendered layer) | 6 |
| 339-341 | atlas blit offsets `cell >> 1`, `cell - 2`, 1:1 per atlas px | sprite px | sprite | x round(k), nearest-neighbour | 6 |
| 347-350 | fallback heights `4` (scrub, rock) / `10` (trees) `* scale`, half-width `h * 0.4` | px | sprite | x round(k) | 6 |

---

## weather/WeatherPainter.ts

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 34-35 | `buildWeatherLut` loops over the full ellipse box | unclamped | per-pixel | clamp to canvas + relief margin (entries <= canvas area; spec 5 "Bounded") | 5 |
| 39, 42 | `ground = y - groundLift(row, col, r)` (nearest cell) | lift px | world | lift from `elevationAt` (3), x k (5) | 3, 5 |
| 43-44 | `fx = (gp.col + 0.5) / CELL_COLS - 0.5`, `fy` likewise | field coords snapped to the NEAREST planet cell centre | per-pixel | use the fractional grid position (`discToGridF`) so cloud edges do not stair-step per planet cell at zoom **(flag: not named in spec)** | 5 |
| 57, 397, 407 | `BAYER4` dither keyed on screen `(x & 3, y & 3)` | 4x4 screen dither | stroke | stays screen-keyed 1 px (spec 2 "dither") | 5 |
| 69 | `P_SPEED` | 62 / 54 / 14 / 20 px/s | world | x k | 5 |
| 70 | `P_LEN` | 3 / 3 / 1 / 1 px | stroke | stays (spec 2 "rain streak length") | 5 |
| 72 | `PMAX`, `FMAX` | 320, 8 | — | none | — |
| 81, 89, 232, 241 | `RAIN_SPAWN = 8`, `FLASH_CHANCE = 0.02`, `stride = 29` — spawn per SAMPLED lookup pixel | per screen px | — | unchanged per screen px keeps on-screen density, i.e. 16x the drops per world area at k = 4 **(flag: decide)** | 5 |
| 173, 219 | `cloudLift` (ctor), spawn `pY = py - cloudLift + 2` | 24 px, +2 px | world | `cloudLift * k` (engine passes it), `+2` x k | 5 |
| 253 | flash `fY = py - cloudLift` | px | world | via cloudLift | 5 |
| 359 | snow/ash sway `sin(phase) * 1.5` | 1.5 px | world | x k | 5 |
| 363-366 | streak loop `l < P_LEN[kind]`, 1 px wide | 1 px | stroke | stays 1 px wide, P_LEN long (spec 2 "rain streak width") | 5 |
| 374 | cloud `y = py - cloudLift` | px | world | via cloudLift | 5 |
| 440-445 | bolt: 1 px wide, lateral step ±1 px per row, clamp `x0 ± 3` | px | stroke | width 1 px (spec 2 "lightning width"); wander clamp 3 px stays **(flag: or world)** | 5 |
| 448-452 | flash halo 7x7, falloff radius 3 px | px | world | radius x k **(flag)** | 5 |
| 337, 414 | shadow / sunward offsets `sunX * 0.9`, `0.35`, `0.15` | field units | — | none | — |

---

## sky/SkyPainter.ts

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 13-21 | `skyLayout`: `cx = geom.cx`, `horizonY = geom.cyTop`, `A = min(vw/2 - 8, max(1.25 rx, 0.42 vw))`, `B = max(8, cyTop - 12)`, `bloom = 0.42 min(vw, vh)` | from the geom it is given | far | computed from the BASE geometry only; `farLayout` then scales `A, B, bloom` by farScale and maps `cx, horizonY` about the focus | 6 |
| 68-72 | `SUN_DIAMETER = 5`, `sunDiameter` clamp 4..8 | px | far | x farScale(k) | 6 |
| 109 | orbit arc dot step `3 / ((A + B) / 2)` | ~3 px spacing | far | spacing follows the far-scaled A, B | 6 |
| 116 | arc dot, 1 px | 1 px | stroke | stays (spec 2 "orbit-arc dots") | 6 |
| 123-136 | sibling disc radius `b.radiusPx` | from renderer (IsoDioramaRenderer 2421) | far | x farScale | 6 |
| 147 | bloom core `Rb = L.bloom * bloomScale(...)` | far layout | far | via `farLayout` | 6 |
| 157-162 | flare `arm = round(6 + D)`, 1-px cross lines | px | stroke | lines 1 px (spec 2 "flare lines"); length follows D (far) | 6 |
| 165-169 | core disc `rad = D / 2` | px | far | via D | 6 |

---

## sky/Backdrop.ts

| line | symbol | current value | class | conversion | owning task |
|---|---|---|---|---|---|
| 11, 14-16 | `PANORAMA_SCREENS = 3`, `backdropWidth(vw) = round(vw) * 3` | 1440 px at 480 | far | panorama baked at `farScale(k)` (`bakeBackdrop` gains `scale`) | 6 |
| 19-22 | `backdropOffset(sunLongitude, W)` | panorama px | far | offset in the far-scaled panorama | 6 |
| 52-61 | vertical gradient over `H` | canvas rows | far | gradient spans the far-scaled height about the focus | 6 |
| 67 | nebula centre line `y0 = H * (0.25..0.60)`, `amp = H * (0.08..0.18)` | px | far | x scale | 6 |
| 70-72 | blob `bx = (i + u) * W/5`, `bw = vw * (0.5..0.95)`, `bh = bw * (0.30..0.55)` | px | far | x scale | 6 |
| 89 | star count `round(W * H / 900)` | 1 per 900 px² | far | spacing x scale (same stars, same world positions), stars stay 1 px | 6 |
| 95-106 | star points 1 px; bright-star cross arms ±1 px | 1 px | stroke | stays (spec 2 "star points") | 6 |

---

## Notes

**Row counts** (227 rows) — HabitableCutawayEngine 115 (world 35, world-anchored
texture 40, per-pixel 17, stroke 4, sprite 3, screen 1, none 15); IsoDioramaRenderer 64
(world 33, stroke 7, far 5, sprite 4, per-pixel 3, screen 2, none 10); SurfaceDecals 16
(world 7, world-anchored texture 3, sprite 3, stroke 1, none 2); WeatherPainter 16 (world 7,
stroke 4, per-pixel 2, none 3); SkyPainter 8 (far 6, stroke 2); Backdrop 7 (far 6,
stroke 1); out of scope 1.

**Flags for later tasks** (judgement calls; none blocks Task 1):

1. `WeatherPainter` 43-44: the weather lookup snaps `fx, fy` to the nearest
   planet-cell centre. Section 4 of the spec only moves the ground LIFT to
   sub-cell sampling; without the fractional position the cloud detail and
   shadows keep per-cell stair steps at zoom 4 (a cell is ~5.6 x 2.8 px there).
2. Rain / flash spawn rates are per sampled SCREEN pixel. Unchanged, a zoom-4
   view shows the same on-screen rain density (16x per world area). The spec
   does not say which is wanted.
3. Several ~2-3 px "lines" are not 1 px at k = 1 (strata edges 1204-1205, fluid
   rim 1780, surface foam ring 930): the spec's 1-px-line rule is applied to the
   two rim rings because the spec names "the rim foam ring"; the strata edges
   are left world-scaled.
4. Column smoothing / median / shore blur kernels (crust 1160-1175, shore
   1546-1560) are 1-px kernels; at zoom they must widen by k or run at base
   resolution, or the keel turns jagged and wave fronts turn to octagon rings.
5. `drawGeom` is read by BOTH placement (must be base) and drawing (must be
   active) in the renderer's `cx/cy/rx/ry` getters — splitting those is a
   prerequisite for Task 6, and Task 4 changes what `drawGeom` returns.
