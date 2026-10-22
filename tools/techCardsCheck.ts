/**
 * Checks the tech cards (src/simulation/TechCards.ts; BigBangEngine.playTechCard;
 * docs/plans/2026-10-14-tech-cards.md) in the real engine, headless.
 *
 *   npx esbuild tools/techCardsCheck.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/tech.mjs --log-level=error && node /tmp/tech.mjs
 *
 * 1. The TP economy: a technology pays once (reloads and setbacks included); an
 *    age pays once.
 * 1b. The owner's model (Oct 22): TP unlock technologies in the tree. An unlock
 *    spends the node's price (half when a nation already knows it), needs its
 *    prerequisites known, inspires the neediest nation able to study it, pays
 *    no discovery TP, and grants the node's card(s) into the hand; a burned
 *    card leaves the hand and costs nothing to burn; recalling it costs its
 *    worn price; the same acts in a twin give the same world; a save keeps
 *    the hand and the unlocks, and an older save without them loads.
 * 2. Every card (authored and small) in a world leapt to the Post-Biological
 *    age: unlocked into the hand; burning it spends no TP and takes it out of
 *    the hand; its omens fall on the nations it names and nowhere else, with
 *    its price laid too, each linked to the act in the Chronicle; its special
 *    act happens; taking it back costs more (wear).
 * 3. Consequences against an untouched twin: a played card changes the world.
 */
import { makeCanvas } from './lib/headlessDom';
const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState, runtimeState } = await import('../src/simulation/GameState');
const { TECH_CARDS, TECH_CARD_BY_ID, CARDS_OF_TECH, KNOWN_NODE_SHARE } = await import('../src/simulation/TechCards');
const { gameStateFromSave, restoreSave, SAVE_VERSION } = await import('../src/simulation/SaveFormat');
const { appeal, available } = await import('../src/simulation/Technology');

let failed = 0;
import { LANDMARK_OF } from '../src/simulation/Landmarks';
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
  gameState.techUnlocked = [];
  gameState.techHand = [];
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


// ── 1b. The owner's model: TP unlock the tree, an unlock grants the card ────
console.log('\n═══ 1b. Unlocks: TP buy technologies, technologies give cards ═══');
{
  /** A Medieval world, and the node to buy: one no nation knows that some nation could study now. */
  const setup = (seed: string) => {
    const e = world(seed, 2);
    const ns = runtimeState.playerNations!;
    gameState.techPoints = 60;
    const node = e.techNodeViews().find((v: any) => !v.known && v.ready);
    return { e, ns, node };
  };
  const { e, ns, node } = setup('tech_unlock');
  check('a Medieval world has a technology ready to unlock', !!node, node?.tech.id ?? 'none');
  if (node) {
    const id = node.tech.id;
    const base = CARDS_OF_TECH[id].reduce((a: number, c: any) => a + c.cost, 0);
    check('a node no nation knows costs its cards\' full price', node.price === base, `${node.price} vs ${base}`);
    // Who should be inspired: the live nation able to study it that is drawn to it most.
    const able = ns.nations.filter((n: any) => !n.fallen && available(n.techs).some((t: any) => t.id === id));
    const w = (n: any) => appeal(node.tech, { ...n.pressures, curiosity: n.values.curiosity * 0.5 }, n.values);
    const expect = able.reduce((b: any, n: any) => !b || w(n) > w(b) ? n : b, null);
    const tp = gameState.techPoints;
    const line = e.unlockTech(id);
    check('unlocking spends the node\'s price', !!line && gameState.techPoints === tp - node.price, `${tp} → ${gameState.techPoints}`);
    check('the node is recorded as unlocked', (gameState.techUnlocked ?? []).includes(id));
    check('its card(s) go into the hand', CARDS_OF_TECH[id].every((c: any) => (gameState.techHand ?? []).includes(c.id)), (gameState.techHand ?? []).join(','));
    const knowers = ns.knowersOf(id);
    check('the neediest able nation learns it at once', knowers.length === 1 && knowers[0] === expect, `${knowers.map((n: any) => n.name).join(',')} vs ${expect?.name}`);
    check('the Chronicle records the unlock', ns.chronicle.some((h: any) => h.what.includes(`to unlock ${node.tech.name}`)));
    const tp2 = gameState.techPoints;
    e.rewardDiscovery(id);
    check('an inspired technology pays no discovery TP', gameState.techPoints === tp2);
    check('a node whose card is in hand cannot be bought again', e.unlockTech(id) === null && gameState.techPoints === tp2,
      e.techNodeViews().find((v: any) => v.tech.id === id).block);

    // Burning: free, and the card leaves the hand.
    const card = CARDS_OF_TECH[id][0];
    const playable = e.techCardViews().find((v: any) => v.card.id === card.id);
    if (playable.block) console.log(`  skip  burn: ${playable.block}`);
    else {
      const tp3 = gameState.techPoints;
      const burned = e.playTechCard(card.id);
      check('burning a card in hand costs no TP', !!burned && gameState.techPoints === tp3, `${tp3} → ${gameState.techPoints}`);
      check('a burned card leaves the hand', !(gameState.techHand ?? []).includes(card.id));
      check('a card not in hand cannot be burned', e.playTechCard(card.id) === null);
      const back = e.techNodeViews().find((v: any) => v.tech.id === id);
      check('taking it back is a recall at a worn price', back.recall && back.price > card.cost, `recall ${back.recall}, ${back.price} TP vs ${card.cost}`);
      const knowN = ns.knowersOf(id).length, tp4 = gameState.techPoints;
      check('a recall returns the card and spends its price', !!e.unlockTech(id) && (gameState.techHand ?? []).includes(card.id) && gameState.techPoints === tp4 - back.price);
      check('a recall inspires no one new', ns.knowersOf(id).length === knowN);
    }
  }
  // Prerequisites: a node whose requirements no nation knows cannot be bought.
  const far = e.techNodeViews().find((v: any) => !v.ready && v.tech.requires.some((r: string) => !ns.nations.some((n: any) => !n.fallen && n.techs.includes(r))));
  const tpF = gameState.techPoints;
  check('a node whose prerequisites are unknown cannot be bought', !!far && e.unlockTech(far.tech.id) === null && gameState.techPoints === tpF,
    far ? `${far.tech.name}: ${far.block}` : 'none found');
  // TP: one short of the price is refused, and the node stays ready.
  const next = e.techNodeViews().find((v: any) => v.ready && !v.unlocked);
  if (next) {
    gameState.techPoints = next.price - 1;
    const v = e.techNodeViews().find((x: any) => x.tech.id === next.tech.id);
    check('one TP short is refused, and the node stays ready', e.unlockTech(next.tech.id) === null && v.ready && !!v.block, v.block);
  }
  // Half price where a nation already knows it.
  gameState.techPoints = 60;
  const knownNode = e.techNodeViews().find((v: any) => v.known && !v.unlocked);
  if (knownNode) {
    const base = CARDS_OF_TECH[knownNode.tech.id].reduce((a: number, c: any) => a + c.cost, 0);
    check('a node a nation knows costs half (rounded up)', knownNode.price === Math.ceil(base * KNOWN_NODE_SHARE), `${knownNode.price} vs ${base}`);
    const before = ns.nations.map((n: any) => n.techs.length).join(',');
    e.unlockTech(knownNode.tech.id);
    check('unlocking a known node teaches no one', ns.nations.map((n: any) => n.techs.length).join(',') === before);
  }
  // Every node grants a card: authored, or the technology's small card.
  const { TECHS } = await import('../src/simulation/Technology');
  check('every technology grants at least one card', TECHS.every((t: any) => (CARDS_OF_TECH[t.id] ?? []).length > 0));
  check('small cards carry a benefit and a price', TECH_CARDS.filter((c: any) => c.minor).every((c: any) => (c.omens ?? []).length > 0 && (c.price ?? []).length > 0));

  // Determinism: the same acts in a twin world give the same world.
  const a = setup('tech_unlock_twin');
  const sigOf = (x: any) => JSON.stringify({ hand: gameState.techHand, un: gameState.techUnlocked, tp: gameState.techPoints,
    techs: runtimeState.playerNations!.nations.map((n: any) => n.techs) });
  const act = (x: any) => { if (x.node) x.e.unlockTech(x.node.tech.id); for (let i = 0; i < 1_500; i++) x.e.update(); return sigOf(x); };
  const sa = act(a);
  const b = setup('tech_unlock_twin');
  const sb = act(b);
  check('unlocks are deterministic (twin worlds agree)', sa === sb, sa === sb ? '' : `${sa.slice(0, 80)} vs ${sb.slice(0, 80)}`);

  // Saves: the hand and the unlocks survive a save and a load; an older save without them loads.
  const handBefore = JSON.stringify(gameState.techHand), unBefore = JSON.stringify(gameState.techUnlocked);
  const save = JSON.parse(JSON.stringify({ version: SAVE_VERSION, savedAt: 0, gameState: { ...gameState, stats: STATS, masterSeed: 'tech_unlock_twin' }, engine: b.e.serialize(), eventLog: [] }));
  reset();
  const loaded = new BigBangEngine(makeCanvas()) as any;
  restoreSave(loaded, save);
  check('a save keeps the hand and the unlocks', JSON.stringify(gameState.techHand) === handBefore && JSON.stringify(gameState.techUnlocked) === unBefore,
    `${JSON.stringify(gameState.techHand)} / ${JSON.stringify(gameState.techUnlocked)}`);
  const old = JSON.parse(JSON.stringify(save));
  delete old.gameState.techHand; delete old.gameState.techUnlocked;
  reset();
  const older = new BigBangEngine(makeCanvas()) as any;
  let threw: string | null = null;
  try { restoreSave(older, old); for (let i = 0; i < 500; i++) older.update(); older.techNodeViews(); older.techCardViews(); } catch (err) { threw = String(err); }
  check('an older save without a hand or unlocks loads and runs', threw === null && !(gameState.techHand ?? []).length, threw ?? '');
  check('gameStateFromSave leaves them optional', gameStateFromSave({}).techHand === undefined || Array.isArray(gameStateFromSave({}).techHand));
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
  const held = views.filter((v: any) => v.unlocked && v.card.special !== 'new_world').length;
  check('no card is in hand before an unlock (only A New World stands)', held === 0, `${held} held`);
  const ready = e.techNodeViews().filter((v: any) => v.ready).length;
  check('a Post-Biological world can unlock most of the tree', ready >= 40, `${ready} nodes ready`);
  check('a card whose technology no nation could learn stays out of reach', (() => {
    const r = new BigBangEngine(makeCanvas()) as any;
    reset(); r.init(STATS, 'tech_sealed'); for (let i = 0; i < 3_000; i++) r.update(); r.leapToEra(1);
    const v = r.techNodeViews().find((x: any) => x.tech.id === 'seedships');
    return !!v && !v.ready && r.unlockTech('seedships') === null;
  })());
  // The sealed check reset gameState and nations: rebuild the main world.
  const w = world('tech_all', 8);
  const wps = w.getPlayerStar();
  w.exploredAreas.push({ x: wps.x, y: wps.y, r: 1e6 });
  const wns = runtimeState.playerNations!;

  for (const card of TECH_CARDS) {
    if (card.special === 'new_world') continue;            // its own scenarios (invariantCheck)
    gameState.techPoints = 200;
    // Into the hand: unlock its technology (or take the card back, when a sibling card's unlock already lit it).
    if (!(gameState.techHand ?? []).includes(card.id)) w.unlockTech(card.needs.tech!);
    const v = w.techCardViews().find((x: any) => x.card.id === card.id);
    if (!v.unlocked) {
      // The seeded history decides how far up the last age its nations climbed; a node out of their reach is the world, not a fault.
      const node = w.techNodeViews().find((x: any) => x.tech.id === card.needs.tech);
      if (!node.ready && !node.known) { console.log(`  skip  ${card.name.padEnd(64)} ${node.block}`); continue; }
      check(`${card.name}: unlocked`, false, node.block ?? 'not in hand'); continue;
    }
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
    const lmBefore = (gameState.landmarks ?? []).length;
    const line = w.playTechCard(card.id, choice);
    if (!line) { check(`${card.name}: plays`, false, 'refused although listed playable'); continue; }
    const problems: string[] = [];
    if (gameState.techPoints !== snap.tp) problems.push(`burning spent TP: ${snap.tp} → ${gameState.techPoints}`);
    if ((gameState.techHand ?? []).includes(card.id)) problems.push('still in hand');
    const title = card.name.charAt(0) + card.name.slice(1).toLowerCase();
    for (const n of wns.nations.filter((x: any) => targets.includes(x.name))) {
      for (const o of card.omens ?? []) if (!n.omens.some((m: any) => m.card === title && m.op === o.op && m.primary && m.cause)) problems.push(`${n.name} lacks ${o.op}`);
      for (const p of card.price ?? []) if (!n.omens.some((m: any) => m.card === title && m.op === p.op && !m.primary)) problems.push(`${n.name} lacks price ${p.op}`);
      if (card.inequality && !(n.state.inequality < (ineq.get(n.id) as number) || n.state.inequality === 0)) problems.push(`${n.name} inequality did not fall`);
    }
    if (card.who === 'knowers') for (const n of others) if (n.omens.some((m: any) => m.card === title && m.primary)) problems.push(`${n.name} got it without the knowledge`);
    if (!wns.chronicle.some((h: any) => h.what.includes(`burned ${title}`))) problems.push('no Chronicle entry for the act');
    // What it leaves standing (Landmarks.ts): one per nation it acts on (or one for a world act), where there is room.
    if (LANDMARK_OF[card.id] && w.getPlayerStar()?.id === wps.id) {
      const raised = (gameState.landmarks ?? []).slice(lmBefore).filter((l: any) => l.card === card.id);
      if (!raised.length) problems.push('left nothing standing');
    }
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
    const again = w.techNodeViews().find((x: any) => x.tech.id === card.needs.tech);
    if (!(again.recall && again.price >= Math.round(card.cost * 1.25) && again.price > 0)) problems.push(`wear: recall ${again.recall}, ${again.price} TP for a ${card.cost} card`);
    check(`${card.name}${card.minor ? ' (small)' : ''}`, !problems.length, problems.length ? problems.join('; ') : `${again.price} TP to recall · ${line.slice(card.name.length + 1, card.name.length + 60).trim()}`);
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
    const need = TECH_CARD_BY_ID[id].needs.tech;
    if (need && !(gameState.techHand ?? []).includes(id)) w.unlockTech(need);
    const v = w.techCardViews().find((x: any) => x.card.id === id);
    if (!v.unlocked) return { v, line: null as string | null, why: 'not in hand' };
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
    // The card's own precondition, made explicit: a nation that knows AI. The
    // seeded history decides whether one learnt it by era 6, and that is not
    // what this check is about.
    const live = ns.nations.filter((n: any) => !n.fallen);
    if (live.length && !live.some((n: any) => n.techs.includes('ai'))) live[0].techs.push('ai');
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
    // The card's own precondition, made explicit on both twins (the seeded
    // history decides whether a nation learnt the technology yet).
    const need = (TECH_CARDS.find((c: any) => c.id === id) as any)?.needs?.tech as string | undefined;
    for (const x of [a, b]) {
      const live = x.ns.nations.filter((n: any) => !n.fallen);
      if (need && live.length && !live.some((n: any) => n.techs.includes(need))) live[0].techs.push(need);
    }
    enter(a);
    gameState.techPoints = 200;
    gameState.techHand = [];
    // The card into the hand: its technology is known on both twins, so the unlock teaches no one.
    if (need) a.e.unlockTech(need);
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
