/**
 * Culling helpers for the galaxy and system views. Pure, so
 * tools/invariantCheck.ts can hold them to the simulation's orbits.
 */

/**
 * How far a system's planets reach from its star: the apoapsis of the
 * outermost orbit, in world units. A system is on screen when its star is
 * within this distance of the view, not only when the star itself is (#84).
 */
export function systemReach(star: { planets: Array<{ orbitalRadius: number; eccentricity?: number }> }): number {
  let r = 0;
  for (const p of star.planets) r = Math.max(r, p.orbitalRadius * (1 + (p.eccentricity ?? 0)));
  return r;
}
