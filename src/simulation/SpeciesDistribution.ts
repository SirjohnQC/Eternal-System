/**
 * SpeciesDistribution — decides which species actually lives where.
 *
 * `GridCell.dominantSpeciesId` was declared and initialised to null and then
 * never written by anything, so the simulation knew a planet's species list but
 * not where any of them lived. Nothing could render or inspect them.
 *
 * This assigns each populated cell a dominant species by scoring every living
 * species against the cell's biome, temperature and elevation, then weighting by
 * population. It is a pure function of the grid + species list, so it can be
 * re-run at any time and always produces the same answer.
 */

import type { PlanetGrid, GridCell, BiomeType } from './PlanetGrid';
import { GRID_SIZE, isWater } from './PlanetGrid';
import type { SpeciesGenome, Environment, SpeciesSize } from './SpeciesGenome';

/** Body-size ladder as a number, for "is this thing big?" tests. */
const SIZE_RANK: Record<SpeciesSize, number> = {
  microscopic: 0, tiny: 1, small: 2, medium: 3, large: 4, massive: 5,
};

/** How well an environment preference suits a biome. 0 = cannot live there. */
function environmentFit(env: Environment, biome: BiomeType): number {
  switch (env) {
    case 'deep_sea':
      return biome === 'deep_ocean' ? 1.0 : biome === 'ocean' ? 0.5 : 0;
    case 'ocean':
      return biome === 'ocean' ? 1.0 : biome === 'deep_ocean' ? 0.7
           : biome === 'shallow' ? 0.8 : 0;
    case 'coastal':
      return biome === 'shallow' ? 1.0 : biome === 'beach' ? 1.0
           : biome === 'ocean' ? 0.4 : biome === 'jungle' ? 0.3 : 0;
    case 'land':
      if (isWater(biome)) return 0;
      switch (biome) {
        case 'jungle': case 'forest': case 'grassland': return 1.0;
        case 'plains': case 'savanna':                  return 0.9;
        case 'beach':                                   return 0.6;
        case 'desert': case 'tundra':                   return 0.45;
        case 'snow':                                    return 0.3;
        case 'mountain':                                return 0.35;
        case 'volcanic':                                return 0.15;
        default:                                        return 0.5;
      }
    case 'aerial':
      // Fliers roost anywhere with something underneath, but favour open land.
      return isWater(biome) ? 0.35 : 0.8;
  }
}

/**
 * How well the REST of the genome suits this biome, beyond its broad environment.
 *
 * `environmentFit` only asks "ocean, coast, land or air?", which is far too
 * coarse: a massive walking carnivore and a tiny crawling producer both scored
 * identically on every land tile, so the map showed lineages scattered at random
 * rather than each in the country that suits it. Reading locomotion, diet, size,
 * metabolism and heat tolerance is what makes a grazing herd sit on savanna, a
 * shore-going reptile straddle beach and shallows, and a photosynthesiser cling
 * to wet, bright ground.
 *
 * Returns a multiplier, roughly 0.2–1.6. Never zero — `environmentFit` alone
 * decides whether a place is survivable at all.
 */
function archetypeFit(sp: SpeciesGenome, cell: GridCell): number {
  const b = cell.biome;
  const d = sp.dna;
  const si = SIZE_RANK[sp.physicalTraits.size] ?? 2;
  const water = isWater(b);
  let f = 1;

  // ── Locomotion: how it gets around decides what ground it can use ─────────
  switch (d.locomotion) {
    case 'swimming':
      f *= water ? 1.35 : 0.25;
      break;
    case 'walking':
      // Legs want firm, open ground. Dense jungle and broken mountain are hard
      // going, wetland and ice worse.
      f *= water ? 0.15
         : b === 'grassland' || b === 'plains' || b === 'savanna' ? 1.45
         : b === 'forest' ? 1.05
         : b === 'jungle' ? 0.7
         : b === 'mountain' ? 0.55
         : b === 'snow' ? 0.5
         : 0.9;
      break;
    case 'crawling':
      // The reptile pattern: at home on the shoreline and in the shallows both.
      f *= b === 'beach' || b === 'shallow' ? 1.5
         : b === 'jungle' || b === 'forest' ? 1.2
         : b === 'desert' ? 1.1
         : water ? 0.8
         : 1.0;
      break;
    case 'flying':
      // Fliers range widely but need somewhere to nest and updrafts to use.
      f *= b === 'mountain' ? 1.4
         : b === 'forest' || b === 'jungle' ? 1.2
         : water ? 0.55
         : 1.05;
      break;
    case 'stationary':
      // Rooted things need substrate and cannot hold on to bare rock or ice.
      // Woodland is where standing growth actually wins: open grass is the most
      // abundant land biome on most worlds, so without this a forest organism
      // simply inherits the grassland by weight of area.
      f *= b === 'mountain' || b === 'snow' || b === 'volcanic' ? 0.3
         : b === 'jungle' || b === 'forest' ? 1.5
         : 0.7 + cell.fertility * 0.9;
      break;
  }

  // ── Diet: what it eats decides where the eating is ────────────────────────
  switch (d.diet) {
    case 'producer':
      // Light and water. Deep ocean is dark; desert and ice are dry.
      f *= b === 'deep_ocean' ? 0.25
         : b === 'desert' || b === 'snow' ? 0.4
         : 0.55 + cell.moisture * 0.85;
      break;
    case 'herbivore':
      f *= 0.35 + cell.fertility * 1.35;
      break;
    case 'carnivore':
      // Predators go where prey concentrates — open country, not barrens.
      f *= b === 'savanna' || b === 'grassland' || b === 'plains' ? 1.4
         : b === 'desert' || b === 'snow' ? 0.5
         : 0.75 + cell.lifeDensity * 0.6;
      break;
    case 'omnivore':
      f *= 0.85 + cell.fertility * 0.5;
      break;
    case 'decomposer':
      f *= 0.7 + cell.lifeDensity * 0.7;
      break;
  }

  // ── Size: big bodies need room and a lot of food ──────────────────────────
  if (si >= 4) {
    f *= b === 'plains' || b === 'savanna' || b === 'grassland' ? 1.3
       : b === 'jungle' || b === 'mountain' ? 0.55
       : b === 'deep_ocean' || b === 'ocean' ? 1.15
       : 0.9;
  } else if (si <= 1) {
    // Small things hide anywhere; cover helps.
    f *= b === 'jungle' || b === 'forest' ? 1.15 : 1.0;
  }

  // ── Metabolism and respiration ────────────────────────────────────────────
  if (d.metabolism === 'photosynthetic') f *= b === 'deep_ocean' ? 0.2 : 1.15;
  if (d.metabolism === 'chemosynthetic') {
    f *= b === 'volcanic' || b === 'deep_ocean' ? 1.5 : 0.8;
  }
  if (d.respiration === 'anaerobic') f *= b === 'volcanic' || b === 'deep_ocean' ? 1.25 : 0.95;

  // ── Heat tolerance carried on the habitat record ──────────────────────────
  if (sp.habitat.temperatureRange === 'extreme_heat') {
    f *= b === 'volcanic' || b === 'desert' ? 1.45 : cell.temperature > 0.65 ? 1.15 : 0.8;
  } else if (sp.habitat.temperatureRange === 'extreme_cold') {
    f *= b === 'snow' || b === 'tundra' ? 1.45 : cell.temperature < 0.4 ? 1.15 : 0.8;
  }

  return Math.max(0.15, Math.min(1.7, f));
}

/** Warm-blooded-ish preference curve; most life clusters away from extremes. */
function temperatureFit(temp: number): number {
  const d = Math.abs(temp - 0.55);
  return Math.max(0.15, 1 - d * 1.6);
}

/** Deterministic hash → [0,1), used for regional advantage. */
function hash3(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Cheap smooth noise over coarse regions of the grid. */
function regionalBias(speciesSeed: number, row: number, col: number): number {
  const R = 24;                       // region size in cells
  const rx = row / R, cy = col / R;
  const r0 = Math.floor(rx), c0 = Math.floor(cy);
  const fr = rx - r0, fc = cy - c0;
  const sr = fr * fr * (3 - 2 * fr), sc = fc * fc * (3 - 2 * fc);
  const a = hash3(speciesSeed, r0, c0);
  const b = hash3(speciesSeed, r0, c0 + 1);
  const c2 = hash3(speciesSeed, r0 + 1, c0);
  const d = hash3(speciesSeed, r0 + 1, c0 + 1);
  return (a + (b - a) * sc) + ((c2 + (d - c2) * sc) - (a + (b - a) * sc)) * sr;
}

function seedOf(sp: SpeciesGenome): number {
  let h = 2166136261;
  for (let i = 0; i < sp.id.length; i++) { h ^= sp.id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Score one species for one cell. Returns 0 when the species simply cannot
 * live there, so uninhabitable cells stay unassigned rather than being given
 * an arbitrary occupant.
 *
 * `bias` is a per-species regional advantage. Without it, near-identical
 * competitors are separated only by population and ONE species takes the entire
 * planet — 52,000 cells to a single winner. Real competitors partition space
 * instead, so each lineage gets patches where it happens to hold the edge.
 */
function score(sp: SpeciesGenome, cell: GridCell, bias: number): number {
  const fit = environmentFit(sp.dna.environment, cell.biome);
  if (fit <= 0) return 0;

  // Adaptable lineages tolerate a wider band of conditions.
  const tolerance = 0.5 + (sp.dna.adaptability / 10) * 0.5;
  const temp = 1 - (1 - temperatureFit(cell.temperature)) * (1 - tolerance + 0.35);

  // Population is relative dominance, so it decides ties between viable species.
  return fit * archetypeFit(sp, cell) * Math.max(0.1, temp)
       * (0.35 + sp.population) * (0.72 + bias * 0.56);
}

/**
 * Stamp `dominantSpeciesId` across the grid.
 *
 * Only cells with actual life get an occupant. Called after evolution steps and
 * whenever the planet view needs an up-to-date picture.
 *
 * @param stride sample every Nth cell and fill the block around it. The grid is
 *   256×256 = 65k cells and species ranges are broad, so scoring every cell
 *   individually is wasted work; 2 keeps it under a millisecond.
 */
export function assignDominantSpecies(
  grid: PlanetGrid,
  species: SpeciesGenome[],
  stride = 2,
): void {
  const living = species.filter(s => !s.isExtinct && s.population > 0.01);

  if (living.length === 0) {
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) grid[row][col].dominantSpeciesId = null;
    }
    return;
  }

  const seeds = living.map(seedOf);

  for (let row = 0; row < GRID_SIZE; row += stride) {
    for (let col = 0; col < GRID_SIZE; col += stride) {
      const cell = grid[row][col];

      let best: SpeciesGenome | null = null;
      let bestScore = 0;
      if (cell.lifeDensity > 0.02) {
        for (let k = 0; k < living.length; k++) {
          const sp = living[k];
          const s = score(sp, cell, regionalBias(seeds[k], row, col));
          if (s > bestScore) { bestScore = s; best = sp; }
        }
      }
      const id = best ? best.id : null;

      // Fill the block this sample represents.
      for (let r = row; r < Math.min(GRID_SIZE, row + stride); r++) {
        for (let c = col; c < Math.min(GRID_SIZE, col + stride); c++) {
          grid[r][c].dominantSpeciesId = grid[r][c].lifeDensity > 0.02 ? id : null;
        }
      }
    }
  }
}

/** Count cells held by each species. Used by the UI to report range size. */
export function speciesRangeCounts(grid: PlanetGrid): Map<string, number> {
  const counts = new Map<string, number>();
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const id = grid[row][col].dominantSpeciesId;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}
