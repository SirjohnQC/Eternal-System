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
console.log(failed === 0 ? '\n  all nation checks passed\n' : `\n  ${failed} nation check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
