/**
 * The weather sim: a 64x32 field over the whole planet, stepped at 4 Hz.
 *
 * Pure and deterministic. Visual only — nothing here feeds back into the
 * simulation. Every physics term has an ablation switch so tools/weatherCheck
 * can prove each metric measures the term it claims to.
 */
import { WeatherEvents } from './WeatherEvents';
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
 * strong in the afternoon, averaging 1 over a day AT THE EQUATOR AT EQUINOX
 * (sunLat = 0) — off the equator, or away from equinox, the row's own
 * subsolar geometry (rowCos/rowSin against sunLat) shifts that mean. Without
 * it the equatorial rising band never let up and its cells rained for the
 * whole hour. Weighted to the tropics around the subsolar latitude (1 there,
 * 0 from 30 degrees away): tropical convection follows the sun; mid-latitude
 * weather is frontal and rides the band wind.
 */
export const DIURNAL = 0.6;
/** Seconds per day when nothing drives the sun (headless runs); the host sets `sunLon`. */
export const WX_DAY = 45;

/**
 * Seasons. The weather's subsolar point sits at latitude `sunLat` (the host sets
 * it from the orbit's declination). Snow decides on a temperature shifted by
 * SEASON_T at full tilt — the winter hemisphere colder, the summer one warmer.
 */
export const SEASON_T = 0.15;
/** Tilt at which the snow shift reaches SEASON_T (the largest tilt a world rolls). */
export const SEASON_REF = (35 * Math.PI) / 180;
/** The tropical rain belt follows the subsolar latitude at half its swing, like Earth's. */
export const ITCZ_FOLLOW = 0.5;

export interface SimAblation {
  uplift?: boolean; vertical?: boolean; cold?: boolean;
  stress?: boolean; wind?: boolean; anomalies?: boolean;
  /** No shower cycle: rain whenever cloud exceeds one threshold (the old sim). */
  cycle?: boolean;
  /** No day cycle: rising air is the same at noon and midnight. */
  diurnal?: boolean;
  /** No seasons: sunLat is ignored — the tropics, Hadley cell, solar heating and snow line behave as at equinox. */
  seasons?: boolean;
}

export const WK = {
  CLEAR: 0, CUMULUS: 1, STORM: 2, ICE: 3, ASH: 4, SMOG: 5,
  STRATUS: 6, CIRRUS: 7, CAP: 8,
} as const;

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
  /** Subsolar latitude, radians. The host sets it from the orbit; 0 standalone. */
  sunLat = 0;
  anomaly: Anomaly | null = null;
  anomalyCount = 0;
  /** Tornadoes and typhoons (own random stream; they never touch the fields). */
  readonly events = new WeatherEvents(0);

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
  private rowSin = new Float64Array(WX_NY);
  private rowLat = new Float64Array(WX_NY);
  private rowSnow = new Float64Array(WX_NY);
  private rowFor: ClimateSources | null = null;
  private anomalyRng: () => number = Math.random;
  /**
   * A few drifting rain regions. Without them the Hadley belt kept dozens of
   * speckles raining on both hemispheres for the whole hour, so the diorama
   * never cleared. Desert worlds (raininess 0) have none.
   */
  private readonly sysX = new Float64Array(6);
  private readonly sysY = new Float64Array(6);
  /** >0 seconds of rain left; <0 seconds of clear left. */
  private readonly sysT = new Float64Array(6);
  private sysN = 0;
  private rainRng: () => number = () => 0;
  /** Windward standing cloud. The lee is 0, apart from a one-cell banner. */
  readonly highCloud = new Float32Array(WX_N);
  /** 0–1 lee of a slope. The painter thins a passing mass here. */
  readonly leeCloud = new Float32Array(WX_N);
  /** Water-cloud kind per cell, written in step. Ash and smog are not in here. */
  readonly form = new Uint8Array(WX_N);
  /** Scratch for seedCover, so the painter's per-cell query does not allocate. */
  private coverM = 0;
  private coverAhead = false;

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
    this.sunLat = 0;
    this.anomaly = null;
    this.anomalyCount = 0;
    this.anomalyRng = weatherRng(this.climate.personality.anomalySeed);
    this.events.reset(this.climate.personality.anomalySeed);
    this.nextAnomaly = 300 + this.anomalyRng() * 300;
    this.rainRng = weatherRng((this.climate.personality.anomalySeed ^ 0x51a15eed) >>> 0);
    this.sysN = this.rainRegionCount();
    for (let s = 0; s < this.sysT.length; s++) this.sysT[s] = 0;
    for (let s = 0; s < this.sysN; s++) {
      this.placeRainRegion(s);
      // Stagger a normal world so both hemispheres are not wet together.
      this.sysT[s] = this.rainLife();
    }
    this.buildHighland();
    this.writeForms();
  }

  /**
   * Cloud on the slope the wind is climbing, then a short banner over the
   * crest. The lee stays clear. A flat plateau does not cap just for being high,
   * and a dry world only caps its steepest rises.
   */
  private buildHighland(): void {
    const elev = this.climate.elev;
    const rainy = this.climate.raininess ?? 1;
    const gain = rainy <= 0 ? 0.5 : rainy >= 1.5 ? 1 : 0.82;
    const rise = new Float32Array(WX_N);
    const SLOPE_LO = 0.012, SLOPE_HI = 0.028;
    for (let j = 0; j < WX_NY; j++) {
      const dir = this.baseWindU(j) >= 0 ? 1 : -1;
      for (let i = 0; i < WX_NX; i++) {
        const k = j * WX_NX + i;
        const upE = elev[j * WX_NX + wrapI(i - dir)];
        const dnE = elev[j * WX_NX + wrapI(i + dir)];
        const here = elev[k];
        const slope = (dnE - upE) * 0.5;
        const t = (slope - SLOPE_LO) / (SLOPE_HI - SLOPE_LO);
        const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
        const tall = (here - 0.56) / 0.2;
        const hgt = tall <= 0 ? 0 : tall >= 1 ? 1 : tall;
        let cap = u * (0.4 + 0.6 * hgt) * gain;
        // The summit itself, not only the climb. A flat top still stays clear;
        // the slope downwind of the crest is the lee and is left alone.
        if (slope > -SLOPE_LO && here > upE + 0.008 && here >= dnE) {
          const climb = (here - upE - 0.008) / 0.018;
          const cU = climb <= 0 ? 0 : climb >= 1 ? 1 : climb;
          const crest = cU * (0.55 + 0.45 * hgt) * gain;
          if (crest > cap) cap = crest;
        }
        rise[k] = cap;
        const leeT = (-slope - SLOPE_LO) / (SLOPE_HI - SLOPE_LO);
        this.leeCloud[k] = slope >= -SLOPE_LO ? 0 : leeT >= 1 ? 1 : leeT <= 0 ? 0 : leeT;
      }
    }
    this.highCloud.set(rise);
    // One cell downwind of a windward face: the cloud streams off the crest, then stops.
    for (let j = 0; j < WX_NY; j++) {
      const dir = this.baseWindU(j) >= 0 ? 1 : -1;
      for (let i = 0; i < WX_NX; i++) {
        const src = rise[j * WX_NX + wrapI(i - dir)];
        if (src <= 0.42) continue;
        const k = j * WX_NX + i;
        const banner = src * 0.5;
        if (banner > this.highCloud[k]) this.highCloud[k] = banner;
        this.leeCloud[k] = 0;
      }
    }
  }

  /** 0–1 standing cloud. Windward slopes and the crest banner; the lee is 0. */
  highland(i: number, j: number): number {
    return this.highCloud[j * WX_NX + i];
  }

  /** 0–1 downslope. A weather mass thins as it crosses onto this side. */
  lee(i: number, j: number): number {
    return this.leeCloud[j * WX_NX + i];
  }

  cloudKind(i: number, j: number): number {
    return this.form[j * WX_NX + i];
  }

  /**
   * Which water cloud to draw, stored on `form`. Ash and smog are decided by
   * `kindAt` and win over this. A mass leads with cirrus, holds cumulus in the
   * tropics and stratus in the westerlies, and a windward slope wears a cap.
   * Inlined: a per-cell call from the painter boxed its return and grew the heap.
   */
  private writeForms(): void {
    const rainy = this.climate.raininess ?? 1;
    // Desert keeps its one small wisp. Wetter skies are a little wider so the
    // typical view holds more cloud without closing the gaps.
    const rx = rainy <= 0 ? 4.5 : rainy >= 1.5 ? 10.5 : 8.4;
    const ry = rainy <= 0 ? 2 : rainy >= 1.5 ? 4.6 : 3.8;
    const rx2 = rx * rx, ry2 = ry * ry;
    const rrx = rainy >= 1.5 ? 7 : 5, rry = rainy >= 1.5 ? 3.2 : 2.4;
    const rrx2 = rrx * rrx, rry2 = rry * rry;
    const dry = rainy <= 0;
    // Only the slots that exist (see seedCover): reading the missing 7th slot
    // made every load in this loop generic and boxed, ~38 KB of garbage a frame.
    const n = Math.min(this.sysN, this.sysT.length), sx = this.sysX, sy = this.sysY, st = this.sysT;
    const hi = this.highCloud, snow = this.snow, conv = this.convection, form = this.form;
    for (let j = 0; j < WX_NY; j++) {
      const wind = this.baseWindU(j);
      const west = Math.abs(latOf(j)) > 0.5;
      for (let i = 0; i < WX_NX; i++) {
        let best = 0, ahead = false, rain = 0;
        for (let s = 0; s < n; s++) {
          if (st[s] <= 0) continue;
          let di = i - sx[s];
          if (di > 32) di -= WX_NX; else if (di < -32) di += WX_NX;
          const dj = j - sy[s];
          const e = (di * di) / rx2 + (dj * dj) / ry2;
          if (e < 1) {
            const m = e <= 0.62 ? 1 : (1 - e) / 0.38;
            if (m > best) {
              best = m;
              ahead = e > 0.5 && (wind >= 0 ? di > 1.2 : di < -1.2);
            }
          }
          if (!dry) {
            const er = (di * di) / rrx2 + (dj * dj) / rry2;
            if (er < 1) {
              const mr = er <= 0.62 ? 1 : (1 - er) / 0.38;
              if (mr > rain) rain = mr;
            }
          }
        }
        const k = j * WX_NX + i;
        const h = hi[k];
        form[k] = best < 0.12 && h < 0.2 ? WK.CLEAR
          : snow[k] && (best > 0.2 || h > 0.2) ? WK.ICE
          : rain > 0.4 && conv[k] > 0.3 ? WK.STORM
          : h >= 0.32 && h >= best * 0.85 ? WK.CAP
          : ahead && best < 0.92 ? WK.CIRRUS
          : west && best > 0.55 ? WK.STRATUS
          : WK.CUMULUS;
      }
    }
  }

  /** Strongest seed at this cell, and whether that cover is the downwind rim. */
  private seedCover(i: number, j: number, rain: boolean): void {
    const rainy = this.climate.raininess ?? 1;
    this.coverM = 0;
    this.coverAhead = false;
    if (rain && rainy <= 0) return;
    const rx = rain ? (rainy >= 1.5 ? 7 : 5) : (rainy <= 0 ? 4.5 : rainy >= 1.5 ? 10.5 : 8.4);
    const ry = rain ? (rainy >= 1.5 ? 3.2 : 2.4) : (rainy <= 0 ? 2 : rainy >= 1.5 ? 4.6 : 3.8);
    const rx2 = rx * rx, ry2 = ry * ry;
    const wind = this.baseWindU(j);
    // Only the slots that exist: a wet climate counts 7 regions
    // (rainRegionCount) but there are 6 slots, and reading slot 6 (undefined)
    // turned every load in this loop generic, so each di / dj / e was a boxed
    // heap number (~8 KB of garbage per painter frame). Slot 6 never covered
    // a cell (its NaN distance fails e < 1), so skipping it changes nothing.
    const n = Math.min(this.sysN, this.sysT.length), sx = this.sysX, sy = this.sysY, st = this.sysT;
    for (let s = 0; s < n; s++) {
      if (st[s] <= 0) continue;
      let di = i - sx[s];
      if (di > 32) di -= WX_NX; else if (di < -32) di += WX_NX;
      const dj = j - sy[s];
      const e = (di * di) / rx2 + (dj * dj) / ry2;
      if (e < 1) {
        const m = e <= 0.62 ? 1 : (1 - e) / 0.38;
        if (m > this.coverM) {
          this.coverM = m;
          this.coverAhead = e > 0.5 && (wind >= 0 ? di > 1.2 : di < -1.2);
        }
      }
    }
  }

  /**
   * How many cloud seeds this climate keeps. A desert still has one small
   * wisp (the sky must not be a dead field) but it does not rain.
   */
  private rainRegionCount(): number {
    const rainy = this.climate.raininess ?? 1;
    // A normal world gets several scattered masses, not one puff and not a sheet.
    return rainy <= 0 ? 1 : rainy >= 0.7 ? 7 : 5;
  }

  private placeRainRegion(s: number): void {
    const r = this.rainRng;
    // Evenly around the planet, with a little jitter. A random pile can sit
    // entirely on the far side, so the hemisphere you are looking at is bare.
    const n = this.sysN > 0 ? this.sysN : 1;
    this.sysX[s] = ((s + r()) / n) * WX_NX;
    if (this.sysX[s] >= WX_NX) this.sysX[s] -= WX_NX;
    // Even seeds in the tropics, odd ones in the westerlies: the two belts
    // where a real sky actually builds cloud.
    if ((s & 1) === 0) this.sysY[s] = 10 + r() * 12;
    else this.sysY[s] = r() < 0.5 ? 5 + r() * 4 : 23 + r() * 4;
  }

  private rainLife(): number {
    const rainy = this.climate.raininess ?? 1;
    const span = this.rainRng();
    // Longer than the 200 s warm-up, so a new world opens with its clouds
    // already seeded instead of in the gap between systems.
    return rainy >= 1.5 ? 280 + span * 140 : 240 + span * 120;
  }

  private rainGap(): number {
    const rainy = this.climate.raininess ?? 1;
    const span = this.rainRng();
    // A rainy world barely pauses. A normal world clears for a stretch.
    return rainy >= 1.5 ? 6 + span * 8 : 18 + span * 22;
  }

  /**
   * 0–1 coverage of a drifting cloud seed at field cell (i, j).
   * `rain` is the smaller core, and is always 0 on a dry world.
   * The sim still runs a full field; the painter uses this so the drifting
   * masses are drawn, plus the standing cap on high ground (`highland`).
   * A sheet of cloud never reaches the glass.
   */
  seedMask(i: number, j: number, rain: boolean): number {
    this.seedCover(i, j, rain);
    return this.coverM;
  }

  /**
   * `seedMask` for every field cell, written into `cloud` (rain false) and
   * `rain` (rain true), WX_N each — the painter's per-frame path. A double
   * returned from a call that is not inlined is boxed: per-cell `seedMask`
   * calls in the painter's WX_N loop were ~1.2 MB of garbage per thousand
   * frames (zoomCheck "weather painter with a moving view").
   */
  fillSeedMasks(cloud: Float64Array, rain: Float64Array): void {
    for (let k = 0; k < WX_N; k++) {
      const i = k % WX_NX, j = (k / WX_NX) | 0;
      this.seedCover(i, j, false);
      cloud[k] = this.coverM;
      this.seedCover(i, j, true);
      rain[k] = this.coverM;
    }
  }

  /** Drift live regions with the band wind; respawn them after their clear gap. */
  private advanceRainRegions(dt: number): void {
    const n = this.rainRegionCount();
    this.sysN = n;
    for (let s = 0; s < n; s++) {
      const t = this.sysT[s];
      if (t > 0) {
        const j = clampJ(Math.round(this.sysY[s]));
        // Inlined band wind (same as baseWindU). A call per step is fine; this
        // stays inline so a returned number is not boxed on the frame path.
        const g = this.climate.personality.bandGain;
        const alat = Math.abs(latOf(j)) * 180 / Math.PI;
        const u = this.ablate.wind ? 0 : alat < 30 ? -0.55 * g[0] : alat < 60 ? 0.6 * g[1] : -0.35 * g[2];
        this.sysX[s] += u * dt;
        if (this.sysX[s] >= WX_NX) this.sysX[s] -= WX_NX;
        else if (this.sysX[s] < 0) this.sysX[s] += WX_NX;
        const left = t - dt;
        // A dry world keeps its one wisp; it drifts, it does not vanish.
        if ((this.climate.raininess ?? 1) <= 0) this.sysT[s] = left > 30 ? left : this.rainLife();
        else this.sysT[s] = left > 0 ? left : -this.rainGap();
      } else {
        const left = t + dt;
        if (left < 0) this.sysT[s] = left;
        else {
          this.placeRainRegion(s);
          this.sysT[s] = this.rainLife();
        }
      }
    }
  }

  /** New sources (lushness, civ level changed). The sky is kept — no teleport. */
  setClimate(c: ClimateSources): void {
    this.climate = c;
    this.buildHighland();
    this.writeForms();
  }

  /** Band wind without meander or anomalies, cells/s; +i is eastward. */
  /** A raining storm cell (kind STORM) or a shower under way at field cell k: where tornadoes drop. */
  isStorm(k: number): boolean {
    if (this.snow[k]) return false;             // no tornado out of a snow squall
    return this.raining[k] > 0.5 || kindAt(this, k) === WK.STORM;
  }

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
   * Row constants: band wind, drift, and the latitude part of weather systems
   * (env x a wave whose longitude is the advected coordinate i - u*t, so
   * weather systems ride the band wind). A short-wavelength detail term was
   * removed: its 7-cell wavelength aliased against the trades' ~6.6-cell travel
   * per 10 s, so tropical cloud read as stationary. rowCell (the Hadley/Ferrel
   * rising/sinking term) is NOT built here: it follows the sun and is
   * recomputed every step, in the season-terms loop.
   */
  private buildRows(): void {
    for (let j = 0; j < WX_NY; j++) {
      this.rowU[j] = this.baseWindU(j);
      this.rowV[j] = this.windV(j);
      const lat = latOf(j), alat = Math.abs(lat);
      this.rowEnv[j] = Math.max(0, 1 - Math.abs(alat - 0.95) / 0.4);
      this.rowCos[j] = Math.cos(lat);
      this.rowSin[j] = Math.sin(lat);
      this.rowLat[j] = lat;
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
    this.advanceRainRegions(dt);
    // No-seasons ablation: sunLat is ignored, so the tropics, Hadley cell,
    // solar heating and snow line behave as at equinox (SimAblation.seasons).
    const sunLat = this.ablate.seasons ? 0 : this.sunLat;
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
    // Season terms follow sunLat EVERY step — buildRows only reruns when the
    // climate object changes, so caching them there would freeze the seasons.
    // (sunLat itself is the top-of-step local, already zeroed under the
    // `seasons` ablation.)
    const cosSL = Math.cos(sunLat), sinSL = Math.sin(sunLat);
    const snowGain = (SEASON_T * sinSL) / Math.sin(SEASON_REF);
    for (let j = 0; j < WX_NY; j++) {
      const dl = this.rowLat[j] - sunLat;
      const tr = 1 - (dl < 0 ? -dl : dl) / (Math.PI / 6);   // tropics centred on the sun, fading at 30 deg
      this.rowTrop[j] = tr > 0 ? tr : 0;
      this.rowSnow[j] = snowGain * this.rowSin[j];
      // The Hadley rising branch follows the sun too, at half its swing (ITCZ_FOLLOW).
      this.rowCell[j] = 0.85 * Math.cos(6 * (this.rowLat[j] - ITCZ_FOLLOW * sunLat));
    }
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
        const sunCos = this.rowCos[j] * cosSL * Math.cos(i * lonStep - sunLon) + this.rowSin[j] * sinSL;
        const heat = noDiurnal ? 1
          : 1 + this.rowTrop[j] * DIURNAL * (Math.PI * (sunCos > 0 ? sunCos : 0) - 1);
        // Solar heating drives convection; it must not deepen subsidence (it
        // did, and at sunLat 35 deg the westerlies stopped raining entirely —
        // the synthetic rain-shadow check went NaN under --solstice). Named
        // riseTerm, not `up`: that name is already the orographic wind sign above.
        const riseTerm = 0.8 * vm + oro + conv * 0.3;
        const rawLift = riseTerm > 0 ? riseTerm * heat : riseTerm;
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
        let r = nr[k];
        if (noCycle) {
          if (nc[k] > 0.42) { p = (nc[k] - 0.42) * 0.35 * dt; nc[k] -= p; }
        } else {
          // Onset needs a built-up cloud (RAIN_ON). Once under way, a shower
          // rides the wind over any cloud above RAIN_OFF until it has aged out
          // (SHOWER_LIFE). A 0.5 cut on the blended state flickered (4 s median
          // spells); refreshing it to 1 while raining let windward slopes under
          // steady inflow rain for the whole hour.
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
        }
        nr[k] = r;
        this.precip[k] = p / dt;
        this.snow[k] = !this.ablate.cold && T + this.rowSnow[j] < COLD ? 1 : 0;
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
    this.events.step(this, dt);
    this.writeForms();
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
