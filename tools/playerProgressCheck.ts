/**
 * Dev-only: across many seeds, does the PLAYER's world reliably get somewhere?
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/playerProgressCheck.ts --bundle \
 *     --platform=node --format=esm --outfile=$TMP/pp.mjs && node $TMP/pp.mjs
 *
 * Args: [runs=12] [ticks=400000] [collisions=on|off|both]
 *
 * M25: the failing metric and the player's collapsing cosmos share one cause —
 * stars packed tight enough that gravity cascades into mergers that reset the
 * home world to magma. The collisions=off control isolates that: if the control
 * advances and collisions=on does not, spacing/drift is the culprit; if both
 * stall, look at biology instead.
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
const { gameState, BIO_PHASE_SEQUENCE } = await import('../src/simulation/GameState');

const RUNS  = Number(process.argv[2]) || 12;
const TICKS = Number(process.argv[3]) || 400_000;
const MODE  = (process.argv[4] || 'on').toLowerCase(); // on | off | both

type PassResult = {
  advanced: number;
  lost: number;
  catastrophes: number;
  exodus: number;
  reached: string[];
};

function runPass(label: string, collisionsOn: boolean): PassResult {
  console.log(`\n═══ Player world progression (${label}) — ${RUNS} seeds × ${TICKS.toLocaleString()} ticks ═══\n`);
  console.log('  seed          reached          catastrophes  exodus  alive');

  const reached: string[] = [];
  let anyExodus = 0, totalCatastrophes = 0;

  for (let r = 0; r < RUNS; r++) {
    gameState.playerPlanetName = `PP${r}`;
    gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
    // Measures the biology ladder: start the home world formed and alive (lab path).
    gameState.skipFormation = true; gameState.destinyOverride = 'ocean';
    gameState.playerSpecies = []; gameState.codexEntries = []; gameState.playerDNA = {};
    gameState.dnaPoints = 0;

    let catastrophes = 0, exodus = 0;
    const engine = new BigBangEngine(makeCanvas());
    engine.collisionsEnabled = collisionsOn;
    engine.onCivEvent = () => {}; engine.onLifeEvent = () => {};
    (engine as any).onPlanetCatastrophe = () => { catastrophes++; };
    (engine as any).onPlayerExodus = () => { exodus++; };
    (engine as any).onPlayerLifeEmerged = () => {};
    engine.init({ life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 }, `pp_${r}`);

    g.eternalSpeed = 60;
    for (let i = 0; i < TICKS && (engine as any).tick < TICKS; i++) engine.update();

    const ps = engine.getPlayerStar();
    const phase = ps?.biologyPhase ?? 'NO PLAYER STAR';
    reached.push(phase);
    anyExodus += exodus;
    totalCatastrophes += catastrophes;
    const alive = (engine as any).stars.filter((s: any) => !s.isDead).length;
    console.log(`  pp_${String(r).padEnd(10)} ${phase.padEnd(16)} ${String(catastrophes).padStart(11)} ` +
                `${String(exodus).padStart(7)} ${String(alive).padStart(6)}`);
  }

  const idx = (p: string) => BIO_PHASE_SEQUENCE.indexOf(p as never);
  const advanced = reached.filter(p => idx(p) > 0).length;
  const lost = reached.filter(p => p === 'NO PLAYER STAR').length;

  console.log(`\n  advanced past microbial: ${advanced}/${RUNS}`);
  console.log(`  player-world catastrophes across all runs: ${totalCatastrophes}`);
  console.log(`  player exoduses: ${anyExodus}`);

  return { advanced, lost, catastrophes: totalCatastrophes, exodus: anyExodus, reached };
}

let ok = true;
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!pass) ok = false;
};

const assertPass = (result: PassResult, label: string) => {
  check(`${label}: the player always has a home world`, result.lost === 0,
        `${result.lost} runs ended with no player star`);
  // A PASSIVE player — no DNA spent, no nudges — gets no help from the levers the
  // Great Filter fix (M20d) put in their hands, so plenty of these worlds are
  // supposed to stall. The bar is that a decent share still get somewhere on their
  // own: measured at 5/10 after the M22g merger rebalance, against 2/12 before it.
  check(`${label}: a reasonable share of seeds advance past microbial`,
        result.advanced >= Math.ceil(RUNS * 0.35), `${result.advanced}/${RUNS}`);
};

if (MODE === 'off') {
  assertPass(runPass('collisions OFF', false), 'collisions-off');
} else if (MODE === 'both') {
  const off = runPass('collisions OFF', false);
  const on  = runPass('collisions ON', true);
  console.log('\n── M25 control comparison ──');
  console.log(`  collisions-off advanced: ${off.advanced}/${RUNS}  catastrophes: ${off.catastrophes}`);
  console.log(`  collisions-on  advanced: ${on.advanced}/${RUNS}  catastrophes: ${on.catastrophes}`);
  assertPass(on, 'collisions-on');
  // Control is informational — it should usually beat or match the on pass.
  check('collisions-off control is at least as healthy as collisions-on',
        off.advanced >= on.advanced,
        `off ${off.advanced} vs on ${on.advanced}`);
} else {
  assertPass(runPass('collisions ON', true), 'collisions-on');
}

console.log(ok ? '\nAll checks passed.\n' : '');
if (!ok) process.exit(1);
