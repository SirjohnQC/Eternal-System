# M18: Evolution Interactivity & Game Feel

**Status:** Planned
**Session:** 2026-03-10 (next)

---

## Overview

Three independent improvements to game feel and player agency, plus one QoL feature for pacing.

---

## Task 1: Auto-Slow on Important Events

**Goal:** When an important event fires (war, naming modal, DNA point assignment, first contact), automatically drop sim speed to 10×, then restore previous speed when the modal closes.

### Implementation

**`src/main.ts`**

Add near the top (after speed-related vars):

```typescript
let _savedSpeed: number | null = null;

function slowForEvent(): void {
  if (engine && engine.speed > 10) {
    _savedSpeed = engine.speed;
    engine.speed = 10;
    // update speed button UI
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-speed="10"]')?.classList.add('active');
  }
}

function restoreSpeed(): void {
  if (_savedSpeed !== null && engine) {
    engine.speed = _savedSpeed;
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-speed="${_savedSpeed}"]`)?.classList.add('active');
    _savedSpeed = null;
  }
}
```

Call `slowForEvent()` before showing each of:
- Species naming modal (onPlayerLifeEmerged)
- Religion naming modal
- DNA point modal (onDNAPoint)
- War dice modal (onWarBattle)
- First contact modal (onFirstContact)
- Leader dialogue modal (showLeaderDialogue)

Call `restoreSpeed()` on each modal's close/confirm handler.

---

## Task 2: Nudge Evolution Rework

**Goal:** Nudge Evolution costs 100 DP and forces one immediate random mutation on the most-populous active species instead of advancing the bio phase.

### Implementation

**`index.html`**

Update Nudge Evolution button label and cost display: `10 DP` → `100 DP`.

**`src/main.ts`**

Find the `nudge-evolution-btn` click handler. Replace body:

```typescript
document.getElementById('nudge-evolution-btn')?.addEventListener('click', () => {
  const COST = 100;
  if (gameState.divinePoints < COST) return;

  const active = gameState.playerSpecies.filter(s => !s.isExtinct);
  if (active.length === 0) return;

  // Target most-populous species
  const target = active.reduce((a, b) => b.population > a.population ? b : a);

  // Force one mutation via EvolutionEngine logic
  const rng = engine!.rngFork(`nudge_${engine!.tick}`);
  const playerDNA = gameState.playerDNA;
  const bioPhase = engine!.getPlayerBioPhase();

  // Import and call tryMutation equivalent: use stepEvolution with single species
  // and discard speciation/extinction — or expose a nudgeMutation helper
  // See EvolutionEngine.ts Task 2b below
  const result = applyNudgeMutation(target, rng, playerDNA, bioPhase, engine!.tick);
  if (result) {
    gameState.playerSpecies = gameState.playerSpecies.map(s => s.id === target.id ? result.species : s);
    gameState.divinePoints -= COST;
    addFeedEntry(`⚡ DIVINE NUDGE: ${result.event.description}`, 'milestone');
    addCodexEntry(`Divine Nudge: ${result.event.description}`, 'divine');
    _geminiService?.sendPlayerMessage(`[DIVINE NUDGE] The god intervened in evolution: ${result.event.description}`, '');
    if (planetRenderer) {
      planetRenderer.bioData = { species: gameState.playerSpecies, biosphere: gameState.playerBiosphere };
    }
  }
});
```

**`src/simulation/EvolutionEngine.ts`** (Task 2b)

Export a new function `applyNudgeMutation`:

```typescript
export function applyNudgeMutation(
  sp: SpeciesGenome,
  rng: SeedRNG,
  playerDNA: DNABranch,
  bioPhase: string,
  tick: number,
): { species: SpeciesGenome; event: EvolutionEvent } | null {
  const copy: SpeciesGenome = {
    ...sp,
    dna: { ...sp.dna },
    evolutionaryPotential: { ...sp.evolutionaryPotential },
    physicalTraits: { ...sp.physicalTraits },
    habitat: { ...sp.habitat },
  };
  const evoRng = rng.fork(`nudge_inner_${tick}`);
  // Force mutation by temporarily boosting chance to 1.0
  const opts = collectMutations(copy, playerDNA, bioPhase, evoRng);
  if (opts.length === 0) return null;
  const pick = opts[evoRng.nextInt(0, opts.length - 1)];
  const oldVal = String((copy.dna as Record<string, unknown>)[pick.trait] ?? '');
  (copy.dna as Record<string, unknown>)[pick.trait] = pick.newValue;
  applySideEffects(copy, pick); // extract side-effect code from tryMutation into shared helper
  return {
    species: copy,
    event: {
      type: 'mutation',
      speciesId: copy.id,
      speciesName: copy.name,
      description: `${copy.name} forcibly evolved: ${pick.trait} ${oldVal} → ${String(pick.newValue)}.`,
    },
  };
}
```

Also expose `engine.rngFork(namespace)` and `engine.getPlayerBioPhase()` from BigBangEngine if not already available.

---

## Task 3: Interactive Evolution Choices (Spore/RimWorld Style)

**Goal:** When a speciation event fires, pause the sim and present the player 2–3 trait paths to choose from for the child species. Player choice shapes evolution direction.

### Phase A: EvolutionEngine changes

Export `generateSpeciationOptions`:

```typescript
export interface SpeciationOption {
  id: string;   // 'aggressive' | 'adaptive' | 'intelligent' | 'aquatic' | etc.
  label: string;
  description: string;
  traitDeltas: Partial<SpeciesDNA>;  // what changes in child
}

export function generateSpeciationOptions(
  parent: SpeciesGenome,
  bioPhase: string,
  rng: SeedRNG,
  count: number = 3,
): SpeciationOption[] {
  // Generate count distinct evolutionary paths based on parent traits + bioPhase
  // Each option mutates 1-2 traits in different directions
  // e.g. "Apex Predator" (+aggression, +size), "Social Colony" (+social, +adaptability), "Neural Leap" (+intelligence)
}
```

Refactor `stepEvolution` to call `generateSpeciationOptions` and return the options alongside the event instead of immediately creating the child, when `onSpeciationChoice` callback is wired.

### Phase B: BigBangEngine callbacks

```typescript
onSpeciationChoice: ((event: EvolutionEvent, options: SpeciationOption[], applyChoice: (optionId: string) => void) => void) | null = null;
```

When speciation chance fires and `onSpeciationChoice` is wired:
- Pause sim (engine.paused = true)
- Fire callback with options + a closure that applies the chosen option and resumes

### Phase C: index.html modal

```html
<div id="evolution-choice-overlay" class="overlay" hidden>
  <div class="evolution-choice-panel">
    <h2 class="panel-title">DIVERGENCE POINT</h2>
    <p id="evo-choice-parent-desc">...</p>
    <div id="evo-choice-options"></div>
    <button id="evo-choice-skip-btn">Let Nature Decide</button>
  </div>
</div>
```

Style: similar to war-dice-overlay, dark cosmic theme, 3 cards side-by-side.

### Phase D: main.ts handler

```typescript
eng.onSpeciationChoice = (event, options, applyChoice) => {
  slowForEvent();
  // populate modal
  showEvolutionChoiceModal(event, options, (chosenId) => {
    applyChoice(chosenId);
    restoreSpeed();
  });
};
```

Each card shows: option label, description, trait delta summary (e.g. "Intelligence +2, Social +1").
"Let Nature Decide" picks randomly.

---

## Suggested Additions (from session brainstorm)

These are ideas worth considering for M18 or a follow-on milestone:

- **Extinction events on player home world** — when a mass extinction happens, brief screen shake or darkening on the planet overlay, dramatic Codex entry with Gemini narration
- **Species trait tooltip** — hovering a species in the legend shows full genome stats
- **Biosphere health feed entries** — every N ticks, a brief auto-generated status update in the event feed: "O₂ levels rising as photosynthetic life spreads across coastal zones"
- **Evolutionary milestones** — first land colonization, first flight, first tool use → each gets a Codex entry + Gemini narration + DP reward (+5 each)
- **Divine Intervention flavor** — when player uses Nudge Evolution, Gemini narrates the mutation in poetic God-voice language rather than just the mechanical description
- **Species extinction memorial** — when a species goes extinct, it moves to an "EXTINCT" section in the legend (grayed out, skulled) for a few seconds before disappearing

---

## Execution Order

1. Task 1 (auto-slow) — fast, high impact, low risk
2. Task 2 (nudge rework) — medium complexity
3. Task 3 (interactive choices) — largest, do in sub-batches A→B→C→D

Verify `npx tsc --noEmit` clean after each task.
