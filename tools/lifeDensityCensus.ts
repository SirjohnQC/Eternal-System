/**
 * Does `GridCell.lifeDensity` actually move during real play, or is it another
 * declared-but-unwritten field? Decal density is planned to key off it.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/lifeDensityCensus.ts --bundle --platform=node \
 *     --format=esm --outfile=%TEMP%/life.mjs && node %TEMP%/life.mjs 400000
 */
const TICKS = Number(process.argv[2]) || 400_000;

// Minimal DOM stub, installed BEFORE the engine module is imported. This
// mirrors tools/engineSim.ts — copy its stub verbatim rather than inventing a
// smaller one; the engine touches more of the DOM than you expect.
const noopCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 1200, height: 800 };
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'getImageData' || prop === 'createImageData') {
      return (...a: number[]) => {
        const w = a.length > 2 ? a[2] : a[0], h = a.length > 2 ? a[3] : a[1];
        return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
      };
    }
    if (prop === 'measureText') return () => ({ width: 10 });
    return () => undefined;
  },
  set() { return true; },
});
function makeCanvas(): any {
  return {
    width: 1200, height: 800, style: {},
    getContext: () => noopCtx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    toDataURL: () => '',
  };
}
const g = globalThis as any;
g.document = {
  createElement: () => makeCanvas(), getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
};
g.window = g;
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.addEventListener = () => {};
g.performance = g.performance ?? { now: () => Date.now() };
g.Image = class { set src(_v: string) {} };
g.eternalSpeed = 1;

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState, runtimeState } = await import('../src/simulation/GameState');
const { generatePlanetGrid } = await import('../src/simulation/PlanetGrid');

gameState.playerPlanetName = 'Census';
gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
gameState.playerSpecies = [];

const engine: any = new BigBangEngine(makeCanvas());
engine.init({ life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 }, 'census_seed');
engine.onCivEvent = () => {};
engine.onLifeEvent = () => {};

// DEVIATION FROM BRIEF, recorded here and in task-1-report.md: the brief's
// code assumes runtimeState.playerPlanetGrid gets populated by the engine's
// own tick loop. It does not. `generatePlanetGrid` is called in exactly one
// place in the whole codebase — src/main.ts:1011-1018, `openPlanetView` —
// lazily, the first time the UI opens the planet overlay. Nothing in
// BigBangEngine.update() or any of its callbacks (onPlanetFormationProgress,
// onPlayerLifeEmerged, etc.) ever calls it. Verified empirically too: running
// the brief's tool unmodified exits `FAIL: runtimeState.playerPlanetGrid is
// null` at 2,000 ticks with no other change. Since stepLifeSpread() only
// touches a grid that already exists (BigBangEngine.ts:2016, gated on
// `runtimeState.playerPlanetGrid` being non-null), a census that never
// creates the grid cannot measure anything — not "flat", genuinely never
// written. Mirroring main.ts's lazy-init here (same seed formula) is the
// minimum change that makes the question answerable at all, and matches
// what happens in real play once a player looks at their home world.
{
  const ps = engine.getPlayerStar();
  if (ps) {
    const home = ps.planets.findIndex((p: any) => p.discovery === 'landing' || p.hasLife);
    const planetIndex = home >= 0 ? home : 0;
    const planet = ps.planets[planetIndex] ?? ps.planets[0];
    const gridSeed = ps.id * 7777 + planetIndex * 131;
    runtimeState.playerPlanetGrid = generatePlanetGrid(planet?.type ?? 'rocky', gridSeed, gameState.playerPlanetDNA);
  }
}

g.eternalSpeed = 60;
for (let i = 0; i < TICKS; i++) engine.update(1 / 60);

const grid = runtimeState.playerPlanetGrid;
if (!grid) { console.error('FAIL: runtimeState.playerPlanetGrid is null'); process.exit(1); }

let land = 0, withLife = 0, sum = 0, max = 0;
const buckets = new Array(10).fill(0);
for (const row of grid) {
  for (const cell of row) {
    if ((cell.fertility ?? 0) <= 0) continue;
    land++;
    const v = cell.lifeDensity ?? 0;
    sum += v; max = Math.max(max, v);
    if (v > 0.02) withLife++;
    buckets[Math.min(9, Math.floor(v * 10))]++;
  }
}
console.log(`
  ticks ${TICKS}  fertile cells ${land}`);
console.log(`  cells with lifeDensity > 0.02 : ${withLife} (${(withLife / Math.max(1, land) * 100).toFixed(1)}%)`);
console.log(`  mean ${(sum / Math.max(1, land)).toFixed(3)}   max ${max.toFixed(3)}`);
console.log('  histogram (0.0-1.0):', buckets.join(' '));

// The decal readout needs SOME spread, not one value everywhere.
const ok = withLife / Math.max(1, land) > 0.05 && max > 0.15;
console.log(ok
  ? '\n  USABLE — lifeDensity varies across the grid; keep it as a decal driver.'
  : '\n  NOT USABLE — lifeDensity is flat/zero in practice. Task 3 must drop it '
    + 'and weight on fertility * lush alone. Record this in the plan before continuing.');
process.exit(0);
