/**
 * A colony world's surface (expansion P4: seeing it). The home world's grid
 * is shaped by the whole surface simulation; a colony world's is derived:
 * the planet's own terrain from its seed, plus the colony's state drawn onto
 * it — territory that grows with its population from the best ground, and
 * its people living there.
 *
 * Derived, not stored: the same planet and colony state always give the same
 * surface, so nothing new goes into the save, and the view re-derives it when
 * the colony changes (CLAUDE.md rule 1).
 *
 * Pure: the engine supplies the grid; no DOM.
 */
import { GRID_SIZE, SEA_LEVEL, type PlanetGrid } from './PlanetGrid';
import { colonyLook, type Colony } from './Colonies';

/** Share of a world's land a colony at full population covers. */
export const TERRITORY_AT_FULL = 0.35;
/** Life thickness on settled ground, and the fringe around it. */
const SETTLED_LIFE = 0.6, FRINGE_LIFE = 0.25, FRINGE = 6;

/** The seed of a planet's terrain (the same formula as the home world's grid). */
export function worldGridSeed(starId: number, planetIndex: number): number {
  return starId * 7777 + planetIndex * 131;
}

/** Cells a colony covers at `population` (0..1), from the land it has. */
export function territorySize(landCells: number, population: number): number {
  if (landCells <= 0) return 0;
  return Math.max(1, Math.round(landCells * TERRITORY_AT_FULL * Math.max(0, Math.min(1, population))));
}

/**
 * Draw a colony onto a freshly generated grid: `civId` on its territory —
 * grown outward from the most fertile land cell, best ground first — and
 * life there and around it. Clears any previous colony marks first, so it
 * can be re-applied as the colony changes.
 */
export function stampColony(grid: PlanetGrid, civId: string, population: number): number {
  let land = 0, start = -1, bestF = -1;
  for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
    const cell = grid[r][c];
    cell.civId = null;
    cell.lifeDensity = 0;
    cell.dominantSpeciesId = null;
    if (cell.elevation <= SEA_LEVEL) continue;
    land++;
    // Ships come down by the sea: the most fertile COASTAL cell is the
    // landing (any land if the world has no sea). Ties broken by position,
    // so the start never depends on scan order alone.
    const coastal = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) =>
      (grid[r + dr]?.[(c + dc + GRID_SIZE) % GRID_SIZE]?.elevation ?? 1) <= SEA_LEVEL);
    const f = cell.fertility + (coastal ? 2 : 0) + ((r * 73 + c * 151) % 97) * 1e-6;
    if (f > bestF) { bestF = f; start = r * GRID_SIZE + c; }
  }
  const want = territorySize(land, population);
  if (start < 0 || want === 0) return 0;

  // Best-first growth over land (a simple frontier sorted by fertility).
  const taken = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const frontier: number[] = [start];
  taken[start] = 1;
  let n = 0;
  const owned: number[] = [];
  while (frontier.length && n < want) {
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) {
      const a = frontier[i], b = frontier[bi];
      if (grid[(a / GRID_SIZE) | 0][a % GRID_SIZE].fertility > grid[(b / GRID_SIZE) | 0][b % GRID_SIZE].fertility) bi = i;
    }
    const k = frontier[bi];
    frontier[bi] = frontier[frontier.length - 1];
    frontier.pop();
    const r = (k / GRID_SIZE) | 0, c = k % GRID_SIZE;
    grid[r][c].civId = civId;
    grid[r][c].lifeDensity = SETTLED_LIFE;
    owned.push(k);
    n++;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = (c + dc + GRID_SIZE) % GRID_SIZE;
      if (rr < 0 || rr >= GRID_SIZE) continue;
      const kk = rr * GRID_SIZE + cc;
      if (taken[kk] || grid[rr][cc].elevation <= SEA_LEVEL) continue;
      taken[kk] = 1;
      frontier.push(kk);
    }
  }
  // A fringe of life around the settled land (gardens, herds, the colonists
  // abroad) — on the coast's water too, where a sea-dwelling people lives.
  for (const k of owned) {
    const r = (k / GRID_SIZE) | 0, c = k % GRID_SIZE;
    if ((r + c) % 3) continue;
    for (let dr = -FRINGE; dr <= FRINGE; dr += 2) for (let dc = -FRINGE; dc <= FRINGE; dc += 2) {
      const rr = r + dr, cc = (c + dc + GRID_SIZE) % GRID_SIZE;
      if (rr < 0 || rr >= GRID_SIZE) continue;
      const cell = grid[rr][cc];
      if (cell.lifeDensity < FRINGE_LIFE) cell.lifeDensity = FRINGE_LIFE;
    }
  }
  return n;
}

/**
 * The Codex "Species" card for a colony world: its people, not the star's.
 * A colony world often orbits a lifeless star (or a star whose natives live
 * on another planet), so the star's own life says nothing about who is here.
 * Null while another people's home world is held: there the natives are the
 * people, and the star's own species card already describes them. Once the
 * natives are gone the occupiers are the world's people.
 *
 * `people` is what the views call the colonists (the player's lineage name,
 * or the founding civilisation's people); `founder` is who sent them.
 */
export function colonyPeopleCard(c: Colony, people: string, founder: string): { name: string; desc: string } | null {
  if (c.occupation?.homeWorld) return null;
  const stage = c.stage ?? 'same';
  const look = colonyLook(c);
  const what = stage === 'same' ? `The same people as on ${founder}'s home world`
    : stage === 'species' ? 'A new species, their own now'
    : stage === 'subspecies' ? 'A subspecies of their ancestors'
    : 'A local variant of their ancestors';
  const kind = c.seizedTick != null ? `Conquerors from ${founder}`
    : c.status === 'outpost' ? `An outpost of ${founder}` : `Settlers from ${founder}`;
  const gens = `${c.generations} generation${c.generations === 1 ? '' : 's'} here`;
  return { name: people, desc: `${kind} · ${what}${look ? ` (${look})` : ''} · ${gens}` };
}
