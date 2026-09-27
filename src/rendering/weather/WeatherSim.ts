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
/** Below this effective temperature, precipitation is snow. */
export const COLD = 0.3;
/** Rate at which sub-saturated air re-evaporates cloud, per second per unit deficit. */
export const CLOUD_EVAP = 1.5;

export interface SimAblation {
  uplift?: boolean; vertical?: boolean; cold?: boolean;
  stress?: boolean; wind?: boolean; anomalies?: boolean;
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
  time = 0;
  anomaly: Anomaly | null = null;
  anomalyCount = 0;

  private nv = new Float32Array(WX_N);
  private nc = new Float32Array(WX_N);
  private na = new Float32Array(WX_N);
  private ns = new Float32Array(WX_N);
  private nextAnomaly = 0;
  private anomalyRng: () => number = Math.random;

  constructor(public climate: ClimateSources, readonly ablate: SimAblation = {}) {
    this.reset();
  }

  /** Back to the state of a freshly baked planet. */
  reset(): void {
    for (const f of [this.cloud, this.ash, this.smog, this.prevCloud, this.prevAsh, this.prevSmog,
                     this.precip, this.convection]) f.fill(0);
    this.snow.fill(0);
    for (let k = 0; k < WX_N; k++) this.vapour[k] = 0.3 * (0.18 + 0.7 * this.climate.temp[k]);
    this.time = 0;
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
   * Rising (+) / sinking (-) air: Hadley/Ferrel cells plus weather systems.
   * The wave term takes its longitude from the advected coordinate i - u*t,
   * so weather systems ride the band wind. (A short-wavelength detail term
   * was removed: its 7-cell wavelength aliased against the trades' ~6.6-cell
   * travel per 10 s, so tropical cloud read as stationary.)
   */
  private verticalMotion(i: number, j: number): number {
    if (this.ablate.vertical) return 0;
    const p = this.climate.personality;
    const lat = latOf(j), alat = Math.abs(lat);
    const x = i - this.baseWindU(j) * this.time;
    const env = Math.max(0, 1 - Math.abs(alat - 0.95) / 0.4);
    return 0.85 * Math.cos(6 * lat)
      + 0.9 * env * Math.sin(x * Math.PI * 2 / WX_NX * p.waveNumber + j * 0.35);
  }

  private near(i: number, j: number, r: number): boolean {
    const an = this.anomaly;
    if (!an) return false;
    const di = Math.min(Math.abs(i - an.i), WX_NX - Math.abs(i - an.i));
    return di <= r && Math.abs(j - an.j) <= r;
  }

  step(dt = WX_DT): void {
    this.time += dt;
    const c = this.climate;
    const { nv, nc, na, ns } = this;

    // Semi-Lagrangian advection: trace back along the wind, sample bilinearly.
    for (let j = 0; j < WX_NY; j++) {
      const v = this.windV(j);
      for (let i = 0; i < WX_NX; i++) {
        const x = i - this.windU(i, j) * dt, y = j - v * dt;
        const k = j * WX_NX + i;
        nv[k] = sampleField(this.vapour, x, y);
        nc[k] = sampleField(this.cloud, x, y);
        na[k] = sampleField(this.ash, x, y);
        ns[k] = sampleField(this.smog, x, y);
      }
    }

    const pressure = this.ablate.stress ? 0 : c.stormPressure;
    for (let j = 0; j < WX_NY; j++) {
      for (let i = 0; i < WX_NX; i++) {
        const k = j * WX_NX + i;
        const T = c.temp[k];
        nv[k] += dt * 0.06 * (c.water[k] * (0.3 + 0.7 * T) + 0.25 * c.landMoist[k]);

        // Orographic lift: air blowing up the elevation gradient.
        const up = this.baseWindU(j) >= 0 ? 1 : -1;
        const slope = (c.elev[j * WX_NX + wrapI(i + up)] - c.elev[j * WX_NX + wrapI(i - up)]) * 0.5;
        const oro = this.ablate.uplift ? 0 : Math.max(0, slope) * 30;

        let conv = T * (0.4 + c.water[k] * 0.6) * 0.5 * (1 + 2.5 * pressure);
        if (this.anomaly?.kind === 'supercell' && this.near(i, j, 2)) conv *= 3;
        this.convection[k] = conv;

        const lift = Math.min(0.8, Math.max(-0.6,
          0.8 * this.verticalMotion(i, j) + oro + conv * 0.3));
        const cap = Math.max(0.05, (0.18 + 0.7 * T) * (1 - lift));
        if (nv[k] > cap) {
          const d = (nv[k] - cap) * Math.min(1, 2 * dt);
          nv[k] -= d; nc[k] += d;
        } else {
          const d = Math.min(nc[k], (cap - nv[k]) * CLOUD_EVAP * dt);
          nc[k] -= d; nv[k] += d;
        }

        let p = 0;
        if (nc[k] > 0.42) { p = (nc[k] - 0.42) * 0.35 * dt; nc[k] -= p; }
        this.precip[k] = p / dt;
        this.snow[k] = !this.ablate.cold && T < COLD ? 1 : 0;
        if (this.anomaly?.kind === 'clearing' && this.near(i, j, 3)) nc[k] *= 1 - Math.min(1, 0.8 * dt);

        nv[k] = Math.min(2, nv[k] * (1 - 0.01 * dt));
        na[k] = Math.min(1.2, na[k] * (1 - 0.05 * dt) + c.ashEmit[k] * 0.5 * dt);
        ns[k] = Math.min(1, Math.max(0,
          ns[k] * (1 - 0.02 * dt - this.precip[k] * 0.8 * dt) + c.smogEmit[k] * 0.003 * dt));
        nc[k] = Math.min(1.4, nc[k]);
      }
    }

    // Rotate buffers: prev <- current, current <- next, next <- old prev.
    let t = this.prevCloud; this.prevCloud = this.cloud; this.cloud = nc; this.nc = t;
    t = this.prevAsh; this.prevAsh = this.ash; this.ash = na; this.na = t;
    t = this.prevSmog; this.prevSmog = this.smog; this.smog = ns; this.ns = t;
    t = this.vapour; this.vapour = nv; this.nv = t;

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

  warmUp(steps = WX_WARMUP): void {
    for (let n = 0; n < steps; n++) this.step(WX_DT);
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
