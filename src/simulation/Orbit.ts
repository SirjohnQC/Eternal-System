/**
 * A planet's position on its orbit. Pure: moved out of BigBangEngine on
 * 2026-09-28 so renderers and headless checks can place planets without
 * importing the whole engine (which touches the DOM and pulls in the sim).
 * BigBangEngine re-exports it unchanged.
 */
export interface OrbitElements {
  orbitalRadius: number;
  orbitalAngle: number;
  orbitalSpeed: number;
  eccentricity?: number;
  periapsisAngle?: number;
}

/**
 * World-space offset of a planet from its star at the given anim tick.
 * Uses a lightweight Kepler approx so eccentric orbits look elliptical.
 */
export function planetOffsetFromStar(p: OrbitElements, animTick: number): { x: number; y: number; r: number } {
  const a = p.orbitalRadius;
  const e = Math.min(0.72, Math.max(0, p.eccentricity ?? 0));
  const M = p.orbitalAngle + animTick * p.orbitalSpeed;
  const peri = p.periapsisAngle ?? 0;
  if (e < 0.015) {
    return { x: Math.cos(M) * a, y: Math.sin(M) * a, r: a };
  }
  // Eccentric anomaly (few fixed-point iterations)
  let E = M;
  for (let i = 0; i < 4; i++) E = M + e * Math.sin(E);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const x0 = a * (cosE - e);
  const y0 = a * Math.sqrt(Math.max(0, 1 - e * e)) * sinE;
  const c = Math.cos(peri), s = Math.sin(peri);
  const x = x0 * c - y0 * s;
  const y = x0 * s + y0 * c;
  return { x, y, r: Math.hypot(x, y) };
}
