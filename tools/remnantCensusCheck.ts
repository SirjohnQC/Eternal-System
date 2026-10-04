/**
 * Dev-only: denser star census + visible dead remnants.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/remnantCensusCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/rc.mjs && node $TMP/rc.mjs
 *
 * Contract:
 *   - life 1 → ~20 stars, life 20 → ~60 (18 + life×2.1)
 *   - morph weights: elliptical/lenticular denser than irregular
 *   - entropy-weighted primordial remnants (~8–15%) with remnantKind + husk planets
 *   - detonateStar leaves a remnant (not a vanishing star)
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

function prep(seed: string, life: number, entropy: number): InstanceType<typeof BigBangEngine> {
  gameState.playerPlanetName = 'Remnant';
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  // Measures the biology ladder: start the home world formed and alive (lab path).
  gameState.skipFormation = true; gameState.destinyOverride = 'ocean';
  gameState.playerSpecies = []; gameState.codexEntries = []; gameState.playerDNA = {};
  const engine = new BigBangEngine(makeCanvas());
  engine.onCivEvent = () => {}; engine.onLifeEvent = () => {};
  engine.init(
    { life, evolution: 10, hostility: 8, entropy, divine: 10 },
    seed,
  );
  return engine;
}

function expectedCensus(life: number): number {
  return Math.floor(18 + life * 2.1);
}

console.log('\n═══ Remnant census ═══');

{
  const low = prep('census_life1', 1, 10);
  const high = prep('census_life20', 20, 10);
  const nLow = low.stars.length;
  const nHigh = high.stars.length;
  check('life 1 yields ~20 systems', Math.abs(nLow - expectedCensus(1)) <= 0, `${nLow} (want ${expectedCensus(1)})`);
  check('life 20 yields ~60 systems', Math.abs(nHigh - expectedCensus(20)) <= 0, `${nHigh} (want ${expectedCensus(20)})`);
  check('high life has more systems than low', nHigh > nLow, `${nLow} → ${nHigh}`);
}

{
  // Aggregate morph density — ellipticals denser than spirals; irregulars sparsest.
  const dense: number[] = [];
  const medium: number[] = [];
  const sparse: number[] = [];
  for (let i = 0; i < 24; i++) {
    const e = prep(`morph_${i}`, 16, 12);
    for (const gal of e.currentGalaxies) {
      const n = gal.starIds.length;
      if (gal.morph === 'elliptical' || gal.morph === 'lenticular') dense.push(n);
      else if (gal.morph === 'irregular') sparse.push(n);
      else medium.push(n);
    }
  }
  const avg = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const d = avg(dense);
  const m = avg(medium);
  const s = avg(sparse);
  check(
    'elliptical/lenticular denser than spiral/barred',
    dense.length === 0 || medium.length === 0 || d > m * 1.05,
    `dense=${d.toFixed(1)} medium=${m.toFixed(1)}`,
  );
  check(
    'irregular sparser than spiral/barred (when both appear)',
    sparse.length === 0 || medium.length === 0 || s < m * 0.95,
    `sparse=${s.toFixed(1)} medium=${m.toFixed(1)} nS=${sparse.length}`,
  );
}

{
  let remnantStars = 0;
  let huskPlanets = 0;
  let playerDead = false;
  for (let i = 0; i < 20; i++) {
    const e = prep(`primord_${i}`, 14, 18);
    for (const star of e.stars) {
      if (star.isPlayerStar && star.isDead) playerDead = true;
      if (!star.isDead) continue;
      remnantStars++;
      if (!(star as any).remnantKind) {
        check('primordial dead has remnantKind', false, `star ${star.id}`);
      }
      for (const p of star.planets) {
        if ((p as any).isDead) huskPlanets++;
      }
    }
  }
  check('player star is never a primordial remnant', !playerDead);
  check('some primordial remnants spawn at high entropy', remnantStars >= 8, `${remnantStars} dead stars across trials`);
  check('remnant systems carry husk planets', huskPlanets >= remnantStars, `${huskPlanets} husks / ${remnantStars} remnants`);
}

{
  const e = prep('detonate_keep', 12, 10);
  const victim = e.stars.find(s => !s.isPlayerStar && !s.isDead)!;
  const beforePlanets = victim.planets.length;
  (e as any).detonateStar(victim, 'test blast');
  check('detonateStar leaves remnant in place', victim.isDead && !!(victim as any).remnantKind, `dead=${victim.isDead} kind=${(victim as any).remnantKind}`);
  check('detonateStar keeps husk planets', victim.planets.length === beforePlanets && victim.planets.every((p: any) => p.isDead), `${victim.planets.length} planets`);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All checks passed.\n');
