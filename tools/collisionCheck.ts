/**
 * Dev-only: does the collision → supernova → new system cycle actually run?
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/collisionCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/collide.mjs && node $TMP/collide.mjs
 *
 * Stars already merged and already died. What M22g adds is that a merger past
 * `COLLISION_SUPERNOVA_MASS` DETONATES, that the gas it throws off condenses
 * into systems which run the young-world formation stages, that those systems
 * are almost always dead rock (1%), and that an Interstellar civilisation
 * evacuates instead of dying with its star.
 */

const noopCtx = new Proxy({}, { get(_t, p) {
  if (p === 'canvas') return { width: 1200, height: 800 };
  if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
  if (p === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w*h*4), width: w, height: h });
  if (p === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w*h*4), width: w, height: h });
  if (p === 'measureText') return () => ({ width: 10 });
  return () => undefined;
}, set() { return true; } });
function makeCanvas(): any {
  return { width: 1200, height: 800, style: {}, getContext: () => noopCtx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }), toDataURL: () => '' };
}
const g = globalThis as any;
g.document = { createElement: () => makeCanvas(), getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
g.window = g; g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {};
g.addEventListener = () => {}; g.performance = g.performance ?? { now: () => Date.now() };
g.Image = class { set src(_v: string) {} }; g.eternalSpeed = 1;

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log(`  FAIL  ${name}  — ${detail}`); }
}

console.log('\n═══ Collision → supernova → new system (M22g) ═══');

const TICKS = 600_000;
let supernovae = 0, exoduses = 0, playerExoduses = 0;
let newborn = 0, newbornAlive = 0, newbornInFormation = 0;

gameState.playerPlanetName = 'Collide';
gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
gameState.playerSpecies = []; gameState.codexEntries = []; gameState.playerDNA = {};

const engine = new BigBangEngine(makeCanvas());
engine.onLifeEvent = () => {};
engine.onCivEvent = (msg: string) => {
  if (/begin again there/.test(msg)) exoduses++;
};
engine.onCosmicEvent = (kind: string) => { if (kind === 'supernova') supernovae++; };
(engine as any).onPlayerExodus = () => { playerExoduses++; };
// Hostile universe: more entropy means more events to observe in one run.
engine.init({ life: 14, evolution: 12, hostility: 14, entropy: 18, divine: 12 }, 'collide_seed');

const idsAtStart = new Set<number>((engine as any).stars.map((s: any) => s.id));

g.eternalSpeed = 60;
for (let i = 0; i < TICKS && (engine as any).tick < TICKS; i++) engine.update();

const stars = (engine as any).stars as any[];
for (const s of stars) {
  if (idsAtStart.has(s.id)) continue;
  newborn++;
  if (s.hasLife) newbornAlive++;
  if (s.formationStage != null) newbornInFormation++;
}

const alive = stars.filter(s => !s.isDead);
console.log(`  ${TICKS.toLocaleString()} ticks · ${supernovae} supernovae · ` +
            `${newborn} stars born (${newbornInFormation} still forming) · ` +
            `${exoduses} NPC exoduses · ${playerExoduses} player exodus`);
console.log(`  universe now holds ${alive.length} living stars`);

check('supernovae occur', supernovae > 0, `${supernovae}`);
check('new stars condense from the remnants', newborn > 0, `${newborn} born`);

// A new system must almost never ARRIVE carrying life. This is the 1% from
// `IDEA.md`, and it is measured at the moment formation completes.
//
// Counting how many newborn systems are alive at the END of a run measures
// something else entirely: those stars have also had hundreds of thousands of
// ticks to evolve life the ordinary slow way, which they are entitled to do
// once they are no longer new. Conflating the two led to tuning the simulation
// against a mis-specified test — the fix was to measure the right quantity, not
// to make the universe barren.
{
  const formed = (engine as any).newSystemsFormed as number;
  const bornAlive = (engine as any).newSystemsBornAlive as number;
  const rate = formed > 0 ? bornAlive / formed : 0;
  console.log(`  systems that finished forming: ${formed}, of which arrived alive: ${bornAlive}`);
  check('a new system almost never arrives carrying life', formed > 0 && rate <= 0.04,
        `${bornAlive}/${formed} = ${(rate * 100).toFixed(1)}% at formation (target 1%)`);

  // And the counterpart, so the tuning cannot drift back to a dead cosmos:
  // systems that have aged out of being new SHOULD be able to come alive.
  const laterRate = newborn > 0 ? newbornAlive / newborn : 0;
  console.log(`  newborn systems alive by end of run: ${newbornAlive}/${newborn} ` +
              `= ${(laterRate * 100).toFixed(1)}% (ambient abiogenesis, expected)`);
  check('systems that age out of being new can still come alive', laterRate > rate,
        `${(laterRate * 100).toFixed(1)}% eventually vs ${(rate * 100).toFixed(1)}% at formation`);
}

// CONTROL: the universe must not run down to nothing, which is what the whole
// birth/death cycle exists to prevent.
check('the cosmos does not die out', alive.length >= 5, `${alive.length} stars left`);

// ── Evacuation, exercised directly ──────────────────────────────────────────
// Waiting for an Interstellar civilisation to happen to sit next to a merger is
// far too rare to rely on in one run, so drive the path itself.
{
  const doomed = alive.find(s => s.planets.length > 0);
  if (!doomed) {
    check('an advanced civilisation evacuates a doomed star', false, 'no candidate star');
  } else {
    doomed.civLevel = 7;                       // Interstellar+
    doomed.hasLife = true;
    doomed.biologyPhase = 'intelligent';
    const refuges = alive.filter(s => s.id !== doomed.id && s.civLevel === 0);
    const before = refuges.length;
    const moved = (engine as any).evacuateCivilisation(doomed, 'test');
    check('an advanced civilisation evacuates a doomed star', moved === true,
          `${before} candidate refuges`);
    if (moved) {
      const settled = alive.filter(s => s.id !== doomed.id && s.civName === doomed.civName && s.civLevel > 0);
      check('the refugees arrive somewhere, with reduced technology',
            settled.length > 0 && settled[0].civLevel < 7,
            settled.length ? `civLevel 7 → ${settled[0].civLevel}` : 'nowhere');
    }
  }

  // CONTROL: a pre-Interstellar civilisation has nowhere to go and must die.
  const primitive = alive.find(s => s.civLevel === 0 && s.planets.length > 0);
  if (primitive) {
    primitive.civLevel = 3;                    // Industrial — no starships
    const moved = (engine as any).evacuateCivilisation(primitive, 'test');
    check('control — a pre-Interstellar civilisation cannot flee', moved === false);
  }
}

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All checks passed.\n');
