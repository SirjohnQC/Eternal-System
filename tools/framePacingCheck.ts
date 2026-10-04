/**
 * Dev-only: sim + orrery pace to wall-clock, not refresh rate.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/framePacingCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/fp.mjs && node $TMP/fp.mjs
 *
 * Contract (existing balance):
 *   - 1× settled sim ≈ 1 tick per real second (`speed/60` per 60Hz frame)
 *   - animTick ≈ 60 units per real second (orrery / VFX)
 *
 * On a 240Hz display, frame-counted pacing made 1× run ~4× fast. After the
 * fix, 60Hz and 240Hz must match wall-clock.
 */

const noopCtx = new Proxy({}, { get(_t, p) {
  if (p === 'canvas') return { width: 800, height: 600 };
  if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
  if (p === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w*h*4), width: w, height: h });
  if (p === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w*h*4), width: w, height: h });
  if (p === 'putImageData') return () => {};
  if (p === 'measureText') return () => ({ width: 10 });
  return () => undefined;
}, set() { return true; } });
function makeCanvas(): any {
  return { width: 800, height: 600, style: {}, getContext: () => noopCtx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), toDataURL: () => '' };
}
const g = globalThis as any;
g.document = { createElement: (tag: string) => tag === 'canvas' ? makeCanvas() : { style: {} },
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
g.window = g; g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {};
g.addEventListener = () => {};
let fakeNow = 1000;
g.performance = { now: () => fakeNow };
g.Image = class { set src(_v: string) {} }; g.eternalSpeed = 1;

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log(`  FAIL  ${name}  — ${detail}`); }
}

function prep(seed: string): InstanceType<typeof BigBangEngine> {
  gameState.playerPlanetName = 'Pace';
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  // Measures the biology ladder: start the home world formed and alive (lab path).
  gameState.skipFormation = true; gameState.destinyOverride = 'ocean';
  gameState.playerSpecies = []; gameState.codexEntries = []; gameState.playerDNA = {};
  const engine = new BigBangEngine(makeCanvas());
  engine.onCivEvent = () => {}; engine.onLifeEvent = () => {};
  engine.init({ life: 10, evolution: 10, hostility: 8, entropy: 8, divine: 10 }, seed);
  // Skip inflation visuals — jump to settled pacing.
  (engine as any).phase = 'settled';
  (engine as any).tick = 1000;
  return engine;
}

/** Drive the real RAF loop path with a fixed refresh period. */
function runHz(engine: InstanceType<typeof BigBangEngine>, hz: number, realSeconds: number): { ticks: number; anim: number } {
  g.eternalSpeed = 1;
  const startTick = engine.tick;
  const startAnim = engine.currentAnimTick;
  engine.start();
  const frameMs = 1000 / hz;
  const frames = Math.round(realSeconds * hz);
  for (let i = 0; i < frames; i++) {
    fakeNow += frameMs;
    (engine as any).loop();
  }
  engine.stop();
  return { ticks: engine.tick - startTick, anim: engine.currentAnimTick - startAnim };
}

console.log('\n═══ Frame pacing (refresh-rate independence) ═══');

{
  const e60 = prep('pace_60');
  const a = runHz(e60, 60, 1);
  const e240 = prep('pace_240');
  const b = runHz(e240, 240, 1);

  check('at 60Hz, 1s of 1× advances ~1 sim tick', a.ticks === 1, `${a.ticks} ticks`);
  check('at 240Hz, 1s of 1× still advances ~1 sim tick', b.ticks === 1, `${b.ticks} ticks`);
  check('animTick tracks ~60 units per real second at 240Hz', Math.abs(b.anim - 60) <= 2, `${b.anim.toFixed(1)} anim`);
  check('60Hz and 240Hz sim pace match', a.ticks === b.ticks, `60Hz=${a.ticks} 240Hz=${b.ticks}`);
  check('60Hz anim also ~60/s', Math.abs(a.anim - 60) <= 2, `${a.anim.toFixed(1)} anim`);
}

{
  // Headless tools call update() in a tight loop without start() — must keep
  // the old "one nominal frame per call" contract (speed 60 → 1 tick/call).
  const e = prep('pace_headless');
  g.eternalSpeed = 60;
  const t0 = e.tick;
  for (let i = 0; i < 100; i++) e.update();
  check('headless update() still advances 1 tick per call at speed 60', e.tick - t0 === 100, `${e.tick - t0}`);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All checks passed.\n');
