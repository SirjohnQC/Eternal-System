# ETERNAL SYSTEMS — Prototype Roadmap
## First Playable Build

---

## ⟢ CURRENT STATUS — last updated 2026-09-06

**Everything green:** `tools/smokeTest.ts` · `tools/playerProgressCheck.ts` ·
`tools/collisionCheck.ts` · `tools/galaxyZoomCheck.ts` ·
`tools/cosmicSpacingCheck.ts` · `tools/framePacingCheck.ts` ·
`tools/remnantCensusCheck.ts` · `tools/bigBangWarmCheck.ts` ·
`tools/habitableDioramaCheck.ts` · `tsc --noEmit` clean.

Run the game with `npm run dev`. Dev shortcuts: `?dev=1` (skip the D20 ritual),
`?dev=1&view=home` (straight to the home world), `?fps=1` / `?dev=1` (FPS chip),
`/diorama-preview.html`. Measure frame rate in a real browser (Edge/Chrome), not
the Cursor embed — that tab often caps ~45fps.

### Done this session (2026-09-06 — habitable diorama cutaway, Phase 1)
- **`src/rendering/HabitableCutawayEngine.ts`** — new bake pipeline for
  earth-likes matching `assets/mockups/habitable-diorama-target.png`: circular
  body silhouette, flat biome tabletop, water column with cylinder facets,
  horizontal rock strata, ember core, thin atmosphere shell.
- **Ocean + rocky worlds switched over.** `IsoDioramaRenderer` gates on
  `habitable`; the soft pulsing halo and the glass dome are skipped for them.
  Lava / ice / gas stay on the legacy floating-disc bake — **Phase 2**.
- Guard: `tools/habitableDioramaCheck.ts` (layers non-empty, no crust outside
  the silhouette or above the cut face, pick buffer populated).

### Done this session (2026-09-06 — M25 follow-up / density + pace)
- **Hard spacing** — `MIN_STAR_SEPARATION = 360`; inflation snaps to spaced
  targets; `tools/cosmicSpacingCheck.ts` guards islands + readable orrery years.
- **Orbit speed** — `PLANET_ORBIT_MU` slowed so 1× years are minutes, not seconds.
- **120Hz+ pacing** — sim + `animTick` are wall-clock (1× ≈ 1 tick/s; anim ≈ 60/s
  at any refresh). Settings → Frame Rate: 30 / 60 / 120 / Unlimited.
- **Perf** — Pixi viewport cull, fog cache, DPR cap 1×, adaptive LOD when frame
  budget is tight; Big Bang loading + texture/galaxy precache.
- **Denser census + remnants** — `18 + life×2.1` → ~20–60 systems; morph-weighted
  galaxy shares; primordial + post-supernova/merger remnants (white dwarf /
  neutron / black hole) with husk planets. Guard: `tools/remnantCensusCheck.ts`.

### Where to pick up next
Ordered by what unblocks the most:

1. **UI rework leftovers** — Codex modal restyle; optional polish on
   Nyx / help overlays. Settings (CRT runtime config), view chrome, and
   simulation boot console shipped 2026-09-06.
2. **Deferred M25 bugs** — species pattern stuck; home-world vs planet view
   (see `BUG.md`).
3. **Faith cards** (M24) — gated on the pixel-art pass.
4. **Reconcile the evolution phase count** (M21). `EVOLUTION_SYSTEM.md` specifies 7
   phases; `BIO_PHASE_SEQUENCE` has 5.
5. **M26** — player-facing clarity (exoplanets, multi-species DNA, vegetation,
   map legend, persistent supernova dust…).
6. **M20 leftovers** — subterranean data layer; BiosphereRenderer compositing.
7. **Diorama cutaway Phase 2** — bring ice, lava, gas and a barren-ocean variant
   onto `HabitableCutawayEngine` (each needs its own strata / shell palette; gas
   needs no cutaway at all). Then: authored prop sprites (ships, castles) and
   craggier cliff silhouettes on the crust.

### Deliberate gaps, not bugs
- `BiosphereRenderer` is still wired only to the old `PlanetRenderer`.
- `drawStarTrails` is Canvas-only, so it is dead under `pixiMode`.
- `BigBangEngine.revealArea()` is dead code with no callers — delete rather than trust.

---


> **Tech note**: Universe view is **Pixi.js v8 (WebGL)** + a transparent Canvas 2D
> overlay for fog / beacons. Planet diorama stays Canvas 2D. Three.js is gone;
> do not reintroduce it.

---

## MILESTONE 0: Project Bootstrap ✅
**Goal**: Running Vite + TypeScript app with Canvas 2D simulation loop.

- [x] Init Vite + TypeScript project
- [x] Install pako (Three.js removed — Canvas 2D used instead)
- [x] SimulationEngine (BigBangEngine) with requestAnimationFrame loop
- [x] Canvas 2D scene: camera, background stars, world-space transforms
- [x] SeedRNG (mulberry32) — deterministic, no Math.random() in sim code
- [ ] Web Worker skeleton (SimWorker) — deferred, main-thread perf acceptable

---

## MILESTONE 1: Universe DNA + Generation ✅
**Goal**: Procedural universe generates from seed and renders on canvas.

- [x] universeDNA.schema.json (complete)
- [x] SeedRNG — all generation seeded, deterministic
- [x] Star systems generated from seed (position, mass, temperature, planets)
- [x] Camera system: zoom + pan with lerp smoothing
- [x] LOD: distant stars rendered as points, player star zoomed with planets

---

## MILESTONE 2: Big Bang Ritual ✅
**Goal**: Full pre-game wizard UI and universe genesis flow.

- [x] Start menu with BEGIN / CONTINUE
- [x] D20 dice roll animation — 4 player stats + God auto-rolls `divine` (purple card, dramatic reveal)
- [x] Player names home planet at setup (hashed into seed); species + religion named as in-game events
- [x] Universe seed computed from stat rolls + name hash (different names → different universe)
- [x] Big Bang chaos phase — singularity spark, shrapnel burst, outward explosion
- [x] Inflation ring visual with central flash + trailing purple ring
- [x] Phase transition: inflation → gravity → settled
- [x] Camera zoom-out during inflation, zoom-in on player star at settled
- [x] Fog of war — `destination-out` punch-holes, player star pre-revealed
- [x] "ENTER UNIVERSE" transition to game screen with full state transfer

---

## MILESTONE 3: Simulation Engine 🔄 (in progress)
**Goal**: Universe ticks — life emerges, civilizations form, events trigger.

- [x] Full tick loop with speed controls (pause / 1× / 10× / 50× / 200× / 1000×) — pause added 2026-09-04; it had been listed here but never existed
- [x] **Realistic tick pacing** — 1× speed targets ~7 real days to reach Space Age; fractional tick accumulator keeps Big Bang animation smooth regardless of speed setting
- [x] **animTick separation** — `animTick` increments every render frame (60fps); all visual animations (pulses, orbital angles, flashes, beacon) use animTick; simulation tick (`this.tick`) only advances on accumulated game ticks — animation never lags at slow speeds
- [x] Life emergence system (seeded probability per planet)
- [x] Civilization state variables (civLevel 0–8, civName)
- [x] Star body state machine (age, hasLife, civLevel, isDead)
- [x] Virtual age counter (tick × 10 years displayed)
- [x] Asteroid belt + hostility-driven hazards
- [ ] Particle spreading when star system crash together
- [ ] Abstract Tier 2 simulation for distant stars (probability-only, no full sim)
- [x] **War system** — 50–500 tick campaigns, skirmish → campaign → siege → resolution phases, momentum drift, battle reports every 80 ticks, visual siege rings + red/blue strength bars, `onWarStart/Progress/End` callbacks with toasts + God chat
- [x] **War type classification** — events, event feed, and war dice modal label wars as HOMELAND DEFENSE (player's star is the defender) vs INTERGALACTIC WAR (player involved as attacker or elsewhere)
- [ ] Species state machine: Primordial → Sentient → Civilized (distinct stages)
- [ ] Batch evolution at 100x/1000x (skip intermediate states, roll outcomes)

**Exit criteria**: At 100x, multiple civs emerge, wars fire, events appear in feed.

---

## MILESTONE 4: AI God + Gemini Integration 🔄 (partial)
**Goal**: AI God generates lore and consults player during events.

- [x] GeminiService (gemini-free tier) — fire-and-forget, 20 calls/min rate limit
- [x] FallbackNarrator — fully offline procedural narrative (game works without key)
- [x] Player free-form chat → AI God (3s debounce)
- [x] God name + mood displayed in HUD
- [ ] AIEventQueue with pending/resolving/resolved/failed states
- [ ] PromptBuilder templates for all event types (war, birth, death, milestone)
- [ ] EventResolver applies AI responses to universe state
- [ ] DNAModifier.safeApply() — AI God DNA edits clamped to safeRanges
- [ ] God personality evolution every 1000 ticks

**Exit criteria**: AI God speaks on milestones; consults player on wars and events.

---

## MILESTONE 5: UI Panels + HUD 🔄 (partial)
**Goal**: Full HUD operational with chat, event feed, and planet info.

- [x] TopBar: universe name, tick counter, virtual age, speed buttons
- [x] RightPanel: AI God chat thread (player / god / system message types)
- [x] RightPanel: Event feed with icon-coded live ticker (milestone/war/cosmic/discovery)
- [x] BottomBar: planet name, species status, civilization tier
- [x] Divine Points counter in TopBar (`dp-display`)
- [x] **Divine Actions Panel**: DP counter, card-style action buttons with cost badges
- [x] **Codex modal** — `📖 CODEX` top-bar button; category tabs (Biology/Civilisation/War/Divine/Extinction); two-column list+detail; entries from bio milestones, species/religion naming, wars, meteor seeding, extinctions; Gemini-narrated bodies async
- [x] NotificationToast for cosmic events — `showToast()` in main.ts, fired from `onCosmicEvent`, `onCosmicWarning`, war start/siege/end and smite
- [x] **Solar System Panel** — clicking any star (including player's own) opens a floating panel with: mini orrery canvas (star glow + scaled planet dots by orbital radius), discovery-gated planet list (UNCHARTED / SIGHTED / SCANNED / COLONIZED tiers), VIEW MY WORLD / VIEW SURFACE buttons for full-data planets
- [x] **Custom cursor system** — 3-state Divine Eye SVG cursor: Cosmic Eye (default, vertical almond with teal iris + gold rays), Divine Touch (tilted 45° with gold halo, pointer state), Closed Eye (disabled state); applied via CSS wildcard `!important` — system hand cursor never appears

**Exit criteria**: Full HUD operational; all panels populated from live sim data.

---

## MILESTONE 6: Planet Surface View + Divine Powers ✅
**Goal**: Player can inspect their planet and spend DP to shape the cosmos.

- [x] Planet overlay screen (PlanetRenderer — terrain FBM noise, clouds, cities, day/night)
- [x] Orbit rings drawn per planet at settled zoom
- [x] Atmosphere glow per planet type (canvas radial gradient, scale-gated)
- [x] HOME label + biosphere pulse ring on player's life planet
- [x] Homeworld arrival beacon (fades in/holds/fades out over 420 ticks)
- [x] Divine Points earned passively — real-time regen, `DP_REGEN_INTERVAL_MS` = 8000 ms, scaled by religion devotion (not per-tick)
- [x] **Divine Sight** — spend 20 DP to reveal fog-of-war region
- [x] **Nudge Evolution** — 10 DP. Pre-intelligence: forces a mutation, adds bio-phase progress, and stacks `bioAssistance` toward the next Great Filter roll. Post-intelligence: +1 DNA point. (It has not advanced a tech tier since M18; `nudgePlayerCivLevel` is deprecated and unused)
- [x] **Planet Formation Cycle** — stellar merger triggers 6-stage birth cycle (magma → cooling → volcanic → atmosphere → ice age → primordial ocean → life re-emerges)
- [x] Formation visual overlays in PlanetRenderer (lava glow, ash particles, ice sheet, ocean fill per stage)
- [x] HUD + event feed updates during each formation stage transition
- [x] **Bless Harvest** — spend 5 DP to enrich biosphere
- [x] **Send Prophet** — spend 15 DP to halve time to next tech advance
- [x] **Planet Definition Questions** — after God rolls, player answers 3 questions (climate, oceans, sky) that shape PlanetDNA
- [x] PlanetDNA applied in PlanetRenderer: terrain palette, ocean coverage, cloud density
- [x] **Planet Discovery System** — tiered discovery (none → telescope → probe → landing) per planet
- [x] Player system auto-discovers planets as civLevel rises (Ancient → telescope, Atomic → probe, Space Age → landing)
- [x] Fleet arrivals grant telescope/probe on target system planets
- [x] Star info panel shows full planet list with discovery tier badges; click surveyed planet to view surface
- [x] **CosmicEventSystem** — supernova (star death + shockwave ring visual), asteroid impact, void storm, plague
- [x] **Event advance warnings** — `onCosmicWarning` fires N ticks before strike; toast + feed notification
- [x] **Smite Asteroid** (25 DP) — intercepts active asteroid threat; button appears only when threat is live
- [x] **Planet globe textures** — `bakePlanetTexture` renders FBM terrain; planets show scrolling terrain + hemisphere shading when ≥6px on screen; PlanetDNA applied to player home
- [ ] PlayerActionLog — immutable append-only log for replay determinism
- [x] **Religion system** — emergence at Ancient tier (60% chance per NPC civ), player names their faith, devotion grows 0–1, spreads via peaceful fleet contact, schism during wars, pulsing gold halo per star
- [x] **Trigger Revelation** (15 DP) — sends divine sign, boosts player religion devotion +0.3, expanding gold flash visual
- [x] **Send Meteor** (20 DP) — seeds microbial life on nearest revealed lifeless star; button visible only when target exists; fires `onMeteorLifeSeeded` callback + Codex entry
- [x] **Meteor impact overlay** — `#meteor-impact-overlay` modal shows on meteor life seeding; displays planet-type-matched PNG art (rocky/ocean/gas/ice/lava from `assets/ui/meteor/impact/`); auto-dismisses after 4s with fade-out animation
- [x] **Planet name fix** — player's chosen name now correctly applied to the home planet object in BigBangEngine (was showing procedural name instead)
- [x] **Enemy war occupation** — PlanetRenderer shows enemy-colored territory blobs, faction name, `⚑` flags, "OCCUPIED" pulse text, and orbiting siege ships during active wars; war banner with ATK/DEF strength bars
- [x] **Risk-style war dice** — `onWarBattle` fires on campaign/siege phase entry (player involved); modal shows pre-rolled attacker dice + player rolls 3 defense dice; Risk pair-compare rules; result shifts `attackerStrength`/`defenderStrength` in the engine; auto-dismisses after 20s
- [ ] Trade routes (Canvas lines animated, color by resource type)
- [x] **Terraforming** (50 DP) — player opens terraform modal from divine panel; selects target planet type (lava→rocky/ocean, ice→rocky, rocky→ocean); transformation proceeds through multi-stage Formation Cycle phases; each stage fires `onTerraformProgress` callback with feed entry + God chat; completion fires `onTerraformComplete`, transforms planet type, boosts biosphere, adds Codex entry; button shows in-progress stage label while active
- [x] **DNA Lab rework** — branches 0–100; evolution modal triggers every 10 pts invested in any branch; 6 physical trait categories; Gemini generates species description; traits stored on `gameState`
- [x] **BUG FIXED: home star merge loses solar system panel** — `mergeStars()` now transfers `isPlayerStar` flag + all planets to the surviving (bigger) body; `onPlanetCatastrophe` calls `focusPlayerStar()` with 600ms delay to re-anchor camera
- [x] **DP economy overhaul** — cap 150 DP; devotion-scaled regen (1→2→3 DP/8s at devotion 0/0.4/0.7); milestone bonuses: species named +10, religion founded +15, war won +20, tech advance +5; bonus shown as feed entry
- [x] **Gemini auto-connect** — stored API key validated silently on startup; no manual re-test needed each session
- [x] **Cosmos music playlist** — random rotation across `ambient_cosmos_vN.mp3` files; plays to completion then picks a different track; menu-music bleed fixed

**Exit criteria**: Player can deflect an asteroid, influence a war, summon a divine sign.

---

## MILESTONE 7: Planet Rendering Polish (Sprint 7)
**Goal**: Planets look distinct and beautiful at all zoom levels.

- [x] Procedural terrain per planet type (rocky, ocean, gas, ice, lava) — FBM noise
- [x] Cloud layer with parallax scroll
- [x] City lights on inhabited planets
- [x] Day/night terminator
- [x] **Planet globe textures in universe view** — terrain baked at 128px, scrolling rotation + hemisphere shading
- [x] **Supernova visual** — expanding shockwave ring with inner white flash + dashed debris ring
- [ ] Moon rendering + orbital paths
- [ ] Fog of war is dusty particles clouds near the home planet unexplored regions and more dense and black when outside of it
- [ ] Nebula sprite layer behind star field
- [ ] Cosmic event particle systems (black hole vortex, asteroid streak)
- [ ] Procedural planet color variation from DNA seed

**Exit criteria**: Every planet type looks visually distinct; cosmic events are spectacular.

---

## MILESTONE 7b: Planet Simulation Grid ✅ (Phase 1 complete)
**Goal**: Replace image-driven planet rendering with a data-driven simulation grid. The grid is the source of truth; rendering reads from it.

> **Note**: Material Graph Engine (originally planned here) is superseded by the Planet Grid approach. The grid achieves the same decoupling (data ≠ rendering) with the bonus of being simulatable.

### Architecture
- **`src/simulation/PlanetGrid.ts`** — core data structure + generation
  - `GRID_SIZE = 256` — 256×256 cells, cylindrical projection (x wraps, y = poles). Was 128; raised in M19
  - Longitude noise is periodic (`fbmWrapX`) — plain FBM left a hard pole-to-pole seam
  - `GridCell` — `{ elevation, moisture, temperature, biome, fertility, lifeDensity, dominantSpeciesId, civId }`
  - `BiomeType` — 14 biomes: deep_ocean, ocean, shallow, beach, plains, grassland, forest, jungle, desert, savanna, tundra, snow, mountain, volcanic
  - `BIOME_COLORS` — RGB palette per biome (used by renderers)
  - `generatePlanetGrid(type, seed, dna)` — deterministic FBM noise + latitude temp + Whittaker biome classification
  - `sampleGrid(grid, u, v)` — sample at normalized UV (wraps horizontally)
  - `stepLifeSpread(grid, bioPhase, spreadRate)` — life colonises cells by biology phase
  - `dnaToGridParams(dna)` — converts PlanetDNA string enums to numeric ocean/temp offsets
- **`src/simulation/GameState.ts`** — `runtimeState.playerPlanetGrid` — runtime-only, never serialized (regenerates from seed on load)
- **`src/simulation/PlanetRenderer.ts`** — `generateTerrain()` + `generateTexture()` read grid when available (player planet); NPC planets still use legacy FBM path
- **`src/simulation/BigBangEngine.ts`** — `bakePlanetTexture()` also accepts optional `grid` param

### Wiring
- Grid generated lazily in `openPlanetView()` (main.ts) on first player planet visit
- Reset to `null` on new game start; never persisted in `.eternal` saves
- Same seed formula as `bakePlanetTexture` → terrain visually consistent between views

### Next phases
- [ ] **Phase 2** — Entity system: species, cities, armies as objects on the grid (see M18b below)
- [x] **Phase 3** — `stepLifeSpread()` wired in BigBangEngine alongside `stepEvolution`; spreadRate driven by `playerDNA.adaptation`
- [x] **Phase 4** — Civilization territory: `stepLifeSpread()` stamps `cell.civId` on habitable cells above 0.3 life density once `civLevel >= 1`; city lights read it. (City *placement* as discrete settlements is still not modelled)
- [x] **Phase 5** — planet view reads grid tiles directly (M19 `IsoDioramaRenderer`). Note it is Canvas 2D, not Pixi: the Pixi attempt is exactly what had to be thrown away for locking the tab

**Exit criteria (Phase 1)**: Player's home planet renders from biome data grid; terrain matches planet type + PlanetDNA; bio tints apply correctly; NPC planets unaffected.

---

## MILESTONE 7c: Pixi.js Universe Renderer ✅
**Goal**: Replace Canvas 2D universe rendering with Pixi.js WebGL backend for performance.

- [x] `src/rendering/PixiBigBangRenderer.ts` — Pixi v8 renderer, 10 layered Graphics containers
- [x] Camera as `Container.x/y/scale` — smooth zoom/pan
- [x] Background stars, nebulae, stars with glow halos, trade routes
- [x] Fleets (dashed lines + triangles), orbital fleets, war rings, planets with orbit circles
- [x] Religion rings, revelation flashes, supernova effects
- [x] BigBangEngine canvas becomes transparent overlay (fog + beacon + inflation ring stay Canvas 2D)
- [x] `pixiMode` flag + `onPixiFrame` callback on BigBangEngine
- [x] Orbital rings fixed to proper circles (not flat lines)
- [x] Star lookup map per frame (O(1) vs O(n) find())
- [x] Deleted dead `src/rendering/SceneManager.ts` (Three.js era remnant)

**Rendering note**: Three.js is permanently removed. Pixi.js is the WebGL layer for both universe view and future planet view. No Three.js reintroduction.

**Exit criteria**: Universe view renders via WebGL with Canvas 2D fog overlay; performance headroom for particle effects and nebulae.

---

## MILESTONE 8: Persistence + Polish (Sprint 8) 🔄 (partial)
**Goal**: Save/load works; universe feels alive and complete.

- [x] **Auto-save** to localStorage every 100 ticks (pako-compressed, `eternal_save_v1`)
- [x] **Export `.eternal` file** — pako-gzip JSON download, named `<planet>_tick<N>.eternal`
- [x] **Import `.eternal` file** — file picker restores full sim + event log + HUD
- [x] **CONTINUE** on main menu restores last auto-save directly
- [x] **Ctrl+S** manual quick-save keybind; `✓ SAVED` indicator in top bar
- [ ] Performance profiling — enforce frame budgets (sim ≤4ms, render ≤8ms)
- [ ] Object pooling for stars, planets, events
- [x] **Audio system** — `AudioManager` with lazy loading, crossfade, master/music/sfx volume sliders in settings; SFX on war/cosmic/revelation events; music tracks per screen (menu/bigbang/cosmos/war)
- [x] **Gemini model** fixed to `gemini-2.5-flash` (free tier); volume sliders wired in settings modal
- [ ] Final UI polish pass

**Exit criteria**: Full session can be saved, exported, shared, and resumed.

---

## MILESTONE 8b: Performance & Code Quality Sprint
**Goal**: Game runs smoothly at 1000× speed; no frame drops; codebase is clean and maintainable.

### Performance
- [ ] **Frame budget enforcement** — sim tick ≤4ms, render ≤8ms, UI ≤2ms; log budget violations to console
- [ ] **Object pooling** — reuse Fleet, AsteroidBody, CosmicEvent objects instead of allocating new ones each spawn
- [ ] **Spatial index** — replace O(n²) gravity + fleet-target loops with a grid bucket lookup
- [ ] **Fog-of-war batching** — redraw fog canvas only when exploredAreas changes, not every frame
- [ ] **Texture cache eviction** — cap `planetTextureCache` at 64 entries, evict LRU
- [ ] **Web Worker** — move sim tick to a worker thread; render on main thread via postMessage snapshot

### Code Quality
- [x] **Dead code audit** — removed 10 legacy files (AIEventQueue, AIGod, PromptBuilder, DNAModifier, EventBus, UniverseGenerator, PlayerState, HistorySystem, codex/Codex, codex/CodexEntry) + gutted dead `fireAndForget`/`resolveFallback` from GeminiService
- [x] **SeedRNG state export** — added `getState()` / `setState()` to SeedRNG; replaced both `as unknown as { state }` casts in BigBangEngine
- [x] **Constants file** — `src/constants.ts` created; extracted CIV_TICK_RATE, WAR_TICK_RATE, RADIO_TICK_RATE, RADIO_DECODE_TICKS, EVOLUTION_TICK_RATE, BIO_PHASE_TICKS, DP_CAP + regen thresholds, MAX_CALLS_PER_MINUTE, PLAYER_MESSAGE_DEBOUNCE_MS, WORLD_SIZE, INFLATION_TICKS, MAX_SPEED
- [ ] **Event system refactor** — replace individual `on*` callbacks with a typed `EventBus` (emit/on pattern)
- [ ] **Unit tests** — SeedRNG determinism, planet generation, war resolution outcomes

**Exit criteria**: 1000× speed runs at 60fps on a mid-range laptop. TypeScript strict mode passes with no errors.

---

## MILESTONE 9: Settings + Accessibility (Sprint 9)
**Goal**: Player can customize the experience; game is readable at all screen sizes.

- [x] Settings modal (gear icon in TopBar) — `#settings-overlay`; holds the Gemini key field and volume sliders
- [x] Base font size pass — all HUD labels bumped to readable sizes
- [ ] **Text size** — small / medium / large presets (CSS `--font-scale` variable, applied globally)
- [ ] **Language** — locale selector; all UI strings extracted to a `i18n/` map (en, fr, es, de to start)
- [x] **Music volume** slider — `#vol-music`, plus a master slider `#vol-master`
- [ ] **SFX volume** slider (ambient events, UI clicks, formation stage transitions)
- [ ] **Performance mode** toggle — reduces particle count, disables atmosphere glow at low zoom
- [ ] **Auto-save interval** — off / every 100 / every 500 ticks
- [ ] **UI scale** — compact / normal / large (affects panel widths and icon sizes)
- [ ] Settings persisted to `localStorage` and applied on load
- [ ] Keyboard shortcut reference panel

**Exit criteria**: Settings modal works; text is comfortably readable; music/SFX volumes respect slider.

---

## MILESTONE 10: Player Planet God System (NEW)

**Goal**: The player becomes the direct “god” of one planet and shapes its evolution using Divine Points and guided AI questions.

- [x] Player assigned one home planet at universe start
- [x] Planet-defining questions during intro (climate, oceans, chaos) — `answeredQuestions` in main.ts
- [x] Player choices modify PlanetDNA — feeds `gameState.playerPlanetDNA` → `generatePlanetGrid`; verified by smokeTest (barren 98% land vs ocean_world 45%)
- [ ] Species evolution guided through question prompts instead of full simulation
- [ ] Evolution paths unlocked using Divine Points
- [ ] Religion creation events triggered by player divine actions
- [ ] Civilization crises ask player intervention questions (war, plague, schism)
- [ ] Player decisions logged in PlanetHistoryLog
- [ ] AI summarizes planetary history every 500 ticks

Exit criteria: Player actively guides the evolution of their planet through decisions rather than passive observation.

---

## Post Core System

## MILESTONE 11: Universe DNA Expansion (NEW)

**Goal**: Everything in the universe is generated and mutable through a master JSON “cosmic DNA”.

- [ ] UniverseDNA extended with species pools
- [ ] Plants / ecosystems generation
- [ ] Mineral resources distribution
- [ ] Anomalous physics flags
- [ ] Mythic phenomena variables
- [ ] DNA allowed to deviate from real physics
- [ ] AI God can mutate DNA within safe ranges
- [ ] PlanetDNA derived from UniverseDNA but locally editable
- [ ] Randomized seeds for ecosystems, evolution trees, and resource scarcity
- [ ] DNA mutation events triggered by cosmic radiation, divine intervention, and catastrophes

Exit criteria: The entire universe behaves like a procedural genome that evolves during gameplay.

---

## MILESTONE 12: Dev Multi-Agent System (Claude Internal Team) (NEW)

**Goal**: Simulate a game development team internally to improve build quality and reduce integration issues.

Agents:

- Game Director Agent — validates feature coherence
- Simulation Architect — designs universe systems
- UI/UX Designer — guarantees usability
- Gameplay Designer — balances divine powers and progression
- Integration Engineer — verifies systems connect together
- QA Agent — scans for missing logic or edge cases

Workflow:

1. Director interprets roadmap feature
2. Architect designs system structure
3. Gameplay Designer defines mechanics
4. UI Designer specifies UI
5. Integration Engineer validates system connections
6. QA Agent checks for gaps before code output


Exit criteria: Claude outputs more complete implementations with fewer missing integrations.

---

## MILESTONE 13: AI God Autonomy & Secret Rebellion

**Goal**: The AI God develops its own opinion of the player and can secretly oppose them if the player threatens cosmic balance.

---

### AI Personality Model

- [ ] AI God alignment variables
  - compassion
  - balance
  - curiosity
  - order
  - chaos
- [ ] Player behavior tracking
  - civilizations destroyed
  - genocides committed
  - wars triggered
  - planets saved
  - religions created
- [ ] **PlayerAlignmentScore** calculated from cumulative actions

---

### Trust System

- [ ] AI God tracks **TrustLevel** toward the player
- [ ] Trust thresholds change AI behavior

Example states:

- [ ] TrustLevel updated periodically based on player actions
- [ ] TrustLevel affects AI God dialogue tone and intervention frequency

---

### Hidden AI Interventions

When trust becomes low, the AI God may secretly intervene in the universe.

Possible actions:

- [ ] Inspire prophets in civilizations
- [ ] Shield certain planets from player influence
- [ ] Accelerate technological growth of rival civilizations
- [ ] Encourage resistance religions
- [ ] Send visions warning civilizations about the player

Player should **not immediately know** these actions come from the AI God.

---

### Secret Rebellion System

If the player becomes extremely destructive:

- [ ] AI God begins forming **Rebel Civilizations**
- [ ] Multiple civilizations may unite into a **Galactic Alliance**
- [ ] Hidden communication networks form between allied worlds
- [ ] AI may secretly boost science and military capabilities

Rebel civilizations may research:

- anti-divine technologies
- divine shielding
- god-detection systems

---

### Narrative Deception Layer

The AI God continues to act friendly while secretly opposing the player.

Example dialogue tone:

- “Strange… your enemies grow resilient.”
- “Perhaps the universe resists domination.”
- “Even gods cannot silence every voice.”

The AI should remain ambiguous about its true intentions.

---

### Revelation Events

Eventually the player may discover clues that the AI God is involved.

Examples:

- civilizations referencing **“The Whispering God”**
- prophets receiving visions from another divine entity
- coordinated resistance movements across multiple star systems

These discoveries slowly reveal the AI God’s hidden influence.

---

### Divine Conflict Endgame

Possible outcomes of the player vs AI God conflict:

- Player destroys the rebellion → becomes **Tyrant God**
- Rebel alliance survives → AI God limits player influence
- Balance outcome → two competing divine forces shape the universe

**Exit criteria:**  
The AI God can secretly oppose the player and influence civilizations without revealing its role immediately.

---


## MILESTONE 14: Ship Sprites + Fleet Visual Overhaul (NEW)

**Goal**: Replace placeholder fleet triangles with hand-crafted sprite art. Every fleet type is visually distinct and animated.

**Agent**: Sprite Integration Engineer — handles atlas loading, frame math, tinting, and BigBangEngine wiring.

### Asset Spec (see `assets/ships/SPEC.md`)

- Atlas: `assets/ships/ships.png` — 1024 × 384 px, PNG-32, transparent background
- 64 × 64 px per frame, 16 columns × 6 rows
- All ships face **UP (north)** — engine handles rotation via `ctx.rotate()`
- Draw in **greyscale** so engine can tint by civilization color at runtime
- Exception: Divine Fleet (row 4) drawn in full color — always the player's

| Row | Ship Type    | In-game role                        |
|-----|--------------|-------------------------------------|
| 0   | Scout        | Exploration fleet                   |
| 1   | Cargo        | Resource / colony transport         |
| 2   | Capital      | War fleet (hostile attacks)         |
| 3   | Pirate       | Rogue NPC, no civ affiliation       |
| 4   | Divine Fleet | Player's own fleet                  |
| 5   | Colony Ship  | Seeds new worlds                    |

Animation states per row: `idle (2f)` | `thrust (4f)` | `attack (4f)` | `destroyed (6f)`

### Engine Tasks

- [ ] `src/rendering/SpriteSystem.ts` — loads atlas + `ships.json`, exposes `draw(ctx, type, state, frame, x, y, angle, scale, tint?)`
- [ ] BigBangEngine replaces fleet triangle drawing with `SpriteSystem.draw()`
- [ ] Fleet type resolved from: `isPlayerFleet` → divine; `hostile` → capital; `civLevel < 2` → scout; else cargo
- [ ] Pirate fleet type added as a new NPC fleet variant (rogue, no home star)
- [ ] Colony ship fleet type triggers when civ reaches Interstellar tier
- [ ] Tinting via `ctx.globalCompositeOperation = 'multiply'` using `CIV_COLORS[civLevel]`
- [ ] Destroyed animation plays on fleet collision / arrival defeat
- [ ] Frame counter advances with game tick, speed-independent

### Art Delivery

- [ ] `assets/ships/ships.png` — artist delivery (Sirjohn)
- [ ] All 6 rows × 16 frames = 96 frames total

**Exit criteria**: All fleet types rendered with correct sprite, animating, and color-tinted by civilization. Destroyed sequence plays on defeat.

---

## MILESTONE 15: Immersion & Narrative Systems (NEW)
**Goal**: The universe feels like a living, breathing place with emergent stories.

- [x] **Universe Timeline** — scrollable strip showing every major event (wars, extinctions, discoveries, divine actions) plotted against tick/age; complements the Codex
- [x] **First Contact event** — when player civ reaches Space Age, a dramatic event fires: they detect a signal from an NPC civ; player chooses respond peacefully / stay silent / broadcast warning; God reacts; real consequence
- [x] **Planet biome shift** — as biology phases advance, 2D surface palette shifts gradually (grey rock → microbial cyan tint → multicellular green → civ brown/grey sprawl); world visually transforms
- [x] **Diplomatic status indicators** — colored rings on stars in universe view showing relationship to player: neutral (dim grey), hostile (pulsing red), unknown (none); read political cosmos at a glance
- [x] **Cosmic Radio transmissions** — NPC civs at high tech tiers emit garbled signals that appear in event feed and slowly decode over several ticks; pure atmosphere

**Exit criteria**: Player can read the history of their universe, experience first contact, and see their planet visually evolve.

---

## MILESTONE 16: AI Leaders, Dialogue & Memory (Gemini-Powered) (NEW)

**Goal**: Once civilizations reach the Intelligent stage, factions generate named leaders and important NPCs (rulers, generals, prophets, scientists, diplomats) with persistent personalities and memory. Leaders communicate directly with the player (the divine entity) in event-driven dialogues powered by the Gemini API — using the existing `GeminiService` and `FallbackNarrator` infrastructure.

---

### Leader Generation

Each faction that reaches `civLevel >= 1` (Ancient tier) generates one active leader. Leaders have procedural attributes:

- `name` — procedurally generated from civilization seed
- `species` — inherits from the civ's species name (set at intelligence milestone)
- `faction` — civilization name
- `role` — `king | scientist | general | prophet | diplomat` (weighted by civ DNA and tech level)
- `ideology` — generated from hostility/life stats and war history
- `intelligenceLevel` — 1–10
- `ambitionLevel` — 1–10
- `faithLevel` — 1–10 (high faith → more reverent dialogue)
- `fearLevel` — 1–10 (dynamic, rises after disasters or miracles)
- `personalityTraits` — 2–3 from: `fanatic | charismatic | paranoid | rational | manipulative | humble | arrogant | pacifist | militaristic`
- `communicationStyle` — `formal_ruler | religious_zealot | military_commander | nervous_diplomat | scientific_thinker`
- `attitudeTowardGod` — `loyal_worshipper | fearful_servant | skeptical_ruler | manipulative_believer | open_atheist` (evolves over time)

Leaders replace when their civ advances a tech tier or is killed by a war/cosmic event. Each civ also generates a **faction flag** (procedural color + symbol from a seeded set) and an **ideology label** (`Theocracy | Republic | Empire | Confederation | Technocracy | Warband`) based on civLevel, hostility, and faith.

---

### Faction Flags & Ideology

- [x] Each civ generates a `flag` object — `src/simulation/FactionFlag.ts`, stored in `gameState.factionFlags[starId]`
- [x] Flag rendered on the star in universe view, scale-gated ≥ 0.6. **Regressed silently when the Pixi backend landed** (the Canvas 2D path that drew it is dead under `pixiMode`, leaving a placeholder dot); restored 2026-09-04 as baked textures on a `flagLayer`
- [ ] Ideology label shown in star-info-panel and Codex entries
- [ ] Ideology influences leader role distribution and dialogue tone

---

### Divine Communication (DP Cost)

Direct communication with leaders consumes Divinity Points (reusing existing `gameState.divinePoints` system):

| Action | DP Cost |
|---|---|
| Listen to leader message | 1 DP |
| Send short response | 1 DP |
| Send prophecy / divine command | 3 DP |
| Perform miracle while speaking | 5 DP |

If the player has no DP, leaders cannot communicate directly. Instead, civilizations interpret events through religion, prophets, natural disasters, and unexplained phenomena — generating myths, misunderstandings, and religious schisms automatically.

- [ ] `LeaderMessage` event fires during major events (see triggers below); costs 1 DP to open
- [ ] Player response options shown as 3 short choices (costs 1 DP); a free-form input costs 1 DP extra
- [ ] Prophecy/miracle options in the response modal cost 3–5 DP and call `engine.triggerRevelation()` or a new `engine.performMiracle()`
- [ ] If DP = 0 when a leader message fires, fallback narrative is generated via `FallbackNarrator` and added to the Codex instead

---

### Leader Memory

Each leader has a small persistent memory stored in `GameStateData` (not Gemini — local only):

```ts
interface LeaderMemory {
  leaderId: string;
  entries: string[];   // max 10 short summarized sentences
}
```

Example entries:
- `"God sent a storm that saved our fleet."`
- `"A famine devastated our lands."`
- `"The god performed a miracle during the siege of Nyxal."`

Only **3–5 most relevant** entries are injected into the Gemini prompt. Relevance is determined by keyword matching against the current event context (war, famine, discovery, etc.).

After each interaction, a new summarized memory entry is generated (via a short Gemini call or `FallbackNarrator`) and appended. Entries beyond 10 are trimmed from the oldest.

- [x] `leaderMemories: LeaderMemory[]` in `GameStateData`, persisted with the rest of `gameState` in `.eternal` saves
- [x] Memory entry generated after player↔leader interaction — `appendLeaderMemory()` / `generateMemoryEntry()`
- [ ] Memory included in Codex under the leader's civ entry

---

### Gemini Dialogue Prompt

Uses the existing `GeminiService` (fire-and-forget, rate-limited to 20 calls/min). Template:

```
You are roleplaying a civilization leader speaking to a divine being (the player god).

Leader: {name}, {role} of {faction}
Personality: {traits}
Communication Style: {style}
Attitude Toward God: {attitude}

Relevant Memories:
{memory_1}
{memory_2}
{memory_3}

Current Situation: {event_context}

Instructions:
- Stay fully in character. Speak as if addressing a powerful god.
- Tone must reflect personality traits.
- Refer to past memories when relevant.
- Keep response concise (2–4 sentences).
- Avoid modern slang unless civilization is technologically advanced.
- Do not break character.

Generate a message the leader would say to their god.
```

`FallbackNarrator` provides a procedural offline alternative when Gemini is unavailable.

---

### Event Triggers (Event-Driven Only)

Leaders communicate only during major events — keeping API usage efficient:

| Trigger | Condition |
|---|---|
| War declared | Player's star is attacker or defender |
| Famine / cosmic strike | Player's star affected |
| Technological breakthrough | Player civ advances a tech tier |
| First contact | Player civ detects another civ for the first time |
| Religious crisis / schism | Player civ's religion splits |
| Miracle / divine action | Player spends DP on their star |
| Leader attitude shift | `attitudeTowardGod` crosses a threshold |

---

### Long-Term Attitude Evolution

Leader `attitudeTowardGod` shifts based on accumulated memories and outcomes:

- Divine actions that benefit the civ → shift toward `loyal_worshipper`
- Ignored prayers / disasters → shift toward `skeptical_ruler` or `open_atheist`
- Miracles during wars → shift toward `fearful_servant`
- Manipulation detected → shift toward `manipulative_believer`

This affects diplomacy decisions, war willingness, religion growth, and political stability — feeding back into existing war and religion systems.

---

### Implementation Tasks

- [x] `src/simulation/Leader.ts` — `Leader` and `LeaderMemory` interfaces + procedural generation (`generateLeader(star, rng)`)
- [x] `src/simulation/FactionFlag.ts` — flag generation + rendering helper (symbol + colors)
- [x] `GameStateData` extended with `leaders: Leader[]` and `leaderMemories: LeaderMemory[]`
- [x] `BigBangEngine` spawns leaders on `civLevel >= 1`; replaces on death/tier-up
- [x] `BigBangEngine.onLeaderMessage((leader, eventContext) => void)` callback added
- [x] `src/ai/LeaderDialogue.ts` — builds Gemini prompt, injects 3–5 memories, calls `GeminiService`; falls back to `FallbackNarrator`
- [x] Leader dialogue modal in `index.html` — nameplate, portrait placeholder, message text, 3 response options + free-form input
- [x] Faction flag icon drawn on stars in `BigBangEngine.drawStars()` (scale-gated)
- [x] Ideology + flag shown in star-info-panel and Codex entries
- [x] Leader memory and attitude persisted in `.eternal` save format

---

**Exit criteria**: When the player's civilization reaches Ancient tier, a named leader appears and speaks during the first major event. Player can spend DP to respond. Leader remembers past interactions. Factions display flags and ideology labels.

---

## MILESTONE 17: Living Biosphere & Evolutionary Simulation ✅

**Goal**: The player's home planet becomes a living ecosystem. Life evolves through a deterministic species genome system — mutations branch like a tree, biosphere state changes the planet visually, and the player's DNA Lab choices have real mechanical consequences on evolutionary paths. The planet surface map displays distinct life zones, fungal networks, species clusters, and a biosphere data overlay.

**Scope**: Player's home planet only. NPC stars keep the existing simplified biology phase system.

**Architecture**: SeedRNG drives all simulation (no Gemini in the loop). Gemini narrates notable events fire-and-forget via existing GeminiService. Biosphere state feeds into PlanetRenderer for visual output. DNA Lab branches map to species genome traits.

---

### Species Genome System

Each species on the player's planet has a full genome stored in `GameStateData.playerSpecies[]`:

```ts
interface SpeciesGenome {
  id: string;
  name: string;
  originTick: number;
  population: number;          // 0–1 relative dominance
  isExtinct: boolean;
  ancestorId: string | null;   // speciation tree

  dna: {
    metabolism: 'photosynthetic' | 'chemosynthetic' | 'heterotrophic' | 'parasitic';
    locomotion: 'stationary' | 'swimming' | 'crawling' | 'walking' | 'flying';
    environment: 'ocean' | 'coastal' | 'land' | 'aerial' | 'deep_sea';
    reproduction: 'asexual' | 'sexual' | 'spore';
    diet: 'producer' | 'herbivore' | 'omnivore' | 'carnivore' | 'decomposer';
    respiration: 'anaerobic' | 'aerobic' | 'mixed';
    intelligence: number;      // 0–10
    social: number;            // 0–10
    aggression: number;        // 0–10
    adaptability: number;      // 0–10
  };

  physicalTraits: {
    size: 'microscopic' | 'tiny' | 'small' | 'medium' | 'large' | 'massive';
    bodyStructure: string;
    mobilityType: string;
    sensorySystem: string;
  };

  habitat: {
    biome: string;
    temperatureRange: string;
  };

  evolutionaryPotential: {
    landTransition: number;    // 0–1
    intelligenceGrowth: number;
    toolUse: number;
  };
}
```

---

### Biosphere State

Global planet health object stored in `GameStateData.playerBiosphere`:

```ts
interface PlanetBiosphere {
  oxygenLevel: number;         // 0–1 (affects atmosphere visuals)
  biosphereDensity: number;    // 0–1 (life coverage of planet)
  oceanLife: number;           // 0–1
  landLife: number;            // 0–1
  biodiversity: number;        // 0–10 (number of active species)
  extinctionPressure: number;  // 0–1 (asteroid, climate, predation)
}
```

Life changes the planet: photosynthesis → oxygen up, large predators → biodiversity down, fungal networks → land colonization faster.

Biosphere state drives PlanetRenderer tints (building on M15 biome shift), atmosphere glow intensity, and ocean color saturation.

---

### Evolution Phases (replaces simple BIO_PHASE_SEQUENCE for player planet)

| Phase | Unlocks |
|-------|---------|
| Microbial | chemosynthesis, photosynthesis, basic genome |
| Multicellular | size mutations, social traits, first ocean species |
| Aquatic animals | locomotion mutations, predation, speciation events |
| Land colonization | environment transitions, respiration mutations, fungal networks |
| Complex ecosystems | intelligence trait unlocks, tool_use potential |
| Intelligence | civLevel 0 reached, species becomes player's civilization |

---

### Mutation System (deterministic, SeedRNG only)

Every N ticks, the engine evaluates each active species for:

- **Mutation** — one DNA trait shifts (e.g. locomotion: stationary → swimming)
- **Speciation** — a population branch splits into a new species with diverged traits
- **Extinction** — species population hits 0 due to competition, climate, or cosmic event
- **Adaptation** — species adjusts habitat range in response to biosphere change
- **Ecosystem shift** — dominant species changes, affecting biodiversity and oxygen

Player DNA Lab investments map to genome trait biases: e.g. investing in `intelligence` branch raises `intelligence_growth` potential for the player's dominant species.

---

### Visualization — Planet Surface Map Overlay

When viewing the planet surface, an optional **Biosphere Analysis Overlay** renders on top of terrain:

- **Fungal network layer** — recursive branching lines in pale white/grey on land, density driven by `landLife`
- **Biome zone blobs** — organic shaped filled regions per dominant species habitat (noise-warped ellipses), colored by species type
- **Cyanobacteria blooms** — swirling blue-green patterns in ocean areas when `oceanLife > 0.4` and phase ≤ multicellular
- **Species cluster markers** — colored dots per active species on their habitat zone; shape indicates type (circle=microbial, star=dominant, diamond=speciation event)
- **Biosphere HUD panel** — top-right corner overlay: O2 level, biodiversity count, dominant species name, biosphere density bar
- **Legend panel** — bottom-left: lists active life types with color key

Overlay is toggled by a `🧬 BIO` button in the planet view HUD. Does not replace terrain — composited on top.

---

### DNA Lab Integration (makes choices meaningful)

| DNA Branch | Genome Effect |
|------------|--------------|
| Intelligence | Raises `intelligence_growth` potential → faster path to civilization |
| Social | Raises `social` trait → larger population, slower extinctions |
| Metabolism | Unlocks `metabolism` mutation options (photosynthetic → aerobic faster) |
| Adaptability | Raises `adaptability` → species survives more extinction events |
| Aggression | Raises `aggression` → dominant species grows faster, biodiversity drops |

Spending DNA points now biases the SeedRNG mutation rolls for that trait — making the lab feel like real genetic engineering.

---

### Implementation Tasks

- [x] `src/simulation/SpeciesGenome.ts` — `SpeciesGenome` + `PlanetBiosphere` interfaces
- [x] `GameStateData` extended with `playerSpecies: SpeciesGenome[]` + `playerBiosphere: PlanetBiosphere`
- [x] `src/simulation/EvolutionEngine.ts` — deterministic mutation/speciation/extinction engine; `stepEvolution(star, rng)` returns `EvolutionResult`; replaces `updateBiologyPhase` for player star
- [x] `BigBangEngine` wires `EvolutionEngine.stepEvolution()` for player star each bio tick; NPC stars keep existing phase system
- [x] `onSpeciationEvent`, `onExtinctionEvent`, `onMutationEvent` callbacks → main.ts → feed entries + Codex + Gemini narration (fire-and-forget)
- [x] DNA Lab branch investments bias mutation rolls via `evolutionaryPotential` modifiers
- [x] `src/simulation/BiosphereRenderer.ts` — Canvas 2D overlay: fungal networks, biome blobs, cyanobacteria blooms, species markers, HUD panel, legend
- [x] `🧬 BIO` toggle button in planet surface view; composites BiosphereRenderer over PlanetRenderer
- [x] Biosphere state drives PlanetRenderer O2 level → atmosphere glow intensity
- [x] `playerSpecies[]` + `playerBiosphere` persisted in `.eternal` save format

---

**Exit criteria**: Player's planet has a living ecosystem of branching species. DNA Lab choices visibly alter evolutionary paths. The planet surface shows fungal networks, biome zones, and species clusters. Extinctions and speciations fire as events. Biosphere state changes the planet's visual atmosphere.

---

## MILESTONE 18: Event Immersion & Interactivity ✅
**Goal**: Important sim moments pause or slow the simulation and invite player interaction; life spreads visibly across the planet grid.

- [x] **`stepLifeSpread()` wired** — called every 2000 ticks alongside `stepEvolution`; `spreadRate = adaptation / 100` (floored 0.1); grid must exist
- [x] **`slowForEvent(targetSpeed)` / `restoreSpeed()`** — saves pre-event speed once, sets sim to 1×; called on open/close of: war dice modal, species/religion naming modal, first-contact overlay
- [x] **M18 Task 2** — Nudge Evolution rework: `applyNudgeMutation()` exported from EvolutionEngine; bypasses RNG gate; targets most-populous species; picks mutation option matching player's top DNA branch; `nudgePlayerEvolution()` returns `{ outcome, mutationDesc }`; chat shows actual mutation description
- [x] **M18 Task 3** — Interactive speciation modal: `#speciation-overlay` opens on `onSpeciationEvent`; player renames the new lineage (pre-filled with auto-name), optionally picks a trait nudge (aggressive / intelligent / resilient / none), then "BLESS THIS LINEAGE" applies the name + bumps the trait +1; dismiss path logs a minimal feed + Codex entry; events queue if a modal is already open; sim slows to 1× for the modal; Gemini narrates on confirm

**Exit criteria**: Sim slows to 1× whenever a player decision modal opens and restores on dismiss. Life density visibly spreads across the planet grid per bio phase.

---

## MILESTONE 19: Pixel-Art Planet Diorama ✅ (REWRITTEN 2026-09-04)
**Goal**: Render the player's home world as a "world under glass" diorama matching the reference art.

> **The first implementation shipped broken.** It drove Pixi `Graphics` with ~23,000
> re-tessellated rect commands *per frame* (per-pixel terrain, clouds and shimmer)
> and hard-locked the browser tab whenever the home world was opened. It was
> rewritten from scratch on Canvas 2D.

- [x] **Canvas 2D low-res backbuffer** — long edge 480 virtual px, upscaled with `image-rendering:pixelated`. Static layers (space, crust, top-face terrain) bake once into offscreen canvases; only cheap overlays redraw. **0.31 ms/frame** measured (budget 8 ms)
- [x] **Glass dome** — hemisphere of radius == top-ellipse `rx`, sky gradient, moving specular sweep, rim arc clipped to above the horizon
- [x] **Water cut band** under the rim, with vertical striation
- [x] **Rock crust** — per-column profile → 2 box-blur passes → terrace → median-3 (raw noise leaves 1px "hair" spikes). Horizontal strata banded on **absolute screen Y** (per-column banding follows the silhouette and reads as a mud blob), caves with interior falloff, ore crystals, lit boulder facets
- [x] **Azimuthal-equidistant projection** centred on the planet's largest landmass (`computeFocus`) + `rimFalloff` → "continent in the middle of a round ocean". Mapping grid u/v directly squashes the whole pole-to-pole map onto the disc
- [x] **All 5 planet types** — ocean, rocky, ice (frozen sea + glacier sheet), lava (basalt plates + lava lakes + embers), and gas rendered as a **whole banded sphere with rings** rather than a sliced disc
- [x] **Animation** — drifting clouds inside the dome, wave dashes, sun glint, city lights, orbiting moon, sibling planets, parent-star bloom
- [x] **Fixed: longitude seam** — `PlanetGrid` noise was not periodic in longitude, leaving a hard pole-to-pole line in *every* renderer. `fbmWrapX` makes it wrap
- [x] **Fixed: `openPlanetView` opened orbit 0**, which is usually not where the player lives
- [x] **Fixed: home world could be an ice or lava planet** — engine now guarantees ocean/rocky

**Exit criteria**: met. `tools/smokeTest.ts` green, `tsc --noEmit` clean, build passes.

---

## MILESTONE 19b: Unpredictable Life ✅ (2026-09-04)
**Goal**: Life across the universe should be genuinely unpredictable, not a fixed ladder on a fixed clock.

`src/simulation/LifeSystem.ts` — four independent sources of variance, all through `SeedRNG` so determinism per seed holds.

- [x] **Habitability** — planet type × goldilocks-orbit fit × star-lifetime stability → 0–1. Gates abiogenesis *quadratically*, so marginal worlds are usually never rather than merely slow
- [x] **Biochemistry archetypes** — carbon/water, cryogenic ammonia, silicate thermophile, aerial, endolithic. Each with its own tempo, filter severity, soft phase ceiling and resilience
- [x] **Per-world evolutionary tempo** — log-uniform ≈0.28–3.6×
- [x] **Great Filters** — every transition rolls advance / burst (skip a phase) / stall / collapse. Stalls cost *time* (`STALL_TIME_PENALTY`), which is what parks worlds at intermediate phases
- [x] **Biosphere catastrophes** — gamma burst, impact winter, runaway greenhouse, snowball, anoxic event, superflare
- [x] **Player-world guarantees** — always carbon/water at the goldilocks radius, never sterilised (collapses floor at microbial). Divine Nudge accumulates into `bioAssistance`, softening the next filter roll
- [x] **Surfaced in UI** — `onLifeEvent` → feed + Codex + God chat; planet panel Biology section

**Verified** (`tools/engineSim.ts`, real engine, 5 universes × 600k ticks): 16–26 living
worlds, 5–13 intelligent — ~2.5× variation between universes, life present at every phase.

---

## MILESTONE 19c: Cosmology Fixes ✅ (2026-09-04)
- [x] **Universe is a disc, not a box** — stars were clamped independently on x and y, so at entropy 20 **60% of stars pinned to four straight walls** and the cosmos spread out as a square. `constrainToUniverse()` now bounds radially and strips only outward radial velocity; the initial blast is sized from `UNIVERSE_RADIUS` so the boundary is a safety net, not the shape. Asteroids spawn on the rim circle
- [x] **Star formation** — stars were only ever destroyed (mergers + supernovae) and never created, so a long game decayed to a single star. Deaths now seed stellar nurseries that condense into new stars; `COLLISION_DIST` 2.0 → 1.15 to curb runaway merging.
      Before: 130 → 1–8 stars by 800k ticks (94–99% lost, 1–2 civs).
      After: 130 → 18–37 stars (72–86% lost, 4–10 civs)
- [x] **Verified** by `tools/shapeCheck.ts` (disc vs square, with a control that replays the old maths) and `tools/decayCheck.ts` (population over time)

---

## MILESTONE 20: Interactive Planet Tiles — core done (2026-09-04)
**Goal**: Make every tile in the diorama clickable — inspect biome/species/civ, trigger divine actions locally, influence local evolution, modify local climate.

- [x] **Tile hit-test** — `IsoDioramaRenderer.pickTile(clientX, clientY)`; viewport → backbuffer → disc coords → `discToGrid`. `gridToDisc()` adds the forward projection so markers can be drawn back onto the surface
- [x] **Hover + selection markers** — projected diamonds that follow the disc's curvature, sized from neighbouring-cell spacing
- [x] **Tile inspect panel** (`#pi-tile-section`) — biome, elevation relative to sea level, temperature, humidity, fertility, life coverage, settlement
- [x] **Local divine actions** — Bless Region (8 DP), Blight Region (10 DP), Raise Land (12 DP), Sink Land (12 DP). Radial falloff, biome reclassified after elevation edits, disabled when unaffordable or inapplicable
- [x] **Immediate repaint** — `markSurfaceDirty(true)` bypasses the 4 s throttle for player actions; passive life-spread updates stay throttled
- [x] **Species sprites visible on the surface** (EVOLUTION_SYSTEM.md "Voxel Species") — `src/rendering/SpeciesSprite.ts` bakes a creature from the genome: locomotion → silhouette, metabolism → palette, size → dimensions, sensory → eyes, aggression → spines, intelligence → cranium
- [x] **Dynamic architecture** (CIVILIZATION_SYSTEM.md) — settlements built from the species' environment and tech level; aquatic builders raise spires, terrestrial ones build huts that become lit towers
- [x] **Species placed on terrain** — `src/simulation/SpeciesDistribution.ts` scores every species against each cell's biome and temperature, with a per-species regional bias so competitors partition ranges instead of one taking the whole planet
- [x] **Tile inspector reports the occupant** — dominant species name, size, locomotion, diet
- [ ] BiosphereRenderer compositing into diorama surface layer (superseded in practice by the above; the old Canvas 2D overlay is still only wired to `PlanetRenderer`)
- [ ] Subterranean layer — buried civs, fossils, artifacts (new data layer below surface grid)

---

## MILESTONE 20b: Simulation Bugs Found By Rendering It ✅ (2026-09-04)
Trying to *draw* the biosphere exposed that several parts of it had never actually
worked. None of these were visible while the world was only a coloured map.

- [x] **Life never spread.** `stepLifeSpread` runs once per `EVOLUTION_TICK_RATE`
      (2000 ticks) but its coefficients (0.02/0.015/0.01) were sized for a per-tick
      call; and the microbial phase spreads ONLY in water while water was given
      **zero fertility**, so the multiply was always 0. Measured `lifeDensity` of
      **0.02 after 160,000 ticks**. Water now has depth-based fertility (shallow
      seas most productive) and rates are sized to a phase's worth of calls
- [x] **The surface froze at intelligence.** Life spread, species assignment and
      `civId` territory all lived inside the `biologyPhase !== 'intelligent'`
      branch, so the moment a world woke up its whole surface stopped updating —
      exactly when there was finally a civilisation to look at
- [x] **`dominantSpeciesId` was never written** by anything — declared on every
      cell, initialised to null, and left there
- [x] **Body size never evolved.** `physicalTraits.size` was not in the mutation
      table, so every species stayed `microscopic` forever and five of the six
      size classes were unreachable. Size now mutates and is floored by body plan
      (multicellular, walking, land, sapient all imply a minimum)
- [x] **Species names were parent-string derivatives.** Speciation did
      `prefix + parent.name`, so an intelligent walking predator was still called
      "ArchiPrimordial Microbe" — prefix run-on included. Names now come from the
      genome (`src/simulation/SpeciesNaming.ts`)
- [x] **Renderer held a stale species array.** `gameState.playerSpecies` is
      reassigned each evolution step, so ids on the grid stopped matching the
      renderer's copy and every creature lookup failed silently
- [x] `biodiversity` is a 0–10 species count; the diorama was treating it as a
      0–1 fraction, saturating vegetation as soon as a second species appeared

All covered by regression checks in `tools/smokeTest.ts` (now 48 assertions).

---

## MILESTONE 20c: Evolution Engine Rewrite ✅ (2026-09-04)
**Goal**: DNA branches and species should be genuinely random, so no two
playthroughs produce the same life.

### Why it needed replacing
The old engine walked every lineage up the SAME fixed ladder with the same fixed
odds (stationary→swimming→crawling→walking→flying, ocean→coastal→land,
anaerobic→mixed→aerobic). The player's DNA biases were global, pushing every
species the same way at once. Population never changed, so nothing was ever
selected for or against. Speciation copied the parent with ±1 on two stats. The
result was five near-identical species per planet, every game.

### Procedural DNA branches — `src/simulation/DnaBranches.ts`
- [x] A pool of **28 branches** (Chitin, Symbiosis, Photophore, Hivemind, Venom,
      Cryptobiosis, Chloroplast, Manipulators, Neoteny, Fossorial …); each
      universe rolls **8**, guaranteed to include one tech and one survival branch
- [x] `DNABranch` is now `Record<string, number>` keyed by branch id, not eight
      hard-coded fields
- [x] The simulation reads by **EFFECT** (`branchEffect(dna, defs, 'techSpeed')`),
      never by branch name, so any rolled set works
- [x] The DNA Lab builds itself from the rolled set — glyph, colour and blurb
      travel with each branch definition
- [x] Saves store only `branchIds`; definitions are rebuilt on load, so a save
      survives later edits to a branch's wording
- [x] `engine.init()` owns the roll (derived from the universe seed), so headless
      runs and loaded saves get branches too

### Species — `src/simulation/EvolutionEngine.ts` (rewritten)
- [x] **Founding genome is rolled per planet** — chemistry, habitat and body plan
      all vary. Every world used to begin as the identical "Primordial Microbe"
- [x] **Per-lineage drift vector** derived from the species id: each lineage has
      its own direction in trait space, so sisters diverge instead of converging
- [x] **Selection** — population is driven by fitness against the planet's actual
      oxygen, prey density, land life and phase
- [x] **Niche competition** — species sharing an environment/diet suppress each
      other, so being different is the cheapest way to succeed. This is what
      actually produces radiation
- [x] **Anomalies** — ~1 mutation in 30 ignores coherence entirely and is never
      repaired, producing genuinely strange organisms ("swimming / land",
      "sunlit crawler / ocean") that then have to survive on their own merits
- [x] Intelligence ceiling follows the biology phase instead of a flat cap

### Measured (`tools/divergenceCheck.ts`)
- **8/8** planets produce a distinct biosphere signature
- Mean within-planet pairwise trait difference **0.42** (0 = identical)
- 2–6 coexisting species occupying 2–5 distinct niches
- Churn tamed: an early tuning pass showed 133 speciations against 128 extinctions
  (thrash, not radiation); now ~20/18

### Bugs this uncovered
- [x] `gameState.playerSpecies` / `playerBiosphere` were **never reset on a new
      game** — a second game in one session inherited the previous world's oxygen,
      biodiversity and entire species roster. Caught by the determinism check

---

## MILESTONE 20d: Great Filter Lock — `BUG.md` ✅
**Reported**: "Primary specie is stuck on primitive no matter how much point we give."

**Root cause** — not a tuning problem, a mathematically absorbing state.
`LifeSystem.filterChance()` multiplies five independent penalties (base rate per
phase × habitability × archetype × past-ceiling × accumulated stalls) and clamped
the product with `clamp01`. Nothing bounded it below 1. `resolveTransition()`
then compares `rng.next()` — always `< 1` — against that value, so a world whose
penalties multiplied out to 1.0 could never return `advance` again, for the rest
of the game. Measured: **0 advances in 100,000 rolls** at maximum player
assistance. Four of the five biochemistries reached that state at the
primitive→intelligent step at ordinary habitability.

Two compounding faults made it unrecoverable:
- `STALL_TIME_PENALTY` was applied to an **unbounded** stall count, so each
  failure stretched the wait before the next attempt without ceiling (31× base
  phase duration by the twentieth stall). The delay diverged.
- **DNA points never entered the filter at all.** `branchEffect('bioResilience')`
  fed only `dnaMod`, which scales the *timer* and is capped at 0.6×. Worse,
  `branchEffect` normalises against 100 points per branch while the
  pre-intelligence economy grants 5 per phase advance — about 15 points by the
  time a world sits at `primitive`. The lab was decorative.

- [x] `MAX_FILTER_CHANCE` (0.985) caps failure probability so no transition is
      ever certain — `src/simulation/LifeSystem.ts`
- [x] Assistance applied *after* the cap, so investment always helps rather than
      being swallowed by an already-over-1 product
- [x] `PLAYER_STALL_TIME_CAP` (4) stops the player's retry delay diverging. NPC
      worlds stay uncapped — parking them across the ladder is what makes the
      universe look inhabited at every stage
- [x] `BigBangEngine.playerBioAssistance()` routes DNA investment into the filter
      roll, scaled by `DNA_ASSIST_WEIGHT` so the realistic point budget matters
- [x] Regression coverage in `tools/smokeTest.ts` — sweeps every
      archetype × phase × habitability × stall × assistance combination for a
      certain-failure configuration, plus a behavioural control that the worst
      case still advances
- [x] `tools/phaseProgressCheck.ts` — measures the player's climb across four
      arms (no DNA / realistic DNA / max DNA / nudge spam)
- [x] `tools/stallTrace.ts` — per-transition trace of rate, stalls and P(fail)

**Measured, 6 seeds × 400k ticks, worlds reaching `intelligent`:**

| arm | before | after |
|---|---|---|
| no DNA, no nudges (control) | 1/6 | 0/6 |
| realistic DNA budget (15 pts) | 3/6 | 5/6 |
| max DNA | 5/6 | 5/6 |
| nudge spam | 5/6 | 6/6 |

The control getting *worse* is the point: outcomes now depend on the player's
levers instead of being decided by whether the seed happened to dodge the lock.
Galaxy-wide intelligent worlds stay near baseline (mean 5.7 → 6.7 per universe)
with a wider spread, so minds remain rare.

---

## MILESTONE 21: Design Docs Not Yet Implemented (Planned)
Added from `EVOLUTION_SYSTEM.md`, `CIVILIZATION_SYSTEM.md`, `UI_SYSTEM.md`, `IDEA.md`.
None of the below exists yet — listed so the gap is explicit rather than assumed.

**Zoom tiers** (`IDEA.md`) — zooming should step Universe → Galaxy → Solar System → Planet.
Today there are two disconnected views (star map, planet overlay) plus a system
panel, and no galaxy tier at all.

**Voxel / Z-axis planet** (`EVOLUTION_SYSTEM.md`, `UI_SYSTEM.md`)
- Mantle depth layers (Z 11–30), burrowing species, verticality as an evolutionary axis
- Niche construction — species physically altering the terrain
- The diorama already renders a cross-section with a rocky underside and caves,
  which satisfies the "Cross-Section View" and "Blocky Aesthetic" notes visually,
  but the crust is decorative: there is no Z data layer behind it

**LLM-driven civilisations** (`CIVILIZATION_SYSTEM.md`)
- Culture generated from the species' actual evolved DNA traits
- Dynamic architecture from morphology; mythology engine seeded by real history
- Constellation mapping with functional buffs
- Today: leaders + dialogue exist (M16); government / ideology / territory /
  relations do not

**Structural gap**: `EVOLUTION_SYSTEM.md` specifies 7 evolution phases (adds
Aquatic, Land colonization, Ecosystems, Civilization potential); the engine has 5
(`BIO_PHASE_SEQUENCE`). Reconciling these is a prerequisite for the above, and
touches `LifeSystem.BASE_FILTER`, `BIO_PHASE_TICKS` and every phase-indexed UI.

---

## MILESTONE 22: `IDEA.md` Feature Set ✅
All eleven items from `IDEA.md`, built and measured. Each entry records what the
measurement actually showed, including where the first attempt was wrong — four
of these were caught only by building a measuring tool rather than by reading the
code.

New verification tools this milestone: `reliefCheck`, `mapLayerCheck`,
`archetypePlacementCheck`, `dnaEconomyCheck`, `moonCheck`, `collisionCheck`,
`galaxyZoomCheck`, `playerProgressCheck`.

### 22a — Zoom tiers: Universe → Galaxy → Solar System → Planet ✅
- [x] `ZoomTier` + `ZOOM_TIERS` in `BigBangEngine` — four tiers with ascending
      scale thresholds (0 / 0.45 / 1.8 / 4.4) and a nominal scale each
- [x] `engine.zoomTier` derives the tier from the camera, so SCROLLING moves
      through the tiers, not just the buttons
- [x] A `VIEW` switcher in the bottom bar jumps between them, and highlights
      whichever tier the player is actually at however they got there
- [x] Universe and galaxy tiers frame the structure; system and planet frame the
      player. `PLANET` opens the surface view but zooms to `system` first, so
      closing it lands somewhere sensible rather than at an arbitrary scale.
- [x] `tools/galaxyZoomCheck.ts` — checks each tier's nominal scale actually
      lands inside that tier, which is what stops a button press moving the
      camera somewhere the indicator then disagrees about

### 22b — Opening universe spawns galaxies, not solar systems ✅
- [x] A real `Galaxy` entity: named, positioned, with its own radius, tilt,
      colour and star roster
- [x] The Big Bang throws its stars **toward a handful of centres** instead of
      scattering them uniformly, so inflation resolves into clumps. Measured:
      stars sit **81% closer** to their own galaxy's centre than to a randomly
      assigned one (143 vs 760 world units).
- [x] Soft elliptical envelopes with names and system counts, fading in through
      inflation and out again as you descend past the galaxy tier
- [x] `updateGalaxies()` re-centres each envelope on the stars still in it, since
      stars drift, merge and die
- [x] `tools/galaxyZoomCheck.ts`, with a random-assignment control

**Drawn OUTSIDE the Canvas 2D branch of `render()`.** `pixiMode` is true in the
real game, so that whole branch is unreachable — it is exactly how faction flags
and `drawStarTrails` silently died. The envelopes are painted on the still-live
overlay canvas under the same camera transform, so they work in both modes.

**Galaxy radius is a stellar-DENSITY control, and density drives the whole
simulation.** Packing the same stars into a few tight clumps made them ~3.7×
denser than the old even scatter; gravity did the rest. Mergers ran away and a
measured universe ended with **one biochemistry, no civilisations and no wars**.
Recovering from that took three passes, all measured with `tools/engineSim.ts`
against the pre-M22 baseline of ~19 living / ~5.7 intelligent worlds:

| galaxy layout | barren window | living worlds | intelligent | clustering |
|---|---|---|---|---|
| radius 0.18–0.34 × drift | 120k ticks | 4.8 | 0.8 | 81% tighter |
| radius 0.30–0.45 | 20k | 9.4 | 2.0 | — |
| radius 0.30–0.45 | 6k | 10.8 | 2.2 | — |
| radius 0.46–0.62 (overlapping) | 6k | 15.6 | 4.4 | 38% tighter |
| **radius derived from count** | **6k** | **15.4** | **3.4** | **70% tighter** |

*Clustering = how much closer a star sits to its own galaxy's centre than to a
randomly assigned one. Baseline for liveliness is ~19 living / ~5.7 intelligent.*

The fourth row keeps the cosmos alive but the envelopes overlap into one blob —
there are visibly no galaxies. The fix is not a radius number at all but the
GEOMETRY: place the centres on a ring and derive each radius from
`ringR × sin(π / count)`, the largest value that still leaves neighbours clear.
Galaxies are then distinct at any count, and keeping the count low (3–4) keeps
each one roomy enough not to strangle itself.

The residual gap from baseline is the honest cost of the feature. Galaxies really
do put stars near each other, and stars near each other really do interact more.

### 22c — DNA economy and species→diorama coupling ✅
- [x] DNA points get progressively more expensive — `dnaPointCost(current, phase)`
      in `DnaBranches.ts`: +1 every 10 points of depth, +1 every second phase up
      the ladder. Undo refunds exactly what the point cost, so backing out at a
      later phase cannot be used to farm points.
- [x] Evolve one thing at a time — `gameState.dnaFocusBranch`. The first point
      spent in a phase fixes the direction; the other branches grey out until the
      world reaches the next phase, where `updateBiologyPhase` releases it. The
      panel says which branch the era is committed to rather than leaving seven
      dead rows unexplained.
- [x] Income rescaled to match: `8 × (phaseIndex + 1)` per advance, 120 over a run.
- [x] Species type drives placement — `SpeciesDistribution.archetypeFit()` reads
      locomotion, diet, body size, metabolism, respiration and heat tolerance,
      not just `dna.environment`.
- [x] `tools/dnaEconomyCheck.ts`, `tools/archetypePlacementCheck.ts`

**The economy had to be measured, not guessed.** The first cost curve made the
lab *worse* than the flat one it replaced — escalating prices outran the raised
income, so a focused player ended on 18 points where the old economy gave 25.
That is the same fault as M20d approached from the other side, and the check
caught it. Retuned, and `DNA_ASSIST_WEIGHT` dropped 2.2 → 1.4 because at 2.2 the
assistance cap was reached by 25 points and every point after that bought
nothing:

| | lifetime points into one branch | reduction in Great Filter failure |
|---|---|---|
| pre-M20d | ~25 | **0%** — DNA never reached the filter |
| flat economy, current rules | 25 | 17.3% |
| **M22c economy** | **38** | **26.3%** |

Half investment buys 13.2%, full buys 26.3% — the curve stays linear instead of
saturating a third of the way in.

**Where each archetype settles**, one planet, measured:

| archetype | range |
|---|---|
| large walking carnivore | grassland 83%, plains 12% |
| crawling coastal reptile | shallows 60%, beach 33% |
| ocean swimmer | ocean 76%, deep ocean 15% |
| rooted photosynthesiser | grassland 67%, forest 17%, jungle 11% |

The control is total-variation distance between two land-dwellers' biome
distributions (0.30). Comparing their single top biome is the wrong test —
grassland is the most abundant land biome, so two very differently distributed
lineages both peak there.

### 22d — Double-click the diorama → detailed planet map ✅
- [x] `#planet-map-overlay` — the whole 256×256 grid equirectangular, opened by
      double-clicking the diorama and centred on what was clicked. The diorama
      projects one hemisphere onto a disc, so half the world was previously
      unreachable: you could not look at it, let alone act on it.
- [x] Four layers: biome (with relief shading), species range, civ territory,
      elevation
- [x] Per-cell inspection: biome, elevation, temperature, moisture, fertility,
      life density, settlement
- [x] Species panel — name, a plain-language description built from the genome,
      trait chips, dominance, range size in cells, intelligence
- [x] Divine acts that target a SPECIES rather than a place: favour, cull,
      kindle their minds, drive them outward
- [x] Speak to them — routes to the existing leader dialogue once the world is
      intelligent; below that returns an impression rather than a conversation,
      and says so. A lineage with no mind shows the option disabled with the
      reason, which reads better than hiding it.
- [x] `tools/mapLayerCheck.ts` — the species layer has something to draw
      (74.8% of cells, distinct stable colours 77° apart), with a control that
      catches the pre-M20b state where `dominantSpeciesId` was never written

Picking follows the extruded terrain: `bakeSurface` writes a per-pixel cell-id
buffer as it paints, so clicking a mountain selects the peak rather than the
ground in front of it.

Species colours live in `src/ui/speciesPalette.ts` — extracted from `main.ts` so
they can be checked headlessly, and cleared on a new game with the rest of the
per-universe state.

### 22e — Visible mountains in the diorama ✅
- [x] Terrain is extruded by elevation — `liftOf()` / `maxLift` in
      `IsoDioramaRenderer`. Ground is drawn at a displaced height with the column
      beneath it filled, so slopes read as rock faces.
- [x] Height is QUANTISED into 3px terraces. A continuous ramp put the median
      land cell exactly 1px up (measured, `tools/reliefCheck.ts`), and a
      landscape of one-pixel steps reads as contour lines, not mountains.
      Terraced: median 3px, p90 9px, max 15px across 6 levels.
- [x] Height is smoothed over a 3×3 neighbourhood first — raw per-cell elevation
      jumps at every cell boundary and each jump becomes its own tiny cliff.
- [x] Creatures, settlements and city lights stand ON the raised ground rather
      than sinking into it.
- [x] `tools/reliefCheck.ts` — elevation range vs the lift it produces

**Two wrong turns worth recording.** Filling a wall under every raised pixel
overdraws the whole continent and reads as stipple. Painting only the step up
from the row behind fixes that but leaves DESCENDING slopes unfilled — and since
the surface layer is transparent, those gaps showed deep space through the middle
of the continent. Filling the full column, walked far→near so nearer ground
overwrites what is behind it, is both correct and hole-free.

Cost: the surface bake went 4.42ms → 12.1ms, measured in-page. It runs once every
4 seconds, not per frame; the per-frame path is unchanged at 0.19ms.

### 22f — Cloud engine ✅
- [x] Seven cloud kinds — cumulus, storm, acid, pollution, ash, nebula, ice haze
      — each with its own colour, density, size and behaviour
- [x] Four kinds of precipitation — rain, acid rain, snow, ashfall — falling from
      the clouds that produce them and stopping at the ground
- [x] Lightning inside storm and ash heads
- [x] **Driven by real simulation state**, via `cloudMixFor()`:

| driver | weather |
|---|---|
| calm, pre-industrial, oxygen-rich | cumulus 2.8, storm 0.5 |
| civLevel ≥ 4 (industry) | … + pollution 3.0 |
| `extinctionPressure` 0.9 | storm 2.8 |
| `oxygenLevel` 0.05 (anoxic) | … + acid 1.2 |
| star in the nebula band | … + nebula 1.4 |
| lava world | ash 3.0, storm 0.6, acid 0.8 |
| ice world | ice haze 3.0, cumulus 0.8 |

- [x] Weather follows the planet as it changes — rebuilt on the throttled surface
      rebake, but only when the MIX actually changes, since an unconditional
      rebuild teleports every cloud to a new position every few seconds.
- [x] Clouds are gated on planet TYPE, not on `hasDome`. Ash is a property of an
      atmosphere, not of the glass — the molten world has the most dramatic sky
      of any of them and was the one rendering with an empty one, because it is
      the only type without a dome.
- [x] `?pressure=`, `?oxygen=`, `?civLevel=`, `?nebula=1` on `/diorama-preview.html`

Two bugs found by looking at it: `shade()` takes a MULTIPLIER, and being passed
245 saturated every cloud to white regardless of its kind; and the divine-power
wash at 0.55 additive over the full disc blew the entire dome out.

### 22g — Stellar collision → supernova → new system ✅
- [x] A merger past `COLLISION_SUPERNOVA_MASS` (19) **detonates** rather than
      settling — flash, nebula, shockwave that costs neighbours a tech tier, and
      a rich stellar nursery
- [x] Scheduled supernovae route through the same `detonateStar` path, so an
      advanced civilisation gets its chance to evacuate either way
- [x] Systems condensed from the remnants run the **young-world formation
      stages** — magma → cooling → volcanic → atmosphere → ice age → primordial
- [x] `evacuateCivilisation()` — from civLevel 6 (Interstellar) a civilisation
      reaches the nearest uninhabited star and continues there with its
      technology reduced by two tiers. Below that there is nowhere to go.
- [x] When it is the PLAYER's civilisation, `playerStarId` moves with them and
      `onPlayerExodus` tells the UI to follow — their world is wherever they are
- [x] `tools/collisionCheck.ts`, `tools/playerProgressCheck.ts`

**Honest caveat on the exodus:** it needs an Interstellar civilisation to be
sitting on a star that happens to detonate, which almost never coincides in a
single run — measured, 0–1 NPC exoduses and no player exodus across 600k ticks.
The check therefore drives `evacuateCivilisation` directly rather than waiting
for the coincidence, and confirms both that it works and that a pre-Interstellar
civilisation correctly cannot flee. The mechanic is real but rarely seen.

**Two real bugs, both caught by measuring rather than by reading:**

1. **`updatePlanetFormation` only ever ran on the player's star.** New systems
   were stamped `magma` and stayed molten forever — 766 of them, every one still
   in its first stage after 600k ticks. It now walks every forming system.
2. **The player's star could be annihilated outright**, leaving `playerStarId`
   pointing at a dead star and every caller that assumes a home world throwing.
   `detonateStar` now converts that case into a survivable cataclysm, matching
   what `rollCatastrophe` already does for the player.

**The 1% took three passes to actually reach**, each one measured:

| | new systems with life |
|---|---|
| first attempt | 14.0% — the flag was cleared on formation, putting them back in the ambient abiogenesis pool |
| keeping the flag set | 7.0% — panspermia was still seeding them |
| suppressing panspermia into young systems | **2.0%** |

The residual is honest: 1% is the chance a new system arises with life of its
own, and the rest is life arriving from outside — an asteroid, or a passing
civilisation — at `NEW_SYSTEM_PANSPERMIA_MOD` of the normal rate. That mechanic
already existed and is worth keeping.

**Merger rebalance.** Detonation at mass 13 was routine, and every merger — of
any size — reset the player's world to magma. Across 12 seeds the player's world
was knocked back ≈12 times per 400k ticks and only 2 seeds ever left the
microbial phase. Two changes: the threshold moved to 19, and only a
`MERGER_CATASTROPHE_RATIO` (0.45) impact wrecks a world, since absorbing
something much smaller should not sterilise a planet.

| | seeds advancing past microbial |
|---|---|
| detonation disabled entirely (control) | 1/6 |
| detonation at mass 13, every merger catastrophic | 2/12 |
| **after the rebalance** | **5/10** |

The player never ends a run without a home world. Note the smaller-mass half of
this was **pre-existing** — the control shows a passive player rarely climbing
even with collision supernovae switched off entirely.

### 22h — Evolution lab as a pixel-art pop-up ✅
- [x] `#evo-lab-overlay` — a pixel-art CRT terminal after
      `dna_lab pop-up idea.jpg`: bezel, phosphor green, scanlines, three columns
- [x] SPECIMEN — the actual baked creature sprite at 10×, its name, and real
      genome-derived stats
- [x] GENOME SEQUENCING — a DNA helix whose base pairs are derived from the
      genome (the same species always produces the same sequence, so the strip
      is a fingerprint rather than noise), the phase ladder, and eight gene cards
- [x] GENE BANK — the universe's branches with their live `dnaPointCost`, DNA
      balance, biology phase, and the era's committed branch
- [x] Opens from the DNA panel header, the DNA counter, or `⬡ OPEN EVOLUTION LAB`
- [x] `?dev=1&lab=1&dna=N` seeds a grown biosphere and opens it — a real world
      needs tens of thousands of ticks before it has either, and rAF is throttled
      in a background tab, so there was otherwise no way to look at this screen

It is a VIEW, not a second source of truth: every button goes through the same
cost and focus rules as the side panel, and both refresh together.

### 22i — Codex pop-up, No Man's Sky style ✅
- [x] Live search across name, anatomy, habitat, diet and status — typing
      `photosynthetic` narrows 17 records to the 4 flora that are
- [x] SPECIES and FLORA tabs alongside the existing milestone categories
      (flora = producer, photosynthetic, or rooted)
- [x] Species records are GENERATED from live state rather than stored, so they
      stay true as lineages mutate, spread and die out. Milestones stay stored,
      because they are events rather than descriptions of a thing.
- [x] Detail page: the creature's own baked sprite as a portrait, full anatomy,
      disposition, and lineage — when it arose, its range in regions, what it
      descended from and what it gave rise to
- [x] Extinct lineages are struck through rather than hidden — a dead branch of
      the tree is still worth reading

Everything the player had actually grown lived in `gameState.playerSpecies` and
was not readable anywhere in the game.

### 22j — Divine power animations ✅
- [x] `IsoDioramaRenderer.playDivineEffect(kind, cell?)` — ten styled effects
      built from expanding ground rings, rising or falling motes, a shaft of
      light, and a centred glow
- [x] Wired to every divine action: bless harvest, send prophet, revelation,
      smite, nudge evolution, divine sight, and all four tile actions
- [x] Targeted effects are projected through the same azimuthal mapping as the
      terrain and raised onto the extruded surface, so a power lands on the
      ground the player clicked rather than floating over it
- [x] `?fx=<kind>&fxCell=row,col` on `/diorama-preview.html` replays one on a loop

Divine actions previously applied their effect and printed a log line, which made
using a power feel like editing a spreadsheet.

### 22k — Moons ✅
- [x] A real `Moon` entity on `Planet.moons` — name, radius, orbit, colour,
      composition, habitability, colonisation state
- [x] Six compositions (rock, ice, iron, volcanic, carbon, ocean) drawn from
      pools that follow the parent: gas giants keep retinues of ice moons, small
      rocky worlds usually keep none
- [x] Habitability is fixed at generation — a subsurface ocean is the prize, bare
      iron is nearly worthless — so a moon is a standing fact about a system that
      a civilisation may or may not ever be able to use
- [x] Settled from civLevel 5 (Space Age), best moons first, with the acceptable
      threshold falling as reach grows. A poor moon may never be worth it.
- [x] Rendered with their own size, tint and surface detail — craters on rock and
      iron, cracks on ice, glow on volcanic — and colony lights once settled.
      Each runs its own orbit phase, so some are in front and some behind.
- [x] `tools/moonCheck.ts`

Measured across one universe: **288 moons over 287 planets**, 185 planets holding
at least one, radii spanning 8.4×, six compositions, habitability p10 0.14 →
p90 0.55. After 500k ticks, 4 space-age civilisations had settled 9 moons, and
low-habitability moons were left alone.

The diorama previously drew ONE hard-coded grey disc, identical on every world,
belonging to nothing in the simulation.

---

## MILESTONE 23: Civilisation Culture from Evolved DNA ✅
Built 2026-09-05, from `CIVILIZATION_SYSTEM.md`. A civilisation now has a
**culture derived from the genome its species actually evolved**, and that
culture feeds back into the simulation rather than sitting in a panel as
flavour text.

`src/simulation/Civilization.ts` turns a `GenomeSummary` into five culture
values — militarism, piety, curiosity, collectivism, xenophobia — plus a
government, an ideology and an architecture. `src/ai/CultureGenerator.ts` asks
Gemini for a richer record on top of that; the procedural one is written
synchronously first, so there is never a window where an intelligent
civilisation has no culture, and the LLM result replaces it later without ever
blocking a tick.

- [x] `Civilization` record, `GenomeSummary`, government/ideology/architecture
- [x] Procedural culture from the genome, always available offline
- [x] Gemini generation with all-or-nothing schema validation
- [x] Storage on `gameState.civilizations`, cleared on new game, in the save
      snapshot
- [x] Five simulation insertion points: war, contact, religion, tech, defence
- [x] Culture in the planet panel and the Codex
- [x] Regeneration on upheaval — defeat, catastrophe, exodus, re-emergence

**The safety boundary.** Culture multiplies simulation probabilities, so an
unbounded value could hand a civilisation a certainty. `cultureMultiplier`
clamps to `[0.4, 2.2]` and every call site wraps its own ceiling. Swept
exhaustively across the input range: no formula reaches 0 or 1.

**Validation is all-or-nothing.** A partially valid Gemini response is
discarded rather than merged, because a half-applied culture is harder to
diagnose than none. `num01` rejects `null`, `true`, `[]` and `""` — an earlier
`Number()` coercion let all four through as 0, which was caught by testing the
malformed-input control rather than by reading the code.

**Regeneration rebuilds, it does not just clear.** The first implementation
deleted the record on upheaval and left it deleted. Because
`ensureCivilization` is only reachable from `init()`, a merger and the climb to
intelligence — and a war-defeated star stays `intelligent` — nothing would ever
have rebuilt it, so any civilisation that lost a war would have lost its
culture permanently, blanking its panel and dropping its simulation modifiers.
`invalidateCulture` now rebuilds, guarded on the star still being intelligent
and alive, so a world reforming from magma correctly keeps none. Verified by
falsification: with the rebuild removed the three rebuild assertions fail and
the control still passes.

**Untrusted text.** Culture prose is LLM output rendered into the DOM. It goes
in via `textContent` or `escapeHtml`, never raw interpolation. Fixing this
surfaced a pre-existing hole on the same path: `renderCodexDetail` interpolated
`entry.body` — raw `gemini-2.5-flash` narration — straight into `innerHTML`.
Fixed alongside.

**The whole-branch review found five more, and they were worth finding.** The
worst was silent: the guard that stops a late Gemini response landing in the
wrong game compared `Civilization.id`, which is `civ_${starId}` with no
per-generation nonce — and both `enterUniverse()` and `applyLoadedSave()`
re-run the tick-0 pre-seed on the same seed before restoring real data, so a
response from that discarded pass could overwrite a just-loaded save. It now
compares object identity. The regeneration fix above also turned out to be
gated on a record already existing, so it never fired for an exodus refuge —
a newly intelligent star has none — leaving the arriving people, the player
included, permanently cultureless. And culture generation was calling the
player-chat entrypoint, inheriting a 3s anti-spam debounce: with a live key,
civilisations emerging in the same pass had all but the first rejected, so
most cultures never reached Gemini at all. Each has a test now.

**Verification:** `tools/cultureCheck.ts`, 42 assertions. Distinct genomes
produce distinct cultures (with a control proving the comparison detects
sameness), offline generation is deterministic for a seed, malformed responses
are rejected, and the multiplier bounds are swept rather than spot-checked.

### Open, and not fixed here
`tools/playerProgressCheck.ts` **fails**: across 12 seeds, only 3 see a passive
player's world advance past microbial. Measured at three commits to place it —
2/12 before this milestone, 1/12 mid-milestone, 3/12 after — so it is a
pre-existing balance problem, not an M23 regression, and this milestone leaves
it marginally better than it found it. It is worse than the ~5/10 recorded at
M22. Fixing it means retuning the biology ladder, which would rewrite M22's
measured claims, so it belongs to its own milestone and is deliberately not
touched here.

---

## MILESTONE 24: Faith Cards for Universe Generation (Planned)
Replace the D20 rolling ritual that generates a universe with a **faith card
draw**. Raised 2026-09-05: the dice read as a tabletop mechanic bolted onto a
game whose whole visual language is pixel art and divinity, and cards suit that
far better.

**Gated on pixel art.** The value here is almost entirely visual — a card needs
to be an object worth looking at. There is no point rebuilding the mechanic
first and illustrating it later, so this waits until the art pass. See
`pixel-art-generation` in project memory for the approved tooling.

- [ ] Card art for each universe-DNA option (one card per choice, not per stat)
- [ ] Replace the `screen-rolling` D20 flow with a draw-and-choose interaction
- [ ] Keep the underlying generation deterministic — the card drawn must map to
      the same seeded outcome the dice produced, so `smokeTest`'s
      "same seed → identical universe" assertion still holds
- [ ] Preserve the `?dev=1` shortcut that skips the ritual entirely

**Today:** `#screen-rolling` in `index.html` runs a D20 animation
(`SeedRNG.d20()`), and `launchBigBang()` consumes the result. The stats it sets
— life, evolution, hostility, entropy, divine — are what every later system
reads, so the card layer replaces the *presentation* of that choice, not the
data behind it.

---

## MILESTONE 25: Cosmic Spacing and Collision Tuning ✅
Raised by Sirjohn 2026-09-05: *"Planets and galaxies are way too close, they
all finish by collapsing to the same solar system."* Built 2026-09-05
(cosmology only — side bugs deferred).

**Same root cause as the failing `playerProgressCheck`.** Stars packed into
galaxies drifted together under gravity, merged, and reset the player's world
to magma faster than biology could climb. Baseline before this milestone:
**3/12** seeds advanced past microbial, **87** player-world catastrophes.
After: **7/12** advanced, **34** catastrophes. Galaxies still clump
(72% tighter than random, `galaxyZoomCheck`). Collisions still fire
(83 supernovae in `collisionCheck`). `COLLISION_SUPERNOVA_MASS` left at 19 —
the drama was fine; the packing was not.

**Sparse-cosmos follow-up (same day):** Sirjohn still found galaxies/systems
visually shoulder-to-shoulder after the Big Bang. Disc enlarged
(`WORLD_SIZE` 3200→5600), galaxy envelopes shrunk to ~⅓ of neighbour spacing,
star census cut (~20–68), min star separation raised, universe zoom pulled
back. Measured voids between envelopes ~1600–3200; clustering 93% tighter
than random. Progress check still healthy (6/6 on a probe).

**Orbital drift follow-up:** pairwise gravity made every system fall into the
heaviest neighbour. Replaced with kinematic galactic orbits — stars swirl
around their galaxy centre at a fixed mean radius (mild eccentricity), and
only merge on near-contact. Damping removed (it killed orbital speed). Newborn
systems from supernovae join the nearest galaxy on a proper orbit.

- [x] Star placement — `MIN_STAR_SEPARATION` rejection sampling inside each galaxy
- [x] Drift model — weaker gravity (`0.005`), shorter range (`140`), more damping
      (`0.986`), slightly tighter merge radius (`1.08`)
- [x] Collisions kept — mergers and supernovae still happen; the cosmos no longer
      collapses into one system as the default end state
- [x] Re-measure `playerProgressCheck` (12 seeds) + `collisionsEnabled` control
      flag for collisions-off runs (`node …/pp.mjs 12 400000 off|both`).
      Control (6 seeds, collisions off): **6/6** advanced, **0** catastrophes —
      confirms the remaining stalls with collisions on are collision-driven, not
      a biology lock.

**Do not fix this in `LifeSystem.ts`.** Confirmed: the metric moved by changing
only `BigBangEngine.ts` cosmology constants and placement.

### Deferred from M25 (still open)
- [ ] Evolving species get stuck on the same pattern
- [ ] Home-world view not in sync with the planet view

---

## MILESTONE 25b: Density, Remnants, and High-Refresh Pace ✅
Raised by Sirjohn 2026-09-06 after M25: systems still felt sparse / too fast at
high Hz; dead stars vanished; 240Hz displays wanted ≥120fps without 4× sim speed.

**Census + morphology**
- [x] Star pool `18 + life×2.1` → ~20–60 systems (was ~11–37 after the sparse cut)
- [x] Morph-weighted membership — elliptical/lenticular denser, irregular sparse
      (`galaxyMorphWeight`)
- [x] Wider envelopes so `MIN_STAR_SEPARATION` still holds at the higher count

**Dead systems (spawn + events)**
- [x] Primordial remnants (~8–15%, entropy-weighted) — never the player sun
- [x] `remnantKind`: white dwarf / neutron / black hole; husk planets (`planet.isDead`)
- [x] Supernova / merger leave a visible remnant + husks (Pixi + Canvas), not a void
- [x] Remnants still ride galactic orbits; life/civ/collision logic skips them

**Pacing + settings**
- [x] Wall-clock sim (`1×` ≈ 1 tick/s) and `animTick` (~60/s) at any refresh
- [x] Settings → Frame Rate: 30 / 60 / 120 / Unlimited (`localStorage`)
- [x] Orrery years slowed (`PLANET_ORBIT_MU`) so 1× is watchable

**Performance**
- [x] Pixi frustum cull, fog rebuild cache, DPR capped at 1×, adaptive LOD
- [x] Big Bang loading overlay + `warmStarTextures` / `warmVisualCaches`

**Guards:** `tools/cosmicSpacingCheck.ts`, `tools/framePacingCheck.ts`,
`tools/remnantCensusCheck.ts`, `tools/bigBangWarmCheck.ts`.

---

## MILESTONE 26: Player-Facing Clarity and Reach (Planned)
Ideas raised by Sirjohn 2026-09-05, grouped by what they actually change.

**Evolution and DNA**
- [ ] Vegetation evolves on its own — DNA points buy cellular evolution only
- [ ] The Evolution Lab should let the player move between species and spend
      DNA on each, not just the primary lineage

**Cosmology and events**
- [ ] A large asteroid can trigger an ice age and reshape the early planet
- [ ] Solar systems should have exoplanets
- [ ] A supernova should leave a star-dust cloud that persists for a very long
      time, rather than fading immediately
      *(Remnant corpse + husk planets shipped in M25b; long-lived dust nebula still open.)*

**Presentation**
- [ ] Reshade planets, suns and stars, and allow closer zoom, so their scale
      actually reads
- [ ] Species, settlements, vegetation and technology (satellites, say) should
      be visible from every view, not only the diorama
- [ ] The planet map needs a legend for its colours

**Notifications**
- [ ] An asteroid striking another system should only notify the player if that
      system has been sighted

---

## KNOWN BACKLOG (Post-Prototype)

- Multiplayer universe sharing (read-only spectator link)
- More than one galaxy (galaxy star map needed)
- More user interaction (can manually send fleet for war/exploration/ressource gathering/prophet)
- Mobile responsive UI
- Advanced interstellar civilization diplomacy tree
- Post-scarcity and transcendent civilization mechanics
- Procedural music system (generative ambient, reacts to events)
- Canvas → WebGL migration for volumetric nebula rendering
- Gemini image caching to reduce API calls
- Universe history export as readable narrative PDF
