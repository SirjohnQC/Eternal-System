# Planet Formation Lifecycle — Design

**Status:** design, awaiting approval  
**Origin:** play feedback that a new world should begin as rock and lava after
the bang, grow through cooling and chemistry, and only later become its
destiny type — with life able to arrive and push along that path, and with
normal play paced so the player watches the world grow rather than
fast-forwarding it away.

## The problem

A new home world today can already look finished: ocean or temperate ground,
plants, creatures, towns. Formation stages exist (`magma` → `cooling` →
`volcanic` → `atmosphere` → `ice_age` → `primordial`) and meteor panspermia
exists, but they are short overlays on a world that already knows what it is.
The dice that pick the home type describe day one, not a path the crust still
has to walk.

Speed is also free in normal play. A player can rush the early ages and never
sit with a young planet. That fights the intent of a god-sim where the first
days are the birth of a world.

## Decisions taken

### Destiny from the seed

- At the start of a real game the dice roll the home world’s **destiny type**.
  Ocean and rocky are common; other types remain possible at lower weight.
- Destiny is what the world is meant to **finish as**. It is not the look of
  day one.
- Setup DNA (`oceans` / `climate`) stays a **lab / test override** only. It is
  not how a normal run chooses the home world.

### Birth

- After the bang the home world opens as **magma / early rock**, the same
  young-world face most planets share.
- The diorama shows that stage: molten or cooling crust, no finished biome
  paint, no plants, no animals, no towns.

### Stages along the destiny

- The world walks a formation ladder **sized for that destiny**.
  - An **ocean** destiny cools, grows air, then a primordial sea.
  - A **rocky** destiny cools and settles into highland crust.
  - Other destinies get a matching ladder when they roll (ice, desert, etc.).
- Existing stage names can stay where they fit; the sequence and which stages
  fire are destiny-dependent, not one fixed list for every world.
- Stage lengths share one rolled **total formation budget**. The seed rolls
  that budget once for the home world.

### Formation duration

- Total time from magma to finished destiny is **uniform-random between 1 and
  3 player days**, measured at **normal-mode pace** (see Play modes).
- Stages divide that budget; they do not each re-roll an independent multi-day
  wait.
- A future **skip** for normal play is allowed later. It is out of scope here.

### Life on the path

- Once the world is far enough along, life can wake **on its own** (stage +
  seed roll), or arrive from outside:
  - a meteor / panspermia strike
  - debris from a living neighbour (volcanic ejecta → asteroid)
- For this pass, life may only **push along the destiny** (faster cooling,
  earlier air, richer seas). It does **not** rewrite ocean into ice, or any
  other destiny change.
- Player-forced destiny diversion (faith cards, evolution branches that change
  the end type) is **out of scope** until those systems exist.

### After formation

- When the last formation stage completes, the world **settles into its destiny
  type**. The biology ladder (`microbial` → … → `intelligent`) begins on that
  finished ground.
- Surface readouts follow phase: bare rock while young; cover and creatures
  only as biology earns them (see also the earlier primitive-world picture
  rules — those apply after formation ends).

### Play modes

At game start the player chooses:

| Mode | Pace | Divine points | Place life | Fast-forward |
|------|------|---------------|------------|--------------|
| **Normal** | One fixed intended pace (no speed slider). Base pace may be snappier than today’s `1×`. | Earned as today | Only through the world’s own rolls / existing divine acts that the design already allows | No |
| **Creative** | Fast-forward available | Unlimited | Yes — player can place / seed life | Yes |

- Normal play is how the game is meant to feel: watch the planet grow.
- Creative is sandbox tools for play and for testing the same systems without
  waiting.
- Dev / engine flags may still force DNA, phase, or speed for lab work; they
  are not the player-facing Normal path.

## Non-goals

- Faith / evolution that **changes destiny type** mid-formation.
- Life that **terraforms** the destiny (cold aliens → ice world, etc.).
- A Normal-mode **skip formation** button (future).
- Creative tools beyond fast-forward, unlimited DP, and place life.
- Reworking NPC pre-seeded biospheres’ full geological history (they may keep
  a shortened or already-advanced state so the universe is not every star in
  magma at once).
- Replacing the existing terraform-from-finished-type sequences; those remain
  a later, post-destiny tool.

## Existing code this rides on

- `PlanetFormationStage` and `FORMATIONFORMATIONFORMATIONformationStage` on `StarBody` (`BigBangEngine.ts`)
- Formation durations and progress callbacks (`onPlanetFormationProgress`)
- Meteor life seeding (`onMeteorLifeSeeded`) and directed panspermia hooks
- Diorama / `PlanetRenderer` formation overlays (today a tint; this work must
  make the **cutaway** match the stage)
- Destiny type on the home planet; biology phase after formation clears

## Visual contract (home diorama)

| Span | Surface |
|------|---------|
| `magma` | Molten / lava face |
| `cooling` / `volcanic` | Cooling rock, vents; little or no standing water |
| `atmosphere` | Thin air readable on the rim; ground still young |
| Destiny sea stages (`ice_age` / `primordial` where used) | Young ocean or ice as the ladder requires |
| Formation complete | Destiny type biomes; biology phase owns life paint |

Exact art per stage can iterate; the contract is that **stage is visible**, not
a label on an already-finished ocean world.

## Success criteria

1. A Normal new game home world starts magma/rock and reaches its destiny only
   after the rolled 1–3 day formation budget at normal pace.
2. Destiny type comes from the start-of-game seed roll (ocean/rocky common);
   lab DNA does not define Normal runs.
3. Life can appear during/after eligible stages via spontaneous roll or
   external seeding, and may hasten the current ladder — never change destiny
   in this pass.
4. Normal mode has no speed slider; Creative offers fast-forward, unlimited DP,
   and place life.
5. The home diorama matches the active formation stage until formation ends.

## Open follow-ups (not blocking this spec)

- Exact stage lists per destiny type (ocean vs rocky vs ice vs desert).
- How much life may shorten the remaining budget (cap so a meteor cannot
  finish a 3-day world in minutes).
- Neighbour ejecta frequency and range.
- Whether Creative “place life” is a divine act UI or a sandbox brush.
