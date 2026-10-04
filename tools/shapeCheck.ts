/**
 * Dev-only check on the SHAPE of the settled universe.
 *
 * Stars used to be clamped independently on x and y, so anything that flew far
 * enough was pinned to one of four straight walls and the cosmos spread out into
 * a square. This measures whether the star field is actually a disc.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/shapeCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/shape.mjs && node /tmp/shape.mjs
 *
 * The tell-tale for a square is `corner/edge radius`: for a disc it is ~1.00,
 * for a square inscribed in the same box it approaches sqrt(2) ≈ 1.41.
 */

const noopCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 1200, height: 800 };
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
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
g.eternalSpeed = 60;

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');
const { WORLD_SIZE, UNIVERSE_RADIUS } = await import('../src/constants');

const CX = WORLD_SIZE / 2, CY = WORLD_SIZE / 2;

console.log(`\nUniverse shape check — boundary radius ${UNIVERSE_RADIUS}\n`);
console.log('  entropy  stars  meanR   maxR   %pinned  corner/edge  verdict');

for (const entropy of [1, 5, 10, 15, 20]) {
  gameState.playerPlanetName = 'ShapeTest';
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  // Measures the biology ladder: start the home world formed and alive (lab path).
  gameState.skipFormation = true; gameState.destinyOverride = 'ocean';
  gameState.playerSpecies = [];

  const engine = new BigBangEngine(makeCanvas());
  engine.init({ life: 12, evolution: 12, hostility: 8, entropy, divine: 10 }, `shape_${entropy}`);
  engine.onCivEvent = () => {};
  engine.onLifeEvent = () => {};

  // Run through inflation + gravity until well past settling.
  for (let i = 0; i < 3000; i++) engine.update();

  const stars = (engine as any).stars.filter((s: any) => !s.isDead);
  const radii = stars.map((s: any) => Math.hypot(s.x - CX, s.y - CY));
  const meanR = radii.reduce((a: number, b: number) => a + b, 0) / radii.length;
  const maxR = Math.max(...radii);
  const pinned = radii.filter((r: number) => r > UNIVERSE_RADIUS - 1).length;

  // Compare how far the field reaches toward the box corners (45°, 135°, …)
  // versus toward the box edges (0°, 90°, …). A disc reaches equally far.
  const reach = (centre: number, halfWidth: number) => {
    let best = 0;
    for (const s of stars) {
      let a = Math.atan2(s.y - CY, s.x - CX);
      // fold into the 0–90° octant pattern the box symmetry produces
      let d = Math.abs(((a - centre + Math.PI) % (Math.PI / 2)) - Math.PI / 4 + Math.PI / 4);
      d = Math.min(d, Math.PI / 2 - d);
      if (d < halfWidth) best = Math.max(best, Math.hypot(s.x - CX, s.y - CY));
    }
    return best;
  };
  const edgeReach   = reach(0, 0.25);
  const cornerReach = reach(Math.PI / 4, 0.25);
  const ratio = edgeReach > 0 ? cornerReach / edgeReach : 0;
  const verdict = ratio < 1.12 ? 'disc' : ratio < 1.28 ? 'rounded square' : 'SQUARE';

  console.log(
    `  ${String(entropy).padStart(7)} ${String(stars.length).padStart(6)} ` +
    `${meanR.toFixed(0).padStart(6)} ${maxR.toFixed(0).padStart(6)} ` +
    `${((pinned / stars.length) * 100).toFixed(1).padStart(8)}% ` +
    `${ratio.toFixed(2).padStart(12)}  ${verdict}`,
  );
}
console.log('');

// ── Control: replay the OLD inflation model, to confirm the metric above is
// actually sensitive to the bug it claims to detect. This is a standalone copy
// of the pre-fix maths (fixed outward force + independent x/y clamp), not a
// call into the engine.
{
  console.log('  control — pre-fix model (square clamp, unscaled blast):');
  const { SeedRNG } = await import('../src/utils/SeedRNG');
  for (const entropy of [1, 10, 20]) {
    const rng = new SeedRNG(`old_${entropy}`);
    const stars: Array<{ x: number; y: number; vx: number; vy: number }> = [];
    for (let i = 0; i < 100; i++) {
      const angle = rng.nextFloat(0, Math.PI * 2);
      const outward = rng.nextFloat(14, 36) * (entropy / 10 + 0.5);
      const spin = rng.nextFloat(1, 4);
      stars.push({
        x: CX + rng.nextFloat(-3, 3), y: CY + rng.nextFloat(-3, 3),
        vx: Math.cos(angle) * outward - Math.sin(angle) * spin,
        vy: Math.sin(angle) * outward + Math.cos(angle) * spin,
      });
    }
    for (let t = 0; t < 240; t++) {
      for (const s of stars) {
        s.vx *= 0.97; s.vy *= 0.97;
        s.x += s.vx; s.y += s.vy;
        s.x = Math.max(20, Math.min(WORLD_SIZE - 20, s.x));
        s.y = Math.max(20, Math.min(WORLD_SIZE - 20, s.y));
      }
    }
    const onWall = stars.filter(s =>
      s.x <= 21 || s.x >= WORLD_SIZE - 21 || s.y <= 21 || s.y >= WORLD_SIZE - 21).length;
    const radii = stars.map(s => Math.hypot(s.x - CX, s.y - CY));
    const reachOld = (centre: number) => {
      let best = 0;
      for (const s of stars) {
        const a = Math.atan2(s.y - CY, s.x - CX);
        let d = Math.abs(((a - centre + Math.PI * 3) % (Math.PI / 2)) - Math.PI / 4) ;
        d = Math.PI / 4 - d;
        if (d < 0.25) best = Math.max(best, Math.hypot(s.x - CX, s.y - CY));
      }
      return best;
    };
    const ratio = reachOld(0) > 0 ? reachOld(Math.PI / 4) / reachOld(0) : 0;
    console.log(
      `  ${String(entropy).padStart(7)} ${String(stars.length).padStart(6)} ` +
      `${(radii.reduce((a, b) => a + b, 0) / radii.length).toFixed(0).padStart(6)} ` +
      `${Math.max(...radii).toFixed(0).padStart(6)} ` +
      `${((onWall / stars.length) * 100).toFixed(1).padStart(8)}% ` +
      `${ratio.toFixed(2).padStart(12)}  ${ratio < 1.12 ? 'disc' : ratio < 1.28 ? 'rounded square' : 'SQUARE'}`);
  }
  console.log('');
}
