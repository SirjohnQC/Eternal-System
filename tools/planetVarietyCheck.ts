/**
 * Are the worlds structurally DIFFERENT, or one blob shuffled?
 *
 * The old version of this check asserted `landmasses >= 40` and
 * `coastSpread >= 0.15` for every world. Those were not merely unsatisfiable,
 * they were wrong: they demanded archipelago-ness of every world, so passing
 * them would have swapped one monoculture for another.
 *
 * This version measures each archetype against the claim THAT archetype makes,
 * and then asserts the three are separable from each other and from the legacy
 * generator. Three modes:
 *
 *   --measure   print the signature table for legacy + every archetype and
 *               assert nothing. This is where the thresholds below came from.
 *   --control   run the three signature suites against TODAY'S generator and
 *               require every one of them to FAIL. If the legacy blob can pass
 *               the supercontinent signature, the signature is not measuring
 *               supercontinent-ness. Exit 0 means the instrument discriminates.
 *   (default)   run the signature suites against their own archetypes, plus the
 *               cross-archetype separation test.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/planetVarietyCheck.ts --bundle \
 *     --platform=node --format=esm --outfile=%TEMP%/variety.mjs \
 *     && node %TEMP%/variety.mjs
 */
const { generatePlanetGrid, isWater, GRID_SIZE } =
  await import('../src/simulation/PlanetGrid');

const MEASURE = process.argv.includes('--measure');
const CONTROL = process.argv.includes('--control');
const SEEDS   = 12;                 // a stochastic system needs a distribution
// 'ocean' is neutral: its cap is above the default, so null DNA leaves sea
// level unshifted. `--type=rocky` etc. measures a type whose cap moves it —
// the spec's open question about whether archetype and sea level stay
// orthogonal once TYPE_OCEAN_COVERAGE has clamped the DNA.
const TYPE = process.argv.find(a => a.startsWith('--type='))?.slice(7) ?? 'ocean';
const N       = GRID_SIZE;
const idx = (r: number, c: number) => r * N + c;

// ─── Measurement ─────────────────────────────────────────────────────────────

/** One world's shape, reduced to the numbers the archetypes make claims about. */
interface Signature {
  /** Fraction of the surface above sea level, weighted by real cell area. The
   *  grid is equirectangular, so counting cells would let the polar rows — a
   *  fifth of the grid, a sliver of the sphere — decide the answer. */
  land: number;
  /** Connected landmasses of at least 30 cells. Specks are noise, not islands. */
  masses: number;
  /** Share of all land held by the single biggest mass. */
  bigShare: number;
  /** Furthest any land cell is from water, in cells / GRID_SIZE. */
  dtw: number;
  /** Area-weighted share of land in the best hemisphere. 0.5 = spread evenly. */
  hemi: number;
  /** How far the coast wanders off the dividing plane, in sphere radii. A coast
   *  drawn with a ruler scores ~0; a ragged one scores high. NOT coastline
   *  length over land area: a clean hemisphere is the most COMPACT arrangement
   *  there is, so by that measure the old lake-riddled blob beats it. */
  coastWobble: number;
  /** Coast cells / sqrt(land cells). Diagnostic and a separation dimension. */
  coastIndex: number;
  /** Share of land classified mountain, snow or volcanic — the rock-and-ice
   *  fraction. Structure metrics cannot see this: a white mountain continent
   *  and a green plains continent have identical landmass counts, and the spike
   *  was caught rendering both a white world and a grey one by eye alone. */
  barren: number;
}

/** Share of land that reads as bare rock or ice rather than living ground. */
function barrenShare(grid: any): number {
  let land = 0, bare = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const b = grid[r][c].biome;
    if (isWater(b)) continue;
    land++;
    if (b === 'mountain' || b === 'snow' || b === 'volcanic') bare++;
  }
  return land > 0 ? bare / land : 0;
}

function waterMask(grid: any): Uint8Array {
  const w = new Uint8Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
    w[idx(r, c)] = isWater(grid[r][c].biome) ? 1 : 0;
  return w;
}

/** Flood fill over land, x wrapping. Returns mass count, biggest share, land. */
function floodLand(w: Uint8Array, minCells: number) {
  const seen = new Uint8Array(N * N);
  const stack: number[] = [];
  let count = 0, best = 0, total = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const i = idx(r, c);
    if (seen[i] || w[i]) continue;
    let size = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const jr = (j / N) | 0, jc = j % N;
      size++;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = jr + dr, nc = (jc + dc + N) % N;   // longitude wraps
        if (nr < 0 || nr >= N) continue;
        const k = idx(nr, nc);
        if (seen[k] || w[k]) continue;
        seen[k] = 1; stack.push(k);
      }
    }
    total += size;
    if (size > best) best = size;
    if (size >= minCells) count++;
  }
  return { count, share: total > 0 ? best / total : 0, land: total };
}

/**
 * Distance from the deepest inland cell to water, by multi-source BFS out of
 * every water cell. This is the discriminator that matters most: it is the one
 * property a centred blob cannot fake in either direction — an archipelago
 * promises no cell is far from water, a supercontinent promises some cell is.
 */
function maxDistToWater(w: Uint8Array): number {
  const dist = new Int32Array(N * N).fill(-1);
  let q: number[] = [];
  for (let i = 0; i < N * N; i++) if (w[i]) { dist[i] = 0; q.push(i); }
  if (q.length === 0) return N;                        // no water anywhere
  let far = 0;
  while (q.length) {
    const next: number[] = [];
    for (const j of q) {
      const jr = (j / N) | 0, jc = j % N;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = jr + dr, nc = (jc + dc + N) % N;
        if (nr < 0 || nr >= N) continue;
        const k = idx(nr, nc);
        if (dist[k] >= 0) continue;
        dist[k] = dist[j] + 1;
        if (dist[k] > far) far = dist[k];
        next.push(k);
      }
    }
    q = next;
  }
  return far;
}

function coastCells(w: Uint8Array): { coast: number; land: number } {
  let coast = 0, land = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (w[idx(r, c)]) continue;
    land++;
    if (onCoast(w, r, c)) coast++;
  }
  return { coast, land };
}

/** Share of the sphere's AREA above sea level. */
function landArea(w: Uint8Array): number {
  let land = 0, tot = 0;
  for (let r = 0; r < N; r++) {
    const a = Math.cos((0.5 - (r + 0.5) / N) * Math.PI);
    if (a <= 0) continue;
    for (let c = 0; c < N; c++) { tot += a; if (!w[idx(r, c)]) land += a; }
  }
  return tot > 0 ? land / tot : 0;
}

/** Is this land cell on the coast? Poles count as an edge. */
function onCoast(w: Uint8Array, r: number, c: number): boolean {
  const up = r > 0 ? w[idx(r - 1, c)] : 1;
  const dn = r < N - 1 ? w[idx(r + 1, c)] : 1;
  return !!(up || dn || w[idx(r, (c + 1) % N)] || w[idx(r, (c - 1 + N) % N)]);
}

/**
 * Where the land sits on the sphere, and how straight the coast is.
 *
 * `share` is the area-weighted fraction of land in the best hemisphere — the
 * grid is equirectangular, so a naive row count would weight the poles as
 * heavily as the equator and call every ice cap a hemisphere. The best axis is
 * the area-weighted mean direction of the land.
 *
 * `wobble` is the spread of the coast about the plane perpendicular to that
 * axis. A hemispheric world split with a ruler has every coast cell on the
 * plane and scores ~0; a raggedly divided one scores high.
 */
function hemisphereStats(w: Uint8Array): { share: number; wobble: number } {
  const pts: Array<[number, number, number, number, boolean]> = [];
  let mx = 0, my = 0, mz = 0, tot = 0;
  for (let r = 0; r < N; r++) {
    const lat = (0.5 - (r + 0.5) / N) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    if (cl <= 0) continue;
    for (let c = 0; c < N; c++) {
      if (w[idx(r, c)]) continue;
      const lon = ((c + 0.5) / N) * Math.PI * 2;
      const x = cl * Math.cos(lon), y = cl * Math.sin(lon), z = sl;
      pts.push([x, y, z, cl, onCoast(w, r, c)]);
      mx += x * cl; my += y * cl; mz += z * cl; tot += cl;
    }
  }
  if (tot === 0) return { share: 0, wobble: 0 };
  const len = Math.hypot(mx, my, mz);
  if (len === 0) return { share: 0.5, wobble: 0 };       // perfectly balanced
  const ax = mx / len, ay = my / len, az = mz / len;
  let half = 0, cw = 0, cm = 0, cv = 0;
  for (const [x, y, z, a, coast] of pts) {
    const d = x * ax + y * ay + z * az;
    if (d > 0) half += a;
    if (coast) { cw += a; cm += d * a; }
  }
  if (cw > 0) {
    const mu = cm / cw;
    for (const [x, y, z, a, coast] of pts) {
      if (!coast) continue;
      const d = x * ax + y * ay + z * az;
      cv += (d - mu) ** 2 * a;
    }
  }
  return { share: half / tot, wobble: cw > 0 ? Math.sqrt(cv / cw) : 0 };
}

function signature(grid: any): Signature {
  const w = waterMask(grid);
  const f = floodLand(w, 30);
  const { coast, land } = coastCells(w);
  const h = hemisphereStats(w);
  return {
    land: landArea(w),
    masses: f.count,
    bigShare: f.share,
    dtw: maxDistToWater(w) / N,
    hemi: h.share,
    coastWobble: h.wobble,
    coastIndex: land > 0 ? coast / Math.sqrt(land) : 0,
    barren: barrenShare(grid),
  };
}

function sweep(archetype: string | null): Signature[] {
  const out: Signature[] = [];
  for (let s = 0; s < SEEDS; s++)
    out.push(signature(generatePlanetGrid(TYPE, 1000 + s * 7919, null, archetype as any)));
  return out;
}

// ─── Assertions ──────────────────────────────────────────────────────────────

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]
                      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const PASS_RATE = 0.75;   // a distribution, not a lucky seed — but not a tyranny

interface Claim {
  name: string;
  get: (s: Signature) => number;
  ok: (v: number) => boolean;
  want: string;
}

/**
 * Every threshold below is the archetype's own promise, in numbers. Each suite
 * includes at least one dimension the legacy blob cannot satisfy — that is what
 * `--control` proves, and it is why the suites are written before the
 * generators are trusted.
 */
const CLAIMS: Record<string, Claim[]> = {
  // "Hundreds of islets in a sea; every settlement is coastal."
  archipelago: [
    { name: 'sea dominates',     get: s => s.land,     ok: v => v >= 0.08 && v <= 0.45, want: '0.08-0.45' },
    { name: 'many landmasses',   get: s => s.masses,   ok: v => v >= 10,   want: '>= 10' },
    { name: 'no dominant mass',  get: s => s.bigShare, ok: v => v <= 0.35, want: '<= 0.35' },
    { name: 'nowhere is inland', get: s => s.dtw,      ok: v => v <= 0.08, want: '<= 0.08' },
    { name: 'land is not bare rock', get: s => s.barren, ok: v => v <= 0.35, want: '<= 0.35' },
  ],
  // "One dominant mass running off the rim, with a genuine interior."
  supercontinent: [
    { name: 'land sits in an ocean', get: s => s.land,     ok: v => v >= 0.25 && v <= 0.60, want: '0.25-0.60' },
    { name: 'few landmasses',        get: s => s.masses,   ok: v => v <= 4,    want: '<= 4' },
    { name: 'one mass dominates',    get: s => s.bigShare, ok: v => v >= 0.70, want: '>= 0.70' },
    { name: 'the interior is deep',  get: s => s.dtw,      ok: v => v >= 0.12, want: '>= 0.12' },
    { name: 'land is not bare rock',  get: s => s.barren,  ok: v => v <= 0.35, want: '<= 0.35' },
  ],
  // "One half land, one half ocean, divided by one long ragged coast."
  hemispheric: [
    { name: 'about half is land',  get: s => s.land,       ok: v => v >= 0.28 && v <= 0.60, want: '0.28-0.60' },
    { name: 'land is one-sided',   get: s => s.hemi,        ok: v => v >= 0.85, want: '>= 0.85' },
    { name: 'the coast is ragged', get: s => s.coastWobble, ok: v => v >= 0.10, want: '>= 0.10' },
    { name: 'land is not bare rock', get: s => s.barren,    ok: v => v <= 0.35, want: '<= 0.35' },
  ],
};

let failed = 0;
function report(name: string, ok: boolean, detail: string): boolean {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!ok) failed++;
  return ok;
}

/** Runs one archetype's claims over a sweep. Returns true if every claim held. */
function runClaims(archetype: string, rows: Signature[], counts = true): boolean {
  let all = true;
  for (const c of CLAIMS[archetype]) {
    const v = rows.map(c.get);
    const med = median(v);
    const rate = v.filter(c.ok).length / v.length;
    const ok = c.ok(med) && rate >= PASS_RATE;
    const detail = `median ${med.toFixed(3)} ${c.want}, ${Math.round(rate * 100)}% of seeds`;
    if (counts) report(`${archetype}: ${c.name}`, ok, detail);
    else console.log(`    ${ok ? 'pass' : 'fail'}  ${archetype}: ${c.name} — ${detail}`);
    all = all && ok;
  }
  return all;
}

const VECTOR = (s: Signature) => [
  Math.log1p(s.masses), s.bigShare, s.dtw, s.hemi, s.coastWobble, s.coastIndex,
  s.land, s.barren,
];

// ─── Modes ───────────────────────────────────────────────────────────────────

if (MEASURE) {
  console.log(`\n  type='${TYPE}', ${SEEDS} grid seeds per config — medians\n`);
  console.log('  config           land    masses  bigShare  dtw     hemi    wobble  coastIdx  barren');
  for (const a of [null, 'supercontinent', 'archipelago', 'hemispheric']) {
    const rows = sweep(a);
    const m = (g: (s: Signature) => number) => median(rows.map(g)).toFixed(3).padEnd(7);
    console.log(`  ${(a ?? 'legacy').padEnd(15)} ${m(s => s.land)} ${m(s => s.masses)} ` +
                `${m(s => s.bigShare)}   ${m(s => s.dtw)} ${m(s => s.hemi)} ` +
                `${m(s => s.coastWobble)} ${m(s => s.coastIndex)}  ${m(s => s.barren)}`);
  }
  console.log('');
  process.exit(0);
}

if (CONTROL) {
  console.log('\n  CONTROL — the three signature suites, fed the LEGACY generator.');
  console.log('  Every suite must FAIL. A suite the old blob can pass is a suite');
  console.log('  that is not measuring what it claims to measure.\n');
  const legacy = sweep(null);
  for (const a of Object.keys(CLAIMS)) {
    const passed = runClaims(a, legacy, false);
    report(`legacy is rejected as ${a}`, !passed,
      passed ? 'the legacy blob SATISFIED this signature' : 'signature not satisfied');
  }
} else {
  console.log(`\n  ${SEEDS} '${TYPE}' worlds per archetype, distinct grid seeds\n`);
  const sweeps: Record<string, Signature[]> = {};
  for (const a of Object.keys(CLAIMS)) sweeps[a] = sweep(a);
  for (const a of Object.keys(CLAIMS)) runClaims(a, sweeps[a]);

  // Cross-archetype separation. "The worlds vary" is weaker than "these are
  // structurally different generators", and only the second was promised.
  // Legacy is a fourth cluster on purpose: an archetype whose worlds land
  // nearest the legacy centroid is still the old blob wearing a name.
  console.log('');
  const clusters: Record<string, Signature[]> = { legacy: sweep(null), ...sweeps };
  const names = Object.keys(clusters);
  const all = names.flatMap(n => clusters[n].map(VECTOR));
  const dims = all[0].length;
  const mean: number[] = [], sd: number[] = [];
  for (let d = 0; d < dims; d++) {
    const col = all.map(v => v[d]);
    const mu = col.reduce((a, b) => a + b, 0) / col.length;
    mean[d] = mu;
    sd[d] = Math.sqrt(col.reduce((a, b) => a + (b - mu) ** 2, 0) / col.length) || 1;
  }
  const z = (v: number[]) => v.map((x, d) => (x - mean[d]) / sd[d]);
  const centroid: Record<string, number[]> = {};
  for (const n of names) {
    const vs = clusters[n].map(s => z(VECTOR(s)));
    centroid[n] = Array.from({ length: dims }, (_, d) =>
      vs.reduce((a, v) => a + v[d], 0) / vs.length);
  }
  const nearest = (v: number[]) => names.reduce((best, n) => {
    const d = Math.hypot(...v.map((x, i) => x - centroid[n][i]));
    return d < best.d ? { n, d } : best;
  }, { n: '', d: Infinity }).n;

  for (const n of names.filter(x => x !== 'legacy')) {
    const hits = clusters[n].filter(s => nearest(z(VECTOR(s))) === n).length;
    report(`${n} worlds classify as ${n}`, hits / clusters[n].length >= 0.9,
      `${hits}/${clusters[n].length} nearest their own centroid`);
  }
}

console.log('');
process.exit(failed === 0 ? 0 : 1);
