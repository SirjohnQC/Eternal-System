/**
 * Checks the tech cards (src/simulation/TechCards.ts; BigBangEngine.playTechCard;
 * docs/plans/2026-10-14-tech-cards.md) in the real engine, headless.
 *
 *   npx esbuild tools/techCardsCheck.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/tech.mjs --log-level=error && node /tmp/tech.mjs
 *
 * 1. The TP economy: a technology pays once (reloads and setbacks included); an
 *    age pays once.
 * 2. Every card in a world leapt to the Post-Biological age: it unlocks from what
 *    the nations know; playing it spends its price; its omens fall on the
 *    nations it names and nowhere else, with its price laid too, each linked
 *    to the act in the Chronicle; its special act happens; the next play costs
 *    more (wear).
 * 3. Consequences against an untouched twin: a played card changes the world.
 */
import { makeCanvas } from './lib/headlessDom';
const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState, runtimeState } = await import('../src/simulation/GameState');
const { TECH_CARDS, TECH_CARD_BY_ID } = await import('../src/simulation/TechCards');

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failed++;
};

function reset(): void {
  gameState.playerPlanetName = 'Techworld';
  gameState.playerPlanetDNA = { climate: 'temperate', oceans: 'mixed', chaos: 'turbulent' };
  gameState.playerSpecies = [];
  gameState.civilizations = {};
  gameState.leaders = [];
  gameState.factionFlags = {};
  gameState.techPoints = 0;
  gameState.divinePoints = 100;
  gameState.techWear = {};
  gameState.techRewarded = [];
  gameState.tpEraHigh = 0;
  gameState.techCardsKnown = [];
  gameState.techEffects = {};
  gameState.homeMoved = null;
  gameState.skipFormation = true;
  runtimeState.playerPlanetGrid = null;
  runtimeState.playerNations = null;
}

const STATS = { life: 15, evolution: 13, hostility: 12, entropy: 11, divine: 10 };

/** A world whose people reached `era` through the normal (leapt) path. */
function world(seed: string, era: number): any {
  reset();
  const e = new BigBangEngine(makeCanvas()) as any;
  e.init(STATS, seed);
  for (let i = 0; i < 3_000; i++) e.update();
  e.leapToEra(era);
  return e;
}

// ── 1. TP economy ────────────────────────────────────────────────────────────
console.log('\n═══ 1. TP economy ═══');
{
  const e = world('tech_tp', 1);
  const ns = runtimeState.playerNations!;
  const known = new Set(ns.nations.flatMap((n: any) => n.techs));
  const ps = e.getPlayerStar();
  check('every technology the nations know paid once', (gameState.techRewarded ?? []).length === known.size,
    `${(gameState.techRewarded ?? []).length} paid, ${known.size} known`);
  check('each age reached paid its TP', gameState.tpEraHigh === ps.civLevel, `high ${gameState.tpEraHigh}, era ${ps.civLevel}`);
  const tp = gameState.techPoints;
  check('TP = 1 per technology + 3 per age', tp === known.size + 3 * ps.civLevel, `${tp} vs ${known.size} + 3×${ps.civLevel}`);
  // The same technology again (a reload, a setback relearned): no new TP.
  e.rewardDiscovery([...known][0]);
  check('a technology learned again pays nothing', gameState.techPoints === tp);
  // An age lost and regained pays once.
  e.shiftEra(ps, ps.civLevel - 1, 'test');
  const before = gameState.techPoints;
  e.leapToEra(ps.civLevel + 1);
  const paidAges = gameState.techPoints - before - ((gameState.techRewarded ?? []).length - known.size);
  check('an age lost and regained pays no age TP', paidAges === 0, `${paidAges} age TP`);
}

// ── 2. Every card ────────────────────────────────────────────────────────────
console.log('\n═══ 2. Every card in a Post-Biological world ═══');
{
  const e = world('tech_all', 8);
  const ns = runtimeState.playerNations!;
  const ps = e.getPlayerStar();
  // Things some cards act on: a colony of ours, a known people, a lifeless world in reach.
  e.exploredAreas.push({ x: ps.x, y: ps.y, r: 1e6 });
  const views = e.techCardViews();
  const unlocked = views.filter((v: any) => v.unlocked).length;
  check('cards unlock from what the nations know', unlocked >= 25, `${unlocked}/${TECH_CARDS.length} unlocked`);
  check('a card whose technology no nation knows stays sealed', (() => {
    const r = new BigBangEngine(makeCanvas()) as any;
    reset(); r.init(STATS, 'tech_sealed'); for (let i = 0; i < 3_000; i++) r.update(); r.leapToEra(1);
    const v = r.techCardViews().find((x: any) => x.card.id === 'seedships');
    // Re-enter the main world's state.
    return !!v && !v.unlocked;
  })());
  // The sealed check reset gameState and nations: rebuild the main world.
  const w = world('tech_all', 8);
  const wps = w.getPlayerStar();
  w.exploredAreas.push({ x: wps.x, y: wps.y, r: 1e6 });
  const wns = runtimeState.playerNations!;

  for (const card of TECH_CARDS) {
    if (card.special === 'new_world') continue;            // its own scenarios (invariantCheck)
    gameState.techPoints = 200;
    const v = w.techCardViews().find((x: any) => x.card.id === card.id);
    if (!v.unlocked) { check(`${card.name}: unlocked`, false, 'sealed in a Post-Biological world'); continue; }
    if (v.block) { console.log(`  skip  ${card.name.padEnd(64)} ${v.block}`); continue; }
    const targets = v.acts as string[];
    const others = wns.nations.filter((n: any) => !n.fallen && !targets.includes(n.name));
    const ineq = new Map(wns.nations.map((n: any) => [n.id, n.state.inequality]));
    const snap = {
      tp: gameState.techPoints, explored: w.exploredAreas.length, arks: w.fleets.filter((f: any) => f.ark).length,
      techs: wns.nations.map((n: any) => n.techs.length).reduce((a: number, b: number) => a + b, 0),
      species: JSON.stringify(gameState.playerSpecies.map((s: any) => s.dna)),
      life: w.stars.filter((s: any) => s.hasLife).length,
      attitudes: Object.values(w.interstellar.polities).map((p: any) => p.attitude[wps.id] ?? 0).reduce((a: number, b: number) => a + b, 0),
    };
    const choice = card.special === 'terraform' ? w.getTerraformInfo()?.options[0]?.targetType : undefined;
    const line = w.playTechCard(card.id, choice);
    if (!line) { check(`${card.name}: plays`, false, 'refused although listed playable'); continue; }
    const problems: string[] = [];
    if (gameState.techPoints !== snap.tp - v.price) problems.push(`TP ${snap.tp} → ${gameState.techPoints}, price ${v.price}`);
    const title = card.name.charAt(0) + card.name.slice(1).toLowerCase();
    for (const n of wns.nations.filter((x: any) => targets.includes(x.name))) {
      for (const o of card.omens ?? []) if (!n.omens.some((m: any) => m.card === title && m.op === o.op && m.primary && m.cause)) problems.push(`${n.name} lacks ${o.op}`);
      for (const p of card.price ?? []) if (!n.omens.some((m: any) => m.card === title && m.op === p.op && !m.primary)) problems.push(`${n.name} lacks price ${p.op}`);
      if (card.inequality && !(n.state.inequality < (ineq.get(n.id) as number) || n.state.inequality === 0)) problems.push(`${n.name} inequality did not fall`);
    }
    if (card.who === 'knowers') for (const n of others) if (n.omens.some((m: any) => m.card === title && m.primary)) problems.push(`${n.name} got it without the knowledge`);
    if (!wns.chronicle.some((h: any) => h.what.includes(`on ${title}`))) problems.push('no Chronicle entry for the act');
    switch (card.special) {
      case 'defence': {
        if (!((gameState.techEffects?.defenceUntil ?? 0) > w.tick)) { problems.push('no defence window'); break; }
        const home = w.homeWorld(wps), bio = home.biosphere;
        w.applyCosmicStrike({ id: -1, type: 'asteroid_impact', targetStarId: wps.id, scheduledTick: w.tick, resolved: false }, wps);
        if (home.biosphere !== bio) problems.push('an asteroid struck through the defence');
        break;
      }
      case 'eyes': if (w.exploredAreas.length <= snap.explored) problems.push('nothing charted'); break;
      case 'kinship': if (!((gameState.techEffects?.kinshipUntil ?? 0) > w.tick)) problems.push('no kinship window'); break;
      case 'founding_fleet': if (w.fleets.filter((f: any) => f.ark).length <= snap.arks) problems.push('no ark left'); break;
      case 'ambassadors': {
        const now = Object.values(w.interstellar.polities).map((p: any) => p.attitude[wps.id] ?? 0).reduce((a: number, b: number) => a + b, 0);
        if (!(now > snap.attitudes)) problems.push('no people warmed to yours');
        break;
      }
      case 'espionage': if (wns.nations.map((n: any) => n.techs.length).reduce((a: number, b: number) => a + b, 0) <= snap.techs) problems.push('nothing stolen'); break;
      case 'terraform': if (!wps.terraformStage) problems.push('no terraforming began'); break;
      case 'seedships': if (w.stars.filter((s: any) => s.hasLife).length <= snap.life) problems.push('no life seeded'); break;
      case 'eureka': if (!wns.nations.filter((n: any) => targets.includes(n.name)).some((n: any) => n.research && n.research.progress >= 1)) problems.push('no study finished'); break;
    }
    const again = w.techCardViews().find((x: any) => x.card.id === card.id).price;
    if (!(again > v.price)) problems.push(`wear: price ${v.price} → ${again}`);
    check(`${card.name}`, !problems.length, problems.length ? problems.join('; ') : `${v.price} TP · ${line.slice(card.name.length + 1, card.name.length + 70).trim()}`);
  }
  for (let i = 0; i < 2_000; i++) w.update();
  check('the world runs on after every card was played', !!w.getPlayerStar() && wns.nations.some((n: any) => !n.fallen));
}

// ── 2b. The cards that need someone to act on ────────────────────────────────
console.log('\n═══ 2b. Colonies, other peoples, a world to remake (Interstellar) ═══');
{
  const C = await import('../src/simulation/Colonies');
  const { TECHS } = await import('../src/simulation/Technology');
  /** A world at `era` with a colony of ours, a people further ahead at another star, and a rocky home. */
  const scene = (era: number) => {
    const w = world(`tech_others_${era}`, era);
    const ps = w.getPlayerStar();
    const ns = runtimeState.playerNations!;
    w.exploredAreas.push({ x: ps.x, y: ps.y, r: 1e6 });
    const site = w.stars.find((s: any) => !s.isDead && !s.isPlayerStar && s.planets.some((p: any) => p.type !== 'gas'));
    C.foundColony(w.colonies, { starId: site.id, planetIndex: site.planets.findIndex((p: any) => p.type !== 'gas'), name: 'Test colony', x: site.x, y: site.y, suitability: 0.6 },
      { starId: ps.id, isPlayer: true, lineage: null, tier: 3 }, w.tick);
    const other = w.stars.find((s: any) => !s.isDead && !s.isPlayerStar && s.id !== site.id && s.planets.length);
    Object.assign(other, { hasLife: true, biologyPhase: 'intelligent', civLevel: 8 });
    w.ensureCivilization(other);
    w.stepPolities();
    const pol = w.interstellar.polities[other.id];
    if (pol) { pol.techs = TECHS.map((t: any) => t.id); pol.era = 8; }
    w.homeWorld(ps).type = 'rocky';
    return { w, ps, ns, pol };
  };
  let { w, ps, ns, pol } = scene(8);
  check('a neighbouring people exists for the test', !!pol);
  const play = (id: string, choice?: string): { v: any; line: string | null; why: string } => {
    gameState.techPoints = 200;
    const v = w.techCardViews().find((x: any) => x.card.id === id);
    if (!v.unlocked) return { v, line: null as string | null, why: 'sealed' };
    if (v.block) return { v, line: null as string | null, why: v.block };
    const line = w.playTechCard(id, choice) as string | null;
    return { v, line, why: line ? '' : 'refused' };
  };
  {
    const r = play('kinship');
    const c = w.colonies.colonies.find((x: any) => x.name === 'Test colony');
    check('KINSHIP NETWORK: colonies held closer to home', !!r.line && w.kinship(c, 0.2) > 0.2, r.why || `contact 0.20 → ${w.kinship(c, 0.2).toFixed(2)}`);
  }
  {
    const before = pol?.attitude[ps.id] ?? 0, techs = pol?.techs.length ?? 0;
    if (pol) pol.techs = pol.techs.filter((t: string) => t !== 'colony_ark');   // something to teach
    const r = play('ambassadors');
    check('AMBASSADORS: the neighbours warm to yours', !!r.line && (pol?.attitude[ps.id] ?? 0) > before, r.why || `${before.toFixed(2)} → ${(pol?.attitude[ps.id] ?? 0).toFixed(2)}`);
    check('AMBASSADORS: and learn something from you (its price)', (pol?.techs.length ?? 0) >= techs, `${pol?.techs.length} techs`);
  }
  {
    const r = play('terraform', 'ocean');
    check('REMAKE A WORLD: the home world begins to change', !!r.line && !!ps.terraformStage, r.why || `${ps.terraformStage} → ${ps.terraformTargetType}`);
  }  {
    const r6 = scene(6);
    ({ w, ps, ns, pol } = r6);
    const known = ns.nations.map((n: any) => n.techs.length).reduce((a: number, b: number) => a + b, 0);
    const grudge = pol?.grievance[ps.id] ?? 0;
    const r = play('espionage');
    const now = ns.nations.map((n: any) => n.techs.length).reduce((a: number, b: number) => a + b, 0);
    check('INDUSTRIAL ESPIONAGE: a technology stolen', !!r.line && now === known + 1, r.why || r.line?.slice(22, 110));
    check('INDUSTRIAL ESPIONAGE: and they remember (its price)', (pol?.grievance[ps.id] ?? 0) > grudge, `${grudge.toFixed(2)} → ${(pol?.grievance[ps.id] ?? 0).toFixed(2)}`);
  }

}

// ── 3. Consequences against an untouched twin ────────────────────────────────
console.log('\n═══ 3. A played card changes the world (vs its twin) ═══');
{
  /** Each engine keeps its own nations and home surface; runtimeState holds one engine's at a time. */
  type Side = { e: any; ns: any; grid: any };
  const side = (seed: string, era: number): Side => {
    const e = world(seed, era);
    return { e, ns: runtimeState.playerNations, grid: e.ensurePlayerGrid() };
  };
  const enter = (x: Side) => { runtimeState.playerNations = x.ns; runtimeState.playerPlanetGrid = x.grid; };
  const run = (x: Side, ticks: number) => { enter(x); for (let i = 0; i < ticks; i++) x.e.update(); x.grid = runtimeState.playerPlanetGrid; };
  const sum = (ns: any, f: (n: any) => number) => ns.nations.filter((n: any) => !n.fallen).reduce((s: number, n: any) => s + f(n), 0);
  const twin = (id: string, era: number, ticks: number, measure: (ns: any) => number, more: boolean, label: string) => {
    const a = side(`tech_twin_${id}`, era);
    const b = side(`tech_twin_${id}`, era);
    enter(a);
    gameState.techPoints = 200;
    const played = a.e.playTechCard(id);
    if (!played) { const v = a.e.techCardViews().find((x: any) => x.card.id === id); check(`${label}`, false, `could not play (${v.unlocked ? v.block ?? 'refused' : 'sealed'})`); return; }
    run(a, ticks);
    run(b, ticks);
    const x = measure(a.ns), y = measure(b.ns);
    check(label, more ? x > y : x < y, `${x.toFixed(2)} vs twin ${y.toFixed(2)} (${((x / Math.max(1e-9, y) - 1) * 100).toFixed(0)}%)`);
  };
  twin('canals', 2, 6_000, ns => sum(ns, n => n.state.foodYield), true, 'GREAT CANALS: more food than the twin');
  twin('universities', 3, 16_000, ns => sum(ns, n => n.techs.length + (n.research?.progress ?? 0)), true, 'UNIVERSITIES: further in study than the twin');
  twin('industry', 5, 16_000, ns => sum(ns, n => n.state.pollution), true, 'INDUSTRIAL PUSH: dirtier than the twin (its price)');
  twin('clean', 5, 6_000, ns => sum(ns, n => n.state.pollution), false, 'CLEAN SKIES: cleaner than the twin');
  twin('laws', 2, 300, ns => sum(ns, n => n.state.inequality), false, 'THE CODE OF LAWS: fairer than the twin');
}

console.log(failed ? `\n${failed} FAILED` : '\nall tech card checks passed');
process.exit(failed ? 1 : 0);
