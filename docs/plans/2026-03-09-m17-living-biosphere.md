# M17: Living Biosphere & Evolutionary Simulation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a living species genome system to the player's home planet — species evolve, speciate, and go extinct via deterministic SeedRNG logic; a Biosphere Analysis overlay visualises fungal networks, biome zones, and species clusters on the planet surface.

**Architecture:** `EvolutionEngine.ts` runs deterministic mutation/speciation/extinction every 2000 ticks for the player's star only; NPC stars keep the existing `updateBiologyPhase` system untouched. `BiosphereRenderer.ts` draws Canvas 2D overlays composited over `PlanetRenderer` terrain. Gemini narrates notable events fire-and-forget using the existing GeminiService pattern (never awaited in the sim loop).

**Tech Stack:** TypeScript, Canvas 2D API, SeedRNG (mulberry32 with `.fork()`), BigBangEngine callback pattern (`on*: (() => void) | null = null`), GameStateData persistence via EngineSnapshot.

---

## Codebase Orientation

Read these before starting any task:

| File | Purpose |
|------|---------|
| `src/simulation/GameState.ts` | `GameStateData` interface + `gameState` singleton — extend here for new state |
| `src/simulation/BigBangEngine.ts` | Sim engine; callbacks listed at lines ~300–315; `updateBiologyPhase()` at line 876; `serialize()`/`loadState()` at lines ~2684–2736 |
| `src/simulation/PlanetRenderer.ts` | Planet surface view; `render()` at line 423; `drawPlanetUI()` at line 848 |
| `src/main.ts` | `wireEngineEvents()` at line 359; `addFeedEntry()` at line ~361 (usage); `addChatMessage()` at line 1809; `addCodexEntry()` at line 1706; `_geminiService` at line 35 |
| `src/utils/SeedRNG.ts` | `rng.fork(namespace: string): SeedRNG` — always fork for isolated sub-streams |

**No test framework exists.** Verification is `npx tsc --noEmit` + visual browser check. Use `npm run dev` to start the dev server.

**Architecture rules to follow:**
- Simulation loop NEVER awaits Gemini. All AI calls are fire-and-forget (`.then().catch()`)
- All procedural generation uses `SeedRNG.fork()` — never `Math.random()` in sim code
- New EngineSnapshot fields must be `optional` (`?`) with null-guards in `loadState()`

---

## Task 1: SpeciesGenome + PlanetBiosphere interfaces

**Files:**
- Create: `src/simulation/SpeciesGenome.ts`

**Step 1: Create the file with all types and the `createPrimordialSpecies` factory**

```typescript
// src/simulation/SpeciesGenome.ts

export type Metabolism   = 'photosynthetic' | 'chemosynthetic' | 'heterotrophic' | 'parasitic';
export type Locomotion   = 'stationary' | 'swimming' | 'crawling' | 'walking' | 'flying';
export type Environment  = 'ocean' | 'coastal' | 'land' | 'aerial' | 'deep_sea';
export type Reproduction = 'asexual' | 'sexual' | 'spore';
export type Diet         = 'producer' | 'herbivore' | 'omnivore' | 'carnivore' | 'decomposer';
export type Respiration  = 'anaerobic' | 'aerobic' | 'mixed';
export type SpeciesSize  = 'microscopic' | 'tiny' | 'small' | 'medium' | 'large' | 'massive';

export interface SpeciesGenome {
  id:          string;
  name:        string;
  originTick:  number;
  population:  number;        // 0–1 relative dominance
  isExtinct:   boolean;
  ancestorId:  string | null; // speciation tree

  dna: {
    metabolism:   Metabolism;
    locomotion:   Locomotion;
    environment:  Environment;
    reproduction: Reproduction;
    diet:         Diet;
    respiration:  Respiration;
    intelligence: number;    // 0–10
    social:       number;    // 0–10
    aggression:   number;    // 0–10
    adaptability: number;    // 0–10
  };

  physicalTraits: {
    size:          SpeciesSize;
    bodyStructure: string;
    mobilityType:  string;
    sensorySystem: string;
  };

  habitat: {
    biome:            string;
    temperatureRange: string;
  };

  evolutionaryPotential: {
    landTransition:     number;  // 0–1
    intelligenceGrowth: number;  // 0–1
    toolUse:            number;  // 0–1
  };
}

export interface PlanetBiosphere {
  oxygenLevel:        number;  // 0–1 (photosynthesis drives this up)
  biosphereDensity:   number;  // 0–1 (total life coverage)
  oceanLife:          number;  // 0–1
  landLife:           number;  // 0–1
  biodiversity:       number;  // 0–10 (count of active species)
  extinctionPressure: number;  // 0–1 (asteroid, climate, predation)
}

export const DEFAULT_BIOSPHERE: PlanetBiosphere = {
  oxygenLevel:        0.01,
  biosphereDensity:   0.05,
  oceanLife:          0.10,
  landLife:           0.00,
  biodiversity:       1,
  extinctionPressure: 0.10,
};

export function createPrimordialSpecies(tick: number): SpeciesGenome {
  return {
    id:         `species_0_${tick}`,
    name:       'Primordial Microbe',
    originTick:  tick,
    population:  1.0,
    isExtinct:   false,
    ancestorId:  null,
    dna: {
      metabolism:   'chemosynthetic',
      locomotion:   'stationary',
      environment:  'ocean',
      reproduction: 'asexual',
      diet:         'producer',
      respiration:  'anaerobic',
      intelligence:  0,
      social:        0,
      aggression:    0,
      adaptability:  2,
    },
    physicalTraits: {
      size:          'microscopic',
      bodyStructure: 'single-celled',
      mobilityType:  'flagella',
      sensorySystem: 'chemoreception',
    },
    habitat: {
      biome:            'deep_ocean_vent',
      temperatureRange: 'extreme_heat',
    },
    evolutionaryPotential: {
      landTransition:     0.0,
      intelligenceGrowth: 0.0,
      toolUse:            0.0,
    },
  };
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd "c:/Users/Sirjohn/Documents/Eternal System" && npx tsc --noEmit`
Expected: No errors from the new file.

**Step 3: Commit**

```bash
cd "c:/Users/Sirjohn/Documents/Eternal System"
git add src/simulation/SpeciesGenome.ts
git commit -m "feat(m17): add SpeciesGenome + PlanetBiosphere interfaces"
```

---

## Task 2: Extend GameStateData with playerSpecies + playerBiosphere

**Files:**
- Modify: `src/simulation/GameState.ts`

**Step 1: Add import at top of GameState.ts (after the FactionFlag import at line 2)**

```typescript
import type { SpeciesGenome, PlanetBiosphere } from './SpeciesGenome';
import { DEFAULT_BIOSPHERE } from './SpeciesGenome';
```

**Step 2: Add fields to the GameStateData interface (after `firstContactFired: boolean;` at line 137)**

```typescript
  // M17: Living Biosphere
  playerSpecies:   SpeciesGenome[];
  playerBiosphere: PlanetBiosphere;
```

**Step 3: Add defaults to the gameState singleton (after `firstContactFired: false,` at line 165)**

```typescript
  playerSpecies:   [],
  playerBiosphere: { ...DEFAULT_BIOSPHERE },
```

**Step 4: Verify TypeScript compiles**

Run: `cd "c:/Users/Sirjohn/Documents/Eternal System" && npx tsc --noEmit`
Expected: No errors.

**Step 5: Commit**

```bash
git add src/simulation/GameState.ts
git commit -m "feat(m17): extend GameStateData with playerSpecies + playerBiosphere"
```

---

## Task 3: EvolutionEngine — deterministic mutation / speciation / extinction

**Files:**
- Create: `src/simulation/EvolutionEngine.ts`

This is the core deterministic engine. Key design decisions:
- All randomness uses a `rng.fork(`evo_${tick}`)` so each tick is reproducible.
- `playerDNA` branches bias mutation rolls (see mapping table below).
- Max 8 active species at once — keeps the system tractable.
- Species are deep-copied inside `stepEvolution` so the caller's arrays are not mutated until the result is applied.

**DNA Lab branch → EvolutionEngine bias mapping:**

| DNABranch field | Genome effect |
|-----------------|--------------|
| `intelligence`  | Raises `dna.intelligence` mutation chance; boosts `evolutionaryPotential.intelligenceGrowth` |
| `social`        | Raises `dna.social` mutation chance |
| `aggression`    | Raises `dna.aggression` mutation chance (biodiversity drops at high aggression) |
| `adaptation`    | Raises overall mutation chance + extinction resistance |
| `mobility`      | Boosts locomotion progression + environment transition chances |
| `size`          | Boosts metabolism complexity mutation chance |

**Step 1: Create the file**

```typescript
// src/simulation/EvolutionEngine.ts
import { SeedRNG } from '../utils/SeedRNG';
import { DNABranch } from './GameState';
import {
  SpeciesGenome, PlanetBiosphere,
  Metabolism, Locomotion, Environment, Respiration,
  createPrimordialSpecies,
} from './SpeciesGenome';

export type EvolutionEventType = 'mutation' | 'speciation' | 'extinction';

export interface EvolutionEvent {
  type:            EvolutionEventType;
  speciesId:       string;
  speciesName:     string;
  description:     string;
  newSpeciesId?:   string;   // speciation only
  newSpeciesName?: string;   // speciation only
}

export interface EvolutionResult {
  updatedSpecies:   SpeciesGenome[];
  updatedBiosphere: PlanetBiosphere;
  events:           EvolutionEvent[];
}

export const EVOLUTION_TICK_RATE = 2000;

export function shouldStepEvolution(tick: number): boolean {
  return tick > 0 && tick % EVOLUTION_TICK_RATE === 0;
}

export function initPlayerSpecies(tick: number): SpeciesGenome[] {
  return [createPrimordialSpecies(tick)];
}

export function stepEvolution(
  bioPhase:   string,
  playerDNA:  DNABranch,
  species:    SpeciesGenome[],
  biosphere:  PlanetBiosphere,
  rng:        SeedRNG,
  tick:       number,
): EvolutionResult {
  const evoRng = rng.fork(`evo_${tick}`);
  const events: EvolutionEvent[] = [];

  // Deep-copy so we never mutate caller arrays
  const updatedSpecies: SpeciesGenome[] = species.map(s => ({
    ...s,
    dna:                   { ...s.dna },
    evolutionaryPotential: { ...s.evolutionaryPotential },
    physicalTraits:        { ...s.physicalTraits },
    habitat:               { ...s.habitat },
  }));

  if (updatedSpecies.length === 0) {
    updatedSpecies.push(createPrimordialSpecies(tick));
  }

  const activeSpecies = updatedSpecies.filter(s => !s.isExtinct);

  for (const sp of activeSpecies) {
    // ── Mutation ───────────────────────────────────────────────────────────────
    const mutEvt = tryMutation(sp, evoRng, playerDNA, bioPhase);
    if (mutEvt) events.push(mutEvt);

    // ── Speciation ─────────────────────────────────────────────────────────────
    const specChance = 0.04 + sp.dna.adaptability * 0.005 + playerDNA.adaptation * 0.002;
    if (activeSpecies.length < 8 && sp.population > 0.3 && evoRng.chance(specChance)) {
      const child = branchSpecies(sp, tick, evoRng);
      updatedSpecies.push(child);
      sp.population = Math.max(0.1, sp.population - 0.2);
      events.push({
        type:          'speciation',
        speciesId:     sp.id,
        speciesName:   sp.name,
        description:   `${sp.name} diverged into ${child.name}.`,
        newSpeciesId:   child.id,
        newSpeciesName: child.name,
      });
    }

    // ── Extinction ─────────────────────────────────────────────────────────────
    const extChance = biosphere.extinctionPressure > 0.7
      ? Math.max(0, 0.12 - sp.dna.adaptability * 0.01 - playerDNA.adaptation * 0.005)
      : 0;
    if (sp.population < 0.05 || evoRng.chance(extChance)) {
      sp.isExtinct = true;
      events.push({
        type:        'extinction',
        speciesId:   sp.id,
        speciesName: sp.name,
        description: `${sp.name} has gone extinct.`,
      });
    }
  }

  const updatedBiosphere = updateBiosphere(updatedSpecies, biosphere, bioPhase);

  return { updatedSpecies, updatedBiosphere, events };
}

// ── Internal helpers ───────────────────────────────────────────────────────────

interface MutOption { trait: string; newValue: unknown; }

function tryMutation(
  sp:        SpeciesGenome,
  rng:       SeedRNG,
  playerDNA: DNABranch,
  bioPhase:  string,
): EvolutionEvent | null {
  const mutChance = 0.15 + sp.dna.adaptability * 0.02 + playerDNA.adaptation * 0.003;
  if (!rng.chance(mutChance)) return null;

  const opts = collectMutations(sp, playerDNA, bioPhase, rng);
  if (opts.length === 0) return null;

  const pick   = opts[rng.nextInt(0, opts.length - 1)];
  const oldVal = String((sp.dna as Record<string, unknown>)[pick.trait] ?? '');
  (sp.dna as Record<string, unknown>)[pick.trait] = pick.newValue;

  // Side-effects on evolutionaryPotential
  if (pick.trait === 'intelligence') {
    sp.evolutionaryPotential.intelligenceGrowth = Math.min(
      1, sp.evolutionaryPotential.intelligenceGrowth + playerDNA.intelligence * 0.005
    );
    if (sp.dna.intelligence > 5) {
      sp.evolutionaryPotential.toolUse = Math.min(1, sp.evolutionaryPotential.toolUse + 0.05);
    }
  }
  if (pick.trait === 'locomotion' && pick.newValue === 'walking') {
    sp.evolutionaryPotential.landTransition = Math.min(
      1, sp.evolutionaryPotential.landTransition + 0.2
    );
  }

  // Sync physicalTraits with dna mutations so the sprite stays accurate
  if (pick.trait === 'locomotion') {
    const mobilityMap: Record<string, string> = {
      stationary: 'flagella',
      swimming:   'fins',
      crawling:   'undulation',
      walking:    'legs',
      flying:     'wings',
    };
    sp.physicalTraits.mobilityType = mobilityMap[String(pick.newValue)] ?? sp.physicalTraits.mobilityType;
  }
  if (pick.trait === 'intelligence') {
    if (sp.dna.intelligence > 6) sp.physicalTraits.bodyStructure = 'vertebrate';
    else if (sp.dna.intelligence > 3 && sp.physicalTraits.bodyStructure === 'single-celled')
      sp.physicalTraits.bodyStructure = 'segmented';
  }
  if (pick.trait === 'social' && sp.dna.social > 5 && sp.physicalTraits.sensorySystem === 'chemoreception') {
    sp.physicalTraits.sensorySystem = 'vision';
  }

  return {
    type:        'mutation',
    speciesId:   sp.id,
    speciesName: sp.name,
    description: `${sp.name} evolved: ${pick.trait} ${oldVal} → ${String(pick.newValue)}.`,
  };
}

function collectMutations(
  sp:        SpeciesGenome,
  playerDNA: DNABranch,
  bioPhase:  string,
  rng:       SeedRNG,
): MutOption[] {
  const opts: MutOption[]  = [];
  const d                  = sp.dna;
  const isMicrobial        = bioPhase === 'microbial';
  const isMulticellular    = bioPhase === 'multicellular';
  const isComplexOrPrimitive = bioPhase === 'complex' || bioPhase === 'primitive';

  // Locomotion progression (phase-gated)
  if (!isMicrobial) {
    if (d.locomotion === 'stationary' && rng.chance(0.5))
      opts.push({ trait: 'locomotion', newValue: 'swimming' as Locomotion });
    if (d.locomotion === 'swimming' && rng.chance(0.4))
      opts.push({ trait: 'locomotion', newValue: 'crawling' as Locomotion });
    if (d.locomotion === 'crawling' && !isMulticellular && rng.chance(0.3 + playerDNA.mobility * 0.004))
      opts.push({ trait: 'locomotion', newValue: 'walking' as Locomotion });
    if (d.locomotion === 'walking' && rng.chance(0.2))
      opts.push({ trait: 'locomotion', newValue: 'flying' as Locomotion });
  }

  // Environment transitions (land colonization)
  if (d.environment === 'ocean' && !isMicrobial && rng.chance(0.25 + playerDNA.mobility * 0.003))
    opts.push({ trait: 'environment', newValue: 'coastal' as Environment });
  if (d.environment === 'coastal' && rng.chance(0.20 + playerDNA.mobility * 0.003))
    opts.push({ trait: 'environment', newValue: 'land' as Environment });

  // Respiration evolution (photosynthesis → aerobic → oxygen buildup)
  if (d.respiration === 'anaerobic' && rng.chance(0.30))
    opts.push({ trait: 'respiration', newValue: 'mixed'   as Respiration });
  if (d.respiration === 'mixed'     && rng.chance(0.25))
    opts.push({ trait: 'respiration', newValue: 'aerobic' as Respiration });

  // Metabolism (size DNA branch biases photosynthesis unlock)
  if (d.metabolism === 'chemosynthetic' && rng.chance(0.35 + playerDNA.size * 0.003))
    opts.push({ trait: 'metabolism', newValue: 'photosynthetic' as Metabolism });
  if (d.metabolism === 'photosynthetic' && rng.chance(0.20))
    opts.push({ trait: 'metabolism', newValue: 'heterotrophic'  as Metabolism });

  // Intelligence (complex+ phase only; biased by intelligence DNA branch)
  if (isComplexOrPrimitive && d.intelligence < 10) {
    const intChance = 0.10
      + playerDNA.intelligence * 0.008
      + sp.evolutionaryPotential.intelligenceGrowth * 0.10;
    if (rng.chance(intChance))
      opts.push({ trait: 'intelligence', newValue: Math.min(10, d.intelligence + 1) });
  }

  // Social (biased by social DNA branch)
  if (d.social < 10 && rng.chance(0.10 + playerDNA.social * 0.005))
    opts.push({ trait: 'social', newValue: Math.min(10, d.social + 1) });

  // Aggression (biased by aggression DNA branch)
  if (d.aggression < 10 && rng.chance(0.08 + playerDNA.aggression * 0.004))
    opts.push({ trait: 'aggression', newValue: Math.min(10, d.aggression + 1) });

  return opts;
}

function branchSpecies(parent: SpeciesGenome, tick: number, rng: SeedRNG): SpeciesGenome {
  const PREFIXES = ['Neo', 'Para', 'Proto', 'Xeno', 'Hyper', 'Sub', 'Archi'];
  const prefix   = PREFIXES[rng.nextInt(0, PREFIXES.length - 1)];
  const baseName = parent.name.replace(/^(Neo|Para|Proto|Xeno|Hyper|Sub|Archi)/, '');
  return {
    ...parent,
    id:         `species_${tick}_${rng.nextInt(1000, 9999)}`,
    name:        prefix + baseName,
    originTick:  tick,
    population:  0.2,
    isExtinct:   false,
    ancestorId:  parent.id,
    dna: {
      ...parent.dna,
      adaptability: Math.max(1, Math.min(10, parent.dna.adaptability + rng.nextInt(-1, 1))),
      aggression:   Math.max(0, Math.min(10, parent.dna.aggression   + rng.nextInt(-1, 2))),
    },
    evolutionaryPotential: {
      ...parent.evolutionaryPotential,
      landTransition: Math.min(1, parent.evolutionaryPotential.landTransition + rng.nextFloat(0, 0.15)),
    },
  };
}

function updateBiosphere(
  species:  SpeciesGenome[],
  bio:      PlanetBiosphere,
  bioPhase: string,
): PlanetBiosphere {
  const active       = species.filter(s => !s.isExtinct);
  const photoCount   = active.filter(s => s.dna.metabolism  === 'photosynthetic').length;
  const aerobicCount = active.filter(s => s.dna.respiration === 'aerobic').length;
  const landCount    = active.filter(s => s.dna.environment === 'land' || s.dna.environment === 'coastal').length;
  const oceanCount   = active.filter(s => s.dna.environment === 'ocean' || s.dna.environment === 'deep_sea').length;

  const newOxygen  = Math.min(1, bio.oxygenLevel  + photoCount  * 0.002 + aerobicCount * 0.001);
  const newLand    = Math.min(1, bio.landLife      + landCount   * 0.010);
  const newOcean   = Math.min(1, bio.oceanLife     + oceanCount  * 0.010);
  const totalPop   = active.reduce((sum, s) => sum + s.population, 0);
  const newDensity = Math.min(1, totalPop * 0.25 + (bioPhase === 'primitive' ? 0.35 : 0));
  const avgAgg     = active.length > 0
    ? active.reduce((sum, s) => sum + s.dna.aggression, 0) / active.length
    : 0;
  const newPressure = Math.max(0, Math.min(1,
    bio.extinctionPressure * 0.99 + avgAgg * 0.008 - newDensity * 0.002
  ));

  return {
    oxygenLevel:        newOxygen,
    biosphereDensity:   newDensity,
    oceanLife:          newOcean,
    landLife:           newLand,
    biodiversity:       Math.min(10, active.length),
    extinctionPressure: newPressure,
  };
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd "c:/Users/Sirjohn/Documents/Eternal System" && npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/simulation/EvolutionEngine.ts
git commit -m "feat(m17): add EvolutionEngine — deterministic mutation/speciation/extinction"
```

---

## Task 4: Wire EvolutionEngine into BigBangEngine

**Files:**
- Modify: `src/simulation/BigBangEngine.ts`

This task adds 3 new callbacks, imports the engine, and calls `stepEvolution()` every `EVOLUTION_TICK_RATE` ticks for the player's star (inside the existing biology-phase block at line 767).

**Step 1: Add imports (after line 11, after the FactionFlag import)**

```typescript
import {
  stepEvolution, shouldStepEvolution, initPlayerSpecies,
  type EvolutionEvent, EVOLUTION_TICK_RATE,
} from './EvolutionEngine';
```

Also extend the existing `import type { SpeciesGenome } from './SpeciesGenome';` (added in Task 1 — if it doesn't exist, add it). Extend it to also import `PlanetBiosphere`:

```typescript
import type { SpeciesGenome, PlanetBiosphere } from './SpeciesGenome';
```

**Step 2: Add the EngineSnapshot fields for persistence (we'll use them in Task 9)**

In the `EngineSnapshot` interface (line ~186), after `cosmicSignals?: CosmicSignal[];`, add:

```typescript
  playerSpecies?:   SpeciesGenome[];
  playerBiosphere?: PlanetBiosphere;
```

**Step 3: Add 3 new callbacks (after line 315, after `onSignalDecoded`)**

```typescript
  onMutationEvent:   ((event: EvolutionEvent) => void) | null = null;
  onSpeciationEvent: ((event: EvolutionEvent) => void) | null = null;
  onExtinctionEvent: ((event: EvolutionEvent) => void) | null = null;
```

**Step 4: Wire the evolution step (at line 767–770)**

Find this block (lines 767–770):

```typescript
      if (star.biologyPhase !== 'intelligent') {
        this.updateBiologyPhase(star);
        continue; // no civilisation advancement until intelligence emerges
      }
```

Replace it with:

```typescript
      if (star.biologyPhase !== 'intelligent') {
        this.updateBiologyPhase(star);

        // M17: Deterministic evolution for player star only
        if (star.isPlayerStar) {
          if (gameState.playerSpecies.length === 0) {
            gameState.playerSpecies = initPlayerSpecies(this.tick);
          }
          if (shouldStepEvolution(this.tick)) {
            const result = stepEvolution(
              star.biologyPhase,
              gameState.playerDNA,
              gameState.playerSpecies,
              gameState.playerBiosphere,
              this.rng,
              this.tick,
            );
            gameState.playerSpecies   = result.updatedSpecies;
            gameState.playerBiosphere = result.updatedBiosphere;
            for (const evt of result.events) {
              if (evt.type === 'mutation')    this.onMutationEvent?.(evt);
              if (evt.type === 'speciation')  this.onSpeciationEvent?.(evt);
              if (evt.type === 'extinction')  this.onExtinctionEvent?.(evt);
            }
          }
        }

        continue; // no civilisation advancement until intelligence emerges
      }
```

**Step 5: Verify TypeScript compiles**

Run: `cd "c:/Users/Sirjohn/Documents/Eternal System" && npx tsc --noEmit`
Expected: No errors.

**Step 6: Commit**

```bash
git add src/simulation/BigBangEngine.ts
git commit -m "feat(m17): wire EvolutionEngine into BigBangEngine for player star bio ticks"
```

---

## Task 5: Wire evolution callbacks in main.ts

**Files:**
- Modify: `src/main.ts`

Wire `onMutationEvent`, `onSpeciationEvent`, `onExtinctionEvent` inside `wireEngineEvents()`. Follow the exact same fire-and-forget pattern as `onBioPhaseAdvance` (line 469).

**Context:** The helpers you'll call are:
- `addFeedEntry(msg, category)` — adds to event feed (categories: `'biology'`, `'extinction'`, `'milestone'`)
- `addChatMessage(text, 'god')` — adds a message to God chat panel
- `addCodexEntry(title, category)` — adds Codex entry, returns `CodexEntry`
- `_geminiService` — `GeminiService | null`, 3-second debounce per call

**Step 1: Add import at top of main.ts (after the LeaderDialogue imports)**

```typescript
import type { EvolutionEvent } from './simulation/EvolutionEngine';
```

**Step 2: Add the 3 callbacks inside `wireEngineEvents()` (after the `eng.onBioPhaseAdvance` block, around line 473)**

```typescript
  // M17: Evolution events
  eng.onMutationEvent = (evt: EvolutionEvent) => {
    addFeedEntry(`🧬 ${evt.description}`, 'biology');
  };

  eng.onSpeciationEvent = (evt: EvolutionEvent) => {
    addFeedEntry(`🌿 SPECIATION: ${evt.description}`, 'biology');
    addCodexEntry(`New Species: ${evt.newSpeciesName ?? evt.speciesName}`, 'biology');
    _geminiService?.sendPlayerMessage(
      `[SPECIATION EVENT — narrate in 2 sentences as the divine observer]: ${evt.description}`
    ).then(res => {
      if (res) addChatMessage(res, 'god');
    }).catch(() => { /* silent */ });
  };

  eng.onExtinctionEvent = (evt: EvolutionEvent) => {
    addFeedEntry(`💀 EXTINCTION: ${evt.description}`, 'extinction');
    addCodexEntry(`Extinction: ${evt.speciesName}`, 'extinction');
    _geminiService?.sendPlayerMessage(
      `[EXTINCTION EVENT — narrate in 2 sentences as the divine observer]: ${evt.description}`
    ).then(res => {
      if (res) addChatMessage(res, 'god');
    }).catch(() => { /* silent */ });
  };
```

**Note:** Check that `addChatMessage` signature is `(text: string, type: 'god' | 'player' | 'system')` — confirm at line 1809 before writing. If the order of arguments differs from what you see in existing usage, match the existing usage exactly.

**Step 3: Verify TypeScript compiles**

Run: `cd "c:/Users/Sirjohn/Documents/Eternal System" && npx tsc --noEmit`
Expected: No errors.

**Step 4: Browser verification**

1. `npm run dev` → open in browser → start new game
2. Speed up to 1000×, wait for evolution ticks (every 2000 sim ticks = ~2 seconds at 1000×)
3. Confirm `🧬` mutation entries appear in the event feed
4. After a speciation event: confirm Codex has a new "New Species: ..." entry

**Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(m17): wire onMutationEvent/onSpeciationEvent/onExtinctionEvent to feed + codex + gemini"
```

---

## Task 6: BiosphereRenderer — Canvas 2D overlay

**Files:**
- Create: `src/simulation/BiosphereRenderer.ts`

**Architecture note:** Two exported draw functions with different coordinate spaces:
1. `drawBiosphereTerrainLayer(ctx, W, H, tick, species, biosphere, seedId)` — called inside PlanetRenderer's world-space `ctx.save()/restore()` block. Uses `W=1200, H=600` (MAP dimensions).
2. `drawBiosphereHUDLayer(ctx, W, H, species, biosphere)` — called from `drawPlanetUI()` in screen space. Uses canvas `width`/`height`.

**Critical design rule:** All terrain visuals are **derived from actual species traits**. Nothing is hardcoded. A fungal network only appears if a species actually has `locomotion: 'stationary'` or `diet: 'decomposer'` on land. Cyanobacteria only appear if a species has `metabolism: 'photosynthetic'` in ocean/coastal water. The visual is the species.

**Trait → visual pattern mapping:**

| Species traits | Terrain pattern |
|----------------|----------------|
| `environment: 'land'` + (`locomotion: 'stationary'` or `diet: 'decomposer'`) | Branching network (root/fungal structure) |
| `environment: 'land'` + `metabolism: 'photosynthetic'` | Plant canopy cluster (blob + radiating lines) |
| `environment: 'land'` + `locomotion: 'crawling'` | Ground trail dots |
| `environment: 'land'` + `locomotion: 'walking'` | Territory path lines |
| `locomotion: 'flying'` | Curved aerial arc trails |
| `environment: 'ocean'` + `metabolism: 'photosynthetic'` | Cyanobacteria swirl blooms |
| `environment: 'ocean'` + `locomotion: 'swimming'` | Spiral current patterns |
| `environment: 'deep_sea'` | Bioluminescent scattered dots |
| `environment: 'coastal'` + `metabolism: 'photosynthetic'` | Coastal algae patches |
| Anything else (microscopic, simple) | No terrain pattern (only blob + marker) |

**Step 1: Create the file**

```typescript
// src/simulation/BiosphereRenderer.ts
import { SeedRNG } from '../utils/SeedRNG';
import { SpeciesGenome, PlanetBiosphere } from './SpeciesGenome';

// ── Color + size maps ─────────────────────────────────────────────────────────

const ENV_COLORS: Record<string, [number, number, number]> = {
  ocean:    [26,  74, 110],
  deep_sea: [10,  32,  48],
  coastal:  [42, 122,  78],
  land:     [74, 110,  42],
  aerial:   [110, 138, 170],
};

const SIZE_RADIUS: Record<string, number> = {
  microscopic: 3,
  tiny:        5,
  small:       7,
  medium:      9,
  large:       12,
  massive:     16,
};

function envRgb(env: string): string {
  const c = ENV_COLORS[env] ?? [68, 102, 68];
  return `${c[0]},${c[1]},${c[2]}`;
}

// ── Trait → pattern resolver ───────────────────────────────────────────────────

type TerrainPattern =
  | 'branching_network'   // fungal / root-like (stationary land, decomposer)
  | 'plant_canopy'        // photosynthetic land
  | 'crawl_trails'        // crawling land
  | 'walk_territory'      // walking land
  | 'aerial_arcs'         // flying
  | 'ocean_blooms'        // photosynthetic ocean (cyanobacteria)
  | 'swim_currents'       // swimming ocean
  | 'bioluminescence'     // deep sea
  | 'coastal_algae'       // photosynthetic coastal
  | 'none';               // too simple / microscopic / unclassified

function getTerrainPattern(sp: SpeciesGenome): TerrainPattern {
  const { environment, locomotion, diet, metabolism } = sp.dna;

  if (locomotion === 'flying') return 'aerial_arcs';

  switch (environment) {
    case 'land':
      if (locomotion === 'stationary' || diet === 'decomposer') return 'branching_network';
      if (metabolism === 'photosynthetic')                       return 'plant_canopy';
      if (locomotion === 'crawling')                             return 'crawl_trails';
      if (locomotion === 'walking')                              return 'walk_territory';
      return 'none';

    case 'ocean':
      if (metabolism === 'photosynthetic') return 'ocean_blooms';
      if (locomotion === 'swimming')       return 'swim_currents';
      return 'none';

    case 'coastal':
      if (metabolism === 'photosynthetic') return 'coastal_algae';
      return 'none';

    case 'deep_sea':
      return 'bioluminescence';

    default:
      return 'none';
  }
}

// ── World-space terrain layer (1200×600 coords) ───────────────────────────────

export function drawBiosphereTerrainLayer(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  tick:    number,
  species: SpeciesGenome[],
  bio:     PlanetBiosphere,
  seedId:  number,
): void {
  const active = species.filter(s => !s.isExtinct);

  ctx.save();

  // 1. Biome zone blobs (background color zones per species — always drawn)
  drawBiomeBlobs(ctx, W, H, active, new SeedRNG(`bio_blobs_${seedId}`));

  // 2. Per-species terrain pattern (derived from actual traits)
  for (const sp of active) {
    const pattern = getTerrainPattern(sp);
    if (pattern === 'none') continue;
    const spRng = new SeedRNG(`bio_pat_${seedId}_${sp.id}`);
    drawTerrainPattern(ctx, W, H, tick, sp, pattern, spRng);
  }

  // 3. Species sprites (on top of patterns — trait-driven creature silhouettes)
  drawSpeciesSprites(ctx, W, H, active, new SeedRNG(`bio_markers_${seedId}`), tick);

  ctx.restore();
}

function drawTerrainPattern(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  tick:    number,
  sp:      SpeciesGenome,
  pattern: TerrainPattern,
  rng:     SeedRNG,
): void {
  const col = ENV_COLORS[sp.dna.environment] ?? [68, 102, 68];
  const alpha = Math.min(0.30, sp.population * 0.32);
  const count = Math.floor(sp.population * 14) + 3;

  switch (pattern) {

    case 'branching_network': {
      // Root/fungal: recursive branching lines on land (right-biased)
      ctx.strokeStyle = `rgba(${col[0]+60},${col[1]+60},${col[2]+40},${alpha + 0.05})`;
      ctx.lineWidth   = 0.8;
      for (let i = 0; i < count; i++) {
        const sx = rng.nextFloat(W * 0.35, W * 0.95);
        const sy = rng.nextFloat(H * 0.08, H * 0.92);
        drawBranch(ctx, sx, sy, rng.nextFloat(-90, 90), 50, 4, rng);
      }
      break;
    }

    case 'plant_canopy': {
      // Photosynthetic land: filled circles with short radiating spokes
      for (let i = 0; i < count; i++) {
        const cx = rng.nextFloat(W * 0.35, W * 0.95);
        const cy = rng.nextFloat(H * 0.08, H * 0.92);
        const r  = rng.nextFloat(8, 22) * sp.population;
        ctx.fillStyle   = `rgba(${col[0]},${col[1]},${col[2]},${alpha})`;
        ctx.strokeStyle = `rgba(${col[0]+40},${col[1]+60},${col[2]},${alpha * 0.6})`;
        ctx.lineWidth   = 0.7;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        // 6 short spokes
        for (let s = 0; s < 6; s++) {
          const a = (s / 6) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          ctx.lineTo(cx + Math.cos(a) * (r + 10), cy + Math.sin(a) * (r + 10));
          ctx.stroke();
        }
      }
      break;
    }

    case 'crawl_trails': {
      // Dotted ground trails on land
      ctx.fillStyle = `rgba(${col[0]+30},${col[1]+20},${col[2]},${alpha + 0.08})`;
      for (let i = 0; i < count * 4; i++) {
        const x = rng.nextFloat(W * 0.30, W * 0.95);
        const y = rng.nextFloat(H * 0.08, H * 0.92);
        ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }

    case 'walk_territory': {
      // Walking: path-like lines + zone outlines on land
      ctx.strokeStyle = `rgba(${col[0]+50},${col[1]+40},${col[2]},${alpha + 0.06})`;
      ctx.lineWidth   = 1.2;
      for (let i = 0; i < count; i++) {
        const sx = rng.nextFloat(W * 0.30, W * 0.95);
        const sy = rng.nextFloat(H * 0.08, H * 0.92);
        const ex = sx + rng.nextFloat(-60, 60);
        const ey = sy + rng.nextFloat(-40, 40);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      }
      break;
    }

    case 'aerial_arcs': {
      // Flying: curved arcs across the whole map
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha * 0.7})`;
      ctx.lineWidth   = 0.8;
      for (let i = 0; i < count; i++) {
        const sx  = rng.nextFloat(0, W);
        const sy  = rng.nextFloat(0, H);
        const cpx = rng.nextFloat(0, W);
        const cpy = rng.nextFloat(0, H * 0.5);
        const ex  = rng.nextFloat(0, W);
        const ey  = rng.nextFloat(0, H);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cpx, cpy, ex, ey); ctx.stroke();
      }
      break;
    }

    case 'ocean_blooms': {
      // Photosynthetic ocean: pulsing radial blooms (cyanobacteria style)
      for (let i = 0; i < count; i++) {
        const cx    = rng.nextFloat(0, W * 0.50);
        const cy    = rng.nextFloat(H * 0.05, H * 0.95);
        const r     = rng.nextFloat(18, 55);
        const pulse = 0.5 + 0.5 * Math.sin(tick * 0.05 + i + sp.id.length);
        const grad  = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, `rgba(${col[0]+20},${col[1]+80},${col[2]+60},${0.35 * pulse})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }

    case 'swim_currents': {
      // Swimming: spiral/swirl current patterns in ocean
      ctx.strokeStyle = `rgba(${col[0]+30},${col[1]+50},${col[2]+80},${alpha * 0.8})`;
      ctx.lineWidth   = 0.7;
      for (let i = 0; i < count; i++) {
        const cx = rng.nextFloat(0, W * 0.55);
        const cy = rng.nextFloat(H * 0.05, H * 0.95);
        const r  = rng.nextFloat(15, 45);
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 3; a += 0.2) {
          const spiral = r * (1 - a / (Math.PI * 3));
          const x = cx + Math.cos(a) * spiral;
          const y = cy + Math.sin(a) * spiral;
          a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }

    case 'bioluminescence': {
      // Deep sea: scattered glowing dots across whole ocean area
      for (let i = 0; i < count * 5; i++) {
        const x     = rng.nextFloat(0, W * 0.45);
        const y     = rng.nextFloat(0, H);
        const pulse = 0.4 + 0.6 * Math.sin(tick * 0.04 + i * 0.7);
        ctx.fillStyle = `rgba(${col[0]+40},${col[1]+100},${col[2]+120},${pulse * 0.55})`;
        ctx.beginPath(); ctx.arc(x, y, rng.nextFloat(1, 3), 0, Math.PI * 2); ctx.fill();
      }
      break;
    }

    case 'coastal_algae': {
      // Coastal photosynthetic: irregular algae patches along coast band
      for (let i = 0; i < count; i++) {
        const cx = rng.nextFloat(W * 0.35, W * 0.55); // coastal band
        const cy = rng.nextFloat(H * 0.05, H * 0.95);
        const rx = rng.nextFloat(12, 40);
        const ry = rng.nextFloat(8, 24);
        ctx.fillStyle = `rgba(${col[0]},${col[1]+40},${col[2]},${alpha + 0.05})`;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, rng.nextFloat(0, Math.PI), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }
}

function drawBranch(
  ctx:    CanvasRenderingContext2D,
  x:      number,
  y:      number,
  angle:  number,
  length: number,
  depth:  number,
  rng:    SeedRNG,
): void {
  if (depth <= 0 || length < 5) return;
  const rad  = (angle * Math.PI) / 180;
  const endX = x + Math.cos(rad) * length;
  const endY = y + Math.sin(rad) * length;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  drawBranch(ctx, endX, endY, angle + rng.nextFloat(20, 50), length * 0.6, depth - 1, rng);
  drawBranch(ctx, endX, endY, angle - rng.nextFloat(20, 50), length * 0.6, depth - 1, rng);
}

function drawBiomeBlobs(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  species: SpeciesGenome[],
  rng:     SeedRNG,
): void {
  for (const sp of species) {
    const alpha = Math.min(0.30, sp.population * 0.35);
    if (alpha < 0.02) continue;

    ctx.fillStyle = `rgba(${envRgb(sp.dna.environment)},${alpha})`;
    const cx = rng.nextFloat(W * 0.05, W * 0.95);
    const cy = rng.nextFloat(H * 0.10, H * 0.90);
    const rx = rng.nextFloat(40, 120) * sp.population;
    const ry = rng.nextFloat(30,  80) * sp.population;

    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, rng.nextFloat(0, Math.PI), 0, Math.PI * 2);
    ctx.fill();

    // Label on dominant blobs
    if (sp.population > 0.45) {
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.font      = '9px Cinzel, serif';
      ctx.textAlign = 'center';
      ctx.fillText(sp.name.slice(0, 14), cx, cy + 4);
    }
  }
}

// Scatter one sprite cluster per species across the map.
// Dominant species gets a larger sprite + a subtle glow ring.
function drawSpeciesSprites(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  species: SpeciesGenome[],
  rng:     SeedRNG,
  tick:    number,
): void {
  if (species.length === 0) return;
  const maxPop = Math.max(...species.map(s => s.population));

  for (const sp of species) {
    const cx = rng.nextFloat(W * 0.05, W * 0.95);
    const cy = rng.nextFloat(H * 0.10, H * 0.90);
    const baseR = SIZE_RADIUS[sp.physicalTraits.size] ?? 6;

    // Dominant species: glow ring behind sprite
    if (sp.population === maxPop) {
      const pulse = 0.5 + 0.5 * Math.sin(tick * 0.06 + sp.id.length);
      const col   = ENV_COLORS[sp.dna.environment] ?? [68, 102, 68];
      const grad  = ctx.createRadialGradient(cx, cy, baseR, cx, cy, baseR * 3);
      grad.addColorStop(0, `rgba(${col[0]+60},${col[1]+80},${col[2]+40},${0.25 * pulse})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    drawSpeciesSprite(ctx, sp, cx, cy, baseR, tick);
  }
}

// Draw a single creature silhouette from physicalTraits + dna.
// physicalTraits is kept in sync with dna by EvolutionEngine.tryMutation(),
// so the sprite automatically reflects what the player evolved.
function drawSpeciesSprite(
  ctx:   CanvasRenderingContext2D,
  sp:    SpeciesGenome,
  cx:    number,
  cy:    number,
  baseR: number,
  tick:  number,
): void {
  const col   = ENV_COLORS[sp.dna.environment] ?? [68, 102, 68];
  const pulse = 0.92 + 0.08 * Math.sin(tick * 0.08 + sp.id.length);
  const r     = baseR * pulse;
  const { bodyStructure, mobilityType, sensorySystem } = sp.physicalTraits;

  ctx.fillStyle   = `rgb(${col[0]},${col[1]},${col[2]})`;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth   = 0.8;

  // ── Body ──────────────────────────────────────────────────────────────────
  if (bodyStructure === 'single-celled') {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  } else if (bodyStructure === 'segmented') {
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse(cx + (i - 1) * r * 0.9, cy, r * 0.6, r * 0.45, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }

  } else {
    // vertebrate: oval body + smaller head
    ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.2, r * 0.7, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + r * 1.3, cy, r * 0.42, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  // ── Mobility appendages ───────────────────────────────────────────────────
  ctx.strokeStyle = `rgba(${col[0]+50},${col[1]+50},${col[2]+50},0.6)`;
  ctx.lineWidth   = 0.6;

  if (mobilityType === 'flagella') {
    for (let i = 0; i < 3; i++) {
      const a = Math.PI + (i - 1) * 0.4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r,       cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * r * 2.4, cy + Math.sin(a) * r * 1.5);
      ctx.stroke();
    }

  } else if (mobilityType === 'fins') {
    ctx.fillStyle = `rgba(${col[0]+30},${col[1]+30},${col[2]+30},0.45)`;
    // top fin
    ctx.beginPath(); ctx.moveTo(cx, cy - r * 0.4); ctx.lineTo(cx - r * 0.7, cy - r * 1.4); ctx.lineTo(cx + r * 0.4, cy - r * 0.4); ctx.closePath(); ctx.fill();
    // bottom fin
    ctx.beginPath(); ctx.moveTo(cx, cy + r * 0.4); ctx.lineTo(cx - r * 0.7, cy + r * 1.4); ctx.lineTo(cx + r * 0.4, cy + r * 0.4); ctx.closePath(); ctx.fill();

  } else if (mobilityType === 'legs' || mobilityType === 'undulation') {
    const legCount = mobilityType === 'undulation' ? 6 : (sp.dna.social > 5 ? 4 : 6);
    for (let i = 0; i < legCount; i++) {
      const a = ((i / legCount) * Math.PI) + Math.PI * 0.1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8);
      ctx.lineTo(cx + Math.cos(a) * r * 1.9, cy + Math.sin(a) * r * 1.6);
      ctx.stroke();
    }

  } else if (mobilityType === 'wings') {
    ctx.fillStyle   = `rgba(${col[0]+30},${col[1]+50},${col[2]+30},0.20)`;
    ctx.strokeStyle = `rgba(${col[0]+60},${col[1]+80},${col[2]+60},0.5)`;
    ctx.lineWidth   = 0.7;
    // left wing
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(cx - r * 2, cy - r * 1.5, cx - r * 3, cy + r * 0.5); ctx.lineTo(cx, cy); ctx.fill(); ctx.stroke();
    // right wing
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(cx + r * 2, cy - r * 1.5, cx + r * 3, cy + r * 0.5); ctx.lineTo(cx, cy); ctx.fill(); ctx.stroke();
  }

  // ── Sensory organs ────────────────────────────────────────────────────────
  const headX = bodyStructure === 'vertebrate' ? cx + r * 1.3
              : bodyStructure === 'segmented'  ? cx + r
              : cx;

  if (sensorySystem === 'vision') {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(headX, cy - r * 0.22, r * 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(headX, cy + r * 0.22, r * 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.beginPath(); ctx.arc(headX + r * 0.05, cy - r * 0.22, r * 0.08, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(headX + r * 0.05, cy + r * 0.22, r * 0.08, 0, Math.PI * 2); ctx.fill();

  } else if (sensorySystem === 'chemoreception') {
    ctx.strokeStyle = `rgba(${col[0]+80},${col[1]+80},${col[2]+80},0.65)`;
    ctx.lineWidth   = 0.5;
    ctx.beginPath(); ctx.moveTo(headX, cy - r * 0.25); ctx.lineTo(headX + r * 0.5, cy - r * 1.1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(headX, cy - r * 0.05); ctx.lineTo(headX + r * 0.7, cy - r * 1.0); ctx.stroke();
  }
}

// ── Screen-space HUD layer (canvas width×height coords) ──────────────────────

export function drawBiosphereHUDLayer(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  species: SpeciesGenome[],
  bio:     PlanetBiosphere,
): void {
  drawBiosphereHUD(ctx, W, H, species, bio);
  drawLegend(ctx, W, H, species);
}

function drawBiosphereHUD(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  species: SpeciesGenome[],
  bio:     PlanetBiosphere,
): void {
  const panelW = 185, panelH = 128;
  const px = W - panelW - 10, py = 56;

  ctx.fillStyle   = 'rgba(4,2,12,0.82)';
  ctx.strokeStyle = 'rgba(0,200,160,0.4)';
  ctx.lineWidth   = 1;
  ctx.fillRect  (px, py, panelW, panelH);
  ctx.strokeRect(px, py, panelW, panelH);

  ctx.fillStyle = '#44ccaa';
  ctx.font      = '9px Cinzel Decorative, serif';
  ctx.textAlign = 'left';
  ctx.fillText('BIOSPHERE ANALYSIS', px + 8, py + 15);

  const rows: [string, string][] = [
    ['O₂ Level',      `${Math.round(bio.oxygenLevel * 100)}%`],
    ['Biodiversity',  `${bio.biodiversity} species`],
    ['Ocean Life',    `${Math.round(bio.oceanLife * 100)}%`],
    ['Land Life',     `${Math.round(bio.landLife * 100)}%`],
    ['Ext. Pressure', `${Math.round(bio.extinctionPressure * 100)}%`],
  ];

  rows.forEach(([label, value], i) => {
    const ry = py + 30 + i * 16;
    ctx.fillStyle = '#7b8aaa';
    ctx.font      = '8px Cinzel, serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, px + 8, ry);
    ctx.fillStyle = '#d4c5e8';
    ctx.textAlign = 'right';
    ctx.fillText(value, px + panelW - 8, ry);
  });

  // Biosphere density bar
  const barY = py + panelH - 14;
  const barW = panelW - 16;
  ctx.fillStyle = 'rgba(68,204,136,0.18)';
  ctx.fillRect(px + 8, barY, barW, 6);
  ctx.fillStyle = '#44cc88';
  ctx.fillRect(px + 8, barY, barW * bio.biosphereDensity, 6);
}

function drawLegend(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  species: SpeciesGenome[],
): void {
  const active = species.filter(s => !s.isExtinct);
  if (active.length === 0) return;

  const rows    = active.slice(0, 5);
  const panelW  = 162;
  const panelH  = 18 + rows.length * 18;
  const px = 10, py = H - panelH - 58;

  ctx.fillStyle   = 'rgba(4,2,12,0.76)';
  ctx.strokeStyle = 'rgba(123,94,167,0.4)';
  ctx.lineWidth   = 1;
  ctx.fillRect  (px, py, panelW, panelH);
  ctx.strokeRect(px, py, panelW, panelH);

  ctx.fillStyle = '#7b5ea7';
  ctx.font      = '8px Cinzel, serif';
  ctx.textAlign = 'left';
  ctx.fillText('ACTIVE LIFE FORMS', px + 8, py + 12);

  rows.forEach((sp, i) => {
    const ry = py + 22 + i * 18;
    // Mini sprite in legend (fixed tick=0 so it doesn't animate in the panel)
    drawSpeciesSprite(ctx, sp, px + 12, ry - 3, 5, 0);
    ctx.fillStyle = '#c8c8d8';
    ctx.textAlign = 'left';
    ctx.fillText(sp.name.slice(0, 18), px + 24, ry);
    ctx.fillStyle = '#7b8aaa';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(sp.population * 100)}%`, px + panelW - 6, ry);
    ctx.textAlign = 'left';
  });
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd "c:/Users/Sirjohn/Documents/Eternal System" && npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/simulation/BiosphereRenderer.ts
git commit -m "feat(m17): add BiosphereRenderer — terrain layer + HUD layer + legend"
```

---

## Task 7: BIO toggle button + overlay compositing

**Files:**
- Modify: `index.html`
- Modify: `src/simulation/PlanetRenderer.ts`
- Modify: `src/main.ts`

This wires the `🧬 BIO` toggle button and composites the biosphere overlay over the planet surface.

**Step 1: Add CSS to index.html (near the `#close-planet-btn` CSS, around line 1635)**

```css
#bio-toggle-btn {
  padding: 4px 12px;
  font-family: 'Cinzel Decorative', serif;
  font-size: 9px;
  letter-spacing: 1px;
  background: rgba(0,180,130,0.08);
  border: 1px solid rgba(0,180,130,0.3);
  color: rgba(0,180,130,0.7);
  cursor: pointer;
  border-radius: 2px;
  transition: all 0.2s;
}
#bio-toggle-btn.active {
  background: rgba(0,200,160,0.20);
  border-color: var(--teal);
  color: #44ccaa;
}
#bio-toggle-btn:hover {
  background: rgba(0,200,160,0.12);
  border-color: var(--teal);
  color: #fff;
}
```

**Step 2: Add the button to index.html planet overlay top bar (line ~2442, before `#close-planet-btn`)**

```html
<button id="bio-toggle-btn" style="display:none">🧬 BIO</button>
```

**Step 3: Add public state properties to PlanetRenderer.ts (after the `warState` definition, around line 56)**

Add these imports at top of PlanetRenderer.ts (after the existing imports):

```typescript
import { drawBiosphereTerrainLayer, drawBiosphereHUDLayer } from './BiosphereRenderer';
import type { SpeciesGenome, PlanetBiosphere } from './SpeciesGenome';
```

Add public properties after `warState`:

```typescript
  // M17: Biosphere overlay
  bioOverlayVisible = false;
  bioData: { species: SpeciesGenome[]; biosphere: PlanetBiosphere } | null = null;
```

**Step 4: Call terrain layer inside `render()` world-space block**

In `render()` (line 423), inside the `ctx.save()` / `ctx.restore()` block, after `this.drawDayNight(ctx)` and before the formation overlay check (around line 456), add:

```typescript
    // M17: Biosphere terrain overlay
    if (this.bioOverlayVisible && this.bioData && this.star.isPlayerStar) {
      drawBiosphereTerrainLayer(
        ctx, this.MAP_W, this.MAP_H, this.tick,
        this.bioData.species, this.bioData.biosphere, this.star.id,
      );
    }
```

**Step 5: Call HUD layer from `drawPlanetUI()`**

In `drawPlanetUI()` (line 848), at the very end of the method (after all existing drawing calls), add:

```typescript
    // M17: Biosphere HUD overlay
    if (this.bioOverlayVisible && this.bioData) {
      drawBiosphereHUDLayer(ctx, W, H, this.bioData.species, this.bioData.biosphere);
    }
```

**Step 6: Wire the toggle button in main.ts**

In `openPlanetView()` (line ~665), after `planetRenderer.start()`, add:

```typescript
  // M17: Show BIO button only on player's home star
  const bioBtn = document.getElementById('bio-toggle-btn') as HTMLButtonElement | null;
  if (bioBtn) {
    bioBtn.style.display = target.isPlayerStar ? '' : 'none';
    bioBtn.classList.toggle('active', planetRenderer.bioOverlayVisible);
  }
```

In `DOMContentLoaded` (or wherever other one-time event listeners are registered), add the toggle handler **once**:

```typescript
document.getElementById('bio-toggle-btn')?.addEventListener('click', () => {
  if (!planetRenderer) return;
  planetRenderer.bioOverlayVisible = !planetRenderer.bioOverlayVisible;
  if (planetRenderer.bioOverlayVisible) {
    planetRenderer.bioData = {
      species:   gameState.playerSpecies,
      biosphere: gameState.playerBiosphere,
    };
  }
  document.getElementById('bio-toggle-btn')?.classList.toggle('active', planetRenderer.bioOverlayVisible);
});
```

Also, update `bioData` each time an evolution event fires. In the `wireEngineEvents` callbacks added in Task 5, add this refresh inside each of the 3 evolution callbacks:

```typescript
    // Keep overlay in sync if open
    if (planetRenderer?.bioOverlayVisible) {
      planetRenderer.bioData = { species: gameState.playerSpecies, biosphere: gameState.playerBiosphere };
    }
```

**Step 7: Verify TypeScript compiles**

Run: `cd "c:/Users/Sirjohn/Documents/Eternal System" && npx tsc --noEmit`
Expected: No errors.

**Step 8: Visual verification**

1. `npm run dev` → start game
2. Open planet view (click home star → VIEW MY WORLD)
3. The `🧬 BIO` button should appear
4. Click it — biosphere overlay appears (HUD panel top-right, legend bottom-left, terrain overlays)
5. Click again — overlay hides
6. For NPC stars: BIO button should not appear

**Step 9: Commit**

```bash
git add index.html src/simulation/PlanetRenderer.ts src/main.ts
git commit -m "feat(m17): add BIO toggle button + biosphere overlay compositing in planet view"
```

---

## Task 8: O2 level drives atmosphere haze in planet surface view

**Files:**
- Modify: `src/simulation/PlanetRenderer.ts`

A subtle blue-white atmospheric haze is drawn in world-space on top of the terrain. Its intensity scales with `biosphere.oxygenLevel`. Visible even without the BIO overlay active (it reflects the actual atmosphere state).

**Step 1: Add `drawOxygenAtmosphere` as a private method (add after `drawDayNight`)**

```typescript
  private drawOxygenAtmosphere(ctx: CanvasRenderingContext2D, o2: number): void {
    const W = this.MAP_W, H = this.MAP_H;
    const alpha = Math.min(0.28, o2 * 0.32);
    const grad  = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0,   `rgba(100,180,255,${alpha})`);
    grad.addColorStop(0.35, 'rgba(80,160,255,0)');
    grad.addColorStop(0.65, 'rgba(80,160,255,0)');
    grad.addColorStop(1,   `rgba(100,180,255,${alpha * 0.6})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
```

**Step 2: Call it in `render()` inside the world-space block (after `drawDayNight`, before the formation overlay check)**

```typescript
    // M17: O2 atmosphere haze
    if (this.bioData && this.bioData.biosphere.oxygenLevel > 0.05) {
      this.drawOxygenAtmosphere(ctx, this.bioData.biosphere.oxygenLevel);
    }
```

This call goes in the same spot as the biosphere terrain layer from Task 7 — put it **before** `drawBiosphereTerrainLayer` so the haze is underneath the organism overlays.

**Step 3: Verify TypeScript compiles**

Run: `cd "c:/Users/Sirjohn/Documents/Eternal System" && npx tsc --noEmit`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/simulation/PlanetRenderer.ts
git commit -m "feat(m17): O2 level drives atmospheric haze intensity in planet surface view"
```

---

## Task 9: Persist playerSpecies + playerBiosphere in .eternal save format

**Files:**
- Modify: `src/simulation/BigBangEngine.ts`

The `EngineSnapshot` fields were already added in Task 4. This task wires them into `serialize()` and `loadState()`.

**Step 1: Add to `serialize()` (line ~2684, after `cosmicSignals: [...this.cosmicSignals],`)**

```typescript
      playerSpecies:   gameState.playerSpecies.map(s => ({
        ...s, dna: { ...s.dna }, evolutionaryPotential: { ...s.evolutionaryPotential },
        physicalTraits: { ...s.physicalTraits }, habitat: { ...s.habitat },
      })),
      playerBiosphere: { ...gameState.playerBiosphere },
```

**Step 2: Add to `loadState()` (line ~2711, after `if (snap.cosmicSignals) ...`)**

```typescript
    if (snap.playerSpecies)   gameState.playerSpecies   = snap.playerSpecies;
    if (snap.playerBiosphere) gameState.playerBiosphere = snap.playerBiosphere;
```

**Step 3: Verify TypeScript compiles**

Run: `cd "c:/Users/Sirjohn/Documents/Eternal System" && npx tsc --noEmit`
Expected: No errors.

**Step 4: Save/load test**

1. Start game → speed 1000× → wait for first mutation events in feed
2. Open planet view → toggle BIO on → confirm species visible
3. `Ctrl+S` to save
4. Refresh browser → click CONTINUE
5. Open planet view → toggle BIO → confirm species list restored
6. Check browser console: `JSON.stringify(gameState.playerSpecies.length)` — should be ≥ 1

**Step 5: Commit**

```bash
git add src/simulation/BigBangEngine.ts
git commit -m "feat(m17): persist playerSpecies + playerBiosphere in .eternal save format"
```

---

## Summary: All ROADMAP M17 tasks covered

| ROADMAP task | Plan task |
|-------------|-----------|
| `src/simulation/SpeciesGenome.ts` interfaces | Task 1 |
| `GameStateData` extended | Task 2 |
| `src/simulation/EvolutionEngine.ts` | Task 3 |
| `BigBangEngine` wires `stepEvolution()` | Task 4 |
| `onSpeciationEvent`, `onExtinctionEvent`, `onMutationEvent` callbacks | Tasks 4 + 5 |
| DNA Lab branch investments bias mutation rolls | Task 3 (baked into `collectMutations` + `tryMutation`) |
| `src/simulation/BiosphereRenderer.ts` | Task 6 |
| `🧬 BIO` toggle button + compositing | Task 7 |
| Biosphere O2 → atmosphere glow | Task 8 |
| `playerSpecies[]` + `playerBiosphere` persisted | Task 9 |

**Exit criteria:** Player's planet has a living ecosystem of branching species. DNA Lab choices visibly alter evolutionary paths. The planet surface shows fungal networks, biome zones, and species clusters under the BIO overlay. Extinctions and speciations fire as feed events + Codex entries + Gemini narration. Biosphere state changes the planet's atmospheric haze. Full state persists across save/load.
