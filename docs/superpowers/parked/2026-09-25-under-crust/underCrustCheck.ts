/**
 * Under-crust hero — does the keel have rock character, a rolled hero, light
 * that reaches the rock, and caverns with interiors?
 *
 * Spec: docs/superpowers/specs/2026-09-24-under-crust-hero-design.md
 *
 * Runs the REAL `paintCutawayCrust` at the real render size
 * (`habitableGeom(480, 320)`: rx 105, wall 40) through tools/lib/softCanvas.ts.
 *
 * CONTROL: `--control` runs every gate against a frozen copy of the pre-hero
 * crust painter (tools/lib/legacyCutawayEngine.ts) and exits 0 only if the
 * metric REJECTS it. The proportions gate is the exception by design — it is a
 * guard that the hero work did not move the silhouette, so both must pass it.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/underCrustCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=$TEMP/ucc.mjs && node $TEMP/ucc.mjs [--control] [--sheet=out.png] [--offset=1000] [--verbose]
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { installSoftCanvas, SoftCanvas } from './lib/softCanvas';

installSoftCanvas();

const args = process.argv.slice(2);
const CONTROL = args.includes('--control');
const SHEET = args.find(a => a.startsWith('--sheet='))?.split('=')[1];
const VERBOSE = args.includes('--verbose');
const OFFSET = Number(args.find(a => a.startsWith('--offset='))?.split('=')[1] ?? 1000);
let shownBlocks = 0;

const cur = await import('../src/rendering/HabitableCutawayEngine') as any;
const legacy = await import('./lib/legacyCutawayEngine') as any;
let under: any = null;
try { under = await import('../src/rendering/UnderCrust'); } catch { /* not built yet */ }

const VW = 480, VH = 320;
const geom = cur.habitableGeom(VW, VH);
const TYPES = ['rocky', 'ocean', 'lava', 'ice', 'desert', 'toxic', 'crystal', 'storm'];

/** Legacy emitters are its ember specks: exactly `emberHot` per type. */
const LEGACY_EMBER: Record<string, [number, number, number]> = {
  ocean: [255, 184, 74], rocky: [255, 176, 70], ice: [220, 240, 255], lava: [255, 210, 90],
  toxic: [230, 255, 90], crystal: [255, 180, 255], desert: [255, 200, 100], storm: [180, 140, 220],
  carbon: [100, 160, 220],
};

interface Paint {
  cv: SoftCanvas;
  emit: Uint8Array;                 // 1 = emitter pixel
  heroes: string[];
  caverns: Array<{ cx: number; cy: number; rx: number; ry: number }>;
}

function paint(genomeSeed: number, type: string, painter: 'current' | 'legacy', force?: string[]): Paint {
  const cv = new SoftCanvas(); cv.width = VW; cv.height = VH;
  const debug: any = {};
  const opts: any = {
    w: VW, h: VH, cx: geom.cx, cyTop: geom.cyTop, rx: geom.rx, ry: geom.ry, R: geom.R,
    wall: geom.wall, cyBody: geom.cyBody, seed: (genomeSeed * 7777) >>> 0, grid: null, planetType: type,
    discToGrid: () => null, rimFalloff: () => 0, liftOf: () => 0, smoothElevation: () => 0, maxLift: 0,
    decalSeed: genomeSeed, genomeSeed, underCrustDebug: debug, underCrustForce: force,
  };
  (painter === 'current' ? cur : legacy).paintCutawayCrust(cv.getContext(), opts);
  let emit: Uint8Array;
  if (debug.emitters instanceof Uint8Array) emit = debug.emitters;
  else {
    emit = new Uint8Array(VW * VH);
    const e = LEGACY_EMBER[type];
    for (let i = 0; i < VW * VH; i++) {
      const d = cv.data;
      if (d[i * 4 + 3] && d[i * 4] === e[0] && d[i * 4 + 1] === e[1] && d[i * 4 + 2] === e[2]) emit[i] = 1;
    }
  }
  return { cv, emit, heroes: debug.roll?.heroes ?? [], caverns: debug.caverns ?? [] };
}

/** Keel pixels: below the wall bottom band — approximated as opaque pixels
 *  below `cyTop + ry + wall * 0.6`, which excludes the fluid wall face. */
const KEEL_Y0 = Math.round(geom.cyTop + geom.ry + geom.wall * 0.6);   // block-scan start only
/**
 * Keel = opaque pixels below the front wall, per column. The wall bottom is
 * frontY + wall + ridge with |ridge| <= 2.5, so +3 clears it on every column.
 * (Corrected 2026-09-25: a single cut row at KEEL_Y0 let 16 rows of the wall's
 * continuous water gradient into the ramp and dither gates on both painters.)
 */
const KEEL_TOP = new Float32Array(VW);
for (let x = 0; x < VW; x++) {
  const fx = (x - geom.cx) / geom.rx;
  KEEL_TOP[x] = Math.abs(fx) >= 1 ? 1e9 : geom.cyTop + Math.sqrt(1 - fx * fx) * geom.ry + geom.wall + 3;
}
const lum = (d: Uint8ClampedArray, i: number) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
const isKeel = (p: Paint, i: number) => Math.floor(i / VW) >= KEEL_TOP[i % VW] && p.cv.data[i * 4 + 3] === 255;
const key = (d: Uint8ClampedArray, i: number) => (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2];

function hueOf(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return 0;
  const d = mx - mn;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

let failed = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
  if (!ok) failed++;
}

const painter = CONTROL ? 'legacy' : 'current';
console.log(`\n=== Under-crust hero (${CONTROL ? 'CONTROL: legacy painter' : 'current painter'}) — ${VW}x${VH}, rx ${geom.rx}, wall ${geom.wall} ===`);

// ─── 1. Roll distribution ─────────────────────────────────────────────────────
{
  const N = 4000;
  let none = 0, one = 0, two = 0;
  const per: Record<string, number> = { coreLit: 0, geode: 0, circulatory: 0 };
  for (let i = 0; i < N; i++) {
    const heroes: string[] = !CONTROL && under ? under.rollUnderCrust(hashSeed(i)).heroes : [];
    if (heroes.length === 0) none++; else if (heroes.length === 1) one++; else two++;
    for (const h of heroes) per[h] = (per[h] ?? 0) + 1;
  }
  const appear = per.coreLit + per.geode + per.circulatory;
  const share = (v: number) => (appear ? v / appear : 0);
  const ok = Math.abs(none / N - 0.15) <= 0.03 && Math.abs(one / N - 0.70) <= 0.04 && Math.abs(two / N - 0.15) <= 0.03
          && ['coreLit', 'geode', 'circulatory'].every(h => Math.abs(share(per[h]) - 1 / 3) <= 0.05);
  check('roll 15/70/15, heroes ~1/3 each', ok,
    `none ${(100 * none / N).toFixed(1)}% one ${(100 * one / N).toFixed(1)}% two ${(100 * two / N).toFixed(1)}%` +
    ` | core ${(100 * share(per.coreLit)).toFixed(0)}% geode ${(100 * share(per.geode)).toFixed(0)}% circ ${(100 * share(per.circulatory)).toFixed(0)}%`);
}

function hashSeed(i: number): number {
  let h = Math.imul(i + 1, 2654435761) ^ 0x5bd1e995; h = Math.imul(h ^ (h >>> 15), 2246822507);
  return (h ^ (h >>> 13)) >>> 0;
}

// ─── Render the world set ─────────────────────────────────────────────────────
const WORLDS = 48;
const worlds: Array<{ seed: number; type: string; p: Paint }> = [];
for (let i = 0; i < WORLDS; i++) {
  const seed = hashSeed(OFFSET + i), type = TYPES[i % TYPES.length];
  worlds.push({ seed, type, p: paint(seed, type, painter) });
}
const heroWorlds = worlds.filter(w => w.p.heroes.length > 0);
const plainWorlds = worlds.filter(w => w.p.heroes.length === 0);
console.log(`  ${WORLDS} worlds rendered: ${heroWorlds.length} with a hero, ${plainWorlds.length} without`);

// ─── 2. Hero presence ─────────────────────────────────────────────────────────
{
  const emitShare = (p: Paint) => {
    let k = 0, e = 0; for (let i = 0; i < VW * VH; i++) if (isKeel(p, i)) { k++; if (p.emit[i]) e++; }
    return k ? e / k : 0;
  };
  const withEmit = heroWorlds.filter(w => emitShare(w.p) >= 0.01).length;
  const plainMax = Math.max(0, ...plainWorlds.map(w => emitShare(w.p)));
  check('hero worlds hold emitters', heroWorlds.length > 0 && withEmit / heroWorlds.length >= 0.9,
    `${withEmit}/${heroWorlds.length} hero worlds >= 1% emissive keel; plain max ${(100 * plainMax).toFixed(2)}%`);
}

// ─── 3. Ramp: palette-locked rock ─────────────────────────────────────────────
{
  let pass = 0; const cover: number[] = [];
  for (const w of plainWorlds) {
    const counts = new Map<number, number>(); let n = 0;
    for (let i = 0; i < VW * VH; i++) if (isKeel(w.p, i) && !w.p.emit[i]) { const k = key(w.p.cv.data, i); counts.set(k, (counts.get(k) ?? 0) + 1); n++; }
    const top = [...counts.values()].sort((a, b) => b - a).slice(0, 6 * 6).reduce((a, b) => a + b, 0);
    const c = n ? top / n : 0; cover.push(c); if (c >= 0.9) pass++;
  }
  cover.sort((a, b) => a - b);
  check('rock is a 6-step ramp', plainWorlds.length > 0 && pass === plainWorlds.length,
    `top-36 colours (6 steps x 6 strata bands) cover median ${(100 * (cover[cover.length >> 1] ?? 0)).toFixed(1)}% of keel rock (gate 90% on every plain world)`);
}

// ─── 4. Ordered dither ────────────────────────────────────────────────────────
/**
 * Is a two-colour 4x4 block ORDERED dither? Rank test: the probability that a
 * pixel of one colour has a higher Bayer threshold than a pixel of the other
 * (AUC) must be >= 0.9 in one direction. A flat level gives a clean threshold
 * set (AUC 1); a light gradient across the block bends it slightly (still
 * high); random dither sits near 0.5. (Corrected 2026-09-25: the first version
 * demanded a clean threshold set and so rejected ordered dither under exactly
 * the light gradients the spec asks for.)
 */
function orderedBlock(a: number[], b: number[]): boolean {
  let gt = 0;
  for (const u of a) for (const v of b) gt += u > v ? 1 : u === v ? 0.5 : 0;
  const auc = gt / (a.length * b.length);
  return auc >= 0.9 || auc <= 0.1;
}
{
  // Synthetic controls, first: the block test must pass Bayer-dithered
  // gradients and reject random-dithered ones, or it measures nothing.
  const Bm = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  let rs = 7; const rnd = () => ((rs = (Math.imul(rs, 1103515245) + 12345) >>> 0) / 4294967296);
  let bayerPass = 0, randPass = 0, trials = 0;
  for (let t = 0; t < 400; t++) {
    const base = 0.2 + rnd() * 0.6, slope = (rnd() - 0.5) * 0.12;   // level varies across the block
    const A1: number[] = [], B1: number[] = [], A2: number[] = [], B2: number[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const lv = base + slope * (x + y), th = Bm[y * 4 + x];
      ((lv + (th + 0.5) / 16 >= 1) ? B1 : A1).push(th);
      ((lv + rnd() >= 1) ? B2 : A2).push(th);
    }
    if (!A1.length || !B1.length || !A2.length || !B2.length) continue;
    trials++;
    if (orderedBlock(A1, B1)) bayerPass++;
    if (orderedBlock(A2, B2)) randPass++;
  }
  const okCtl = bayerPass / trials >= 0.9 && randPass / trials <= 0.2;
  check('dither test: synthetic controls', okCtl,
    `Bayer gradients pass ${(100 * bayerPass / trials).toFixed(0)}% (need >=90), random dither passes ${(100 * randPass / trials).toFixed(0)}% (need <=20)`);

  const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  let two = 0, full = 0, bayerOk = 0;
  for (const w of worlds) {
    const d = w.p.cv.data;
    for (let by = KEEL_Y0 - (KEEL_Y0 & 3) + 4; by + 4 <= VH; by += 4) for (let bx = 0; bx + 4 <= VW; bx += 4) {
      const cols = new Map<number, number[]>(); let okBlock = true;
      for (let y = 0; y < 4 && okBlock; y++) for (let x = 0; x < 4; x++) {
        const i = (by + y) * VW + bx + x;
        if (!isKeel(w.p, i) || w.p.emit[i]) { okBlock = false; break; }
        const k = key(d, i); if (!cols.has(k)) cols.set(k, []); cols.get(k)!.push(B[((by + y) & 3) * 4 + ((bx + x) & 3)]);
      }
      if (!okBlock) continue;
      full++;
      if (cols.size !== 2) continue;
      two++;
      const [a, b] = [...cols.values()];
      if (orderedBlock(a, b)) bayerOk++;
      else if (VERBOSE && shownBlocks++ < 6) {
        // Print the block as a 4x4 of A/B so the failure mode is visible.
        const ks = [...cols.keys()]; let rows = '';
        for (let y = 0; y < 4; y++) { for (let x = 0; x < 4; x++) rows += key(d, (by + y) * VW + bx + x) === ks[0] ? 'A' : 'B'; rows += ' '; }
        console.log(`        non-Bayer block @${bx},${by} ${w.type}/${w.p.heroes.join('+') || 'none'}: ${rows}`);
      }
    }
  }
  const share = full ? two / full : 0, cons = two ? bayerOk / two : 0;
  check('ordered (Bayer) dithering', share >= 0.10 && cons >= 0.70,
    `${(100 * share).toFixed(1)}% of full keel blocks are two-step; ${(100 * cons).toFixed(1)}% of those are Bayer threshold sets`);
}

// ─── 5. Emission lights the rock ──────────────────────────────────────────────
{
  let pass = 0, n = 0, unmeasured = 0; const ratios: number[] = [], areas: number[] = [];
  // Hero worlds, and on the control every world (its embers are its emitters).
  for (const w of (heroWorlds.length ? heroWorlds : worlds)) {
    const p = w.p, d = p.cv.data;
    const ems: number[] = []; for (let i = 0; i < VW * VH; i++) if (p.emit[i] && isKeel(p, i)) ems.push(i);
    if (ems.length < 3) continue;
    n++;
    // Distance to the nearest emitter (chamfer, capped at 40).
    const dist = new Float32Array(VW * VH).fill(60);
    for (const i of ems) dist[i] = 0;
    for (let pass2 = 0; pass2 < 2; pass2++) {
      const fwd = pass2 === 0;
      for (let yy = 0; yy < VH; yy++) { const y = fwd ? yy : VH - 1 - yy;
        for (let xx = 0; xx < VW; xx++) { const x = fwd ? xx : VW - 1 - xx; const i = y * VW + x;
          const s = fwd ? -1 : 1;
          if (x + s >= 0 && x + s < VW) dist[i] = Math.min(dist[i], dist[i + s] + 1);
          if (y + s >= 0 && y + s < VH) dist[i] = Math.min(dist[i], dist[i + s * VW] + 1);
          if (x + s >= 0 && x + s < VW && y + s >= 0 && y + s < VH) dist[i] = Math.min(dist[i], dist[i + s * VW + s] + 1.414);
        } }
    }
    // Cavern interiors are voids whose back wall must be dark (gate 6); they
    // are not "surrounding rock". Mask them out of the halo profile.
    const voidPx = new Uint8Array(VW * VH);
    for (const c of p.caverns) for (let y = Math.floor(c.cy - c.ry); y <= c.cy + c.ry; y++) for (let x = Math.floor(c.cx - c.rx); x <= c.cx + c.rx; x++) {
      if (x < 0 || y < 0 || x >= VW || y >= VH) continue;
      if (((x + 0.5 - c.cx) / c.rx) ** 2 + ((y + 0.5 - c.cy) / c.ry) ** 2 <= 1) voidPx[y * VW + x] = 1;
    }
    const rock = (i: number) => isKeel(p, i) && !p.emit[i] && !voidPx[i];
    // Row-matched baseline: strata band on absolute Y, so compare within rows.
    const farRow = new Float64Array(VH), farN = new Float64Array(VH);
    for (let i = 0; i < VW * VH; i++) if (rock(i) && dist[i] >= 32) { const y = Math.floor(i / VW); farRow[y] += lum(d, i); farN[y]++; }
    // A wide halo can light every pixel of its rows, leaving no far baseline
    // there. Borrow the nearest row that has one (strata change slowly by row).
    // (Corrected 2026-09-25: those rows were skipped, so the widest halos
    // measured as haloR 0 / ratio 1.00 — unmeasured, not unlit.)
    {
      const has = (y: number) => farN[y] >= 8;
      const src = new Int32Array(VH).fill(-1);
      for (let y = 0; y < VH; y++) {
        if (has(y)) { src[y] = y; continue; }
        for (let k = 1; k < VH; k++) {
          if (y - k >= 0 && has(y - k)) { src[y] = y - k; break; }
          if (y + k < VH && has(y + k)) { src[y] = y + k; break; }
        }
      }
      const fr = farRow.slice(), fn = farN.slice();
      for (let y = 0; y < VH; y++) if (src[y] >= 0 && src[y] !== y) { farRow[y] = fr[src[y]] / fn[src[y]] * 8; farN[y] = 8; }
    }
    if (!farN.some(v => v >= 8)) { unmeasured++; n--; continue; }
    // Halo = radial luminance profile. Mean (lum / row-matched far lum) per
    // 1 px distance shell; the halo radius is the last CONTIGUOUS shell from
    // the emitter that stays >= 1.15. Area = rock pixels inside that radius,
    // over emitter pixels. (Corrected 2026-09-25: counting single pixels above
    // 1.2x their row mean counted dither — 30% of far-field rock cleared it —
    // and scored the legacy embers 9.3.)
    const shellSum = new Float64Array(31), shellN = new Float64Array(31);
    let nearSum = 0, baseSum = 0, cnt = 0;
    for (let i = 0; i < VW * VH; i++) {
      if (!rock(i) || dist[i] > 30) continue;
      const y = Math.floor(i / VW); if (farN[y] < 8) continue;
      const base = farRow[y] / farN[y];
      if (dist[i] >= 2 && dist[i] <= 6) { nearSum += lum(d, i); baseSum += base; cnt++; }
      const sh = Math.floor(dist[i]); shellSum[sh] += lum(d, i) / Math.max(1, base); shellN[sh]++;
    }
    let haloR = 0;
    // From shell 2: shell 1 is the emitter's own rim (a vessel wall, a crystal
    // root), not rock. Same 2 px start as the near ring.
    for (let r = 2; r <= 30; r++) { if (shellN[r] < 4 || shellSum[r] / shellN[r] < 1.15) break; haloR = r; }
    let inHalo = 0;
    for (let i = 0; i < VW * VH; i++) if (rock(i) && dist[i] < haloR + 1 && dist[i] > 0) inHalo++;
    const ratio = cnt ? nearSum / baseSum : 1, area = inHalo / ems.length;
    ratios.push(ratio); areas.push(area);
    if (VERBOSE) console.log(`        halo ${w.type}/${w.p.heroes.join('+')}: emitters ${ems.length} ratio ${ratio.toFixed(2)} haloR ${haloR} area ${area.toFixed(1)}`);
    // A compact emitter (the core lens) cannot have 6x its own area of keel
    // around it in a ~90 px keel, so size-relative radius also counts: the
    // halo must reach 1.5x the emitter's equivalent radius sqrt(A/pi).
    // (Corrected 2026-09-25: cores with 20-30 px halos were failing on area.)
    const rEq = Math.sqrt(ems.length / Math.PI);
    if (ratio >= 1.25 && (area >= 6 || haloR >= 1.5 * rEq)) pass++;
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] ?? 0; };
  check('emission lights surrounding rock', n > 0 && pass / n >= 0.9,
    `${pass}/${n} worlds (${unmeasured} unmeasurable); near/row-matched far luminance median ${med(ratios).toFixed(2)} (gate 1.25), halo (contiguous shells >= 1.15x) area / emitter area median ${med(areas).toFixed(1)} (gate 6, or halo radius >= 1.5x emitter radius)`);
}

// ─── 6. Caverns with interiors ────────────────────────────────────────────────
{
  const geodes = heroWorlds.filter(w => w.p.heroes.includes('geode'));
  let cav = 0, good = 0; const cavWhy = { colours: 0, dark: 0, rim: 0 };
  for (const w of geodes) {
    const d = w.p.cv.data;
    for (const c of w.p.caverns) {
      cav++;
      const colours = new Set<number>(); let top = 0, topN = 0, bot = 0, botN = 0, rim = 0;
      for (let y = Math.floor(c.cy - c.ry); y <= c.cy + c.ry; y++) for (let x = Math.floor(c.cx - c.rx); x <= c.cx + c.rx; x++) {
        const e = ((x + 0.5 - c.cx) / c.rx) ** 2 + ((y + 0.5 - c.cy) / c.ry) ** 2;
        const i = y * VW + x; if (x < 0 || y < 0 || x >= VW || y >= VH) continue;
        if (e <= 1) {
          colours.add(key(d, i));
          if (y < c.cy - c.ry * 0.3 && !w.p.emit[i]) { top += lum(d, i); topN++; }
          if (y > c.cy + c.ry * 0.3 && !w.p.emit[i]) { bot += lum(d, i); botN++; }
        }
        if (e > 0.45 && e <= 1.3 && w.p.emit[i]) rim++;
      }
      const okC = colours.size >= 3, okD = topN > 0 && botN > 0 && top / topN < bot / botN, okR = rim >= 2;
      if (okC && okD && okR) good++; else { if (!okC) cavWhy.colours++; if (!okD) cavWhy.dark++; if (!okR) cavWhy.rim++; }
    }
  }
  check('geode caverns have interiors', cav > 0 && good / cav >= 0.9,
    `${good}/${cav} caverns: >=3 colours, back wall darker than floor, crystals on the rim` +
    (good < cav ? ` (misses: colours ${cavWhy.colours}, dark ${cavWhy.dark}, rim ${cavWhy.rim})` : ''));
}

// ─── 7. Hue from the genome ───────────────────────────────────────────────────
{
  const hues: Record<string, number[]> = { coreLit: [], geode: [], circulatory: [] };
  for (const w of heroWorlds) {
    if (w.p.heroes.length !== 1) continue;
    let sx = 0, sy = 0, n = 0; const d = w.p.cv.data;
    for (let i = 0; i < VW * VH; i++) if (w.p.emit[i]) {
      const h = hueOf(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) * Math.PI / 180; sx += Math.cos(h); sy += Math.sin(h); n++;
    }
    if (n) hues[w.p.heroes[0]].push((Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360);
  }
  const span = (a: number[]) => {             // smallest arc covering all hues
    if (a.length < 2) return 0; const s = [...a].sort((x, y) => x - y);
    let gap = 360 - (s[s.length - 1] - s[0]); for (let i = 1; i < s.length; i++) gap = Math.max(gap, s[i] - s[i - 1]);
    return 360 - gap;
  };
  const spans = Object.entries(hues).map(([k, v]) => `${k} ${span(v).toFixed(0)}deg/${v.length}`);
  // Family-relative (corrected 2026-09-25): the spec gives coreLit a 40 deg
  // family (8-48), so a flat 60 deg span could never pass. Each hero must
  // cover min(60, 60% of its family's extent).
  const FAMILY_EXTENT: Record<string, number> = { coreLit: 40, geode: 275, circulatory: 275 };
  const okSpan = Object.values(hues).filter(v => v.length >= 2).length >= 2 &&
                 Object.entries(hues).every(([h, v]) => v.length < 2 || span(v) >= Math.min(60, 0.6 * FAMILY_EXTENT[h]));
  const a = paint(worlds[0].seed, worlds[0].type, painter), b = paint(worlds[0].seed, worlds[0].type, painter);
  const same = Buffer.compare(Buffer.from(a.cv.data), Buffer.from(b.cv.data)) === 0;
  check('hue varies with genome, deterministic', okSpan && same, `${spans.join(', ')}; repeat-identical ${same}`);
}

// ─── 8. Proportions unchanged ─────────────────────────────────────────────────
{
  let diffPx = 0;
  for (const w of worlds.slice(0, 16)) {
    const l = paint(w.seed, w.type, 'legacy');
    for (let i = 0; i < VW * VH; i++) if ((l.cv.data[i * 4 + 3] > 0) !== (w.p.cv.data[i * 4 + 3] > 0)) diffPx++;
  }
  check('silhouette and wall unchanged', diffPx === 0, `${diffPx} alpha-mask pixels differ from the legacy painter over 16 worlds`);
}

// ─── Contact sheet (keel crops, x2) ───────────────────────────────────────────
if (SHEET) {
  const Z = 2, cw = geom.rx * 2 + 8, ch = VH - (geom.cyTop - 4), cols = 4;
  const shown = worlds.slice(0, 16);
  const W = cols * cw * Z, H = Math.ceil(shown.length / cols) * ch * Z;
  const img = new Uint8Array(W * H * 4);
  for (let i = 0; i < img.length; i += 4) { img[i] = 8; img[i + 1] = 8; img[i + 2] = 20; img[i + 3] = 255; }
  shown.forEach((w, k) => {
    const ox = (k % cols) * cw, oy = Math.floor(k / cols) * ch;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const sx = geom.cx - geom.rx - 4 + x, sy = geom.cyTop - 4 + y; if (sx < 0 || sy >= VH) continue;
      const si = (sy * VW + sx) * 4; const a = w.p.cv.data[si + 3] / 255; if (!a) continue;
      for (let zy = 0; zy < Z; zy++) for (let zx = 0; zx < Z; zx++) {
        const di = (((oy + y) * Z + zy) * W + (ox + x) * Z + zx) * 4;
        for (let c = 0; c < 3; c++) img[di + c] = img[di + c] * (1 - a) + w.p.cv.data[si + c] * a;
      }
    }
  });
  writeFileSync(SHEET, encodePng(W, H, img));
  console.log(`  sheet: ${SHEET} — ${shown.map(w => `${w.type}:${w.p.heroes.join('+') || 'none'}`).join(' ')}`);
}

function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const T = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ─── Verdict ──────────────────────────────────────────────────────────────────
if (CONTROL) {
  // Proportions is a guard both painters must pass; every other gate must fail.
  const expected = 7;
  console.log(failed >= expected
    ? `\nCONTROL OK — the metric rejects the legacy painter on ${failed} gate(s).`
    : `\nCONTROL BROKEN — only ${failed} gate(s) failed on the legacy painter (expected ${expected}).`);
  process.exit(failed >= expected ? 0 : 1);
}
console.log(failed ? `\n${failed} gate(s) FAILED` : '\nall gates passed');
process.exit(failed ? 1 : 0);
