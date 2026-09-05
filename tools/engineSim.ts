/**
 * Dev-only headless run of the real BigBangEngine.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/engineSim.ts --bundle --platform=node  *     --format=esm --outfile=/tmp/enginesim.mjs && node /tmp/enginesim.mjs 400000 6
 *
 * Bundles with esbuild and runs under Node against a minimal DOM stub, driving
 * `engine.update()` directly (never `render()`). This is the end-to-end check
 * that the life model behaves in the actual simulation, not just in isolation:
 * how many worlds wake up, where they get stuck, and how often that varies
 * between universes.
 */

// ── Minimal DOM stub, installed before the engine module is imported ─────────
const noopCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 1200, height: 800 };
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'getImageData') {
      return (_x: number, _y: number, w: number, h: number) =>
        ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    }
    if (prop === 'createImageData') {
      return (w: number, h: number) =>
        ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    }
    if (prop === 'measureText') return () => ({ width: 10 });
    return () => undefined;
  },
  set() { return true; },
});

function makeCanvas(): any {
  return {
    width: 1200, height: 800,
    style: {},
    getContext: () => noopCtx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    toDataURL: () => '',
  };
}

const g = globalThis as any;
g.document = {
  createElement: () => makeCanvas(),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};
g.window = g;
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.addEventListener = () => {};
g.performance = g.performance ?? { now: () => Date.now() };
g.Image = class { set src(_v: string) {} };
g.eternalSpeed = 1;

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');
const { ARCHETYPES } = await import('../src/simulation/LifeSystem');
const { BIO_PHASE_SEQUENCE } = await import('../src/simulation/GameState');

// ── Run ─────────────────────────────────────────────────────────────────────

const TICKS = Number(process.argv[2]) || 400_000;
const RUNS  = Number(process.argv[3]) || 6;

console.log(`\nHeadless engine runs: ${RUNS} universes × ${TICKS.toLocaleString()} ticks\n`);
console.log('  seed          stars  living  microb multic complx primit INTELL  ext  archetypes');

const intelligentCounts: number[] = [];
const livingCounts: number[] = [];

for (let run = 0; run < RUNS; run++) {
  gameState.playerPlanetName = `World${run}`;
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  gameState.playerSpecies = [];
  gameState.codexEntries = [];

  const engine = new BigBangEngine(makeCanvas());
  const stats = { life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 };
  const seed = `sim_${run}`;
  engine.init(stats, seed);

  // Silence the callbacks — we only care about the end state here.
  engine.onCivEvent = () => {};
  engine.onLifeEvent = () => {};

  // Drive update() directly. Each call advances one tick once settled.
  g.eternalSpeed = 60;
  const frames = Math.ceil(TICKS / 1);
  for (let i = 0; i < frames && (engine as any).tick < TICKS; i++) engine.update();

  const stars = (engine as any).stars as any[];
  const alive = stars.filter(s => !s.isDead);
  const living = alive.filter(s => s.hasLife);
  const tally: Record<string, number> = {};
  for (const ph of BIO_PHASE_SEQUENCE) tally[ph] = 0;
  for (const s of living) tally[s.biologyPhase]++;

  const ext = alive.reduce((n, s) => n + (s.extinctions ?? 0), 0);
  const archTally: Record<string, number> = {};
  for (const s of living) {
    const a = s.lifeArchetype ?? 'carbon_water';
    archTally[a] = (archTally[a] ?? 0) + 1;
  }
  const archStr = Object.entries(archTally)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${ARCHETYPES[k as keyof typeof ARCHETYPES].label}×${v}`)
    .join(' ');

  intelligentCounts.push(tally['intelligent']);
  livingCounts.push(living.length);

  const cells = BIO_PHASE_SEQUENCE.map(p => String(tally[p]).padStart(6)).join(' ');
  console.log(
    `  ${seed.padEnd(12)} ${String(alive.length).padStart(5)} ${String(living.length).padStart(7)} ` +
    `${cells} ${String(ext).padStart(4)}  ${archStr}`,
  );
}

const spread = (a: number[]) =>
  `${Math.min(...a)}–${Math.max(...a)} (mean ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)})`;
console.log(`\n  living worlds across universes:      ${spread(livingCounts)}`);
console.log(`  intelligent worlds across universes: ${spread(intelligentCounts)}\n`);
