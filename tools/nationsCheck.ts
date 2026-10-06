/**
 * Checks the nation system (src/simulation/Nations.ts) on real planet grids,
 * and writes a territory map per world so it can be looked at.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/nationsCheck.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/nations.mjs" --log-level=error && node "$TEMP/nations.mjs" [outDir]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generatePlanetGrid, GRID_SIZE, BIOME_COLORS, isWater, isHabitable, type PlanetGrid } from '../src/simulation/PlanetGrid';
import { NationSystem } from '../src/simulation/Nations';
import { valuesFromGenome, type GenomeSummary } from '../src/simulation/Civilization';
import { flagColorAt } from '../src/rendering/NationFlagArt';
import { TECHS, TECH_BY_ID, appeal, available } from '../src/simulation/Technology';

const outDir = process.argv[2] ?? 'renders/nations';
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
  if (!ok) failed++;
};

const genome = (social: number, aggression: number): GenomeSummary => ({
  speciesName: 'Test', metabolism: 'heterotrophic', locomotion: 'walking', environment: 'land', diet: 'omnivore',
  respiration: 'aerobic', reproduction: 'sexual', size: 'medium', bodyStructure: 'vertebrate', sensorySystem: 'vision',
  intelligence: 7, social, aggression, adaptability: 5, biome: 'forest', temperatureRange: 'temperate',
});

/** Settle the fertile habitable land, as stepLifeSpread stamps civId. */
function settled(type: string, seed: number): PlanetGrid {
  const grid = generatePlanetGrid(type, seed, null, null);
  for (const row of grid) for (const c of row) {
    c.lifeDensity = isHabitable(c.biome) ? c.fertility : 0;
    c.civId = isHabitable(c.biome) && c.fertility > 0.35 ? '1' : null;
  }
  return grid;
}

function png(w: number, h: number, rgba: Uint8ClampedArray): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function map(grid: PlanetGrid, ns: NationSystem): Uint8ClampedArray {
  const img = new Uint8ClampedArray(GRID_SIZE * GRID_SIZE * 4);
  for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
    const i = r * GRID_SIZE + c, o = i * 4, own = ns.owner[i];
    let [R, G, B] = BIOME_COLORS[grid[r][c].biome];
    if (own >= 0) {
      const [nr, ng, nb] = hex(ns.nations[own].color);
      const border = [[0, 1], [1, 0], [0, -1], [-1, 0]].some(([dr, dc]) => {
        const rr = r + dr, cc = (c + dc + GRID_SIZE) % GRID_SIZE;
        return rr >= 0 && rr < GRID_SIZE && ns.owner[rr * GRID_SIZE + cc] !== own;
      });
      const a = border ? 0.9 : 0.35;
      R = R * (1 - a) + nr * a; G = G * (1 - a) + ng * a; B = B * (1 - a) + nb * a;
    }
    const cap = ns.nations.some(n => Math.abs(n.capital.row - r) <= 1 && Math.abs(n.capital.col - c) <= 1);
    if (cap) { R = 255; G = 255; B = 255; }
    img[o] = R; img[o + 1] = G; img[o + 2] = B; img[o + 3] = 255;
  }
  return img;
}

mkdirSync(outDir, { recursive: true });
const allFlags: NationSystem['nations'] = [];
for (const [type, seed, social, aggr] of [['rocky', 7, 4, 5], ['ocean', 3, 6, 3], ['rocky', 42, 2, 8], ['desert', 11, 5, 4], ['toxic', 5, 9, 2]] as const) {
  console.log(`\n  ${type} seed ${seed} (social ${social}, aggression ${aggr})`);
  const grid = settled(type, seed * 7777);
  const g = genome(social, aggr);
  const ns = new NationSystem(seed);
  ns.found(grid, valuesFromGenome(g), g, 0);
  const n = ns.nations.length;
  check('founds 2-6 nations', n >= 2 && n <= 6, `${n}: ${ns.nations.map(x => x.name).join(', ')}`);
  let settledN = 0, unowned = 0, wet = 0;
  for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
    const cell = grid[r][c], o = ns.owner[r * GRID_SIZE + c];
    if (cell.civId != null && !isWater(cell.biome)) { settledN++; if (o < 0) unowned++; }
    if (o >= 0 && isWater(cell.biome)) wet++;
  }
  check('every settled cell has a nation', unowned === 0, `${unowned} of ${settledN} unowned`);
  check('no nation owns water', wet === 0, `${wet}`);
  check('border colours are distinct', new Set(ns.nations.map(x => x.color)).size === n);
  // Contiguity: the share of each nation's cells in its largest 4-connected piece.
  const shares = ns.nations.map((_, k) => {
    const seen = new Uint8Array(GRID_SIZE * GRID_SIZE); let total = 0, best = 0;
    for (let i = 0; i < seen.length; i++) {
      if (ns.owner[i] !== k) continue; total++;
      if (seen[i]) continue;
      let size = 0; const st = [i]; seen[i] = 1;
      while (st.length) {
        const j = st.pop()!; size++;
        const r = (j / GRID_SIZE) | 0, c = j % GRID_SIZE;
        for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
          const rr = r + dr; if (rr < 0 || rr >= GRID_SIZE) continue;
          const q = rr * GRID_SIZE + (c + dc + GRID_SIZE) % GRID_SIZE;
          if (!seen[q] && ns.owner[q] === k) { seen[q] = 1; st.push(q); }
        }
      }
      best = Math.max(best, size);
    }
    return total ? best / total : 1;
  });
  check('territories are mostly one piece (>= 50%)', shares.every(s => s >= 0.5), shares.map(s => `${(s * 100) | 0}%`).join(' '));
  const again = new NationSystem(seed); again.found(settled(type, seed * 7777), valuesFromGenome(g), g, 0);
  check('same seed, same nations', again.nations.map(x => x.name).join() === ns.nations.map(x => x.name).join()
    && again.owner.every((v, i) => v === ns.owner[i]));
  for (let t = 1; t <= 300; t++) ns.step(grid, t);
  const st = ns.nations.map(x => x.state);
  check('needs stay finite and positive', st.every(s => Number.isFinite(s.population) && s.population > 0 && Number.isFinite(s.knowledge)),
    st.map(s => `${s.population | 0}p ${s.land}c`).join(' | '));
  const pr = ns.nations.map(x => x.pressures);
  check('pressures stay in 0..1', pr.every(p => Object.values(p).every(v => v >= 0 && v <= 1)),
    ns.nations.map(x => `${x.name.split(' ').pop()}: hunger ${(x.pressures.hunger * 100) | 0}% crowd ${(x.pressures.crowding * 100) | 0}% unrest ${(x.pressures.unrest * 100) | 0}%`).join('; '));
  for (const x of ns.nations) console.log(`        ${x.name} — ${x.government}, ${x.ideology}; flag ${x.flag.layout}/${x.flag.emblem}; ${x.history.length} history entries: ${x.history.slice(-1)[0].what}`);
  writeFileSync(`${outDir}/${type}_${seed}.png`, png(GRID_SIZE, GRID_SIZE, map(grid, ns)));
  allFlags.push(...ns.nations);
}
// Every flag founded above, 10x6 px each at 6x, on a dark sheet.
{
  const FC = 10, FR = 6, UP = 6, PAD = 4, COLS = 6;
  const rows = Math.ceil(allFlags.length / COLS);
  const W = COLS * (FC * UP + PAD) + PAD, H = rows * (FR * UP + PAD) + PAD;
  const img = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { img[i * 4] = 30; img[i * 4 + 1] = 34; img[i * 4 + 2] = 48; img[i * 4 + 3] = 255; }
  allFlags.forEach((n, k) => {
    const ox = PAD + (k % COLS) * (FC * UP + PAD), oy = PAD + Math.floor(k / COLS) * (FR * UP + PAD);
    for (let j = 0; j < FR; j++) for (let i = 0; i < FC; i++) {
      const [R, G, B] = hex(flagColorAt(n.flag, (i + 0.5) / FC, (j + 0.5) / FR, FC, FR));
      for (let dy = 0; dy < UP; dy++) for (let dx = 0; dx < UP; dx++) {
        const o = ((oy + j * UP + dy) * W + ox + i * UP + dx) * 4;
        img[o] = R; img[o + 1] = G; img[o + 2] = B;
      }
    }
  });
  writeFileSync(`${outDir}/flags.png`, png(W, H, img));
}
// ── Phase 2: technology as a response ──────────────────────────────────────
console.log('\n  technology');
{
  const calm = { hunger: 0, crowding: 0, scarcity: 0, unrest: 0, pollution: 0, curiosity: 0.25 };
  const mid = { militarism: 0.5, piety: 0.5, curiosity: 0.5, collectivism: 0.5, xenophobia: 0.5 };
  check('hunger draws a people to farming', appeal(TECH_BY_ID.agriculture, { ...calm, hunger: 0.8 }, mid) > 3 * appeal(TECH_BY_ID.writing, { ...calm, hunger: 0.8 }, mid));
  check('a pious people leans to priesthood', appeal(TECH_BY_ID.priesthood, calm, { ...mid, piety: 0.95 }) > appeal(TECH_BY_ID.priesthood, calm, { ...mid, piety: 0.05 }));
  check('every prerequisite exists and is earlier or same era', TECHS.every(t => t.requires.every(r => TECH_BY_ID[r] && TECH_BY_ID[r].era <= t.era)));
  check('only ancient techs at the start', available([]).every(t => t.era === 1));
  check('the tree reaches a spaceship', TECHS.some(t => t.spaceship));

  const relStats = { wars: 0, trades: 0, falls: 0 };
  // A long run at the engine's pace (step every 2000 ticks, 40000 ticks an era).
  const ERA = 40000, STEP = 2000;
  for (const [type, seed, social, aggr] of [['rocky', 7, 4, 5], ['desert', 11, 5, 4]] as const) {
    const grid = settled(type, seed * 7777);
    const g = genome(social, aggr);
    const ns = new NationSystem(seed);
    ns.found(grid, valuesFromGenome(g), g, 0);
    const eraAt: number[] = [];
    let peakPollution = 0, peakHunger = 0, ships = 0, prereqOk = true;
    const news: string[] = [];
    let longestWar = 0;
    const warSince = new Map<string, number>();
    for (let t = STEP; t <= ERA * 12; t += STEP) {
      ns.step(grid, t, ERA);
      news.push(...ns.drainNews());
      for (const r of ns.relations) {
        const key = `${r.a}-${r.b}`;
        if (r.war) { if (!warSince.has(key)) warSince.set(key, t); longestWar = Math.max(longestWar, t - warSince.get(key)!); }
        else warSince.delete(key);
      }
      for (const d of ns.drainDiscoveries()) {
        const before = d.nation.techs.slice(0, d.nation.techs.indexOf(d.tech.id));
        if (!d.tech.requires.every(r => before.includes(r))) prereqOk = false;
        if (d.tech.spaceship) ships++;
      }
      for (const n of ns.nations) { peakPollution = Math.max(peakPollution, n.pressures.pollution); peakHunger = Math.max(peakHunger, n.pressures.hunger); }
      if (t % ERA === 0) eraAt.push(ns.maxEra);
    }
    console.log(`\n  ${type} ${seed}: max era by era-time ${eraAt.join(' ')}`);
    check('eras climb over time', eraAt[eraAt.length - 1] > eraAt[1] && eraAt[1] >= 1, eraAt.join(' '));
    check('about one era per era of time (not runaway)', eraAt[3] >= 2 && eraAt[3] <= 6, `after 4 eras: ${eraAt[3]}`);
    check('prerequisites always learned first', prereqOk);
    check('nations follow different paths', new Set(ns.nations.map(n => n.techs.slice(0, 4).join())).size > 1);
    check('industry brings pollution, and it bites', peakPollution > 0.25, `peak ${(peakPollution * 100) | 0}%`);
    const learned = ns.nations.flatMap(n => n.history.filter(h => h.because.some(b => b.startsWith('building on')) || TECHS.some(t => h.what.endsWith(t.deed + '.'))));
    const driven = learned.filter(h => h.because.some(b => /%\)/.test(b))).length;
    check('some choices answer a pressure', driven >= learned.length * 0.15, `${driven} of ${learned.length} discoveries answered a pressure`);
    const wars = news.filter(m => m.includes('gone to war')).length, peaces = news.filter(m => m.includes('made peace')).length;
    const trades = news.filter(m => m.startsWith('Caravans')).length, falls = news.filter(m => m.includes('has fallen')).length;
    relStats.wars += wars; relStats.trades += trades; relStats.falls += falls;
    console.log(`        attitudes now: ${ns.relations.map(r => r.attitude.toFixed(2)).join(' ')}`);
    console.log(`        relations: ${trades} trade routes opened, ${wars} wars, ${peaces} peaces, ${falls} nations fallen; longest war ${(longestWar / ERA).toFixed(2)} eras`);
    for (const m of news.slice(0, 12)) console.log(`          ~ ${m}`);
    check('wars end (none outlasts 3 eras)', longestWar <= ERA * 3, `${(longestWar / ERA).toFixed(2)} eras`);
    check('every war has its causes recorded', ns.nations.every(n => n.history.filter(h => h.what.includes('went to war')).every(h => h.because.length >= 1)));
    console.log(`        peak hunger ${(peakHunger * 100) | 0}%, colony arks launched: ${ships}`);
    for (const n of ns.nations) {
      console.log(`        ${n.name} (era ${n.era}): first ${n.techs.slice(0, 8).map(id => TECH_BY_ID[id].name).join(', ')}`);
      console.log(`          now: ${Object.entries(n.pressures).map(([k, v]) => `${k} ${(v * 100) | 0}%`).join(' ')}; inequality ${(n.state.inequality * 100) | 0}%`);
      for (const h of n.history.filter(h => h.what.includes(' ') ).slice(0, 7)) console.log(`          · ${h.what}  ← ${h.because.join('; ')}`);
    }
  }
  // Conquest: a small nation forced into war with a much larger neighbour.
  {
    const grid = settled('rocky', 7 * 7777), g = genome(4, 5), ns = new NationSystem(7);
    ns.found(grid, valuesFromGenome(g), g, 0);
    for (let t = 2000; t <= 20000; t += 2000) ns.step(grid, t, 40000);
    const pairs = ns.relations.filter(r => r.border > 0).sort((x, y) => y.border - x.border);
    const r = pairs[0];
    const [big, small] = ns.nations[r.a].state.land > ns.nations[r.b].state.land ? [ns.nations[r.a], ns.nations[r.b]] : [ns.nations[r.b], ns.nations[r.a]];
    const before = small.state.land;
    // The big one is far ahead: every technology up to the Space Age, and martial.
    big.techs = TECHS.filter(t => t.era <= 5).map(t => t.id); big.era = 5; big.values.militarism = 1;
    r.war = { aggressor: big.id, since: 0, cause: ['test'], landAtStart: [ns.nations[r.a].state.land, ns.nations[r.b].state.land], taken: [0, 0], weariness: 0 };
    let ended = false;
    for (let t = 22000; t <= 120000 && !ended; t += 2000) { ns.step(grid, t, 40000); ended = !r.war; }
    const lostLand = before - (small.fallen ? 0 : small.state.land);
    check('a lopsided war moves the frontier', lostLand > before * 0.3, `${small.name} ${before} → ${small.fallen ? 'fallen' : small.state.land} cells`);
    check('and ends (in peace or conquest), with causes', ended && small.history.some(h => /peace|fell/.test(h.what) && h.because.length > 0),
      small.history.slice(-1)[0]?.what ?? '');
  }
  check('relations happen: trade and war both emerge', relStats.trades > 0 && relStats.wars > 0, JSON.stringify(relStats));
}

console.log(failed === 0 ? '\n  all nation checks passed\n' : `\n  ${failed} nation check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
