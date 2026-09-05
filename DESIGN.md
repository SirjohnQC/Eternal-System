# ETERNAL SYSTEMS — Game Design Document
## Version 1.0 | AI Game Studio Output

---

## VISION

> "Eternal Systems is not a game you win. It is a universe you witness — and occasionally, dare to touch."

The player is not a god. They are the ward of one, assigned custodianship of a single planet in an
incomprehensibly vast cosmos governed by an autonomous AI deity of its own design.

---

## DESIGN PILLARS

| # | Pillar | Statement |
|---|--------|-----------|
| 1 | Autonomous Emergence | The universe evolves without the player's consent. |
| 2 | Meaningful Smallness | The player's planet is one of thousands. |
| 3 | Procedural Coherence | Every element is random but internally consistent. |
| 4 | Living Mythology | The Codex is a history book written in real time. |
| 5 | The AI as Character | The AI God is a personality with preferences and philosophy. |
| 6 | Dread and Wonder | Cosmic events feel vast and existentially real. |
| 7 | Time as Resource | Players manage attention, not just actions. |

---

## PRE-GAME: THE BIG BANG RITUAL

### D20 Dice Roll Outcomes

| Roll Sum | Effect |
|----------|--------|
| 2–8      | Sparse universe — few stars, hostile, rare life |
| 9–15     | Balanced universe — moderate density, varied life |
| 16–28    | Dense universe — many stars, extreme events, abundant life |
| 29–40    | Overflow universe — maximum density, frequent catastrophes |

### The Five Questions (Planet Setup)

1. Dominant climate (arctic / temperate / arid / oceanic / volcanic / exotic)
2. Terrain type (flat plains / mountain ranges / deep oceans / crystal formations / gaseous layers)
3. Atmospheric composition (oxygen / methane / ammonia / exotic compounds)
4. Biological tendency (carbon / silicon / energy-based / crystalline / plasma)
5. First species temperament (aggressive / cooperative / reclusive / curious / hive-minded)

**Universe Seed:** `masterSeed = hash(universeName + diceRolls + planetAnswers)`

---

## DIVINE POINTS SYSTEM

### Earning Points

| Source | Points |
|--------|--------|
| Time passage (per tick) | +1 |
| Civilization milestone on player planet | +5 |
| Successful AI God consultation | +10 |
| Cosmic event survived by player species | +15 |
| Interstellar contact made | +25 |

### Spending Points

| Action | Cost |
|--------|------|
| Nudge species evolution trait | 10 |
| Trigger climate shift | 20 |
| Reveal hidden resource | 15 |
| Influence war outcome (probabilistic) | 30 |
| Summon divine sign (interpreted by civilization) | 25 |
| Request AI God to focus on player planet | 50 |
| Attempt to protect planet from cosmic event | 75 |

---

## SIMULATION TIME SCALES

| Speed Mode | Virtual Years / Second |
|------------|------------------------|
| Pause | 0 |
| 1x | 10 |
| 10x | 100 |
| 100x | 1,000 |
| 1000x | 10,000 |

At 100x and 1000x: apply multi-step evolution batch processing per tick to prevent state skipping.

---

## LIFE & SPECIES STATE MACHINE

```
[Primordial Soup] → [Single Cell] → [Multi-Cell] → [Complex Life]
  → [Sentient Species] → [Tribal] → [Agricultural] → [Industrial]
  → [Information Age] → [Spacefaring] → [Post-Scarcity] → [Transcendent]
```

Each transition requires: minimum age threshold, resource conditions, stability score.

---

## CIVILIZATION STATE VARIABLES

```
population, technology_level, military_power, cultural_cohesion,
religious_influence, diplomatic_relations[], resource_stockpile,
interstellar_capability (bool), known_species[]
```

---

## COSMIC EVENTS

| Event | Player Warning | Survivable |
|-------|---------------|------------|
| Supernova | Yes (+3 ticks) | Partial (evacuation) |
| Gamma Ray Burst | No | No (unless shielded) |
| Asteroid Impact | Yes (+1 tick) | Yes (costs DP) |
| Black Hole Drift | Yes (+10 ticks) | With AI God help |
| Extinction Plague | No | Possible (quarantine) |
| Void Storm | Partial | Yes |

Wars span 50–500 ticks; resolved via scheduled EventResolver callbacks.

---

## CORE GAME LOOP

```
[Universe Created] → [Planet Assigned] → [Tick Loop Begins]
       ↓
[AI God Autonomous Evolution]  ←→  [Player Divine Actions]
       ↓
[Key Events Surface] → [AI Consults Player] → [Player Decides / Abstains]
       ↓
[Consequences Applied] → [Codex Updated] → [History Logged]
       ↓
[Time Advances] → [Repeat]
```
