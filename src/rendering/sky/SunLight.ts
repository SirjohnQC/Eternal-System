/**
 * The sun's direction, one definition for every consumer of light: the disc's
 * night veil, the atmosphere, the weather painter, city lights and moons.
 *
 * Pure — no DOM. With d the diorama's day angle: sky azimuth pi/2 - d,
 * elevation sin(d). d = 0 puts the sun on the +x horizon, pi/2 at local noon
 * (overhead, behind the dome), pi on the -x horizon, 3pi/2 at local midnight.
 * Before 2026-09-28 every consumer used cos(d) alone, so noon and midnight lit
 * the disc identically and the face was never fully day or night.
 */

/** How strongly the sun's elevation lights the whole face. Noon: 0.38 + 0.9 * 0.65 ~ 1. */
export const ELEV_LIGHT = 0.65;
/** Darkest night veil alpha. The world stays readable at night (Sirjohn, 2026-09-28). */
export const NIGHT_MAX = 0.58;

/**
 * Signed: > 0 where the sun faces this point of the disc. `dx` is disc x in -1..1.
 * Replaces `dx * cos(d)` everywhere; identical to it when sin(d) = 0.
 */
export function sunFacing(dx: number, d: number): number {
  return dx * Math.cos(d) + ELEV_LIGHT * Math.sin(d);
}

/** Day amount on the face, 0-1. The night veil is `(1 - sunLit) * NIGHT_MAX`. */
export function sunLit(dx: number, d: number): number {
  const v = 0.38 + 0.9 * sunFacing(dx, d);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Moon shading: the shadow disc's horizontal offset in moon radii (away from
 * the sun) and its alpha (deeper when the sun is down). Continuous: no flip at
 * noon. The shade is today's fixed 0.6 whenever the sun is down or on the
 * horizon (sin d <= 0) and lightens only while the sun is up, reaching 0.24
 * at noon — so the terminator is identical to the pre-2026-09-28 picture at
 * sunrise, sunset and all night.
 */
export function moonShade(d: number): { offset: number; alpha: number } {
  return { offset: -0.3 * Math.cos(d), alpha: 0.6 * (1 - 0.6 * Math.max(0, Math.sin(d))) };
}
