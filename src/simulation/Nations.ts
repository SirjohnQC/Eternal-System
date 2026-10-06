/**
 * Nations — the countries a civilisation splits into on its home world.
 *
 * Phase 1 of docs/CORE_LOOP_VISION.md: civilisations become AGENTS. Each nation
 * has a territory on the planet grid, a culture drifted from its species', a
 * government and ideology that follow from that culture, a flag, and a needs
 * state (population, food, materials, land, cohesion, knowledge). Where a need
 * runs short, a PRESSURE appears; phase 2 makes nations respond to pressures
 * (technology as a response). Every change that matters is written to a causal
 * history: { what happened, because of what }.
 *
 * Pure simulation: no rendering, no DOM. Deterministic from the seed and the
 * grid it is stepped against.
 */
import { GRID_SIZE, isWater, isHabitable, type PlanetGrid, type BiomeType } from './PlanetGrid';
import {
  governmentFor, ideologyFor, type CultureValues, type GenomeSummary, type Government, type Ideology,
} from './Civilization';
import { SeedRNG } from '../utils/SeedRNG';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Pixel flag design: a layout over two or three colours and an emblem. */
export type FlagLayout = 'bicolor-h' | 'bicolor-v' | 'tricolor-h' | 'tricolor-v' | 'cross' | 'saltire' | 'canton' | 'chevron' | 'border';
export type FlagEmblem = 'none' | 'star' | 'disc' | 'crescent' | 'diamond' | 'bar' | 'eye';
export interface NationFlag { layout: FlagLayout; colors: [string, string, string]; emblem: FlagEmblem; emblemColor: string }

/** What a nation has and needs. All per-nation, recomputed from its land each step. */
export interface NationState {
  /** Arbitrary units: ~ people. */
  population: number;
  /** Food the land yields per step vs what the people eat. */
  foodYield: number; foodNeed: number;
  /** Wood, stone, ore reachable in the territory. */
  materials: number;
  /** Cells held. */
  land: number;
  /** 0–1: how well the nation holds together. Sprawl and strain erode it. */
  cohesion: number;
  /** Accumulated know-how. Grows with people and curiosity. */
  knowledge: number;
}

/**
 * Hidden scenario labels (vision §3): the simulation knows these, the player
 * sees consequences. Each is 0 (none) .. 1 (acute).
 */
export interface Pressures {
  hunger: number;      // food need over yield
  crowding: number;    // people per cell over what the land carries
  scarcity: number;    // materials per person short
  unrest: number;      // cohesion lost
}

export interface HistoryEntry {
  tick: number;
  /** What happened, in plain words. */
  what: string;
  /** Why: the states / earlier entries that caused it. */
  because: string[];
}

export interface Nation {
  id: number;
  name: string;
  /** e.g. "Kingdom", "Republic", "Holy See" — follows the government. */
  form: string;
  government: Government;
  ideology: Ideology;
  values: CultureValues;
  flag: NationFlag;
  /** Border / map colour (the flag's first colour). */
  color: string;
  /** Capital cell. */
  capital: { row: number; col: number };
  founded: number;
  state: NationState;
  pressures: Pressures;
  history: HistoryEntry[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const N = GRID_SIZE * GRID_SIZE;
const MIN_NATIONS = 2, MAX_NATIONS = 6;
/** Food one fertile cell yields, and one unit of population eats. */
const FOOD_PER_FERTILE = 1.0, FOOD_PER_PERSON = 0.012;
/** People a cell carries comfortably (crowding above this). */
const CARRY_PER_CELL = 70;
const HISTORY_MAX = 60;

const FLAG_COLORS = [
  '#b8322a', '#2f6fb3', '#2e8b4e', '#7d3fa0', '#d06a1e', '#1f8f86',
  '#e3b23c', '#23324a', '#e9e4d4', '#8a1c3c', '#5a7d2a', '#111418',
];
const LAYOUTS: FlagLayout[] = ['bicolor-h', 'bicolor-v', 'tricolor-h', 'tricolor-v', 'cross', 'saltire', 'canton', 'chevron', 'border'];
const EMBLEMS: FlagEmblem[] = ['none', 'star', 'disc', 'crescent', 'diamond', 'bar', 'eye'];

const FORM_OF: Record<Government, string[]> = {
  Theocracy:     ['Holy See of', 'Sanctum of', 'Faithful'],
  Republic:      ['Republic of', 'Commonwealth of', 'Free State of'],
  Empire:        ['Empire of', 'Dominion of', 'Imperium of'],
  Confederation: ['Confederacy of', 'League of', 'Union of'],
  Technocracy:   ['Directorate of', 'Academy of', 'Concord of'],
  Warband:       ['Horde of', 'Warhost of', 'Clans of'],
  Hive:          ['Hive of', 'Brood of', 'Swarm of'],
  Council:       ['Council of', 'Assembly of', 'Moot of'],
};

// ─── Names ────────────────────────────────────────────────────────────────────

/** A place name; harsher sounds for warlike peoples, softer for pious ones. */
function placeName(rng: SeedRNG, v: CultureValues): string {
  const hard = ['k', 'r', 'g', 'd', 'th', 'kr', 'z', 'v', 'gr', 'dr'];
  const soft = ['l', 'm', 'n', 's', 'sh', 'el', 'y', 'f', 'h', 'lu'];
  const vow = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'ou', 'ei'];
  const ends = v.militarism > 0.55 ? ['ak', 'or', 'ug', 'ar', 'ost', 'ek'] : v.piety > 0.55 ? ['ael', 'ion', 'esh', 'ara', 'iel'] : ['an', 'ia', 'en', 'is', 'or', 'ea', 'um'];
  const pool = v.militarism > 0.5 ? hard : v.piety > 0.5 ? soft : rng.next() < 0.5 ? hard : soft;
  const syl = 1 + Math.floor(rng.next() * 2);
  let s = '';
  for (let i = 0; i < syl; i++) s += rng.pick(pool) + (i === 0 ? rng.pick(vow) : rng.pick(['a', 'e', 'i', 'o', 'u']));
  s += rng.pick(ends);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function flagFor(rng: SeedRNG, v: CultureValues, used: Set<string>): NationFlag {
  // The first colour must be distinct between nations (it is the border colour).
  let c0 = rng.pick(FLAG_COLORS);
  for (let i = 0; i < FLAG_COLORS.length && used.has(c0); i++) c0 = FLAG_COLORS[(FLAG_COLORS.indexOf(c0) + 1) % FLAG_COLORS.length];
  used.add(c0);
  const others = FLAG_COLORS.filter(c => c !== c0);
  const c1 = rng.pick(others), c2 = rng.pick(others.filter(c => c !== c1));
  // Pious peoples favour crosses and emblems of light; warlike ones bold
  // bands; collective ones simple fields.
  const layout: FlagLayout = v.piety > 0.6 && rng.next() < 0.6 ? rng.pick(['cross', 'saltire'] as FlagLayout[])
    : v.collectivism > 0.65 && rng.next() < 0.5 ? rng.pick(['border', 'bicolor-h'] as FlagLayout[])
    : rng.pick(LAYOUTS);
  const emblem: FlagEmblem = v.piety > 0.6 && rng.next() < 0.6 ? rng.pick(['star', 'disc', 'eye'] as FlagEmblem[]) : rng.pick(EMBLEMS);
  return { layout, colors: [c0, c1, c2], emblem, emblemColor: rng.next() < 0.5 ? '#f2ead0' : c2 };
}

// ─── Terrain ──────────────────────────────────────────────────────────────────

const FERTILE: Partial<Record<BiomeType, number>> = {
  grassland: 1, plains: 1, forest: 0.8, jungle: 0.7, savanna: 0.7, beach: 0.4, tundra: 0.3, desert: 0.15,
};
const MATERIAL: Partial<Record<BiomeType, number>> = {
  forest: 1, jungle: 0.9, mountain: 1.2, tundra: 0.3, savanna: 0.3, desert: 0.2, volcanic: 0.6,
};

/** Smooth value noise on the grid (wraps in x), 0..1, for organic borders. */
function borderNoise(r: number, c: number, seed: number): number {
  // Large cells: small-scale noise averages out over the long paths
  // between capitals and the borders stay straight.
  const S = 28;
  const h = (x: number, y: number) => {
    let v = (((x % 64) + 64) % 64) * 374761393 + y * 668265263 + seed * 2654435761;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  const gx = c / S, gy = r / S, x0 = Math.floor(gx), y0 = Math.floor(gy);
  const tx = gx - x0, ty = gy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const W = Math.ceil(GRID_SIZE / S);                     // wrap period in noise cells
  const a = h(x0 % W, y0), b = h((x0 + 1) % W, y0), cc = h(x0 % W, y0 + 1), d = h((x0 + 1) % W, y0 + 1);
  return a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy;
}

/**
 * Cost to push a border across a cell: mountains and rivers slow it (so
 * borders settle along ridges and rivers), water stops it, and smooth noise
 * keeps borders from running straight.
 */
function crossCost(grid: PlanetGrid, r: number, c: number, seed: number): number {
  const cell = grid[r][c];
  if (isWater(cell.biome)) return Infinity;
  const steep = cell.biome === 'mountain' ? 6 : cell.biome === 'snow' ? 5 : 1;
  const n = 0.6 * borderNoise(r, c, seed) + 0.4 * borderNoise(r * 2.3 + 17, c * 2.3 + 5, seed + 1);
  return (steep + cell.elevation * 2 + (cell.river > 0.5 ? 5 : 0)) * (0.25 + 3 * n * n);
}

// ─── The system ───────────────────────────────────────────────────────────────

const EASED: Record<keyof Pressures, string> = { hunger: 'Hunger', crowding: 'Crowding', scarcity: 'The shortage', unrest: 'Unrest' };

/**
 * What a visitor would notice (vision §3): the pressures as observable
 * consequences, never as their labels. Mildest first-hand signs at 0.25,
 * stronger wording past 0.6. Empty when all is calm.
 */
export function symptomsOf(n: Nation): string[] {
  const p = n.pressures, out: string[] = [];
  const say = (v: number, mild: string, acute: string) => { if (v >= 0.6) out.push(acute); else if (v >= 0.25) out.push(mild); };
  say(p.hunger, 'Granaries are running low', 'People queue at empty granaries');
  say(p.crowding, 'Streets are crowded', 'Families crowd into every room');
  say(p.scarcity, 'Builders lack timber and stone', 'Half-built walls stand abandoned');
  say(p.unrest, 'Factions quarrel in the capital', 'Crowds gather against the rulers');
  return out;
}

export class NationSystem {
  readonly nations: Nation[] = [];
  /** Nation index per cell (row * GRID_SIZE + col), -1 for none. */
  readonly owner = new Int8Array(N).fill(-1);
  /** Bumped on any change a renderer would draw (territory, flags). */
  version = 0;
  private rng: SeedRNG;
  private founded = false;

  constructor(readonly seed: number) {
    this.rng = new SeedRNG(seed ^ 0x6e47104e);
  }

  get isFounded(): boolean { return this.founded; }

  nationAt(row: number, col: number): Nation | null {
    const i = this.owner[row * GRID_SIZE + col];
    return i >= 0 ? this.nations[i] : null;
  }

  /**
   * Split the settled land (cells with a civId) into nations. Capitals are the
   * most fertile settled cells, spread apart (farthest-point sampling). How
   * many: more land and a less collective people make more nations.
   */
  found(grid: PlanetGrid, base: CultureValues, genome: GenomeSummary, tick: number): void {
    const settled: number[] = [];
    for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
      const cell = grid[r][c];
      if (cell.civId != null && !isWater(cell.biome)) settled.push(r * GRID_SIZE + c);
    }
    if (settled.length < 40) return;                    // too little to split yet
    const rng = this.rng;
    // More land settled, and a less collective temper, split into more nations.
    const share = settled.length / N;
    const want = Math.max(MIN_NATIONS, Math.min(MAX_NATIONS,
      Math.round(1.5 + share * 3 + (1 - base.collectivism) * 2.2 + (rng.next() - 0.5))));
    // Capitals: first the most fertile cell, then the settled cell farthest
    // (by wrapped grid distance) from every capital so far, weighted by fertility.
    const caps: number[] = [];
    let best = settled[0], bestF = -1;
    for (const i of settled) {
      const f = grid[(i / GRID_SIZE) | 0][i % GRID_SIZE].fertility + rng.next() * 0.05;
      if (f > bestF) { bestF = f; best = i; }
    }
    caps.push(best);
    while (caps.length < want) {
      let pick = -1, pickScore = -1;
      for (let s = 0; s < settled.length; s += 3) {
        const i = settled[s], r = (i / GRID_SIZE) | 0, c = i % GRID_SIZE;
        let d = Infinity;
        for (const k of caps) {
          const kr = (k / GRID_SIZE) | 0, kc = k % GRID_SIZE;
          let dc = Math.abs(c - kc); if (dc > GRID_SIZE / 2) dc = GRID_SIZE - dc;
          d = Math.min(d, Math.hypot(r - kr, dc));
        }
        const score = d * (0.5 + grid[r][c].fertility);
        if (score > pickScore) { pickScore = score; pick = i; }
      }
      if (pick < 0 || pickScore < 6) break;
      caps.push(pick);
    }
    // Nations: culture drifts from the species' (each people its own temper).
    const used = new Set<string>();
    caps.forEach((cap, idx) => {
      const drift = (x: number) => Math.max(0, Math.min(1, x + (rng.next() - 0.5) * 0.36));
      const values: CultureValues = {
        militarism: drift(base.militarism), piety: drift(base.piety), curiosity: drift(base.curiosity),
        collectivism: drift(base.collectivism), xenophobia: drift(base.xenophobia),
      };
      const government = governmentFor(values, genome);
      const flag = flagFor(rng, values, used);
      const place = placeName(rng, values);
      const forms = FORM_OF[government];
      const form = rng.pick(forms);
      const name = form.endsWith('of') ? `${form} ${place}` : `${form} ${place}`;
      const r = (cap / GRID_SIZE) | 0, c = cap % GRID_SIZE;
      this.nations.push({
        id: idx, name, form, government, ideology: ideologyFor(values), values, flag, color: flag.colors[0],
        capital: { row: r, col: c }, founded: tick,
        state: { population: 0, foodYield: 0, foodNeed: 0, materials: 0, land: 0, cohesion: 0.8, knowledge: 0 },
        pressures: { hunger: 0, crowding: 0, scarcity: 0, unrest: 0 },
        history: [{ tick, what: `${name} was founded around ${place}.`,
          because: [`the people had spread across ${settled.length} settled cells`, `its founders were ${government.toLowerCase()}-minded`] }],
      });
      this.owner[cap] = idx;
    });
    this.claim(grid, settled);
    this.founded = true;
    this.recompute(grid, tick);
    this.version++;
  }

  /**
   * Territory: every settled cell goes to the nation that reaches it most
   * cheaply over land (multi-source Dijkstra from the current territories).
   * Cells are never taken from an owner here — phase 3 (relations, war) moves
   * borders; this only hands out newly settled land.
   */
  private claim(grid: PlanetGrid, settled: number[]): void {
    const own = this.owner;
    // Float64: the heap holds doubles; a Float32 dist rounds below the pushed
    // value, so `d > dist[i]` skipped nearly every cell as stale.
    const dist = new Float64Array(N).fill(Infinity);
    const isSettled = new Uint8Array(N);
    for (const i of settled) isSettled[i] = 1;
    // Binary heap of [dist, cell].
    const heap: number[] = [];
    const push = (d: number, i: number) => {
      heap.push(d, i);
      let k = heap.length / 2 - 1;
      while (k > 0) { const p = ((k - 1) >> 1); if (heap[p * 2] <= heap[k * 2]) break; [heap[p * 2], heap[k * 2]] = [heap[k * 2], heap[p * 2]]; [heap[p * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1], heap[p * 2 + 1]]; k = p; }
    };
    const pop = (): [number, number] => {
      const d = heap[0], i = heap[1];
      const ld = heap[heap.length - 2], li = heap[heap.length - 1];
      heap.length -= 2;
      if (heap.length) {
        heap[0] = ld; heap[1] = li;
        let k = 0;
        for (;;) {
          const a = k * 2 + 1, b = a + 1; let m = k;
          if (a * 2 < heap.length && heap[a * 2] < heap[m * 2]) m = a;
          if (b * 2 < heap.length && heap[b * 2] < heap[m * 2]) m = b;
          if (m === k) break;
          [heap[m * 2], heap[k * 2]] = [heap[k * 2], heap[m * 2]]; [heap[m * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1], heap[m * 2 + 1]]; k = m;
        }
      }
      return [d, i];
    };
    // Multi-source: every owned cell starts at 0 with its own label; labels
    // flow outward over land. Unsettled land can be crossed (at 3x) but is
    // not claimed; only settled cells without an owner take the label.
    const src = new Int8Array(N).fill(-1);
    for (let i = 0; i < N; i++) if (own[i] >= 0) { dist[i] = 0; src[i] = own[i]; push(0, i); }
    while (heap.length) {
      const [d, i] = pop();
      if (d > dist[i]) continue;
      const r = (i / GRID_SIZE) | 0, c = i % GRID_SIZE;
      for (let k = 0; k < 4; k++) {
        const nr = r + (k === 0 ? -1 : k === 1 ? 1 : 0);
        if (nr < 0 || nr >= GRID_SIZE) continue;
        const nc = (c + (k === 2 ? -1 : k === 3 ? 1 : 0) + GRID_SIZE) % GRID_SIZE;
        const j = nr * GRID_SIZE + nc;
        const cost = crossCost(grid, nr, nc, this.seed);
        if (cost === Infinity) continue;
        const nd = d + cost * (isSettled[j] ? 1 : 3);
        if (nd < dist[j]) { dist[j] = nd; src[j] = src[i]; push(nd, j); }
      }
    }
    for (const i of settled) if (own[i] < 0 && src[i] >= 0) own[i] = src[i];
    // Settled cells nothing reached over land (islands): the nearest capital.
    for (const i of settled) {
      if (own[i] >= 0) continue;
      const r = (i / GRID_SIZE) | 0, c = i % GRID_SIZE;
      let best = 0, bd = Infinity;
      this.nations.forEach((n, k) => {
        let dc = Math.abs(c - n.capital.col); if (dc > GRID_SIZE / 2) dc = GRID_SIZE - dc;
        const d = Math.hypot(r - n.capital.row, dc);
        if (d < bd) { bd = d; best = k; }
      });
      own[i] = best;
    }
  }

  /**
   * One step: new settled land is claimed, needs are recomputed from the
   * land, people grow (or starve) toward what the food carries, knowledge
   * accrues, cohesion drifts — and crossing a pressure threshold is written
   * to the nation's history with its cause.
   */
  step(grid: PlanetGrid, tick: number): void {
    if (!this.founded) return;
    let grew = false;
    const settled: number[] = [];
    for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
      const i = r * GRID_SIZE + c, cell = grid[r][c];
      const s = cell.civId != null && !isWater(cell.biome);
      if (s) settled.push(i);
      if (s && this.owner[i] < 0) grew = true;
      if (!s && this.owner[i] >= 0) { this.owner[i] = -1; grew = true; }
    }
    if (grew) { this.claim(grid, settled); this.version++; }
    this.recompute(grid, tick);
  }

  private recompute(grid: PlanetGrid, tick: number): void {
    const land = new Float64Array(this.nations.length), food = new Float64Array(this.nations.length);
    const mats = new Float64Array(this.nations.length), live = new Float64Array(this.nations.length);
    for (let i = 0; i < N; i++) {
      const o = this.owner[i];
      if (o < 0) continue;
      const cell = grid[(i / GRID_SIZE) | 0][i % GRID_SIZE];
      land[o]++;
      food[o] += (FERTILE[cell.biome] ?? 0) * cell.fertility * FOOD_PER_FERTILE * (cell.river > 0.5 ? 1.3 : 1);
      mats[o] += MATERIAL[cell.biome] ?? 0;
      live[o] += isHabitable(cell.biome) ? cell.lifeDensity : 0;
    }
    this.nations.forEach((n, k) => {
      const s = n.state, p = n.pressures, before = { ...p };
      s.land = land[k]; s.foodYield = food[k]; s.materials = mats[k];
      // People grow toward what the food carries (logistic), and starve above it.
      const carry = s.foodYield / FOOD_PER_PERSON;
      if (s.population === 0) s.population = Math.min(carry * 0.5, live[k] * 20 + 50);
      s.population = Math.max(10, s.population + s.population * 0.02 * (1 - s.population / Math.max(1, carry)));
      s.foodNeed = s.population * FOOD_PER_PERSON;
      s.knowledge += s.population * 0.0004 * (0.5 + n.values.curiosity);
      // Cohesion: sprawl and hunger wear it down; a shared faith and a
      // collective temper hold it.
      // Sprawl: a nation over ~a seventh of the planet strains to hold together.
      const sprawl = s.land / (N / 7);
      const target = Math.max(0, Math.min(1, 0.55 + 0.3 * n.values.collectivism + 0.15 * n.values.piety - 0.25 * sprawl - 0.4 * p.hunger));
      s.cohesion += (target - s.cohesion) * 0.05;
      p.hunger = Math.max(0, Math.min(1, s.foodNeed / Math.max(1e-6, s.foodYield) - 1));
      p.crowding = Math.max(0, Math.min(1, s.population / Math.max(1, s.land * CARRY_PER_CELL) - 1));
      p.scarcity = Math.max(0, Math.min(1, 1 - s.materials / Math.max(1, s.population * 0.01)));
      p.unrest = Math.max(0, Math.min(1, (0.6 - s.cohesion) / 0.6));
      // History: a pressure crossing into "acute" is an event, with its cause.
      const note = (key: keyof Pressures, what: string, because: string[]) => {
        if (before[key] < 0.5 && p[key] >= 0.5) this.log(n, tick, what, because);
        if (before[key] >= 0.5 && p[key] < 0.25) this.log(n, tick, `${EASED[key]} eased in ${n.name}.`, [`${key} fell to ${(p[key] * 100) | 0}%`]);
      };
      note('hunger', `Hunger spread through ${n.name}.`, [`${s.population | 0} people`, `food for ${(s.foodYield / FOOD_PER_PERSON) | 0}`]);
      note('crowding', `${n.name} grew crowded.`, [`${s.population | 0} people on ${s.land} cells`]);
      note('scarcity', `${n.name} ran short of materials.`, [`${s.materials.toFixed(0)} worth of wood and stone for ${s.population | 0} people`]);
      note('unrest', `Unrest stirred in ${n.name}.`, [
        s.land > N / 7 ? 'its lands sprawled too wide to hold' : 'its people drifted apart',
        ...(p.hunger > 0.3 ? ['hunger'] : []),
      ]);
    });
  }

  private log(n: Nation, tick: number, what: string, because: string[]): void {
    n.history.push({ tick, what, because });
    if (n.history.length > HISTORY_MAX) n.history.splice(1, n.history.length - HISTORY_MAX);   // keep the founding
  }
}
