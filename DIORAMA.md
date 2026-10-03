# Eternal System — Procedural Planet Diorama Engine

## Context

Eternal System is a simulation/god game where AI-controlled gods compete to influence and develop simulated worlds.

The game uses a **close-up planetary diorama** as one of its primary visual representations of a planet.

The goal is NOT to create a static decorative planet.

The goal is to create a **living, procedural planetary diorama engine** where the visible environment is generated from the underlying simulation state.

The player should be able to look at a planet and immediately understand:

* What kind of planet this is
* Whether it has life
* How developed its civilizations are
* What its climate is like
* Whether it is peaceful or hostile
* Whether it is technologically advanced
* Whether civilization is damaging the environment
* Whether the planet is undergoing catastrophic events
* How the planet has changed over time

The diorama should feel like a tiny living world.

Think:

* miniature planet
* strategy-game diorama
* procedural ecosystem
* living simulation
* pixel-art / stylized game aesthetic
* readable from a relatively small viewport
* visually dense without becoming visually noisy

---

# 1. Core Design Philosophy

The diorama must be:

### Procedural

Do not rely on manually authored maps for individual planets.

A planet's visual appearance should be generated from simulation parameters.

### Reactive

Changes in the simulation should visibly affect the diorama.

For example:

Population increases:

→ settlements grow
→ roads appear
→ lights increase
→ agriculture expands
→ pollution may increase
→ forests may be removed

Technology increases:

→ primitive villages become towns
→ towns become cities
→ infrastructure becomes more sophisticated
→ energy infrastructure appears
→ transportation networks develop

Climate worsens:

→ vegetation changes
→ clouds change
→ storms become more frequent
→ oceans change
→ deserts expand
→ civilization adapts or suffers

### Alive

The world should never look frozen.

Even when nothing major happens, the diorama should have subtle movement:

* clouds moving
* ocean movement
* vegetation movement
* smoke
* atmospheric particles
* weather
* lightning
* animals
* vehicles
* city lights
* volcanic activity
* waves
* tiny environmental animations

The player should be able to stare at the planet and think:

> "Something is actually happening down there."

---

# 2. Planet Diorama Composition

The planet should be represented as a **small 3D or pseudo-3D spherical/curved world viewed from an elevated close-up camera**.

The camera should show a limited region of the planet rather than the entire globe.

This creates the feeling that the player is looking down at a tiny world.

The visible region should contain a procedural mixture of:

* terrain
* oceans
* coastlines
* rivers
* lakes
* vegetation
* settlements
* infrastructure
* atmospheric effects
* weather
* geological activity

The visible region should change as the planet rotates or as the camera moves.

---

# 3. Planet Types

The engine should support fundamentally different planet environments.

Examples:

### Terrestrial

Earth-like:

* oceans
* continents
* forests
* grasslands
* deserts
* mountains
* atmosphere
* clouds

### Ocean World

Mostly water:

* huge oceans
* islands
* deep ocean
* storms
* marine ecosystems
* underwater civilization possibilities

### Desert World

* minimal vegetation
* sand
* rocky terrain
* dust storms
* underground settlements
* sparse water

### Frozen World

* ice
* snow
* frozen oceans
* glaciers
* blizzards
* limited vegetation

### Volcanic World

* lava
* volcanoes
* ash
* sulfurous atmosphere
* volcanic storms
* extreme temperatures

### Toxic World

* strange atmosphere
* toxic clouds
* acid rain
* poisoned oceans
* mutated vegetation
* industrial contamination

### Artificial / Highly Developed World

Potential late-game planet:

* enormous cities
* artificial structures
* energy grids
* megastructures
* orbital infrastructure
* artificial atmosphere modifications

The system should be extensible so new planet types can be added without rewriting the renderer.

---

# 4. Terrain Generation

Terrain should be procedurally generated from a planet seed.

Use layered procedural noise or an equivalent deterministic system.

Terrain parameters should include:

* elevation
* temperature
* humidity
* rainfall
* latitude
* geological activity
* water level
* erosion
* biome influence

Generate:

* mountains
* hills
* plains
* valleys
* plateaus
* deserts
* beaches
* cliffs
* rivers
* lakes
* coastlines

Terrain generation must be deterministic.

The same:

`planetSeed + simulationState`

should produce the same terrain.

---

# 5. Biome System

Create a biome classification system based on environmental variables.

Example:

```text
Temperature
Humidity
Elevation
Rainfall
Water availability
Latitude
```

Possible biomes:

* ocean
* deep ocean
* shallow ocean
* beach
* tropical forest
* temperate forest
* boreal forest
* grassland
* savanna
* desert
* tundra
* ice
* volcanic
* swamp
* mountain
* wasteland
* polluted wasteland

Each biome should have its own visual characteristics.

For example:

FOREST:

* trees
* bushes
* darker terrain
* wildlife
* occasional clearings

DESERT:

* sand
* rocks
* sparse vegetation
* dust particles
* dunes

TUNDRA:

* snow
* sparse vegetation
* frozen water

VOLCANIC:

* dark rock
* lava
* smoke
* ash
* glowing areas

---

# 6. Vegetation System

Vegetation must be procedural.

Do NOT simply scatter random trees.

Vegetation density should depend on:

* biome
* rainfall
* temperature
* soil fertility
* pollution
* civilization
* technology
* climate change

Vegetation should exist in layers:

```text
Grass
Bushes
Trees
Large forests
Special vegetation
```

Vegetation should also be dynamic.

Examples:

Deforestation:

```text
forest → cleared land → agriculture → settlement
```

Climate change:

```text
forest → dry forest → grassland → desert
```

Pollution:

```text
healthy vegetation → damaged vegetation → dead vegetation
```

Reforestation:

```text
dead land → grass → bushes → young forest → mature forest
```

---

# 7. Ocean System

Oceans must not be static blue surfaces.

Support:

* shallow water
* deep water
* abyssal/deep ocean
* waves
* currents
* reflections
* underwater terrain
* marine vegetation
* marine life
* pollution
* oil/chemical contamination
* storms
* ice

Ocean depth should affect color and visual appearance.

For example:

```text
coast
↓
shallow ocean
↓
deep ocean
↓
abyss
```

The ocean should have subtle animation.

---

# 8. Deep Ocean

Deep ocean should be represented as an actual environmental layer.

Potential visuals:

* darker water
* trenches
* underwater volcanoes
* glowing organisms
* submarine infrastructure
* underwater settlements
* mining operations
* deep-sea pollution

Advanced civilizations should potentially be able to develop underwater infrastructure.

---

# 9. Atmosphere System

Atmosphere is optional.

A planet may have:

```text
No atmosphere
Thin atmosphere
Normal atmosphere
Dense atmosphere
Toxic atmosphere
Extreme atmosphere
Artificial atmosphere
```

Atmosphere affects rendering.

Possible effects:

* atmospheric haze
* color tint
* cloud formation
* storms
* visibility
* lighting
* sky color
* atmospheric particles

No-atmosphere planets should visually feel completely different.

---

# 10. Cloud System

Clouds must be procedural and animated.

Cloud generation should depend on:

* humidity
* temperature
* atmosphere
* ocean coverage
* weather
* planetary rotation

Support:

* thin clouds
* dense clouds
* storm clouds
* hurricane systems
* localized cloud formations
* atmospheric bands

Clouds should move over time.

Storm clouds should visibly grow and move.

---

# 11. Weather System

Create a procedural weather layer.

Weather types:

* clear
* cloudy
* rain
* heavy rain
* snow
* blizzard
* fog
* thunderstorm
* hurricane
* tornado
* dust storm
* ash storm
* acid rain
* meteorological anomalies

Weather should be driven by the simulation rather than randomly changing every few seconds.

For example:

```text
High ocean temperature
+
high humidity
+
strong atmospheric instability
=
storm formation
```

Weather systems should move across the terrain.

---

# 12. HARSH WEATHER

Extreme weather must have visual consequences.

Examples:

### Hurricane

* giant rotating cloud system
* heavy rain
* wind
* ocean waves
* lightning
* flooding
* damaged settlements

### Tornado

* rotating funnel
* dust/debris
* localized destruction

### Blizzard

* snow
* reduced visibility
* frozen terrain
* buried structures

### Dust Storm

* orange/brown atmospheric haze
* reduced visibility
* vegetation stress
* settlement disruption

### Volcanic Ash Storm

* dark sky
* ash particles
* red/orange volcanic glow
* reduced vegetation

### Acid Rain

* unusual cloud color
* visible rainfall
* vegetation damage
* contaminated water

Extreme weather should potentially affect civilization and ecosystems.

---

# 13. Volcano System

Volcanoes should be procedural geological objects.

Support:

* dormant volcanoes
* active volcanoes
* erupting volcanoes
* volcanic fields
* underwater volcanoes

Visual effects:

* smoke
* ash
* lava
* glowing lava channels
* explosions
* atmospheric effects

Eruptions should modify the world.

For example:

```text
eruption
→ lava
→ terrain modification
→ ash
→ vegetation destruction
→ temporary climate effects
→ settlement damage
```

---

# 14. Civilization / Settlement System

Civilization must be clearly visible from the diorama.

Settlement size should correlate with simulation population.

Possible levels:

```text
Nomadic
Camp
Village
Town
City
Large City
Metropolis
Megacity
Planetary Civilization
```

Settlements should be procedural.

Do not place buildings randomly.

Buildings should form believable patterns.

Examples:

Village:

* small houses
* dirt paths
* farms

Town:

* houses
* roads
* small commercial buildings

City:

* dense buildings
* roads
* industrial zones
* utilities

Advanced city:

* skyscrapers
* transit
* energy infrastructure
* dense lighting
* advanced architecture

---

# 15. Civilization Expansion

Settlements should grow over time.

Example:

```text
Village
 ↓
Town
 ↓
City
 ↓
Metropolis
```

Expansion should visibly consume surrounding terrain.

For example:

```text
forest
→ logging
→ farmland
→ suburbs
→ city
```

This should create the feeling of civilization physically changing the planet.

---

# 16. Agriculture

Agriculture should be visible.

Generate:

* farms
* crop fields
* irrigation
* livestock areas
* plantations

Agriculture should respond to:

* climate
* population
* technology
* water availability

Large civilizations should require larger agricultural regions unless they have advanced technologies.

---

# 17. Infrastructure

Infrastructure should communicate technological development.

Primitive:

* dirt paths
* simple bridges
* basic settlements

Industrial:

* roads
* railways
* factories
* power plants
* mines

Modern:

* highways
* airports
* dense power grids
* large industrial areas

Advanced:

* maglev
* futuristic cities
* massive energy infrastructure
* automated systems
* orbital elevators
* megastructures

Infrastructure should connect settlements rather than appear as isolated decoration.

---

# 18. Technology Visualization

Technology should be visually obvious.

Create a technology progression system.

Example:

```text
Stone Age
Bronze Age
Iron Age
Industrial
Modern
Advanced
Futuristic
Post-Planetary
```

Each technology tier unlocks visual assets.

Technology should influence:

* architecture
* transportation
* energy
* agriculture
* industry
* communication
* pollution
* environmental control

A technologically advanced planet should look fundamentally different from a primitive planet.

---

# 19. Energy Systems

Visible energy infrastructure:

Primitive:

* fires
* biomass

Industrial:

* coal plants
* factories
* smokestacks

Modern:

* nuclear plants
* solar farms
* wind turbines
* power grids

Advanced:

* fusion
* massive energy collectors
* futuristic reactors
* orbital energy systems

Energy production should correspond to civilization data.

---

# 20. Pollution System

Pollution should be one of the major visual feedback systems.

Pollution types:

* air pollution
* water pollution
* industrial pollution
* chemical contamination
* radioactive contamination
* light pollution

Pollution should visibly affect the environment.

Examples:

High industrial pollution:

* smog
* brown/gray atmospheric haze
* dirty water
* dead vegetation
* industrial smoke

Water pollution:

* discolored coastal water
* dead zones
* floating contamination

Radioactive pollution:

* glowing contaminated areas
* dead vegetation
* exclusion zones

Pollution should NOT simply be a visual overlay.

It should be tied to actual simulation values.

---

# 21. Environmental Recovery

The system must also represent environmental improvement.

If pollution decreases:

```text
polluted water
→ recovering water
→ healthy water
```

and:

```text
dead vegetation
→ grass
→ bushes
→ forest
```

This makes player actions visible.

---

# 22. Wildlife

Wildlife should provide life and scale.

Animals should be procedurally spawned according to biome.

Examples:

Forest:

* birds
* deer
* insects

Ocean:

* fish
* whales
* schools

Desert:

* small animals
* reptiles

Advanced civilization:

* domesticated animals
* artificial wildlife
* drones potentially replacing biological animals

Animals should be subtle.

They should not overwhelm the diorama.

---

# 23. Day / Night Cycle

The diorama should support planetary time.

Day:

* sunlight
* active wildlife
* visible cities

Night:

* city lights
* reduced activity
* darker terrain
* atmospheric lighting

Civilization should become especially visible at night.

A primitive planet might have almost no lights.

A modern planet might have enormous illuminated regions.

---

# 24. Civilization Activity

Make civilization feel active.

Examples:

* vehicles moving along roads
* trains
* ships
* aircraft
* construction
* smoke
* lights turning on/off
* industrial activity
* farming
* mining
* settlement expansion

These can be simplified animations.

The goal is **perceived life**, not simulation of every individual.

---

# 25. Simulation → Visual Mapping

Create a centralized system that converts simulation values into visual parameters.

Example:

```text
PlanetState
    ↓
DioramaState
    ↓
Terrain
Biome
Vegetation
Ocean
Atmosphere
Weather
Settlements
Infrastructure
Pollution
Technology
Effects
    ↓
Renderer
```

Do NOT let individual rendering systems directly inspect arbitrary simulation variables.

Create a clean data-driven interface.

Example concept:

```javascript
DioramaState {
    terrain
    climate
    atmosphere
    ocean
    vegetation
    civilization
    technology
    pollution
    weather
    geology
}
```

This should make the engine easy to extend.

---

# 26. Deterministic Procedural Generation

Everything procedural should use deterministic seeds.

Example:

```text
planetSeed
regionSeed
settlementSeed
vegetationSeed
weatherSeed
```

Changing simulation values should modify the appropriate systems without completely regenerating unrelated geometry.

For example:

Increasing population should not randomly move an entire mountain range.

---

# 27. Performance

This is extremely important.

The diorama is a visual representation, not a full planet simulator.

Use:

* instancing
* object pooling
* level of detail
* sprite batching
* texture atlases
* procedural placement
* lightweight particles
* culling
* cached procedural generation

Do not create thousands of independent expensive objects if the same effect can be achieved with:

* instanced sprites
* particles
* shaders
* batched meshes

The diorama should remain performant while the main simulation continues running.

---

# 28. Pixel Art Direction

The original visual direction of Eternal System is intended to be **pixel-art oriented**.

The engine should therefore support a stylized pixel-art presentation.

Important:

Do NOT simply render a normal 3D world and put a pixelation filter over it.

Instead, the visual language should intentionally resemble a high-quality pixel-art strategy game.

Use:

* limited visual complexity
* readable silhouettes
* strong shapes
* sprite-based environmental assets
* pixel-friendly particles
* controlled color palettes
* subtle animation
* exaggerated visual readability

The system should still work with higher-resolution assets later.

---

# 29. Diorama Camera

The camera should provide:

* close-up planetary perspective
* slight tilt
* readable terrain
* visible curvature
* controlled zoom
* optional rotation
* smooth transitions

The player should feel like they are looking at a miniature world.

Potential camera states:

```text
Overview
Region
Settlement
Event
Disaster
```

The camera should be able to smoothly zoom toward important events.

Example:

Volcano erupts:

```text
normal camera
→ subtle notification
→ camera focuses toward volcano
→ eruption animation
→ returns to normal
```

---

# 30. Important Events

The diorama should visually react to major simulation events.

Examples:

* civilization discovered
* civilization collapsed
* major war
* industrial revolution
* technological breakthrough
* climate catastrophe
* asteroid impact
* volcanic eruption
* nuclear event
* mass extinction
* terraforming
* planetary restoration

These should produce temporary or permanent visual changes.

---

# 31. Asteroid / Catastrophic Events

Support large-scale planetary events.

Examples:

### Meteor Impact

* impact crater
* explosion
* dust cloud
* fire
* environmental damage

### Nuclear War

* mushroom clouds
* burning cities
* radioactive zones
* infrastructure destruction

### Mass Extinction

* reduced wildlife
* dying vegetation
* environmental changes

### Terraforming

Gradual transformation:

```text
barren planet
→ atmosphere
→ clouds
→ water
→ vegetation
→ civilization
```

---

# 32. Procedural Event System

Create an event interface.

Example:

```javascript
PlanetEvent {
    type
    location
    intensity
    duration
    startTime
}
```

Examples:

```text
VOLCANIC_ERUPTION
STORM
TORNADO
METEOR_IMPACT
CITY_EXPANSION
FOREST_FIRE
FLOOD
DROUGHT
POLLUTION_SPIKE
TECHNOLOGY_BREAKTHROUGH
```

The diorama engine should consume these events and create visual effects.

---

# 33. Visual Priority

Because the diorama is small, prioritize visual readability.

Priority:

1. Terrain
2. Ocean / water
3. Major settlements
4. Vegetation
5. Weather
6. Pollution
7. Infrastructure
8. Geological events
9. Wildlife
10. Tiny decorative details

Do not sacrifice readability for detail.

---

# 34. The "Alive" Test

The engine should pass this test:

If the player watches the same diorama for 30 seconds without interacting:

They should see some combination of:

* clouds moving
* waves moving
* weather evolving
* vegetation moving
* animals moving
* vehicles moving
* city lights
* smoke
* particles
* atmospheric effects

If the planet feels like a static screenshot, the system has failed.

---

# 35. The "Evolution" Test

The engine should also pass this test:

Start with:

```text
Primitive civilization
low technology
low population
healthy environment
```

Then simulate thousands/millions of years.

The visual result should naturally evolve:

```text
primitive settlement
→ villages
→ towns
→ cities
→ industrial civilization
→ technological civilization
```

Meanwhile:

```text
forests
→ agriculture
→ industry
→ pollution
```

or alternatively:

```text
industry
→ environmental awareness
→ clean technology
→ reforestation
→ environmental recovery
```

The player should be able to visually understand this history.

---

# 36. Architecture

Build the system as independent modules.

Suggested architecture:

```text
DioramaEngine
│
├── PlanetGenerator
│
├── TerrainSystem
│
├── BiomeSystem
│
├── OceanSystem
│
├── AtmosphereSystem
│
├── CloudSystem
│
├── WeatherSystem
│
├── VegetationSystem
│
├── WildlifeSystem
│
├── CivilizationSystem
│
├── SettlementSystem
│
├── InfrastructureSystem
│
├── TechnologySystem
│
├── PollutionSystem
│
├── GeologicalSystem
│
├── EventSystem
│
├── DayNightSystem
│
├── ParticleSystem
│
├── CameraSystem
│
└── DioramaRenderer
```

Keep these systems modular.

A planet without atmosphere should simply disable the atmosphere systems.

An oceanless planet should not instantiate ocean systems unnecessarily.

---

# 37. Data Driven Design

Avoid hardcoding visual rules everywhere.

Use configuration/data where possible.

Example:

```javascript
BiomeDefinition {
    name
    temperatureRange
    humidityRange
    vegetationDensity
    treeTypes
    wildlifeTypes
    terrainPalette
}
```

Technology:

```javascript
TechnologyTier {
    name
    settlementStyle
    infrastructure
    energySources
    pollutionMultiplier
}
```

Weather:

```javascript
WeatherDefinition {
    type
    conditions
    visualEffects
    environmentalEffects
}
```

This will allow new content to be added without rewriting the engine.

---

# 38. Important Principle

The diorama should **not fake the simulation**.

The simulation is the source of truth.

The diorama is a visual interpretation of the simulation.

For example:

If the simulation says:

```text
population = 2,000,000
technology = industrial
pollution = high
forestCoverage = 18%
```

the diorama should naturally produce something resembling:

* large urban settlement
* industrial infrastructure
* smoke
* reduced forests
* polluted waterways
* heavy transportation

If:

```text
population = 400
technology = primitive
pollution = almost zero
forestCoverage = 82%
```

the world should visibly look like:

* mostly wilderness
* tiny settlement
* forests
* primitive paths
* minimal infrastructure

---

# 39. Implementation Strategy

Do NOT attempt to implement every feature simultaneously.

Build vertically.

### Phase 1 — Basic Planet

Implement:

* terrain
* water
* camera
* procedural seed
* basic biomes

### Phase 2 — Life

Add:

* vegetation
* ocean animation
* atmosphere
* clouds
* day/night

### Phase 3 — Civilization

Add:

* settlements
* roads
* agriculture
* infrastructure
* technology tiers

### Phase 4 — Environmental Systems

Add:

* pollution
* climate effects
* environmental recovery
* ocean pollution

### Phase 5 — Weather

Add:

* rain
* snow
* storms
* extreme weather
* cloud systems

### Phase 6 — Geological Systems

Add:

* volcanoes
* lava
* earthquakes
* underwater volcanoes

### Phase 7 — Advanced Civilization

Add:

* advanced cities
* futuristic infrastructure
* megastructures
* advanced energy

### Phase 8 — Events

Add:

* meteor impacts
* disasters
* wars
* extinction
* terraforming

---

# 40. Development Requirement

Before implementing large systems, inspect the existing Eternal System codebase.

Determine:

* current engine/framework
* rendering technology
* existing planet data structures
* simulation tick system
* available assets
* current UI architecture
* existing procedural generation
* performance constraints

Do not rewrite unrelated systems.

Integrate the diorama engine into the existing architecture.

Prefer extending existing systems over creating duplicate systems.

---

# 41. Debug Mode

Create a debug visualization mode.

Allow toggling overlays:

```text
[Terrain]
[Elevation]
[Temperature]
[Humidity]
[Biome]
[Water]
[Vegetation]
[Population]
[Technology]
[Pollution]
[Weather]
[Infrastructure]
[Geology]
```

This is extremely important for development.

The developer should be able to see WHY the diorama generated what it generated.

---

# 42. Final Goal

The final result should feel like:

> A tiny living planet that the player can observe and manipulate.

The player should be able to look at a world and immediately notice:

**"This planet is alive."**

Then, after playing for a while:

**"I caused that."**

And eventually:

**"Holy shit, this world has a history."**

That emotional connection is more important than raw graphical complexity.

Build the system so the procedural simulation itself creates the visual storytelling.
