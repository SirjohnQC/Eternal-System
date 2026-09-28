/**
 * The weather sim: a 64x32 field over the whole planet, stepped at 4 Hz.
 *
 * Pure and deterministic. Visual only — nothing here feeds back into the
 * simulation. Every physics term has an ablation switch so tools/weatherCheck
 * can prove each metric measures the term it claims to.
 */
import { WX_NX, WX_NY, WX_N, weatherRng, type ClimateSources } from './WeatherClimate';

export const WX_DT = 0.25;
export const WX_WARMUP = 200;
/** Seconds per warm-up step. */
export const WX_WARMUP_DT = 1;
/** Below this effective temperature, precipitation is snow. */
export const COLD = 0.3;
/** Rate at which sub-saturated air re-evaporates cloud, per second per unit deficit. */
export const CLOUD_EVAP = 1.5;

/**
 * Shower cycle. A cell starts to rain when its cloud passes RAIN_ON and keeps
 * raining until the cloud is drained below RAIN_OFF; then it is dry until the
 * cloud builds back up. Without the hysteresis, rising-air cells sat just above
 * one threshold at equilibrium and rained for the whole hour.
 */
export const RAIN_ON = 0.55;
export const RAIN_OFF = 0.35;
export const RAIN_RATE = 0.35;
/** Shower state above which rain continues (onset sets it to 1). */
export const SHOWER_ALIVE = 0.3;
/** Seconds for the shower state to decay from 1 to 0; a shower lasts ~0.7 of this. */
export const SHOWER_LIFE = 90;
/** Lee strength per unit downslope: raises shower onset by this fraction. */
export const OROGRAPHIC_DESCENT = 6;
/** Shower decay per second per unit lee strength. */
export const LEE_KILL = 2;
/** Seconds for fohn dryness to fade as the air moves on. */
export const FOHN_LIFE = 10;
/** Shower lifetime multiplier per unit storm pressure. */
export const STORM_SHOWER = 2;
/** Initial vapour as a fraction of the no-lift saturation cap. */
export const VAPOUR_START = 0.6;
/** A shower drains vapour down to this fraction of the saturation cap. */
export const RAIN_DRY = 0.8;
/**
 * Day cycle. Rising air is scaled by local solar heating, weak at night and
 * strong in the afternoon, averaging 1 over a day. Without it the equatorial
 * rising band never let up and its cells rained for the whole hour. Weighted
 * to the tropics (1 at the equator, 0 from 30 degrees): tropical convection
 * follows the sun; mid-latitude weather is frontal and rides the band wind.
 */
export const DIURNAL = 0.6;
/** Seconds per day when nothing drives the sun (headless runs); the host sets `sunLon`. */
export const WX_DAY = 45;

export interface SimAblation {
  uplift?: boolean; vertical?: boolean; cold?: boolean;
  stress?: boolean; wind?: boolean; anomalies?: boolean;
  /** No shower cycle: rain whenever cloud exceeds one threshold (the old sim). */
  cycle?: boolean;
  /** No day cycle: rising air is the same at noon and midnight. */
  diurnal?: boolean;
}

export const WK = { CLEAR: 0, CUMULUS: 1, STORM: 2, ICE: 3, ASH: 4, SMOG: 5 } as const;

export type AnomalyKind = 'supercell' | 'reversal' | 'clearing';
export interface Anomaly { kind: AnomalyKind; i: number; j: number; until: number }

/** Latitude of field row j, radians; row 0 is the north pole. */
export function latOf(j: number): number {
  return (0.5 - (j + 0.5) / WX_NY) * Math.PI;
}

const wrapI = (i: number) => ((i % WX_NX) + WX_NX) % WX_NX;
const clampJ = (j: number) => (j < 0 ? 0 : j > WX_NY - 1 ? WX_NY - 1 : j);

/** Bilinear sample; longitude wraps, latitude clamps. */
export function sampleField(f: Float32Array, x: number, y: number): number {
  const i0 = Math.floor(x), j0 = Math.floor(y);
  const fx = x - i0, fy = y - j0;
  const a = wrapI(i0), b = wrapI(i0 + 1), r0 = clampJ(j0) * WX_NX, r1 = clampJ(j0 + 1) * WX_NX;
  return f[r0 + a] * (1 - fx) * (1 - fy) + f[r0 + b] * fx * (1 - fy)
       + f[r1 + a] * (1 - fx) * fy + f[r1 + b] * fx * fy;
}

/** Nearest field cell. */
export function fieldIndex(x: number, y: number): number {
  return clampJ(Math.round(y)) * WX_NX + wrapI(Math.round(x));
}

export class WeatherSim {
  vapour = new Float32Array(WX_N);
  cloud = new Float32Array(WX_N);
  ash = new Float32Array(WX_N);
  smog = new Float32Array(WX_N);
  prevCloud = new Float32Array(WX_N);
  prevAsh = new Float32Array(WX_N);
  prevSmog = new Float32Array(WX_N);
  readonly precip = new Float32Array(WX_N);
  readonly convection = new Float32Array(WX_N);
  readonly snow = new Uint8Array(WX_N);
  /**
   * Shower state, 0-1; a shower is under way where it is above 0.5. Continuous
   * so it can be advected bilinearly: a 0/1 flag copied from the nearest source
   * cell never moved, because the air moves ~0.14 cells per step.
   */
  raining = new Float32Array(WX_N);
  /** Fohn dryness, 0+: air that came down a slope. Advected; suppresses showers. */
  dryness = new Float32Array(WX_N);
  time = 0;
  /** Grid longitude of the subsolar point, radians. The host sets it each frame. */
  sunLon = 0;
  anomaly: Anomaly | null = null;
  anomalyCount = 0;

  private nv = new Float32Array(WX_N);
  private nc = new Float32Array(WX_N);
  private na = new Float32Array(WX_N);
  private ns = new Float32Array(WX_N);
  private nr = new Float32Array(WX_N);
  private nd = new Float32Array(WX_N);
  private nextAnomaly = 0;
  /** Per-row constants of step(), rebuilt when the climate object changes. */
  private rowU = new Float64Array(WX_NY);
  private rowV = new Float64Array(WX_NY);
  private rowEnv = new Float64Array(WX_NY);
  private rowCell = new Float64Array(WX_NY);
  private rowCos = new Float64Array(WX_NY);
  private rowTrop = new Float64Array(WX_NY);
  private rowFor: ClimateSources | null = null;
  private anomalyRng: () => number = Math.random;

  constructor(public climate: ClimateSources, readonly ablate: SimAblation = {}) {
    this.reset();
  }

  /** Back to the state of a freshly baked planet. */
  reset(): void {
    for (const f of [this.cloud, this.ash, this.smog, this.prevCloud, this.prevAsh, this.prevSmog,
                     this.precip, this.convection]) f.fill(0);
    this.snow.fill(0);
    this.raining.fill(0);
    this.dryness.fill(0);
    // Start near saturation: from 30% a dry storm world (seed 99) took ~80 s to
    // rain at all, past the 50 s warm-up, so a new planet opened rainless.
    for (let k = 0; k < WX_N; k++) this.vapour[k] = VAPOUR_START * (0.18 + 0.7 * this.climate.temp[k]);
    this.time = 0;
    // Each world's day starts at its own hour, so two seeds do not share a sky.
    this.sunLon = (this.climate.personality.detailOffset / WX_NX) * Math.PI * 2;
    this.anomaly = null;
    this.anomalyCount = 0;
    this.anomalyRng = weatherRng(this.climate.personality.anomalySeed);
    this.nextAnomaly = 300 + this.anomalyRng() * 300;
  }

  /** New sources (lushness, civ level changed). The sky is kept — no teleport. */
  setClimate(c: ClimateSources): void {
    this.climate = c;
  }

  /** Band wind without meander or anomalies, cells/s; +i is eastward. */
  baseWindU(j: number): number {
    if (this.ablate.wind) return 0;
    const g = this.climate.personality.bandGain;
    const a = Math.abs(latOf(j)) * 180 / Math.PI;
    return a < 30 ? -0.55 * g[0] : a < 60 ? 0.6 * g[1] : -0.35 * g[2];
  }

  windU(i: number, j: number): number {
    if (this.ablate.wind) return 0;
    const base = this.baseWindU(j);
    // The meander rides the band: its longitude is the advected coordinate.
    let u = base + 0.3 * Math.sin((i - base * this.time) * 0.25 + this.climate.personality.rowPhase[j]);
    const an = this.anomaly;
    if (an && an.kind === 'reversal' && Math.abs(j - an.j) <= 3) u = -u;
    return u;
  }

  /** Equatorward drift in the tropics, rows/s (+j is southward). */
  private windV(j: number): number {
    if (this.ablate.wind) return 0;
    const lat = latOf(j);
    return Math.abs(lat) < Math.PI / 6 ? Math.sign(lat) * 0.10 : 0;
  }

  /**
   * Row constants: band wind, drift, and the latitude parts of vertical motion.
   * Rising (+) / sinking (-) air is Hadley/Ferrel cells (cellTerm) plus weather
   * systems (env x a wave whose longitude is the advected coordinate i - u*t,
   * so weather systems ride the band wind). A short-wavelength detail term was
   * removed: its 7-cell wavelength aliased against the trades' ~6.6-cell travel
   * per 10 s, so tropical cloud read as stationary.
   */
  private buildRows(): void {
    for (let j = 0; j < WX_NY; j++) {
      this.rowU[j] = this.baseWindU(j);
      this.rowV[j] = this.windV(j);
      const lat = latOf(j), alat = Math.abs(lat);
      this.rowEnv[j] = Math.max(0, 1 - Math.abs(alat - 0.95) / 0.4);
      this.rowCell[j] = 0.85 * Math.cos(6 * lat);
      this.rowCos[j] = Math.cos(lat);
      // Tropics only, fading to nothing at 30 degrees.
      const tr = 1 - alat / (Math.PI / 6);
      this.rowTrop[j] = tr > 0 ? tr : 0;
    }
    this.rowFor = this.climate;
  }

  private near(i: number, j: number, r: number): boolean {
    const an = this.anomaly;
    if (!an) return false;
    const di = Math.min(Math.abs(i - an.i), WX_NX - Math.abs(i - an.i));
    return di <= r && Math.abs(j - an.j) <= r;
  }

  step(dt = WX_DT): void {
    this.time += dt;
    this.sunLon -= (Math.PI * 2 / WX_DAY) * dt;   // the sun moves west
    const c = this.climate;
    const { nv, nc, na, ns, nr, nd } = this;

    // Semi-Lagrangian advection: trace back along the wind, sample bilinearly.
    // windU and sampleField are inlined by hand (same expressions, bit-identical
    // results): as out-of-line calls in this long loop each returned double
    // was boxed, ~130 KB of garbage per step. tools/weatherCheck measures the heap.
    const vap = this.vapour, cl = this.cloud, as = this.ash, sm = this.smog, rain = this.raining, dry = this.dryness;
    if (this.rowFor !== c) this.buildRows();
    const rowU = this.rowU, rowV = this.rowV;
    const rowPhase = c.personality.rowPhase, an = this.anomaly;
    const noWind = !!this.ablate.wind;
    for (let j = 0; j < WX_NY; j++) {
      const v = rowV[j], base = rowU[j];
      const flip = an !== null && an.kind === 'reversal' && Math.abs(j - an.j) <= 3;
      for (let i = 0; i < WX_NX; i++) {
        let u = 0;
        if (!noWind) {
          u = base + 0.3 * Math.sin((i - base * this.time) * 0.25 + rowPhase[j]);
          if (flip) u = -u;
        }
        const x = i - u * dt, y = j - v * dt;
        const k = j * WX_NX + i;
        const i0 = Math.floor(x), j0 = Math.floor(y);
        const fx = x - i0, fy = y - j0;
        const a = wrapI(i0), b = wrapI(i0 + 1), r0 = clampJ(j0) * WX_NX, r1 = clampJ(j0 + 1) * WX_NX;
        nv[k] = vap[r0 + a] * (1 - fx) * (1 - fy) + vap[r0 + b] * fx * (1 - fy)
              + vap[r1 + a] * (1 - fx) * fy + vap[r1 + b] * fx * fy;
        nc[k] = cl[r0 + a] * (1 - fx) * (1 - fy) + cl[r0 + b] * fx * (1 - fy)
              + cl[r1 + a] * (1 - fx) * fy + cl[r1 + b] * fx * fy;
        na[k] = as[r0 + a] * (1 - fx) * (1 - fy) + as[r0 + b] * fx * (1 - fy)
              + as[r1 + a] * (1 - fx) * fy + as[r1 + b] * fx * fy;
        ns[k] = sm[r0 + a] * (1 - fx) * (1 - fy) + sm[r0 + b] * fx * (1 - fy)
              + sm[r1 + a] * (1 - fx) * fy + sm[r1 + b] * fx * fy;
        nr[k] = rain[r0 + a] * (1 - fx) * (1 - fy) + rain[r0 + b] * fx * (1 - fy)
              + rain[r1 + a] * (1 - fx) * fy + rain[r1 + b] * fx * fy;
        nd[k] = dry[r0 + a] * (1 - fx) * (1 - fy) + dry[r0 + b] * fx * (1 - fy)
              + dry[r1 + a] * (1 - fx) * fy + dry[r1 + b] * fx * fy;
      }
    }

    const pressure = this.ablate.stress ? 0 : c.stormPressure;
    const noCycle = !!this.ablate.cycle, noDiurnal = !!this.ablate.diurnal;
    // Stormy air (type or biosphere stress) keeps showers going longer. Starting
    // them sooner instead drained cloud before it could build into storms.
    const showerDecay = 1 / (SHOWER_LIFE * (1 + STORM_SHOWER * pressure));
    const sunLon = this.sunLon, lonStep = Math.PI * 2 / WX_NX;
    const waveNumber = c.personality.waveNumber, noVertical = !!this.ablate.vertical;
    // Clamps in the cell loop are ternaries, not Math.min/max: V8's mid tier
    // (Maglev) boxes Math.min/max results, ~60 KB of garbage per step whenever
    // this function is not running TurboFan code. Same values bit for bit.
    const condense = 2 * dt < 1 ? 2 * dt : 1, clearing = 1 - (0.8 * dt < 1 ? 0.8 * dt : 1);
    for (let j = 0; j < WX_NY; j++) {
      const baseU = rowU[j], env = this.rowEnv[j], cellTerm = this.rowCell[j];
      for (let i = 0; i < WX_NX; i++) {
        const k = j * WX_NX + i;
        const T = c.temp[k];
        nv[k] += dt * 0.06 * (c.water[k] * (0.3 + 0.7 * T) + 0.25 * c.landMoist[k]);

        // Orographic lift: air blowing up the elevation gradient.
        const up = baseU >= 0 ? 1 : -1;
        const slope = (c.elev[j * WX_NX + wrapI(i + up)] - c.elev[j * WX_NX + wrapI(i - up)]) * 0.5;
        const oro = this.ablate.uplift ? 0 : slope > 0 ? slope * 30 : 0;
        // Down the slope the air sinks and warms (fohn) and stays dry downstream
        // for a while (dryness, advected, fading over FOHN_LIFE): no new showers,
        // and ones riding over the ridge die out. Applied to the SHOWERS, not the
        // cloud: evaporating cloud in the lee pinned cloud edges to the terrain
        // and cost ~13 points of drift-with-the-wind. Without it, wind-carried
        // showers rained on the lee as hard as upwind.
        const descent = this.ablate.uplift || slope >= 0 ? 0 : -slope * OROGRAPHIC_DESCENT;
        const d0 = nd[k] * (1 - dt / FOHN_LIFE);
        const lee = descent > d0 ? descent : d0 > 0 ? d0 : 0;
        nd[k] = lee;

        let conv = T * (0.4 + c.water[k] * 0.6) * 0.5 * (1 + 2.5 * pressure);
        if (this.anomaly?.kind === 'supercell' && this.near(i, j, 2)) conv *= 3;
        this.convection[k] = conv;

        const vm = noVertical ? 0
          : cellTerm + 0.9 * env * Math.sin((i - baseU * this.time) * Math.PI * 2 / WX_NX * waveNumber + j * 0.35);
        // Local solar heating: 0 at night, peak at noon; mean over a day 1/pi.
        const sunCos = Math.cos(i * lonStep - sunLon) * this.rowCos[j];
        const heat = noDiurnal ? 1
          : 1 + this.rowTrop[j] * DIURNAL * (Math.PI * (sunCos > 0 ? sunCos : 0) - 1);
        const rawLift = (0.8 * vm + oro + conv * 0.3) * heat;
        const lift = rawLift > 0.8 ? 0.8 : rawLift < -0.6 ? -0.6 : rawLift;
        const rawCap = (0.18 + 0.7 * T) * (1 - lift);
        const cap = rawCap > 0.05 ? rawCap : 0.05;
        if (nv[k] > cap) {
          const d = (nv[k] - cap) * condense;
          nv[k] -= d; nc[k] += d;
        } else {
          const evap = (cap - nv[k]) * CLOUD_EVAP * dt;
          const d = evap < nc[k] ? evap : nc[k];
          nc[k] -= d; nv[k] += d;
        }

        let p = 0;
        if (noCycle) {
          if (nc[k] > 0.42) { p = (nc[k] - 0.42) * 0.35 * dt; nc[k] -= p; }
        } else {
          // Onset needs a built-up cloud (RAIN_ON). Once under way, a shower
          // rides the wind over any cloud above RAIN_OFF until it has aged out
          // (SHOWER_LIFE). A 0.5 cut on the blended state flickered (4 s median
          // spells); refreshing it to 1 while raining let windward slopes under
          // steady inflow rain for the whole hour.
          let r = nr[k];
          if (r <= SHOWER_ALIVE && nc[k] > RAIN_ON * (1 + lee)) r = 1;
          if (r > SHOWER_ALIVE) {
            r -= dt * (showerDecay + lee * LEE_KILL);
            const pr = (nc[k] - RAIN_OFF * 0.5) * RAIN_RATE * dt;
            p = pr > 0 ? pr : 0;
            nc[k] -= p;
            // The downdraft dries the column too. Without this, a vapour pool
            // under steady uplift refilled the cloud as fast as it rained out
            // and ~10% of cells still rained all hour.
            const dv = (nv[k] - cap * RAIN_DRY) * RAIN_RATE * dt;
            if (dv > 0) { nv[k] -= dv; p += dv; }
            if (nc[k] < RAIN_OFF) r = 0;
          }
          nr[k] = r;
        }
        this.precip[k] = p / dt;
        this.snow[k] = !this.ablate.cold && T < COLD ? 1 : 0;
        if (this.anomaly?.kind === 'clearing' && this.near(i, j, 3)) nc[k] *= clearing;

        const v2 = nv[k] * (1 - 0.01 * dt);
        nv[k] = v2 < 2 ? v2 : 2;
        const a2 = na[k] * (1 - 0.05 * dt) + c.ashEmit[k] * 0.5 * dt;
        na[k] = a2 < 1.2 ? a2 : 1.2;
        const s2 = ns[k] * (1 - 0.02 * dt - this.precip[k] * 0.8 * dt) + c.smogEmit[k] * 0.003 * dt;
        ns[k] = s2 < 0 ? 0 : s2 > 1 ? 1 : s2;
        if (nc[k] > 1.4) nc[k] = 1.4;
      }
    }

    // Rotate buffers: prev <- current, current <- next, next <- old prev.
    let t = this.prevCloud; this.prevCloud = this.cloud; this.cloud = nc; this.nc = t;
    t = this.prevAsh; this.prevAsh = this.ash; this.ash = na; this.na = t;
    t = this.prevSmog; this.prevSmog = this.smog; this.smog = ns; this.ns = t;
    t = this.vapour; this.vapour = nv; this.nv = t;
    const tr = this.raining; this.raining = nr; this.nr = tr;
    const td = this.dryness; this.dryness = nd; this.nd = td;

    this.scheduleAnomaly();
  }

  private scheduleAnomaly(): void {
    if (this.ablate.anomalies) return;
    if (this.anomaly && this.time >= this.anomaly.until) this.anomaly = null;
    if (this.anomaly || this.time < this.nextAnomaly) return;
    const r = this.anomalyRng;
    const roll = r();
    const kind: AnomalyKind = roll < 0.4 ? 'supercell' : roll < 0.7 ? 'reversal' : 'clearing';
    const dur = kind === 'supercell' ? 60 : kind === 'reversal' ? 30 : 45;
    this.anomaly = { kind, i: Math.floor(r() * WX_NX), j: 6 + Math.floor(r() * (WX_NY - 12)), until: this.time + dur };
    this.anomalyCount++;
    this.nextAnomaly = this.time + 300 + r() * 300;
  }

  /**
   * Spin up to the climate's steady state. Coarse steps (WX_WARMUP_DT): at the
   * frame step, 200 steps (50 s) ended well short of equilibrium (ocean cloud
   * 0.27 vs 0.33 settled), so a new planet opened on a transient sky.
   */
  warmUp(steps = WX_WARMUP): void {
    for (let n = 0; n < steps; n++) this.step(WX_WARMUP_DT);
  }
}

/**
 * What the sky at field cell k reads as. Kinds fall out of the channels.
 * STORM is raining (cloud above the 0.45 precip threshold) and strongly
 * convective. Precipitation drains cloud above 0.45, so a higher cloud gate
 * (the old 0.75) was unreachable and no storm ever formed.
 */
export function kindAt(sim: WeatherSim, k: number): number {
  const c = sim.cloud[k], a = sim.ash[k], s = sim.smog[k];
  if (c + a + s < 0.05) return WK.CLEAR;
  if (a >= c && a >= s) return WK.ASH;
  if (s > 0.25 && s > c * 1.5) return WK.SMOG;
  if (c > 0.45 && sim.convection[k] > 0.45) return WK.STORM;
  if (sim.snow[k]) return WK.ICE;
  return WK.CUMULUS;
}
