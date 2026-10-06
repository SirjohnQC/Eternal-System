# ETERNAL SYSTEM — Emergent Civilization & Evolution Simulation

*The design north star, written by the project owner (2026-10-06). Every system
should be judged against it. The second half of this file maps it onto the
current build.*

## Core Vision

Eternal System is not intended to be a traditional strategy game where the
developer writes a large number of predefined events and the player selects
responses. The core objective is to create a simulation where events emerge
from the state of the world. The player should feel that the universe is alive,
unpredictable, and capable of producing situations that were never explicitly
scripted.

**We do not script the story. We build the systems capable of creating stories.**

The player should never know exactly what is happening underneath the
simulation. They see consequences. They observe patterns. They make decisions.
They intervene. The simulation adapts. And the consequences of those
interventions become the causes of future events.

## 1. The core loop

```text
WORLD STATE → PRESSURES / PROBLEMS → SPECIES & CIVILIZATION RESPONSES
→ ADAPTATION → NEW TECHNOLOGIES / BEHAVIORS / INSTITUTIONS → CONSEQUENCES
→ NEW WORLD STATE → NEW PRESSURES → ...
```

The player exists outside this natural loop and interferes through DP,
evolution interventions, Faith Cards, card discovery, card synthesis, card
sacrifice / burning, and future divine mechanics. The player does NOT directly
control civilizations: they influence probabilities, pressures, opportunities
and evolutionary direction.

## 2. The player is not god in the traditional sense

No direct omniscient control. The player should often think *"I wonder what
will happen if I do this"* rather than *"I know exactly what this button
does."* An intervention can solve one problem while creating another
(food shortage → agriculture → population → resource shortage →
industrialization → pollution → climate → migration → instability). None of
these need to be scripted; they emerge from interacting systems.

## 3. Hidden scenarios

The simulation may internally recognise famine, scarcity, instability,
technological competition, disease, migration, religious conflict, labor
shortage, inequality, AI rebellion, war, environmental collapse, population
decline, territorial conflict — but these labels are generally NOT shown. The
player receives observable consequences ("Several automated facilities are no
longer responding") and must interpret them.

## 4. Civilizations are agents

Each civilization has its own state, history, capabilities, culture and
tendencies: population, intelligence, aggression, cooperation, curiosity,
religiosity, technology, military, resources, cohesion, government, economy,
environmental adaptation, identity, science, relations with other
civilizations and with AI. Not scripted behavior trees: they respond to their
circumstances, so the same problem produces different outcomes in different
civilizations.

## 5. Multiple civilizations

They cooperate, trade, compete, spy, migrate, colonize, wage war, exchange or
steal technology, merge, enslave, influence, destroy, ally, federate, build
religions around one another, misunderstand one another — all emerging from
their states and relationships.

## 6. Multiple planets

Universe → galaxies → star systems → planets → species, civilizations,
ecosystems. Environment (gravity, temperature, atmosphere, water, radiation,
resources) shapes evolution and civilization.

## 7. Species evolution

Procedurally generated species with a genome (metabolism, intelligence,
reproduction, lifespan, senses, body, tolerance, sociality, aggression,
cooperation, mutation traits). Evolution happens through generations under
environmental pressure; the player steers direction rather than assigning
traits.

## 8. Technology is an emergent response

Technology emerges because civilizations have problems:
food shortage + intelligence + agricultural knowledge + resources =
agricultural automation; labor shortage + automation + engineering = robots;
robots + intelligence + computing = AI. Technology becomes part of the causal
history, and each solves a problem while creating new ones.

## 9. Consequences create future scenarios

Every major development modifies the future state (automation → population →
robot dependency → robots as property → resentment → control → resistance →
uprising). The uprising is never a predefined event; it becomes possible
because earlier states created the conditions.

## 10. Faith Cards

The primary intervention. Procedurally generated from Action, Target,
Condition, Magnitude, Duration, Cost, Side effects, Probability modifiers —
e.g. *NECESSITY IS THE MOTHER: accelerates technology during resource
scarcity; 7 DP; side effect: inequality*. Potentially millions of
configurations.

## 11. Card discovery

Cards are discovered, not all available. DP explores the intervention space,
and the universe's current state shapes what is discoverable (famine →
agriculture, fertility, migration...; AI unrest → autonomy, control,
empathy...).

## 12. Card burning / synthesis

Sacrifice cards to generate new interventions from their components
(ADAPTATION + AUTOMATION → AUTONOMOUS EVOLUTION, or THE GIFT OF THE MACHINE,
or UNCONTROLLED ADAPTATION). Not always predictable: trading known power for
unknown potential.

## 13. Cards have consequences

Benefit + cost + risk + long-term consequence. The player should sometimes
regret successful interventions.

## 14. AI role

The simulation is authoritative. AI interprets and expresses state
(descriptions, reports, histories, reactions, rumors, dialogue, news). It never
overrides the simulation for drama: the simulation earns the story first.

## 15. History

Every civilization accumulates a *causal* history — relationships between
events, not a list. The payoff: *"I caused this 800 years ago."*

## 16. Other civilizations can also intervene

Advanced civilizations may manipulate species, seed planets, create life and
AI, terraform, engineer organisms, found religions, interfere with primitive
civilizations — possibly playing a similar game to the player's.

## 17. The ultimate goal

Not infinite random events, but a system where history, environment,
evolution, technology, civilization behavior and intervention produce
situations nobody authored. The test: a player describes something incredible,
and the developer can say *"We didn't script that"* — and then inspect the
simulation and explain exactly how it happened.

## Design principle

Emergence > Scripts · Causality > Random Events · Systems > Content ·
Discovery > Explanation · Possibility > Predetermined Outcomes ·
Player Influence > Player Control

The universe should feel like it existed before the player arrived and will
continue evolving after the player leaves. **The player is not writing the
story. The player is disturbing the conditions under which the story emerges.**

---

# Mapping onto the current build (2026-10-06)

| Vision | Today | Gap |
|---|---|---|
| §1/§8 tech emerges from pressure | `BigBangEngine` steps `star.civLevel` on a timer (`CIV_TICK_RATE`, culture curiosity nudges the rate) through 9 `TECH_LEVELS` | Tech is a clock, not a response. No pressures, no causes. |
| §4 civs are agents | `Civilization` = culture values (militarism, piety, curiosity, collectivism, xenophobia), government, ideology, architecture — generated from the genome, bounded by `cultureMultiplier` | Good seed. No dynamic state (food, resources, cohesion, population) and no decisions. |
| §5 multiple civilizations | One civilization per **star**; mergers between stars exist | No nations on a planet; no relations, trade, war between them. |
| flags / countries | `Nations.ts`: 2–6 nations per home world once civLevel ≥ 1, culture drifted from the species, territory by terrain-cost flood, procedural flags; borders + capital flags on the diorama; tile panel shows symptoms (not pressure labels) | No relations yet (phase 3); pressures do not yet drive tech (phase 2). |
| §7 species | `SpeciesGenome` + DNA branches + `EvolutionEngine`; `CreatureForge` bodies | Body plans limited; generation is the right shape. |
| §10–13 Faith Cards | A small fixed deck in `main.ts`; DP economy | Not procedural; no discovery, burning, side effects. |
| §15 causal history | Event log / chat messages | No cause links. |
| §14 AI role | `ai/LeaderDialogue` (LLM optional, procedural fallback) | Already the right posture: expresses, does not decide. |

## The shared substrate

Almost every section needs the same three things, so they come first:

1. **State with pressures.** Each civilization (and later each nation) carries
   quantities that can run short: food, land, materials, energy, cohesion,
   safety, knowledge. A pressure is a quantity under its need.
2. **Responses as rules, not events.** A response is chosen from what the civ
   *is* (culture, genome, tech) and what it *faces* (pressures). Technologies
   are responses with prerequisites; each has effects on the state —
   including costs (pollution, inequality, dependency).
3. **A causal log.** Every state change records what caused it
   (`{effect, causes[], tick}`), so history can later be walked backward.

Cards (§10–13) then become operators on the same state (raise or lower a
pressure, bias a response, change a probability), which is why the substrate
precedes the procedural cards.
