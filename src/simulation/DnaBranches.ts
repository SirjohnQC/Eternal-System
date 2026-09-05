/**
 * DnaBranches — the player's investable evolutionary levers, generated per universe.
 *
 * These used to be eight hard-coded fields (`intelligence`, `aggression`, …) baked
 * into an interface, into the DNA Lab's markup, and into a dozen direct reads like
 * `playerDNA.adaptation` scattered through the engine. Every universe therefore
 * offered exactly the same eight choices.
 *
 * Now a universe draws its branches from a pool, so what you *can* invest in is
 * itself part of what makes a playthrough different. The simulation never names a
 * branch: it asks for an EFFECT ("how much tech speed does this genome buy?") and
 * whichever branches this universe happens to have contribute to it.
 */

import type { SeedRNG } from '../utils/SeedRNG';

/**
 * What the simulation can ask for. Branches map onto these; the sim only ever
 * queries by effect, never by branch name.
 */
export type EffectKind =
  | 'techSpeed'        // civilisation advances faster
  | 'bioResilience'    // life spreads faster, Great Filters bite less
  | 'bodySize'         // biases body-size mutations upward
  | 'mobility'         // locomotion / environment transitions, fleet range
  | 'social'           // religion emerges earlier, alliances
  | 'aggression'       // war tendency, territorial expansion
  | 'sensory'          // fog-of-war reveal, earlier vision
  | 'longevity'        // star lifespan, entropy resistance
  | 'mutability'       // raw mutation rate — more change, in any direction
  | 'divergence'       // speciation rate — lineages split more readily
  | 'metabolism'       // pushes metabolic strategy shifts
  | 'intellectGrowth'; // raises the ceiling on intelligence gains

/** Genome traits a branch can bias during mutation. */
export type TraitBias =
  | 'intelligence' | 'aggression' | 'social' | 'adaptability'
  | 'size' | 'locomotion' | 'environment' | 'metabolism' | 'diet' | 'respiration';

export interface BranchDef {
  id:      string;
  label:   string;
  glyph:   string;
  color:   string;
  blurb:   string;
  effects: Partial<Record<EffectKind, number>>;
  bias:    Partial<Record<TraitBias, number>>;
}

/**
 * The pool. Far more than any one universe uses, so the eight you get are a
 * genuine roll. Each entry is a plausible evolutionary investment rather than a
 * generic stat, which is what makes the choice interesting.
 */
export const BRANCH_POOL: BranchDef[] = [
  { id: 'cortex', label: 'Cortex', glyph: '◎', color: '#44aaff',
    blurb: 'Folded neural tissue. Thought becomes cheap.',
    effects: { techSpeed: 1.0, intellectGrowth: 0.8 }, bias: { intelligence: 1.0 } },
  { id: 'chitin', label: 'Chitin', glyph: '⬢', color: '#c8a05a',
    blurb: 'Hardened exoskeleton. Cheap armour, hard limits.',
    effects: { bioResilience: 0.6, bodySize: -0.3 }, bias: { adaptability: 0.6, size: -0.4 } },
  { id: 'symbiosis', label: 'Symbiosis', glyph: '◈', color: '#44cc88',
    blurb: 'Two lineages, one metabolism. Neither survives alone.',
    effects: { bioResilience: 0.9, divergence: 0.5 }, bias: { adaptability: 0.8, metabolism: 0.6 } },
  { id: 'photophore', label: 'Photophore', glyph: '⚶', color: '#7ce8d8',
    blurb: 'Light made flesh. Signalling, luring, blinding.',
    effects: { social: 0.6, sensory: 0.7 }, bias: { social: 0.5, metabolism: 0.4 } },
  { id: 'hivemind', label: 'Hivemind', glyph: '✦', color: '#cc88ff',
    blurb: 'Individuals stop mattering. The colony decides.',
    effects: { social: 1.1, techSpeed: 0.4 }, bias: { social: 1.0, intelligence: 0.3 } },
  { id: 'regrowth', label: 'Regrowth', glyph: '◊', color: '#88dd66',
    blurb: 'Lost limbs return. So does lost territory.',
    effects: { bioResilience: 1.0, longevity: 0.6 }, bias: { adaptability: 0.9 } },
  { id: 'toxicity', label: 'Toxicity', glyph: '⟁', color: '#a8e04a',
    blurb: 'Chemistry as a weapon. Nothing eats you twice.',
    effects: { aggression: 0.8, bioResilience: 0.4 }, bias: { aggression: 0.8, diet: 0.4 } },
  { id: 'endurance', label: 'Endurance', glyph: '✧', color: '#ffcc44',
    blurb: 'Slow, patient, and very hard to finish off.',
    effects: { longevity: 1.1, bioResilience: 0.5 }, bias: { adaptability: 0.6, size: 0.3 } },
  { id: 'buoyancy', label: 'Buoyancy', glyph: '⌇', color: '#66c8ff',
    blurb: 'Control of depth. The water column opens up.',
    effects: { mobility: 0.9 }, bias: { locomotion: 0.8, environment: 0.7 } },
  { id: 'mimicry', label: 'Mimicry', glyph: '⊛', color: '#d8a0e0',
    blurb: 'Become something else. Predators lose interest.',
    effects: { bioResilience: 0.7, sensory: 0.5 }, bias: { adaptability: 0.7, aggression: -0.3 } },
  { id: 'lattice', label: 'Lattice', glyph: '✷', color: '#b0b8c8',
    blurb: 'Internal scaffolding. Bodies can finally get big.',
    effects: { bodySize: 1.1 }, bias: { size: 1.0, locomotion: 0.3 } },
  { id: 'venom', label: 'Venom', glyph: '⧫', color: '#ff6644',
    blurb: 'Delivered chemistry. Small things kill large ones.',
    effects: { aggression: 1.0 }, bias: { aggression: 1.0, diet: 0.6 } },
  { id: 'echolocation', label: 'Echolocation', glyph: '⟐', color: '#44ffcc',
    blurb: 'Seeing with sound. Darkness stops being a barrier.',
    effects: { sensory: 1.1, mobility: 0.4 }, bias: { environment: 0.5, intelligence: 0.3 } },
  { id: 'thermogenesis', label: 'Thermogenesis', glyph: '♨', color: '#ff9944',
    blurb: 'Burning fuel for warmth. Cold worlds open up.',
    effects: { bioResilience: 0.8, metabolism: 0.7 }, bias: { metabolism: 0.8, adaptability: 0.5 } },
  { id: 'spore', label: 'Spore Dispersal', glyph: '❋', color: '#c0e070',
    blurb: 'Reproduction cast to the wind. Range over care.',
    effects: { divergence: 1.0, mobility: 0.5 }, bias: { environment: 0.6, adaptability: 0.4 } },
  { id: 'plasticity', label: 'Plasticity', glyph: '∿', color: '#ff88cc',
    blurb: 'The body reshapes within a lifetime.',
    effects: { mutability: 1.2, bioResilience: 0.4 }, bias: { adaptability: 0.8 } },
  { id: 'carapace', label: 'Carapace', glyph: '⌂', color: '#8a7a5a',
    blurb: 'A fortress you carry. Slow but nearly unkillable.',
    effects: { longevity: 0.9, aggression: -0.3 }, bias: { size: 0.5, adaptability: 0.5 } },
  { id: 'flight', label: 'Aerofoil', glyph: '⩚', color: '#a8d8ff',
    blurb: 'Surfaces that bite the air. The sky becomes habitat.',
    effects: { mobility: 1.2 }, bias: { locomotion: 1.0, environment: 0.8, size: -0.4 } },
  { id: 'photosynth', label: 'Chloroplast', glyph: '☘', color: '#5ab04a',
    blurb: 'Food from light. Never hunt again.',
    effects: { metabolism: 1.1, bioResilience: 0.5 }, bias: { metabolism: 1.0, diet: -0.6, locomotion: -0.5 } },
  { id: 'gigantism', label: 'Gigantism', glyph: '⬟', color: '#d0a060',
    blurb: 'Scale as a strategy. Nothing preys on the enormous.',
    effects: { bodySize: 1.3, aggression: 0.3 }, bias: { size: 1.2 } },
  { id: 'neoteny', label: 'Neoteny', glyph: '☽', color: '#ffb0d0',
    blurb: 'Never quite grow up. Juvenile traits, adult minds.',
    effects: { intellectGrowth: 1.0, mutability: 0.6 }, bias: { intelligence: 0.7, size: -0.5 } },
  { id: 'burrow', label: 'Fossorial', glyph: '⊓', color: '#a08060',
    blurb: 'Life below the surface. Catastrophes pass overhead.',
    effects: { bioResilience: 1.2, longevity: 0.4 }, bias: { environment: 0.6, adaptability: 0.7 } },
  { id: 'pack', label: 'Pack Instinct', glyph: '⩶', color: '#ff9060',
    blurb: 'Coordinated hunting. The group outthinks the prey.',
    effects: { aggression: 0.7, social: 0.8, techSpeed: 0.3 }, bias: { social: 0.7, aggression: 0.6, diet: 0.5 } },
  { id: 'anaerobe', label: 'Anaerobiosis', glyph: '⊘', color: '#9070b0',
    blurb: 'Life without oxygen. Poisoned worlds are home.',
    effects: { bioResilience: 1.0, metabolism: 0.6 }, bias: { respiration: 1.0, adaptability: 0.6 } },
  { id: 'bioluminescence', label: 'Deep Radiance', glyph: '✺', color: '#70e0ff',
    blurb: 'Cold light in lightless places.',
    effects: { sensory: 0.8, social: 0.5 }, bias: { environment: 0.5, social: 0.4 } },
  { id: 'tool', label: 'Manipulators', glyph: '⋔', color: '#e0c060',
    blurb: 'Limbs that grasp. Everything else follows from this.',
    effects: { techSpeed: 1.2, intellectGrowth: 0.6 }, bias: { intelligence: 0.8, locomotion: 0.4 } },
  { id: 'colonial', label: 'Coloniality', glyph: '⁘', color: '#88c0a0',
    blurb: 'Many bodies acting as one organism.',
    effects: { divergence: 0.8, social: 0.6, bodySize: 0.5 }, bias: { social: 0.6, size: 0.5 } },
  { id: 'cryptobiosis', label: 'Cryptobiosis', glyph: '❄', color: '#b0d8f0',
    blurb: 'Suspend everything and wait out the apocalypse.',
    effects: { longevity: 1.3, bioResilience: 0.9 }, bias: { adaptability: 1.0 } },
];

/** How many branches a universe offers. Matches the DNA Lab's layout. */
export const BRANCH_COUNT = 8;

/**
 * Roll this universe's branch set.
 *
 * Guarantees at least one branch that advances technology and one that helps
 * life survive, so no seed produces a universe the player cannot progress in.
 */
export function generateBranchSet(rng: SeedRNG): BranchDef[] {
  const pool = [...BRANCH_POOL];
  const picked: BranchDef[] = [];

  const takeWith = (kind: EffectKind) => {
    const candidates = pool.filter(b => (b.effects[kind] ?? 0) > 0.5);
    if (candidates.length === 0) return;
    const chosen = candidates[rng.nextInt(0, candidates.length - 1)];
    picked.push(chosen);
    pool.splice(pool.indexOf(chosen), 1);
  };

  takeWith('techSpeed');
  takeWith('bioResilience');

  while (picked.length < BRANCH_COUNT && pool.length > 0) {
    const i = rng.nextInt(0, pool.length - 1);
    picked.push(pool[i]);
    pool.splice(i, 1);
  }

  // Stable display order so the panel does not reshuffle between renders.
  picked.sort((a, b) => a.label.localeCompare(b.label));
  return picked;
}

// ─── Investment cost ──────────────────────────────────────────────────────────

/**
 * What the NEXT point in a branch costs, given how far it has already been
 * pushed and how far the biosphere has climbed.
 *
 * Every point used to cost exactly one, forever, which made the lab a slider
 * rather than a decision — there was never a reason not to spread points thin.
 * Cost now rises with the depth of the investment, so specialising deeply is a
 * real commitment, and with the biology phase, so late change is expensive and
 * early direction matters.
 *
 * @param current how many points are already in this branch
 * @param phaseIndex position on `BIO_PHASE_SEQUENCE`, 0 = microbial
 */
export function dnaPointCost(current: number, phaseIndex: number): number {
  // Every 10 points in, the next one costs one more.
  const depth = 1 + Math.floor(Math.max(0, current) / 10);
  // And every second phase up the ladder adds a surcharge on top.
  //
  // Both curves are deliberately gentler than they first look. Priced any
  // steeper, escalating cost outruns the income granted per phase and the lab
  // ends up buying LESS than the old flat economy did — measured, see
  // `tools/dnaEconomyCheck.ts`. That is the same fault that made the DNA lab
  // decorative in the first place (ROADMAP M20d), arrived at from the other
  // direction.
  return depth + Math.floor(Math.max(0, phaseIndex) / 2);
}

/** Total cost to take a branch from 0 to `target`, at a fixed phase. */
export function dnaTotalCost(target: number, phaseIndex: number): number {
  let sum = 0;
  for (let i = 0; i < target; i++) sum += dnaPointCost(i, phaseIndex);
  return sum;
}

/** A fresh, all-zero investment record for a branch set. */
export function emptyInvestment(defs: BranchDef[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of defs) out[d.id] = 0;
  return out;
}

/**
 * Total strength of an effect, 0–1 per point invested.
 *
 * This is how the simulation reads DNA. It never mentions a branch by name, so
 * a universe whose branches are Venom and Cryptobiosis works exactly as well as
 * one with Cortex and Regrowth.
 */
export function branchEffect(
  dna: Record<string, number>,
  defs: BranchDef[],
  kind: EffectKind,
): number {
  let total = 0;
  for (const d of defs) {
    const weight = d.effects[kind];
    if (!weight) continue;
    total += ((dna[d.id] ?? 0) / 100) * weight;
  }
  return total;
}

/** Combined bias toward one genome trait, summed across invested branches. */
export function traitBias(
  dna: Record<string, number>,
  defs: BranchDef[],
  trait: TraitBias,
): number {
  let total = 0;
  for (const d of defs) {
    const weight = d.bias[trait];
    if (!weight) continue;
    total += ((dna[d.id] ?? 0) / 100) * weight;
  }
  return total;
}

/** Look a branch definition up by id, for UI and saves. */
export function branchById(defs: BranchDef[], id: string): BranchDef | null {
  return defs.find(d => d.id === id) ?? null;
}

/**
 * Rebuild definitions from ids.
 *
 * Saves store only the ids, so a save keeps working if a branch's wording or
 * colour is later tweaked. Unknown ids are dropped rather than crashing a load.
 */
export function branchesFromIds(ids: string[]): BranchDef[] {
  const out: BranchDef[] = [];
  for (const id of ids) {
    const def = BRANCH_POOL.find(b => b.id === id);
    if (def) out.push(def);
  }
  return out;
}
