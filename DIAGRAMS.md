# ETERNAL SYSTEMS — System Diagrams

---

## DIAGRAM 1: Full System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          BROWSER (Main Thread)                           │
│                                                                          │
│  ┌──────────────────┐    ┌───────────────────────────────────────────┐  │
│  │   THREE.JS SCENE  │    │                  UI LAYER                  │  │
│  │                  │    │  TopBar │ AIGodChat │ EventFeed │ Codex    │  │
│  │  GalaxyRenderer  │    │  BottomPanel │ BigBangRitual │ Toasts     │  │
│  │  PlanetRenderer  │    └───────────────────┬───────────────────────┘  │
│  │  NebulaRenderer  │                        │ DOM events                │
│  │  EventRenderer   │    ┌───────────────────▼───────────────────────┐  │
│  │  TradeRoutes     │    │           SIMULATION ENGINE (stub)         │  │
│  └────────┬─────────┘    │  - reads SharedArrayBuffer from SimWorker  │  │
│           │ render()     │  - drains AIEventQueue resolved entries    │  │
│           │              │  - applies player actions                  │  │
│  ┌────────▼─────────┐    └───────────────────┬───────────────────────┘  │
│  │  WebGLRenderer   │                        │ postMessage               │
└──┴──────────────────┴────────────────────────┼──────────────────────────┘
                                               │
                        ┌──────────────────────▼──────────────────────────┐
                        │              SIM WORKER THREAD                    │
                        │                                                   │
                        │  ┌─────────────┐  ┌──────────────────────────┐  │
                        │  │  TIER 1 SIM │  │     TIER 2 ABSTRACT SIM  │  │
                        │  │  (full tick)│  │  (probability rolls only) │  │
                        │  │             │  │  updates every 100 ticks  │  │
                        │  │  LifeSys    │  └──────────────────────────┘  │
                        │  │  CivSys     │                                 │
                        │  │  EventSys   │  ┌──────────────────────────┐  │
                        │  └─────────────┘  │      AI EVENT QUEUE       │  │
                        │                   │  pending → resolving       │  │
                        │  SharedArrayBuffer│  → resolved → drained     │  │
                        │  (planet/civ state│                            │  │
                        │   vectors)        └───────────┬──────────────┘  │
                        └───────────────────────────────┼─────────────────┘
                                                        │ async fetch
                        ┌───────────────────────────────▼─────────────────┐
                        │              GEMINI API (External)                │
                        │  gemini-pro: text/JSON responses                  │
                        │  gemini-pro-vision: image generation              │
                        │  Rate limited: 20 calls/min enforced client-side  │
                        └─────────────────────────────────────────────────┘
```

---

## DIAGRAM 2: AI Event Lifecycle

```
SIMULATION TICK
     │
     ├─ Life evolves on Voraxis-IV
     │
     ▼
AIEventQueue.push({
  type: SPECIES_EVOLUTION_LORE,
  status: 'pending',
  context: { planetId, speciesName, newStage }
  prompt: PromptBuilder.build(...)
})
     │
     │ (next available, non-blocking)
     ▼
GeminiService.fireAndForget(event)
     │
     │ event.status = 'resolving'
     │
     │ ~~~ Gemini API call running in background ~~~
     │
     │ (2–5 seconds later, independent of tick)
     ▼
event.response = {
  narrative: "From the crystalline depths of Voraxis...",
  codexEntry: { name, description, origin },
  imagePrompt: "Silicon lifeform emerging from crystal cave..."
}
event.status = 'resolved'
     │
     │ (next tick, EventResolver picks this up)
     ▼
EventResolver.apply(event)
  → Codex.addEntry(codexEntry)
  → HistorySystem.log(narrative)
  → if consultationQuestion → UI.showConsultation()
  → if dnaDelta → DNAModifier.safeApply()
```

---

## DIAGRAM 3: Universe Generation Flow

```
Player completes Big Bang Ritual
            │
            ▼
masterSeed = hash(universeName + playerRoll + godRoll + answers[5])
            │
            ▼
SeedRNG.init(masterSeed)
            │
            ├──► Generate N galaxies
            │      └──► For each galaxy:
            │             ├──► Position (seeded random 3D coords)
            │             ├──► Generate M star systems
            │             │      └──► For each system:
            │             │             ├──► Star type + age
            │             │             ├──► Generate P planets
            │             │             │      └──► Planet type, size, moons, resources
            │             │             └──► Assign to cosmic region
            │             └──► Assign galaxy type + age
            │
            ├──► Assign player planet (from planetSetupAnswers)
            │      └──► Init LifeSystem with player-chosen biology
            │
            └──► Init AIGod (name, philosophy = AI-generated via Gemini)
                   └──► First AI event: GOD_PHILOSOPHY_UPDATE
```

---

## DIAGRAM 4: Civilization State Machine

```
                    ┌──────────────────────────────────────────────────────┐
                    │                  CIVILIZATION STATES                  │
                    │                                                        │
  intelligence ─►  TRIBAL ──► AGRICULTURAL ──► INDUSTRIAL ──► INFORMATION  │
  threshold met         │           │                │              │        │
                        │           │                │              ▼        │
                        │           │                │         SPACEFARING   │
                        │           │                │              │        │
                        │           │                │              ▼        │
                        │           └────────────────┘        POST-SCARCITY │
                        │                                           │        │
                        │          (at any stage)                   ▼        │
                        ├──► WAR ──────────────────────────── TRANSCENDENT  │
                        ├──► RELIGION_EMERGENCE                             │
                        ├──► TRADE (with other civs, spacefaring+)          │
                        └──► EXTINCTION (cosmic event / war)                │
                    └──────────────────────────────────────────────────────┘

  War duration: 50–500 ticks | Resolved by EventResolver callback
  Religion: emerges when cultural_cohesion > threshold + unexplained event logged
  Trade: requires spacefaring + known_species[] not empty
```

---

## DIAGRAM 5: UI Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  [ETERNAL SYSTEMS: Nexara]    TICK: 14,822    [⏸][1x][10x][100x][1000x] │
│  Divine Points: 342 DP                                                    │
├──────────────────────────────────────────────┬───────────────────────────┤
│                                              │  AETHON-VII  ◆ contemplat │
│                                              │  ─────────────────────────│
│                                              │  "The crystalline minds of │
│                                              │   Voraxis have taken their │
│                                              │   first steps toward the   │
│                                              │   stars. I am... watching."│
│                                              │                            │
│           THREE.JS UNIVERSE                  │  [EVENT — WAR DECLARED]   │
│           (full viewport, camera             │  The Keth'ral have launched│
│            modes: Galaxy/System/Planet)      │  war on the Solborn.       │
│                                              │                            │
│                                              │  Do you intervene?         │
│                                              │  [◈ Aid Keth'ral - 30 DP] │
│                                              │  [◈ Aid Solborn  - 30 DP] │
│                                              │  [◈ Observe      - Free  ] │
│                                              │  ─────────────────────────│
│                                              │  [14,220] ✦ Sentient life  │
│                                              │  [14,891] ◈ Supernova warn │
│                                              │  [15,103] ⚔ War declared  │
│                                              │  [CODEX]                   │
├──────────────────────────────────────────────┴───────────────────────────┤
│  PLANET: Voraxis-IV  │  SPECIES: Silicon-crystalline  │  CIV: Industrial  │
│  Age: 4.2B yrs       │  Pop: 2.1B   Tech: 6           │  ████████░░ 80%  │
│  Climate: Crystal    │  Mood: Curious                  │  ──────────────  │
│  Resources: Exotic Matter ████  Energy Crystals ████   │  [TIMELINE ▾]   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## DIAGRAM 6: LOD + Camera Tier System

```
ZOOM LEVEL          CAMERA MODE          RENDER DETAIL
    │
    │ (fully zoomed out)
    ▼
GALAXY VIEW          Orthographic        All galaxies = instanced point sprites
    │                Top-down            No individual planets visible
    │                Scroll/drag         Click galaxy → auto-zoom to SYSTEM VIEW
    │
SYSTEM VIEW          Isometric           Star + all planets as simple spheres
    │                Perspective         Moons hidden, no atmosphere
    │                Orbit controls      Click planet → auto-zoom to PLANET VIEW
    │
PLANET VIEW          Close Perspective   Full shader planet, moons, atmosphere
                     Free orbit          Asteroid belt rings, surface detail
                                         Trade routes visible if interstellar
```
