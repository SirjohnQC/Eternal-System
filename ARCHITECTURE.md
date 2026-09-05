# ETERNAL SYSTEMS — Technical Architecture Document
## Version 1.0 | AI Game Studio Output

---

## TECH STACK

- **Runtime**: Browser (Vite + TypeScript)
- **Rendering**: Three.js r160+
- **AI**: Google Gemini API (gemini-pro + gemini-pro-vision)
- **Bundler**: Vite 5
- **Concurrency**: Web Workers + SharedArrayBuffer
- **Persistence**: localStorage + .eternal export files (pako-compressed JSON)

---

## FOLDER STRUCTURE

```
eternal-systems/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
│
├── src/
│   ├── main.ts
│   │
│   ├── core/
│   │   ├── SimulationEngine.ts
│   │   ├── UniverseGenerator.ts
│   │   ├── SeedRNG.ts                 (mulberry32 deterministic RNG)
│   │   ├── TickScheduler.ts
│   │   └── EventBus.ts
│   │
│   ├── universe/
│   │   ├── Galaxy.ts
│   │   ├── StarSystem.ts
│   │   ├── Planet.ts
│   │   ├── Moon.ts
│   │   ├── CosmicRegion.ts
│   │   └── AsteroidBelt.ts
│   │
│   ├── life/
│   │   ├── LifeSystem.ts
│   │   ├── Species.ts
│   │   ├── PlantEcosystem.ts
│   │   └── EvolutionEngine.ts
│   │
│   ├── civilizations/
│   │   ├── Civilization.ts
│   │   ├── WarSystem.ts
│   │   ├── TradeSystem.ts
│   │   ├── ReligionSystem.ts
│   │   └── DiplomacySystem.ts
│   │
│   ├── ai/
│   │   ├── AIGod.ts
│   │   ├── GeminiService.ts
│   │   ├── AIEventQueue.ts
│   │   ├── PromptBuilder.ts
│   │   └── DNAModifier.ts
│   │
│   ├── events/
│   │   ├── CosmicEventSystem.ts
│   │   ├── CosmicEventTypes.ts
│   │   └── EventResolver.ts
│   │
│   ├── player/
│   │   ├── PlayerState.ts
│   │   ├── DivinePowers.ts
│   │   └── PlayerActionLog.ts
│   │
│   ├── codex/
│   │   ├── Codex.ts
│   │   ├── CodexEntry.ts
│   │   └── CodexWriter.ts
│   │
│   ├── history/
│   │   ├── HistorySystem.ts
│   │   └── HistoryEntry.ts
│   │
│   ├── rendering/
│   │   ├── SceneManager.ts
│   │   ├── CameraController.ts
│   │   ├── GalaxyRenderer.ts
│   │   ├── PlanetRenderer.ts
│   │   ├── NebulaRenderer.ts
│   │   ├── CosmicEventRenderer.ts
│   │   ├── TradeRouteRenderer.ts
│   │   └── shaders/
│   │       ├── planet.vert.glsl
│   │       ├── planet.frag.glsl
│   │       ├── nebula.frag.glsl
│   │       └── tradeRoute.frag.glsl
│   │
│   ├── ui/
│   │   ├── App.ts
│   │   ├── TopBar.ts
│   │   ├── RightPanel.ts
│   │   ├── AIGodChat.ts
│   │   ├── EventFeed.ts
│   │   ├── BottomPanel.ts
│   │   ├── CodexModal.ts
│   │   ├── BigBangRitual.ts
│   │   └── NotificationSystem.ts
│   │
│   ├── dna/
│   │   ├── universeDNA.schema.json
│   │   └── DNAValidator.ts
│   │
│   └── utils/
│       ├── uuid.ts
│       ├── math.ts
│       └── logger.ts
│
└── public/
    ├── fonts/
    └── audio/
```

---

## SIMULATION ENGINE PSEUDOCODE

```typescript
class SimulationEngine {
  private tick: number = 0;
  private running: boolean = false;
  private speedMultiplier: number = 1;
  private lastTimestamp: number = 0;

  start() {
    this.running = true;
    requestAnimationFrame(this.loop.bind(this));
  }

  private loop(timestamp: number) {
    if (!this.running) return;
    const delta = timestamp - this.lastTimestamp;
    this.lastTimestamp = timestamp;
    const virtualYearsAdvanced = (delta / 1000) * 10 * this.speedMultiplier;

    this.tickCosmicStructures(virtualYearsAdvanced);
    this.tickLifeSystems(virtualYearsAdvanced);
    this.tickCivilizations(virtualYearsAdvanced);
    this.tickCosmicEvents(virtualYearsAdvanced);

    this.processResolvedAIEvents();   // NON-BLOCKING — reads queue results only
    this.applyPendingPlayerActions();
    this.historySystem.checkpoint(this.tick);
    this.sceneManager.render(this.tick);

    this.tick++;
    requestAnimationFrame(this.loop.bind(this));
  }

  private processResolvedAIEvents() {
    const resolved = this.aiEventQueue.drainResolved();
    for (const event of resolved) {
      EventResolver.apply(event, this.universe, this.codex, this.history);
      if (event.response?.consultationQuestion) {
        this.ui.showConsultation(event);
      }
      if (event.response?.dnaDelta) {
        DNAModifier.safeApply(event.response.dnaDelta, this.dna);
      }
    }
  }
}
```

---

## AI ARCHITECTURE: ASYNC EVENT QUEUE

The simulation loop NEVER awaits Gemini. All AI calls are fire-and-forget.

```
SIMULATION LOOP THREAD
  tick() → checks eventQueue → applies resolved AI results
       ↓ (non-blocking push)
AI EVENT QUEUE
  [pending] [resolving] [resolved]
  Each entry: { id, type, context, prompt, response? }
       ↓ (async fire-and-forget)
GEMINI SERVICE WORKER
  Batches requests, rate-limits (20/min), retries on failure
  Returns: { text, imageData?, dnaModification? }
```

### AIEvent Interface

```typescript
interface AIEvent {
  id: string;
  type: AIEventType;
  status: 'pending' | 'resolving' | 'resolved' | 'failed';
  createdAtTick: number;
  resolvedAtTick?: number;
  context: Record<string, unknown>;
  prompt: string;
  response?: AIEventResponse;
  retryCount: number;
}

enum AIEventType {
  UNIVERSE_EVENT_NARRATIVE  = 'universe_event_narrative',
  SPECIES_EVOLUTION_LORE    = 'species_evolution_lore',
  CIVILIZATION_MILESTONE    = 'civilization_milestone',
  CODEX_ENTRY_GENERATION    = 'codex_entry_generation',
  CODEX_IMAGE_GENERATION    = 'codex_image_generation',
  PLAYER_CONSULTATION       = 'player_consultation',
  GOD_PHILOSOPHY_UPDATE     = 'god_philosophy_update',
  DNA_MODIFICATION_PROPOSAL = 'dna_modification_proposal',
  WAR_NARRATIVE             = 'war_narrative',
  COSMIC_EVENT_DESCRIPTION  = 'cosmic_event_description'
}
```

---

## AI GOD STATE

```json
{
  "god": {
    "name": "Aethon-VII",
    "philosophy": "entropy as progress",
    "temperament": "detached curiosity",
    "mood": "contemplative",
    "focusedSystem": "GX-0042",
    "relationship_with_player": 0.65,
    "total_decisions_made": 14822,
    "personality_traits": ["patient", "cryptic", "occasionally_merciful"],
    "evolution_log": []
  }
}
```

God personality evolves every 1000 ticks by feeding universe history milestones into system prompt context.

---

## TWO-TIER SIMULATION

### Tier 1: Active Simulation (Full Fidelity)
- Scope: Player's galaxy + adjacent galaxies
- Logic: Full tick — life, civilizations, events, resources
- Rendering: Full Three.js with LOD
- Update rate: Every frame

### Tier 2: Abstract Simulation (Statistical)
- Scope: All other galaxies
- Logic: Probability roll per 100 ticks per galaxy
- Rendering: Single instanced point sprite per galaxy
- Update rate: Every 100 ticks
- On zoom-in: Instantly expand to Tier 1 via deterministic UniverseGenerator

---

## PERFORMANCE LIMITS

| Resource | Limit |
|----------|-------|
| Max simulated galaxies | 50 |
| Max active star systems | 500 |
| Max planets in active pool | 1,000 |
| Max active civilizations | 200 |
| Max concurrent cosmic events | 25 |
| Max AI event queue depth | 100 |
| Max Gemini calls/minute | 20 |
| Max particles per cosmic event | 5,000 |
| Max instanced galaxy points | 50,000 |
| Max Three.js draw calls/frame | 150 |

### Frame Budget (target 60fps = 16.6ms)

| Task | Budget |
|------|--------|
| Simulation tick (Tier 1) | ≤ 4ms |
| AI event queue drain | ≤ 1ms |
| Three.js render | ≤ 8ms |
| UI update | ≤ 2ms |
| Slack | ≤ 1.6ms |

---

## WEB WORKER ARCHITECTURE

```
Main Thread
├── requestAnimationFrame loop
├── Three.js rendering
└── UI updates

SimWorker Thread
├── Tier 1 simulation tick
├── Tier 2 abstract simulation
├── Event generation
└── History logging

Communication:
  SharedArrayBuffer  — planet/civ state vectors (lock-free reads)
  postMessage        — events and AI queue entries
```

---

## PERSISTENCE

- **Auto-save**: Every 100 ticks → `localStorage['eternal_dna']`
- **Codex**: `localStorage['eternal_codex']`
- **History**: Last 1000 entries in memory; older → `localStorage['eternal_history']`
- **Export**: `.eternal` files = pako-compressed JSON (target <5MB)
- **D20 outcomes**: Stored in `playerActions[]` log with roll value for full determinism

---

## THREE.JS RENDERING PLAN

### LOD Tiers by Camera Distance

| Distance | Render Detail |
|----------|---------------|
| < 100 units | Full planet mesh, moons, rings, atmosphere shader |
| 100–500 units | Simple sphere, no moons, flat material |
| 500–2000 units | Sprite billboard |
| > 2000 units | Instanced point in galaxy cloud |

### Camera Modes

| Mode | Type | Transition |
|------|------|------------|
| Galaxy View | Orthographic top-down | Scroll zoom, drag pan |
| System View | Isometric perspective | Click star system |
| Planet View | Close-up perspective | Click planet |

Transitions: 1.5s lerp with easing. Clicking a star system in Galaxy View auto-transitions to System View.

### Procedural Visual Systems

- **Galaxies**: InstancedMesh point sprites, color = age spectrum
- **Planets**: Custom vertex/fragment shaders per planet type
- **Nebulae**: Layered sprites with additive blending, slow UV scroll
- **Cosmic Events**: Particle systems (supernova=burst, black hole=vortex, GRB=cone beam)
- **Trade Routes**: Animated dashed LineSegments2, color = resource type

### Render Loop

```
requestAnimationFrame
  ├── updateCameraLerp()
  ├── updateShaderUniforms(tick)
  ├── updateLOD()
  ├── updateParticleSystems()
  ├── updateTradeRoutes()
  ├── renderer.render(scene, camera)
  └── updateHUD()
```
