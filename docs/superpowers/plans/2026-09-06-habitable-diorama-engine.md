# Habitable Cutaway Diorama Engine — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or implement directly) to implement this plan task-by-task.

**North star docs:**
- `DIORAMA.md` — full living procedural diorama vision (reactive sim → visuals, modular systems, phased build)
- Habitable mockup — flat biome tabletop + layered cutaway + atmosphere shell

**Goal:** Rebuild the earth-like (habitable ocean/rocky) planet diorama as a dedicated cutaway engine matching the habitable mockup — flat biome tabletop, layered crust, thin atmosphere shell — while keeping grid pick / life overlays working. This is **DIORAMA.md Phase 1** (terrain / water / biomes / basic atmosphere), not the full modular stack yet.

**Architecture:** Extract a **HabitableCutawayEngine** bake pipeline used by `IsoDioramaRenderer` for `ocean` + temperate `rocky` worlds. Leave lava/ice/gas on the legacy path for Phase 2. Later phases in `DIORAMA.md` (life, civ, pollution, weather…) plug in as overlays / modules on this silhouette.

**Architecture:** Extract a **HabitableCutawayEngine** bake pipeline used by `IsoDioramaRenderer` for `ocean` + temperate `rocky` worlds. Leave lava/ice/gas on the legacy path for Phase 2.

**Tech stack:** Canvas 2D, nearest-neighbour upscale, existing `PlanetGrid` biomes, `SpeciesSprite` overlays.

**Reference mockups:**
- Primary: `assets/mockups/habitable-diorama-target.png` (habitable with atmosphere)
- Secondary: `assets/mockups/ocean-cutaway-ref.jpg` (ocean slab / no props)

---

## File map

| File | Responsibility |
|------|----------------|
| `src/rendering/HabitableCutawayEngine.ts` | **New** — bake surface disc, cutaway strata, atmosphere shell, starfield helpers |
| `src/rendering/IsoDioramaRenderer.ts` | Wire habitable path; skip soft halo/glass dome when engine active |
| `src/dev/dioramaPreview.ts` | Ensure `?type=ocean` exercises new path |
| `tools/habitableDioramaCheck.ts` | Optional smoke: bake does not throw; layers non-empty |

---

### Task 1: Scaffold HabitableCutawayEngine

**Files:**
- Create: `src/rendering/HabitableCutawayEngine.ts`

**Step 1:** Define interfaces and constants matching mockup layers:

```ts
export interface CutawayBakeResult {
  surface: HTMLCanvasElement;   // flat biome tabletop (ellipse)
  crust: HTMLCanvasElement;     // cutaway rock + abyss + core glow
  atmosphere?: HTMLCanvasElement; // optional prebaked shell mask
}

export interface CutawayBakeOpts {
  w: number; h: number;
  cx: number; cy: number;
  rx: number; ry: number;
  seed: number;
  grid: PlanetGrid;
  planetType: 'ocean' | 'rocky';
}
```

**Step 2:** Export `bakeHabitableCutaway(opts): CutawayBakeResult`.

**Step 3:** Commit scaffold with stub that fills solid colors (prove wiring).

---

### Task 2: Surface tabletop (biome disc)

**Files:**
- Modify: `HabitableCutawayEngine.ts`

**Step 1:** Project grid → flat ellipse (reuse IsoDiorama azimuthal helpers or duplicate minimal `proj`).

**Step 2:** Paint punchy biome clusters (water, grass, forest, desert, mountain, snow) with hard pixel edges — limited palette, chunky clusters not soft gradients.

**Step 3:** Minimal height terracing only for cliffs/mountains; keep overall “flat tabletop” read.

**Step 4:** Verify in diorama preview (`npm run dev` + `/diorama-preview.html?type=ocean`).

---

### Task 3: Cutaway crust layers

**Files:**
- Modify: `HabitableCutawayEngine.ts`

**Step 1:** Under the ellipse rim, paint:
1. Dark under-ocean / soil lip
2. Mid brown rock strata (jagged but readable)
3. Deep shadowed rock
4. Ember / lava flecks near bottom core (subtle)

**Step 2:** Hard silhouette against space — no soft glow on crust edge.

**Step 3:** Key light from upper-left (match mockup).

---

### Task 4: Atmosphere shell + clouds

**Files:**
- Modify: `HabitableCutawayEngine.ts`
- Modify: `IsoDioramaRenderer.ts` `frame()`

**Step 1:** Replace soft radial halo + glass dome for habitable path with:
- Thin cyan/blue ellipse stroke + soft inner rim (1–2 px feel at virtual res)
- Wispy cloud sprites along mid-band / rim (reuse or simplify `makeCloudSprite`)

**Step 2:** Gate: only when `planetType` is ocean/rocky AND new engine active.

---

### Task 5: Wire IsoDioramaRenderer

**Files:**
- Modify: `IsoDioramaRenderer.ts`

**Step 1:** In `bakeAll` / `bakeSurface` / `bakeCrust`, if habitable → call `bakeHabitableCutaway` and assign `surfaceLayer` / `crustLayer`.

**Step 2:** In `frame`, skip old halo + `drawDome` when habitable engine used; draw new atmosphere instead.

**Step 3:** Keep shimmer / creatures / settlements / markers on top.

**Step 4:** Manual check: `?dev=1&view=home` home world looks closer to mockup.

---

### Task 6: Smoke + handoff docs

**Files:**
- Create: `tools/habitableDioramaCheck.ts` (optional)
- Modify: `cursor.md`, `ROADMAP.md` CURRENT STATUS

**Step 1:** Guard: bake returns canvases with non-zero pixels.

**Step 2:** Note Phase 2: ice / lava / gas / barren ocean variant.

---

## Non-goals (Phase 1)
- Authored PNG planet bodies
- Castle/ship prop sprites (can fake with existing settlement markers)
- Rewriting PlanetGrid
- Gas giant / lava full redesign
