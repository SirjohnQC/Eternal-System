/**
 * SpeciesNaming — names a species from what it actually became.
 *
 * Speciation used to name a child by sticking a prefix on the PARENT'S NAME
 * string (`prefix + parent.name`), which meant every descendant of the starting
 * organism stayed a "Primordial Microbe" forever: an intelligent, walking,
 * carnivorous animal would be called "ArchiPrimordial Microbe". It also produced
 * no space, so the prefix ran into the noun.
 *
 * Names are now derived from the genome, so they describe the creature — a
 * swimming filter-feeder reads differently from a flying predator, and the name
 * changes as a lineage genuinely diverges.
 */

import type { SeedRNG } from '../utils/SeedRNG';
import type { SpeciesGenome } from './SpeciesGenome';

// ─── Word pools ───────────────────────────────────────────────────────────────

/** The noun is driven by how the animal moves and where it lives. */
const ROOTS: Record<string, string[]> = {
  stationary_ocean:  ['Polyp', 'Frond', 'Bloom', 'Anemone', 'Coral'],
  stationary_land:   ['Spore-Tree', 'Stalk', 'Thicket', 'Creeper', 'Fungus'],
  swimming_ocean:    ['Ray', 'Finling', 'Eel', 'Drifter', 'Lurker', 'Serpent'],
  swimming_deep:     ['Abyssal', 'Anglerform', 'Trench-Eel', 'Gulper'],
  crawling_land:     ['Crawler', 'Segmentid', 'Vermid', 'Scuttler', 'Burrower'],
  crawling_coastal:  ['Tidecrawler', 'Shellback', 'Mudskimmer'],
  walking_land:      ['Strider', 'Ambler', 'Pede', 'Runner', 'Treader'],
  flying_aerial:     ['Glider', 'Soarer', 'Skywing', 'Kite', 'Windrider'],
  flying_land:       ['Flitter', 'Hoverling', 'Dartwing'],
  fallback:          ['Organism', 'Form', 'Dweller'],
};

/** The epithet is driven by diet, aggression and metabolism. */
const PREDATOR   = ['Fanged', 'Ripping', 'Hunting', 'Taloned', 'Barbed'];
const GRAZER     = ['Grazing', 'Browsing', 'Placid', 'Broadmouth'];
const PRODUCER   = ['Sunlit', 'Verdant', 'Bloomskin', 'Photic'];
const SCAVENGER  = ['Carrion', 'Rooting', 'Sifting'];
const PARASITE   = ['Clinging', 'Boring', 'Leeching'];
const CHEMO      = ['Vent-Born', 'Sulphur', 'Deepfed'];

/** Size adjectives, used sparingly so names stay short. */
const SIZE_WORD: Record<string, string | null> = {
  microscopic: 'Micro', tiny: 'Lesser', small: null,
  medium: null, large: 'Great', massive: 'Titan',
};

/** Genus syllables, for the occasional binomial-feeling name. */
const SYL_A = ['Ke', 'Tha', 'Vor', 'Ny', 'Sel', 'Mor', 'Ith', 'Za', 'Cor', 'Ael'];
const SYL_B = ['thyx', 'ran', 'vex', 'dros', 'mira', 'nak', 'sul', 'phen', 'tor', 'lys'];

function rootKey(g: SpeciesGenome): string {
  const loc = g.dna.locomotion;
  const env = g.dna.environment;
  if (loc === 'stationary') return env === 'land' || env === 'aerial' ? 'stationary_land' : 'stationary_ocean';
  if (loc === 'swimming')   return env === 'deep_sea' ? 'swimming_deep' : 'swimming_ocean';
  if (loc === 'crawling')   return env === 'coastal' ? 'crawling_coastal' : 'crawling_land';
  if (loc === 'walking')    return 'walking_land';
  if (loc === 'flying')     return env === 'aerial' ? 'flying_aerial' : 'flying_land';
  return 'fallback';
}

function epithetPool(g: SpeciesGenome): string[] {
  if (g.dna.metabolism === 'parasitic')      return PARASITE;
  if (g.dna.metabolism === 'photosynthetic') return PRODUCER;
  if (g.dna.metabolism === 'chemosynthetic') return CHEMO;
  switch (g.dna.diet) {
    case 'carnivore':   return g.dna.aggression >= 5 ? PREDATOR : SCAVENGER;
    case 'herbivore':   return GRAZER;
    case 'producer':    return PRODUCER;
    case 'decomposer':  return SCAVENGER;
    default:            return g.dna.aggression >= 6 ? PREDATOR : GRAZER;
  }
}

/**
 * Build a name for a genome.
 *
 * Intelligent lineages get a genus-style binomial, which reads as a species that
 * someone might one day name itself.
 */
export function nameForGenome(g: SpeciesGenome, rng: SeedRNG): string {
  const roots = ROOTS[rootKey(g)] ?? ROOTS['fallback'];
  const root = roots[rng.nextInt(0, roots.length - 1)];

  // Sapient lineages earn a genus name. When they have one, the descriptive
  // words are trimmed back — "Vordros Great Broadmouth Bloom" is a mouthful,
  // and long names wrap badly in the tile panel and Codex.
  const sapient = g.dna.intelligence >= 7;
  const parts: string[] = [];

  const size = SIZE_WORD[g.physicalTraits.size];
  if (size && rng.chance(sapient ? 0.25 : 0.6)) parts.push(size);

  const pool = epithetPool(g);
  if (rng.chance(sapient ? 0.4 : 0.75)) parts.push(pool[rng.nextInt(0, pool.length - 1)]);

  parts.push(root);

  if (sapient) {
    const genus = SYL_A[rng.nextInt(0, SYL_A.length - 1)] + SYL_B[rng.nextInt(0, SYL_B.length - 1)];
    return `${genus} ${parts.join(' ')}`;
  }

  return parts.join(' ');
}
