/**
 * The living world's ecology (#112): a food web keeps different ways of life
 * side by side, splits move into open niches, extinction pressure means
 * something again, and the diorama's hunts and quarrels follow the food web.
 *
 *   - species: worlds hold several species once life is complex (not 2-4);
 *   - extinction pressure is not pinned at 1.0 (it was, on almost every world);
 *   - the food web: a hunter with prey thrives where one without starves,
 *     and prey loses to what hunts it;
 *   - encounters (src/rendering/Encounters.ts): hunts only on what the hunter
 *     eats, rivals share an environment and are not each other's food, every
 *     creature in at most one; a hunt closes in and a caught prey vanishes
 *     for the rest of the cycle; the same time gives the same pose.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/ecologyCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/eco.mjs --log-level=error && node /tmp/eco.mjs
 *
 * Exits non-zero if any check fails.
 */
import { SeedRNG } from '../src/utils/SeedRNG';
import { stepEvolution, createFoundingSpecies, preysOn } from '../src/simulation/EvolutionEngine';
import { DEFAULT_BIOSPHERE, type SpeciesGenome } from '../src/simulation/SpeciesGenome';
import { generateBranchSet, emptyInvestment } from '../src/simulation/DnaBranches';
import { planEncounters, poseAt, ENCOUNTER_PERIOD, type Creature } from '../src/rendering/Encounters';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) failed++;
};

const LADDER = ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'] as const;

// ── 1. Worlds: how many species, and the pressure ────────────────────────────
console.log('Ecology: worlds');
const late: number[] = [];
let pressureSum = 0, pressureN = 0, pinned = 0;
const worlds: SpeciesGenome[][] = [];
for (let w = 0; w < 10; w++) {
  const seed = `eco_${w}`;
  const rng = new SeedRNG(seed);
  const defs = generateBranchSet(new SeedRNG(`br_${seed}`));
  const dna = emptyInvestment(defs);
  let species = [createFoundingSpecies(0, rng)];
  let bio = { ...DEFAULT_BIOSPHERE };
  let step = 0, high = 0, n = 0;
  for (let p = 0; p < LADDER.length; p++) {
    for (let i = 0; i < 130; i++, step++) {
      const r = stepEvolution(LADDER[p], dna, species, bio, rng, step * 2000, defs);
      species = r.updatedSpecies; bio = r.updatedBiosphere;
      if (p >= 2) { late.push(species.filter(s => !s.isExtinct).length); pressureSum += bio.extinctionPressure; pressureN++; n++; if (bio.extinctionPressure > 0.95) high++; }
    }
  }
  if (high > n * 0.5) pinned++;
  worlds.push(species.filter(s => !s.isExtinct));
}
const mean = late.reduce((a, b) => a + b, 0) / late.length;
check('several species live together once life is complex', mean >= 6, `mean ${mean.toFixed(1)} alive (complex onward)`);
check('no world keeps a single species', worlds.every(ws => ws.length >= 2), worlds.map(ws => ws.length).join(' '));
const kinds = worlds.map(ws => new Set(ws.map(s => `${s.dna.environment}/${s.dna.diet}`)).size);
check('they live different ways (environment x diet)', kinds.reduce((a, b) => a + b, 0) / kinds.length >= 4, kinds.join(' '));
check('extinction pressure is not pinned at its ceiling', pinned === 0 && pressureSum / pressureN < 0.6,
  `mean ${(pressureSum / pressureN).toFixed(2)}, pinned on ${pinned}/10 worlds`);

// ── 2. The food web ─────────────────────────────────────────────────────────
console.log('Ecology: the food web');
const base = createFoundingSpecies(0, new SeedRNG('fw'));
const make = (id: string, env: SpeciesGenome['dna']['environment'], diet: SpeciesGenome['dna']['diet'], size: SpeciesGenome['physicalTraits']['size'], loc: SpeciesGenome['dna']['locomotion'] = 'walking', pop = 0.4): SpeciesGenome => ({
  ...base, id, name: id, population: pop, isExtinct: false,
  dna: { ...base.dna, environment: env, diet, locomotion: loc, metabolism: diet === 'producer' ? 'photosynthetic' : 'heterotrophic', respiration: 'aerobic', adaptability: 5, aggression: 5 },
  physicalTraits: { ...base.physicalTraits, size, bodyStructure: 'vertebrate' },
});
const plant = make('plant', 'land', 'producer', 'small', 'stationary');
const grazer = make('grazer', 'land', 'herbivore', 'medium');
const wolf = make('wolf', 'land', 'carnivore', 'medium');
const shark = make('shark', 'ocean', 'carnivore', 'large', 'swimming');
const titan = make('titan', 'land', 'herbivore', 'massive');
check('grazers eat plants, hunters eat animals', preysOn(grazer, plant) > 0 && preysOn(wolf, grazer) > 0 && preysOn(wolf, plant) === 0 && preysOn(grazer, wolf) === 0);
check('only where both can meet (a sea hunter does not hunt land grazers)', preysOn(shark, grazer) === 0);
check('a hunter cannot take prey far bigger than itself', preysOn(wolf, titan) === 0);
const bio = { ...DEFAULT_BIOSPHERE, biosphereDensity: 0.5, landLife: 0.6, oceanLife: 0.6, oxygenLevel: 0.6, extinctionPressure: 0.1 };
const popAfter = (pool: SpeciesGenome[], id: string, steps = 25) => {
  let sp = pool.map(s => ({ ...s, dna: { ...s.dna }, physicalTraits: { ...s.physicalTraits } }));
  const rng = new SeedRNG(`fw_${id}_${pool.length}`);
  let b = { ...bio };
  for (let i = 0; i < steps; i++) { const r = stepEvolution('complex', {}, sp, b, rng, i * 2000, []); sp = r.updatedSpecies; b = { ...r.updatedBiosphere, extinctionPressure: 0.1 }; }
  return sp.find(s => s.id === id)?.population ?? 0;
};
// One step: selection runs first, so a single step isolates the food web from
// the noise of mutation and new species.
const fedWolf = popAfter([plant, grazer, wolf], 'wolf', 1);
const starvedWolf = popAfter([plant, make('plant2', 'land', 'producer', 'tiny', 'stationary'), wolf], 'wolf', 1);
check('a hunter with prey does better than one with none', fedWolf > starvedWolf, `${fedWolf.toFixed(3)} vs ${starvedWolf.toFixed(3)}`);
const huntedGrazer = popAfter([plant, grazer, wolf], 'grazer', 1);
// The control: a land hunter too small to take it (nearly the same rival, no predation).
const safeGrazer = popAfter([plant, grazer, make('wolfling', 'land', 'carnivore', 'tiny')], 'grazer', 1);
check('prey does worse with a hunter about', huntedGrazer < safeGrazer, `${huntedGrazer.toFixed(3)} vs ${safeGrazer.toFixed(3)}`);

// ── 3. Encounters on the diorama ─────────────────────────────────────────────
console.log('Ecology: encounters (the view)');
let pairs = 0, badHunt = 0, badClash = 0, twice = 0, hunts = 0, clashes = 0, closes = 0, vanish = 0, nondet = 0;
for (let w = 0; w < worlds.length; w++) {
  const ws = worlds[w];
  const rng = new SeedRNG(`place_${w}`);
  const list: Creature[] = [];
  for (let i = 0; i < 40; i++) list.push({ wx: rng.nextFloat(0, 300), wy: rng.nextFloat(0, 150), genome: ws[rng.nextInt(0, ws.length - 1)] });
  const es = planEncounters(list, 70);
  pairs += es.length;
  const seen = new Set<number>();
  for (const e of es) {
    if (seen.has(e.a) || seen.has(e.b)) twice++;
    seen.add(e.a); seen.add(e.b);
    const A = list[e.a].genome, B = list[e.b].genome;
    if (e.kind === 'hunt') {
      hunts++;
      if (!(preysOn(A, B) > 0) || B.dna.diet === 'producer' || A.dna.locomotion === 'stationary') badHunt++;
      const gap = (t: number) => { const p = poseAt(e, list, t); const a = list[e.a], b = list[e.b];
        return Math.hypot(a.wx + p.a.dx - (b.wx + p.b.dx), a.wy + p.a.dy - (b.wy + p.b.dy)); };
      const t0 = -e.offset * ENCOUNTER_PERIOD;   // the start of a cycle
      if (gap(t0 + 11.4) < gap(t0 + 2) * 0.5) closes++;
      const after = poseAt(e, list, t0 + 13);
      if (after.b.hidden) vanish++;
    } else {
      clashes++;
      if (A.dna.environment !== B.dna.environment || preysOn(A, B) > 0 || preysOn(B, A) > 0 || A.dna.diet === 'producer') badClash++;
    }
    for (const t of [3.3, 10.1, 12.7]) if (JSON.stringify(poseAt(e, list, t)) !== JSON.stringify(poseAt(e, list, t))) nondet++;
  }
}
check('creatures meet: hunts and quarrels are planned', pairs > 0 && hunts > 0 && clashes > 0, `${hunts} hunts, ${clashes} quarrels over 10 worlds`);
check('a hunt is only ever on something the hunter eats', badHunt === 0, `${badHunt}`);
check('rivals share an environment and are not each other\'s food', badClash === 0, `${badClash}`);
check('each creature is in at most one encounter', twice === 0, `${twice}`);
check('a hunter closes in on its prey', closes === hunts, `${closes}/${hunts}`);
check('some prey are caught (and vanish), some escape', vanish > 0 && vanish < hunts, `${vanish}/${hunts} caught this cycle`);
check('the same time gives the same pose', nondet === 0);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall ecology checks passed');
process.exit(failed ? 1 : 0);
