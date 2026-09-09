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

Each step of CIVILIZATION should have their own branching/pace:

Phase 1: Primordial & Tribal (The Pre-Civilization)

Focus: Survival, foraging, megafauna interaction, and biological/social foundations.

    Biological Dawn: Life as primitive flora/fauna, early hominids, or baseline sentient organisms trying not to get eaten.

    Foraging & Nomadic Era: Small bands, fire mastery, rudimentary tool use (flint, bone), tracking herds, and oral traditions.

    Tribal Consolidation: Kinship networks, shamanism/early animist beliefs, cave art, and the transition from pure scavenging to systematic hunting-gathering.

Phase 2: Agricultural & Agrarian (The Birth of "Civilization")

Focus: Sedentism, surplus, population boom, and social stratification.

    The Neolithic Revolution: Domestication of wild crops and livestock; permanent settlements replace temporary camps.

    The Surplus Economy: Food surpluses allow specialized labor (potters, weavers, soldiers, priests) instead of everyone foraging.

    Early State Formation: Irrigation projects, chiefdoms turning into monarchies, writing systems (for accounting and tax), laws, and the first true cities (Mesopotamia, Indus Valley).

Phase 3: Classical & Industrial (The Mechanical Age)

Focus: Empire building, systemic philosophy, and harnessing physical chemistry.

    Classical Empires & Feudalism: Iron working, coinage, massive trade routes (Silk Road), organized religion, standing armies, and philosophy/mathematics.

    The Scientific & Industrial Revolution: Moving from muscle/wind power to coal, steam, and oil. Mechanized manufacturing, railways, mass education, and rapid urbanization.

    Global Interconnection: Telegraphs, steamships, global trade networks, and modern nation-states, ending with globalized conflict and early aviation.

Phase 4: Information & Planetary (Type 0 to Type I)

Focus: Digital networks, rocketry, and total planetary energy mastery.

    The Information Age: Computers, global telecommunications networks, genetics, and automated machinery. The civilization becomes a globally linked nervous system.

    Near-Space Era: Satellites, GPS, orbital stations, and crewed exploration of the local planetary neighborhood (Moon/Mars colonization).

    Type I Transition (Planetary Civilization): Harnessing 100% of the home planet's incoming solar energy, weather control, controlled global ecology, fusion power, and geothermal megaprojects.

Phase 5: Stellar & Interplanetary (Type II)

Focus: Multi-world colonization, stellar engineering, and resource abundance.

    The System-Wide Web: Asteroid mining, permanent habitats across the solar system (Mars, gas giant moons, Oort cloud), and early AI autonomy.

    Dyson Swarm Era: Encapsulating the home star with solar collectors to harvest its total energy output (Type II on the Kardashev scale).

    Interstellar Probes & FTL/Near-Light Travel: Sending generation ships, sleeper ships, or laser-propelled light-sails to neighboring star systems.

Phase 6: Galactic (Type III)

Focus: Multi-star empires, macro-engineering, and post-scarcity.

    The Diaspora of Worlds: Colonizing hundreds or thousands of star systems. Organic species may diverge into separate planetary sub-species or transhuman variants.

    Megastructure Engineering: Building Ringworlds, Matrioshka brains (computational computers built around stars), and stellar engines to physically move star systems.

    Type III Mastery: Harnessing the energy of an entire galaxy, controlling wormholes, and managing interstellar commerce spanning tens of thousands of light-years.

Phase 7: Universal & Dimensional (Type IV & V)

Focus: Reality-scale physics, cosmic manipulation, and spacetime engineering.

    Galactic Clustering & Local Group Dominance: Bridging voids between galaxies, engineering galactic collisions for resources, and mastering cosmic strings.

    Type IV (Universal Scale): Harvesting the dark energy of the expanding universe, manipulating space-time geometry, and bypassing the heat death of the universe (building pocket universes or creating time loops).

    Multiversal/Dimensional Expansion (Type V): Accessing parallel realities, higher spatial dimensions (branes), and rewriting the fundamental laws of physics at will.

Phase 8: Transcendent & Post-Physical (Type VI)

Focus: Mind uploading, substrate independence, and entropy defiance.

    The Singularity of Consciousness: Biological entities fully abandon physical form, uploading into pure information patterns, quantum foam, or cosmic background radiation.

    Reality as Software: The civilization no longer "lives" inside space; space and time become variables they can compute and rewrite. They build simulated universes and populate them.

    Entropy Reversal: Finding loopholes in thermodynamics to sustain thought and existence indefinitely, effectively becoming immune to the death of the universe.

Phase 9: The Omega Point (As Far As We Can Think Of)

Focus: The unification of all existence, godhood, and reset.

    The Ultimate Observer: The boundary of philosophy and hard sci-fi. The civilization merges into a single, pan-cosmic consciousness that remembers everything that ever happened and computes everything that ever could.

    The Cycle Reset: The civilization initiates a new "Big Bang" with custom-tailored physical laws, spawning a brand new universe—and kicking off Phase 1 all over again for a new lineage of life.
	
	Example of alien/glitch phase:
	
	When designing alien civilizations for a game, moving past the "humans with forehead prosthetics" trope opens up massive potential. Xenobiology, evolutionary pressures, and differing planetary environments entirely reshape what a species looks like, how they think, and how their technological phases unfold.Part 1: Alien Species & Biological Foundations (The "Who")An alien species' physical form dictates its psychology, architecture, and technology. What seems "normal" to humans might be utterly alien to them.The Symbiont / Hive Collective: Instead of individual intellects, the "species" consists of micro-organisms, insectoids, or neural-net fungi that function as a single hive mind, or separate entities linked by constant biological telemetry.Game Impact: No concept of individual property, crime, or political elections. Decisions happen via pheromonal consensus or instantaneous hive-wide alignment.Silicon-Based Lithivores: Lifeforms built on a silicon lattice rather than carbon, perhaps evolving near volcanic vents or high-radiation worlds. They might look like crystalline structures, animated rock, or metallic organisms.Game Impact: They don’t eat organic food; they "graze" on mineral deposits or pure metals. Their computers and bodies are made of the same materials, blurring the line between biology and machine from the very beginning.Aquatic / Subsurface Abyssal: Intelligent life evolving under the ice of a Europa-like moon or deep ocean world.Game Impact: They have no natural access to fire, metallurgy, or combustion engines. Their "Industrial Revolution" would be entirely based on hydro-mechanics, acoustics, sonics, and bio-engineering (growing tools and structures out of coral, bone, and kelp rather than smelting iron).Avian / Low-Gravity Gliders: Entities native to gas giant upper atmospheres or low-gravity moons with massive wingspans and hollow bones.Game Impact: Highly ephemeral, vertical culture. They have no concept of "grounded" borders or land ownership. Architecture consists of floating nests or sky-tethers, and their history views the solid surface of planets as a terrifying, high-gravity abyss.Radical Radivores (Radiation-Eaters): Species thriving on high-radiation worlds, utilizing melanin-like pigments that feed directly on gamma or X-rays.Game Impact: Nuclear material isn't a weapon or a dangerous waste product to them—it's high-calorie cuisine or a cozy habitat. Their electronics might be entirely radiation-hardened biological tissue.Part 2: Divergent Technological Paths (The "How They Build")Even if an alien species reaches space, how they get there can completely bypass human milestones. Technology branches based on planetary constraints:The Biotech Path (No Silicon): What happens if a planet lacks easily accessible copper, iron, or silicon, but is bursting with rich genetic material?The Result: They grow their technology. Instead of factories, they have organ-forges. Their computers are neural tissues grown in vats, their starships are massive, living space-whales coated in secreted armor, and their weapons are engineered pathogens or hyper-dense bone-darts.The Acoustics/Sonic Path: Developed by blind subterranean or aquatic species.The Result: Their entire industrial base relies on resonant frequencies, massive sonic hammers, and vibration manipulation. They "see" and build with sound, shaping materials by singing to them at specific atomic frequencies rather than cutting or welding.The Megalithic / Kinetic Path: For heavy-gravity worlds where flying or rocketry is nearly impossible due to a crushing atmosphere and steep escape velocity.The Result: To reach space, they must skip traditional rocketry entirely and focus early on massive mass drivers, planetary-scale space elevators, tension towers, and colossal kinetic rail networks that fling cargo into orbit.Part 3: Alien Phases of Civilization (Xenosociology)When mapping these species across a grand timeline, their societal phases might warp standard human expectations:Phase A: The Pre-Industrial PivotHuman Path: Fire $\rightarrow$ Bronze/Iron $\rightarrow$ Steam $\rightarrow$ Fossil Fuels.Alien Alternatives:The Symbiotic Domestication: Using specialized local fauna as living batteries, heaters, and tools before ever discovering electricity.The Geothermal/Tidal Tap: Skipping combustion entirely because their planet's violent crustal activity makes geothermal venting the easiest early energy source.Phase B: The Planetary Integration (The Great Filter)Human Path: Fragmented nation-states, global trade, internet, digital networks, and near-miss nuclear self-destruction.Alien Alternatives:The Hive Synchronization: If the species is telepathic or gestalt, they never had "wars" between nations because individuality didn't exist. Their planetary integration phase was a peaceful, biological merging of awareness.The Caste-Locked Equilibrium: A species divided by strict biological castes (e.g., worker, thinker, soldier bugs) that plateaued for millions of years in a rigid, caste-enforced agrarian or feudal state because social mobility was biologically impossible.Phase C: The Cosmic Expansion (Post-Planetary)Human Path: Satellites $\rightarrow$ Moon landings $\rightarrow$ Mars rovers $\rightarrow$ Interstellar probes.Alien Alternatives:Nomadic Seeders: A species whose home planet is unstable (frequently battered by asteroid impacts or stellar flares). They evolve a culture entirely centered on "leaving before home breaks," making generational colony ships or spore-like vacuum-viable pods normal long before they invent the computer.Virtual Maturation: A civilization that invents mind-uploading and virtual reality before rocketry. They realize physical space is cold, inefficient, and dangerous, so 99% of their population chooses to live inside a simulated Dyson sphere or computronium matrix, sending out automated robot probes to passively mine the galaxy while they experience infinite simulated paradises.
	
	Important is that phases should not be predicatble but coherent. Like an aquatic life that becomes intelligent could have high technologie but never reaches space exploration unless another civ show them... 