/**
 * MoonSize — one reading of "how big is this moon", shared by the engine's
 * generator, every renderer that draws a moon, and the body inspector.
 *
 * A moon's `radius` is in world units and always below its parent's. Size is
 * judged RELATIVE to the parent, normalised per parent kind: a gas giant's
 * biggest moon is a far smaller fraction of it than a rocky world's, but should
 * still read as a "giant" moon on screen.
 *
 * Old saves: moons written before sizes varied lack `irregular` and
 * `inclination`; both are derived here from the moon's existing fields, so an
 * old save draws the same way every time without migration.
 */
import type { Moon, MoonKind, Planet } from './BigBangEngine';
import { SeedRNG } from '../utils/SeedRNG';

export type MoonSizeClass = 'captured' | 'minor' | 'major' | 'giant';

/** Largest moon/parent radius ratio the generator rolls, per parent kind. */
export function moonRelCeiling(parentType: Planet['type']): number {
  return parentType === 'gas' ? 0.45 : 0.6;
}

/**
 * 0 (smallest captured rock) .. 1 (largest moon this parent kind can hold).
 * Range: [0, 1], unitless.
 */
export function moonSizeT(moon: Pick<Moon, 'radius'>, parent: Pick<Planet, 'radius' | 'type'>): number {
  const rel = parent.radius > 0 ? moon.radius / parent.radius : 0.25;
  const t = rel / moonRelCeiling(parent.type);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Size class from {@link moonSizeT}: captured < 0.2 <= minor < 0.42 <= major < 0.7 <= giant. */
export function moonSizeClass(moon: Pick<Moon, 'radius'>, parent: Pick<Planet, 'radius' | 'type'>): MoonSizeClass {
  const t = moonSizeT(moon, parent);
  return t < 0.2 ? 'captured' : t < 0.42 ? 'minor' : t < 0.7 ? 'major' : 'giant';
}

/** Lumpy, non-spherical body (a captured asteroid). Defaults from size for old saves. */
export function moonIsIrregular(moon: Moon, parent: Pick<Planet, 'radius' | 'type'>): boolean {
  return moon.irregular ?? moonSizeT(moon, parent) < 0.2;
}

/**
 * Tilt of this moon's orbit as seen in the home-world sky, radians, about
 * -0.35..0.35. Defaults (old saves) to a stable value hashed from the name, so
 * two moons never share one path.
 */
export function moonInclination(moon: Moon, index: number): number {
  if (Number.isFinite(moon.inclination)) return moon.inclination as number;
  let h = 2166136261 ^ index;
  for (let i = 0; i < moon.name.length; i++) h = Math.imul(h ^ moon.name.charCodeAt(i), 16777619);
  return (((h >>> 0) % 1000) / 1000 - 0.5) * 0.6;
}

/** Inspector label. */
export function moonSizeLabel(c: MoonSizeClass): string {
  return c === 'captured' ? 'Tiny (captured rock)' : c === 'minor' ? 'Small' : c === 'major' ? 'Large' : 'Giant';
}

/**
 * Roll a planet's satellites (BigBangEngine.generateMoons calls this with one
 * draw from the engine rng; the dev preview calls it directly).
 *
 * Count and composition follow the parent: gas giants keep whole retinues of
 * moons of very different sizes, an ordinary world usually keeps none or one
 * and sometimes two or three. Sizes are rolled by class, from tiny captured
 * rocks (lumpy, far out) to giant moons. Habitability is fixed here from
 * composition, so a moon is a fact about a system a civilisation may or may
 * not ever be able to use. Deterministic in `seed`.
 */
export function rollMoons(planet: Pick<Planet, 'type' | 'radius'>, label: string, seed: number): Moon[] {
  const rng = new SeedRNG(seed >>> 0);
  const gas = planet.type === 'gas';
  // Counts. Gas giant: 2-6. Ordinary world: 0 (~44%), 1 (~32%), 2 (~16%),
  // 3 (~8%), with small worlds (radius < 0.75) holding fewer.
  let count: number;
  if (gas) {
    const r = rng.next();
    count = r < 0.15 ? 2 : r < 0.42 ? 3 : r < 0.70 ? 4 : r < 0.88 ? 5 : 6;
  } else {
    const r = rng.next() * (planet.radius < 0.75 ? 0.82 : 1);
    count = r < 0.44 ? 0 : r < 0.76 ? 1 : r < 0.92 ? 2 : 3;
  }
  if (count === 0) return [];

  // Which compositions are plausible around this kind of planet.
  const POOLS: Record<Planet['type'], MoonKind[]> = {
    gas:     ['ice', 'ice', 'rock', 'ocean', 'carbon', 'volcanic'],
    ice:     ['ice', 'ice', 'rock'],
    ocean:   ['rock', 'ice', 'carbon'],
    rocky:   ['rock', 'rock', 'iron', 'carbon'],
    lava:    ['volcanic', 'iron', 'rock'],
    toxic:   ['rock', 'carbon', 'ice'],
    crystal: ['ice', 'rock', 'carbon'],
    desert:  ['rock', 'iron', 'carbon'],
    storm:   ['ice', 'rock', 'ocean'],
    carbon:  ['carbon', 'rock', 'iron'],
    mechanical: ['iron', 'iron', 'rock'],
  };
  // Captured rocks are bare: rock, iron, carbon only.
  const CAPTURED: MoonKind[] = ['rock', 'rock', 'carbon', 'iron'];
  const TINT: Record<MoonKind, string[]> = {
    rock:     ['#b9b2a6', '#a8a094', '#c4b8a4'],
    ice:      ['#d6ecf8', '#c4e0f0', '#e4f0f4'],
    iron:     ['#8c7f78', '#9a7f6c', '#7c7470'],
    volcanic: ['#c96a44', '#d4a040', '#b85a3a'],
    carbon:   ['#4c4a52', '#5a5048', '#44464e'],
    ocean:    ['#5f9fd0', '#4f8fc4'],
  };
  // A subsurface ocean is the prize; bare iron is nearly worthless.
  const HAB: Record<MoonKind, [number, number]> = {
    ocean:    [0.55, 0.85],
    ice:      [0.30, 0.60],
    carbon:   [0.22, 0.45],
    rock:     [0.15, 0.40],
    volcanic: [0.05, 0.22],
    iron:     [0.04, 0.18],
  };
  // Size classes as fractions of the parent kind's ceiling (MoonSize):
  // captured 0.06-0.18, minor 0.22-0.40, major 0.45-0.68, giant 0.72-1.0.
  const CLASS_T: Array<[number, number]> = [[0.06, 0.18], [0.22, 0.40], [0.45, 0.68], [0.72, 1.0]];
  const ceiling = moonRelCeiling(planet.type);

  // One "primary" moon may be big; the rest skew small. A gas giant always
  // has at least one major-or-giant moon and a scatter of captured rocks.
  const classes: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng.next();
    let c: number;
    if (i === 0) c = gas ? (r < 0.45 ? 3 : 2) : (r < 0.16 ? 3 : r < 0.48 ? 2 : r < 0.80 ? 1 : 0);
    else if (gas) c = r < 0.18 ? 2 : r < 0.48 ? 1 : 0;
    else c = r < 0.08 ? 2 : r < 0.42 ? 1 : 0;
    classes.push(c);
  }
  // Inner to outer: big moons tend to sit inside, captured rocks far out.
  const order = classes.map((c, i) => ({ c, k: rng.next() + (c === 0 ? 0.9 : 0) - c * 0.12, i }))
    .sort((x, y) => x.k - y.k).map(o => o.c);

  const moons: Moon[] = [];
  let orbit = planet.radius * 2.0;
  for (let i = 0; i < count; i++) {
    const cls = order[i];
    const captured = cls === 0;
    const pool = captured ? CAPTURED : POOLS[planet.type];
    const kind = pool[rng.nextInt(0, pool.length - 1)];
    const [hlo, hhi] = HAB[kind];
    const [tlo, thi] = CLASS_T[cls];
    const radius = planet.radius * ceiling * rng.nextFloat(tlo, thi);
    // Spacing grows with the moon's size so neighbours never touch.
    orbit += planet.radius * (gas ? rng.nextFloat(0.45, 0.8) : rng.nextFloat(0.9, 1.5)) + radius * 1.8;
    const tints = TINT[kind];
    moons.push({
      name: `${label}-${'abcdefgh'[i]}`,
      radius: Math.min(radius, planet.radius * 0.7),
      orbitalRadius: orbit + rng.nextFloat(0, 0.6),
      orbitalAngle: rng.nextFloat(0, Math.PI * 2),
      // Outer orbits are slower; captured rocks keep a little extra drift.
      orbitalSpeed: rng.nextFloat(0.0035, 0.0095) / (1 + i * 0.85) * (captured ? 1.2 : 1),
      color: tints[rng.nextInt(0, tints.length - 1)],
      kind,
      habitability: Math.min(0.95, rng.nextFloat(hlo, hhi) + (cls >= 2 ? 0.08 : 0) - (captured ? 0.06 : 0)),
      colonised: false,
      colonisedTick: null,
      irregular: captured || (cls === 1 && rng.chance(0.25)),
      inclination: rng.nextFloat(-0.32, 0.32),
    });
  }
  return moons;
}

/**
 * System-view moon placement, shared by the Pixi renderer and the engine's
 * click-pick so what is drawn is what is clicked. `body` is the planet's drawn
 * diameter in world units. Each moon keeps its own orbit radius, pushed out
 * by rank so moons never collapse onto one ring when the planet is drawn
 * larger than life at low zoom.
 */
export function moonViewOrbit(moon: Moon, index: number, body: number): number {
  return Math.max(moon.orbitalRadius, body * (0.8 + 0.42 * index));
}

/**
 * System-view moon diameter in world units: from its real radius, with a
 * per-class floor in SCREEN px (captured ~4-5, minor ~6-7, major ~9-10, giant ~11-14),
 * so a giant stays visibly bigger than a captured rock at every zoom.
 */
export function moonViewSize(moon: Moon, parent: Pick<Planet, 'radius' | 'type'>, cameraScale: number): number {
  const t = moonSizeT(moon, parent);
  const floorPx = 4 + t * 10;
  return Math.max(moon.radius * 3.2, floorPx / Math.max(0.01, cameraScale));
}

/** Zoom at which a moon of this size first shows in the system view. */
export function moonViewMinScale(moon: Moon, parent: Pick<Planet, 'radius' | 'type'>): number {
  const t = moonSizeT(moon, parent);
  return t >= 0.7 ? 0.5 : t >= 0.42 ? 0.65 : t >= 0.2 ? 0.85 : 1.1;
}
