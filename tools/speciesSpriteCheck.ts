/**
 * Does the creature sprite on the diorama actually show the species that evolved?
 *
 * Everything is judged at the ON-SCREEN size — the pixels the diorama puts on
 * its 480px backbuffer after `IsoDioramaRenderer.buildInhabitants` sizes the
 * sprite — never at the baked canvas size. A medium creature used to be baked
 * 20px wide and nearest-neighbour decimated to ~7px, so detail that exists in
 * the bake can be invisible in the game.
 *
 * Three questions, each a gate:
 *
 *  1. SENSITIVITY — hold the species id fixed, change ONE genome axis, re-render.
 *     Does a perceptible difference reach the screen? Per axis, over every
 *     evolved species big enough to carry detail (on-screen long edge >= 5px).
 *     An axis the baker ignores scores 0 no matter how varied the art looks.
 *  2. PROVENANCE — hold the genome fixed, change only the id. Variation the id
 *     alone produces is decoration, not identity. It must stay well below the
 *     variation the genome produces, or "distinct" sprites are distinct by dice.
 *  3. DISTINGUISHABILITY — on each simulated world, every pair of co-existing
 *     living species: can they be told apart on screen? Split into silhouette,
 *     palette and size so a baker that only varies one dimension shows it.
 *
 * "Perceptible" at this size: a pixel counts as different when its opacity
 * flips, or both are opaque and the RGB distance exceeds 60. A pair/perturbation
 * is perceptibly different when at least max(2, 12% of the larger silhouette)
 * pixels differ, after aligning both sprites bottom-centre (how they are placed).
 *
 * CONTROL: `--control` runs the identical metric on a frozen copy of the
 * pre-rework baker (tools/lib/legacySpeciesSprite.ts) and exits 0 only if the
 * metric REJECTS it. A metric that cannot fail on that baker measures nothing.
 *
 * Build + run (PowerShell or bash):
 *   node_modules/.bin/esbuild tools/speciesSpriteCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TEMP/ssc.mjs && node $TEMP/ssc.mjs [--control] [--sheet=out.png] [--seeds=40] [--verbose]
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { installSoftCanvas, SoftCanvas } from './lib/softCanvas';

installSoftCanvas();

const { SeedRNG } = await import('../src/utils/SeedRNG');
const { initPlayerSpecies, stepEvolution, isCoherent } = await import('../src/simulation/EvolutionEngine');
const { DEFAULT_BIOSPHERE } = await import('../src/simulation/SpeciesGenome');
type SpeciesGenome = import('../src/simulation/SpeciesGenome').SpeciesGenome;
const legacy = await import('./lib/legacySpeciesSprite');
const current = await import('../src/rendering/SpeciesSprite') as any;

const args = process.argv.slice(2);
const CONTROL = args.includes('--control');
const SEEDS = Number(args.find(a => a.startsWith('--seeds='))?.split('=')[1] ?? 40);
const SHEET = args.find(a => a.startsWith('--sheet='))?.split('=')[1];
const VERBOSE = args.includes('--verbose');

// ─── On-screen sprite: what the diorama puts on the backbuffer ────────────────

interface Px { w: number; h: number; d: Uint8ClampedArray }

/** The diorama's pre-rework sizing (IsoDioramaRenderer.buildInhabitants @2d62867). */
const LEGACY_SIZE_PX: Record<string, number> = {
  microscopic: 2.5, tiny: 4, small: 5.5, medium: 7.5, large: 10, massive: 13.5,
};
const LEGACY_PHASE_SCALE: Record<string, number> = {
  multicellular: 0.55, complex: 0.78, primitive: 0.92, intelligent: 1.0,
};

function resample(src: SoftCanvas, w: number, h: number): Px {
  const dst = new SoftCanvas(); dst.width = w; dst.height = h;
  dst.getContext().drawImage(src, 0, 0, w, h);
  return { w, h, d: dst.data };
}

/** Legacy pipeline: bake at scale 1, then drawImage to target size, depth 0.5. */
function legacyOnScreen(g: SpeciesGenome, phase: string): Px {
  const cv = legacy.bakeCreatureSprite(g, 1) as unknown as SoftCanvas;
  const target = (LEGACY_SIZE_PX[g.physicalTraits.size] ?? 5) * (LEGACY_PHASE_SCALE[phase] ?? 1);
  const w = Math.round(Math.max(2, target));
  const h = Math.round(Math.max(2, target * cv.height / cv.width));
  return resample(cv, w, h);
}

/**
 * Current pipeline. If the baker exports `dioramaCreatureSprite` (the function
 * the renderer calls), use exactly that — it returns the on-screen canvas,
 * blitted 1:1. Otherwise the renderer still uses the legacy blit path.
 */
function currentOnScreen(g: SpeciesGenome, phase: string): Px {
  if (typeof current.dioramaCreatureSprite === 'function') {
    const cv = current.dioramaCreatureSprite(g, phase, 0.5) as SoftCanvas;
    return { w: cv.width, h: cv.height, d: cv.data };
  }
  const cv = current.bakeCreatureSprite(g, 1) as SoftCanvas;
  const target = (LEGACY_SIZE_PX[g.physicalTraits.size] ?? 5) * (LEGACY_PHASE_SCALE[phase] ?? 1);
  return resample(cv, Math.round(Math.max(2, target)),
    Math.round(Math.max(2, target * cv.height / cv.width)));
}

const onScreen = CONTROL ? legacyOnScreen : currentOnScreen;
const clearCaches = () => (CONTROL ? legacy.clearSpriteCaches() : current.clearSpriteCaches());

// ─── Pixel comparison ─────────────────────────────────────────────────────────

const OPAQUE = 128;
const COLOR_DIFF = 60;

function opaqueCount(p: Px): number {
  let n = 0; for (let i = 3; i < p.d.length; i += 4) if (p.d[i] >= OPAQUE) n++; return n;
}

/** Align bottom-centre on a shared canvas, count perceptibly different pixels. */
function diff(a: Px, b: Px, mode: 'all' | 'mask' = 'all'): number {
  const W = Math.max(a.w, b.w), H = Math.max(a.h, b.h);
  const ox = (p: Px) => Math.floor((W - p.w) / 2), oy = (p: Px) => H - p.h;
  const at = (p: Px, x: number, y: number): number => {
    const sx = x - ox(p), sy = y - oy(p);
    if (sx < 0 || sy < 0 || sx >= p.w || sy >= p.h) return -1;
    return (sy * p.w + sx) * 4;
  };
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ia = at(a, x, y), ib = at(b, x, y);
    const oa = ia >= 0 && a.d[ia + 3] >= OPAQUE, ob = ib >= 0 && b.d[ib + 3] >= OPAQUE;
    if (oa !== ob) { n++; continue; }
    if (!oa || mode === 'mask') continue;
    const dr = a.d[ia] - b.d[ib], dg = a.d[ia + 1] - b.d[ib + 1], db = a.d[ia + 2] - b.d[ib + 2];
    if (Math.sqrt(dr * dr + dg * dg + db * db) > COLOR_DIFF) n++;
  }
  return n;
}

function perceptible(a: Px, b: Px, mode: 'all' | 'mask' = 'all'): boolean {
  const need = Math.max(2, 0.12 * Math.max(opaqueCount(a), opaqueCount(b)));
  return diff(a, b, mode) >= need;
}

/** Mean colour of opaque pixels. */
function meanColor(p: Px): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < p.d.length; i += 4) if (p.d[i + 3] >= OPAQUE) {
    r += p.d[i]; g += p.d[i + 1]; b += p.d[i + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}
function bbox(p: Px): [number, number] {
  let x0 = p.w, x1 = -1, y0 = p.h, y1 = -1;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (p.d[(y * p.w + x) * 4 + 3] >= OPAQUE) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return x1 < 0 ? [0, 0] : [x1 - x0 + 1, y1 - y0 + 1];
}
function distinctColors(p: Px): number {
  const s = new Set<number>();
  for (let i = 0; i < p.d.length; i += 4) if (p.d[i + 3] >= OPAQUE) s.add((p.d[i] >> 3) << 10 | (p.d[i + 1] >> 3) << 5 | (p.d[i + 2] >> 3));
  return s.size;
}

// ─── Population: evolve real species with the real engine ─────────────────────

const PHASES = ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'];
const STEPS_PER_PHASE = 30;
interface World { seed: number; phase: string; species: SpeciesGenome[] }

function evolveWorlds(): World[] {
  const worlds: World[] = [];
  for (let seed = 0; seed < SEEDS; seed++) {
    const rng = new SeedRNG(`spritecheck_${seed}`);
    let species = initPlayerSpecies(0, new SeedRNG(`founder_sc_${seed}`));
    let bio = { ...DEFAULT_BIOSPHERE };
    let tick = 0;
    for (const phase of PHASES) {
      for (let i = 0; i < STEPS_PER_PHASE; i++) {
        tick += 2000;
        const r = stepEvolution(phase, {}, species, bio, rng, tick, []);
        species = r.updatedSpecies; bio = r.updatedBiosphere;
      }
      if (phase !== 'microbial') {
        worlds.push({ seed, phase, species: species.filter(s => !s.isExtinct).map(s => structuredClone(s)) });
      }
    }
  }
  return worlds;
}

// ─── Perturbations ────────────────────────────────────────────────────────────

const LOCO = ['stationary', 'swimming', 'crawling', 'walking', 'flying'];
const META = ['photosynthetic', 'chemosynthetic', 'heterotrophic', 'parasitic'];
const ENV  = ['ocean', 'coastal', 'land', 'aerial', 'deep_sea'];
const DIET = ['producer', 'herbivore', 'omnivore', 'carnivore', 'decomposer'];
const SIZE = ['microscopic', 'tiny', 'small', 'medium', 'large', 'massive'];
const BODY = ['single-celled', 'colonial', 'segmented', 'radial', 'shelled',
              'cartilaginous', 'vertebrate', 'exoskeletal', 'gelatinous', 'filamentous'];
const SENS = ['chemoreception', 'photoreception', 'vision', 'compound eyes', 'echolocation',
              'electroreception', 'tactile bristles', 'thermal pits', 'magnetoreception'];
const next = <T>(arr: T[], v: T): T => arr[(arr.indexOf(v) + 1) % arr.length];
const flipNum = (v: number) => (v < 5 ? v + 5 : v - 5);

type Axis = { name: string; apply: (g: SpeciesGenome) => void };
const AXES: Axis[] = [
  { name: 'locomotion',    apply: g => { g.dna.locomotion  = next(LOCO, g.dna.locomotion) as any; } },
  { name: 'metabolism',    apply: g => { g.dna.metabolism  = next(META, g.dna.metabolism) as any; } },
  { name: 'size',          apply: g => { const i = SIZE.indexOf(g.physicalTraits.size); g.physicalTraits.size = SIZE[i >= 4 ? i - 1 : i + 1] as any; } },
  { name: 'environment',   apply: g => { g.dna.environment = next(ENV, g.dna.environment) as any; } },
  { name: 'bodyStructure', apply: g => { g.physicalTraits.bodyStructure = next(BODY, g.physicalTraits.bodyStructure); } },
  { name: 'sensorySystem', apply: g => { g.physicalTraits.sensorySystem = next(SENS, g.physicalTraits.sensorySystem); } },
  { name: 'diet',          apply: g => { g.dna.diet = next(DIET, g.dna.diet) as any; } },
  { name: 'aggression',    apply: g => { g.dna.aggression   = flipNum(g.dna.aggression); } },
  { name: 'intelligence',  apply: g => { g.dna.intelligence = flipNum(g.dna.intelligence); } },
];
const AXIS_GATE = 0.75;           // perceptible in >= 75% of perturbations
const PROVENANCE_GATE = 0.5;      // id-only change perceptible in <= half as many cases as genome
const DISTINCT_GATE = 0.90;       // >= 90% of co-existing pairs distinguishable

// ─── Run ──────────────────────────────────────────────────────────────────────

let failed = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(40)} ${detail}`);
  if (!ok) failed++;
}

clearCaches();
const worlds = evolveWorlds();
const all = worlds.flatMap(w => w.species.map(s => ({ s, phase: w.phase })));
console.log(`\n=== Species sprite identity (${CONTROL ? 'CONTROL: legacy baker' : 'current baker'}) ===`);
console.log(`  ${SEEDS} seeds, ${worlds.length} world snapshots, ${all.length} living species`);

// Census of what evolution actually produced — the space the baker must span.
const census = (f: (g: SpeciesGenome) => string) => {
  const m = new Map<string, number>(); for (const { s } of all) m.set(f(s), (m.get(f(s)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
};
console.log(`  locomotion  ${census(g => g.dna.locomotion)}`);
console.log(`  size        ${census(g => g.physicalTraits.size)}`);
console.log(`  body        ${census(g => g.physicalTraits.bodyStructure)}`);
console.log(`  environment ${census(g => g.dna.environment)}`);

// On-screen size distribution.
const sizes = all.map(({ s, phase }) => { const p = onScreen(s, phase); return Math.max(p.w, p.h); });
const hist = new Map<number, number>(); for (const v of sizes) hist.set(v, (hist.get(v) ?? 0) + 1);
console.log(`  on-screen long edge (px): ${[...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' ')}`);

// 1. Sensitivity.
console.log('\n  1. SENSITIVITY — one genome axis changed, id fixed');
const detailed = all.filter(({ s, phase }) => { const p = onScreen(s, phase); return Math.max(p.w, p.h) >= 5; });
const axisRates: number[] = [];
for (const ax of AXES) {
  let hit = 0, n = 0, shown = 0;
  // --verbose: hit rate per bucket (value transition for categorical axes,
  // locomotion@on-screen-px otherwise) and the first few misses.
  const by = new Map<string, [number, number]>();
  for (const { s, phase } of detailed) {
    const g2 = structuredClone(s); ax.apply(g2);
    if (JSON.stringify(g2) === JSON.stringify(s)) continue;
    // A perturbation that makes the genome incoherent (or coherent) would let
    // the anomaly glitch score the axis. Only same-coherence changes count.
    if (isCoherent(g2) !== isCoherent(s)) continue;
    n++;
    const a0 = onScreen(s, phase), b0 = onScreen(g2, phase);
    const ok = perceptible(a0, b0);
    if (ok) hit++;
    if (!VERBOSE) continue;
    if (!ok && shown++ < 4) {
      console.log(`        miss: ${s.dna.locomotion}/${s.physicalTraits.bodyStructure}/${s.physicalTraits.sensorySystem}/${s.dna.diet}` +
        ` a${s.dna.aggression} i${s.dna.intelligence} ${Math.max(a0.w, a0.h)}px diff=${diff(a0, b0)}` +
        ` need=${Math.max(2, 0.12 * Math.max(opaqueCount(a0), opaqueCount(b0))).toFixed(1)}`);
    }
    const k = ax.name === 'bodyStructure' ? `${s.physicalTraits.bodyStructure}>${g2.physicalTraits.bodyStructure}`
            : `${s.dna.locomotion}@${Math.max(a0.w, a0.h)}`;
    const e = by.get(k) ?? [0, 0]; e[0] += ok ? 1 : 0; e[1]++; by.set(k, e);
  }
  if (VERBOSE) console.log('        ' + [...by.entries()].sort().map(([k, [h, t]]) => `${k} ${h}/${t}`).join('  '));
  const rate = n ? hit / n : 0;
  axisRates.push(rate);
  check(`axis ${ax.name}`, rate >= AXIS_GATE, `${(rate * 100).toFixed(1)}% perceptible (${hit}/${n})`);
}
const genomeRate = axisRates.reduce((a, b) => a + b, 0) / axisRates.length;

// 2. Provenance.
console.log('\n  2. PROVENANCE — genome fixed, id changed');
let idHit = 0, idN = 0;
for (const { s, phase } of detailed) {
  for (let k = 0; k < 3; k++) {
    const g2 = structuredClone(s); g2.id = `${s.id}_twin${k}`;
    idN++;
    if (perceptible(onScreen(s, phase), onScreen(g2, phase))) idHit++;
  }
}
const idRate = idN ? idHit / idN : 0;
check('id-only variation < genome variation', idRate <= PROVENANCE_GATE * genomeRate,
  `id ${(idRate * 100).toFixed(1)}% vs genome mean ${(genomeRate * 100).toFixed(1)}% (gate: id <= ${(PROVENANCE_GATE * 100)}% of genome)`);

// 3. Distinguishability of co-existing species.
console.log('\n  3. DISTINGUISHABILITY — co-existing living species, pairwise');
let pairs = 0, distinct = 0, silh = 0, pal = 0, sz = 0;
const confusions: string[] = [];
for (const w of worlds) {
  const px = w.species.map(s => onScreen(s, w.phase));
  for (let i = 0; i < px.length; i++) for (let j = i + 1; j < px.length; j++) {
    pairs++;
    const a = px[i], b = px[j];
    const dSil = perceptible(a, b, 'mask');
    const ca = meanColor(a), cb = meanColor(b);
    const dPal = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]) > 40;
    const [aw, ah] = bbox(a), [bw, bh] = bbox(b);
    const dSz = Math.abs(aw - bw) >= 2 || Math.abs(ah - bh) >= 2;
    const any = perceptible(a, b, 'all') || dPal || dSz;
    if (dSil) silh++; if (dPal) pal++; if (dSz) sz++;
    if (any) distinct++;
    else if (confusions.length < 6) {
      const x = w.species[i], y = w.species[j];
      confusions.push(`seed ${w.seed} ${w.phase}: ${x.dna.locomotion}/${x.physicalTraits.size}/${x.physicalTraits.bodyStructure}/${x.dna.diet}` +
                      ` == ${y.dna.locomotion}/${y.physicalTraits.size}/${y.physicalTraits.bodyStructure}/${y.dna.diet}`);
    }
  }
}
const pct = (v: number) => `${(100 * v / Math.max(1, pairs)).toFixed(1)}%`;
console.log(`     ${pairs} pairs: silhouette differs ${pct(silh)}, palette differs ${pct(pal)}, size differs ${pct(sz)}`);
check('co-existing pairs distinguishable', distinct / Math.max(1, pairs) >= DISTINCT_GATE,
  `${pct(distinct)} (gate ${DISTINCT_GATE * 100}%)`);
for (const c of confusions) console.log(`        identical on screen: ${c}`);

// Readability at size — reported, not gated.
const colours = detailed.map(({ s, phase }) => distinctColors(onScreen(s, phase)));
console.log(`\n  colours per on-screen sprite (>=5px): median ${colours.sort((a, b) => a - b)[colours.length >> 1] ?? 0}`);

// ─── Contact sheet ────────────────────────────────────────────────────────────

if (SHEET) {
  const Z = 6, cell = 16, cols = 20;
  const shown = all.slice(0, 200);
  const rows = Math.ceil(shown.length / cols);
  const W = cols * cell * Z, H = rows * cell * Z;
  const img = new Uint8Array(W * H * 4);
  for (let i = 0; i < img.length; i += 4) { img[i] = 46; img[i + 1] = 58; img[i + 2] = 40; img[i + 3] = 255; }
  shown.forEach(({ s, phase }, k) => {
    const p = onScreen(s, phase);
    const ox = (k % cols) * cell + Math.floor((cell - p.w) / 2), oy = Math.floor(k / cols) * cell + (cell - 1 - p.h);
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
      const si = (y * p.w + x) * 4; const a = p.d[si + 3] / 255; if (a <= 0) continue;
      for (let zy = 0; zy < Z; zy++) for (let zx = 0; zx < Z; zx++) {
        const X = (ox + x) * Z + zx, Y = (oy + y) * Z + zy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const di = (Y * W + X) * 4;
        for (let c = 0; c < 3; c++) img[di + c] = img[di + c] * (1 - a) + p.d[si + c] * a;
      }
    }
  });
  writeFileSync(SHEET, encodePng(W, H, img));
  console.log(`  contact sheet: ${SHEET} (${shown.length} sprites, x${Z})`);
}

function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ─── Verdict ──────────────────────────────────────────────────────────────────

if (CONTROL) {
  console.log(failed > 0
    ? `\nCONTROL OK — the metric rejects the legacy baker (${failed} gate(s) failed).`
    : '\nCONTROL BROKEN — the legacy baker passed every gate; the metric measures nothing.');
  process.exit(failed > 0 ? 0 : 1);
}
console.log(failed ? `\n${failed} gate(s) FAILED` : '\nall gates passed');
process.exit(failed ? 1 : 0);
