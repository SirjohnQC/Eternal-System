/**
 * Dev-only headless check of the signature-species evolution system
 * (docs/superpowers/specs/2026-10-04-signature-species-evolution-design.md)
 * on the real BigBangEngine.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/evolutionLabCheck.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/evo.mjs" --log-level=error && node "$TEMP/evo.mjs"
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
const M = await import('../src/simulation/Mutations');

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${name.padEnd(62)} ${detail}`);
};

gameState.playerPlanetName = 'Lab';
gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' } as any;
gameState.skipFormation = true; gameState.destinyOverride = 'ocean';
gameState.dnaPoints = 0;
const engine: any = new BigBangEngine(makeCanvas());
engine.init({ life: 14, evolution: 12, hostility: 9, entropy: 10, divine: 12 }, 'evo_lab_1');
engine.onCivEvent = () => {}; engine.onLifeEvent = () => {};
const awards: string[] = [];
engine.onDNAAward = (n: number, why: string) => awards.push(`+${n} ${why}`);
let drift = 0; engine.onSignatureDrift = () => drift++;
let gifts = 0; engine.onSpontaneousMutation = () => gifts++;
g.eternalSpeed = 60;
const run = (ticks: number) => { const end = engine.tick + ticks; while (engine.tick < end) engine.update(); };

console.log('\n  SIGNATURE SPECIES EVOLUTION\n');
run(800);
const sig = () => engine.signatureSpecies();
check('a signature species exists once life appears', !!sig(), sig()?.name ?? 'none');
check('first life grants DNA for a first choice', awards.some(a => a.includes('Life has taken hold')) && gameState.dnaPoints >= 6,
  `${gameState.dnaPoints} DNA`);
check('Form I is recorded', gameState.speciesForms.length === 1 && gameState.speciesForms[0].form === 1, '');
check('the universe offers every core card and some optional ones',
  M.MUTATIONS.filter(m => m.core).every(m => gameState.offeredMutations.includes(m.id))
  && gameState.offeredMutations.length < M.MUTATIONS.length,
  `${gameState.offeredMutations.length}/${M.MUTATIONS.length}`);

const ps = engine.getPlayerStar();
const ctx = () => ({ genome: sig(), phase: ps.biologyPhase, owned: gameState.mutationsOwned,
  queued: gameState.mutationQueue, offered: gameState.offeredMutations, points: gameState.dnaPoints });
const avail = M.cardStates(ctx()).filter(c => c.status === 'available');
check('microbial cards are available', avail.length >= 3, avail.map(c => c.def.id).join(','));

// Buy two cards (what the UI does), check the preview, evolve.
const buy = (id: string) => { const d = M.MUTATION_BY_ID[id]; gameState.dnaPoints -= d.cost; gameState.mutationQueue.push(id); };
gameState.dnaPoints += 20;
const pickA = avail.find(c => c.def.id === 'flagellum') ?? avail[0];
buy(pickA.def.id);
const pickB = M.cardStates(ctx()).find(c => c.status === 'available' && c.def.group === 'energy')!;
buy(pickB.def.id);
const before = M.cloneGenome(sig());
const preview = M.previewGenome(sig(), gameState.mutationQueue);
const visible = (x: any) => [x.dna.locomotion, x.dna.metabolism, x.dna.diet, x.dna.environment,
  x.physicalTraits.size, x.physicalTraits.bodyStructure, x.physicalTraits.sensorySystem, x.physicalTraits.mobilityType].join('|');
check('queued cards change the preview creature (sprite channels)', visible(preview) !== visible(before) || pickA.def.id === 'flagellum',
  `${visible(before)} -> ${visible(preview)}`);
check('a fork closes its siblings once one is queued',
  M.cardStates(ctx()).filter(c => c.def.group === pickB.def.group && c.def.id !== pickB.def.id).every(c => c.status === 'locked'), '');
check('queue of two is ready to evolve', M.queueReady(gameState.mutationQueue), gameState.mutationQueue.join(','));
const r = engine.evolveSignature();
check('evolving applies the queue and records Form II',
  !!r && r.form === 2 && gameState.mutationQueue.length === 0 && gameState.mutationsOwned.length === 2
  && visible(sig()) === visible(preview), r ? `${r.before.name} -> ${r.after.name}; ${r.diff.join('; ')}` : 'null');
check('the evolution reveal lists what changed', !!r && r.diff.length > 0, `${r?.diff.length} rows`);

// Drift never undoes an owned card's locked traits; signature survives.
const locked = M.lockedTraits(gameState.mutationsOwned);
const snap = (x: any) => [...locked].map(t => t === 'size' ? x.physicalTraits.size : x.dna[t]).join('|');
const lockedBefore = snap(sig());
const id0 = sig().id;
run(80_000);
check('drift never moves a locked trait', !!sig() && snap(sig()) === lockedBefore, `${[...locked].join(',')}: ${lockedBefore} / ${sig() ? snap(sig()) : '—'}`);
check('the signature species is still the same lineage, alive', sig()?.id === id0, '');
check('DNA arrives from named events', awards.length >= 5, `${awards.length} awards, e.g. ${[...new Set(awards.map(a => a.replace(/^\+\d+ /, '')))].slice(0, 4).join(' | ')}`);
console.log(`    drift events on signature: ${drift}, spontaneous cards: ${gifts}, phase ${ps.biologyPhase}, DNA ${gameState.dnaPoints}`);
check('unlocked traits still drift (surprises happen)', drift > 0, `${drift}`);

console.log(failed ? `\n  ${failed} check(s) FAILED\n` : '\n  all evolution checks passed\n');
if (failed) process.exitCode = 1;
