/**
 * Dev-only measurement of how the PLAYER's world climbs the biology ladder.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/phaseProgressCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TMP/phasecheck.mjs && node $TMP/phasecheck.mjs
 *
 * BUG under investigation: "primary species is stuck on primitive no matter how
 * many DNA points we give."
 *
 * Three arms, so the measure has a control that proves it can detect a
 * difference at all:
 *   A  control      — no DNA spent, no nudges
 *   B  max DNA      — 100 points into every branch (far past what the game grants)
 *   C  nudge spam   — nudgePlayerEvolution() every 500 ticks
 *
 * If B looks like A, DNA points do not move the player's biology phase, which is
 * exactly what the bug report claims.
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
const { gameState, runtimeState, BIO_PHASE_SEQUENCE } = await import('../src/simulation/GameState');

type Arm = 'control' | 'realDNA' | 'maxDNA' | 'nudge';

const TICKS = Number(process.argv[2]) || 600_000;
const RUNS  = Number(process.argv[3]) || 8;

interface RunResult {
  reached:   string;          // furthest phase reached
  entered:   Record<string, number>;   // tick each phase was first entered
  stallsAt:  Record<string, number>;   // stall count observed when leaving / at end
  endStalls: number;
}

function runOnce(arm: Arm, seed: string): RunResult {
  gameState.playerPlanetName = 'Testworld';
  gameState.playerPlanetDNA  = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  // Measures the biology ladder: start the home world formed and alive (lab path).
  gameState.skipFormation = true; gameState.destinyOverride = 'ocean';
  gameState.playerSpecies    = [];
  gameState.codexEntries     = [];
  gameState.playerDNA        = {};
  gameState.dnaPoints        = 0;

  const engine = new BigBangEngine(makeCanvas());
  const stats = { life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 };
  engine.init(stats, seed);
  engine.onCivEvent = () => {};
  engine.onLifeEvent = () => {};
  (engine as any).onPlayerLifeEmerged = () => {};

  if (arm === 'maxDNA') {
    // Far more than the game will ever grant: every branch maxed.
    for (const d of runtimeState.branchDefs) gameState.playerDNA[d.id] = 100;
  }
  if (arm === 'realDNA') {
    // The best a player can actually do by the time they sit at 'primitive',
    // under the M22c economy: about 31 points in one branch (measured, see
    // `tools/dnaEconomyCheck.ts`), poured into the branch with the strongest
    // bioResilience weight.
    const defs = runtimeState.branchDefs;
    let best = defs[0], bestW = -1;
    for (const d of defs) {
      const w = d.effects.bioResilience ?? 0;
      if (w > bestW) { bestW = w; best = d; }
    }
    gameState.playerDNA[best.id] = 31;
  }

  const entered: Record<string, number> = {};
  const stallsAt: Record<string, number> = {};
  g.eternalSpeed = 60;

  let last = '';
  for (let i = 0; i < TICKS; i++) {
    engine.update();
    const ps = (engine as any).stars.find((s: any) => s.isPlayerStar);
    if (!ps) continue;
    const ph = ps.biologyPhase;
    if (ph !== last) {
      if (last) stallsAt[last] = Math.max(stallsAt[last] ?? 0, 0);
      entered[ph] = entered[ph] ?? (engine as any).tick;
      last = ph;
    }
    stallsAt[ph] = Math.max(stallsAt[ph] ?? 0, ps.bioStalls ?? 0);
    if (arm === 'nudge' && i % 500 === 0) engine.nudgePlayerEvolution();
    if (ph === 'intelligent') break;
  }

  const ps = (engine as any).stars.find((s: any) => s.isPlayerStar);
  return {
    reached:   ps?.biologyPhase ?? 'dead',
    entered,
    stallsAt,
    endStalls: ps?.bioStalls ?? 0,
  };
}

console.log(`\nPlayer biology-phase progression: ${RUNS} seeds × up to ${TICKS.toLocaleString()} ticks\n`);

for (const arm of ['control', 'realDNA', 'maxDNA', 'nudge'] as Arm[]) {
  console.log(`── arm: ${arm} ──`);
  console.log('  seed        reached        ' +
    BIO_PHASE_SEQUENCE.map(p => p.slice(0, 6).padStart(8)).join('') + '   endStalls');
  const reachedTally: Record<string, number> = {};
  for (let r = 0; r < RUNS; r++) {
    const seed = `phase_${r}`;
    const res = runOnce(arm, seed);
    reachedTally[res.reached] = (reachedTally[res.reached] ?? 0) + 1;
    const cells = BIO_PHASE_SEQUENCE
      .map(p => (res.entered[p] === undefined ? '—' : String(res.entered[p])).padStart(8))
      .join('');
    console.log(`  ${seed.padEnd(11)} ${res.reached.padEnd(14)}${cells}   ${res.endStalls}`);
  }
  const summary = Object.entries(reachedTally)
    .sort((a, b) => BIO_PHASE_SEQUENCE.indexOf(a[0] as any) - BIO_PHASE_SEQUENCE.indexOf(b[0] as any))
    .map(([k, v]) => `${k}×${v}`).join('  ');
  console.log(`  → ${summary}\n`);
}
