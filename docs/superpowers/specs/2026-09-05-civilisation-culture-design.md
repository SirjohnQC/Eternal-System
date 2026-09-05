# Civilisation Culture from Evolved DNA — Design

**Date:** 2026-09-05
**Milestone:** M23 (first of six subsystems in `CIVILIZATION_SYSTEM.md`)
**Status:** approved in chat, awaiting spec review

> This project is not a git repository, so this spec is written to disk but not
> committed. Nothing else in the workflow depends on the commit.

---

## Purpose

Turn an intelligent species into a civilisation whose character comes from the
DNA it actually evolved. A hive-minded aquatic filter-feeder and a solitary
walking apex predator should build visibly different societies, and those
differences should be legible in play — not just in a description panel.

Today every civilisation behaves identically. War chance, tech speed, religion
and first-contact hostility are all driven by universe-wide stats
(`this.stats.hostility`, `this.stats.evolution`) with no per-civilisation term at
all. Two neighbouring empires with completely different biology are mechanically
indistinguishable.

## Scope

**In:** the `Civilization` record, LLM generation from the genome, schema
validation, procedural fallback, five simulation insertion points, a planet-panel
Culture section, Codex entries, and a verification tool.

**Out** — these are the other five subsystems in the design doc and are NOT built
here, though the record carries the fields they will need: mythology generated
from real event history, constellation mapping with functional buffs,
diplomacy/alliances/relations, prophecies, and morphology-driven city rendering.

## Decisions taken

1. **LLM output drives the simulation.** Chosen deliberately over a
   deterministic-structure / LLM-prose split. The consequences below are managed,
   not avoided.
2. **Generation is once at emergence**, repeated only on upheaval. Roughly 3–6
   intelligent civilisations exist per universe (measured, `tools/engineSim.ts`),
   so call volume is trivial.

   **Upheaval is exactly these four events**, and nothing else — the list is
   closed so call volume cannot creep:
   - losing a war (`civLevel` reduced by a war resolution)
   - a collapse or catastrophe that drops the civilisation below `civLevel 1`
   - evacuation to another star (`evacuateCivilisation`, M22g)
   - the biosphere re-reaching `intelligent` after regressing from it

   Regeneration reuses the current genome, so a civilisation that has evolved
   since emergence gets a culture reflecting what it is *now*.
3. **Determinism holds offline.** The engine's determinism guarantee — asserted by
   `smokeTest`'s "same seed → identical universe" — is preserved in headless and
   offline mode, where the procedural generator is seeded from the universe seed.
   Online, culture is intentionally variable. The determinism test runs headless,
   so it remains meaningful.
4. **No network calls in the tick loop.** Generation is event-driven and
   asynchronous. The simulation only ever reads a stored record. A civilisation
   whose generation is still in flight uses its procedural record until the LLM
   result arrives and replaces it.

---

## Data model

New file `src/simulation/Civilization.ts`.

```ts
export type Government =
  | 'Theocracy' | 'Republic' | 'Empire' | 'Confederation'
  | 'Technocracy' | 'Warband' | 'Hive' | 'Council';

export type Ideology =
  | 'Expansionist' | 'Isolationist' | 'Mercantile' | 'Militarist'
  | 'Scholarly' | 'Devout' | 'Egalitarian' | 'Hierarchic';

/** Each 0–1. These are what the simulation actually reads. */
export interface CultureValues {
  militarism:    number;
  piety:         number;
  curiosity:     number;
  collectivism:  number;
  xenophobia:    number;
}

/** Flat, serialisable copy of the traits culture is generated from. */
export interface GenomeSummary {
  speciesName:   string;
  metabolism:    string;
  locomotion:    string;
  environment:   string;
  diet:          string;
  respiration:   string;
  reproduction:  string;
  size:          string;
  bodyStructure: string;
  sensorySystem: string;
  intelligence:  number;
  social:        number;
  aggression:    number;
  adaptability:  number;
  biome:         string;
  temperatureRange: string;
}

export interface Architecture {
  style:         string;   // free text, length-capped
  material:      string;
  settlementForm: string;
}

export interface Civilization {
  id:             string;
  starId:         number;
  speciesId:      string;
  name:           string;
  government:     Government;
  ideology:       Ideology;
  values:         CultureValues;
  architecture:   Architecture;
  selfDescription: string;
  foundingMyth:   string;
  epithet:        string;
  /**
   * Snapshot of the genome this was generated from, for the Codex and for
   * regeneration. A flat copy rather than a live reference: `playerSpecies` is
   * REASSIGNED on every evolution step, so a held reference goes stale silently
   * (ROADMAP M20b).
   */
  sourceGenome:   GenomeSummary;
  origin:         'llm' | 'procedural';
  generatedAtTick: number;
}
```

Stored on `gameState.civilizations: Record<number, Civilization>` keyed by
`starId`. `gameState` is serialised wholesale by the save system
(`main.ts:3336`), so this persists for free — but it must be **cleared on a new
game** alongside `leaders`, `factionFlags` and the rest. State leaking between
games in one session is the single most repeated bug in this codebase
(ROADMAP M20b), and a keyed record of stale star ids is exactly that shape.

---

## Generation pipeline

```
reach 'intelligent'  ──▶  procedural record written immediately  (never absent)
                             │
                             ├─ offline / no key / rate-limited ──▶ done
                             │
                             └─ online ──▶ Gemini call
                                             │
                                             ▼
                                     schema validation
                                             │
                                    ┌────────┴────────┐
                                  valid            invalid
                                    │                 │
                          replace record      keep procedural,
                          origin='llm'        log, do not retry
```

Writing the procedural record **first** is deliberate: there is never a window
where an intelligent civilisation has no culture, and no code path needs to
handle a missing record.

### Prompt input

The species' real evolved genome, not a summary invented for the prompt:
metabolism, locomotion, environment, diet, respiration, reproduction, size, body
plan, sensory system, intelligence / social / aggression / adaptability, habitat
biome and temperature range, plus the biosphere's oxygen level and biodiversity
and the star's tech tier.

### Response contract

Strict JSON. Every field validated:

| field | rule on failure |
|---|---|
| `government`, `ideology` | must match the enum exactly; otherwise the whole response is rejected |
| `values.*` | coerced to number, clamped 0–1; non-numeric rejects the response |
| `architecture.*` | strings, trimmed, capped at 60 chars |
| `selfDescription`, `foundingMyth` | capped at 400 chars |
| `epithet` | capped at 60 chars |

Rejection is all-or-nothing: a partially valid response is not merged, because a
half-LLM half-procedural record is harder to reason about than either.

---

## Simulation insertion points

Culture multiplies rolls that already exist. All five are currently
universe-wide.

| site | today | culture term |
|---|---|---|
| `BigBangEngine.ts:1533` war initiation | `chance(hostility / 40)` | militarism, xenophobia |
| `BigBangEngine.ts:1470` tech advance rate | `CIV_TICK_RATE × (21 − evolution)/10` | curiosity |
| `BigBangEngine.ts:1521` religion emergence | `civLevel === 1 && chance(0.65)` | piety |
| `BigBangEngine.ts:1988` first-contact hostility | `chance(hostility / 25)` | xenophobia |
| `BigBangEngine.ts:3452` war resolution | `chance(0.65 + hostility/200)` | collectivism |

Note on the religion site: an earlier draft of this spec pointed at
`BigBangEngine.ts:3587`, which is the **asteroid-impact** roll, not religion.
Religion actually emerges once, at `civLevel === 1`, on a flat 0.65 chance. That
means piety cannot scale a repeated roll here — it shifts the one-shot chance and
the starting devotion instead.

### The clamp is structural, not advisory

Every culture term resolves through one function:

```ts
/** Culture's influence on any roll. Hard-bounded; can never reach 0 or certainty. */
export function cultureMultiplier(v: number, strength = 1): number {
  const t = Math.max(0, Math.min(1, v));          // untrusted input
  const raw = 1 + (t - 0.5) * 2 * strength * 0.6;  // 0.4 … 1.6 at strength 1
  return Math.max(CULTURE_MULT_MIN, Math.min(CULTURE_MULT_MAX, raw));
}
```

`CULTURE_MULT_MIN = 0.4`, `CULTURE_MULT_MAX = 2.2`.

This matters more here than anywhere else in the codebase. ROADMAP M20d was
caused by multiplied factors reaching probability 1 and creating an absorbing
state that no player action could escape — measured at 0 advances in 100,000
rolls. Those factors were written by us. These come from **model output**, which
makes the failure mode more likely, not less. The bound is therefore enforced in
one place and swept exhaustively in test rather than reasoned about per site.

Every call site additionally clamps its final probability below certainty.

---

## UI

- **Planet info panel** — a Culture section: name, government, ideology, epithet,
  a values bar row, architecture, and the self-description.
- **Codex** — civilisation records alongside the species and flora records added
  in M22i, searchable by the same free-text box.
- Records show `origin` honestly, so a player can tell procedural from generated.

---

## Verification

New `tools/cultureCheck.ts`:

1. **Malformed input falls back cleanly.** Feed the validator deliberate junk —
   empty, truncated, wrong types, unknown enum values, prompt-injection strings,
   absurd numbers, deeply nested objects — and assert every one yields a valid
   procedural record rather than a corrupted civilisation. *This is the control:
   it must fail if validation is removed.*
2. **The clamp holds across the whole value space.** Sweep every culture value
   from 0 to 1 at fine resolution, across all five insertion points, and assert
   no resulting probability leaves `(0, 1)` exclusive. Directly guards the M20d
   failure mode.
3. **Distinct genomes produce distinct cultures.** Generate procedurally from a
   spread of archetypes; assert government/ideology/values vary, with a
   random-assignment control proving the measure can detect sameness.
4. **Offline determinism.** Same seed, same species → identical culture records.
5. **Smoke test addition** — every civilisation at `intelligent` has a valid
   record, and `gameState.civilizations` is empty after starting a new game.

Existing tools that must stay green: `smokeTest`, `collisionCheck`,
`galaxyZoomCheck`, `moonCheck`, `dnaEconomyCheck`, `archetypePlacementCheck`,
`mapLayerCheck`, `roadmapAudit`.

---

## Risks

| risk | handling |
|---|---|
| Model output corrupts the simulation | All-or-nothing schema validation; one structural clamp; exhaustive sweep test |
| Game differs with/without an API key | Procedural fallback produces the same record *shape* and value ranges, so behaviour stays sane — less varied, not different in kind |
| Seed determinism | Preserved offline/headless where the tests run; intentionally variable online, per the decision above |
| Prompt injection via species names | Species names are procedurally generated by the engine, never user text; validator caps lengths and rejects unknown enums regardless |
| State leaking between games | `gameState.civilizations` cleared in the new-game reset with the other per-universe state |

---

## Out of scope, recorded for the next subsystems

Mythology from real event history · constellation mapping with functional buffs ·
alliances, treaties and a relations map · prophecies · morphology-driven city
rendering. The `Civilization` record carries `values`, `architecture` and
`sourceGenome` specifically so these can be built on top without reshaping it.
