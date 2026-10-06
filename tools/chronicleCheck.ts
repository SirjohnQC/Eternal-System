/**
 * Checks the Chronicle (src/simulation/Chronicle.ts and the causal links the
 * nations write, src/simulation/Nations.ts): every link points at an earlier,
 * real entry; a world left to itself already builds chains (hunger -> a
 * technology -> an age); and a card the player cast shows up at the roots of
 * what happened afterwards ("I caused this").
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/chronicleCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/chronicle.mjs --log-level=error && node /tmp/chronicle.mjs
 */
import { generatePlanetGrid, isHabitable, type PlanetGrid } from '../src/simulation/PlanetGrid';
import { NationSystem, type HistoryEntry } from '../src/simulation/Nations';
import { valuesFromGenome, type GenomeSummary } from '../src/simulation/Civilization';
import { cast, priceOf, type FaithCard, type ActionId } from '../src/simulation/FaithCards';
import { causeTree, ancestors, descendants, yourHand, whenOf, type CauseNode } from '../src/simulation/Chronicle';
import { SeedRNG } from '../src/utils/SeedRNG';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(56)} ${detail}`);
  if (!ok) failed++;
};

const genome: GenomeSummary = {
  speciesName: 'Test', metabolism: 'heterotrophic', locomotion: 'walking', environment: 'land', diet: 'omnivore',
  respiration: 'aerobic', reproduction: 'sexual', size: 'medium', bodyStructure: 'vertebrate', sensorySystem: 'vision',
  intelligence: 7, social: 5, aggression: 5, adaptability: 5, biome: 'forest', temperatureRange: 'temperate',
};
function settled(seed: number): PlanetGrid {
  const grid = generatePlanetGrid('ocean', seed, null, null);
  for (const row of grid) for (const c of row) {
    c.lifeDensity = isHabitable(c.biome) ? c.fertility : 0;
    c.civId = isHabitable(c.biome) && c.fertility > 0.35 ? '1' : null;
  }
  return grid;
}
const ERA = 40000, STEP = 2000;
const world = (seed: number) => {
  const grid = settled(seed), ns = new NationSystem(seed);
  ns.found(grid, valuesFromGenome(genome), genome, 0);
  return { ns, grid, t: 0 };
};
const run = (w: ReturnType<typeof world>, eras: number) => { const end = w.t + ERA * eras; for (; w.t <= end; w.t += STEP) w.ns.step(w.grid, w.t, ERA); };
const card = (actions: ActionId[], over: Partial<FaithCard> = {}): FaithCard => {
  const c: FaithCard = { id: 't', name: 'BOUNTIFUL HARVEST', actions, target: 'hungriest', condition: 'always', magnitude: 3, duration: 3, sides: [], cost: 0, odds: 5, origin: '', forged: 0, ...over };
  c.cost = priceOf(c);
  return c;
};
const show = (n: CauseNode, ns: NationSystem, pad = '        '): void => {
  console.log(`${pad}${n.entry.kind === 'divine' ? '✦ ' : ''}${n.entry.what}${n.seen ? ' (above)' : ''}`);
  for (const c of n.causes) show(c, ns, pad + '  ↳ ');
};

console.log('Chronicle: links');
{
  const w = world(61);
  run(w, 3);
  const all = w.ns.chronicle;
  check('a world of three eras writes a chronicle', all.length > 40, `${all.length} entries`);
  check('every link points at an earlier, real entry', all.every(e => e.causes.every(c => c < e.id && !!w.ns.entry(c))));
  const linked = all.filter(e => e.causes.length);
  check('most events link to what caused them', linked.length / all.length > 0.4, `${Math.round(100 * linked.length / all.length)}% linked`);
  const techs = all.filter(e => / (sowed|built|raised|began|learned|dug|smelted|wrote|brought|founded|parcelled|harnessed|put|printed|lit|fed|spoke|promised|split)/.test(e.what) && e.causes.length);
  check('technologies link to the pressures and techs behind them', techs.length > 5, `${techs.length}`);
  const deep = all.map(e => ({ e, n: ancestors(w.ns, e.id).length })).sort((a, b) => b.n - a.n)[0];
  check('chains run several links deep', deep.n >= 4, `${deep.n} ancestors behind "${deep.e.what}"`);
  const tree = causeTree(w.ns, deep.e.id, 4, 14)!;
  show(tree, w.ns);
  check('the tree never repeats an entry in full', (() => { const ids: number[] = []; const walk = (n: CauseNode) => { if (!n.seen) ids.push(n.entry.id); n.causes.forEach(walk); }; walk(tree); return ids.length === new Set(ids).size; })());
  const wars = all.filter(e => e.what.includes('went to war'));
  if (wars.length) check('a war links to its causes', wars.some(e => e.causes.length > 0), wars[0].what);
  const peace = all.filter(e => e.what.includes('made peace'));
  if (peace.length) check('a peace links to its war', peace.every(e => e.causes.some(c => w.ns.entry(c)?.what.includes('war') || w.ns.entry(c)?.what.includes('peace'))));
  check('each entry says when', whenOf(w.ns, all[0]).includes('ages ago'), whenOf(w.ns, all[0]));
}

console.log('Chronicle: your hand');
{
  const w = world(62);
  run(w, 1);
  const res = cast(w.ns, card(['fertility', 'harvest'], { target: 'all' }), new SeedRNG('h'), w.t);
  run(w, 1.5);
  const castE = w.ns.chronicle.find(e => e.kind === 'divine')!;
  check('the cast itself is in the chronicle', !!castE, castE?.what);
  const after = descendants(w.ns, castE.id);
  check('what followed from it is found', after.length >= 2, `${after.length} later events`);
  for (const e of after.filter(x => !/fields bore|Children were born/.test(x.what)).slice(0, 8)) console.log(`        → ${e.what}`);
  const later = after.filter(e => !e.what.includes('fields bore') && !e.what.includes('Children were born'));
  check('consequences beyond the card itself (crowding, hunger, techs…)', later.length >= 1, later[0]?.what ?? '');
  if (later.length) {
    const hand = yourHand(w.ns, later[later.length - 1].id);
    check('from a later event, your hand is found at the roots', hand.some(h => h.id === castE.id), `"${later[later.length - 1].what}" ← ${hand.map(h => h.what).join(', ')}`);
  }
  check('nations that heeded it name the card in their history', res.heeded.every(n => n.history.some(h => h.causes.includes(castE.id))));
}

console.log('Chronicle: bounded');
{
  const w = world(63);
  run(w, 12);
  check('the chronicle stays bounded', w.ns.chronicle.length <= 2000, `${w.ns.chronicle.length}`);
  check('links to aged-out entries are simply missing, never broken', w.ns.chronicle.every((e: HistoryEntry) => e.causes.every(c => c < e.id)));
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall chronicle checks passed');
process.exit(failed ? 1 : 0);
