/**
 * Mutations — the player's evolution cards for the signature species
 * (docs/superpowers/specs/2026-10-04-signature-species-evolution-design.md).
 *
 * Each card is a concrete body change with a guaranteed genome effect. Every
 * card moves at least one gene that SpeciesSprite draws, so buying it changes
 * the creature you see. Cards are queued, then applied together as one
 * evolution (a new "form").
 *
 * Pure: no engine, no DOM.
 */
import type { SpeciesGenome, SpeciesSize } from './SpeciesGenome';
import type { BiologyPhase } from './GameState';
import { BIO_PHASE_SEQUENCE } from './GameState';
import type { EffectKind } from './DnaBranches';
import { SIZE_ORDER, repair } from './EvolutionEngine';
import { SeedRNG } from '../utils/SeedRNG';

/** Genome traits natural drift can move; an owned card locks the ones it sets. */
export type LockableTrait =
  | 'intelligence' | 'social' | 'aggression' | 'adaptability' | 'size'
  | 'locomotion' | 'environment' | 'metabolism' | 'diet' | 'respiration';

export interface MutationDef {
  id: string;
  label: string;
  glyph: string;
  blurb: string;
  /** Earliest biology phase the card is offered in. */
  phase: BiologyPhase;
  cost: number;
  /** One card per group: a fork. */
  group?: string;
  /** At least one of these must be owned (or queued ahead of it). */
  requiresAny?: string[];
  /** A major change evolves on its own, without a second card. */
  major?: boolean;
  /** Always offered. Optional cards are rolled in or out per universe. */
  core?: boolean;
  /** Traits drift may no longer move once owned. */
  locks: LockableTrait[];
  /** Simulation effects, read by the engine's playerEffect. */
  effects: Partial<Record<EffectKind, number>>;
  /** Genome precondition; a reason string when the body cannot take it. */
  blockedBy?: (g: SpeciesGenome) => string | null;
  /** The change itself. Must leave a coherent genome (repair runs after). */
  apply: (g: SpeciesGenome) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const si = (s: SpeciesSize) => Math.max(0, SIZE_ORDER.indexOf(s));
const sizeAtLeast = (g: SpeciesGenome, s: SpeciesSize) => {
  if (si(g.physicalTraits.size) < si(s)) g.physicalTraits.size = s;
};
const sizeAtMost = (g: SpeciesGenome, s: SpeciesSize) => {
  if (si(g.physicalTraits.size) > si(s)) g.physicalTraits.size = s;
};
const sizeUp = (g: SpeciesGenome, n: number) => {
  g.physicalTraits.size = SIZE_ORDER[Math.min(SIZE_ORDER.length - 1, si(g.physicalTraits.size) + n)];
};
const clamp10 = (v: number) => Math.max(0, Math.min(10, v));
const notPlant = (g: SpeciesGenome) => {
  if (g.dna.metabolism === 'photosynthetic' || g.dna.metabolism === 'chemosynthetic') g.dna.metabolism = 'heterotrophic';
};
const needsBody = (g: SpeciesGenome) =>
  g.physicalTraits.bodyStructure === 'single-celled' ? 'Needs a many-celled body first' : null;
/** Early body plans cannot replace a skeleton once one has grown. */
const noSkeleton = (g: SpeciesGenome) =>
  g.physicalTraits.bodyStructure === 'vertebrate' || g.physicalTraits.bodyStructure === 'exoskeletal'
    ? 'Already has a skeleton' : null;

// ─── The catalog ─────────────────────────────────────────────────────────────

export const MUTATIONS: MutationDef[] = [
  // ── Microbial ──────────────────────────────────────────────────────────────
  { id: 'chloroplasts', label: 'Chloroplasts', glyph: '☀', phase: 'microbial', cost: 4, group: 'energy', core: true,
    blurb: 'Eat sunlight. Green, slow, and everywhere the light reaches.',
    locks: ['metabolism', 'diet'], effects: { bioResilience: 0.15 },
    apply: g => { g.dna.metabolism = 'photosynthetic'; g.dna.diet = 'producer';
      if (g.dna.environment === 'deep_sea') g.dna.environment = 'ocean'; } },
  { id: 'engulfing', label: 'Engulfing Membrane', glyph: '◐', phase: 'microbial', cost: 4, group: 'energy', core: true,
    blurb: 'Swallow your neighbours whole. The first predator.',
    locks: ['metabolism', 'diet'], effects: { mutability: 0.12, aggression: 0.1 },
    apply: g => { g.dna.metabolism = 'heterotrophic'; g.dna.diet = 'omnivore'; } },
  { id: 'vent_chemistry', label: 'Vent Chemistry', glyph: '♨', phase: 'microbial', cost: 4, group: 'energy',
    blurb: 'Feed on sulphur in the dark, by the heat of the deep vents.',
    locks: ['metabolism', 'environment'], effects: { bioResilience: 0.2 },
    apply: g => { g.dna.metabolism = 'chemosynthetic'; g.dna.diet = 'producer'; g.dna.environment = 'deep_sea';
      g.physicalTraits.sensorySystem = 'thermal pits'; } },
  { id: 'flagellum', label: 'Whip Flagellum', glyph: '∿', phase: 'microbial', cost: 3, core: true,
    blurb: 'A lashing tail. Go where the food is instead of waiting for it.',
    locks: ['locomotion'], effects: { mobility: 0.15 },
    apply: g => { g.dna.locomotion = 'swimming'; g.physicalTraits.mobilityType = 'flagella';
      if (g.dna.environment === 'land' || g.dna.environment === 'aerial') g.dna.environment = 'coastal'; } },
  { id: 'oxygen', label: 'Oxygen Breathing', glyph: '○', phase: 'microbial', cost: 4, core: true,
    blurb: 'Burn oxygen for ten times the energy. Weak until the air fills with it.',
    locks: ['respiration'], effects: { bioResilience: 0.1, intellectGrowth: 0.1 },
    apply: g => { g.dna.respiration = 'aerobic'; } },
  { id: 'eyespot', label: 'Eyespot', glyph: '◉', phase: 'microbial', cost: 3, group: 'eyes',
    blurb: 'A speck of pigment that knows light from dark.',
    locks: [], effects: { sensory: 0.1 },
    apply: g => { g.physicalTraits.sensorySystem = 'photoreception'; } },
  { id: 'colony', label: 'Colony Bonds', glyph: '⁂', phase: 'microbial', cost: 5, core: true, major: true,
    blurb: 'Cells that stay together after dividing. The first step to a body.',
    locks: ['size'], effects: { social: 0.2, divergence: 0.1 },
    apply: g => { g.physicalTraits.bodyStructure = 'colonial'; sizeAtLeast(g, 'tiny');
      g.dna.social = clamp10(g.dna.social + 2); } },

  // ── Multicellular ──────────────────────────────────────────────────────────
  { id: 'shell', label: 'Mineral Shell', glyph: '⬡', phase: 'multicellular', cost: 6, group: 'body', core: true, major: true,
    blurb: 'A hard dome of chalk. Slow, safe, and very hard to kill.',
    locks: ['adaptability'], effects: { bioResilience: 0.25, longevity: 0.15 },
    blockedBy: noSkeleton,
    apply: g => { g.physicalTraits.bodyStructure = 'shelled'; sizeAtLeast(g, 'small');
      g.dna.adaptability = clamp10(g.dna.adaptability + 2); } },
  { id: 'segments', label: 'Segmented Body', glyph: '≡', phase: 'multicellular', cost: 6, group: 'body', core: true, major: true,
    blurb: 'A body of repeating rings. Room to grow anything on each one.',
    locks: [], effects: { mobility: 0.15, divergence: 0.15 },
    blockedBy: noSkeleton,
    apply: g => { g.physicalTraits.bodyStructure = 'segmented'; sizeAtLeast(g, 'small'); } },
  { id: 'jelly', label: 'Jelly Bell', glyph: '◠', phase: 'multicellular', cost: 6, group: 'body', major: true,
    blurb: 'A pulsing transparent bell that drifts with the currents.',
    locks: ['locomotion'], effects: { mutability: 0.15 },
    blockedBy: g => (g.dna.environment === 'land' || g.dna.environment === 'aerial') ? 'Lives in water only' : noSkeleton(g),
    apply: g => { g.physicalTraits.bodyStructure = 'gelatinous'; g.dna.locomotion = 'swimming';
      g.physicalTraits.mobilityType = 'undulating fringe'; sizeAtLeast(g, 'small'); } },
  { id: 'growth', label: 'Larger Body', glyph: '▲', phase: 'multicellular', cost: 5, core: true,
    blurb: 'Grow a size class. Bigger eats smaller.',
    locks: ['size'], effects: { bodySize: 0.2 },
    blockedBy: g => g.physicalTraits.bodyStructure === 'single-celled' ? 'Needs a many-celled body first' : null,
    apply: g => { sizeUp(g, 1); } },
  { id: 'crawling_foot', label: 'Crawling Foot', glyph: '⟂', phase: 'multicellular', cost: 5,
    blurb: 'A muscular foot to creep along the sea floor and the shore.',
    locks: ['locomotion'], effects: { mobility: 0.2 },
    blockedBy: needsBody,
    apply: g => { g.dna.locomotion = 'crawling'; g.physicalTraits.mobilityType = 'muscular foot';
      if (g.dna.environment === 'deep_sea' || g.dna.environment === 'ocean') g.dna.environment = 'coastal'; } },
  { id: 'gut', label: 'Gut Symbionts', glyph: '✿', phase: 'multicellular', cost: 5, group: 'diet',
    blurb: 'Bacteria in the gut that digest what nothing else can. A grazer.',
    locks: ['diet'], effects: { metabolism: 0.25, bioResilience: 0.1 },
    apply: g => { notPlant(g); g.dna.diet = 'herbivore'; g.dna.adaptability = clamp10(g.dna.adaptability + 1); } },

  // ── Complex ────────────────────────────────────────────────────────────────
  { id: 'backbone', label: 'Backbone', glyph: '┃', phase: 'complex', cost: 8, group: 'skeleton', core: true, major: true,
    blurb: 'A spine of cartilage and bone. The frame big bodies and big brains hang on.',
    locks: [], effects: { intellectGrowth: 0.2, bodySize: 0.15 },
    blockedBy: needsBody,
    apply: g => { g.physicalTraits.bodyStructure = 'vertebrate'; sizeAtLeast(g, 'small'); } },
  { id: 'exoskeleton', label: 'Exoskeleton', glyph: '⬢', phase: 'complex', cost: 8, group: 'skeleton', core: true, major: true,
    blurb: 'Armour on the outside. Tough, jointed, and quick to multiply.',
    locks: [], effects: { bioResilience: 0.2, divergence: 0.1 },
    blockedBy: needsBody,
    apply: g => { g.physicalTraits.bodyStructure = 'exoskeletal'; sizeAtLeast(g, 'small');
      g.dna.aggression = clamp10(g.dna.aggression + 1); } },
  { id: 'fins', label: 'Fins', glyph: '⟩', phase: 'complex', cost: 7, group: 'move', core: true,
    blurb: 'Steering fins. Fast in open water.',
    locks: ['locomotion'], effects: { mobility: 0.25 },
    blockedBy: needsBody,
    apply: g => { g.dna.locomotion = 'swimming'; g.physicalTraits.mobilityType = 'fins';
      if (g.dna.environment === 'land' || g.dna.environment === 'aerial') g.dna.environment = 'coastal'; } },
  { id: 'legs', label: 'Legs', glyph: '╨', phase: 'complex', cost: 10, group: 'move', core: true, major: true,
    requiresAny: ['backbone', 'exoskeleton', 'segments'],
    blurb: 'Walk out of the sea. A whole new world of dry land.',
    locks: ['locomotion', 'environment'], effects: { mobility: 0.35 },
    apply: g => { g.dna.locomotion = 'walking'; g.dna.environment = 'land'; sizeAtLeast(g, 'small');
      g.physicalTraits.mobilityType = 'legs';
      if (g.dna.metabolism === 'photosynthetic' || g.dna.metabolism === 'chemosynthetic') {
        g.dna.metabolism = 'heterotrophic'; if (g.dna.diet === 'producer') g.dna.diet = 'herbivore';
      } } },
  { id: 'wings', label: 'Wings', glyph: '⋀', phase: 'complex', cost: 11, group: 'move', major: true,
    requiresAny: ['backbone', 'exoskeleton', 'segments'],
    blurb: 'Take to the air. Light bodies only.',
    locks: ['locomotion', 'environment'], effects: { mobility: 0.45, sensory: 0.1 },
    apply: g => { g.dna.locomotion = 'flying'; g.dna.environment = 'aerial'; sizeAtMost(g, 'medium'); sizeAtLeast(g, 'small');
      g.physicalTraits.mobilityType = 'membrane wings'; notPlant(g);
      if (g.dna.diet === 'producer') g.dna.diet = 'omnivore'; } },
  { id: 'camera_eyes', label: 'Camera Eyes', glyph: '◎', phase: 'complex', cost: 7, group: 'eyes', core: true,
    blurb: 'A lens and a retina. See the world in detail.',
    locks: [], effects: { sensory: 0.3, intellectGrowth: 0.1 },
    apply: g => { g.physicalTraits.sensorySystem = 'vision'; } },
  { id: 'compound_eyes', label: 'Compound Eyes', glyph: '⁙', phase: 'complex', cost: 7, group: 'eyes',
    blurb: 'A thousand facets. Nothing moves without you seeing it.',
    locks: [], effects: { sensory: 0.3, aggression: 0.05 },
    apply: g => { g.physicalTraits.sensorySystem = 'compound eyes'; } },
  { id: 'echolocation', label: 'Echolocation', glyph: '◌', phase: 'complex', cost: 8, group: 'eyes',
    blurb: 'Hunt by echo in the dark water or the night air.',
    locks: [], effects: { sensory: 0.25, mobility: 0.1 },
    apply: g => { g.physicalTraits.sensorySystem = 'echolocation'; } },
  { id: 'grazing_jaws', label: 'Grinding Jaws', glyph: '⌓', phase: 'complex', cost: 7, group: 'diet', core: true,
    blurb: 'Flat teeth for plants. Many, peaceful, well fed.',
    locks: ['diet', 'aggression'], effects: { bioResilience: 0.15, social: 0.1 },
    apply: g => { notPlant(g); g.dna.diet = 'herbivore'; g.dna.aggression = clamp10(g.dna.aggression - 1); } },
  { id: 'hunting_jaws', label: 'Hunting Jaws', glyph: '▼', phase: 'complex', cost: 8, group: 'diet', core: true,
    blurb: 'Fangs and a taste for meat. Fewer, but feared.',
    locks: ['diet', 'aggression'], effects: { aggression: 0.3, intellectGrowth: 0.1 },
    apply: g => { notPlant(g); g.dna.diet = 'carnivore'; g.dna.aggression = clamp10(Math.max(5, g.dna.aggression + 2)); } },
  { id: 'venom', label: 'Venom Barbs', glyph: '✦', phase: 'complex', cost: 8,
    blurb: 'Spines that sting. Predators learn to leave you alone.',
    locks: ['aggression'], effects: { aggression: 0.25, bioResilience: 0.1 },
    blockedBy: needsBody,
    apply: g => { g.dna.aggression = clamp10(Math.max(6, g.dna.aggression + 2)); } },

  // ── Primitive ──────────────────────────────────────────────────────────────
  { id: 'big_brain', label: 'Bigger Brain', glyph: '◍', phase: 'primitive', cost: 12, core: true, major: true,
    requiresAny: ['backbone', 'exoskeleton'],
    blurb: 'A swollen cranium. Expensive to feed; it thinks.',
    locks: ['intelligence'], effects: { intellectGrowth: 0.4, techSpeed: 0.2 },
    apply: g => { g.dna.intelligence = clamp10(Math.max(5, g.dna.intelligence + 2)); sizeAtLeast(g, 'small');
      g.evolutionaryPotential.intelligenceGrowth = Math.min(1, g.evolutionaryPotential.intelligenceGrowth + 0.3); } },
  { id: 'pack_bonds', label: 'Pack Bonds', glyph: '⚇', phase: 'primitive', cost: 10, core: true,
    blurb: 'Live in groups, share food, raise young together.',
    locks: ['social'], effects: { social: 0.4, bioResilience: 0.1 },
    apply: g => { g.dna.social = clamp10(g.dna.social + 3); g.dna.reproduction = 'sexual'; } },
  { id: 'hands', label: 'Grasping Hands', glyph: '✋', phase: 'primitive', cost: 12, core: true, major: true,
    requiresAny: ['legs'],
    blurb: 'Free the front limbs and grip. Stand up; reach for things.',
    locks: ['intelligence', 'locomotion'], effects: { techSpeed: 0.3, intellectGrowth: 0.2 },
    blockedBy: g => g.dna.locomotion !== 'walking' ? 'Must walk on land' : null,
    apply: g => { g.dna.intelligence = clamp10(g.dna.intelligence + 1);
      g.evolutionaryPotential.toolUse = Math.min(1, g.evolutionaryPotential.toolUse + 0.4); } },
  { id: 'gigantism', label: 'Gigantism', glyph: '⬆', phase: 'primitive', cost: 11,
    blurb: 'Two size classes bigger. Nothing hunts a titan.',
    locks: ['size'], effects: { bodySize: 0.4, aggression: 0.1 },
    blockedBy: g => g.dna.locomotion === 'flying' ? 'Too heavy to fly' : needsBody(g),
    apply: g => { sizeUp(g, 2); } },
  { id: 'slow_ageing', label: 'Slow Ageing', glyph: '∞', phase: 'primitive', cost: 10,
    blurb: 'Long lives, few young, deep memory.',
    locks: ['adaptability'], effects: { longevity: 0.4, intellectGrowth: 0.1 },
    apply: g => { g.dna.adaptability = clamp10(g.dna.adaptability + 1); g.dna.reproduction = 'sexual'; } },

  // ── Intelligent ────────────────────────────────────────────────────────────
  { id: 'language', label: 'Language', glyph: '❝', phase: 'intelligent', cost: 15, core: true, major: true,
    blurb: 'Words. Knowledge outlives the one who learned it.',
    locks: ['social'], effects: { techSpeed: 0.4, social: 0.3 },
    apply: g => { g.dna.social = clamp10(g.dna.social + 2); g.dna.intelligence = clamp10(g.dna.intelligence + 1); } },
  { id: 'toolmaking', label: 'Toolmaking', glyph: '⚒', phase: 'intelligent', cost: 15, core: true,
    blurb: 'Shape stone and wood. The first technology.',
    locks: ['intelligence'], effects: { techSpeed: 0.5 },
    apply: g => { g.evolutionaryPotential.toolUse = 1; g.dna.intelligence = clamp10(g.dna.intelligence + 1); } },
  { id: 'star_sense', label: 'Star Sense', glyph: '✧', phase: 'intelligent', cost: 14,
    blurb: 'Feel the planet\'s magnetic field. Navigators born.',
    locks: [], effects: { sensory: 0.4, techSpeed: 0.15, mobility: 0.15 },
    apply: g => { g.physicalTraits.sensorySystem = 'magnetoreception'; } },
];

export const MUTATION_BY_ID: Record<string, MutationDef> =
  Object.fromEntries(MUTATIONS.map(m => [m.id, m]));

/** How many queued cards trigger an evolution (a major card alone also does). */
export const EVOLVE_THRESHOLD = 2;

// ─── Universe roll ───────────────────────────────────────────────────────────

/** Optional cards this universe offers. Core cards are always offered. */
export function rollUniverseMutations(seed: string): string[] {
  const rng = new SeedRNG(`mutations_${seed}`);
  return MUTATIONS.filter(m => m.core || rng.chance(0.6)).map(m => m.id);
}

// ─── State queries ───────────────────────────────────────────────────────────

export type CardStatus = 'owned' | 'queued' | 'available' | 'locked';

export interface CardState {
  def: MutationDef;
  status: CardStatus;
  /** Why it is locked, or why it cannot be afforded. */
  reason: string | null;
  affordable: boolean;
}

export interface MutationContext {
  genome: SpeciesGenome | null;
  phase: BiologyPhase;
  owned: readonly string[];
  queued: readonly string[];
  offered: readonly string[];
  points: number;
}

const phaseIdx = (p: BiologyPhase) => BIO_PHASE_SEQUENCE.indexOf(p);

/** The state of every card this universe offers, in catalog order. */
export function cardStates(ctx: MutationContext): CardState[] {
  const have = new Set([...ctx.owned, ...ctx.queued]);
  const groupsTaken = new Set<string>();
  for (const id of have) { const g = MUTATION_BY_ID[id]?.group; if (g) groupsTaken.add(g); }
  // Preconditions are checked against the body the queue will produce.
  const preview = ctx.genome ? previewGenome(ctx.genome, ctx.queued) : null;
  const out: CardState[] = [];
  for (const def of MUTATIONS) {
    if (!ctx.offered.includes(def.id)) continue;
    let status: CardStatus = ctx.owned.includes(def.id) ? 'owned'
      : ctx.queued.includes(def.id) ? 'queued' : 'available';
    let reason: string | null = null;
    if (status === 'available') {
      if (!preview) reason = 'No life yet';
      else if (phaseIdx(ctx.phase) < phaseIdx(def.phase)) reason = `Opens at ${def.phase} life`;
      else if (def.group && groupsTaken.has(def.group)) reason = 'Another path was chosen';
      else if (def.requiresAny && !def.requiresAny.some(r => have.has(r))) {
        reason = `Needs ${def.requiresAny.map(r => MUTATION_BY_ID[r]?.label ?? r).join(' or ')}`;
      } else reason = def.blockedBy?.(preview) ?? null;
      if (reason) status = 'locked';
    }
    const affordable = ctx.points >= def.cost;
    out.push({ def, status, reason, affordable });
  }
  return out;
}

/** Apply one card to a genome in place, then repair the rest of the body. */
export function applyMutation(g: SpeciesGenome, id: string): void {
  const def = MUTATION_BY_ID[id];
  if (!def) return;
  def.apply(g);
  repair(g);
}

/** A deep copy of a genome. */
export function cloneGenome(g: SpeciesGenome): SpeciesGenome {
  return {
    ...g, dna: { ...g.dna }, physicalTraits: { ...g.physicalTraits },
    habitat: { ...g.habitat }, evolutionaryPotential: { ...g.evolutionaryPotential },
  };
}

/** A deep copy of `g` with the queued cards applied in order. */
export function previewGenome(g: SpeciesGenome, queued: readonly string[]): SpeciesGenome {
  const c = cloneGenome(g);
  for (const id of queued) applyMutation(c, id);
  return c;
}

/** True when the queue is enough to evolve. */
export function queueReady(queued: readonly string[]): boolean {
  return queued.length >= EVOLVE_THRESHOLD || queued.some(id => MUTATION_BY_ID[id]?.major);
}

/** Traits drift may not move on the signature species. */
export function lockedTraits(owned: readonly string[]): Set<LockableTrait> {
  const s = new Set<LockableTrait>();
  for (const id of owned) for (const t of MUTATION_BY_ID[id]?.locks ?? []) s.add(t);
  return s;
}

/** Sum of an effect over owned cards, capped like a fully-invested branch. */
export function mutationEffect(owned: readonly string[], kind: EffectKind): number {
  let t = 0;
  for (const id of owned) t += MUTATION_BY_ID[id]?.effects[kind] ?? 0;
  return Math.min(1.2, t);
}

/** Readable differences between two forms, for the evolution reveal. */
export function genomeDiff(a: SpeciesGenome, b: SpeciesGenome): string[] {
  const rows: Array<[string, string, string]> = [
    ['Size', a.physicalTraits.size, b.physicalTraits.size],
    ['Body', a.physicalTraits.bodyStructure, b.physicalTraits.bodyStructure],
    ['Moves by', `${a.dna.locomotion}`, `${b.dna.locomotion}`],
    ['Limbs', a.physicalTraits.mobilityType, b.physicalTraits.mobilityType],
    ['Lives in', a.dna.environment.replace(/_/g, ' '), b.dna.environment.replace(/_/g, ' ')],
    ['Feeds as', a.dna.diet, b.dna.diet],
    ['Energy', a.dna.metabolism, b.dna.metabolism],
    ['Breathes', a.dna.respiration, b.dna.respiration],
    ['Senses', a.physicalTraits.sensorySystem, b.physicalTraits.sensorySystem],
    ['Intellect', `${a.dna.intelligence}`, `${b.dna.intelligence}`],
    ['Social', `${a.dna.social}`, `${b.dna.social}`],
    ['Aggression', `${a.dna.aggression}`, `${b.dna.aggression}`],
    ['Adaptability', `${a.dna.adaptability}`, `${b.dna.adaptability}`],
  ];
  return rows.filter(r => r[1] !== r[2]).map(([k, x, y]) => `${k}: ${x} → ${y}`);
}
