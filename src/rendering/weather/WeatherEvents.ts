/**
 * Severe weather: each kind of world brews its own.
 *
 * World state, in weather-field coordinates (x: column, wraps; y: row), so
 * every painter — identity or zoom camera — draws the same storm in the same
 * place. Stepped by WeatherSim on its own random stream: adding them leaves
 * the cloud, rain and wind fields exactly as they were.
 *
 * | world                         | its storms                                   |
 * |-------------------------------|----------------------------------------------|
 * | ocean, rocky, toxic, crystal, | tornadoes out of storms over land; typhoons  |
 * | carbon                        | over warm tropical sea (tinted to the sky)   |
 * | storm                         | supercells (a rotating tower dropping a      |
 * |                               | funnel) and hypercanes (outsized typhoons)   |
 * | desert                        | dust devils on hot ground; haboobs (rolling  |
 * |                               | walls of dust) riding the wind               |
 * | ice                           | blizzards: polar lows full of driving snow   |
 * | lava                          | fire whirls spun up over the heat            |
 * | gas                           | none (no surface)                            |
 */
import { WX_NX, WX_NY, weatherRng, type ClimateSources } from './WeatherClimate';

export const VX = {
  TORNADO: 0, TYPHOON: 1, DUST_DEVIL: 2, HABOOB: 3, BLIZZARD: 4, SUPERCELL: 5, FIRE_WHIRL: 6,
} as const;

/** The name a kind goes by (dev preview `?storm=`). */
export const VX_NAMES = ['tornado', 'typhoon', 'dust_devil', 'haboob', 'blizzard', 'supercell', 'fire_whirl'] as const;

/** Colour treatment of a vortex, from its world. */
export const VSTYLE = { PLAIN: 0, ACID: 1, SOOT: 2, PRISM: 3, HYPER: 4 } as const;

export interface Vortex {
  kind: number;
  /** VSTYLE: tint (toxic, carbon, crystal) or the storm world's hypercane. */
  style: number;
  /** Field coordinates of the centre (x wraps, y clamps). */
  x: number; y: number;
  /** Seconds since it formed, and its full life. */
  age: number; life: number;
  /** Radius in field cells (spiral, wall cloud, dust front half-length). */
  r: number;
  /** +1 counter-clockwise on screen, -1 clockwise (hemisphere). */
  spin: number;
  /** Direction of travel: along x (+1 east), or for a haboob along y (+1 south); its front faces it. */
  dir: number;
  /** 0-1 strength: grows in, fades out, drops off its home ground. */
  power: number;
  /** Per-event seed for the painters' detail. */
  seed: number;
}

/** What WeatherEvents needs from the sim each step. */
export interface VortexHost {
  readonly time: number;
  climate: ClimateSources;
  /** Raining storm cell (kind STORM), or a shower under way, at field cell k. */
  isStorm(k: number): boolean;
  windU(i: number, j: number): number;
}

/** One kind of storm a world can brew. */
interface Brew {
  kind: number;
  /** Chance per spawn roll (ROLL_EVERY s; 1800 rolls an hour), from the climate. */
  chance: (c: ClimateSources) => number;
  max: number;
}

/**
 * Per world: what it brews, how often. Rates per hour at 1800 rolls:
 * tornado ~4 on an ordinary world, typhoon ~2-3 on an ocean world;
 * storm world ~12 supercells and ~6 hypercanes; desert ~40 dust devils and
 * ~4 haboobs; ice ~6 blizzards; lava ~20 fire whirls.
 */
const TORNADO: Brew = { kind: VX.TORNADO, chance: c => 0.0005 + 0.019 * c.stormPressure, max: 2 };
const TYPHOON: Brew = { kind: VX.TYPHOON, chance: c => 0.0028 * (0.4 + c.stormPressure) * Math.min(1.5, c.raininess), max: 1 };
const BREWS: Record<string, Brew[]> = {
  ocean: [TORNADO, TYPHOON], rocky: [TORNADO, TYPHOON], toxic: [TORNADO, TYPHOON],
  crystal: [TORNADO, TYPHOON], carbon: [TORNADO, TYPHOON],
  storm: [
    { kind: VX.SUPERCELL, chance: () => 0.007, max: 1 },
    { kind: VX.TYPHOON, chance: () => 0.0035, max: 1 },
  ],
  desert: [
    { kind: VX.DUST_DEVIL, chance: () => 0.025, max: 3 },
    { kind: VX.HABOOB, chance: () => 0.0022, max: 1 },
  ],
  ice: [{ kind: VX.BLIZZARD, chance: () => 0.0035, max: 1 }],
  lava: [{ kind: VX.FIRE_WHIRL, chance: () => 0.012, max: 2 }],
};

/** Grow-in and fade-out seconds per kind. */
const GROW = [2.5, 8, 1.2, 6, 8, 6, 2];
const FADE = [3, 12, 1.5, 8, 10, 6, 2.5];

const STYLE_OF: Record<string, number> = {
  toxic: VSTYLE.ACID, carbon: VSTYLE.SOOT, crystal: VSTYLE.PRISM, storm: VSTYLE.HYPER,
};

/** Seconds between spawn rolls. */
const ROLL_EVERY = 2;

export class WeatherEvents {
  readonly list: Vortex[] = [];
  private rng: () => number;
  // -0, not 0: V8 stores 0 as a small integer and later rolls as doubles, and
  // that field change kept deoptimising the cloud painter that reads this
  // object every frame (garbage each frame). -0 is a double from the start
  // and compares exactly like 0.
  private nextRoll = -0;

  constructor(seed: number) {
    this.rng = weatherRng((seed ^ 0x70f00d5) >>> 0);
  }

  reset(seed: number): void {
    this.list.length = 0;
    this.rng = weatherRng((seed ^ 0x70f00d5) >>> 0);
    this.nextRoll = -0;
  }

  count(kind: number): number {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) if (this.list[i].kind === kind) n++;
    return n;
  }

  /** The kinds this world brews (dev: what `?storm=` may force). */
  static kindsFor(planetType: string | undefined): number[] {
    return (BREWS[planetType ?? 'rocky'] ?? []).map(b => b.kind);
  }

  /** Force one (dev preview / tests): at the best spot for its kind, or (x, y). */
  force(host: VortexHost, kind: number, x?: number, y?: number): Vortex | null {
    const spot = x !== undefined && y !== undefined ? { x, y } : this.findSpot(host, kind, true);
    if (!spot) return null;
    const v = this.make(host, kind, spot.x, spot.y);
    this.list.push(v);
    return v;
  }

  step(host: VortexHost, dt: number): void {
    const c = host.climate;
    for (let n = this.list.length - 1; n >= 0; n--) {
      const v = this.list[n];
      v.age += dt;
      const i = ((Math.floor(v.x) % WX_NX) + WX_NX) % WX_NX, j = clampRow(Math.floor(v.y));
      const k = j * WX_NX + i;
      const sea = c.water[k] > 0.5, u = host.windU(i, j);
      switch (v.kind) {
        case VX.TYPHOON:
          // Trade winds carry it west; it curves poleward as it ages; land starves it.
          v.x += (u * 0.6 - 0.05) * dt;
          v.y += (v.y < WX_NY / 2 ? -1 : 1) * 0.012 * dt;
          if (!sea) v.age += dt * 3;
          break;
        case VX.HABOOB:
          // A gust front out of the desert's heat: its wall runs east-west and
          // rolls north or south (dir), drifting with the band wind.
          v.y += v.dir * 0.16 * dt;
          v.x += u * 0.3 * dt;
          if (sea) v.age += dt * 3;
          break;
        case VX.BLIZZARD:
          v.x += u * 0.55 * dt;
          v.y += Math.sin(v.age * 0.05 + v.seed) * 0.02 * dt;
          break;
        default: {
          // Funnels ride the storm's wind with a wander; dust devils skitter.
          const jit = v.kind === VX.DUST_DEVIL ? 0.3 : 0.08;
          v.x += (u * (v.kind === VX.SUPERCELL ? 0.35 : 0.5) + Math.sin(v.age * 0.7 + v.seed) * jit) * dt;
          v.y += Math.cos(v.age * 0.5 + v.seed * 2) * jit * 0.6 * dt;
          if (sea && v.kind !== VX.SUPERCELL) v.age += dt * 2;
        }
      }
      v.x = ((v.x % WX_NX) + WX_NX) % WX_NX;
      v.y = v.y < 1 ? 1 : v.y > WX_NY - 2 ? WX_NY - 2 : v.y;
      v.power = Math.min(1, v.age / GROW[v.kind], (v.life - v.age) / FADE[v.kind]);
      if (v.age >= v.life) this.list.splice(n, 1);
    }
    if (host.time < this.nextRoll) return;
    this.nextRoll = host.time + ROLL_EVERY;
    const brews = BREWS[c.planetType ?? 'rocky'];
    if (!brews) return;
    for (const b of brews) {
      if (this.count(b.kind) >= b.max || this.rng() >= b.chance(c)) continue;
      const s = this.findSpot(host, b.kind, false);
      if (s) this.list.push(this.make(host, b.kind, s.x, s.y));
    }
  }

  private make(host: VortexHost, kind: number, x: number, y: number): Vortex {
    const r = this.rng, c = host.climate;
    const style = STYLE_OF[c.planetType ?? ''] ?? VSTYLE.PLAIN;
    const hyper = kind === VX.TYPHOON && style === VSTYLE.HYPER;
    const i = ((Math.floor(x) % WX_NX) + WX_NX) % WX_NX, j = clampRow(Math.floor(y));
    const LIFE: [number, number][] = [[14, 10], [60, 60], [6, 5], [40, 25], [50, 40], [40, 25], [10, 7]];
    const RAD: [number, number][] = [[0.9, 0], [4.5, 1.5], [0.5, 0.2], [4, 2], [3.5, 1.5], [2, 0.6], [0.7, 0.2]];
    const [l0, l1] = LIFE[kind], [r0, r1] = RAD[kind];
    return {
      kind, style, x, y, age: 0,
      life: l0 + r() * l1,
      r: (r0 + r() * r1) * (hyper ? 1.45 : 1),
      // Northern hemisphere (row < half) spins counter-clockwise seen from above.
      spin: y < WX_NY / 2 ? 1 : -1,
      // Haboob: rolls north or south (+1: south, toward the front of the disc);
      // the others: travel along x with the wind.
      dir: kind === VX.HABOOB ? (r() < 0.5 ? -1 : 1) : host.windU(i, j) < 0 ? -1 : 1,
      power: 0,
      seed: Math.floor(r() * 1e9),
    };
  }

  /** A random cell that suits the kind; `any` relaxes the weather condition (forcing). */
  private findSpot(host: VortexHost, kind: number, any: boolean): { x: number; y: number } | null {
    const c = host.climate, r = this.rng;
    for (let tries = 0; tries < 160; tries++) {
      const i = Math.floor(r() * WX_NX), j = 2 + Math.floor(r() * (WX_NY - 4));
      const k = j * WX_NX + i;
      const lat = Math.abs((0.5 - (j + 0.5) / WX_NY) * 180);
      const land = c.water[k] <= 0.35;
      switch (kind) {
        case VX.TORNADO:
          if (!land || lat > 65 || (!any && !host.isStorm(k))) continue;
          break;
        case VX.SUPERCELL:
          if (lat > 65 || (!any && !host.isStorm(k))) continue;
          break;
        case VX.TYPHOON:
          if (c.water[k] < 0.85 || lat < 6 || lat > 32 || (!any && c.temp[k] < 0.55)) continue;
          break;
        case VX.DUST_DEVIL:
          if (!land || lat > 50 || (!any && c.temp[k] < 0.5)) continue;
          break;
        case VX.HABOOB:
          if (!land || lat > 45) continue;
          break;
        case VX.BLIZZARD:
          if (lat < 20 || lat > 75) continue;
          break;
        case VX.FIRE_WHIRL:
          if (!land || (!any && c.ashEmit[k] <= 0 && c.temp[k] < 0.7)) continue;
          break;
      }
      return { x: i + 0.5, y: j + 0.5 };
    }
    return null;
  }
}

function clampRow(j: number): number {
  return j < 0 ? 0 : j > WX_NY - 1 ? WX_NY - 1 : j;
}
