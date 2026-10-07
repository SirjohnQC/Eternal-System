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
// Measures the biology ladder: start the home world formed and alive (lab path).
gameState.skipFormation = true; gameState.destinyOverride = 'ocean';
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

// ── Sizes and counts (moons of clearly different sizes; more than one) ────
// Control: the pre-2026-10-06 roll gave ordinary worlds at most 1 moon (2 when
// radius > 0.9), gas giants at most 4, and two size bands that overlapped
// heavily; within one system the biggest/smallest ratio rarely passed 2.
{
  const { moonSizeClass, moonIsIrregular, moonInclination } = await import('../src/simulation/MoonSize');
  const classes = new Map<string, number>();
  let ordinaryMulti = 0, ordinaryWithMoons = 0, gasCount = 0, gasMoonsMax = 0;
  let ordinaryThree = 0, gasSpreadOk = 0, gasTotal = 0, overlapping = 0, irregular = 0, sameTilt = 0;
  const countsHist = new Map<number, number>();
  for (const st of stars) for (const pl of st.planets) {
    const ms: Moon[] = pl.moons;
    countsHist.set(ms.length, (countsHist.get(ms.length) ?? 0) + 1);
    for (const m of ms) {
      const c = moonSizeClass(m, pl);
      classes.set(c, (classes.get(c) ?? 0) + 1);
      if (moonIsIrregular(m, pl)) irregular++;
    }
    if (pl.type === 'gas') {
      gasTotal++; gasCount += ms.length; gasMoonsMax = Math.max(gasMoonsMax, ms.length);
      if (ms.length >= 2) {
        const r = ms.map(m => m.radius);
        if (Math.max(...r) >= Math.min(...r) * 3) gasSpreadOk++;
      }
    } else if (ms.length > 0) {
      ordinaryWithMoons++;
      if (ms.length >= 2) ordinaryMulti++;
      if (ms.length >= 3) ordinaryThree++;
    }
    // Neighbouring orbits must clear both bodies.
    const sorted = [...ms].sort((a, b) => a.orbitalRadius - b.orbitalRadius);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].orbitalRadius - sorted[i - 1].orbitalRadius < sorted[i].radius + sorted[i - 1].radius) overlapping++;
    }
    for (let i = 1; i < ms.length; i++) if (moonInclination(ms[i], i) === moonInclination(ms[i - 1], i - 1)) sameTilt++;
  }
  console.log('  moons per planet: ' + [...countsHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join('  '));
  console.log('  size classes: ' + [...classes.entries()].map(([k, n]) => `${k}×${n}`).join(', '));
  check('all four size classes occur', classes.size === 4, `${classes.size} classes`);
  check('ordinary worlds sometimes have 2-3 moons', ordinaryMulti >= Math.max(1, ordinaryWithMoons * 0.2),
        `${ordinaryMulti}/${ordinaryWithMoons} mooned ordinary worlds have several`);
  check('some ordinary worlds have three moons (old roll capped them at 2)', ordinaryThree > 0, `${ordinaryThree} worlds`);
  check('gas giants keep retinues', gasTotal === 0 || (gasCount / gasTotal >= 3 && gasMoonsMax >= 5),
        `mean ${(gasCount / Math.max(1, gasTotal)).toFixed(1)}, max ${gasMoonsMax}`);
  check('a gas giant\'s moons differ clearly in size', gasTotal === 0 || gasSpreadOk >= gasTotal * 0.7,
        `${gasSpreadOk}/${gasTotal} have biggest >= 3x smallest`);
  check('captured rocks are lumpy', irregular > 0, `${irregular} irregular`);
  check('moon orbits never overlap', overlapping === 0, `${overlapping} overlapping pairs`);
  check('moons in one system cross the sky on different tilts', sameTilt === 0, `${sameTilt} shared tilts`);

  // Old saves: a moon without the new fields still answers sensibly.
  const old: Moon = { name: 'Old-a', radius: 0.1, orbitalRadius: 3, orbitalAngle: 0, orbitalSpeed: 0.005,
    color: '#b9b2a6', kind: 'rock', habitability: 0.2, colonised: false, colonisedTick: null };
  const parent = { radius: 1, type: 'rocky' as const };
  const tilt = moonInclination(old, 0);
  check('old-save moons default sensibly', typeof moonIsIrregular(old, parent) === 'boolean'
        && Number.isFinite(tilt) && Math.abs(tilt) <= 0.35 && moonInclination(old, 0) === tilt,
        `irregular=${moonIsIrregular(old, parent)} tilt=${tilt.toFixed(3)}`);
}

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
