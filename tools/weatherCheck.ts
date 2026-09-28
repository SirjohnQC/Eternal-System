/**
 * Does the weather read the world?
 *
 * Every claim has a control that must FAIL: an ablation (the same sim with the
 * term under test switched off) or a stand-in for today's behaviour. A metric
 * that cannot fail on its control is measuring something else.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/weatherCheck.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/wx.mjs" --log-level=error && node --expose-gc "$TEMP/wx.mjs" [--quick]
 */
import { generatePlanetGrid, GRID_SIZE, type PlanetGrid } from '../src/simulation/PlanetGrid';
import {
  WX_NX, WX_NY, WX_N, buildClimate, personalityFor, type ClimateInput,
} from '../src/rendering/weather/WeatherClimate';
import { SEA_LEVEL } from '../src/simulation/PlanetGrid';
import type { ClimateSources } from '../src/rendering/weather/WeatherClimate';
import {
  WeatherSim, WX_DT, WX_WARMUP, WK, kindAt, latOf, fieldIndex, type SimAblation,
} from '../src/rendering/weather/WeatherSim';
import {
  WeatherPainter, buildWeatherLut, type WeatherLut,
} from '../src/rendering/weather/WeatherPainter';

const QUICK = process.argv.includes('--quick');
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
  if (!ok) failed++;
}
const SEEDS = QUICK ? [1, 7, 42] : [1, 7, 42, 99, 123, 256, 511, 777, 1001, 2024, 4242, 9001];

function input(grid: PlanetGrid, planetType: string, seed: number, over: Partial<ClimateInput> = {}): ClimateInput {
  return {
    grid, planetType, seed, lush: 0.5, extinctionPressure: 0.1, oxygenLevel: 0.6,
    civLevel: 0, inNebula: false, ...over,
  };
}
const mean = (f: Float32Array) => f.reduce((a, b) => a + b, 0) / f.length;

// ─── 1. Climate sources ────────────────────────────────────────────────────────
console.log('\n  CLIMATE');
{
  const g = generatePlanetGrid('ocean', 7 * 7777, null, null);
  const ocean = buildClimate(input(g, 'ocean', 7));
  const ice = buildClimate(input(g, 'ice', 7));
  const lava = buildClimate(input(generatePlanetGrid('lava', 7 * 7777, null, null), 'lava', 7));
  const desert = buildClimate(input(generatePlanetGrid('desert', 7 * 7777, null, null), 'desert', 7));
  check('ice is colder than ocean', mean(ice.temp) < mean(ocean.temp) - 0.15,
    `ice ${mean(ice.temp).toFixed(2)} ocean ${mean(ocean.temp).toFixed(2)}`);
  check('desert is hotter than ocean', mean(desert.temp) > mean(ocean.temp) + 0.1,
    `desert ${mean(desert.temp).toFixed(2)}`);
  check('magma does not evaporate water', mean(lava.water) === 0, `lava water ${mean(lava.water).toFixed(3)}`);
  check('ocean world has evaporating water', mean(ocean.water) > 0.05, `${mean(ocean.water).toFixed(3)}`);
  const ventCells = lava.ashEmit.filter(v => v > 0).length / WX_N;
  check('lava ash comes from vents, not a floor', ventCells > 0.01 && ventCells < 0.15,
    `${(ventCells * 100).toFixed(1)}% of cells emit`);
  check('no ash on an ocean world', mean(ocean.ashEmit) === 0, `${mean(ocean.ashEmit)}`);
  check('no smog below civ 4', mean(ocean.smogEmit) === 0, `${mean(ocean.smogEmit)}`);
  const a = personalityFor(1), b = personalityFor(2), a2 = personalityFor(1);
  check('personality is deterministic', JSON.stringify(a) === JSON.stringify(a2), '');
  check('personality differs by seed', JSON.stringify(a) !== JSON.stringify(b), '');
  // Review focus 4: pre-life world, nothing known.
  const bare = buildClimate(input(g, 'rocky', 3, { lush: 0, extinctionPressure: 0, oxygenLevel: 0, civLevel: 0 }));
  const finite = [bare.water, bare.temp, bare.elev, bare.landMoist, bare.ashEmit, bare.smogEmit]
    .every(f => f.every(Number.isFinite));
  check('pre-life world builds, all finite', finite && Number.isFinite(bare.stormPressure), '');
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function run(c: ClimateSources, steps: number, ablate: SimAblation = {}): WeatherSim {
  const s = new WeatherSim(c, ablate);
  s.warmUp(WX_WARMUP);
  for (let n = 0; n < steps; n++) s.step(WX_DT);
  return s;
}
/** Mean precip per cell over `steps`, after warm-up. */
function precipMean(c: ClimateSources, steps: number, ablate: SimAblation = {}): Float32Array {
  const s = new WeatherSim(c, ablate);
  s.warmUp(WX_WARMUP);
  const acc = new Float32Array(WX_N);
  for (let n = 0; n < steps; n++) { s.step(WX_DT); for (let k = 0; k < WX_N; k++) acc[k] += s.precip[k]; }
  for (let k = 0; k < WX_N; k++) acc[k] /= steps;
  return acc;
}
/** Synthetic world: ocean west of i=20, land east, optional ridge at i=34-35. */
function synthGrid(ridge: boolean): PlanetGrid {
  const g: any[] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    const row: any[] = [];
    const lat = (0.5 - (r + 0.5) / GRID_SIZE) * 180;
    for (let c = 0; c < GRID_SIZE; c++) {
      const i = Math.floor(c / 4);
      const sea = i < 20;
      const onRidge = ridge && (i === 34 || i === 35);
      row.push({
        elevation: sea ? 0.30 : onRidge ? 0.95 : 0.55,
        moisture: 0.5, temperature: Math.max(0, 1 - Math.abs(lat) / 90 * 0.95),
        biome: sea ? 'ocean' : onRidge ? 'mountain' : 'plains',
        fertility: 0.5, lifeDensity: 0, dominantSpeciesId: null, civId: null,
      });
    }
    g.push(row);
  }
  return g as PlanetGrid;
}
const westerlyRows = [...Array(WX_NY).keys()].filter(j => {
  const a = Math.abs(latOf(j)) * 180 / Math.PI; return a > 33 && a < 57;
});
/** Share of the two sides' rain that falls in the lee, 0-1; NaN when neither side rains. */
function leeShare(p: Float32Array): number {
  let up = 0, down = 0;
  for (const j of westerlyRows) for (let i = 28; i <= 33; i++) up += p[j * WX_NX + i];
  for (const j of westerlyRows) for (let i = 36; i <= 41; i++) down += p[j * WX_NX + i];
  return up + down > 1e-3 ? down / (up + down) : NaN;
}
/** The null model: climate masks x scrolling noise. No physics. */
function nullPrecip(c: ClimateSources): Float32Array {
  const p = new Float32Array(WX_N);
  for (let k = 0; k < WX_N; k++) {
    const cloud = (c.water[k] * (0.3 + 0.7 * c.temp[k]) + 0.4 * c.landMoist[k]) * 1.2;
    p[k] = Math.max(0, cloud - 0.45);
  }
  return p;
}
const STEPS = QUICK ? 400 : 800;

// ─── 2. Physics ───────────────────────────────────────────────────────────────
console.log('\n  PHYSICS');
{
  // Rain shadow, synthetic: how much of the rain the ridge moves out of the lee,
  // relative to the same world with no ridge. Bounded (-1..1): the old ratio of
  // ratios read 114,676 or 0.00 once rain became intermittent and one side's
  // total approached zero. NaN (a side-pair with no rain at all) fails.
  const cR = buildClimate(input(synthGrid(true), 'ocean', 5));
  const cF = buildClimate(input(synthGrid(false), 'ocean', 5));
  const shift = (abl: SimAblation) => leeShare(precipMean(cF, STEPS, abl)) - leeShare(precipMean(cR, STEPS, abl));
  const shadow = shift({}), shadowAbl = shift({ uplift: true });
  const shadowNull = leeShare(nullPrecip(cF)) - leeShare(nullPrecip(cR));
  check('rain shadow (synthetic ridge)', shadow >= 0.2, `lee share falls by ${shadow.toFixed(2)} >= 0.2`);
  check('  control: uplift ablated has none', !(shadowAbl >= 0.2), `${shadowAbl.toFixed(2)} < 0.2`);
  check('  control: null model has none', !(shadowNull >= 0.2), `${shadowNull.toFixed(2)} < 0.2`);

  // Rain shadow, real grids: windward vs lee cells, relative to uplift-ablated.
  const rel: number[] = [];
  for (const seed of SEEDS) {
    const c = buildClimate(input(generatePlanetGrid('rocky', seed * 7777, null, null), 'rocky', seed));
    const p = precipMean(c, QUICK ? 200 : 400), pA = precipMean(c, QUICK ? 200 : 400, { uplift: true });
    const probe = new WeatherSim(c);
    let ww = 0, lee = 0, wwA = 0, leeA = 0;
    for (let j = 2; j < WX_NY - 2; j++) {
      const up = probe.baseWindU(j) >= 0 ? 1 : -1;
      for (let i = 0; i < WX_NX; i++) {
        const at = (di: number) => j * WX_NX + ((i + di) % WX_NX + WX_NX) % WX_NX;
        const rise = c.elev[at(up)] - c.elev[at(-up)];
        if (rise > 0.05) { ww += p[at(0)]; wwA += pA[at(0)]; lee += p[at(3 * up)]; leeA += pA[at(3 * up)]; }
      }
    }
    rel.push((ww / Math.max(1e-6, lee)) / Math.max(1e-6, wwA / Math.max(1e-6, leeA)));
  }
  rel.sort((a, b) => a - b);
  const relMed = rel[Math.floor(rel.length / 2)];
  check('rain shadow (real grids, median)', relMed >= 1.5, `${relMed.toFixed(2)} >= 1.5 over ${rel.length} seeds`);

  // Poles snow.
  const cO = buildClimate(input(generatePlanetGrid('ocean', 42 * 7777, null, null), 'ocean', 42));
  const snowShare = (abl: SimAblation) => {
    const s = new WeatherSim(cO, abl); s.warmUp(WX_WARMUP);
    let polS = 0, polP = 0, troS = 0, troP = 0;
    for (let n = 0; n < STEPS; n++) {
      s.step(WX_DT);
      for (let j = 0; j < WX_NY; j++) {
        const a = Math.abs(latOf(j)) * 180 / Math.PI;
        for (let i = 0; i < WX_NX; i++) {
          const k = j * WX_NX + i, p = s.precip[k];
          if (a > 60) { polP += p; if (s.snow[k]) polS += p; }
          if (a < 30) { troP += p; if (s.snow[k]) troS += p; }
        }
      }
    }
    return (polS / Math.max(1e-9, polP)) / Math.max(0.01, troS / Math.max(1e-9, troP));
  };
  const snowR = snowShare({}), snowAbl = snowShare({ cold: true });
  check('poles snow', snowR >= 5, `polar/tropical snow share ${snowR.toFixed(1)} >= 5`);
  check('  control: cold ablated', snowAbl < 5, `${snowAbl.toFixed(1)} < 5`);

  // Storms follow stress.
  const gO = generatePlanetGrid('ocean', 42 * 7777, null, null);
  const stormFrac = (pressure: number, abl: SimAblation) => {
    const s = run(buildClimate(input(gO, 'ocean', 42, { extinctionPressure: pressure })), STEPS, abl);
    let n = 0; for (let k = 0; k < WX_N; k++) if (kindAt(s, k) === WK.STORM) n++;
    return n / WX_N;
  };
  const sHi = stormFrac(0.8, {}), sLo = stormFrac(0, {});
  const aHi = stormFrac(0.8, { stress: true }), aLo = stormFrac(0, { stress: true });
  check('storms follow stress', sHi >= 2 * Math.max(sLo, 0.002), `${(sHi * 100).toFixed(1)}% vs ${(sLo * 100).toFixed(1)}%`);
  check('  control: stress ablated', !(aHi >= 2 * Math.max(aLo, 0.002)), `${(aHi * 100).toFixed(1)}% vs ${(aLo * 100).toFixed(1)}%`);

  // Vertical motion's own signature: a subtropical dry belt (Hadley descent).
  // Temperature alone gives a monotone profile, so the ablated sim cannot make one.
  const dryBelt = (abl: SimAblation) => {
    const s = run(cO, STEPS, abl);
    let eq = 0, nE = 0, sub = 0, nS = 0, mid = 0, nM = 0;
    for (let j = 0; j < WX_NY / 2; j++) {
      let m = 0;
      for (let i = 0; i < WX_NX; i++) m += s.cloud[j * WX_NX + i] + s.cloud[(WX_NY - 1 - j) * WX_NX + i];
      m /= 2 * WX_NX;
      const a = Math.abs(latOf(j)) * 180 / Math.PI;
      if (a < 12) { eq += m; nE++; }
      else if (a >= 20 && a <= 35) { sub += m; nS++; }
      else if (a >= 48 && a <= 65) { mid += m; nM++; }
    }
    sub /= nS;
    return Math.min(eq / nE - sub, mid / nM - sub);
  };
  const belt = dryBelt({}), beltAbl = dryBelt({ vertical: true });
  check('subtropical dry belt (vertical motion)', belt >= 0.05, `subtropics drier by ${belt.toFixed(3)} >= 0.05`);
  check('  control: vertical motion ablated', !(beltAbl >= 0.05), `${beltAbl.toFixed(3)} < 0.05`);

  // Moves with the wind: row cross-correlation peak between t and t+10 s,
  // pooled over six ocean seeds. On seed 42 alone the committed sim read 95%
  // while seeds 99/123/256 read 35-65%; pooled it was 70%. The bar is 65%:
  // rows split ~50/50 when nothing moves the cloud, and zero wind reads 0%.
  const driftSeeds = [42, 7, 1, 99, 123, 256];
  const driftClimates = driftSeeds.map(sd => buildClimate(input(generatePlanetGrid('ocean', sd * 7777, null, null), 'ocean', sd)));
  const drift = (abl: SimAblation) => {
    let agree = 0, rows = 0;
    for (const cD of driftClimates) {
    const dirProbe = new WeatherSim(cD);
    const s = run(cD, 100, abl);
    // Transient field only: subtract the 60 s mean so stationary, source-pinned cloud cancels.
    const avg = new Float32Array(WX_N);
    for (let n = 0; n < 240; n++) { s.step(WX_DT); for (let k = 0; k < WX_N; k++) avg[k] += s.cloud[k] / 240; }
    const before = s.cloud.map((v, k) => v - avg[k]);
    for (let n = 0; n < 40; n++) s.step(WX_DT);
    const after = s.cloud.map((v, k) => v - avg[k]);
    for (let j = 2; j < WX_NY - 2; j++) {
      const a = Math.abs(latOf(j)) * 180 / Math.PI;
      if (Math.abs(a - 30) < 5 || Math.abs(a - 60) < 5) continue;   // band edges
      let best = -Infinity, bestShift = 0;
      for (let sh = -8; sh <= 8; sh++) {
        let cc = 0;
        for (let i = 0; i < WX_NX; i++) cc += before[j * WX_NX + i] * after[j * WX_NX + ((i + sh) % WX_NX + WX_NX) % WX_NX];
        if (cc > best) { best = cc; bestShift = sh; }
      }
      rows++;
      // Judge against the real band direction, even when the wind is ablated.
      if (bestShift !== 0 && Math.sign(bestShift) === Math.sign(dirProbe.baseWindU(j))) agree++;
    }
    }
    return agree / Math.max(1, rows);
  };
  const dr = drift({}), drAbl = drift({ wind: true });
  check('cloud moves with the band wind', dr >= 0.65, `${(dr * 100).toFixed(0)}% of rows agree, 6 seeds pooled`);
  check('  control: zero wind', drAbl < 0.65, `${(drAbl * 100).toFixed(0)}%`);

  // Smog where the cities are.
  const civGrid = generatePlanetGrid('ocean', 7 * 7777, null, null);
  for (const [cr, cc] of [[80, 40], [128, 150], [170, 220]]) {
    for (let r = cr - 20; r <= cr + 20; r++) for (let c = cc - 20; c <= cc + 20; c++) {
      if ((r - cr) ** 2 + (c - cc) ** 2 <= 400) civGrid[r][(c + GRID_SIZE) % GRID_SIZE].civId = 'civ';
    }
  }
  const smogRatio = (opts: object, civLevel: number) => {
    const c = buildClimate(input(civGrid, 'ocean', 7, { civLevel }), opts);
    const s = run(c, STEPS);
    // Distance from the real cities, never from the ablated emitters.
    const src = buildClimate(input(civGrid, 'ocean', 7, { civLevel }));
    let near = 0, nN = 0, far = 0, nF = 0;
    for (let j = 0; j < WX_NY; j++) for (let i = 0; i < WX_NX; i++) {
      const k = j * WX_NX + i;
      let dist = 99;
      for (let jj = 0; jj < WX_NY; jj++) for (let ii = 0; ii < WX_NX; ii++) {
        if (src.smogEmit[jj * WX_NX + ii] <= 0) continue;
        const di = Math.min(Math.abs(ii - i), WX_NX - Math.abs(ii - i));
        dist = Math.min(dist, Math.max(di, Math.abs(jj - j)));
      }
      if (dist <= 3) { near += s.smog[k]; nN++; } else if (dist >= 10) { far += s.smog[k]; nF++; }
    }
    return { ratio: (near / Math.max(1, nN)) / Math.max(1e-6, far / Math.max(1, nF)), total: s.smog.reduce((a, b) => a + b, 0) };
  };
  const sm = smogRatio({}, 6), smU = smogRatio({ uniformEmitters: true }, 6), sm3 = smogRatio({}, 3);
  check('smog sits over the cities', sm.ratio >= 3, `near/far ${sm.ratio.toFixed(1)} >= 3`);
  check('  control: uniform emitters', !(smU.ratio >= 3), `${smU.ratio.toFixed(1)}`);
  check('no smog below civ 4', sm3.total === 0, `total ${sm3.total}`);

  // Ash where the vents are.
  const ashRatio = (opts: object) => {
    const c = buildClimate(input(generatePlanetGrid('lava', 7 * 7777, null, null), 'lava', 7), opts);
    const s = run(c, STEPS);
    const src = buildClimate(input(generatePlanetGrid('lava', 7 * 7777, null, null), 'lava', 7));
    let near = 0, nN = 0, far = 0, nF = 0;
    for (let j = 0; j < WX_NY; j++) for (let i = 0; i < WX_NX; i++) {
      let dist = 99;
      for (let jj = Math.max(0, j - 12); jj < Math.min(WX_NY, j + 13); jj++) for (let ii = i - 12; ii <= i + 12; ii++) {
        if (src.ashEmit[jj * WX_NX + ((ii % WX_NX) + WX_NX) % WX_NX] <= 0) continue;
        dist = Math.min(dist, Math.max(Math.abs(ii - i), Math.abs(jj - j)));
      }
      const k = j * WX_NX + i;
      if (dist <= 3) { near += s.ash[k]; nN++; } else if (dist >= 8) { far += s.ash[k]; nF++; }
    }
    return (near / Math.max(1, nN)) / Math.max(1e-6, far / Math.max(1, nF));
  };
  const ar = ashRatio({}), arU = ashRatio({ uniformEmitters: true });
  check('ash sits over the vents', ar >= 3, `near/far ${ar.toFixed(1)} >= 3`);
  check('  control: uniform emitters', arU < 3, `${arU.toFixed(1)} < 3`);

  // Per-world personality.
  const corr = (a: Float32Array, b: Float32Array) => {
    const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0;
    for (let k = 0; k < a.length; k++) { n += (a[k] - ma) * (b[k] - mb); da += (a[k] - ma) ** 2; db += (b[k] - mb) ** 2; }
    return n / Math.sqrt(Math.max(1e-12, da * db));
  };
  /** Final cloud, and its anomaly from the run's own mean over the last 240 steps. */
  const runAnom = (c: ClimateSources) => {
    const s = new WeatherSim(c); s.warmUp(WX_WARMUP);
    const avg = new Float32Array(WX_N);
    for (let n = 0; n < STEPS; n++) {
      s.step(WX_DT);
      if (n >= STEPS - 240) for (let k = 0; k < WX_N; k++) avg[k] += s.cloud[k] / 240;
    }
    return { raw: s.cloud.slice(), anom: s.cloud.map((v, k) => v - avg[k]) };
  };
  const pA = runAnom(buildClimate(input(gO, 'ocean', 11)));
  const pB = runAnom(buildClimate(input(gO, 'ocean', 12)));
  const pA2 = runAnom(buildClimate(input(gO, 'ocean', 11)));
  const cAB = corr(pA.anom, pB.anom), cAA = corr(pA.anom, pA2.anom);
  check('two seeds, same grid: different weather', cAB < 0.5, `anomaly corr ${cAB.toFixed(2)} < 0.5`);
  check('same seed twice: identical', pA.raw.every((v, k) => v === pA2.raw[k]), '');
  check('  control: seed ignored is identical', cAA >= 0.5, `anomaly corr ${cAA.toFixed(2)}`);

  // Stable over hours.
  const TYPES = ['ocean', 'rocky', 'ice', 'lava', 'desert', 'storm', 'toxic', 'carbon', 'crystal'];
  const LONG = QUICK ? 4000 : 20000;
  // Dry by TYPE, not by measured water: mean(c.water) reads ~0 on most ice and
  // all crystal seeds, which would let a vapour-starved ice world (the failure
  // R2h fixed) pass on the weaker 'alive' bar.
  const DRY_TYPES = new Set(['desert', 'lava', 'carbon']);
  const fails: string[] = [];
  for (const t of TYPES) for (const seed of SEEDS.slice(0, QUICK ? 2 : 6)) {
    const c = buildClimate(input(generatePlanetGrid(t, seed * 7777, null, null), t, seed));
    // The floor catches a dead sim, not a dry world: a water-bearing type
    // must keep >= 2% cover; a dry type (DRY_TYPES) must only
    // stay alive, max cloud (+ash, the same aerosol the cover counts) > 0.05 at
    // every sample. (0.1 sat inside desert's live range, 0.090-0.145; a dead
    // sim reads 0.) The 75% cap, the NaN/range check and the frozen check
    // apply to every type.
    const wet = !DRY_TYPES.has(t);
    const s = new WeatherSim(c); s.warmUp(WX_WARMUP);
    let snap = s.cloud.slice(), frozen = 0, samples = 0, failed1 = false;
    for (let n = 1; n <= LONG; n++) {
      s.step(WX_DT);
      if (n % 240 !== 0) continue;               // every 60 s
      samples++;
      let cover = 0, bad = false, peak = 0;
      for (let k = 0; k < WX_N; k++) {
        const v = s.cloud[k];
        if (!Number.isFinite(v) || v < 0 || v > 1.4 || !Number.isFinite(s.vapour[k])) bad = true;
        if (v + s.ash[k] > 0.3) cover++;
        if (v + s.ash[k] > peak) peak = v + s.ash[k];
      }
      cover /= WX_N;
      if (corr(snap, s.cloud) > 0.95) frozen++;
      snap = s.cloud.slice();
      const dead = wet ? cover < 0.02 : peak <= 0.05;
      if ((bad || dead || cover > 0.75) && !failed1) { failed1 = true; fails.push(`${t} seed ${seed} step ${n}: cover ${(cover * 100).toFixed(1)}% peak ${peak.toFixed(2)}${bad ? ' NaN/range' : ''}`); }
    }
    if (frozen > samples * 0.5) fails.push(`${t} seed ${seed}: frozen in ${frozen}/${samples} samples`);
  }
  check('stable over hours, every type', fails.length === 0, fails.join('; ') || `${TYPES.length} types x ${QUICK ? 2 : 6} seeds x ${LONG} steps`);

  // Rain comes and goes. Before the cycle a wet spot rained ~75% of the time and
  // some rained for the whole hour: rising-air cells sat above the precip
  // threshold at equilibrium. Measured at the painter's spawn threshold (0.004),
  // i.e. rain the player can see. Over one hour, per run: the median wet cell
  // is wet <= 40% of the time, <= 2% of the planet is wet > 80% of the time
  // (was 24-32%; a few windward slopes legitimately stay rainy), and the planet
  // still rains somewhere (>= 20% of cells get some). The longest spell is
  // reported, not gated: one wet slope sets it.
  const rainCycle = (abl: SimAblation) => {
    const HOUR = 3600 / WX_DT;
    let worstShare = 0, worstSpell = 0, leastEver = 1, worstSoaked = 0;
    for (const t of ['ocean', 'rocky', 'storm', 'ice']) for (const seed of SEEDS.slice(0, 2)) {
      const s = new WeatherSim(buildClimate(input(generatePlanetGrid(t, seed * 7777, null, null), t, seed)), abl);
      s.warmUp(WX_WARMUP);
      const wetN = new Int32Array(WX_N), run = new Int32Array(WX_N), best = new Int32Array(WX_N);
      for (let n = 0; n < HOUR; n++) {
        s.step(WX_DT);
        for (let k = 0; k < WX_N; k++) {
          if (s.precip[k] > 0.004) { wetN[k]++; if (++run[k] > best[k]) best[k] = run[k]; } else run[k] = 0;
        }
      }
      const shares: number[] = [];
      for (let k = 0; k < WX_N; k++) if (wetN[k]) shares.push(wetN[k] / HOUR);
      shares.sort((a, b) => a - b);
      worstShare = Math.max(worstShare, shares.length ? shares[shares.length >> 1] : 0);
      worstSpell = Math.max(worstSpell, Math.max(...best) * WX_DT);
      leastEver = Math.min(leastEver, shares.length / WX_N);
      worstSoaked = Math.max(worstSoaked, shares.filter(v => v > 0.8).length / WX_N);
    }
    return { worstShare, worstSpell, leastEver, worstSoaked };
  };
  const rc = rainCycle({}), rcAbl = rainCycle({ cycle: true, diurnal: true });
  const cycles = (r: typeof rc) => r.worstShare <= 0.4 && r.worstSoaked <= 0.02 && r.leastEver >= 0.2;
  const fmt = (r: typeof rc) => `median wet share ${(r.worstShare * 100).toFixed(0)}%, wet >80% of the time ${(r.worstSoaked * 100).toFixed(1)}% of planet, least rained-on ${(r.leastEver * 100).toFixed(0)}% (longest spell ${r.worstSpell.toFixed(0)} s)`;
  check('rain comes and goes', cycles(rc), fmt(rc));
  check('  control: no shower cycle', !cycles(rcAbl), fmt(rcAbl));
}

// ─── 3. Anomalies ─────────────────────────────────────────────────────────────
console.log('\n  ANOMALIES');
{
  const TWO_HOURS = 7200 / WX_DT;
  const counts: number[] = [];
  let deterministic = true;
  for (const seed of SEEDS.slice(0, 3)) {
    const c = buildClimate(input(generatePlanetGrid('ocean', seed * 7777, null, null), 'ocean', seed));
    const a = new WeatherSim(c), b = new WeatherSim(c);
    const kindsA: string[] = [], kindsB: string[] = [];
    for (let n = 0; n < TWO_HOURS; n++) {
      a.step(WX_DT); b.step(WX_DT);
      if (a.anomaly && a.anomaly.until - a.time > 29.9) kindsA.push(`${a.anomaly.kind}@${a.anomaly.i},${a.anomaly.j}`);
      if (b.anomaly && b.anomaly.until - b.time > 29.9) kindsB.push(`${b.anomaly.kind}@${b.anomaly.i},${b.anomaly.j}`);
    }
    counts.push(a.anomalyCount);
    if (kindsA.join('|') !== kindsB.join('|')) deterministic = false;
  }
  check('anomalies: 12-24 per two hours', counts.every(n => n >= 12 && n <= 24), counts.join(', '));
  check('anomalies are deterministic', deterministic, '');
  const off = new WeatherSim(buildClimate(input(generatePlanetGrid('ocean', 7777, null, null), 'ocean', 1)), { anomalies: true });
  for (let n = 0; n < TWO_HOURS; n++) off.step(WX_DT);
  check('  control: ablated schedule fires none', off.anomalyCount === 0, `${off.anomalyCount}`);
}

// ─── 4. Painter ───────────────────────────────────────────────────────────────
console.log('\n  PAINTER');
// A 480x260 canvas like the real renderer's, face rx 150 / ry 78, and an
// azimuthal projection centred on the equator (as habitableDioramaCheck does).
const PW = 480, PH = 260;
const pgeom = { cx: 240, cyTop: 140, rx: 150, ry: 78 };
const project = (dx: number, dy: number) => {
  const r = Math.hypot(dx, dy);
  if (r > 1) return null;
  const c = r * (Math.PI / 2), sinC = Math.sin(c), cosC = Math.cos(c);
  const ny = -dy;
  const lat = r < 1e-6 ? 0 : Math.asin(Math.max(-1, Math.min(1, (ny * sinC) / r)));
  const lon = Math.atan2(dx * sinC, r * cosC);
  const v = 0.5 - lat / Math.PI, u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;
  return { row: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)))),
           col: Math.min(GRID_SIZE - 1, Math.floor(u * GRID_SIZE)) };
};
function painterFor(type: string, seed: number, over: Partial<ClimateInput> = {}, opts: object = {}) {
  const grid = generatePlanetGrid(type, seed * 7777, null, null);
  const lift = (row: number, col: number) => grid[row][col].elevation >= SEA_LEVEL ? Math.round((grid[row][col].elevation - SEA_LEVEL) * 30) : 0;
  const lut = buildWeatherLut(pgeom, project, (row, col) => lift(row, col));
  const c = buildClimate(input(grid, type, seed, over), opts);
  const sim = new WeatherSim(c); sim.warmUp(WX_WARMUP);
  const painter = new WeatherPainter(lut, c, 24, seed);
  const img = { width: PW, height: PH, data: new Uint8ClampedArray(PW * PH * 4) };
  const shadow = { width: PW, height: PH, data: new Uint8ClampedArray(PW * PH * 4) };
  let acc = 0;
  const frame = (dt = 1 / 60) => {
    acc += dt;
    while (acc >= WX_DT) { acc -= WX_DT; sim.step(WX_DT); painter.onStep(sim); }
    painter.prepare(sim, acc / WX_DT, dt);
    img.data.fill(0); shadow.data.fill(0);
    painter.paintShadows(shadow, 0.6, 1);
    painter.paintClouds(img, 0.6, 1);
  };
  return { lut, c, sim, painter, img, shadow, frame };
}
{
  // Terrain stays readable.
  const TYPES = ['ocean', 'rocky', 'ice', 'lava', 'desert', 'storm', 'toxic', 'carbon', 'crystal'];
  /** Mean share of face pixels at mid-or-dense cloud, and at any cloud step. */
  const coverOf = (type: string, seed: number, opts: object = {}) => {
    const p = painterFor(type, seed, {}, opts);
    let sum = 0, drawn = 0;
    for (let f = 0; f < 60; f++) {
      p.frame();
      sum += p.painter.stats.midOrDense / p.lut.count;
      drawn += p.painter.stats.drawn / p.lut.count;
    }
    return { mid: sum / 60, drawn: drawn / 60 };
  };
  const shareOf = (type: string, seed: number, opts: object = {}) => coverOf(type, seed, opts).mid;
  let readable = true, detail = '';
  // R4a: the sky must not read blank either. Desert is exempt (R2i: no
  // evaporating water, its sky is legitimately near-empty).
  let notBlank = true, blankDetail = '';
  for (const t of TYPES) {
    const covers = SEEDS.slice(0, QUICK ? 3 : 12).map(s => coverOf(t, s));
    const shares = covers.map(c => c.mid).sort((a, b) => a - b);
    const drawn = covers.map(c => c.drawn).sort((a, b) => a - b);
    const med = shares[Math.floor(shares.length / 2)], max = shares[shares.length - 1];
    const dMed = drawn[Math.floor(drawn.length / 2)];
    detail += `${t} ${(med * 100).toFixed(0)}/${(max * 100).toFixed(0)}% `;
    blankDetail += `${t} ${(dMed * 100).toFixed(1)}% `;
    if (med > 0.55 || max > 0.70) readable = false;
    if (t === 'ocean' && med < 0.10) readable = false;
    if (t !== 'desert' && dMed < 0.05) notBlank = false;
  }
  check('terrain stays readable (median/max)', readable, detail);
  check('sky is not blank (median drawn >= 5%)', notBlank, blankDetail);
  const blanket = shareOf('lava', 7, { ashFloor: 0.12 });
  check('  control: lava ash floor hides the face', blanket > 0.70, `${(blanket * 100).toFixed(0)}% > 70%`);

  // Storm reads in a still frame.
  const stormStats = (over: Partial<ClimateInput>, seed: number, type = 'storm') => {
    const p = painterFor(type, seed, over);
    let minLive = Infinity, minWet = Infinity; const f0 = p.painter.flashesTotal;
    // R4c: the spec's metric is the storm type's STEADY STATE. Rain minima are
    // sampled after a 5 s settle (frame 300 on): right after warm-up a weak
    // seed's sim is still ramping (seed 99: ~30 live at frame 0, 57 by frame 30).
    // Flashes are counted over the full minute.
    for (let f = 0; f < 60 * 60; f++) {
      p.frame();
      if (f >= 300 && f % 30 === 0) {
        minLive = Math.min(minLive, p.painter.pCount);
        let wet = 0; for (let k = 0; k < WX_N; k++) if (p.sim.precip[k] > 0.004) wet++;
        minWet = Math.min(minWet, wet / WX_N);
      }
    }
    return { minLive, minWet, flashesPer5s: (p.painter.flashesTotal - f0) / 12 };
  };
  // -0.6 cancels the storm type's +0.6 base, so stormPressure clamps to 0.
  // R4b: every storm seed, not one.
  const STORM_SEEDS = SEEDS.slice(0, QUICK ? 3 : 6);
  // "Real rain exists": ~10 field cells. Not a quota — storm worlds are
  // drier than ocean worlds in terrain (seed 99 is 2% water). Desert reads 0.
  const STORM_WET_FLOOR = 0.005;
  const st = STORM_SEEDS.map(s => stormStats({}, s));
  const stCalm = STORM_SEEDS.map(s => stormStats({ extinctionPressure: -0.6 }, s));
  // Rain somewhere on the planet at every moment, not on one fixed face: with
  // the shower cycle a storm world can turn a dry region to the viewer (seed
  // 99's face: mean ~23 live particles, the old sim's constant drizzle hid it).
  // Decided 2026-09-28: a storm world may have a calm side. Face particles are
  // still reported. Control: a desert world never rains.
  const dryCtl = stormStats({}, 7, 'desert');
  check('storm world: always raining somewhere', st.every(r => r.minWet >= STORM_WET_FLOOR),
    `min planet share raining per seed ${st.map(r => (r.minWet * 100).toFixed(1) + '%').join(', ')} >= ${STORM_WET_FLOOR * 100}% (face particles min ${st.map(r => r.minLive).join(', ')})`);
  check('  control: desert never rains', !(dryCtl.minWet >= STORM_WET_FLOOR), `${(dryCtl.minWet * 100).toFixed(1)}%`);
  check('storm world: lightning every few seconds', st.every(r => r.flashesPer5s >= 1),
    `per 5 s per seed ${st.map(r => r.flashesPer5s.toFixed(1)).join(', ')}`);
  // The control must fail on EVERY seed: no calm world may read as a storm.
  check('  control: calm storm world has no lightning', stCalm.every(r => !(r.flashesPer5s >= 1)),
    stCalm.map(r => `${r.flashesPer5s.toFixed(1)}/5s, raining ${(r.minWet * 100).toFixed(1)}%`).join(', '));

  // Rain lands on the ground; painter stays in bounds.
  const p = painterFor('storm', 42);
  let offGround = 0, outOfBounds = 0;
  const allowed = new Uint8Array(PW * PH);
  for (let n = 0; n < p.lut.count; n++) {
    const x = p.lut.px[n];
    const yTop = p.lut.py[n] - 24 - 4, yBot = Math.max(p.lut.py[n], p.lut.ground[n]) + 1;
    for (let xx = x - 3; xx <= x + 3; xx++) for (let y = yTop; y <= yBot; y++) {
      if (xx >= 0 && y >= 0 && xx < PW && y < PH) allowed[y * PW + xx] = 1;
    }
  }
  for (let f = 0; f < 600; f++) {
    p.frame();
    for (let q = 0; q < p.painter.pCount; q++) {
      if (p.painter.pY[q] > p.painter.pGround[q] || p.painter.pGround[q] !== p.lut.ground[p.painter.pSpawn[q]]) offGround++;
    }
    for (let k = 0; k < PW * PH; k++) {
      if ((p.img.data[k * 4 + 3] || p.shadow.data[k * 4 + 3]) && !allowed[k]) outOfBounds++;
    }
  }
  check('rain lands on the ground under its cloud', offGround === 0, `${offGround} violations`);
  check('painter stays on the face + cloud band', outOfBounds === 0, `${outOfBounds} stray pixels`);

  // R5a: shading follows the cloud, not the field grid. A sharp light/dark jump
  // between two same-level cloud pixels should sit on a field-cell boundary no
  // more often than any pixel pair does. Comparing a smoothed sunward sample
  // against the NEAREST cell's value flipped shading at every cell edge and
  // tiled clouds into rectangles (seen 2026-09-27 in renders/weather-2026-09-27).
  const gridBias = (type: string, seed: number) => {
    const q = painterFor(type, seed);
    const at = new Int32Array(PW * PH).fill(-1);
    for (let n = 0; n < q.lut.count; n++) {
      const y = q.lut.py[n] - 24;
      if (y >= 0) at[y * PW + q.lut.px[n]] = fieldIndex(q.lut.fx[n], q.lut.fy[n]);
    }
    let pairs = 0, pairsB = 0, jumps = 0, jumpsB = 0;
    const d = q.img.data, lum = (o: number) => d[o] * 0.3 + d[o + 1] * 0.59 + d[o + 2] * 0.11;
    for (let f = 0; f < 240; f++) {
      q.painter.pCount = 0; q.frame();
      if (f % 40) continue;
      for (let y = 0; y < PH - 1; y++) for (let x = 0; x < PW - 1; x++) {
        const i = y * PW + x, o = i * 4;
        if (!d[o + 3] || at[i] < 0) continue;
        for (const j of [i + 1, i + PW]) {
          const oj = j * 4;
          if (d[oj + 3] !== d[o + 3] || at[j] < 0) continue;
          const b = at[i] !== at[j];
          pairs++; if (b) pairsB++;
          if (Math.abs(lum(o) - lum(oj)) > 30) { jumps++; if (b) jumpsB++; }
        }
      }
    }
    return jumps < 20 ? 1 : (jumpsB / jumps) / (pairsB / pairs);
  };
  const biases = ['ocean', 'storm', 'toxic'].flatMap(t => SEEDS.slice(0, 3).map(s => gridBias(t, s)));
  const worstBias = Math.max(...biases);
  check('cloud shading ignores the field grid', worstBias < 2,
    `jumps on cell edges vs chance, worst ${worstBias.toFixed(2)} < 2 (${biases.map(v => v.toFixed(1)).join(' ')})`);

  // R5b: a lone ash plume is lit on the sun side and dark on the far side, not
  // a dark ring around a lit core (the carbon vent, 2026-09-27).
  {
    const q = painterFor('carbon', 7);
    const s = q.sim;
    s.cloud.fill(0); s.prevCloud.fill(0); s.smog.fill(0); s.prevSmog.fill(0); s.ash.fill(0); s.prevAsh.fill(0);
    for (let j = 0; j < WX_NY; j++) for (let i = 0; i < WX_NX; i++) {
      const r2 = (i - 16) ** 2 + (j - 20) ** 2;
      s.ash[j * WX_NX + i] = s.prevAsh[j * WX_NX + i] = 0.9 * Math.exp(-r2 / 4);
    }
    q.painter.pCount = 0;
    q.painter.prepare(s, 1, 0);
    q.img.data.fill(0);
    q.painter.paintClouds(q.img, 0.6, 1);
    const lums: { x: number; l: number }[] = [];
    const d = q.img.data;
    for (let i = 0; i < PW * PH; i++) if (d[i * 4 + 3]) lums.push({ x: i % PW, l: d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11 });
    let cx = 0; for (const p of lums) cx += p.x; cx /= Math.max(1, lums.length);
    const sorted = lums.map(p => p.l).sort((a, b) => a - b);
    const mid = sorted[sorted.length >> 1] ?? 0;
    const dark = lums.filter(p => p.l < mid - 10), lit = lums.filter(p => p.l > mid + 10);
    // sunAzimuth 0.6: the sun is toward +x.
    const darkSunSide = dark.filter(p => p.x > cx).length / Math.max(1, dark.length);
    const litSunSide = lit.filter(p => p.x > cx).length / Math.max(1, lit.length);
    check('lone plume: lit toward the sun, dark away', lums.length > 30 && lit.length > 0.1 * lums.length && darkSunSide < 0.3 && litSunSide > 0.7,
      `${lums.length} px, lit ${lit.length}, dark on sun side ${(darkSunSide * 100).toFixed(0)}%, lit on sun side ${(litSunSide * 100).toFixed(0)}%`);
  }

  // No per-frame allocation.
  const gcFn = (globalThis as any).gc as (() => void) | undefined;
  if (!gcFn) {
    check('no per-frame allocation', false, 'run with node --expose-gc');
  } else {
    // Best of three windows after a long warm-up. One window after 100 frames
    // failed ~1 run in 5 (+146 KB vs a steady +36 KB): the optimising compiler
    // tiering up mid-window puts code and feedback on the heap. That happens
    // once; a real per-frame allocation shows in every window.
    const growth = (frame: () => void) => {
      for (let f = 0; f < 1000; f++) frame();
      let best = Infinity;
      for (let w = 0; w < 3; w++) {
        gcFn(); const h0 = process.memoryUsage().heapUsed;
        for (let f = 0; f < 1000; f++) frame();
        best = Math.min(best, process.memoryUsage().heapUsed - h0);
      }
      return best;
    };
    const q = painterFor('ocean', 7);
    const grew = growth(q.frame);
    check('no per-frame allocation', grew < 64 * 1024, `heap +${(grew / 1024).toFixed(1)} KB per 1000 frames, best of 3`);
    const sink: { v: Float32Array | null } = { v: null };
    const q2 = painterFor('ocean', 7);
    const grewCtl = growth(() => { q2.frame(); sink.v = new Float32Array(16); });
    check('  control: one small array per frame', grewCtl >= 64 * 1024, `heap +${(grewCtl / 1024).toFixed(1)} KB`);
  }

  // Headless cost (informational — the gate is measured in the preview, Task 6).
  const b = painterFor('ocean', 7);
  const times: number[] = [];
  for (let f = 0; f < 200; f++) { const t0 = performance.now(); b.frame(); times.push(performance.now() - t0); }
  times.sort((x, y) => x - y);
  console.log(`  info  headless frame (sim amortised + paint) median ${times[100].toFixed(2)} ms`);
}

console.log(failed === 0 ? '\n  all weather checks passed\n' : `\n  ${failed} weather check(s) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
