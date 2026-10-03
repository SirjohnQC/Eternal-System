/**
 * Dev-only: solar systems stay islands, and 1× orrery motion stays readable.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/cosmicSpacingCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/cs.mjs && node $TMP/cs.mjs
 *
 * Regression this guards: stars packed into ~25wu of each other (solar systems
 * overlapping) while planets completed a year in ~9 seconds at 60fps — blender
 * speed even at 1×. Placement advertised MIN_STAR_SEPARATION but inflation and
 * a best-effort fallback never actually landed stars that far apart.
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

const FPS = 60;
/** Inner planets must take at least this long for one revolution at 1×. */
const MIN_YEAR_SECONDS = 70;
/** Stars in the same galaxy must sit at least this far apart after orbits lock. */
const MIN_SETTLED_SEP = 240;

function systemExtent(star: any): number {
  let max = star.radius * 3.4;
  for (const p of star.planets) max = Math.max(max, p.orbitalRadius + p.radius);
  return max;
}

function settle(engine: InstanceType<typeof BigBangEngine>): any[] {
  g.eternalSpeed = 60;
  while ((engine as any).tick < 280) engine.update();
  g.eternalSpeed = 1;
  return ((engine as any).stars as any[]).filter(s => !s.isDead);
}

console.log('\n═══ Cosmic spacing + 1× orrery ═══');

const seeds = ['diag_a', 'galaxy_seed', 'moon_seed', 'sparse_1'];
let worstSep = Infinity;
let overlapPairs = 0;
let fastestYear = Infinity;
let slowestYear = 0;
let keplerOk = true;
let keplerChecked = 0;

for (const seed of seeds) {
  gameState.playerPlanetName = 'Spacing';
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  gameState.playerSpecies = []; gameState.codexEntries = []; gameState.playerDNA = {};

  const engine = new BigBangEngine(makeCanvas());
  engine.onCivEvent = () => {}; engine.onLifeEvent = () => {};
  engine.init({ life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 }, seed);
  const stars = settle(engine);

  for (let i = 0; i < stars.length; i++) {
    for (let j = i + 1; j < stars.length; j++) {
      if (stars[i].galaxyId !== stars[j].galaxyId) continue;
      const d = Math.hypot(stars[i].x - stars[j].x, stars[i].y - stars[j].y);
      if (d < worstSep) worstSep = d;
      if (d < systemExtent(stars[i]) + systemExtent(stars[j])) overlapPairs++;
    }
  }

  for (const star of stars) {
    const planets = [...star.planets].sort((a, b) => a.orbitalRadius - b.orbitalRadius);
    for (const p of planets) {
      const year = (2 * Math.PI) / p.orbitalSpeed / FPS;
      if (year < fastestYear) fastestYear = year;
      if (year > slowestYear) slowestYear = year;
    }
    if (planets.length >= 2) {
      const innerP = planets[0];
      const outerP = planets[planets.length - 1];
      // Jitter of ±15% can reorder close rungs; only the wide gap must stay Keplerian.
      if (outerP.orbitalRadius >= innerP.orbitalRadius * 1.8) {
        keplerChecked++;
        if (!(innerP.orbitalSpeed > outerP.orbitalSpeed)) keplerOk = false;
      }
    }
  }
}

check('same-galaxy systems stay islands after the Big Bang',
  worstSep >= MIN_SETTLED_SEP,
  `closest pair ${worstSep.toFixed(1)}wu (need ≥ ${MIN_SETTLED_SEP})`);

check('solar-system envelopes do not overlap',
  overlapPairs === 0,
  `${overlapPairs} overlapping pairs across ${seeds.length} seeds`);

check('even the fastest planet year is watchable at 1×',
  fastestYear >= MIN_YEAR_SECONDS,
  `fastest ${fastestYear.toFixed(1)}s / slowest ${slowestYear.toFixed(1)}s (need ≥ ${MIN_YEAR_SECONDS}s)`);

check('inner worlds still outrun the fringe (Kepler + jitter)',
  keplerOk && keplerChecked > 0,
  `${keplerChecked} systems checked`);

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All checks passed.\n');
