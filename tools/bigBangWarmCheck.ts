/**
 * Dev-only: Big Bang visual caches can be warmed before start().
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/bigBangWarmCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/bbwarm.mjs && node $TMP/bbwarm.mjs
 *
 * Guards the loading-screen precache: init alone used to leave galaxy sprites
 * cold, so the first inflation frames hitch while baking 128² envelopes.
 */

const noopCtx = new Proxy({}, { get(_t, p) {
  if (p === 'canvas') return { width: 1200, height: 800 };
  if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
  if (p === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w*h*4), width: w, height: h });
  if (p === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w*h*4), width: w, height: h });
  if (p === 'putImageData') return () => {};
  if (p === 'measureText') return () => ({ width: 10 });
  return () => undefined;
}, set() { return true; } });
function makeCanvas(): any {
  return { width: 1200, height: 800, style: {}, getContext: () => noopCtx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }), toDataURL: () => '' };
}
const g = globalThis as any;
g.document = { createElement: (tag: string) => {
  if (tag === 'canvas') return makeCanvas();
  return { style: {}, appendChild() {}, removeChild() {} };
}, getElementById: () => null,
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

console.log('\n═══ Big Bang warm / precache ═══');

gameState.playerPlanetName = 'Warm';
gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
gameState.playerSpecies = []; gameState.codexEntries = []; gameState.playerDNA = {};

const engine = new BigBangEngine(makeCanvas());
engine.onCivEvent = () => {}; engine.onLifeEvent = () => {};
engine.init({ life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 }, 'warm_seed');

check('init leaves the loop stopped', !(engine as any).running);

const warm = (engine as any).warmVisualCaches;
check('warmVisualCaches exists', typeof warm === 'function');

if (typeof warm === 'function') {
  const before = (engine as any).galaxySpriteCache?.size ?? -1;
  await warm.call(engine);
  const after = (engine as any).galaxySpriteCache?.size ?? 0;
  const gals = engine.currentGalaxies.length;
  check('warming fills the galaxy sprite cache', after >= gals && after > 0,
        `cache=${after}, galaxies=${gals} (was ${before})`);
  check('still not running after warm', !(engine as any).running);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All checks passed.\n');
