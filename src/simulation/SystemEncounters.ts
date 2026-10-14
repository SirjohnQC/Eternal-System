/**
 * System encounters (#115): what happens when two star systems overlap.
 *
 * Stars only merge when their cores nearly touch, but a system's planets orbit
 * out to 100+ units, so two systems used to sit inside each other forever,
 * planets interpenetrating, with nothing happening. Now an intruding star
 * works on the other system's planets the way a passing star would:
 *
 * - **Tides.** A planet whose orbit reaches toward the intruder is tugged.
 *   Most tugs only stretch its orbit (eccentricity up); a stretched orbit
 *   gives way: the planet is captured by the intruder or flung out of both
 *   systems (a rogue world, gone from the map).
 * - **Swallowing.** A planet whose orbit runs through the intruder's corona
 *   falls into it (or into the black hole, for a remnant).
 * - **Collisions.** Where the two systems' outer orbits cross, their planets
 *   can meet: a much bigger world absorbs the smaller and comes out molten,
 *   two of a size shatter into a debris cloud that thins and clears.
 *
 * The outermost planet goes first, which is also what a real passing star
 * does: the loosely held outer worlds are stripped long before the inner
 * ones. It keeps every planet index stable too (only the last planet of a
 * roster is ever removed, and captures append), so colonies, the home world,
 * arks in flight and world records keyed by `starId:planetIndex` never point
 * at the wrong world. A world that people live on (or that one of the
 * protections in `isProtected` covers) is never taken; it shields the planets
 * inside its orbit, and the systems stop trading worlds until it is gone.
 *
 * Geometry uses each orbit's size, not the planet's place on it: planet
 * positions are drawn from the animation clock, which is not part of the
 * simulation, so the encounter is a hazard rate over the orbit (rule 4: the
 * outcome is deterministic per seed). Pure: the engine supplies the stars,
 * the protection rule, a random source and a place to put debris.
 */
import type { StarBody, Planet, NebulaCloud } from './BigBangEngine';
import type { SeedRNG } from '../utils/SeedRNG';

/** Ticks between encounter passes. */
export const ENCOUNTER_EVERY = 20;
/** An intruder within `orbit × TIDE_REACH` of a star tugs that orbit. */
export const TIDE_REACH = 1.3;
/** Chance per pass of a tidal event for a fully engulfed orbit (equal masses). */
const TIDE_HAZARD = 0.015;
/** Chance per pass that a planet whose orbit runs through the intruder falls in. */
const SWALLOW_HAZARD = 0.004;
/** Chance per pass that two crossing outer orbits bring their planets together. */
const COLLIDE_HAZARD = 0.003;
/** A stretched orbit past this gives way (capture or ejection) on the next tug. */
const LOOSE_ECC = 0.58;
/** Eccentricity cap the orbit drawer accepts (`planetOffsetFromStar`). */
const MAX_ECC = 0.7;
/** Radius ratio at which a collision is an absorption, not mutual destruction. */
const ABSORB_RATIO = 1.6;
/** Widest orbit a captured planet is given. */
const MAX_CAPTURE_ORBIT = 150;

export type EncounterKind = 'perturbed' | 'captured' | 'ejected' | 'swallowed' | 'absorbed' | 'shattered';

export interface EncounterEvent {
  kind: EncounterKind;
  /** The system the planet belonged to. */
  host: StarBody;
  /** The other system (the captor, the star it fell into, the other world's star). */
  other: StarBody;
  planet: string;
  /** For collisions: the other planet's name. */
  otherPlanet?: string;
}

export interface EncounterWorld {
  stars: StarBody[];
  rng: SeedRNG;
  /** True for a planet that must not be removed or moved (people, colonies, home, arks). */
  isProtected: (star: StarBody, planetIndex: number) => boolean;
  /** Visual debris / flashes; they fade with the nebulae. */
  nebulae: NebulaCloud[];
}

/** How far a system's planets reach from its star (apoapsis of the widest orbit). */
export function systemReach(star: StarBody): number {
  let m = 0;
  for (const p of star.planets) m = Math.max(m, apoapsis(p));
  return m;
}

const apoapsis = (p: Planet) => p.orbitalRadius * (1 + Math.min(MAX_ECC, p.eccentricity ?? 0));

/** The outermost planet that may be taken, or null when the outermost is protected or there is none. */
function looseOuter(w: EncounterWorld, s: StarBody): Planet | null {
  const i = s.planets.length - 1;
  if (i < 0 || w.isProtected(s, i)) return null;
  return s.planets[i];
}

/** Pull of `intruder` on `host`'s planets, 0..1 (a black hole or a big star pulls hardest). */
function pullOf(host: StarBody, intruder: StarBody): number {
  return Math.min(1, (2 * intruder.mass) / (host.mass + intruder.mass));
}

/**
 * One encounter pass over every pair of systems close enough to touch.
 * Returns what happened, in order.
 */
export function stepEncounters(w: EncounterWorld): EncounterEvent[] {
  const events: EncounterEvent[] = [];
  const stars = w.stars;
  const reach = stars.map(systemReach);
  for (let i = 0; i < stars.length; i++) {
    for (let j = i + 1; j < stars.length; j++) {
      const a = stars[i], b = stars[j];
      const range = Math.max(reach[i], reach[j]) * TIDE_REACH;
      if (range <= 0) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
      if (d2 >= range * range) continue;
      const d = Math.sqrt(d2);
      tides(w, a, b, d, events);
      tides(w, b, a, d, events);
      collide(w, a, b, d, events);
      reach[i] = systemReach(a);
      reach[j] = systemReach(b);
    }
  }
  return events;
}

/** `intruder` at distance `d` works on `host`'s outermost planet. */
function tides(w: EncounterWorld, host: StarBody, intruder: StarBody, d: number, out: EncounterEvent[]): void {
  const p = looseOuter(w, host);
  if (!p) return;
  const r = p.orbitalRadius;
  // The orbit runs through the intruder's corona.
  const corona = intruder.radius * 1.2 + 2 + (intruder.remnantKind === 'black_hole' ? 6 : 0);
  if (Math.abs(r - d) < corona && w.rng.chance(SWALLOW_HAZARD)) {
    host.planets.pop();
    debris(w, intruder.x, intruder.y, intruder.remnantKind === 'black_hole' ? [120, 90, 160] : [255, 170, 90], 0.55, 8);
    out.push({ kind: 'swallowed', host, other: intruder, planet: p.name });
    return;
  }
  const engulf = (apoapsis(p) * TIDE_REACH - d) / (apoapsis(p) * TIDE_REACH);
  if (engulf <= 0) return;
  if (!w.rng.chance(TIDE_HAZARD * engulf * pullOf(host, intruder))) return;

  const ecc = p.eccentricity ?? 0;
  if (ecc < LOOSE_ECC && w.rng.chance(0.7)) {
    p.eccentricity = Math.min(MAX_ECC, ecc + w.rng.nextFloat(0.08, 0.2));
    p.periapsisAngle = (p.periapsisAngle ?? 0) + w.rng.nextFloat(-0.6, 0.6);
    out.push({ kind: 'perturbed', host, other: intruder, planet: p.name });
    return;
  }
  // The orbit gives way. A strong enough intruder keeps the planet.
  // (A system still forming takes no one in: its planets are still condensing.)
  if (intruder.formationStage == null && (!intruder.isDead || intruder.remnantKind === 'black_hole' || w.rng.chance(0.5))) {
    if (pullOf(host, intruder) >= 0.7 && w.rng.chance(0.55)) {
      host.planets.pop();
      const name = p.name;
      capture(w, intruder, p, d);
      out.push({ kind: 'captured', host, other: intruder, planet: name });
      return;
    }
  }
  host.planets.pop();
  out.push({ kind: 'ejected', host, other: intruder, planet: p.name });
}

/** Give `p` a wide, eccentric orbit outside `captor`'s planets (the roster stays sorted outward). */
function capture(w: EncounterWorld, captor: StarBody, p: Planet, d: number): void {
  const outer = captor.planets.length ? captor.planets[captor.planets.length - 1].orbitalRadius : captor.radius + 6;
  const want = Math.max(outer * 1.08 + 4, Math.abs(p.orbitalRadius - d) * w.rng.nextFloat(0.6, 1.1));
  const a = Math.min(Math.max(want, outer + 4), Math.max(MAX_CAPTURE_ORBIT, outer + 4));
  p.orbitalSpeed *= Math.sqrt(Math.max(1, p.orbitalRadius) / a);
  p.orbitalRadius = a;
  p.eccentricity = w.rng.nextFloat(0.3, 0.6);
  p.periapsisAngle = w.rng.nextFloat(0, Math.PI * 2);
  p.orbitalAngle = w.rng.nextFloat(0, Math.PI * 2);
  // A capture strips most of what the planet held.
  p.moons = p.moons.filter(() => w.rng.chance(0.4));
  // Roman-numeral names follow their new place; a discovered name is kept.
  if (/^[IVX]+$/.test(p.name) || /^\d+$/.test(p.name)) p.name = roman(captor.planets.length + 1);
  captor.planets.push(p);
}

/** The two systems' outermost planets meet where their orbits cross. */
function collide(w: EncounterWorld, a: StarBody, b: StarBody, d: number, out: EncounterEvent[]): void {
  const p = looseOuter(w, a), q = looseOuter(w, b);
  if (!p || !q) return;
  const ra = p.orbitalRadius, rb = q.orbitalRadius;
  if (!(Math.abs(ra - rb) < d && d < ra + rb)) return;
  if (!w.rng.chance(COLLIDE_HAZARD)) return;
  // Where the orbits cross (one of the two points; the debris drifts anyway).
  const x = (d * d + ra * ra - rb * rb) / (2 * d);
  const h = Math.sqrt(Math.max(0, ra * ra - x * x));
  const ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
  const cx = a.x + ux * x - uy * h, cy = a.y + uy * x + ux * h;
  const big = p.radius >= q.radius ? p : q, small = big === p ? q : p;
  if (big.radius >= small.radius * ABSORB_RATIO) {
    (small === p ? a : b).planets.pop();
    big.radius = Math.cbrt(big.radius ** 3 + small.radius ** 3);
    if (big.type !== 'gas') { big.type = 'lava'; big.color = '#c8461e'; }
    big.eccentricity = Math.min(MAX_ECC, (big.eccentricity ?? 0) + 0.1);
    debris(w, cx, cy, [255, 120, 60], 0.5, 10);
    out.push({ kind: 'absorbed', host: small === p ? a : b, other: small === p ? b : a, planet: small.name, otherPlanet: big.name });
    return;
  }
  a.planets.pop();
  b.planets.pop();
  debris(w, cx, cy, [150, 140, 125], 0.6, 16);
  out.push({ kind: 'shattered', host: a, other: b, planet: p.name, otherPlanet: q.name });
}

function debris(w: EncounterWorld, x: number, y: number, [r, g, b]: number[], alpha: number, maxRadius: number): void {
  w.nebulae.push({ x, y, radius: 2, maxRadius, alpha, r, g, b, age: 0 });
}

function roman(n: number): string {
  const t: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, k] of t) while (n >= v) { s += k; n -= v; }
  return s;
}
