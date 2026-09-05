# M19: Pixel-Art Isometric Planet Diorama — Design Spec

**Date:** 2026-03-14
**Status:** Ready for Implementation
**Scope:** Renderer only (no interactive tiles — deferred to M20)

---

## Overview

Replace `PlanetRenderer.ts` for the player's home planet with a pixel-art isometric diorama renderer. When the player clicks "VIEW MY WORLD", the planet overlay shows a floating cylindrical world-slice: flat isometric top surface showing live terrain data, rocky cliff sides with geological layers, jagged bottom formations, and a static cosmic backdrop — all fully animated.

NPC planets keep the existing `PlanetRenderer.ts`. Only the player planet gets the diorama.

---

## Reference Visual

A floating pixel-art disc/cylinder suspended in space:
- **Top surface:** elliptical (2:1 ratio, isometric perspective), showing terrain — ocean, landmasses, coastlines, mountains, forests
- **Sides:** vertical cylindrical cliff wall showing geological cross-section layers
- **Bottom:** jagged rock/stone formations hanging in space
- **Background:** deep space, star field, moon (top-right)
- **Future variants noted:** alien planet (acid green aesthetic), mechanical planet (electric blue) — reserved slots in architecture, not in M19 scope

---

## Architecture

### New File
**`src/rendering/IsoDioramaRenderer.ts`**
Self-contained Pixi.js v8 class. Creates its own `Application` targeting a `<div id="diorama-mount">` inside `#planet-overlay`. Runs its own `app.ticker` while the overlay is open; pauses on close.

### Modified Files
- **`src/simulation/PlanetGrid.ts`** — `GRID_SIZE` constant: `128 → 256`
- **`src/main.ts`** — `openPlanetOverlay()` swapped to instantiate and drive `IsoDioramaRenderer`
- **`index.html`** — `#planet-canvas` stays in the DOM (used by NPC planet view via star-info-panel); a sibling `<div id="diorama-mount">` is added inside `#planet-overlay`. The diorama mount is shown when the player views their own planet; `#planet-canvas` is shown for NPC views. Confirm whether `#bio-toggle-btn` exists as an HTML element (it may be CSS-only / already absent) — if present, hide it for M19.

### Unchanged
- `src/simulation/PlanetRenderer.ts` — kept for NPC planets (star-info-panel)
- `src/simulation/BiosphereRenderer.ts` — BIO overlay deferred to M20

---

## Pixel-Art Rendering Technique

Pixi.js app runs at **full overlay resolution** with:
- `antialias: false`
- All graphics drawn at **integer coordinates**
- All textures use nearest-neighbour sampling — set via Pixi v8 API: `texture.source.scaleMode = 'nearest'` (the v7 `SCALE_MODE` enum does not exist in v8)
- CSS canvas: `image-rendering: pixelated`

This gives authentic pixel-art crispness without a low-res render target, while keeping Pixi's full animation capabilities.

---

## Diorama Geometry

All measurements proportional to canvas size `(W, H)`:

| Element | Value |
|---------|-------|
| Center | `(W/2, H × 0.42)` |
| Top ellipse rx | `W × 0.44` |
| Top ellipse ry | `W × 0.22` (2:1 = isometric) |
| Disc wall height | `H × 0.30` |
| Bottom formations depth | `H × 0.12` below wall |

---

## Layer Stack (back to front)

| # | Container | Contents |
|---|-----------|----------|
| 0 | `bgLayer` | Space gradient (near-black → slight blue top), 250 seeded star dots (1–2px, 15% twinkle), moon sprite top-right |
| 1 | `atmosLayer` | Soft elliptical glow behind disc, color + alpha pulse varies by planet type |
| 2 | `cliffLayer` | Cylindrical disc wall — horizontal geological stripes, left darkened (shadow), right lit |
| 3 | `surfaceLayer` | Top ellipse (masked), terrain patches sampled from 256×256 grid biome data. **Gas planets:** replace contents with swirling horizontal band Graphics (no grid sampling — no solid surface) |
| 4 | `oceanLayer` | Animated shimmer quads over water/coastal tiles |
| 5 | `cloudLayer` | 4 drifting cloud patches clipped to top ellipse mask |
| 6 | `cityLayer` | 1–2px warm-white/yellow dots on tiles where `civId !== null`, individually blinking |
| 7 | `bottomLayer` | Jagged formation polygons below disc, type-specific geometry |

---

## Planet Type Variants

### Cliff Geological Stripes

| Type | Stripe 1 (top) | Stripe 2 | Stripe 3 | Stripe 4 (bottom) |
|------|---------------|----------|----------|-------------------|
| ocean | sand/sediment | sandstone | dark rock | cave (dark + mineral glints) |
| rocky | topsoil | sandstone | granite | deep rock |
| lava | basalt | magma rock | lava veins (animated glow) | magma chamber |
| ice | permafrost | ice-rock | frozen granite | deep freeze |
| gas | `cliffLayer` contents replaced entirely with swirling horizontal gas band Graphics (no geological stripes) | | | |
| *(future)* alien | reserved | reserved | reserved | reserved |
| *(future)* mechanical | reserved | reserved | reserved | reserved |

### Atmosphere Glow & Surface Palette

| Type | Atmo glow color | Surface dominant | Bottom formations | Clouds |
|------|----------------|-----------------|-------------------|--------|
| ocean | deep blue | blue ocean, green/tan land, white foam coastlines | dark stone spires, waterfall edges | yes |
| rocky | warm tan | tan/brown desert, grey mountains, rust rock | grey/brown stone spires | yes |
| lava | orange-red | black basalt, red lava rivers, orange glow cracks | glowing lava drips, smoke wisps | no (smoke instead) |
| ice | icy cyan | white/pale blue glacier, grey exposed rock, teal frozen ocean | icicle spires, frost formations | yes |
| gas | purple-tan | swirling horizontal band layers (no solid surface) | wisping gas tendrils | no |

---

## Animation System

All animations driven by `app.ticker`. Define `t = app.ticker.lastTime / 1000` (seconds) at the top of the ticker callback — do NOT use `app.ticker.elapsed` directly as it is in milliseconds in Pixi v8. Cloud drift uses frame-delta: `x += 24 × (app.ticker.deltaMS / 1000)` (= 24px/s, framerate-independent).

| Element | Formula | Present on |
|---------|---------|-----------|
| Atmosphere pulse | `α = 0.35 + 0.1 × sin(t × 0.628)` (~10s cycle) | all types |
| Ocean shimmer | `α = 0.6 + 0.2 × sin(t × 0.05 + tileX × 0.1)` | ocean, rocky |
| Cloud drift | `x += 24 × dt` (dt = deltaMS/1000), wraps at ellipse edge | ocean, rocky, ice |
| Lava vein glow | `α = 0.4 + 0.3 × sin(t × 0.08 + veinIndex × 0.7)` | lava |
| Lava drip | slow downward y offset, loops | lava |
| Gas band drift | bands shift vertically at different speeds | gas |
| City light blink | seeded timer per tile (1–5s), toggles visible | all (if `civId` on tile) |
| Star twinkle | 15% of stars: `α = 0.7–1.0 × sin(t × seedFactor)` | background |

**City lights detail:** Sampled from 256×256 grid — any tile with `civId !== null` gets a dot in `cityLayer`. Blink timers seeded from `tileX * 256 + tileY` for determinism per save.

**`civId` write path (prerequisite):** `GridCell.civId` is currently always `null` — no code sets it. As part of M19, `stepLifeSpread()` must stamp `civId = star.civId` on a tile when `lifePresent === true` and the star's `civLevel >= 1` (Ancient tier or higher). This is the minimal write path; city lights will remain invisible until this is wired.

---

## PlanetGrid Upgrade: 128 → 256

`GRID_SIZE = 256` (single constant in `PlanetGrid.ts`). Changes cascade to:
- `generatePlanetGrid()` — more noise octaves for finer terrain detail
- `stepLifeSpread()` — same algorithm, larger grid
- `sampleGrid(u, v)` — unchanged (u/v are 0–1, resolution-independent)

**Audit required:** All access to `playerPlanetGrid` goes through `sampleGrid()` or `stepLifeSpread()` — no direct `[x][y]` indexing found. The main risk is `stepLifeSpread()` itself: it loops over all `GRID_SIZE × GRID_SIZE` cells. Upgrading to 256 means the spread algorithm now processes 4× as many cells per call, but `spreadRate` is unchanged — meaning life covers the same proportion of the surface per tick but does so across more cells. Monitor for gameplay balance regression (life may feel slower to visually spread at the same DNA investment levels).

---

## Integration: `openPlanetOverlay()` Flow

```
1. #planet-overlay shown
2. First open only: IsoDioramaRenderer instantiated, Pixi canvas appended to #diorama-mount.
   Instance stored in module-level variable (e.g. `let _dioramaRenderer: IsoDioramaRenderer | null = null`).
   Never re-instantiated — creating multiple Pixi Application instances causes memory leaks.
3. Data passed: playerPlanetGrid (256×256), playerBiosphere, playerSpecies, playerPlanet
4. renderer.start() — app.ticker begins
5. Overlay close: renderer.pause() — ticker stops, canvas stays mounted
6. Re-open: renderer.resume() + renderer.refreshData(...) to pick up biosphere/species changes
7. BIO toggle button: hidden for M19 (verify element exists in HTML before hiding)
```

**Frame budget:** IsoDioramaRenderer only ticks when overlay is open. Universe sim continues in the background. No budget conflict — diorama ticker is independent of the main sim loop.

---

## Out of Scope for M19

- Interactive tile click / inspect / divine actions → M20
- Subterranean layer (buried civs, fossils, artifacts) → M20+
- BiosphereRenderer compositing into diorama → M20
- Alien and mechanical planet type art → future milestone
- Moon animation (orbit) → future polish pass
- Directional star lighting / day-night terminator → future polish pass

---

## Exit Criteria

1. Clicking "VIEW MY WORLD" shows the diorama (not the old PlanetRenderer canvas)
2. All 5 planet types render with correct palette, cliff stripes, bottom formations, and atmosphere glow
3. Ocean shimmer, cloud drift, lava glow, city lights, and star twinkle all animate
4. City lights appear only when the player's civilization has settled tiles (`civId` present)
5. 256×256 grid generates correctly; no regression in life spread or biosphere systems
6. `npx tsc --noEmit` clean
7. NPC planet view (star-info-panel) still uses old PlanetRenderer unaffected
