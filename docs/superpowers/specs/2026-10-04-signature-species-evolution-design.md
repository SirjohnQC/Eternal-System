# Signature Species Evolution — Design

**Status:** implemented 2026-10-04 (`src/simulation/Mutations.ts`, check: `tools/evolutionLabCheck.ts`)
**Origin:** play feedback — the Evolution Lab and the side DNA panel feel like
two unconnected systems; it is unclear how DNA is earned or what spending it
does; nothing you buy visibly changes the creature. Evolving should feel like
your Pokémon evolving.

## The problem (as built)

- Two UIs spend the same points: the side panel (+/− sliders, an "EVOLVE
  SPECIES" button that opens a 6-category traits picker) and the lab's gene
  bank. The traits picker writes `playerSpeciesTraits`, which nothing reads.
- DNA is earned almost only on biology-phase advances (tens of thousands of
  ticks apart) and +1 per Nudge after intelligence. Nothing on the planet earns
  it.
- A point in a branch only biases *which* trait mutates on the next random
  roll: indirect, delayed, often invisible.
- The lab shows whichever lineage is most numerous right now, so "your
  species" can change under you.
- The sprite baker already gives every gene its own visual channel
  (`SpeciesSprite.ts`); it is simply never driven by a player decision.

## Decisions

### One signature species
- The first lineage on the home world is the player's **signature species**
  (`gameState.signatureSpeciesId`). It is pinned in the lab, HUD and codex.
- It never goes extinct while the world lives (population floor). If it is
  ever lost, the most populous descendant inherits the title.
- Other lineages keep evolving on their own as wildlife and rivals.

### Mutations, not sliders
- The lab offers **mutation cards** (`src/simulation/Mutations.ts`): concrete
  body changes — Chloroplasts, Mineral Shell, Fins, Legs, Wings, Camera Eyes,
  Venom, Bigger Brain, Language…
- Each card: a cost in DNA, the earliest biology phase it can appear in,
  prerequisites, a **fork group** (one card per group: Shell *or* Segments *or*
  Jelly bell), a genome precondition, and a deterministic genome change. Every
  card changes something the sprite draws.
- Cards also carry **effects** (the existing `EffectKind`s: tech speed, bio
  resilience, mutability…). The engine's `playerEffect` reads owned mutations,
  so the simulation consequences of the old branches are kept.
- **Per-universe roll:** core cards are always offered; each optional card is
  rolled in or out per universe from the master seed, so each playthrough's
  tree differs.

### Queue, then evolve
- Buying a card **queues** it (DNA spent; un-queue refunds). The lab shows the
  current form beside a live preview of the next form with the queue applied.
- When the queue holds **enough** — `EVOLVE_THRESHOLD` (2) cards, or one card
  marked *major* — EVOLVE lights up. Pressing it plays the evolution sequence
  and applies the queue.
- **The evolution sequence:** the creature turns to a white silhouette, old
  and new silhouettes alternate faster and faster, a flash, then the new form
  is revealed with its new name, form number and a before → after trait list.
- Each evolution is a **form** (Form I, II, III…) kept in a dex strip in the
  lab.

### Strongly steered, drift adds surprises
- Owned mutations **lock** the traits they set: natural drift on the signature
  species never undoes them.
- Unlocked traits keep drifting as before; a drift change on the signature
  species is announced ("Natural drift: …").
- **Spontaneous mutations:** each evolution step has a small chance to drop a
  random available card into the queue for free.

### Earning DNA from things you can see
Each award shows a toast with its reason.

| Event | DNA |
|---|---|
| Life first takes hold (the first choice) | +6 |
| Biology phase advance | +8 × phase number (kept) |
| Signature species dominates a biome it never held | +3 |
| A sub-species branches off the signature | +2 |
| A rival lineage goes extinct while yours lives | +1 |
| Each evolution step, by dominance | +1, +2 above 40% |
| Nudge Evolution after intelligence | +1 (kept) |

### One lab
- The side panel becomes a summary: DNA, the signature creature, queue
  status, an "evolution ready" glow; it opens the lab.
- The lab: specimen tank (current → next form), the mutation tree by phase,
  the queue with EVOLVE, the form dex.
- The old traits picker is no longer opened (it changed nothing).

## Non-goals
- Player control over non-signature lineages.
- Hand-drawn art per mutation (the procedural baker draws every form).
- Rebalancing tech/civ pacing beyond keeping existing effects alive.

## Success criteria
1. Buying cards visibly changes the preview sprite before evolving, and the
   real creature after.
2. The side panel and the lab show the same state and lead to the same action.
3. DNA arrives from named, visible events.
4. Drift never undoes an owned mutation; surprises still happen.
5. The evolution sequence plays on every evolution.
