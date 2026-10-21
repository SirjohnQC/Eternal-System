/**
 * The mind gate (stage-moments plan, P4), headless.
 *
 *   npm run test:mind
 *
 * 1. The drift's odds: an untouched lineage at intelligence 0 reaches the
 *    gate in a median of 6..20 evolution steps, never more than 44.
 * 2. In the engine: a world at Hands with a mindless lineage waits (no roll,
 *    no stall counted), the drift brings the mind, and only then does the
 *    world cross, with intelligence >= MIND_MIN, as the player's own lineage.
 *    A twin that took a bigger brain crosses sooner.
 * 3. Creative mode passes the same gate: a leap gives a thinking people.
 * 4. The mind cards: Language and Toolmaking open at Hands; the three are
 *    gone once the people think.
 *
 * Exits non-zero on any failure.
 */
import { makeCanvas } from './lib/headlessDom';
const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState, runtimeState, createDefaultGameState } = await import('../src/simulation/GameState');
const { MIND_MIN, MIND_WAIT_MAX, mindDriftChance } = await import('../src/simulation/People');
const { SeedRNG } = await import('../src/utils/SeedRNG');
const { cardStates, MUTATIONS } = await import('../src/simulation/Mutations');
const { EVOLUTION_TICK_RATE } = await import('../src/simulation/EvolutionEngine');

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failed++;
};

console.log('The drift\'s odds');
{
  const rng = new SeedRNG('mind_odds');
  const waits: number[] = [];
  for (let t = 0; t < 20_000; t++) {
    let intel = 0, k = 0;
    while (intel < MIND_MIN) { if (rng.next() < mindDriftChance(k, 0, 1.1)) intel++; k++; }
    waits.push(k);
  }
  waits.sort((a, b) => a - b);
  const median = waits[waits.length >> 1], max = waits[waits.length - 1];
  check('an untouched lineage wakes in a median of 6..20 steps', median >= 6 && median <= 20, `median ${median}`);
  check('… and never later than 44 steps', max <= 44, `max ${max}`);
  check('after the bound the drift always lands', mindDriftChance(MIND_WAIT_MAX, 0, 1.3) === 1);
  check('a bigger mind grows it faster', mindDriftChance(5, 0.6, 1.1) > mindDriftChance(5, 0, 1.1));
}

function world(seed: string): any {
  Object.assign(gameState, createDefaultGameState(), {
    playerPlanetName: 'Mindworld', playerSpeciesName: 'Velari', skipFormation: true, masterSeed: seed, divinePoints: 100,
  });
  runtimeState.playerPlanetGrid = null;
  runtimeState.playerNations = null;
  const stats = { life: 18, evolution: 10, hostility: 10, entropy: 10, divine: 10 };
  gameState.stats = stats;
  const e = new BigBangEngine(makeCanvas()) as any;
  e.init(stats, seed);
  for (let i = 0; i < 6_000 && !e.signatureSpecies(); i++) e.update();
  return e;
}

/** Put the player's world at Hands, ripe, with a lineage of intelligence `intel`. */
function atHands(e: any, intel: number): void {
  const ps = e.getPlayerStar(), sig = e.signatureSpecies();
  ps.biologyPhase = 'primitive';
  ps.bioPhaseProgress = 1e9;
  ps.mindWait = 0;
  ps.bioStalls = 0;
  sig.dna.intelligence = intel;
}

console.log('The gate in the engine');
let gatedWins = 0, seeds = 0;
for (const seed of ['mind_a', 'mind_b', 'mind_c', 'mind_d']) {
  const e = world(seed);
  const ps = e.getPlayerStar();
  if (!e.signatureSpecies()) { check(`${seed}: a lineage to test`, false); continue; }
  seeds++;
  atHands(e, 0);
  let crossedAt = -1, sawStall = false, lowMindCross = false;
  for (let i = 0; i < (MIND_WAIT_MAX + 6) * EVOLUTION_TICK_RATE; i++) {
    e.update();
    const sig = e.signatureSpecies();
    if (ps.biologyPhase === 'primitive' && (sig?.dna.intelligence ?? 0) < MIND_MIN && (ps.bioStalls ?? 0) > 0) sawStall = true;
    if (ps.biologyPhase === 'intelligent') { crossedAt = i; lowMindCross = (e.mindCrossedAt.get(ps.id) ?? -1) < MIND_MIN; break; }
    if (ps.biologyPhase !== 'primitive') break;   // a collapse: the test ends there
  }
  check(`${seed}: waiting at Hands counts no stalls`, !sawStall);
  check(`${seed}: crosses only with a mind`, crossedAt < 0 || !lowMindCross, `crossed at ${crossedAt}`);
  if (crossedAt >= 0) {
    const civ = gameState.civilizations[ps.id];
    check(`${seed}: the civilisation is the player's own lineage`, civ?.speciesId === gameState.signatureSpeciesId);
  }
  // The twin that bought a mind on entering Hands.
  const t = world(seed);
  atHands(t, 5);
  let twinAt = -1;
  for (let i = 0; i < (MIND_WAIT_MAX + 6) * EVOLUTION_TICK_RATE; i++) {
    t.update();
    if (t.getPlayerStar().biologyPhase === 'intelligent') { twinAt = i; break; }
  }
  if (twinAt >= 0 && (crossedAt < 0 || twinAt < crossedAt)) gatedWins++;
  console.log(`  · ${seed}: untouched crossed after ${crossedAt < 0 ? '—' : crossedAt} ticks, the thinking twin after ${twinAt < 0 ? '—' : twinAt}`);
}
check('a lineage that took a bigger mind wakes sooner (most seeds)', gatedWins >= Math.ceil(seeds * 0.75), `${gatedWins}/${seeds}`);

console.log('Creative leaps pass the gate');
{
  const e = world('mind_leap');
  const sig = e.signatureSpecies();
  if (sig) sig.dna.intelligence = 0;
  e.leapToEra(1);
  const ps = e.getPlayerStar();
  check('a leap gives a thinking people', ps.biologyPhase === 'intelligent' && (e.signatureSpecies()?.dna.intelligence ?? 0) >= MIND_MIN,
    `intelligence ${e.signatureSpecies()?.dna.intelligence}`);
}

console.log('The mind cards');
{
  const g = (world('mind_cards').signatureSpecies());
  const offered = MUTATIONS.map((m: any) => m.id);
  const at = (phase: string) => cardStates({ genome: g, phase: phase as any, owned: [], queued: [], offered, points: 99 });
  const hands = at('primitive'), minds = at('intelligent');
  const st = (cs: any[], id: string) => cs.find(c => c.def.id === id);
  check('Language and Toolmaking open at Hands', st(hands, 'language')?.reason !== 'Opens at intelligent life' && !!st(hands, 'toolmaking'));
  check('the mind cards are gone once they think', !st(minds, 'language') && !st(minds, 'toolmaking') && !st(minds, 'big_brain'));
  check('the mind cards say so', ['big_brain', 'language', 'toolmaking'].every(id => MUTATIONS.find((m: any) => m.id === id)?.mind));
}

console.log('The name the player gives');
{
  const e = world('mind_name');
  e.namePlayerPeople('Thessari');
  check('naming the people names the lineage', e.signatureSpecies()?.name === 'Thessari');
  gameState.mutationQueue = ['big_brain'];
  gameState.mutationsOwned = ['backbone'];
  const r = e.evolveSignature();
  check('evolving keeps the name the player gave', !!r && e.signatureSpecies()?.name === 'Thessari' && r.after.name === 'Thessari', r?.after.name ?? 'did not evolve');
}

console.log(failed ? `\n${failed} mind gate check(s) FAILED` : '\nmind gate checks passed');
if (failed) process.exit(1);
