/**
 * Dev-only: across many seeds, does the PLAYER's world reliably get somewhere?
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/playerProgressCheck.ts --bundle \
 *     --platform=node --format=esm --outfile=$TMP/pp.mjs && node $TMP/pp.mjs
 *
 * The smoke test asserts this on ONE seed, which cannot distinguish "the model
 * is broken" from "this particular universe was unlucky". M22g adds collision
 * supernovae and moves the player's world around, and M22k draws from the same
 * RNG during generation, so every seed's trajectory shifted. This measures the
 * distribution instead of a single sample, and reports how often the player's
 * world is knocked back to magma so the cost of the new mechanic is visible.
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

console.log(`\n═══ Player world progression — ${RUNS} seeds × ${TICKS.toLocaleString()} ticks ═══\n`);
console.log('  seed          reached          catastrophes  exodus  alive');

const reached: string[] = [];
let anyExodus = 0, totalCatastrophes = 0;

for (let r = 0; r < RUNS; r++) {
  gameState.playerPlanetName = `PP${r}`;
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  gameState.playerSpecies = []; gameState.codexEntries = []; gameState.playerDNA = {};
  gameState.dnaPoints = 0;

  let catastrophes = 0, exodus = 0;
  const engine = new BigBangEngine(makeCanvas());
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

let ok = true;
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!pass) ok = false;
};

// The one that actually matters: the player must never be left without a world.
check('the player always has a home world', lost === 0,
      `${lost} runs ended with no player star`);
// A PASSIVE player — no DNA spent, no nudges — gets no help from the levers the
// Great Filter fix (M20d) put in their hands, so plenty of these worlds are
// supposed to stall. The bar is that a decent share still get somewhere on their
// own: measured at 5/10 after the M22g merger rebalance, against 2/12 before it.
check('a reasonable share of seeds advance past microbial',
      advanced >= Math.ceil(RUNS * 0.35), `${advanced}/${RUNS}`);

console.log(ok ? '\nAll checks passed.\n' : '');
if (!ok) process.exit(1);
