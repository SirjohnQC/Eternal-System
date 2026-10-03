# Eternal System — Cursor handoff

**Last updated:** 2026-09-06  
**Purpose:** Pickup for the next chat. Cosmology/performance just landed as **M25b**; UI rework is still the main presentation track.

---

## Read first

| Doc | Why |
|-----|-----|
| `ROADMAP.md` → **CURRENT STATUS** | Ordered next steps + what just shipped |
| `DIORAMA.md` | Living procedural diorama engine vision (north star) |
| `docs/superpowers/plans/2026-09-06-habitable-diorama-engine.md` | Phase 1 cutaway bake for earth-like worlds |
| `BUG.md` | Open bugs (species pattern, home↔planet desync, …) |
| `UI_REWORK.md` + `UI_rework.png` | Pixel / ancient-machine UI target |
| `IDEA.md` | Wishlist; M26 items still open (exoplanets, dust cloud, …) |

Run: `npm run dev` (port 3000). Prefer **Edge/Chrome** for FPS — Cursor’s embed often caps ~45fps.

Dev: `?dev=1`, `?dev=1&view=home`, `?fps=1`.

---

## Just shipped (M25b — do not redo)

- Star census ~**20–60** (`18 + life×2.1`), morph-weighted galaxy shares
- **Remnants**: primordial + supernova/merger → white dwarf / neutron / black hole + husk planets (`remnantKind`, `planet.isDead`)
- **Wall-clock** sim/anim (safe at 120/240Hz); Settings → Frame Rate 30/60/120/Unlimited
- Spacing + slow orrery; Pixi cull / fog cache / DPR 1× / adaptive LOD; Big Bang precache loader
- Guards: `tools/cosmicSpacingCheck.ts`, `framePacingCheck.ts`, `remnantCensusCheck.ts`, `bigBangWarmCheck.ts`

Key files: `src/simulation/BigBangEngine.ts`, `src/rendering/PixiBigBangRenderer.ts`, `src/main.ts` (settings), `index.html` (FPS row + loading overlay).

---

## Habitable diorama cutaway — Phase 1 shipped (2026-09-06)

`src/rendering/HabitableCutawayEngine.ts` bakes earth-like worlds to match
`assets/mockups/habitable-diorama-target.png` (secondary ref:
`assets/mockups/ocean-cutaway-ref.jpg`).

- **Geometry** — the body is a CIRCLE of radius `rx` centred at `bodyCy =
  cy + (rx − ry)`; the cut face is an ellipse `rx × ry` (`ry = 0.5·rx`) whose top
  touches the top of the circle. Both passes clamp to the circle, which leaves a
  bare-rock "shoulder" at the limb — the reference has one too.
- **Layers** — `paintCutawaySurface` (flat biome tabletop, hard-edged clusters,
  inline coastlines, foam rim) · `paintCutawayCrust` (water column with cylinder
  facets → silt lip → horizontal strata → ember core) · `bakeCutawayAtmosphere`
  (rim hairline + short inner haze + tight outer bloom, day/night falloff).
- **Only ocean + rocky use it.** `IsoDioramaRenderer.habitable` gates it, and
  skips the pulsing halo + `drawDome` for those worlds. Lava / ice / gas are
  still on the legacy floating-disc-under-glass bake — that is **Phase 2**.
- The engine takes the projection (`discToGrid`), `rimFalloff`, `liftOf` and
  `smoothElevation` as callbacks, so picking / markers / settlements / divine FX
  all stay in register with the terrain. Do not fork the azimuthal math.
- Guard: `tools/habitableDioramaCheck.ts`. Preview: `/diorama-preview.html?type=ocean`.

---

## Where to pick up

1. **UI leftovers** — Codex modal restyle (settings + view chrome + sim boot done).
2. **Diorama cutaway Phase 2** — ice / lava / gas / barren-ocean on the new
   engine; craggier crust silhouettes; authored props (ships, castles).
3. **Deferred M25 bugs** in `BUG.md`
4. **M26** — exoplanets, persistent supernova dust, multi-species DNA lab, map legend, …

---

## UI rework status

| Area | Status |
|------|--------|
| HUD shell (top bar, left rail, Faith deck, status, Nyx panel) | Done |
| Left rail vertical centering | Done |
| Pixel icons (rail + Faith + resources) | Done under `assets/pixel/` |
| SYSTEM rail → `openSystemPanel` | Wired |
| End Turn button | **Intentionally omitted** |
| Shared `:root` fonts + palette | Done |
| Menu + rolling screens | Done — rolling is CRT **SIMULATION BOOT** + Launch |
| Big Bang loading screen | Done (brand fonts + progress) |
| System inspector (`#star-info-panel`) | Done — instrument chrome |
| Planet / diorama overlay chrome | Done — top bar + `#planet-info-panel` |
| Zoom tiers + UNI/GAL/SYS/PLN labels | Done |
| Codex / settings full restyle | Settings done (CRT runtime config); Codex still old |

### Tokens (`index.html` `:root`)

- Display: `--font-display` (Cinzel Decorative) · Brand: `--font-brand` (Press Start 2P) · UI: `--font-ui` · Pixel labels: `--font-pixel`
- Size scale (2K-readable): `--fs-micro` 10 · `--fs-label` 11 · `--fs-body` 13 · `--fs-title` 15 · `--fs-display` 17
- Gold / purple / teal / cyan / green / red — see existing `:root` block

### Assets

- Source: `assets/pixel/` → served via `public/assets` sync (`vite.config.ts`)
- Do **not** junction `public/assets` → `assets`
- Generator skill: `.claude/skills/game-asset-generation/SKILL.md` (`EACHLABS_API_KEY`)

---

## Rendering architecture (quick)

- **Pixi** (`PixiBigBangRenderer`): universe bodies, haze, fleets, …
- **Canvas overlay** (`BigBangEngine` canvas): fog-of-war, home beacon, inflation ring
- Remnants are drawn in Pixi (and Canvas fallback); do not `continue` on `isDead` without a remnant path
- **Canvas 2D** (`IsoDioramaRenderer`): the planet / home-world diorama. Baked
  static layers (background, crust, surface, atmosphere) blitted per frame; only
  clouds, shimmer, city lights, props and divine FX are redrawn. Earth-likes bake
  via `HabitableCutawayEngine`; everything else via the legacy in-file path.

---

## Suggested first message for the next session

> Continue from `cursor.md` / ROADMAP CURRENT STATUS (2026-09-06). M25b is done.
> Next: \<UI rework Big Bang chrome | M25 deferred bugs | M26 exoplanets\>.
