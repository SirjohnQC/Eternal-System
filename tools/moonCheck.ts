/**
 * Dev-only: do moons exist, vary, and get settled?
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/moonCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/moons.mjs && node $TMP/moons.mjs
 *
 * Before M22k there was no moon entity anywhere in the engine — the diorama drew
 * one hard-coded grey disc that belonged to nothing. The control here is that
 * exact state: identical size and colour everywhere, and nothing colonisable.
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
import type { Moon } from '../src/simulation/BigBangEngine';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log(`  FAIL  ${name}  — ${detail}`); }
}

console.log('\n═══ Moons ═══');

gameState.playerPlanetName = 'Moontest';
gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
gameState.playerSpecies = []; gameState.codexEntries = []; gameState.playerDNA = {};

const engine = new BigBangEngine(makeCanvas());
engine.onCivEvent = () => {}; engine.onLifeEvent = () => {};
engine.init({ life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 }, 'moon_seed');

const stars = (engine as any).stars as any[];
const allMoons: Moon[] = [];
let planetsWithMoons = 0, planetsTotal = 0;
for (const st of stars) {
  for (const pl of st.planets) {
    planetsTotal++;
    if (pl.moons.length > 0) planetsWithMoons++;
    for (const m of pl.moons) allMoons.push(m);
    // A moon must never be larger than the world it orbits.
    for (const m of pl.moons) {
      if (m.radius >= pl.radius) {
        failures.push(`moon ${m.name} is bigger than its planet`);
      }
    }
  }
}

console.log(`  ${allMoons.length} moons across ${planetsTotal} planets ` +
            `(${planetsWithMoons} planets have at least one)`);

check('moons exist at all', allMoons.length > 0, `${allMoons.length} moons`);
check('not every planet has moons', planetsWithMoons < planetsTotal,
      `${planetsWithMoons}/${planetsTotal}`);
check('no moon outsizes its planet', failures.length === 0);

// ── Variation. The control is the old behaviour: one size, one colour. ──────
const radii = allMoons.map(m => m.radius);
const rMin = Math.min(...radii), rMax = Math.max(...radii);
check('moons vary in size', rMax > rMin * 1.8,
      `radius ${rMin.toFixed(2)} – ${rMax.toFixed(2)} (${(rMax / rMin).toFixed(1)}× spread)`);

const colours = new Set(allMoons.map(m => m.color));
check('moons vary in colour', colours.size >= 3,
      `${colours.size} distinct colours`);

const kinds = new Map<string, number>();
for (const m of allMoons) kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + 1);
console.log('  compositions: ' + [...kinds.entries()]
  .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', '));
check('several compositions occur', kinds.size >= 3, `${kinds.size} kinds`);

// ── Habitability spread ─────────────────────────────────────────────────────
const habs = allMoons.map(m => m.habitability).sort((a, b) => a - b);
const q = (p: number) => habs[Math.min(habs.length - 1, Math.floor(p * habs.length))];
console.log(`  habitability: p10 ${q(0.1).toFixed(2)}  median ${q(0.5).toFixed(2)}  p90 ${q(0.9).toFixed(2)}`);
check('habitability actually varies', q(0.9) - q(0.1) > 0.2,
      `spread ${(q(0.9) - q(0.1)).toFixed(2)}`);
check('some moons are worth settling and some are not',
      habs.some(h => h > 0.5) && habs.some(h => h < 0.25));

// ── Colonisation only once a civilisation can reach them ────────────────────
{
  const before = allMoons.filter(m => m.colonised).length;
  check('nothing is colonised at tick 0', before === 0, `${before} colonised`);

  // Drive the sim far enough for civilisations to reach the Space Age.
  g.eternalSpeed = 60;
  for (let i = 0; i < 500_000 && (engine as any).tick < 500_000; i++) engine.update();

  let colonised = 0, spacefaring = 0;
  const laterMoons: Moon[] = [];
  for (const st of (engine as any).stars) {
    if (st.civLevel >= 5) spacefaring++;
    for (const pl of st.planets) for (const m of pl.moons) {
      laterMoons.push(m);
      if (m.colonised) colonised++;
    }
  }
  console.log(`  after 500k ticks: ${spacefaring} space-age civilisations, ${colonised} moons settled`);
  check('advanced civilisations settle moons', spacefaring === 0 || colonised > 0,
        `${colonised} settled by ${spacefaring} space-age civs`);
  check('poor moons are left alone',
        laterMoons.some(m => !m.colonised && m.habitability < 0.2) || laterMoons.length === 0,
        'at least one low-habitability moon remains unsettled');
}

console.log(`\n═══ RESULT: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('All checks passed.\n');
