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
