/**
 * Dev-only: how the star population changes over a long game.
 *
 * Stars are lost to mergers and supernovae. Nothing creates new ones, so the
 * question is whether a long session ends in an almost-empty universe.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/decayCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/decay.mjs && node /tmp/decay.mjs
 */

const noopCtx = new Proxy({}, {
  get(_t, p) {
    if (p === 'canvas') return { width: 1200, height: 800 };
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (p === 'measureText') return () => ({ width: 10 });
    return () => undefined;
  },
  set() { return true; },
});
function mc(): any {
  return {
    width: 1200, height: 800, style: {}, getContext: () => noopCtx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
  };
}
const g = globalThis as any;
g.document = { createElement: () => mc(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
g.window = g; g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {};
g.addEventListener = () => {}; g.eternalSpeed = 60;

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');

console.log('\nStar population over time (entropy varied)\n');
console.log('  entropy   t=0   50k  100k  200k  400k  800k   lost%  civs@800k');

for (const entropy of [4, 11, 18]) {
  gameState.playerPlanetName = 'DecayTest';
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  // Measures the biology ladder: start the home world formed and alive (lab path).
  gameState.skipFormation = true; gameState.destinyOverride = 'ocean';
  gameState.playerSpecies = [];

  const e = new BigBangEngine(mc());
  e.onCivEvent = () => {}; e.onLifeEvent = () => {}; e.onCosmicEvent = () => {};
  e.init({ life: 15, evolution: 13, hostility: 12, entropy, divine: 10 }, `decay_${entropy}`);

  const alive = () => (e as any).stars.filter((s: any) => !s.isDead).length;
  const marks: Record<number, number> = {};
  const initial = alive();
  const checkpoints = [50_000, 100_000, 200_000, 400_000, 800_000];

  for (let i = 0; i < 800_000; i++) {
    e.update();
    const t = (e as any).tick;
    for (const cp of checkpoints) if (marks[cp] === undefined && t >= cp) marks[cp] = alive();
  }

  const stars = (e as any).stars.filter((s: any) => !s.isDead);
  const civs = stars.filter((s: any) => s.hasLife && s.biologyPhase === 'intelligent').length;
  const lost = ((1 - stars.length / initial) * 100).toFixed(0);

  console.log(
    `  ${String(entropy).padStart(7)} ${String(initial).padStart(5)} ` +
    checkpoints.map(c => String(marks[c] ?? alive()).padStart(5)).join(' ') +
    ` ${(lost + '%').padStart(7)} ${String(civs).padStart(10)}`,
  );
}
console.log('');
