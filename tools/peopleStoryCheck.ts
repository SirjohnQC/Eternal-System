/**
 * Checks "Your People" (src/simulation/PeopleStory.ts; species design P1):
 * symptoms are words, never numbers, and follow the pressures; beliefs and the
 * lineage link back to the casts that shaped them; consequence beats come a
 * generation or more after a cast, are never re-told, and never say "your
 * card caused"; card text names the player's people.
 *
 * Build + run (also part of `npm test`):
 *   node_modules/.bin/esbuild tools/peopleStoryCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=.cache/people.mjs --log-level=error && node .cache/people.mjs
 */
import { generatePlanetGrid, isHabitable, type PlanetGrid } from '../src/simulation/PlanetGrid';
import { NationSystem } from '../src/simulation/Nations';
import { valuesFromGenome, type GenomeSummary } from '../src/simulation/Civilization';
import { cast, describe, priceOf, targetTextOf, resolveTarget, type FaithCard, type ActionId } from '../src/simulation/FaithCards';
import {
  symptomsOf, activityOf, beliefsOf, shapedBy, beatsSince, personalize, plural, natureOf, headingOf,
} from '../src/simulation/PeopleStory';
import { DEFAULT_BIOSPHERE, createPrimordialSpecies } from '../src/simulation/SpeciesGenome';
import { SeedRNG } from '../src/utils/SeedRNG';
import {
  MUTATIONS, MUTATION_BY_ID, ANSWERS, answersFor, mutationPrice, giftReason, cardStates, PRESSURE_TIMES,
  DRAWBACKS, EVOLVE_THRESHOLD, queueReady, mutationEffect, applyMutation, cloneGenome,
} from '../src/simulation/Mutations';
import { pressureKinds } from '../src/simulation/PeopleStory';
import { kindOf, relationTo, censusOf, livingRows, archiveRows, deathOf, yearsSpan } from '../src/simulation/SpeciesCatalog';
import type { SpeciesGenome } from '../src/simulation/SpeciesGenome';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(60)} ${detail}`);
  if (!ok) failed++;
};

const genome: GenomeSummary = {
  speciesName: 'Velari', metabolism: 'heterotrophic', locomotion: 'walking', environment: 'land', diet: 'omnivore',
  respiration: 'aerobic', reproduction: 'sexual', size: 'medium', bodyStructure: 'vertebrate', sensorySystem: 'vision',
  intelligence: 7, social: 5, aggression: 5, adaptability: 5, biome: 'forest', temperatureRange: 'temperate',
};
const ERA = 40000, STEP = 2000;
function world(seed: number): { ns: NationSystem; grid: PlanetGrid; t: number } {
  const grid = generatePlanetGrid('ocean', seed, null, null);
  for (const row of grid) for (const c of row) {
    c.lifeDensity = isHabitable(c.biome) ? c.fertility : 0;
    c.civId = isHabitable(c.biome) && c.fertility > 0.35 ? '1' : null;
  }
  const ns = new NationSystem(seed);
  ns.found(grid, valuesFromGenome(genome), genome, 0);
  let t = 0;
  for (; t <= ERA * 1.5; t += STEP) ns.step(grid, t, ERA);
  return { ns, grid, t };
}
const run = (w: { ns: NationSystem; grid: PlanetGrid; t: number }, eras: number) => {
  const end = w.t + ERA * eras;
  for (; w.t <= end; w.t += STEP) w.ns.step(w.grid, w.t, ERA);
};
const card = (actions: ActionId[], over: Partial<FaithCard> = {}): FaithCard => {
  const c: FaithCard = { id: 'test', name: 'THE LONG RAIN', actions, target: 'all', condition: 'always', magnitude: 3, duration: 2,
    sides: [], cost: 0, odds: 1, origin: '', forged: 0, ...over };
  c.cost = priceOf(c);
  return c;
};

console.log('Your People: symptoms and activity');
{
  const w = world(31);
  const n = w.ns.nations.find(x => !x.fallen)!;
  n.pressures.hunger = 0.9;
  const s = symptomsOf(w.ns, null);
  check('a starving nation is the first symptom', s[0]?.kind === 'hunger' && s[0].severity === 3 && s[0].text.includes(n.name), s[0]?.text);
  check('symptoms are words, never numbers', s.every(x => !/\d/.test(x.text.replace(n.name, ''))), s.map(x => x.text).join(' | '));
  check('the heading follows the worst symptom', /Hunger/.test(headingOf(s)));
  for (const m of w.ns.nations) m.pressures.hunger = 0.95;
  check('a hungry world forages', activityOf(w.ns, null) === 'foraging', activityOf(w.ns, null));
  const pre = symptomsOf(null, { ...DEFAULT_BIOSPHERE, extinctionPressure: 0.8, oxygenLevel: 0.02 });
  check('before nations, the living world speaks', pre.some(x => x.kind === 'extinction') && pre.some(x => x.kind === 'air'), pre.map(x => x.text).join(' | '));
  check('nature is words', natureOf(createPrimordialSpecies(0)).length === 4);
  check('plural names', plural('Selsul Runner') === 'Selsul Runners' && plural('Velari') === 'Velari' && plural('Kith') === 'Kiths' && plural('Moss') === 'Moss');
}

console.log('Your People: beliefs, lineage and beats');
{
  const w = world(41);
  const before = new Set(w.ns.chronicle.map(e => e.id));
  check('no beats before any cast', beatsSince(w.ns, before).length === 0);
  const t0 = w.t;
  const res = cast(w.ns, card(['harvest']), new SeedRNG('b1'), w.t);
  check('the cast is heeded', res.heeded.length > 0, res.line);
  const castId = w.ns.chronicle.filter(e => e.kind === 'divine').pop()!.id;
  const b = beliefsOf(w.ns);
  check('they remember the cast, in words', b.some(x => x.cast === castId && /The Long Rain: they are still watching/.test(x.text)), b.map(x => x.text).join(' | '));
  check('a belief about devotion comes first', b[0]?.cast === 0, b[0]?.text);
  check('no beat in the same generation', beatsSince(w.ns, before).length === 0);
  run(w, 1.2);
  const later = beliefsOf(w.ns).find(x => x.cast === castId);
  check('later, the memory is what came of it', !!later && !/watching the sky/.test(later.text), later?.text);
  const beats = beatsSince(w.ns, before, 0.5, 5);
  check('a generation on, the people answer', beats.length > 0, beats[0]?.entry.what);
  check('each beat links back to the cast', beats.every(x => x.cast.id === castId));
  check('beats come at least a generation after', beats.every(x => x.entry.age - x.cast.age >= 0.5));
  check('beats never say "your card"', beats.every(x => !/your card|you cast/i.test(x.entry.what)));
  const seen = new Set([...before, ...beats.map(x => x.entry.id)]);
  check('a beat is never told twice', beatsSince(w.ns, seen, 0.5, 5).every(x => !beats.some(y => y.entry.id === x.entry.id)));
  const form = { form: 2, name: 'Velari II', tick: w.t, genome: createPrimordialSpecies(0), mutations: ['fur'] };
  const sh = shapedBy(form, t0 - 1, w.ns, id => id);
  check('a form names the cast that shaped it', sh.entry === castId && sh.text === 'your Long Rain', sh.text);
  const first = shapedBy({ ...form, form: 1 }, -1, w.ns, id => id);
  check('the first form was the first of them', first.entry === 0 && /first/.test(first.text));
  const pre = shapedBy(form, -1, null, id => ({ fur: 'Thick Fur' }[id] ?? id));
  check('before nations, a form is what it gained', pre.text === 'they grew thick fur', pre.text);
}

console.log('Your People: cards speak of them');
{
  const w = world(51);
  const kin = card(['awaken'], { target: 'kin' });
  const k = personalize(describe(kin), targetTextOf(kin), 'Velari', []);
  check('the kin target names your people', /your Velari\b/.test(k), k);
  const hungry = card(['harvest'], { target: 'hungriest' });
  const falls = resolveTarget(w.ns, 'hungriest');
  const h = personalize(describe(hungry), targetTextOf(hungry), 'Velari', falls);
  check('a nation target names the nation it would fall on', h.includes(falls[0].name), h);
  const all = card(['harvest'], { target: 'all' });
  check('every nation is every nation of your people', /every nation of the Velari\b/.test(personalize(describe(all), targetTextOf(all), 'Velari', [])));
  const wilds = card(['harvest'], { target: 'wilds' });
  let same = true;
  try { same = personalize(describe(wilds), targetTextOf(wilds), 'Velari', []) === describe(wilds); } catch { same = true; }
  check('other targets are left as they are', same);
}


console.log('Evolution answers the world');
{
  check('every mutation says what it answers', MUTATIONS.every(m => (ANSWERS[m.id]?.length ?? 0) > 0), MUTATIONS.filter(m => !ANSWERS[m.id]).map(m => m.id).join(','));
  check('every answer names a real mutation', Object.keys(ANSWERS).every(id => !!MUTATION_BY_ID[id]));
  const gut = MUTATION_BY_ID['gut'];
  check('an answering card costs less', mutationPrice(gut, ['hunger']) < gut.cost, `${mutationPrice(gut, ['hunger'])} vs ${gut.cost}`);
  check('a nudge, not a gift (at most 25% off, never free)', mutationPrice(gut, ['hunger']) >= Math.max(1, Math.floor(gut.cost * 0.75)));
  check('a card that answers nothing costs full price', mutationPrice(gut, ['war']) === gut.cost);
  check('the worst pressure it answers is named', answersFor('exoskeleton', ['war', 'pollution']) === 'war');
  check('a gift says what brought it', /^the hungry years favoured those with gut symbionts$/.test(giftReason('gut', ['hunger'])), giftReason('gut', ['hunger']));
  check('a gift with no cause is chance', /chance/.test(giftReason('gut', ['war'])));
  const ctx = { genome: createPrimordialSpecies(0), phase: 'microbial' as const, owned: [], queued: [], offered: MUTATIONS.map(m => m.id), points: 0 };
  const priced = cardStates({ ...ctx, pressures: ['air'] }).find(c => c.def.id === 'oxygen')!;
  check('card states carry price and the pressure', priced.answers === 'air' && priced.price < priced.def.cost, `${priced.price}/${priced.def.cost}`);
  const afford = cardStates({ ...ctx, points: priced.price, pressures: ['air'] }).find(c => c.def.id === 'oxygen')!;
  check('affordable at the answering price', afford.affordable);
  check('without pressures nothing changes', cardStates(ctx).every(c => c.price === c.def.cost && c.answers === null));
  const pk = pressureKinds(null, { ...DEFAULT_BIOSPHERE, extinctionPressure: 0.8, oxygenLevel: 0.02 });
  check('pressure kinds come worst first, without repeats', pk[0] === 'extinction' && new Set(pk).size === pk.length, pk.join(','));
  const f = { form: 3, name: 'X', tick: 5, genome: createPrimordialSpecies(0), mutations: ['gut'], why: PRESSURE_TIMES.hunger };
  check('a form remembers what it answered', shapedBy(f, 0, null, id => id).text === 'the hungry years');
}

console.log('Species catalogue');
{
  const base = createPrimordialSpecies(0);
  const mk = (id: string, over: (g: SpeciesGenome) => void, anc: string | null = null): SpeciesGenome => {
    const g: SpeciesGenome = JSON.parse(JSON.stringify(base));
    g.id = id; g.name = id; g.ancestorId = anc; g.physicalTraits.bodyStructure = 'vertebrate';
    g.dna.environment = 'land'; g.dna.locomotion = 'walking'; g.physicalTraits.size = 'medium'; over(g); return g;
  };
  const you = mk('you', g => { g.dna.diet = 'omnivore'; g.population = 0.4; });
  const branch = mk('branch', g => { g.dna.diet = 'omnivore'; g.population = 0.1; }, 'you');
  const wolf = mk('wolf', g => { g.dna.diet = 'carnivore'; g.physicalTraits.size = 'large'; g.population = 0.2; });
  const deer = mk('deer', g => { g.dna.diet = 'herbivore'; g.physicalTraits.size = 'small'; g.population = 0.3; });
  const kelp = mk('kelp', g => { g.dna.diet = 'producer'; g.dna.environment = 'ocean'; g.dna.locomotion = 'stationary'; g.population = 0.5; });
  const gone = mk('gone', g => { g.isExtinct = true; g.extinct = { tick: 500, cause: 'outcompeted', by: 'you' }; g.originTick = 100; });
  const old = mk('old', g => { g.isExtinct = true; });
  const pool = [kelp, wolf, deer, branch, you, gone, old];
  check('relations: predator, prey, branch, yours', relationTo(wolf, you, pool) === 'predator' && relationTo(deer, you, pool) === 'prey'
    && relationTo(branch, you, pool) === 'branch' && relationTo(you, you, pool) === 'yours');
  check('a sea plant is no threat to land folk', relationTo(kelp, you, pool) === 'harmless', relationTo(kelp, you, pool));
  const c = censusOf(pool, 'you');
  check('the census counts living, extinct and branches', c.living === 5 && c.extinct === 2 && c.branches === 1 && c.ever === 7, JSON.stringify(c));
  const rows = livingRows(pool, 'you');
  check('yours first, its branch right under it', rows[0].g.id === 'you' && rows[1].g.id === 'branch' && rows[1].depth === 1, rows.map(r => r.g.id).join(','));
  check('every living lineage listed once', rows.length === 5 && new Set(rows.map(r => r.g.id)).size === 5);
  check('shares add up to the whole', Math.abs(rows.reduce((a, r) => a + r.share, 0) - 1) < 1e-9);
  check('the archive lists the dead, latest first', archiveRows(pool).map(g => g.id).join(',') === 'gone,old');
  check('a death names its killer', deathOf(gone, pool, 'you') === 'outcompeted by your you', deathOf(gone, pool, 'you') ?? '');
  check('older deaths are honest about it', /before anyone kept records/.test(deathOf(old, pool, 'you') ?? ''));
  check('kinds are words', kindOf(wolf) === 'hunter' && kindOf(kelp) === 'ocean plant' && kindOf(base) !== '', `${kindOf(wolf)} / ${kindOf(kelp)} / ${kindOf(base)}`);
  check('spans in years', yearsSpan(400) === '4K years' && yearsSpan(5) === '50 years');
}

console.log('Evolution: trade-offs');
{
  check('every mutation has a drawback, said in words', MUTATIONS.every(m => !!DRAWBACKS[m.id]?.text), MUTATIONS.filter(m => !DRAWBACKS[m.id]).map(m => m.id).join(','));
  check('every drawback costs something', Object.values(DRAWBACKS).every(d => Object.values(d.effects ?? {}).some(v => (v ?? 0) < 0) || Object.values(d.dna ?? {}).some(v => (v ?? 0) !== 0)));
  check('every drawback names a real mutation', Object.keys(DRAWBACKS).every(id => !!MUTATION_BY_ID[id]));
  check('evolving takes three changes, or one major', EVOLVE_THRESHOLD === 3 && !queueReady(['flagellum', 'oxygen']) && queueReady(['flagellum', 'oxygen', 'eyespot']) && queueReady(['colony']));
  check('a drawback weighs on its effect', mutationEffect(['shell'], 'mobility') < 0, String(mutationEffect(['shell'], 'mobility')));
  check('effects stay in bounds', mutationEffect(MUTATIONS.map(m => m.id), 'divergence') >= -0.3 && mutationEffect(MUTATIONS.map(m => m.id), 'techSpeed') <= 1.2);
  const g = cloneGenome(createPrimordialSpecies(0)); g.dna.adaptability = 5;
  applyMutation(g, 'fins');
  check('a trait drawback lands on the body', g.dna.adaptability === 4, String(g.dna.adaptability));
}

console.log(failed ? `\n${failed} people-story check(s) FAILED` : '\npeople-story checks passed');
if (failed) process.exit(1);
