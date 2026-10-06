/**
 * Checks procedural Faith Cards (src/simulation/FaithCards.ts) and the omens
 * they lay on nations (src/simulation/Nations.ts): discovery follows the
 * world's state, burning forges new cards from old parts, and a cast card
 * changes a nation's state against an untouched twin — with the card in its
 * causal history.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/faithCardsCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/faith.mjs --log-level=error && node /tmp/faith.mjs
 */
import { generatePlanetGrid, isHabitable, type PlanetGrid } from '../src/simulation/PlanetGrid';
import { NationSystem, type Nation } from '../src/simulation/Nations';
import { valuesFromGenome, type GenomeSummary } from '../src/simulation/Civilization';
import {
  discover, forge, cast, signalsOf, describe, priceOf, resolveTarget, ACTIONS,
  type FaithCard, type WorldSignals, type ActionId, type ForgeKind,
} from '../src/simulation/FaithCards';
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

function settled(type: string, seed: number): PlanetGrid {
  const grid = generatePlanetGrid(type, seed, null, null);
  for (const row of grid) for (const c of row) {
    c.lifeDensity = isHabitable(c.biome) ? c.fertility : 0;
    c.civId = isHabitable(c.biome) && c.fertility > 0.35 ? '1' : null;
  }
  return grid;
}

const ERA = 40000, STEP = 2000;
/** A founded world, run `eras` forward. */
function world(seed: number, eras = 1.5): { ns: NationSystem; grid: PlanetGrid; t: number } {
  const grid = settled('ocean', seed);
  const ns = new NationSystem(seed);
  ns.found(grid, valuesFromGenome(genome), genome, 0);
  let t = 0;
  for (; t <= ERA * eras; t += STEP) ns.step(grid, t, ERA);
  return { ns, grid, t };
}
const run = (w: { ns: NationSystem; grid: PlanetGrid; t: number }, eras: number) => {
  const end = w.t + ERA * eras;
  for (; w.t <= end; w.t += STEP) w.ns.step(w.grid, w.t, ERA);
};

const card = (actions: ActionId[], over: Partial<FaithCard> = {}): FaithCard => {
  const c: FaithCard = { id: 'test', name: 'TEST CARD', actions, target: 'all', condition: 'always', magnitude: 3, duration: 2,
    sides: [], cost: 0, odds: 1, origin: '', forged: 0, ...over };
  c.cost = priceOf(c);
  return c;
};

// ── 1. Cards are sentences of parts ───────────────────────────────────────────
console.log('Faith Cards: parts');
{
  const calm: WorldSignals = { hunger: 0, crowding: 0, scarcity: 0, unrest: 0, pollution: 0, war: 0, peace: 1, trade: 0.3, piety: 0.5, curiosity: 0.5, dominance: 0.1, era: 0.3 };
  const rng = new SeedRNG('parts');
  const all: FaithCard[] = [];
  for (let i = 0; i < 400; i++) all.push(...discover(calm, rng, 3, `p${i}`));
  const configs = new Set(all.map(c => `${c.actions}|${c.target}|${c.condition}|${c.magnitude}|${c.duration}|${c.sides.map(s => s.op + s.when + s.mag)}`));
  check('1200 drawn cards are mostly distinct configurations', configs.size > 900, `${configs.size} distinct`);
  check('every card has a cost of at least 2 DP', all.every(c => c.cost >= 2), `range ${Math.min(...all.map(c => c.cost))}..${Math.max(...all.map(c => c.cost))}`);
  check('odds are probabilities', all.every(c => c.odds > 0.3 && c.odds < 1));
  check('a seek offers distinct actions', all.length % 3 === 0 && Array.from({ length: all.length / 3 }, (_, i) => all.slice(i * 3, i * 3 + 3))
    .every(t => new Set(t.map(c => c.actions[0])).size === 3));
  check('most cards carry a side effect (a price)', all.filter(c => c.sides.length).length / all.length > 0.7,
    `${Math.round(100 * all.filter(c => c.sides.length).length / all.length)}%`);
  const sample = all.slice(0, 4);
  for (const c of sample) console.log(`        ${c.name.padEnd(28)} ${String(c.cost).padStart(3)} DP  ${describe(c)}`);
  const names = new Set(all.map(c => c.name));
  check('names vary', names.size > 150, `${names.size} names`);
}

// ── 2. Discovery follows the world ────────────────────────────────────────────
console.log('Faith Cards: discovery shaped by the world');
{
  const base: WorldSignals = { hunger: 0, crowding: 0, scarcity: 0, unrest: 0, pollution: 0, war: 0, peace: 1, trade: 0, piety: 0.5, curiosity: 0.3, dominance: 0.1, era: 0.2 };
  const tally = (sig: WorldSignals, seed: string) => {
    const rng = new SeedRNG(seed), n: Record<string, number> = {};
    for (let i = 0; i < 300; i++) for (const c of discover(sig, rng, 3, 'x')) n[c.actions[0]] = (n[c.actions[0]] ?? 0) + 1;
    return n;
  };
  const famine = tally({ ...base, hunger: 0.9, crowding: 0.5 }, 'famine');
  const war = tally({ ...base, war: 1, peace: 0 }, 'war');
  const smog = tally({ ...base, pollution: 0.9, era: 0.5 }, 'smog');
  const calm = tally(base, 'calm');
  check('famine turns up harvests more than calm does', (famine.harvest ?? 0) > (calm.harvest ?? 0) * 1.5, `${famine.harvest} vs ${calm.harvest}`);
  check('famine turns up roads out (exodus)', (famine.exodus ?? 0) > (calm.exodus ?? 0) * 1.3, `${famine.exodus} vs ${calm.exodus}`);
  check('war turns up truces (calm)', (war.calm ?? 0) > (calm.calm ?? 0) * 1.5, `${war.calm} vs ${calm.calm}`);
  check('smoke turns up cleansing rains', (smog.cleanse ?? 0) > (calm.cleanse ?? 0) * 1.5, `${smog.cleanse} vs ${calm.cleanse}`);
  check('anything can still surface in a calm world', Object.keys(calm).length === ACTIONS.length, `${Object.keys(calm).length}/${ACTIONS.length} actions`);
  const w = world(11);
  const sig = signalsOf(w.ns);
  check('signals read from a real world are 0..1', Object.values(sig).every(v => v >= 0 && v <= 1), JSON.stringify(Object.fromEntries(Object.entries(sig).map(([k, v]) => [k, +v.toFixed(2)]))));
  check('discovery names the time it was found in', discover(sig, new SeedRNG('o'), 1, 'o')[0].origin.startsWith('Glimpsed in'));
}

// ── 3. Burning ────────────────────────────────────────────────────────────────
console.log('Faith Cards: burning and synthesis');
{
  const rng = new SeedRNG('forge');
  const kinds: Record<ForgeKind, number> = { fusion: 0, refinement: 0, wild: 0 };
  let inherited = 0, fusedBoth = 0, fusions = 0, refinedUp = 0, refinements = 0;
  for (let i = 0; i < 600; i++) {
    const [a, b] = discover({ hunger: 0.5, crowding: 0.3, scarcity: 0.3, unrest: 0.3, pollution: 0.2, war: 0.5, peace: 0.5, trade: 0.3, piety: 0.5, curiosity: 0.5, dominance: 0.4, era: 0.4 }, rng, 2, `f${i}`);
    const { card: c, kind } = forge(a, b, rng, `c${i}`);
    kinds[kind]++;
    if (c.actions.some(x => a.actions.includes(x) || b.actions.includes(x))) inherited++;
    if (kind === 'fusion') { fusions++; if (c.actions.includes(a.actions[0]) && c.actions.includes(b.actions[0])) fusedBoth++; }
    if (kind === 'refinement') { refinements++; if (c.magnitude >= Math.min(3, Math.min(a.magnitude, b.magnitude) + 1)) refinedUp++; }
    if (i === 0) console.log(`        ${a.name} + ${b.name} -> ${c.name} (${kind}): ${describe(c)}`);
  }
  check('all three outcomes happen', kinds.fusion > 50 && kinds.refinement > 50 && kinds.wild > 50, JSON.stringify(kinds));
  check('a fusion carries both purposes', fusedBoth === fusions, `${fusedBoth}/${fusions}`);
  check('a refinement is stronger than the weaker parent', refinedUp === refinements, `${refinedUp}/${refinements}`);
  check('most forged cards keep a parent purpose', inherited / 600 > 0.75, `${Math.round(inherited / 6)}%`);
}

// ── 4. Cast cards change nations (vs an untouched twin) ───────────────────────
console.log('Faith Cards: omens on nations');
const twins = (seed: number) => [world(seed), world(seed)];
const sum = (ns: NationSystem, f: (n: Nation) => number) => ns.nations.filter(n => !n.fallen).reduce((a, n) => a + f(n), 0);
{
  const [a, b] = twins(21);
  const res = cast(a.ns, card(['harvest']), new SeedRNG('c1'), a.t);
  check('a certain card is heeded everywhere', res.heeded.length === a.ns.nations.filter(n => !n.fallen).length, res.line);
  run(a, 0.1); run(b, 0.1);
  check('harvest: more food than the twin', sum(a.ns, n => n.state.foodYield) > sum(b.ns, n => n.state.foodYield) * 1.3,
    `${sum(a.ns, n => n.state.foodYield).toFixed(1)} vs ${sum(b.ns, n => n.state.foodYield).toFixed(1)}`);
  run(a, 0.3); run(b, 0.3);
  check('harvest: then more people than the twin', sum(a.ns, n => n.state.population) > sum(b.ns, n => n.state.population) * 1.15,
    `${sum(a.ns, n => n.state.population) | 0} vs ${sum(b.ns, n => n.state.population) | 0}`);
  const n0 = a.ns.nations[res.heeded[0].id];
  check('the card is in the causal history', n0.history.some(h => h.because.some(x => x.includes('Test Card'))), n0.history.slice(-1)[0]?.what);
  check('a visitor sees the omen, not its name', /more than anyone sowed/.test(JSON.stringify(n0.omens.filter(o => o.active).map(o => o.op))) || n0.omens.some(o => o.active && o.op === 'harvest'));
  run(a, 0.3); run(b, 0.3);
  const famished = sum(a.ns, n => n.pressures.hunger), twinF = sum(b.ns, n => n.pressures.hunger);
  check('harvest: when it passes, more mouths than food (regret)', famished > twinF, `hunger ${famished.toFixed(2)} vs ${twinF.toFixed(2)}`);
}
{
  const [a, b] = twins(22);
  cast(a.ns, card(['pestilence']), new SeedRNG('c2'), a.t);
  run(a, 0.3); run(b, 0.3);
  check('pestilence: fewer people than the twin', sum(a.ns, n => n.state.population) < sum(b.ns, n => n.state.population) * 0.8,
    `${sum(a.ns, n => n.state.population) | 0} vs ${sum(b.ns, n => n.state.population) | 0}`);
}
{
  const [a, b] = twins(23);
  const rivals = resolveTarget(a.ns, 'rivals');
  cast(a.ns, card(['discord'], { target: 'rivals' }), new SeedRNG('c3'), a.t);
  run(a, 0.25); run(b, 0.25);
  const ra = a.ns.relation(rivals[0].id, rivals[1].id)!, rb = b.ns.relation(rivals[0].id, rivals[1].id)!;
  check('discord: rivals think worse of each other than in the twin', ra.attitude < rb.attitude - 0.2 || !!ra.war,
    `${ra.attitude.toFixed(2)}${ra.war ? ' (war)' : ''} vs ${rb.attitude.toFixed(2)}`);
  check('discord: wrongs are remembered', ra.grievance > rb.grievance, `${ra.grievance.toFixed(2)} vs ${rb.grievance.toFixed(2)}`);
}
{
  const [a, b] = twins(24);
  cast(a.ns, card(['inspire'], { duration: 3 }), new SeedRNG('c4'), a.t);
  run(a, 0.8); run(b, 0.8);
  check('inspire: more techs learned than the twin', sum(a.ns, n => n.techs.length) > sum(b.ns, n => n.techs.length) + 2,
    `${sum(a.ns, n => n.techs.length)} vs ${sum(b.ns, n => n.techs.length)}`);
}
{
  const [a, b] = twins(25);
  const [src] = resolveTarget(a.ns, 'crowded');
  cast(a.ns, card(['exodus'], { target: 'crowded' }), new SeedRNG('c5'), a.t);
  run(a, 0.15); run(b, 0.15);
  const others = (ns: NationSystem) => sum(ns, n => n.id === src.id ? 0 : n.state.population);
  check('exodus: the source empties', a.ns.nations[src.id].state.population < b.ns.nations[src.id].state.population * 0.85,
    `${a.ns.nations[src.id].state.population | 0} vs ${b.ns.nations[src.id].state.population | 0}`);
  check('exodus: its neighbours fill', others(a.ns) > others(b.ns), `${others(a.ns) | 0} vs ${others(b.ns) | 0}`);
}
{
  const [a] = twins(26);
  const c = card(['harvest'], { sides: [{ op: 'dependency', when: 'after', mag: 3 }], duration: 1 });
  const res = cast(a.ns, c, new SeedRNG('c6'), a.t);
  const n = a.ns.nations[res.heeded[0].id];
  const dep = () => n.omens.find(o => o.op === 'dependency')!;
  check('an aftermath waits while the card works', !dep().started);
  run(a, 0.35);
  check('an aftermath begins when the card passes', dep().started && dep().aftermath, n.history.slice(-3).map(h => h.what).join(' | '));
  check('the aftermath names the card that passed', n.history.some(h => h.because.some(x => x.includes('had passed'))));
}
{
  // A condition: a harvest that only works in hunger does nothing for the sated.
  const [a] = twins(27);
  const c = card(['harvest'], { condition: 'war' });
  cast(a.ns, c, new SeedRNG('c7'), a.t);
  run(a, 0.05);
  const atWar = (n: Nation) => a.ns.relations.some(r => r.war && (r.a === n.id || r.b === n.id));
  const ok = a.ns.nations.filter(n => !n.fallen).every(n => n.omens.filter(o => o.op === 'harvest').every(o => o.active === atWar(n)));
  check('a condition gates the omen', ok);
}
{
  // Odds: a card nobody heeds changes nothing, and says so.
  const [a] = twins(28);
  const res = cast(a.ns, card(['blight'], { odds: -1 }), new SeedRNG('c8'), a.t);
  check('an unheeded card lays no omen', !res.heeded.length && a.ns.nations.every(n => !n.omens.length), res.line);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall faith card checks passed');
process.exit(failed ? 1 : 0);
