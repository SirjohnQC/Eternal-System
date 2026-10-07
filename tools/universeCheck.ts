/**
 * The universe's sectors (src/simulation/Universe.ts) and the engine's use of
 * them: every sector rolls 2–5 galaxies; home can be any sector; Entropy makes
 * the universe lumpier; dormant galaxies stay in their own sectors; the home
 * sector's live galaxies match its roll; charting follows the tech ladder; the
 * universe map frames every sector.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/universeCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/universe.mjs --log-level=error && node /tmp/universe.mjs
 *
 * Exits non-zero if any check fails.
 */
const noopCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 1200, height: 800 };
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'getImageData' || prop === 'createImageData') {
      return (a: number, b: number, w = 1, h = 1) =>
        ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
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
  };
}

const g = globalThis as any;
g.document = {
  createElement: () => makeCanvas(),
  getElementById: () => null, querySelector: () => null,
  querySelectorAll: () => [], addEventListener() {},
};
g.window = g;
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.eternalSpeed = 60;

const U = await import('../src/simulation/Universe');
const { BigBangEngine, ZOOM_TIERS } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
const stats = (entropy: number) => ({ life: 12, evolution: 11, hostility: 9, entropy, divine: 10 });

{
  const homes = new Set<number>();
  let badCount = 0, badPlace = 0, dupNames = 0, dupIds = 0;
  const spreadLow: number[] = [], spreadHigh: number[] = [];
  for (let i = 0; i < 300; i++) {
    const c = U.generateCosmos(`u_${i}`, stats(i % 2 ? 19 : 2));
    homes.add(c.home);
    if (c.sectors.length !== U.SECTOR_COUNT) badCount++;
    if (new Set(c.sectors.map(s => s.name)).size !== c.sectors.length) dupNames++;
    const ids = U.dormantGalaxies(c).map(g => g.id);
    if (new Set(ids).size !== ids.length || ids.some(id => id < 100)) dupIds++;
    for (const s of c.sectors) {
      if (s.galaxyCount < 2 || s.galaxyCount > 5) badCount++;
      if (!s.home && s.galaxies.length !== s.galaxyCount) badCount++;
      for (const g of s.galaxies) if (U.sectorAt(c, g.cx, g.cy) !== s.index) badPlace++;
    }
    const counts = c.sectors.map(s => s.galaxyCount);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
    (i % 2 ? spreadHigh : spreadLow).push(sd);
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  check('nine sectors of 2–5 galaxies', badCount === 0, `${badCount} bad`);
  check('home can be any sector', homes.size === U.SECTOR_COUNT, `${homes.size} distinct`);
  check('dormant galaxies sit in their own sector', badPlace === 0, `${badPlace}`);
  check('sector names unique, dormant ids unique and clear of home ids', dupNames === 0 && dupIds === 0);
  check('Entropy makes the universe lumpier', avg(spreadHigh) > avg(spreadLow) * 1.3, `sd ${avg(spreadLow).toFixed(2)} → ${avg(spreadHigh).toFixed(2)}`);
  const c = U.generateCosmos('same', stats(10)), d = U.generateCosmos('same', stats(10));
  check('deterministic per seed', JSON.stringify(c) === JSON.stringify(d));
  check('charting: none early, neighbours at Space Age, all when Interstellar',
    U.chartedByTech(c, 4).length === 0 &&
    U.chartedByTech(c, 5).every(i => U.sectorDistance(c, i, c.home) === 1) && U.chartedByTech(c, 5).length >= 3 &&
    U.chartedByTech(c, 6).length === U.SECTOR_COUNT - 1);
}

{
  const e: any = new BigBangEngine(makeCanvas());
  e.init(stats(10), 'universe_engine');
  const c = e.cosmos;
  const live = e.currentGalaxies.filter((g: any) => g.starIds.length >= 0);
  check('home sector holds its rolled number of galaxies', live.length === c.sectors[c.home].galaxyCount, `${live.length} vs ${c.sectors[c.home].galaxyCount}`);
  check('home sector is where the simulation lives', e.stars.every((s: any) => U.sectorAt(c, s.x, s.y) === c.home));
  check('tiers: universe map, sector, galaxy, system, planet', ZOOM_TIERS.map((t: any) => t.tier).join() === 'cosmos,universe,galaxy,system,planet');
  const f = e.cosmosFrame();
  const W = 1200;
  const cornersVisible = c.sectors.every((s: any) => Math.abs(s.ox + 2800 - f.x) * f.scale < W / 2 + 1);
  check('the universe map frames every sector', f.scale < 0.06 && cornersVisible, `scale ${f.scale.toFixed(3)}`);
  e.setZoomTier('cosmos');
  check('the map button lands on the universe-map tier', (() => { e['camera'].scale = e['camera'].ts; return e.zoomTier === 'cosmos'; })());
  gameState.sectorsCharted = [];
  e.getPlayerStar().civLevel = 6;
  e['updateSectorCharting']();
  check('an interstellar people charts every sector', gameState.sectorsCharted.length === U.SECTOR_COUNT - 1 && c.sectors.every((s: any) => ['home', 'charted'].includes(e.sectorStateOf(s.index))));
  gameState.sectorsCharted = [];
}

console.log(failures ? `\n${failures} FAILED` : '\nall universe checks passed');
process.exit(failures ? 1 : 0);
