/**
 * Dev-only: does the rewritten evolution engine actually produce VARIETY?
 *
 * The previous engine walked every lineage up the same fixed ladder with the
 * same odds, so a planet reliably ended with five near-identical species and
 * every playthrough looked the same. This measures the two things that matter:
 *
 *   WITHIN a planet  — are the coexisting species different from each other?
 *   BETWEEN planets  — do different seeds produce different biospheres?
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/divergenceCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/div.mjs && node /tmp/div.mjs
 */

import { SeedRNG } from '../src/utils/SeedRNG';
import { stepEvolution, createFoundingSpecies } from '../src/simulation/EvolutionEngine';
import { DEFAULT_BIOSPHERE, type SpeciesGenome } from '../src/simulation/SpeciesGenome';
import { generateBranchSet, emptyInvestment, type BranchDef } from '../src/simulation/DnaBranches';

const LADDER = ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'] as const;

interface Run {
  seed: string;
  branches: string[];
  species: SpeciesGenome[];
  anomalies: number;
  extinctions: number;
  speciations: number;
}

function runPlanet(seed: string, invest: boolean): Run {
  const rng = new SeedRNG(seed);
  const defs: BranchDef[] = generateBranchSet(new SeedRNG(`br_${seed}`));
  const dna = emptyInvestment(defs);
  if (invest) {
    // Spend as a player might: heavily into two branches.
    dna[defs[0].id] = 60;
    dna[defs[1].id] = 40;
  }

  let species = [createFoundingSpecies(0, rng)];
  let bio = { ...DEFAULT_BIOSPHERE };
  let anomalies = 0, extinctions = 0, speciations = 0;

  for (let p = 0; p < LADDER.length; p++) {
    for (let i = 0; i < 130; i++) {
      const r = stepEvolution(LADDER[p], dna, species, bio, rng, (p * 130 + i) * 2000, defs);
      species = r.updatedSpecies;
      bio = r.updatedBiosphere;
      for (const e of r.events) {
        if (e.type === 'anomaly')    anomalies++;
        if (e.type === 'extinction') extinctions++;
        if (e.type === 'speciation') speciations++;
      }
    }
  }
  return {
    seed, branches: defs.map(d => d.label),
    species: species.filter(s => !s.isExtinct),
    anomalies, extinctions, speciations,
  };
}

/** Trait-level distance between two genomes, 0 (identical) to 1. */
function distance(a: SpeciesGenome, b: SpeciesGenome): number {
  let diff = 0, total = 0;
  const enums: (keyof SpeciesGenome['dna'])[] =
    ['metabolism', 'locomotion', 'environment', 'reproduction', 'diet', 'respiration'];
  for (const k of enums) { total++; if (a.dna[k] !== b.dna[k]) diff++; }
  total++; if (a.physicalTraits.size !== b.physicalTraits.size) diff++;
  total++; if (a.physicalTraits.bodyStructure !== b.physicalTraits.bodyStructure) diff++;
  const nums: (keyof SpeciesGenome['dna'])[] = ['intelligence', 'social', 'aggression', 'adaptability'];
  for (const k of nums) {
    total++;
    diff += Math.min(1, Math.abs((a.dna[k] as number) - (b.dna[k] as number)) / 5);
  }
  return diff / total;
}

function meanPairwise(species: SpeciesGenome[]): number {
  if (species.length < 2) return 0;
  let sum = 0, pairs = 0;
  for (let i = 0; i < species.length; i++)
    for (let j = i + 1; j < species.length; j++) { sum += distance(species[i], species[j]); pairs++; }
  return sum / pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
const runs: Run[] = [];
for (let i = 0; i < 8; i++) runs.push(runPlanet(`world_${i}`, i % 2 === 0));

console.log('\n── Within-planet divergence ──');
console.log('  seed        species  mean pairwise difference  niches (env/diet pairs)');
let totalDiv = 0;
for (const r of runs) {
  const div = meanPairwise(r.species);
  totalDiv += div;
  const niches = new Set(r.species.map(s => `${s.dna.environment}/${s.dna.diet}`)).size;
  console.log(`  ${r.seed.padEnd(10)} ${String(r.species.length).padStart(7)} ` +
              `${div.toFixed(2).padStart(24)} ${String(niches).padStart(22)}`);
}
console.log(`  mean divergence across planets: ${(totalDiv / runs.length).toFixed(2)}`);

console.log('\n── Between-planet variety ──');
const allSigs = runs.map(r =>
  r.species.map(s => `${s.dna.metabolism}/${s.dna.locomotion}/${s.dna.environment}/${s.physicalTraits.size}`)
    .sort().join(' | '));
const unique = new Set(allSigs).size;
console.log(`  ${unique}/${runs.length} planets produced a distinct biosphere signature`);

console.log('\n── Sample biospheres ──');
for (const r of runs.slice(0, 4)) {
  console.log(`\n  ${r.seed}  branches: ${r.branches.slice(0, 4).join(', ')}…`);
  console.log(`    speciations ${r.speciations}, extinctions ${r.extinctions}, anomalies ${r.anomalies}`);
  for (const s of r.species) {
    console.log(`    ${s.name.padEnd(30)} ${s.physicalTraits.size.padEnd(12)} ` +
                `${s.dna.locomotion.padEnd(11)} ${s.dna.environment.padEnd(9)} ` +
                `${s.dna.diet.padEnd(11)} int:${s.dna.intelligence}`);
  }
}
console.log('');
