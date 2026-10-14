/**
 * The Forge (src/simulation/Forge.ts) and its engine hookup.
 *
 *   - every Fate Card is well-formed and has its pixel icon;
 *   - deals are deterministic (same seed + same picks → same world) and never
 *     deal a card past its limit, or a reaction the world has not earned;
 *   - across many random forges: ~10 picks, every destiny reachable, reactions
 *     and "???" cards show up, modifiers stay in range, the reveal is complete;
 *   - the player can steer: chasing water mostly makes ocean worlds, chasing
 *     cold mostly makes ice worlds (aim, but no guarantee);
 *   - Creative decrees hold the world's type through any cards; "let fate
 *     decide" finishes the forge (deterministically) with a random world;
 *   - the engine holds a forged world (no ladder, no stray life) until the
 *     golden spark, which finishes it and wakes life exactly once.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/forgeCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/forge.mjs --log-level=error && node /tmp/forge.mjs
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

const { existsSync } = await import('node:fs');
const F = await import('../src/simulation/Forge');
const { gameState } = await import('../src/simulation/GameState');
const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { SeedRNG } = await import('../src/utils/SeedRNG');

/** true/false when icons can be checked (run from the repo root), else null. */
function icons(name: string): boolean | null {
  return existsSync('public/assets/pixel/divine/cards') ? existsSync(`public/assets/pixel/divine/cards/${name}.png`) : null;
}
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
const STATS = { life: 12, evolution: 11, hostility: 9, entropy: 10, divine: 10 };

// ── 1. The deck ─────────────────────────────────────────────────────────────
{
  const params = new Set<string>(F.FORGE_PARAMS);
  // Icons are checked against the repo's public/ folder (run from the repo root).
  const icons = existsSync('public/assets/pixel/divine/cards');
  const bad = F.FATE_CARDS.filter(c =>
    (!c.unknown && c.value <= 0) || !c.name || !c.text ||
    Object.keys(c.effects).some(k => !params.has(k)) ||
    (icons && !existsSync(`public/assets/pixel/divine/cards/${c.icon}.png`)));
  check(`every Fate Card is well-formed${icons ? ' with an icon' : ' (icons not checked: run from the repo root)'}`, bad.length === 0, bad.map(c => c.id).join(', '));
  check('30+ cards, reactions among them', F.FATE_CARDS.length >= 30 && F.FATE_CARDS.filter(c => c.when).length >= 6, `${F.FATE_CARDS.length} cards`);
  check('ids unique', new Set(F.FATE_CARDS.map(c => c.id)).size === F.FATE_CARDS.length);
}

// ── 2. Determinism and dealing rules ────────────────────────────────────────
function playOut(seed: string, chooser: (s: any) => number, temp = 6000): any {
  const s = F.newForge(seed, STATS, temp, 'Whisperer');
  let guard = 0;
  while (s.phase === 'draft' && guard++ < 60) F.forgeCard(s, chooser(s));
  return s;
}
{
  const a = playOut('det_seed', s => s.round % s.hand.length);
  const b = playOut('det_seed', s => s.round % s.hand.length);
  check('same seed + same picks → same world', JSON.stringify(a.played) === JSON.stringify(b.played) && JSON.stringify(a.outcome) === JSON.stringify(b.outcome));
  const c = playOut('other_seed', s => s.round % s.hand.length);
  check('a different seed deals differently', JSON.stringify(a.played) !== JSON.stringify(c.played));
}

// ── 3. Many random forges ──────────────────────────────────────────────────
{
  const destinies: Record<string, number> = {};
  let picks = 0, minP = 99, maxP = 0, withReaction = 0, withUnknown = 0, dupHands = 0, overMax = 0, unearned = 0, badMods = 0, badReveal = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const rng = new SeedRNG(`rand_${i}`);
    const s = F.newForge(`seed_${i}`, { life: rng.nextInt(1, 20), evolution: rng.nextInt(1, 20), hostility: rng.nextInt(1, 20), entropy: rng.nextInt(1, 20), divine: 10 }, rng.nextFloat(3000, 30000), 'W');
    let sawReaction = false, sawUnknown = false;
    while (s.phase === 'draft') {
      const ids = s.hand.map((c: any) => c.id);
      if (ids.filter((id: string) => id !== 'unknown').length !== new Set(ids.filter((id: string) => id !== 'unknown')).size) dupHands++;
      for (const c of s.hand) {
        const def = F.FATE_BY_ID[c.id];
        if (def.when) { sawReaction = true; if (!def.when(s.dna)) unearned++; }
        if (def.unknown) sawUnknown = true;
        if (s.played.filter((p: any) => p.id === c.id).length >= def.max) overMax++;
      }
      F.forgeCard(s, rng.nextInt(0, s.hand.length - 1));
    }
    const o = s.outcome!;
    destinies[o.destiny] = (destinies[o.destiny] ?? 0) + 1;
    picks += s.round; minP = Math.min(minP, s.round); maxP = Math.max(maxP, s.round);
    if (sawReaction) withReaction++;
    if (sawUnknown) withUnknown++;
    const m = o.mods;
    if (!(m.tempo >= 0.7 && m.tempo <= 1.7 && m.catastrophe >= 0.3 && m.catastrophe <= 2 && m.assist >= -0.15 && m.assist <= 0.35)) badMods++;
    if (o.traits.length !== 7 || o.traits.some(([k, v]: [string, string]) => !k || !v)) badReveal++;
  }
  const avg = picks / N;
  check('about ten picks per forge', avg >= 8 && avg <= 12.5 && minP >= 5 && maxP <= 18, `avg ${avg.toFixed(1)}, ${minP}–${maxP}`);
  check('every destiny reachable', ['ocean', 'rocky', 'ice', 'desert'].every(d => (destinies[d] ?? 0) >= N * 0.04), JSON.stringify(destinies));
  check('reactions are offered in many forges', withReaction >= N * 0.3, `${withReaction}/${N}`);
  check('"???" cards turn up sometimes', withUnknown >= N * 0.15 && withUnknown <= N * 0.9, `${withUnknown}/${N}`);
  check('no duplicate cards in a hand', dupHands === 0, `${dupHands}`);
  check('no card dealt past its limit', overMax === 0, `${overMax}`);
  check('no reaction dealt unearned', unearned === 0, `${unearned}`);
  check('modifiers stay in range', badMods === 0, `${badMods}`);
  check('the reveal names every trait', badReveal === 0, `${badReveal}`);
}

// ── 4. Steering ────────────────────────────────────────────────────────────
function steer(param: string, dir = 1): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < 150; i++) {
    const s = playOut(`steer_${param}_${i}`, st => {
      let best = 0, bestV = -Infinity;
      st.hand.forEach((c: any, k: number) => { const v = (F.FATE_BY_ID[c.id].effects as any)[param] ?? 0; if (v * dir > bestV) { bestV = v * dir; best = k; } });
      return best;
    });
    out[s.outcome.destiny] = (out[s.outcome.destiny] ?? 0) + 1;
  }
  return out;
}
{
  const water = steer('water'), cold = steer('cold');
  check('chasing water mostly makes ocean worlds', (water['ocean'] ?? 0) >= 150 * 0.6, JSON.stringify(water));
  check('chasing cold mostly makes ice worlds', (cold['ice'] ?? 0) >= 150 * 0.6, JSON.stringify(cold));
  check('…but neither is guaranteed', (water['ocean'] ?? 0) < 150 || (cold['ice'] ?? 0) < 150);
}

// ── 4b. Creative decrees and "Let fate decide" ─────────────────────────────
{
  // A decree is the world's type whatever the cards do, and the surface DNA agrees.
  const agrees: Record<string, (p: any) => boolean> = {
    ocean: p => p.oceans === 'ocean_world',
    ice: p => p.climate === 'frozen',
    desert: p => p.climate === 'desert' && p.oceans === 'barren',
    rocky: p => p.oceans === 'mixed',
  };
  const bad: string[] = [];
  for (const d of F.DECREES) {
    if (icons(d.icon) === false) bad.push(`${d.destiny}: no icon ${d.icon}`);
    for (let i = 0; i < 120; i++) {
      const rng = new SeedRNG(`decree_${d.destiny}_${i}`);
      const s = F.newForge(`decree_${d.destiny}_${i}`, { life: rng.nextInt(1, 20), evolution: rng.nextInt(1, 20), hostility: rng.nextInt(1, 20), entropy: rng.nextInt(1, 20), divine: 10 }, rng.nextFloat(3000, 30000), 'W');
      // Decreed at a random point of the draft, then cards chosen at random or by chasing a force against it.
      const at = rng.nextInt(0, 4);
      const chase = F.FORGE_PARAMS[rng.nextInt(0, F.FORGE_PARAMS.length - 1)];
      while (s.phase === 'draft') {
        if (s.round === at && !s.decree) F.decreeWorld(s, d.destiny);
        if (s.decree && F.destinyOf(s.dna) !== d.destiny) { bad.push(`${d.destiny} #${i}: forces drifted to ${F.destinyOf(s.dna)} mid-draft`); break; }
        let k = rng.nextInt(0, s.hand.length - 1);
        if (i % 2) s.hand.forEach((c: any, j: number) => { if (((F.FATE_BY_ID[c.id].effects as any)[chase] ?? 0) > ((F.FATE_BY_ID[s.hand[k].id].effects as any)[chase] ?? 0)) k = j; });
        F.forgeCard(s, k);
      }
      if (s.decree === d.destiny && (s.outcome.destiny !== d.destiny || !agrees[d.destiny](s.outcome.planetDNA))) {
        bad.push(`${d.destiny} #${i}: became ${s.outcome.destiny} ${JSON.stringify(s.outcome.planetDNA)}`);
      }
    }
  }
  check('a Creative decree holds the world\'s type, and its surface agrees', bad.length === 0, bad.slice(0, 3).join('; '));

  // Lifting a decree hands the type back to the forces; decrees only while drafting.
  const s = F.newForge('decree_lift', STATS, 6000, 'W');
  F.decreeWorld(s, 'desert');
  F.decreeWorld(s, null);
  check('a lifted decree gives the type back to the forces', !s.decree && F.forgeDestiny(s) === F.destinyOf(s.dna));
  const done = playOut('decree_done', st => 0);
  check('no decree once the draft is over', !F.decreeWorld(done, 'ice') && done.outcome.destiny === F.forgeDestiny(done));

  // "Let fate decide": straight to the reveal, deterministic, random worlds across seeds.
  const fates: Record<string, number> = {};
  let unfinished = 0, same = true;
  for (let i = 0; i < 200; i++) {
    const a = F.newForge(`fate_${i}`, STATS, 3000 + i * 130, 'W');
    if (i % 3) F.forgeCard(a, 0);                       // sometimes after a pick of one's own
    const b = JSON.parse(JSON.stringify(a));
    F.letFateDecide(a); F.letFateDecide(b);
    if (a.phase !== 'reveal' || !a.outcome) unfinished++;
    else fates[a.outcome.destiny] = (fates[a.outcome.destiny] ?? 0) + 1;
    if (JSON.stringify(a.outcome) !== JSON.stringify(b.outcome)) same = false;
  }
  check('"let fate decide" always ends the forge at the reveal', unfinished === 0, `${unfinished}`);
  check('"let fate decide" is deterministic (a reload decides the same)', same);
  check('"let fate decide" gives every type of world', ['ocean', 'rocky', 'ice', 'desert'].every(d => (fates[d] ?? 0) >= 4), JSON.stringify(fates));
  const ice = F.newForge('fate_decreed', STATS, 6000, 'W');
  F.decreeWorld(ice, 'ice');
  F.letFateDecide(ice);
  check('"let fate decide" keeps a Creative decree', ice.outcome?.destiny === 'ice');
}

// ── 5. Engine: held until the spark ────────────────────────────────────────
{
  const makeCanvasAny = makeCanvas as any;
  const e: any = new BigBangEngine(makeCanvasAny());
  e.init(STATS, 'forge_engine_check');
  while (e.phase !== 'settled') e.update();
  let completes = 0, lifeEvents = 0, arrivals = 0;
  e.onPlanetFormationComplete = () => completes++;
  e.onPlayerLifeEmerged = () => lifeEvents++;
  e.onFormationLifeArrived = () => arrivals++;
  const ps = e.beginForge();
  check('the home world starts forging', !!ps && ps.formationHeld === true && e.isHomeForming());
  const stage0 = ps.formationStage, prog0 = ps.formationProgress;
  gameState.forge = F.newForge('forge_engine_check', STATS, ps.temperature, 'W');
  for (let i = 0; i < 30000; i++) e.update();
  check('while held: no timed ladder', ps.formationStage === stage0 && ps.formationProgress === prog0, `${stage0}→${ps.formationStage}`);
  check('while held: no stray life', !ps.hasLife && arrivals === 0 && lifeEvents === 0);
  e.shapeForgedWorld('ocean', 'atmosphere', { climate: 'temperate', oceans: 'ocean_world', chaos: 'serene' });
  const home = e.homeWorld(ps);
  check('the forge shapes the world', ps.formationDestiny === 'ocean' && ps.formationStage === 'atmosphere' && home.dna.oceans === 'ocean_world');
  e.shapeForgedWorld('ice', 'ice_age', { climate: 'frozen', oceans: 'mixed', chaos: 'turbulent' });
  e.sparkForgedLife(1.7);
  check('the spark finishes the world', !ps.formationHeld && ps.formationStage === null && !e.isHomeForming() && e.homeWorld(ps).type === 'ice');
  check('the spark wakes life exactly once', ps.hasLife && completes === 1 && lifeEvents === 1 && ps.bioTempo === 1.7, `complete=${completes} life=${lifeEvents}`);
  e.sparkForgedLife(1.0);
  check('a second spark does nothing', completes === 1 && lifeEvents === 1);
  gameState.forge = null;
  gameState.forgeMods = null;
}

console.log(failures ? `\n${failures} FAILED` : '\nall forge checks passed');
process.exit(failures ? 1 : 0);
