/**
 * AirTraffic — the flying machines over a world's towns (playtest Oct 22:
 * "some [buildings] should spawn flying object like plane").
 *
 * Airfields and spaceports come from the settlement plan (SettlementPlan
 * `airfield` / `spaceport` buildings and their runway / apron pads). Every
 * flight is a closed-form function of the view's clock: a port sends one
 * out every few seconds, it rolls down the runway, climbs, crosses to
 * another port and lands there, or leaves over the edge of the world (and
 * as many come in from it). Nothing is stored or stepped, so nothing drifts
 * and nothing leaks between worlds; a frame costs a few sums per port.
 *
 * Machines by era: biplanes and airships (industrial), propeller airliners,
 * airships and helicopters (atomic), jets, helicopters and drones (space
 * age), hover transports and drones (interstellar on); a spaceport launches
 * a shuttle straight up now and then.
 *
 * Pure: no DOM. Positions are base-world face coordinates; `alt` is height
 * above the ground in world px (drawn as screen-up).
 */
import type { Building, Era, Pad, SettlementPlan } from './SettlementPlan';

export type AircraftKind = 'biplane' | 'airship' | 'prop' | 'jet' | 'heli' | 'shuttle' | 'drone' | 'hover';

export interface Port {
  kind: 'airfield' | 'spaceport';
  era: Era;
  /** The terminal / launch pad building. */
  bx: number; by: number;
  /** Runway or apron (face coordinates). */
  x0: number; x1: number; y: number;
  /** Ground height there (world px). */
  lift: number;
  seed: number;
}

export interface Flight {
  kind: AircraftKind;
  x: number; y: number;
  /** Ground height under it, and its height above that (world px). */
  ground: number; alt: number;
  /** Heading left (the sprite is drawn facing right). */
  left: boolean;
  /** 0..1 fade at the edge of the world. */
  alpha: number;
}

/** Machines a port of this era flies. */
export function fleetOf(kind: Port['kind'], era: Era): AircraftKind[] {
  if (kind === 'spaceport') return era >= 6 ? ['shuttle', 'hover'] : ['shuttle'];
  if (era <= 3) return ['biplane', 'biplane', 'airship'];
  if (era === 4) return ['prop', 'prop', 'airship', 'heli'];
  if (era === 5) return ['jet', 'jet', 'heli', 'drone'];
  return ['hover', 'jet', 'drone'];
}

/** The plan's ports, each with its runway or apron. */
export function portsOf(plan: SettlementPlan, liftOf: (b: Building, i: number) => number): Port[] {
  const out: Port[] = [];
  plan.buildings.forEach((b, i) => {
    if (b.kind !== 'airfield' && b.kind !== 'spaceport') return;
    const want = b.kind === 'airfield' ? 'runway' : 'apron';
    let best: Pad | null = null, bd = Infinity;
    for (const p of plan.pads) {
      if (p.kind !== want) continue;
      const d = Math.hypot((p.x0 + p.x1) / 2 - b.x, p.y0 - b.y);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    out.push({
      kind: b.kind, era: plan.towns[b.town]?.era ?? plan.era, bx: b.x, by: b.y,
      x0: best.x0, x1: best.x1, y: (best.y0 + best.y1) / 2, lift: liftOf(b, i), seed: b.seed,
    });
  });
  return out;
}

function hash(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Seconds between departures from one port, and how long a flight lasts. */
export const DEPART_EVERY = 9;
const FLIGHT_SECONDS = 16;

/**
 * Everything in the air (or rolling on a runway) at time `t` (seconds),
 * for a disc centred on (cx, cy) with radii (rx, ry) in face coordinates.
 * At most ceil(FLIGHT_SECONDS / DEPART_EVERY) + 1 flights per port.
 */
export function flightsAt(ports: Port[], t: number, disc: { cx: number; cy: number; rx: number; ry: number }): Flight[] {
  const out: Flight[] = [];
  ports.forEach((p, pi) => {
    const every = DEPART_EVERY * (0.8 + 0.5 * hash(p.seed, 1));
    const off = hash(p.seed, 2) * every;
    const n1 = Math.floor((t - off) / every);
    const per = Math.ceil(FLIGHT_SECONDS * 1.7 / every) + 1;
    for (let n = n1; n > n1 - per; n--) {
      const t0 = off + n * every;
      const fleet = fleetOf(p.kind, p.era);
      const kind = fleet[Math.floor(hash(p.seed + n, 3) * fleet.length)];
      const f = flight(kind, p, pi, ports, n, (t - t0), disc);
      if (f) out.push(f);
    }
  });
  return out;
}

function flight(kind: AircraftKind, p: Port, pi: number, ports: Port[], n: number, s: number, disc: { cx: number; cy: number; rx: number; ry: number }): Flight | null {
  if (s < 0) return null;
  const h = (k: number) => hash(p.seed + n * 31, k);
  // A shuttle goes straight up off its pad, faster and faster.
  if (kind === 'shuttle') {
    const T = 7;
    if (s > T) return null;
    const climb = s < 1.2 ? 0 : 3 * (s - 1.2) * (s - 1.2);
    return { kind, x: (p.x0 + p.x1) / 2, y: p.y, ground: p.lift, alt: climb, left: false, alpha: climb > 120 ? 0 : 1 };
  }
  const slow = kind === 'airship' ? 1.7 : kind === 'heli' || kind === 'drone' ? 1.2 : 1;
  const T = FLIGHT_SECONDS * slow;
  if (s > T) return null;
  const vertical = kind === 'heli' || kind === 'drone' || kind === 'hover';
  const cruise = (kind === 'airship' ? 13 : vertical ? 10 : 20) + h(4) * 8;
  // Where to: another port half the time (when there is one), else the edge
  // of the world; every other flight comes in from the edge instead.
  const others = ports.filter((_, i) => i !== pi);
  const toPort = others.length > 0 && h(5) < 0.5 ? others[Math.floor(h(6) * others.length)] : null;
  const ang = h(7) * Math.PI * 2;
  const edge = { x: disc.cx + Math.cos(ang) * disc.rx * 1.25, y: disc.cy + Math.sin(ang) * disc.ry * 1.25 };
  const inbound = !toPort && (n & 1) === 1;
  // The path: roll along the runway (or rise from the pad), fly, land.
  const startX = vertical ? p.bx : p.x0 + (p.x1 - p.x0) * 0.1, startY = vertical ? p.by - 1 : p.y;
  const liftOffX = vertical ? startX : p.x1, liftOffY = startY;
  let endX: number, endY: number, endGround: number;
  if (toPort) {
    endX = vertical ? toPort.bx : toPort.x0 + (toPort.x1 - toPort.x0) * 0.85; endY = vertical ? toPort.by - 1 : toPort.y; endGround = toPort.lift;
  } else { endX = edge.x; endY = edge.y; endGround = 0; }
  const roll = vertical ? 0 : 0.18, land = toPort && !vertical ? 0.14 : 0;
  const at = (u: number) => {
    let x: number, y: number, alt: number, ground: number;
    if (u < roll) {
      const k = smooth(u / roll);
      x = startX + (liftOffX - startX) * k; y = startY; alt = 0; ground = p.lift;
    } else if (u > 1 - land) {
      // Touch down at the runway's start, roll along it.
      const k = (u - (1 - land)) / land;
      const tdX = toPort ? toPort.x0 + (toPort.x1 - toPort.x0) * 0.1 : endX;
      x = tdX + (endX - tdX) * k; y = endY; alt = 0; ground = endGround;
    } else {
      const k = (u - roll) / Math.max(1e-6, 1 - roll - land);
      const fx = toPort && !vertical ? toPort.x0 + (toPort.x1 - toPort.x0) * 0.1 : endX;
      x = liftOffX + (fx - liftOffX) * k; y = liftOffY + (endY - liftOffY) * k;
      // Up to cruising height over the first part, down over the last
      // (towards the edge it stays up and fades out).
      const up = vertical ? smooth(k / 0.15) : smooth(k / 0.3);
      const down = toPort ? smooth((1 - k) / (vertical ? 0.15 : 0.3)) : 1;
      alt = cruise * Math.min(up, down);
      ground = p.lift + ((toPort ? endGround : p.lift) - p.lift) * k;
    }
    return { x, y, alt, ground };
  };
  // Inbound from the edge: the same path run backwards, landing here.
  const u = inbound ? 1 - s / T : s / T;
  const { x, y, alt, ground } = at(u);
  const ahead = at(Math.max(0, Math.min(1, u + (inbound ? -0.01 : 0.01))));
  const left = ahead.x < x;
  const r = Math.hypot((x - disc.cx) / disc.rx, (y - disc.cy) / disc.ry);
  const alpha = r < 1 ? 1 : Math.max(0, 1 - (r - 1) / 0.2);
  if (alpha <= 0) return null;
  return { kind, x, y, ground, alt, left, alpha };
}
