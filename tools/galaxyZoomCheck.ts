/**
 * Dev-only: galaxies (M22b) and zoom tiers (M22a).
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/galaxyZoomCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/gz.mjs && node $TMP/gz.mjs
 *
 * The visual side of this can be looked at in the browser; the parts that can be
 * silently WRONG are whether stars actually clump into their galaxies rather
 * than staying uniformly scattered, and whether the tier thresholds are
 * self-consistent. Both are checked here, the first against a uniform-scatter
 * control.
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

const { BigBangEngine, ZOOM_TIERS } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log(`  FAIL  ${name}  — ${detail}`); }
}

// ── Zoom tiers ──────────────────────────────────────────────────────────────
console.log('\n═══ Zoom tiers (M22a) ═══');
{
  check('four tiers, universe → planet', ZOOM_TIERS.length === 4 &&
        ZOOM_TIERS.map(t => t.tier).join(',') === 'universe,galaxy,system,planet',
        ZOOM_TIERS.map(t => t.tier).join(' → '));

  const ascending = ZOOM_TIERS.every((t, i) => i === 0 || t.min > ZOOM_TIERS[i - 1].min);
  check('thresholds ascend', ascending,
        ZOOM_TIERS.map(t => t.min).join(' < '));

  // Every tier's nominal scale must actually land inside that tier, or a button
  // press moves the camera somewhere the indicator then disagrees about.
  const tierAt = (sc: number) => {
    let out = ZOOM_TIERS[0].tier;
    for (const t of ZOOM_TIERS) if (sc >= t.min) out = t.tier;
    return out;
  };
  const consistent = ZOOM_TIERS.every(t => tierAt(t.nominal) === t.tier);
  check('each tier\'s nominal scale lands in that tier', consistent,
        ZOOM_TIERS.map(t => `${t.tier}@${t.nominal}→${tierAt(t.nominal)}`).join(', '));
}

// ── Galaxies ────────────────────────────────────────────────────────────────
console.log('\n═══ Galaxies (M22b) ═══');
{
  gameState.playerPlanetName = 'Gal';
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  // Measures the biology ladder: start the home world formed and alive (lab path).
  gameState.skipFormation = true; gameState.destinyOverride = 'ocean';
  gameState.playerSpecies = []; gameState.codexEntries = []; gameState.playerDNA = {};

  const engine = new BigBangEngine(makeCanvas());
  engine.onCivEvent = () => {}; engine.onLifeEvent = () => {};
  engine.init({ life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 }, 'galaxy_seed');

  const galaxies = engine.currentGalaxies;
  check('the universe has galaxies', galaxies.length >= 3, `${galaxies.length}`);
  check('every galaxy is named', galaxies.every(gx => gx.name.length > 0),
        galaxies.map(gx => gx.name).join(' · '));
  check('every star belongs to one', (engine as any).stars.every((s: any) => s.galaxyId != null));

  const sizes = galaxies.map(gx => gx.starIds.length);
  check('galaxies differ in size', Math.max(...sizes) > Math.min(...sizes),
        `${Math.min(...sizes)} – ${Math.max(...sizes)} stars`);

  // Let inflation resolve, so stars actually reach their galaxies.
  g.eternalSpeed = 60;
  for (let i = 0; i < 40_000 && (engine as any).tick < 40_000; i++) engine.update();

  const stars = (engine as any).stars.filter((s: any) => !s.isDead);

  /** Mean distance from each star to its own galaxy's centre. */
  const meanToOwn = (assign: (s: any) => number) => {
    let sum = 0, n = 0;
    for (const s of stars) {
      const gx = galaxies.find(q => q.id === assign(s));
      if (!gx) continue;
      sum += Math.hypot(s.x - gx.x, s.y - gx.y); n++;
    }
    return n ? sum / n : 0;
  };

  const actual = meanToOwn(s => s.galaxyId);
  // CONTROL: the same stars assigned to galaxies at RANDOM. If inflation did not
  // actually cluster anything, the true assignment is no better than this.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const control = meanToOwn(() => galaxies[Math.floor(rnd() * galaxies.length)].id);

  console.log(`  mean distance to own galaxy centre: ${actual.toFixed(0)}`);
  console.log(`  control (random assignment):        ${control.toFixed(0)}`);
  check('stars really do clump into their galaxies', actual < control * 0.7,
        `${actual.toFixed(0)} vs ${control.toFixed(0)} random — ${((1 - actual / control) * 100).toFixed(0)}% tighter`);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All checks passed.\n');
