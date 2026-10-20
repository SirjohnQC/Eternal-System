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
  check('plural names', plural('Selsul Runner') === 'Selsul Runners' && plural('Velari') === 'Velaris' && plural('Kith') === 'Kiths' && plural('Moss') === 'Moss');
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
  check('the kin target names your people', /your Velaris/.test(k), k);
  const hungry = card(['harvest'], { target: 'hungriest' });
  const falls = resolveTarget(w.ns, 'hungriest');
  const h = personalize(describe(hungry), targetTextOf(hungry), 'Velari', falls);
  check('a nation target names the nation it would fall on', h.includes(falls[0].name), h);
  const all = card(['harvest'], { target: 'all' });
  check('every nation is every nation of your people', /every nation of the Velaris/.test(personalize(describe(all), targetTextOf(all), 'Velari', [])));
  const wilds = card(['harvest'], { target: 'wilds' });
  let same = true;
  try { same = personalize(describe(wilds), targetTextOf(wilds), 'Velari', []) === describe(wilds); } catch { same = true; }
  check('other targets are left as they are', same);
}

console.log(failed ? `\n${failed} people-story check(s) FAILED` : '\npeople-story checks passed');
if (failed) process.exit(1);
