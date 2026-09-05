/** Dev-only: trace exactly why the player's world sits in one biology phase. */
const noopCtx = new Proxy({}, { get(_t, p) {
  if (p === 'canvas') return { width: 1200, height: 800 };
  if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
  if (p === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w*h*4), width: w, height: h });
  if (p === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w*h*4), width: w, height: h });
  if (p === 'measureText') return () => ({ width: 10 });
  return () => undefined;
}, set() { return true; } });
function makeCanvas(): any { return { width: 1200, height: 800, style: {}, getContext: () => noopCtx,
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }), toDataURL: () => '' }; }
const g = globalThis as any;
g.document = { createElement: () => makeCanvas(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
g.window = g; g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {};
g.addEventListener = () => {}; g.performance = g.performance ?? { now: () => Date.now() };
g.Image = class { set src(_v: string) {} }; g.eternalSpeed = 1;

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');
const { BIO_PHASE_TICKS } = await import('../src/constants');
const { STALL_TIME_PENALTY, filterChance } = await import('../src/simulation/LifeSystem');

const SEED   = process.argv[2] || 'phase_4';
const TICKS  = Number(process.argv[3]) || 400_000;
const NUDGE  = process.argv[4] === 'nudge';

gameState.playerPlanetName = 'Testworld';
gameState.playerPlanetDNA  = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
gameState.playerSpecies = []; gameState.codexEntries = []; gameState.playerDNA = {}; gameState.dnaPoints = 0;

const engine = new BigBangEngine(makeCanvas());
engine.init({ life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 }, SEED);
engine.onCivEvent = () => {};
engine.onLifeEvent = (msg: string) => console.log(`  [t=${(engine as any).tick}] LIFE: ${msg}`);
(engine as any).onPlayerLifeEmerged = () => {};

g.eternalSpeed = 60;
let lastPhase = '', lastStalls = -1;
for (let i = 0; i < TICKS; i++) {
  engine.update();
  const ps = (engine as any).stars.find((s: any) => s.isPlayerStar);
  if (!ps) continue;
  if (NUDGE && i % 500 === 0) engine.nudgePlayerEvolution();
  if (ps.biologyPhase !== lastPhase || (ps.bioStalls ?? 0) !== lastStalls) {
    lastPhase = ps.biologyPhase; lastStalls = ps.bioStalls ?? 0;
    const evoMod = (21 - 12) / 10;
    const tempo = ps.bioTempo ?? 1;
    const rate = (BIO_PHASE_TICKS as any)[ps.biologyPhase] * evoMod * 1.0 * 1.0
               / Math.max(0.15, tempo) * (1 + lastStalls * STALL_TIME_PENALTY);
    const p = filterChance({ phase: ps.biologyPhase, habitability: (engine as any).habitabilityOf(ps),
      archetype: (engine as any).archetypeOf(ps), stalls: lastStalls,
      assistance: (engine as any).bioAssistance });
    console.log(`  t=${String((engine as any).tick).padStart(7)}  phase=${ps.biologyPhase.padEnd(14)}` +
      `stalls=${lastStalls}  tempo=${tempo.toFixed(2)}  ticksToNextRoll=${Math.round(rate).toLocaleString().padStart(10)}` +
      `  P(fail)=${(p * 100).toFixed(1)}%  assist=${((engine as any).bioAssistance).toFixed(2)}`);
  }
  if (ps.biologyPhase === 'intelligent') break;
}
const ps = (engine as any).stars.find((s: any) => s.isPlayerStar);
console.log(`\n  END: phase=${ps?.biologyPhase} progress=${Math.round(ps?.bioPhaseProgress)} stalls=${ps?.bioStalls}`);
