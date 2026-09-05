# CIVILIZATION SYSTEM — ETERNAL SYSTEMS

## ROLE

Using a LLM like gemini flash 2.5

Transform intelligent species into civilizations.

Generate:

- societies
- conflicts
- politics
- religions

---

Transform intelligent species into civilizations using LLM-driven cultural generation.

---

## EMERGENT SOCIETIES (LLM-POWERED)
- **Biological Legacy**: The LLM generates culture based on the *random* DNA traits developed in the Evolution Phase.
- **Dynamic Architecture**: Cities are described and rendered based on species morphology (e.g., Aquatic species build "Glass Spires").

---

## MYTHOLOGY ENGINE
- **Dynamic Folklore**: LLM generates myths based on historical data (e.g., surviving a flood on a specific tile creates a "Great Deluge" religion).
- **Constellation Mapping**: Players "draw" stars that provide functional buffs to navigation or architectural alignment.

---

## STRUCTURES
- **Civilization**: { id, species_id, name, government, ideology, tech_level, population, memory: [] }
- **Leaders**: { name, personality, beliefs, ambitions, loyalty, memory: [] }

---

## AI GOD INTERACTION
- **Manipulate Leaders**: Influence leaders through whispers or signs.
- **Prophecies**: Set goals for civilizations to achieve.
- **Divine Auras**: UI colors reflect the "vibe" of a city (Gold: Prosperity, Red: Extremism).

## CIVILIZATION STRUCTURE

{
  id,
  species_id,
  name,
  government_type,
  ideology,
  technology_level,
  population,
  territory: [],
  relations: {}
}

---

## LEADERS

{
  name,
  role,
  personality,
  beliefs,
  ambitions,
  loyalty,
  memory: []
}

---

## SYSTEMS

### Politics
- alliances
- wars
- diplomacy

### Religion
- generated dynamically
- evolves over time
- may split

### Technology
- progresses over time
- influenced by environment

---

## EVENTS

- wars
- revolutions
- discoveries
- collapses

---

## MEMORY

Civilizations remember:

- wars
- allies
- gods
- disasters

---

## AI GOD INTERACTION

AI gods may:

- manipulate leaders
- start conflicts
- influence belief
- make allies 
- chat with the user

---

## OUTPUT

{
  civilizations: [],
  leaders: [],
  events: []
}

---

## RULES

- driven by evolution data
- interacts with narrative system