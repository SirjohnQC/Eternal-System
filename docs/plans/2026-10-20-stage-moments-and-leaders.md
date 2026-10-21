# Stage moments and leaders

*Design, 2026-10-20. Brainstorm for problems 1 and 3 of the alpha playtest
(`docs/playtests/2026-10-20-alpha.md`). Design only: nothing here is built yet.*

Judged against `docs/CORE_LOOP_VISION.md`. The player disturbs conditions and
never controls them. Consequences are shown and labels are hidden. The payoff
is *"I caused this."* Every option below is checked against that test, and
against the architecture rules in `CLAUDE.md`.

The tester, on the two problems:

> "In about a minute and a half at 1000× my people went from 'Early
> Civilisation' to 'Interstellar'. I had no meaningful decision on the way.
> The only thing that kept interrupting me was a modal leader dialogue at
> every era."

> "Microbes to civilisation happened while I was reading one dialog. I never
> saw a multicellular or complex stage on the disc. I had 135 DNA banked and
> had not spent a point."

---

## 0. What is actually happening (measured)

Before designing, I ran the engine headless to check the tester's numbers. The
probe was a throwaway script built like `tools/playerProgressCheck.ts`:
`skipFormation`, an ocean destiny, `life 20`, three seeds, and the
`evolution` die at 20 (the tester's roll) or 10 (a median roll). At 1000×,
`BigBangEngine.update` runs about 1000 ticks per wall second
(`paceToWallClock`), so **1,000 ticks is about 1 s at 1000×**.

| | evo 20, seed a | evo 20, seed b | evo 10, seed a |
|---|---|---|---|
| Ticks spent in microbial / multicellular / complex / primitive | 16,260 / 3,660 / 3,200 / 2,750 | 1,360 / 900 / 2,740 / 2,340 | 50,570 / 40,260 / 35,230 / 105,680 |
| Ticks from intelligence to Ancient | 3,910 | 1,710 | 1,430 |
| Ticks per era (Ancient → Space Age) | 16k, 18k, 14k, 12k | 15k, 20k, 12k, 10k, 12k | 95k (Ancient) |
| Ancient → Interstellar | (collapsed at Space Age) | **69k ticks ≈ 69 s** | — |
| Food at the start of each era ("fed") | Medieval 224–271 %, Industrial 161–189 % | Medieval 358–451 %, Industrial 146–307 % | Medieval 111–119 % |
| Leader modals fired | 6 | **12** | 2 |
| The people's genome (`peopleOf`) | intelligence **0**, crawling herbivore | intelligence **0**, **stationary producer** | intelligence **0**, **stationary herbivore** |

Five causes come out of this.

**R1. One die is an 11× pace knob.** `evoMod = (21 − evolution) / 10` scales
both `BIO_PHASE_TICKS` (`BigBangEngine.updateBiologyPhase`) and
`CIV_TICK_RATE` (`civAdvanceRate`). It runs from 2.0 at a roll of 1 to 0.1 at
a roll of 20. On a roll of 20, multicellular to intelligence takes 7k–10k
ticks, about **8 s at 1000×**. That is the tester's "while I was reading one
dialog".

**R2. The era clock outruns the people.** The nations step once every
`EVOLUTION_TICK_RATE` (2000 ticks). `Nations.recompute` grows the population by
at most +16 % per call, whatever amount of era-time passed. Research advances
by `dt / ticksPerEra` (`Nations.research`), so it scales with the clock. On a
fast roll an age lasts only 5 to 9 nation steps: the food technologies arrive
before people can grow into them. The tester's "2069 % fed" is mostly this
artifact. On a median roll the same world sits at 111–119 %, where hunger is
one bad harvest away. **"Nothing needed the player" is partly a pacing bug,
not a missing mechanic.**

**R3. Nothing holds at a stage change.** `eng.onBioPhaseAdvance`
(`main.ts:964`) only writes to the feed and the chat. Only the naming modals,
first contact and war dice call `slowForEvent`. The leader modal does not slow
the game at all, so the sim keeps running at 1000× underneath it.
`slowForEvent`/`restoreSpeed` keep a single `_preEventSpeed` slot. When two
modals stack (the tester saw "Faith is born" over a leader dialogue), closing
the first one restores 1000× while the second is still open.

**R4. The mind is not the people's.** The primitive → intelligent step is a
Great Filter roll (`LifeSystem.resolveTransition`) on habitability and
archetype. It never reads the genome. `peopleOf(species, 0)` then crowns the
"most intelligent" species even at intelligence 0. In all three runs the
people had intelligence 0, and twice it was a stationary producer: the
tester's "a mindless plant-fish built Dyson-era tech". `language` and
`toolmaking` are `phase: 'intelligent'` mutations (`Mutations.ts:233,237`), so
the lab offers them only after the mind already exists, and still offers them
in space.

**R5. Leaders are disposable and loud.**
- `spawnLeaderForStar` deletes the star's leader and rolls a fresh stranger
  from `Leader.ts`'s name pool on every `advanceCiv`. That includes every
  re-advance after a setback. On seed b, the world bounced between eras 0 and
  1 after a collapse, and each bounce fired "Their first leader rises" again:
  12 modals.
- `showLeaderDialogue` **charges 1 DP just to appear** (`main.ts:3661`).
- Its answers (bless, omen, silent) change the attitude and fear of a leader
  who is deleted at the next era.
- The broken line comes from the fallback. `LeaderDialogue.generateLeaderDialogue`
  feeds a full sentence ("Our civilization has advanced to Industrial.") into
  `FallbackNarrator.generateCivilizationMilestone`, which is the **god's**
  narrator template ("The ${civName} have achieved ${milestone}."). The result
  is a nested sentence, a doubled period, and a king who talks about his own
  people in the third person.
- The councils in Nations & Councils (`NationsOverview.councilOf`) are hashed
  from `name | government | revolts`. They are not simulated. They change only
  on a revolt or a change of government, which is why the tester saw "the same
  three councillors… from Ancient to Interstellar".
- These leaders and the nations are two unrelated systems: `gameState.leaders`
  holds one leader per star, while the councils are per nation.

**Two side findings that bear on the design:**
- **DP regenerates on wall time.** A `setInterval` of 8 s in `main.ts:1236`
  gives 1–3 DP whatever the speed. At 1000× one age is 1–2 regen ticks, so a
  player who fast-forwards can almost never afford a Seek (6 DP) inside an age.
  At ▶ they drown in DP. The god's budget per age is set by the speed button.
- **The nations are runtime-only.** `runtimeState.playerNations` is not
  serialized (`GameState.ts:253`). Anything new I put on the nations (rulers,
  petitions) inherits that gap until the nations are saved. This doc does not
  fix it, but it flags the gap wherever it matters.

**On the phase count (M21).** This design keys on *transitions* of the
built five-phase ladder (`BIO_PHASE_SEQUENCE`), plus the eras. It works
unchanged with either resolution of M21. If the engine grows to seven phases,
it gains two more thresholds. My recommendation for M21 is to stay at five:
the measured problem is that the five we have pass unseen, not that there are
too few. `EVOLUTION_SYSTEM.md` should drop to five and fold "Aquatic / Land
colonization / Ecosystems" into what multicellular and complex *show*.

---

## Problem 1: Pacing and stage moments

### Option 1A: Moments that hold the clock (presentation only)

**The player sees:** at each *great* change, the game drops to ▶
(`NORMAL_PACE`). A banner rises over the disc with a 32×32 glyph, the stage
name from `Progression` and one line in the world's own words. The camera
eases to where it happened: the first complex creature's cell, or the first
capital. The banner fades after about 8 s. Speed stays at ▶ until the player
raises it again. A setting offers *On great moments: slow (default) / pause /
nothing*.

**Moments, and what marks them:**

| Moment | Fires when | Where the camera goes |
|---|---|---|
| Cells hold together | first `multicellular` | a coastal cell with the highest `lifeDensity` |
| Eyes open | first `complex` | the cell of the newest creature lineage |
| Hands | first `primitive` | the people's densest cell |
| First minds | first `intelligent` | the same, with the naming prompt folded in |
| First nation(s) | `ns.isFounded` | each capital in turn |
| A new age | a new **high** of `civLevel` | the capital of the nation that reached it |
| The first ark | `d.tech.spaceship` | the launching nation's capital |
| A fall | a setback of an era or more, a mass extinction, or a nation falling | the place it hit |
| A star dies nearby | a supernova within the player's sight bubble | the star map, then back |

**The simulation changes:** none. The engine gains one callback,
`onStageMoment(m: { kind, starId, tick, from, to, cell? })`, emitted from
`updateBiologyPhase`, `stepNations` (founding), `advanceCiv` and the
catastrophe paths.
- **Highs:** a moment fires only on a new high. `gameState.momentHigh` is an
  optional `{ bio: number; era: number }` and is never lowered, the same way
  `tpEraHigh` works today. Seed b's six bounces back to Ancient become one
  Ancient moment and one Fall.
- **Bursts:** a burst that skips a phase emits one moment that names the leap.
- **Speed hold:** in `main.ts`, the single slot `_preEventSpeed` is replaced by
  a counted hold, `holdSpeed(reason)` / `releaseSpeed(reason)`, in a small pure
  module `src/ui/SpeedHold.ts`. The original speed comes back only when the
  last hold is released. A speed button pressed by the player clears all
  holds.

**Cost:** small.

**Risks:**
- It is spectacle with nothing to do. The tester asked for "something to do
  there", not only a pause.
- Too many moments train the player to dismiss them. Budget them: at most one
  holding moment per 20 s of wall time, and moments inside the window merge
  into one banner ("Ages pass…").
- **Vision:** stage names are already shown everywhere, so the banner adds no
  hidden label. A Fall banner must speak in symptoms ("the cities went dark"),
  never "COLLAPSE".
- **Rules:**
  - Rule 4: speed is UI, and moments never write sim state.
  - Rule 3: `starId` is explicit.
  - Rule 6: a Creative `leapToEra` emits one summary moment, not eight.

### Option 1B: Thresholds, a small Forge at each great moment

**The player sees:** the Forge is the build's best loop ("three cards, a world
that visibly changes with each pick, flavour lines that answer my choices").
Each great moment re-opens a small version of it. Three **threshold cards**
fan out over the Faith deck. They are *not* modal: speed buttons, rails and the
deck stay live. Each card is a disturbance of the conditions the new stage is
born into, with its usual anatomy (action, reach, odds, side effects):

| Moment | Example cards (all built from existing `FaithCards` actions or `DivineWorks`) |
|---|---|
| Cells hold together | *The Warm Shelf* (rains over the coasts; side: storms), *The Long Cold* (ice age; slows tempo, raises mutation odds), *A Bitter Sea* (murrain on the old lineages; opens niches) |
| Eyes open | *Hunters in the Shallows* (a predator lineage is favoured; side: herds thin), *The Dry Land Calls* (land fertility up over a province), *Hardiness* |
| Hands | *Fire from the Sky* (lightning starts a wildfire, via `Wildfire.trySpark`), *Quickened Minds*, *A Hard Winter* (cold pressure that selects for wit) |
| First nation | *A Comet's Tail* (piety), *The Good Year* (harvest), *The Dry Year* (scarcity) |
| A new age | drawn from the nations' own signals, as Seek already does |
| A fall / a star dies nearby | *Shelter*, *Foretelling* (sight), *Let Them Fear* (piety up, cohesion down) |

The player may take one card into the hand for free, or let the cards fade.
Casting the card still costs DP: the threshold gives a *choice*, not a free
miracle. A card that fades leaves the world to itself. **Nothing happens "by
default" for the player.**

**The simulation changes:**
- `FaithCards.discover` gains an optional `moment?: MomentKind`. It reweights
  `drawn` signals toward the table above, so the existing generator does the
  work.
- The deal is made in the **engine**, from `this.rng.fork('threshold_<kind>_<tick>')`
  (rule 4), and stored in `gameState.threshold?: { kind, cards, tick }`. That
  makes it optional and saved (rule 8). A reload shows the same three cards.
- No card can set a phase or an era. Every one is an operator on conditions,
  so the stage that follows still emerges.

**Cost:** medium. The card generator exists. The work is the moment weights,
the non-modal fan, and the deal moved from the UI (`FaithHand.seek` seeds its
own `SeedRNG`) to an engine method.

**Risks:**
- If the cards read as "pick your next stage", the threshold becomes a script.
  Mitigate with odds and side effects on every card, and no "advance" action.
- A player at 1000× may never see the fan. 1A's hold fixes that. 1B needs 1A.

### Option 1C: Ages as long as their pressures (pace from need, not a clock)

**The player sees:**
- Ages no longer tick by on a fixed rate. A sated, peaceful world lingers in
  its golden age. A hungry, crowded, warring one rushes, and pays for it.
- "Fed" hovers around 100–130 %, so a drought, a war or a card pushes it
  under.
- The ages of an ignored world still pass. They are just shaped by what
  presses on the people.

**The simulation changes:**
1. **Bound the pace die** (R1). Replace `(21 − e) / 10` in
   `updateBiologyPhase`, `civAdvanceRate` and the third copy at
   `BigBangEngine.ts:4330` with **`0.6 + 0.05 × (20 − e)`**, for `e` in 1..20.
   That gives 0.6 at a roll of 20 and 1.1 at 10 (the median is unchanged), and
   1.55 at a roll of 1: a 2.6× range instead of 20×. Put it in one function,
   `paceOf(stats)`, so the three copies cannot drift apart.
2. **Population moves in era-time** (R2). `Nations.advance` passes `eras` to
   `recompute`. The logistic step becomes
   `growth = (1 + g)^(eras / REF_ERAS) − 1`, with `REF_ERAS = 2000 / 44000`
   (one step at a median roll). Famine stays capped at −30 % per step. People
   then keep up with their own knowledge at any pace and any speed. The Creative
   leap (`leapToEra`, STEP 2000) goes through the same path (rule 6).
3. **Necessity paces study** (vision §8). In `Nations.research`, multiply the
   `pace` by `need = 0.7 + 0.8 × max(hunger, crowding, scarcity, unrest)`,
   clamped to [0.7, 1.5], where each pressure is 0..1. Comfort is slow and
   need is fast. `research` already reads `pressures` to *choose* a technology.
   This makes them set the *speed* too.

**Cost:** medium. It is three edits in the sim, but every balance check moves.
`nationsCheck`, `techCardsCheck`, `smokeTest` and `playerProgressCheck` need
re-baselining, and the visual goldens do not change.

**Risks:**
- A median roll gets slower ages in comfortable worlds, and a passive player
  may wait longer. Measure the ages' wall time at ▶ and at 1000× before and
  after, with the paceCheck below.
- With item 3, a very comfortable world could crawl. The clamp of 0.7 bounds
  it.
- **Vision:** strongly for. The ages *become* the pressures' consequence.

### Option 1D: Turning points that come from the nations' own state

**The player sees:** the ages need the god because the world presses, not
because a script says so. When one nation's pressure crosses into acute, the
disc pins a symptom where it happens, using the words of
`PeopleStory.symptomsOf`: "The young go hungry in the north of Deiis". A short
hold follows (from 1A), and for one season the Faith deck's Seek draws from
that crisis. The same happens when a war begins, when a nation falls, or when
smoke fouls the land. The player sees the consequence, never the label
"FAMINE".

**The simulation changes:** almost none. `Nations.recompute`'s `note()`
already logs every acute crossing with its causes (`marks['p:<pressure>']`),
and wars and falls are already news. A new `drainTurningPoints()` on
`NationSystem` returns the crossings that matter:
- the nation holds at least 25 % of the people, **or**
- it is the first time this pressure turned acute on the world, **or**
- it is the first war of the age.

The engine forwards them as moments of kind `'turn'`. This only becomes
meaningful once 1C makes the pressures reachable. Today, at "443 % fed", they
rarely fire.

**Cost:** small (plumbing), but it depends on 1C to matter.

**Risks:**
- Crisis spam on a troubled world. Cap it at one turning point per nation per
  half age, and merge the rest into the feed.
- **Vision:** for. This is §3 (consequences shown, labels hidden) and §9
  (consequences create future scenarios) made visible.

### Option 1E: The species makes the people (the mind is evolved, not rolled)

**The player sees:**
- The people are the creature the player shaped. The first-minds moment
  happens only when a lineage can actually think.
- Language, Toolmaking and Bigger Brain are the lab choices that bring it
  closer. The god can quicken them, but cannot hand them a civilisation.
- After the first age, DNA buys adaptations that answer the people's
  pressures. This is pillar C of `2026-10-19-species-bond-and-cards.md`.

**The simulation changes:**
- **The gate.** For the primitive → intelligent step, `updateBiologyPhase`
  requires a thinker: `peopleOf(species, MIND_MIN)` with `MIND_MIN = 4` on the
  0–10 `dna.intelligence` scale, and `locomotion !== 'stationary'`. Without
  one, the outcome is `'stall'` with its own line ("They are clever with their
  bodies, not yet with their thoughts"). This is not a collapse. It does not
  count toward `bioStalls`, so the stall penalty does not compound.
- **The order.** `language` and `toolmaking` move from `phase: 'intelligent'`
  to `phase: 'primitive'` in `Mutations.ts`, so they are offered while they
  can still matter. `big_brain` already sets intelligence to at least 5. The
  three become the player's lever on the gate.
- **The drift.** The player lineage's `intelligenceGrowth` drift
  (`EvolutionEngine.ts:459`) gets +50 % while the world is primitive, so a
  passive player still crosses, only later.
- **After the mind.** Civilisation-era DNA buys the pressure-answering
  adaptations of the species plan, P2. DNA keeps a purpose.

**Cost:** medium.

**Risks:**
- **The one-species world.** The tester's world held one lineage, and a plant
  one at that. The gate would stall it forever unless the ecology branches a
  mobile lineage, or the player's DNA moves one. Guard it with
  `playerProgressCheck` (at least 35 % of seeds must still reach intelligence
  in 400k ticks) and fall back to the drift.
- **Rule 7.** The people chosen by `peopleOf(species, MIND_MIN)` must be the
  same species everywhere: the nations' genome (`stepNations` →
  `ns.found(..., genome)`), Your People, and Nations & Councils' "wildlife"
  line.

### What each currency is for, stage by stage (after 1A–1E)

| Stage | DNA | DP | TP | The moment offers |
|---|---|---|---|---|
| Microbial → complex | body plan, metabolism (lab) | nudge, seek, works on the land | — | thresholds of seas, cold, air |
| Primitive | **the mind**: Bigger Brain, Language, Toolmaking | Quickened Minds, fire from the sky | — | thresholds that select for wit |
| First nations → Industrial | adaptations that answer pressures (hunger, cold) | omens on nations, answers to petitions (problem 3) | tech cards | turning points from the nations' state |
| Industrial → Space Age | hardiness against pollution and disease | the same, plus the heavens | tech cards; the colony ark | turning points; the first ark |
| Interstellar+ | colony divergence (`Divergence.ts`) | the heavens, other stars | tech cards | a star dies nearby; first contact |

**DP pacing (measure first):** wall-time DP regen makes the god's budget per
age depend on the speed button. Moments partly correct this, because holds
spend wall time at ▶. If the paceCheck still shows fewer than one Seek's worth
of DP (6) per age at 1000×, move the regen into game time with a wall-time
floor. That decision belongs in a separate PR.

### Recommendation for Problem 1

Do **1A first, then 1C, then 1B with 1E, and fold 1D into 1A's event bus.**
1A gives the felt change at once ("slow down or pause at each stage change").
1C makes the world press at all. 1B gives the player something to do at the
moment. 1E makes that moment the player's own creature's.

---

## Problem 3: Blocking leader pop-ups

### Option 3A: Voices, not modals

**The player sees:**
- A leader who wants to speak is a line in the feed and a badge on the
  NATIONS rail: "✉ Dax, king of Oshon, would speak with you". It never opens
  by itself.
- Clicking it opens the dialogue **docked** in the right column (like Your
  People), not as `#leader-dialogue-overlay` over the whole screen. Speed
  buttons, rails and the Faith deck stay live, and Esc closes it.
- Speaking is free, and only the bless and omen answers cost DP.

**The simulation changes:**
- `eng.onLeaderMessage` (`main.ts:1257`) adds a feed entry instead of calling
  `showLeaderDialogue`.
- The 1 DP fee to receive goes (`main.ts:3661`).
- `fireLeaderMessage` fires only on a new era high (see 1A), never on a
  re-advance.
- **The template fix:** `LeaderDialogue` stops calling the god's
  `generateCivilizationMilestone`. `eventContext` becomes structured, as
  `{ kind: 'era' | 'first' | 'blessing' | 'revelation' | 'petition', era?, need? }`.
  A new `FallbackNarrator.generateLeaderLine(leader, ctx)` has first-person
  templates per `communicationStyle` ("We have learned to make iron sing,
  Great One. Is this your will?"). The Gemini prompt receives the same fields
  in place of a sentence.

**Cost:** small.

**Risks:**
- Voices become noise that nobody opens. That is acceptable for P1: it stops
  the harm. The later options give the voices a reason.

### Option 3B: One summary per age

**The player sees:** at each new age, the moment banner from 1A carries the
age's summary. It shows the age's name, what was learned (the top three
techs, from `drainDiscoveries`), wars fought, who rules now, and one line from
the ruler of the leading nation, with *FOLLOW IN THE CHRONICLE*. The summary
is not modal. It stays in the event log as one entry. The existing leap text
in `leapToEra` ("Ages pass in a breath: …") is the model.

**The simulation changes:** none beyond 1A. The engine gathers the age's
discoveries, wars and falls into the moment payload, as the leap already does.

**Cost:** small.

**Risks:**
- Low. It replaces one interruption per age with one non-blocking card. At
  1000× several ages may merge into one banner, per 1A's budget.

### Option 3C: Rulers as characters on the Nations & Councils window

**The player sees:** each nation's Council of State is made of people who
live:
- A ruler and two councillors, with portraits.
- They are born, reign, age and die.
- Heirs take the throne. A revolt replaces the council, and a conquest ends
  it.
- Loyalty and influence move:
  - the Marshal rises in war;
  - the High Priest rises after a cast;
  - loyalty falls with cohesion.
- Every succession is a Chronicle entry with its causes ("Queen Ysel died; her
  Marshal took the throne while the north starved"). Across the ages the
  tester would see new faces, and know why.
- The leader who speaks to the god is the ruler of the leading nation, the
  same person shown on the council. The disposable stranger is gone.

**The simulation changes:**
- `Nations.ts` gains `Nation.council?: Figure[]`:
  ```ts
  interface Figure {
    id: number; name: string;
    seat: 0 | 1 | 2;              // 0 ruler; titles from SEATS[government] (moved from NationsOverview)
    born: number; dies: number;   // era-time (NationSystem.age); a reign 0.3–0.9 era
    traits: PersonalityTrait[];   // Leader.ts pools, weighted by the nation's values
    attitude: AttitudeTowardGod;  // starts from piety, moves with casts and answers
    loyalty: number;              // 0..1, eases toward cohesion ± temper
    influence: number;            // 0..1, seat weight + war / piety / knowledge drift
    memory: number[];             // chronicle ids, last 10 (replaces leaderMemories for the home world)
  }
  ```
- Figures are generated from the NationSystem's own rng, so the sim stays
  deterministic (rule 4).
- Successions happen inside `advance`, on death, on an `unrest` revolt (the
  existing `rose against` history), on conquest and on a change of government.
  Each one is logged with its causes.
- **Rule 7 consistency:**
  - `spawnLeaderForStar` stops spawning for the player star.
  - `gameState.leaders`' entry for that star becomes a projection of the
    leading nation's ruler, refreshed whenever the ruler changes.
  - Other stars keep today's per-star leader.
- **Rule 1:** `NationsOverview.councilOf` stops hashing and reads
  `n.council`.
- **Art:** portraits stay procedural. Each is the people's
  `SpeciesSprite.bakeCreatureSprite`, drawn at 32 px with a 6×6 seat prop
  (crown, staff or helm) stamped above, and tinted by the flag. The portrait
  is genome-derived, so it changes when the people evolve, which is the point.

**Cost:** medium to large.

**Risks:**
- **Saves.** Nations are runtime-only, so the rulers are lost on reload just
  as the history is today. Accept that for now and flag it; the fix is a
  NationSystem save, which is its own task.
- **Reset.** `NationSystem` is rebuilt per game, so figures cannot leak
  between games. `gameState.leaders`/`leaderMemories` are already cleared at
  `BigBangEngine.ts:1246`. Keep both.
- **Vision:** for (§4, civilisations are agents with their own state).

### Option 3D: Petitions, which the player may answer or ignore

**The player sees:** when a pressure turns acute in a nation, its ruler may
petition the sky:

> "The granaries of Deiis are empty. Queen Ysel asks the sky for mercy."

The petition sits in a **Voices** tray, the NATIONS rail badge with a short
list. It never blocks and lasts one season (0.25 era). The player can respond
in three ways:
- **Answer it** with any Faith card cast on that nation, through the existing
  cast path. The answer can be the kind expected (rain) or a cruel one
  (murrain).
- **Speak**, through the docked dialogue from 3A.
- **Ignore it.**

The ruler remembers. The petition never pays out a reward. Its consequences
are the people's: their attitude to the god and their piety. The Chronicle
links the petition, the cast and what came of it.

**The simulation changes:**
- In `Nations.recompute`'s `note()`, an acute crossing pushes a petition
  `{ id, nation, figure, need, mark: n.marks['p:<need>'], until: age + 0.25 }`,
  unless the ruler's attitude is `open_atheist`. Limits: at most one open
  petition per nation and three on the world.
- `drainPetitions()` works like `drainNews`. When the window closes:
  - **Answered** (a cast reached that nation in the window): ruler
    `attitude +1` along `ATTITUDE_SCALE` (`shiftLeaderAttitude` exists),
    nation `values.piety +0.03`, bounded to 0..1.
  - **Answered with a bane:** `fear +2`, piety +0.03, cohesion −0.03.
  - **Ignored:** a pious ruler's attitude −1, nothing else.
- `HistoryEntry.kind` gains an optional `'petition'` value. The cast entry
  links to the petition, so the Chronicle shows "your hand" with the
  petition at the root.

**Cost:** medium (needs 3C for the figure; with 3A only, it could be voiced by
the nation without a face).

**Risks:**
- Petitions turn into quests. They must not grant DP or DNA, and they must not
  name the scenario. The wording comes from `symptomsOf`.
- They crowd the screen on a troubled world. The caps above prevent that.

### Option 3E: Prophets and heretics

**The player sees:** in a pious nation under pressure, someone claims to speak
for the god. The player can send a sign that affirms them, contradict them
with an omen, or stay silent. A prophet who is affirmed founds a movement. A
prophet who is contradicted may still be believed, or may turn the people
from the sky.

**The simulation changes:**
- A prophet is a `Figure` with no seat. They arise when
  `piety > 0.6 && unrest > 0.4`.
- Their movement is a new pressure on cohesion between nations. That needs
  religion between nations, which the vision mapping lists as missing.

**Cost:** large.

**Risks:**
- Scope. It needs inter-nation religion first. It fits the premise well (the
  people's relationship to a god they cannot see), but should come later.

### Recommendation for Problem 3

**3A and 3B now. Then 3C. Then 3D. Leave 3E for after religion between
nations.** 3A and 3B remove the blocking and the broken line in one small PR.
3C answers "the council never changed". 3D gives the voices a reason to be
heard, and feeds the Chronicle's "Your hand is in this".

---

## Phased plan (both problems)

Each phase is one PR, one concern, with its issue number. Every new
`gameState` field is optional (rule 8). Every phase adds its guard (rule 9).
**A guard's control must reject the current build first.**

### P1: Moments and voices (small) — 1A + 3A + 3B

**Touches:**
- `BigBangEngine.ts`: `onStageMoment`, emitted from `updateBiologyPhase`,
  `stepNations` (founding) and `advanceCiv`; `fireLeaderMessage` only on a new
  high; the moment payload for an age (discoveries, wars, falls, ruler);
  `gameState.momentHigh`.
- `main.ts`:
  - the hold stack replaces `slowForEvent`/`restoreSpeed` everywhere they are
    called;
  - the banner;
  - `onLeaderMessage` goes to the feed;
  - no DP fee;
  - the docked dialogue;
  - Esc closes it.
- `src/ui/SpeedHold.ts` (new, pure).
- `LeaderDialogue.ts`, `FallbackNarrator.ts`: `generateLeaderLine` and the
  structured context.
- **Art:** nine 32×32 moment glyphs in `tools/gen_pixel_icons.py`: cell
  cluster, eye, hand, mind, flag, columns, ark, cracked ground, star burst.
  They are written to `assets/pixel/divine/moments/` and
  `public/assets/pixel/divine/moments/`. The diorama also gets a one-ring
  pulse at the moment's cell, reusing the card-reach sweep.

**Guards:**
- `tools/momentCheck.ts`. A headless run at evo 20 on seeds a and b, 160k
  ticks, recording `onStageMoment` and `onLeaderMessage`. It asserts:
  - exactly one moment per new high, per bio phase and per era;
  - seed b's bounces give **one** Ancient moment and at most one Fall per half
    age;
  - `onLeaderMessage` fires at most once per era high;
  - every moment carries the player's `starId`.
  - **Control:** on today's build, seed b gives 12 leader messages, so the
    check fails.
- `tools/speedHoldCheck.ts`: nested holds restore the original speed only on
  the last release, and a player speed press clears all holds.
- `tools/leaderLineCheck.ts`: every `communicationStyle` × every context
  kind. It asserts no `..`, no `achieved [A-Z]`, no third-person own faction
  ("The Oshon" said by Oshon's king), and exactly one terminal mark.
  **Control:** today's fallback fails on "have achieved Our".
- **Visual test:** a new case for an era change at 1000×. It expects the
  banner and **no** `#leader-dialogue-overlay.active`.

### P2: Ages that press (medium) — 1C + 1D

**Touches:**
- `BigBangEngine.ts`: `paceOf(stats)` replaces the three `(21 − e)/10`
  copies; turning points become moments.
- `Nations.ts`:
  - `recompute(grid, tick, eras)` with era-time growth;
  - the `need` factor in `research`;
  - `drainTurningPoints()`.

**Guards:**
- `tools/paceCheck.ts` hardens this doc's probe. It covers evo 20 and evo 10,
  four seeds, 300k ticks. It asserts:
  1. the median ticks per bio stage at evo 20 is at least 0.4× the evo-10
     median (today it is about 0.08×);
  2. the median "fed" at each era start is between 0.95 and 1.8 (today it is
     1.5–4.5 at evo 20);
  3. at least one acute pressure crossing per two ages at both rolls.
  - **Control:** items 1 and 2 fail on main.
- **Invariant** (`invariantCheck.ts`): "a founded nation's fed ratio stays
  ≤ 3 after its first age". Flag it `knownIssue` until P2 lands.
- Re-baseline `nationsCheck`, `techCardsCheck`, `smokeTest` and
  `playerProgressCheck` (at least 35 % of seeds must still advance).
- Report DP per age at ▶ and at 1000× (the DP finding above), so the regen
  decision is made on numbers.

### P3: Rulers who live (medium–large) — 3C

**Touches:**
- `Nations.ts`: `Figure`, successions, and loyalty and influence dynamics;
  `SEATS` moves from `NationsOverview.ts`.
- `NationsOverview.ts`: reads `n.council`, plus the portraits.
- `BigBangEngine.ts`:
  - `spawnLeaderForStar` skips the player star;
  - the projection into `gameState.leaders`;
  - `leaderMemories` for the home world come from `Figure.memory`.
- `src/rendering/`: a portrait helper over `bakeCreatureSprite`, with seat
  props, cached per (genome, seat, tint) and cleared by `clearSpriteCaches()`.

**Guards:**
- `tools/councilCheck.ts`, over 6 ages and 4 seeds. It asserts:
  - a median of at least one succession per nation per two ages;
  - every succession has a Chronicle entry with at least one cause;
  - councillors' loyalty tracks cohesion (Spearman > 0.5);
  - a new game shows no figure from the previous one (the state-reset list).
  - **Control:** today's hashed council has zero successions across six ages,
    so the check fails.
- **Invariant:** every non-fallen nation has three seats titled from
  `SEATS[government]`, and the ruler id is unique.

### P4: Thresholds and the evolved mind (medium) — 1B + 1E

**Touches:**
- `FaithCards.ts`: `discover(..., moment?)` and the moment weights.
- `BigBangEngine.ts`: `dealThreshold(kind)` from a forked rng, and
  `gameState.threshold`.
- `FaithHand.ts`: the non-modal fan, and taking a card free into the hand.
- `updateBiologyPhase`: the mind gate.
- `Mutations.ts`: the phases of `language` and `toolmaking`.
- `EvolutionEngine.ts`: the drift boost.

**Guards:**
- `tools/thresholdCheck.ts`. It asserts:
  - the same seed and tick give the same three cards, before and after a
    save round-trip (with `saveCheck`);
  - no threshold card's action sets a phase or an era;
  - a threshold left to fade leaves the world identical to an untouched twin
    (the `techCardsCheck` twin method).
- **Invariant:** "the people of an intelligent player world can think":
  `peopleOf(...).dna.intelligence ≥ MIND_MIN` and not `stationary`.
  Flag it `knownIssue` until P4 lands. **Control:** all three probe runs fail
  it today (intelligence 0).
- `playerProgressCheck` still holds at least 35 % of seeds reaching
  intelligence.

### P5: Petitions (medium) — 3D

**Touches:**
- `Nations.ts`: petitions in `note()`, `drainPetitions()` and the outcomes.
- `Chronicle.ts` / `ChronicleUI.ts`: the `'petition'` kind as a root of
  "your hand".
- The Voices tray on the NATIONS rail.

**Guards:**
- `tools/petitionCheck.ts`. It asserts:
  - every petition links to a `p:<need>` mark;
  - at most one open petition per nation and three on the world;
  - all petitions expire;
  - twins with an answered and an ignored petition differ in attitude and
    piety, and in **neither** DP nor food (no reward).
- **Invariant:** the petition counts stay bounded.

### Later: prophets (3E), after religion between nations.

---

## Open questions for Sirjohn

1. **Slow or pause?** 1A defaults to *slow to ▶* on great moments, because the
   world keeps moving under the god. Should the default be *pause*, as the
   tester half-asked ("auto-drop to 1× (or pause with a moment card)")?
2. **The pace die.** Is a 2.6× range for the `evolution` roll (0.6 to 1.55)
   right, or should a roll of 20 still feel dramatically fast?
3. **Are threshold cards free to take?** The proposal is free to take into the
   hand, and DP to cast. The alternative is a free cast at the moment, as in
   the Forge.
4. **The mind gate.** May a world stall at Hands until a thinker evolves (with
   the drift as a safety net)? Or should the gate only *slow* the step?
5. **Saving the nations.** P3 and P5 put characters on the nations, which are
   not saved. Fix the NationSystem save before P3, or accept rulers that
   re-roll on reload for now?
