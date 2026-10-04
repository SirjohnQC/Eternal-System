/**
 * Architecture genome — how ONE civilisation builds, rolled once from what
 * the species is and the world it lives on, plus a seeded wildcard or two.
 *
 * The era then advances WITHIN this style (hive builders stay hive
 * builders: mud hives, resin hives, glass hives), so a species' cities are
 * recognisable through the ages and two species never build alike.
 *
 * - Body plan -> shape language (boxes, domes, hives, pods, grown towers…)
 * - Habitat / movement -> where and how it stands (stilts over water,
 *   half-buried burrows, tall spires for flyers)
 * - Social level -> layout (scattered loners, grid towns, dense clusters)
 * - World type -> material and colour (basalt, ice, crystal, clay, soot…)
 * - Wildcards (seeded) -> the surprise: ring towns, very tall or squat
 *   buildings, painted roofs, lanterns everywhere, colossal monuments.
 *
 * Pure and deterministic.
 */
export type ShapeFamily = 'box' | 'dome' | 'hive' | 'pod' | 'spire' | 'burrow' | 'grown' | 'carved';
export type TownLayout = 'grid' | 'ring' | 'cluster' | 'line' | 'scatter';
export type Quirk = 'tall' | 'squat' | 'ring' | 'painted' | 'lanterns' | 'colossal';

export interface ArchGenome {
  shape: ShapeFamily;
  layout: TownLayout;
  /** Footprint and height multipliers. */
  scale: number;
  tall: number;
  /** Raised on stilts (water peoples). */
  stilts: boolean;
  /** Wall colour (hsl) — null keeps the era's own materials. */
  wall: [number, number, number] | null;
  /** Roof / accent colour (hsl). */
  accent: [number, number, number];
  material: string;
  quirks: Quirk[];
  /** One line for the codex / cards: "raises resin hives on stilts". */
  summary: string;
}

export interface ArchInput {
  bodyStructure: string;
  environment: string;
  locomotion: string;
  metabolism: string;
  social: number;
  size: string;
  planetType: string;
  seed: number;
}

function rng(seed: number) {
  let s = seed | 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296; };
}

const SHAPE_BY_BODY: Record<string, ShapeFamily> = {
  vertebrate: 'box', shelled: 'dome', exoskeletal: 'hive', segmented: 'hive', gelatinous: 'pod',
  radial: 'dome', colonial: 'hive', filamentous: 'grown', cartilaginous: 'spire', 'single-celled': 'pod',
};
/** Shapes a world lends itself to (the wildcard draws from these). */
const WORLD_SHAPES: Record<string, ShapeFamily[]> = {
  lava: ['carved', 'dome', 'burrow'], ice: ['dome', 'carved', 'burrow'], crystal: ['carved', 'spire', 'pod'],
  toxic: ['pod', 'dome', 'hive'], desert: ['burrow', 'box', 'dome'], carbon: ['carved', 'hive', 'box'],
  ocean: ['dome', 'pod', 'box'], rocky: ['box', 'carved', 'hive'], storm: ['burrow', 'dome', 'carved'],
};
const WORLD_MATERIAL: Record<string, [string, [number, number, number]]> = {
  lava: ['basalt', [18, 0.14, 0.26]], ice: ['ice', [200, 0.38, 0.84]], crystal: ['crystal', [275, 0.42, 0.7]],
  toxic: ['sealed membrane', [92, 0.42, 0.5]], carbon: ['soot-stone', [20, 0.1, 0.3]], desert: ['fired clay', [30, 0.48, 0.62]],
};
const BODY_MATERIAL: Record<string, [string, [number, number, number]]> = {
  shelled: ['nacre', [36, 0.2, 0.84]], exoskeletal: ['resin', [33, 0.62, 0.5]], segmented: ['chitin', [300, 0.2, 0.4]],
  gelatinous: ['gel', [186, 0.42, 0.7]], filamentous: ['living wood', [96, 0.36, 0.42]], colonial: ['coral', [8, 0.45, 0.65]],
  radial: ['spun fibre', [48, 0.4, 0.68]], 'single-celled': ['secreted film', [110, 0.25, 0.62]],
};

export function archGenome(a: ArchInput): ArchGenome {
  const R = rng(a.seed ^ 0xa4c1);
  let shape: ShapeFamily = SHAPE_BY_BODY[a.bodyStructure] ?? 'box';
  if (a.metabolism === 'photosynthetic') shape = 'grown';
  if (a.locomotion === 'flying' || a.environment === 'aerial') shape = shape === 'box' ? 'spire' : shape;
  if (a.locomotion === 'crawling' && R() < 0.5) shape = 'burrow';
  // The world has its say a third of the time: the same species builds
  // differently on a lava world than on an ocean world.
  if (R() < 0.33) {
    const opts = WORLD_SHAPES[a.planetType] ?? ['box'];
    shape = opts[Math.floor(R() * opts.length)];
  }
  const stilts = a.environment === 'ocean' || a.environment === 'coastal' || a.environment === 'deep_sea'
    || (a.planetType === 'ocean' && R() < 0.35);
  const layout: TownLayout = a.social >= 8 ? 'cluster' : a.social <= 2 ? 'scatter'
    : stilts ? 'line' : a.bodyStructure === 'radial' ? 'ring' : R() < 0.15 ? 'ring' : 'grid';
  const sizeK: Record<string, number> = { microscopic: 0.7, tiny: 0.75, small: 0.85, medium: 1, large: 1.2, massive: 1.45 };
  let scale = sizeK[a.size] ?? 1, tall = 1;
  const [material, wall] = WORLD_MATERIAL[a.planetType] ?? BODY_MATERIAL[a.bodyStructure] ?? ['quarried stone', null as unknown as [number, number, number]];
  let accent: [number, number, number] = wall ? [(wall[0] + 150 + R() * 60) % 360, 0.45, 0.45] : [8, 0.55, 0.42];
  // Wildcards: one, sometimes two.
  const pool: Quirk[] = ['tall', 'squat', 'ring', 'painted', 'lanterns', 'colossal'];
  const quirks: Quirk[] = [];
  const nq = R() < 0.35 ? 2 : 1;
  while (quirks.length < nq) {
    const q = pool[Math.floor(R() * pool.length)];
    if (!quirks.includes(q) && !(q === 'tall' && quirks.includes('squat')) && !(q === 'squat' && quirks.includes('tall'))) quirks.push(q);
  }
  if (quirks.includes('tall')) { tall *= 1.7; scale *= 0.85; }
  if (quirks.includes('squat')) { tall *= 0.6; scale *= 1.2; }
  if (quirks.includes('painted')) accent = [R() * 360, 0.75, 0.55];
  const lay: TownLayout = quirks.includes('ring') ? 'ring' : layout;
  const words: Record<ShapeFamily, string> = {
    box: 'houses', dome: 'domes', hive: 'hives', pod: 'pods', spire: 'spires', burrow: 'burrows', grown: 'grown towers', carved: 'carved halls',
  };
  const summary = `${material === 'quarried stone' ? 'builds' : `builds ${material}`} ${words[shape]}`
    + (stilts ? ' on stilts' : '') + (lay === 'ring' ? ', in ring towns' : lay === 'cluster' ? ', packed close' : lay === 'scatter' ? ', far apart' : '')
    + (quirks.includes('tall') ? ', reaching high' : quirks.includes('squat') ? ', low and wide' : '')
    + (quirks.includes('lanterns') ? ', lit by lanterns' : '') + (quirks.includes('colossal') ? ', around colossal monuments' : '');
  return { shape, layout: lay, scale, tall, stilts, wall, accent, material, quirks, summary };
}
