# Expansion, conquest and divergence — design

*2026-10-12 — decisions recorded below. Judged against `docs/CORE_LOOP_VISION.md` (§1, §4–§7, §15).*

## The idea (owner, 2026-10-12)

> A species that lives a few generations on another planet whose environment is
> slightly different should get a different DNA branch over time, making them
> slightly different (smaller / bigger / different colour / …).

Plus three missing mechanics: **planet exploration**, **species expansion**
(colonies) and **star conquest**.

## Principles

- **Nobody orders a colony.** Expansion is a *response* to pressure (crowding,
  scarcity, a curious culture, a dying star), like every technology. The player
  disturbs conditions — cards, DNA — and never clicks "colonise".
- **Divergence is not scripted.** A colony keeps a copy of its species and that
  copy evolves under *its* world's conditions with the existing
  `EvolutionEngine` (drift, selection, niche competition). Different world →
  different survivors → a different people. Contact with home slows it (gene
  flow); isolation speeds it.
- **Everything is causal history.** Launch, landfall, failure, divergence,
  independence, conquest: each is a Chronicle entry linked to its causes.

## What exists today

| Piece | State |
|---|---|
| Discovery ladder | Telescope → probe → landing on the home system's planets (`advancePlayerPlanetDiscovery`), by tech level. Landing is a label only. |
| Colony Ark tech | `colony_ark` (era 6, answers crowding/scarcity) — fires a message and a codex entry. **No ship, no colony.** |
| Moon colonies | `moon.colonised` flag for any civ past a level (`updateMoonColonisation`). No population, no people. |
| Inter-star polities | `StarPolities.ts`: pressures, techs, attitudes, trade routes, wars carried by fleets. Wars end with no change of hands. |
| Exodus | A dying home star moves the people to another star wholesale. |
| Evolution | `EvolutionEngine.stepEvolution`: fitness = f(genome, biosphere, phase). **Does not read the planet** (gravity, light, temperature, atmosphere). |

## Model

### Colony (new, engine state, saved)

```ts
interface Colony {
  id: string;
  starId: number; planetIndex: number;        // where (a moon later: moonIndex)
  founderStarId: number;                       // who sent it
  foundedTick: number;
  population: number;                          // 0..1 of the world's capacity
  lineage: SpeciesGenome;                      // the colonists' own copy, evolving
  homeLineageId: string;                       // the species it split from
  generations: number;                         // evolution steps lived there
  contact: number;                             // 0..1 traffic with home (gene flow)
  loyalty: number;                             // 0..1 tie to the founder
  culture: CultureValues;                      // drifts from the founder's
  status: 'outpost' | 'colony' | 'independent' | 'occupied';
}
```

### 1. Exploration

Extend discovery past the home system: within `explorationRadius`, systems go
telescope → probe → surveyed. Surveying a planet reveals its **environment
vector** (below). Purely informational at first; it is what an ark targets.

### 2. Expansion (the ark)

- **Trigger:** learning `colony_ark` (or later techs) while a pressure that it
  answers is high — not on a timer. Repeat launches as long as pressure lasts,
  with a cooldown.
- **Target choice** (from what the people *are* and *face*): surveyed planets
  scored on habitability for **their** genome, distance, crowding at home;
  curious cultures reach further, xenophobic ones prefer empty worlds, martial
  ones accept inhabited ones.
- **Voyage:** an ark is an engine fleet (existing `Fleet`) with travel time.
  It can be lost (distance, hostile space, a war) → Chronicle.
- **Landfall:** outpost → colony as population grows on the world's capacity.
  A bad fit can die out: that is selection, and a story.

### 3. Divergence (the owner's idea)

Each colony steps its `lineage` with `stepEvolution` on the colony's own
biosphere, once per `EVOLUTION_TICK_RATE` ("a generation"). The one engine
change: **fitness reads the planet's environment**, not just the biosphere.

| Environment (per planet) | Selects for | Shows as |
|---|---|---|
| Gravity (planet mass / type) | low → larger, lighter frames; high → smaller, sturdier | size class, limb proportions |
| Star light (star temperature, orbit) | dim → large eyes, pale or dark skin; harsh → pigment, armour | colour, eye size |
| Temperature | cold → insulation, bulk; hot → slender, heat-shedding | body covering, size |
| Atmosphere / oxygen | thin → large lungs, slow metabolism | respiration, posture |
| Water / land share | aquatic or terrestrial drift | locomotion, environment |

**Genetic distance** = a weighted difference between `lineage` and the home
species' genome. Thresholds, softened by `contact` (gene flow pulls the lineage
back toward home each generation):

- **variant** (small distance): same species, a visible local form —
  "the pale Kethari of Ethix II".
- **subspecies:** own name, own sprite tint/size in the views.
- **new species** (large distance, low contact): a separate entry in the
  species tree and the Codex; can no longer interbreed (#63 hooks in here:
  where they can, mixing produces random DNA).

Visuals come free from the existing `CreatureForge` / sprite bakers, which
already draw from genome fields.

### 4. Conquest

Polity wars (already emergent) gain an outcome: an attacker that wins with a
large strength margin and a reachable, desirable world **occupies** it. The
world gets an `occupied` colony of the attacker; the native people remain
(two peoples on one world): resistance, assimilation or mixing over time,
depending on culture and genome distance. Occupation can fail and revert.

### 5. Consequences (emerge, not scripted)

- Distance + low contact → culture drift → falling loyalty → **independence**
  (a new polity with its own techs and attitudes).
- An independent colony can trade with home, rival it, or go to war with it.
- A diverged species meeting its ancestors is a first-contact event.

### Player influence (cards, DNA — never orders)

New Faith Card kinds on the same substrate: *Wanderlust* (raise the drive to
launch), *Favourable winds* (ark survival), *Quickened adaptation* (faster
divergence), *Kinship* (raise contact/loyalty), *Sever the line* (cut contact).
Each has side effects (e.g. faster divergence → more failed colonies).

## Phases

| Phase | Delivers | Guard (tests) |
|---|---|---|
| **P1 Colonies** | `Colony` state, ark launch from pressure, voyage as a fleet, landfall/failure, colony growth; system map marker + planet panel shows the colony; Chronicle entries; save field + migration | invariants: colony on a real planet, population in 0..1, no colony on a dead star; deterministic; save fixture |
| **P2 Divergence** | planet environment vector; fitness reads it; per-colony evolution; genetic distance + contact; variant/subspecies/species naming; tint/size in sprites | scenario: same founder on a cold/high-gravity vs warm/low-gravity world diverges in the expected direction; contact 1.0 diverges slower than 0.0 |
| **P3 Conquest & independence** | occupation outcome of polity wars; two peoples on one world; loyalty → independence → new polity | invariants: an occupied world has both peoples; an independent colony is a polity |
| **P4 Seeing it** | per-world surface grid + diorama for colony worlds (generalises #76, #77); per-world history (#17); lineage tree in the species panel (#38) and Codex (#65) | visual goldens for a colony world |

P1 + P2 deliver the owner's idea end to end; P3/P4 can follow.

## Decisions (owner, 2026-10-12)

1. **The player's colonies are the player's until they break away.** DP, Faith
   Cards and the planet view reach them; falling loyalty can make one
   independent, and from then on it is another polity.
2. **Divergence is slow, across sessions.** A visible variant takes many
   generations, a new species is rare and meaningful. Tuning target at Normal
   pace (one generation ≈ 17 min): a **variant after ~10 generations (~3 h of
   play)**, a **subspecies after ~30 (~9 h)**, a **new species** only for an
   isolated colony over ~60+ generations. Contact stretches all of these.
3. **Other civilisations colonise and conquer too — including the player's
   worlds.** The universe doesn't wait for the player.
