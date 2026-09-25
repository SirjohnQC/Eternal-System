// src/simulation/SpeciesGenome.ts

export type Metabolism   = 'photosynthetic' | 'chemosynthetic' | 'heterotrophic' | 'parasitic';
export type Locomotion   = 'stationary' | 'swimming' | 'crawling' | 'walking' | 'flying';
export type Environment  = 'ocean' | 'coastal' | 'land' | 'aerial' | 'deep_sea';
export type Reproduction = 'asexual' | 'sexual' | 'spore';
export type Diet         = 'producer' | 'herbivore' | 'omnivore' | 'carnivore' | 'decomposer';
export type Respiration  = 'anaerobic' | 'aerobic' | 'mixed';
export type SpeciesSize  = 'microscopic' | 'tiny' | 'small' | 'medium' | 'large' | 'massive';

export interface SpeciesGenome {
  id:          string;
  name:        string;
  originTick:  number;
  population:  number;        // 0–1 relative dominance
  isExtinct:   boolean;
  ancestorId:  string | null; // speciation tree

  dna: {
    metabolism:   Metabolism;
    locomotion:   Locomotion;
    environment:  Environment;
    reproduction: Reproduction;
    diet:         Diet;
    respiration:  Respiration;
    intelligence: number;    // 0–10
    social:       number;    // 0–10
    aggression:   number;    // 0–10
    adaptability: number;    // 0–10
  };

  physicalTraits: {
    size:          SpeciesSize;
    bodyStructure: string;
    mobilityType:  string;
    sensorySystem: string;
  };

  habitat: {
    biome:            string;
    temperatureRange: string;
  };

  evolutionaryPotential: {
    landTransition:     number;  // 0–1
    intelligenceGrowth: number;  // 0–1
    toolUse:            number;  // 0–1
  };
}

export interface PlanetBiosphere {
  oxygenLevel:        number;  // 0–1 (photosynthesis drives this up)
  biosphereDensity:   number;  // 0–1 (total life coverage)
  oceanLife:          number;  // 0–1
  landLife:           number;  // 0–1
  biodiversity:       number;  // 0–10 (count of active species)
  extinctionPressure: number;  // 0–1 (asteroid, climate, predation)
}

export const DEFAULT_BIOSPHERE: PlanetBiosphere = {
  oxygenLevel:        0.01,
  biosphereDensity:   0.05,
  oceanLife:          0.10,
  landLife:           0.00,
  biodiversity:       1,
  extinctionPressure: 0.10,
};

export function createPrimordialSpecies(tick: number): SpeciesGenome {
  return {
    id:         `species_0_${tick}`,
    name:       'Primordial Microbe',
    originTick:  tick,
    population:  1.0,
    isExtinct:   false,
    ancestorId:  null,
    dna: {
      metabolism:   'chemosynthetic',
      locomotion:   'stationary',
      environment:  'ocean',
      reproduction: 'asexual',
      diet:         'producer',
      respiration:  'anaerobic',
      intelligence:  0,
      social:        0,
      aggression:    0,
      adaptability:  2,
    },
    physicalTraits: {
      size:          'microscopic',
      bodyStructure: 'single-celled',
      mobilityType:  'flagella',
      sensorySystem: 'chemoreception',
    },
    habitat: {
      biome:            'deep_ocean_vent',
      temperatureRange: 'extreme_heat',
    },
    evolutionaryPotential: {
      landTransition:     0.0,
      intelligenceGrowth: 0.0,
      toolUse:            0.0,
    },
  };
}

/**
 * May this species be DRAWN standing on a water cell?
 *
 * The diorama's top face sinks its outer hemisphere (`rimFalloff`) without
 * changing biome or life density, so a land animal placed off the raw grid can
 * end up standing on open sea and the whole rim rings with waders. The renderer
 * therefore gates creatures on water.
 *
 * That gate used to ask about LOCOMOTION — swimming or flying only — which
 * silently hid every aquatic organism that neither swims nor flies: kelp and
 * reef (`stationary`) and sea-floor crawlers. Measured at 12-22% of occupied
 * cells drawn as empty ocean.
 *
 * Environment is the right question, and it is now trustworthy: `isCoherent`
 * rejects land-swimmers and ocean-fliers, so a genome's habitat and its means
 * of moving can no longer disagree. Fliers are allowed over water because they
 * cross it.
 */
export function inhabitsWater(g: SpeciesGenome): boolean {
  const env = g.dna.environment;
  return env === 'ocean' || env === 'deep_sea' || env === 'coastal'
      || g.dna.locomotion === 'flying';
}

/**
 * How deeply a species sits when it occupies a water cell, 0..1.
 *
 * 0 = drawn wholly above the surface (fliers crossing open water).
 * 1 = wholly submerged, no part breaking the surface.
 *
 * Drawing marine life standing proud on the water read as statues on plinths.
 * Habitat sets the baseline depth, then two adjustments: rooted organisms (kelp,
 * reef) stay under because they are anchored to the floor, and big bodies breach
 * — a massive animal shows its back the way a whale does.
 */
export function waterSubmersion(g: SpeciesGenome): number {
  if (g.dna.locomotion === 'flying') return 0;

  const env = g.dna.environment;
  let s = env === 'deep_sea' ? 1.0
        : env === 'ocean'    ? 0.85
        : env === 'coastal'  ? 0.55
        :                      0.85;   // land/aerial here would be incoherent

  if (g.dna.locomotion === 'stationary') s += 0.15;   // rooted to the floor

  const size = g.physicalTraits.size;
  if (size === 'massive') s -= 0.22;
  else if (size === 'large') s -= 0.12;

  return Math.max(0, Math.min(1, s));
}
