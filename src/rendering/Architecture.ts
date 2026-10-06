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

// ─── Nations ──────────────────────────────────────────────────────────────────

/** What a nation's culture brings to its building (Nations.ts). */
export interface NationCulture {
  values: { militarism: number; piety: number; curiosity: number; collectivism: number; xenophobia: number };
  government: string;
  /** The flag's first colour, '#rrggbb'. */
  color: string;
  id: number;
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const DEFAULT_ARCH: ArchGenome = {
  shape: 'box', layout: 'grid', scale: 1, tall: 1, stilts: false, wall: null,
  accent: [8, 0.55, 0.42], material: 'quarried stone', quirks: [], summary: 'builds houses',
};

/**
 * How ONE nation builds: its species' way of building (the shape family, the
 * material, stilts — the body does not change at a border), bent by what the
 * nation is. Its flag colour roofs its towns; an insular people walls itself
 * into ring towns, a communal one packs close, an independent one scatters;
 * the curious build tall, the pious raise colossal temples, the martial keep
 * their walls low and thick. Each nation's stone has its own shade.
 * Pure and deterministic.
 */
export function nationArch(base: ArchGenome | null | undefined, n: NationCulture): ArchGenome {
  const b = base ?? DEFAULT_ARCH, v = n.values;
  const R = rng(0x9e3779b1 ^ Math.imul(n.id + 1, 2654435761));
  const [fh, fs, fl] = hexToHsl(n.color);
  // Roofs in the national colour (greys and near-whites keep a little colour of their own).
  const accent: [number, number, number] = fs < 0.15
    ? [(b.accent[0] + R() * 40 - 20 + 360) % 360, Math.max(0.12, b.accent[1] * 0.5), Math.max(0.28, Math.min(0.6, fl))]
    : [fh, Math.min(0.62, Math.max(0.35, fs * 0.8)), Math.max(0.3, Math.min(0.55, fl))];
  const wall: [number, number, number] | null = b.wall
    ? [(b.wall[0] + (R() - 0.5) * 30 + 360) % 360, b.wall[1], Math.max(0.2, Math.min(0.9, b.wall[2] + (R() - 0.5) * 0.12))]
    : [(30 + (R() - 0.5) * 40 + (v.piety > 0.6 ? 10 : 0) + 360) % 360, 0.18 + R() * 0.16, 0.56 + (v.piety - 0.5) * 0.25 + (R() - 0.5) * 0.1];
  const layout: TownLayout = v.xenophobia > 0.65 ? 'ring' : v.collectivism > 0.68 ? 'cluster' : v.collectivism < 0.3 ? 'scatter' : b.layout;
  let tall = b.tall, scale = b.scale;
  const quirks: Quirk[] = b.quirks.filter(q => q !== 'ring' && q !== 'painted');
  if (v.curiosity > 0.65) tall *= 1.25;
  if (v.militarism > 0.65) { tall *= 0.88; scale *= 1.08; }
  if (v.piety > 0.65 && !quirks.includes('colossal')) quirks.push('colossal');
  if (v.piety > 0.55 && v.collectivism > 0.55 && !quirks.includes('lanterns')) quirks.push('lanterns');
  const words: Record<ShapeFamily, string> = {
    box: 'houses', dome: 'domes', hive: 'hives', pod: 'pods', spire: 'spires', burrow: 'burrows', grown: 'grown towers', carved: 'carved halls',
  };
  const colourWord = (h: number) => h < 15 || h >= 345 ? 'red' : h < 45 ? 'orange' : h < 70 ? 'golden' : h < 165 ? 'green' : h < 200 ? 'teal' : h < 255 ? 'blue' : h < 300 ? 'violet' : 'rose';
  const summary = `${colourWord(accent[0])}-roofed ${words[b.shape]}`
    + (b.stilts ? ' on stilts' : '') + (layout === 'ring' ? ', in walled ring towns' : layout === 'cluster' ? ', packed close' : layout === 'scatter' ? ', far apart' : '')
    + (v.curiosity > 0.65 ? ', reaching high' : '') + (v.militarism > 0.65 ? ', low and thick-walled' : '')
    + (quirks.includes('colossal') ? ', around great temples' : '') + (quirks.includes('lanterns') ? ', lit by lanterns' : '');
  return { ...b, layout, tall, scale, wall, accent, quirks, summary };
}
