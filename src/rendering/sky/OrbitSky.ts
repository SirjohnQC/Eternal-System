/**
 * The home world's sky, from the simulation's REAL orbits.
 *
 * Pure and stateless: a new planet or a restarted clock simply gives a new
 * answer. A body's sky azimuth is its true direction from home measured from
 * the sun, turned with the day: the angle between two bodies in the sky is
 * their real angle as seen from home. See
 * docs/superpowers/specs/2026-09-28-orbit-sky-design.md.
 */
import { planetOffsetFromStar, type OrbitElements } from '../../simulation/Orbit';

export const TAU = Math.PI * 2;
/** Largest axial tilt a world can roll. */
export const MAX_TILT = (35 * Math.PI) / 180;

export const wrapPi = (a: number): number => {
  let v = (a + Math.PI) % TAU;
  if (v < 0) v += TAU;
  return v - Math.PI;
};

export interface SkyPlanet extends OrbitElements { genomeSeed?: number }

export interface SkySibling<P> {
  planet: P;
  az: number;
  elev: number;
  /** Angle at the sibling between the sun and home, radians. */
  phaseAngle: number;
  /** 0 new .. 1 full. */
  litFraction: number;
}

export interface SkyState<P> {
  sun: { az: number; elev: number; sizeScale: number };
  siblings: SkySibling<P>[];
  /** True ecliptic longitude of the sun seen from home, radians. */
  sunLongitude: number;
  /** Subsolar latitude, radians (seasons). */
  declination: number;
}

function hash01(seed: number, salt: number): number {
  let h = Math.imul((seed | 0) ^ salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Axial tilt, 0..MAX_TILT, fixed by the world's genome seed. */
export function axialTilt(genomeSeed: number): number {
  return hash01(genomeSeed, 0x7117) * MAX_TILT;
}

/** Sun longitude at the northern spring equinox, 0..2pi. */
export function seasonZero(genomeSeed: number): number {
  return hash01(genomeSeed, 0x5ea5) * TAU;
}

export function orbitSky<P extends SkyPlanet>(input: {
  animTick: number; home: P | null; planets: readonly P[]; dayAngle: number;
}): SkyState<P> {
  const sunAz = Math.PI / 2 - input.dayAngle;
  const out: SkyState<P> = {
    sun: { az: sunAz, elev: Math.cos(sunAz), sizeScale: 1 },
    siblings: [], sunLongitude: 0, declination: 0,
  };
  const home = input.home;
  if (!home) return out;
  const h = planetOffsetFromStar(home, input.animTick);
  if (home.orbitalRadius > 0 && h.r > 1e-9) out.sun.sizeScale = home.orbitalRadius / h.r;
  // TRUE longitude: the two branches of planetOffsetFromStar use different
  // references, and mean anomaly drifts up to 2e from the real sky.
  const lambdaSun = h.r > 1e-9 ? Math.atan2(-h.y, -h.x) : 0;
  out.sunLongitude = lambdaSun;
  const seed = home.genomeSeed ?? 0;
  out.declination = Math.asin(Math.sin(axialTilt(seed)) * Math.sin(lambdaSun - seasonZero(seed)));
  for (const p of input.planets) {
    if (p === home) continue;                          // identity, not index
    const s = planetOffsetFromStar(p, input.animTick);
    const vx = s.x - h.x, vy = s.y - h.y;
    const az = sunAz + wrapPi(Math.atan2(vy, vx) - lambdaSun);
    const ax = -s.x, ay = -s.y, la = Math.hypot(ax, ay), lb = Math.hypot(vx, vy);
    const cosA = la > 1e-9 && lb > 1e-9 ? (ax * -vx + ay * -vy) / (la * lb) : 1;
    const phaseAngle = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
    out.siblings.push({ planet: p, az, elev: Math.cos(az), phaseAngle, litFraction: (1 + Math.cos(phaseAngle)) / 2 });
  }
  return out;
}
