/**
 * CreatureForge — procedural pixel creatures built from a 3D body, after
 * idlerunner00/procedural-pixel-creatures (skeleton of primitives, soft-union
 * distance fields, an oblique camera, quantised material lighting, outlines
 * and designed eye stamps).
 *
 * The genome picks a BODY PLAN (fish, quadruped, biped, crawler, crab, snail,
 * jelly, bird, insect, polyp, plant, cell…) and dresses it: size sets the
 * build, body structure the plan's variant, senses the head parts, diet the
 * jaw and markings, aggression spikes and horns, intelligence the skull and
 * posture, metabolism and habitat the palette.
 *
 * Pure: renders into an RGBA buffer; `SpeciesSprite` wraps it in a canvas.
 * Used for portraits (lab, dex, evolution sequence, codex). Creatures on the
 * planet are only a few pixels tall and keep the hand-placed pixel baker.
 */
import type { SpeciesGenome, Metabolism, Environment } from '../simulation/SpeciesGenome';

export type V3 = [number, number, number];

// ─── Materials and palette ───────────────────────────────────────────────────

const PRIMARY = 0, BELLY = 1, MARK = 2, ACCENT = 3, SHELL = 4, BONE = 5, LEAF = 6, WING = 8;
/** Material index lit as self-luminous by the renderer, in every palette. */
export const GLOW = 7;
const MATS = 9;
/** Ramp levels: 0 deep … 4 highlight; OUTLINE is a separate darker step. */
const LEVELS = 5;

export type RGB = [number, number, number];

export function hsl(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s)); l = Math.max(0.03, Math.min(0.96, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
                  : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
export function toward(h: number, target: number, amt: number): number {
  const d = ((target - h + 540) % 360) - 180;
  return Math.abs(d) < amt ? target : h + Math.sign(d) * amt;
}

const META_HUE: Record<Metabolism, number> = {
  photosynthetic: 108, chemosynthetic: 268, heterotrophic: 30, parasitic: 326,
};
const ENV_TONE: Record<Environment, { dh: number; l: number; s: number }> = {
  deep_sea: { dh: -14, l: 0.34, s: 0.62 },
  ocean:    { dh: -10, l: 0.48, s: 0.58 },
  coastal:  { dh:   6, l: 0.56, s: 0.55 },
  land:     { dh:  10, l: 0.46, s: 0.52 },
  aerial:   { dh:   0, l: 0.62, s: 0.56 },
};

export interface Ramp { lv: RGB[]; outline: RGB; alpha: number }

/** Five-step ramp with hue shifting: shadows lean blue-violet, lights lean warm. */
export function ramp(h: number, s: number, l: number, alpha = 255): Ramp {
  const lv: RGB[] = [];
  const steps = [-0.25, -0.13, 0, 0.12, 0.22];
  for (let i = 0; i < LEVELS; i++) {
    const k = steps[i];
    const hh = k < 0 ? toward(h, 245, -k * 70) : toward(h, 55, k * 60);
    const ss = s * (k < 0 ? 1 + -k * 0.3 : 1 - k * 0.6);
    lv.push(hsl(hh, ss, l + k * (k < 0 ? 1.0 : 1.1)));
  }
  return { lv, outline: hsl(toward(h, 250, 30), Math.min(1, s * 0.9), Math.max(0.06, l * 0.28)), alpha };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function buildPalette(g: SpeciesGenome, seed: number): Ramp[] {
  const env = ENV_TONE[g.dna.environment] ?? ENV_TONE.land;
  const jit = (hash3(seed, 1, 2, 3) - 0.5) * 16;
  const H = (META_HUE[g.dna.metabolism] ?? 30) + env.dh + jit;
  let S = env.s, L = env.l + (hash3(seed, 4, 5, 6) - 0.5) * 0.06;
  if (g.dna.diet === 'decomposer') S *= 0.7;
  const jelly = g.physicalTraits.bodyStructure === 'gelatinous';
  const a = jelly ? 190 : 255;
  const r: Ramp[] = new Array(MATS);
  r[PRIMARY] = ramp(H, S, L, a);
  r[BELLY] = ramp(toward(H, 48, 30), S * 0.45, Math.min(0.8, L + 0.2), a);
  // Markings: a shifted, darker hue, so stripes and spots read at a glance.
  r[MARK] = ramp(H + (g.dna.diet === 'carnivore' ? -18 : 22), Math.min(1, S * 1.1), L - 0.14, a);
  r[ACCENT] = ramp(H + 165 * (hash3(seed, 7, 8, 9) < 0.5 ? 1 : -1) * 0.35 + 20, Math.min(0.9, S * 1.1), Math.min(0.72, L + 0.06), a);
  r[SHELL] = ramp(toward(H, 35, 50), S * 0.5, Math.min(0.75, L + 0.12));
  r[BONE] = ramp(44, 0.32, 0.8);
  r[LEAF] = ramp(112, 0.5, 0.42);
  r[GLOW] = ramp(172, 0.85, 0.66);
  // Machine life: steel plates, bronze accents, a lit cyan; crystal life: glassy facets.
  if (g.physicalTraits.bodyStructure === 'mechanical') {
    r[PRIMARY] = ramp(212 + jit, 0.12, 0.56);
    r[SHELL] = ramp(205, 0.18, 0.42);
    r[MARK] = ramp(32, 0.55, 0.46);
    r[ACCENT] = ramp(28, 0.6, 0.5);
    r[BELLY] = ramp(210, 0.1, 0.7);
    r[GLOW] = ramp(185 + jit * 2, 0.9, 0.62);
  } else if (g.physicalTraits.bodyStructure === 'crystalline') {
    const ch = 190 + hash3(seed, 9, 9, 1) * 120;
    r[PRIMARY] = ramp(ch, 0.5, 0.62, 225);
    r[ACCENT] = ramp(ch + 40, 0.6, 0.7, 225);
    r[BELLY] = ramp(ch, 0.3, 0.75, 225);
    r[GLOW] = ramp(ch + 20, 0.95, 0.7);
  }
  const insectWing = g.dna.locomotion === 'flying' && (g.physicalTraits.bodyStructure === 'exoskeletal' || g.physicalTraits.bodyStructure === 'segmented');
  r[WING] = insectWing ? ramp(195, 0.25, 0.8, 150) : ramp(toward(H, 280, 20), S * 0.8, Math.max(0.2, L - 0.12), 235);
  return r;
}

// ─── Body: primitives and groups ─────────────────────────────────────────────

const ELL = 0, CONE = 1, TRI = 2;

interface Prim {
  kind: number;
  a: V3; b: V3; c: V3;
  r: V3;          // ellipsoid radii / cone r1,r2 in [0],[1] / tri thickness in [0]
  mat: number;
  group: number;
  /** Bounding sphere in creature space (for culling). */
  bc: V3; br: number;
}

interface Group { side: number; blend: number; noPattern: boolean; facet: boolean }

interface Eye { p: V3; style: 'vision' | 'compound' | 'spot' | 'small'; size: number }
interface Dot { p: V3; mat: number }

export class Body {
  prims: Prim[] = [];
  groups: Group[] = [];
  eyes: Eye[] = [];
  dots: Dot[] = [];
  /** Centre of a coiled shell, for its spiral banding. */
  shell: V3 | null = null;
  group(side = 0, blend = 0.06, noPattern = false, facet = false): number {
    this.groups.push({ side, blend, noPattern, facet });
    return this.groups.length - 1;
  }
  ell(c: V3, r: V3, mat: number, group: number): void {
    this.prims.push({ kind: ELL, a: c, b: c, c, r, mat, group, bc: c, br: Math.max(r[0], r[1], r[2]) });
  }
  cone(a: V3, b: V3, r1: number, r2: number, mat: number, group: number): void {
    const bc: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const half = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 2;
    this.prims.push({ kind: CONE, a, b, c: b, r: [r1, r2, 0], mat, group, bc, br: half + Math.max(r1, r2) });
  }
  tri(a: V3, b: V3, c: V3, thick: number, mat: number, group: number): void {
    const bc: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const br = Math.max(dist(a, bc), dist(b, bc), dist(c, bc)) + thick;
    this.prims.push({ kind: TRI, a, b, c, r: [thick, 0, 0], mat, group, bc, br });
  }
  /** A tapering chain through points (tails, tentacles, flagella). */
  chain(pts: V3[], r0: number, r1: number, mat: number, group: number): void {
    for (let i = 0; i < pts.length - 1; i++) {
      const t0 = i / (pts.length - 1), t1 = (i + 1) / (pts.length - 1);
      this.cone(pts[i], pts[i + 1], r0 + (r1 - r0) * t0, r0 + (r1 - r0) * t1, mat, group);
    }
  }
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ─── Animation ───────────────────────────────────────────────────────────────
//
// Plans read the pose phase PH (0..1, one gait / beat cycle) while they build:
// legs step, wings beat, tails sweep, bells pulse. 0 is the old still pose
// (or close to it), so portraits forged at phase 0 look as they always did.
let PH = 0;
/** False for a still pose (portraits): limbs at rest, feet down. */
let MOVING = false;
const TAU = Math.PI * 2;
/** Swing, -1..1, at a phase offset (fraction of a cycle). */
const sw = (o = 0) => MOVING ? Math.sin((PH + o) * TAU) : 0;
/** Lift, 0..1: a foot is up for the forward half of its stride. */
const up = (o = 0) => MOVING ? Math.max(0, Math.cos((PH + o) * TAU)) : 0;

/**
 * A stepping foot (after procedural-pixel-creatures' LeggedLocomotion): it
 * is PLANTED for `duty` of the cycle, sliding back at constant speed as the
 * body walks over it, then swings forward on an eased arc with a lift.
 * Returns [dx, lift] in units of the stride (dx -0.5..0.5, lift 0..1).
 * The creature moves forward one stride per cycle, so a planted foot holds
 * still on the ground.
 */
function step(o: number, duty = 0.64): [number, number] {
  if (!MOVING) return [0, 0];
  const p = ((PH + o) % 1 + 1) % 1;
  if (p < duty) return [0.5 - p / duty, 0];
  const t = (p - duty) / (1 - duty);
  return [-0.5 + (0.5 - 0.5 * Math.cos(Math.PI * t)), Math.sin(Math.PI * t)];
}
/** Stride length of the walkers, in body units (the renderer moves them by it). */
export const STRIDE = 0.16;
/** Wing beat, skewed: a fast downstroke and a slower upstroke. 1 up … -1 down. */
const flap = () => Math.cos(PH * TAU + 0.45 * Math.sin(PH * TAU));

// ─── Signed distances (Inigo Quilez) ─────────────────────────────────────────

function sdEllipsoid(px: number, py: number, pz: number, r: V3): number {
  const k0 = Math.hypot(px / r[0], py / r[1], pz / r[2]);
  const k1 = Math.hypot(px / (r[0] * r[0]), py / (r[1] * r[1]), pz / (r[2] * r[2]));
  return k1 === 0 ? -Math.min(r[0], r[1], r[2]) : k0 * (k0 - 1) / k1;
}

function sdRoundCone(px: number, py: number, pz: number, a: V3, b: V3, r1: number, r2: number): number {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  if (l2 < 1e-9) return Math.hypot(px - a[0], py - a[1], pz - a[2]) - Math.max(r1, r2);
  const rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const y = pax * bax + pay * bay + paz * baz, z = y - l2;
  const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz, y2 = y * y * l2, z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

function sdTriangle(px: number, py: number, pz: number, a: V3, b: V3, c: V3, thick: number): number {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const cbx = c[0] - b[0], cby = c[1] - b[1], cbz = c[2] - b[2];
  const acx = a[0] - c[0], acy = a[1] - c[1], acz = a[2] - c[2];
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const pbx = px - b[0], pby = py - b[1], pbz = pz - b[2];
  const pcx = px - c[0], pcy = py - c[1], pcz = pz - c[2];
  const nx = bay * acz - baz * acy, ny = baz * acx - bax * acz, nz = bax * acy - bay * acx;
  const side = (ux: number, uy: number, uz: number, qx: number, qy: number, qz: number) => {
    const cx = uy * nz - uz * ny, cy = uz * nx - ux * nz, cz = ux * ny - uy * nx;
    return Math.sign(cx * qx + cy * qy + cz * qz);
  };
  const seg = (ux: number, uy: number, uz: number, qx: number, qy: number, qz: number) => {
    const uu = ux * ux + uy * uy + uz * uz;
    const t = Math.max(0, Math.min(1, (ux * qx + uy * qy + uz * qz) / uu));
    const dx = ux * t - qx, dy = uy * t - qy, dz = uz * t - qz;
    return dx * dx + dy * dy + dz * dz;
  };
  let d2: number;
  if (side(bax, bay, baz, pax, pay, paz) + side(cbx, cby, cbz, pbx, pby, pbz) + side(acx, acy, acz, pcx, pcy, pcz) < 2) {
    d2 = Math.min(seg(bax, bay, baz, pax, pay, paz), seg(cbx, cby, cbz, pbx, pby, pbz), seg(acx, acy, acz, pcx, pcy, pcz));
  } else {
    const dn = nx * pax + ny * pay + nz * paz;
    d2 = dn * dn / (nx * nx + ny * ny + nz * nz);
  }
  return Math.sqrt(d2) - thick;
}

function sdPrim(p: Prim, x: number, y: number, z: number): number {
  if (p.kind === ELL) return sdEllipsoid(x - p.a[0], y - p.a[1], z - p.a[2], p.r);
  if (p.kind === CONE) return sdRoundCone(x, y, z, p.a, p.b, p.r[0], p.r[1]);
  return sdTriangle(x, y, z, p.a, p.b, p.c, p.r[0]);
}

function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ─── Body plans ──────────────────────────────────────────────────────────────

interface Traits {
  bulk: number;         // girth multiplier from size
  seed: number;
  carn: boolean; herb: boolean; producer: boolean;
  aggr: number; intel: number;
  sense: string; mobility: string; body: string;
  deep: boolean;
}

function traitsOf(g: SpeciesGenome): Traits {
  const SIZE_BULK: Record<string, number> = { microscopic: 0.85, tiny: 0.9, small: 0.95, medium: 1, large: 1.12, massive: 1.25 };
  return {
    bulk: SIZE_BULK[g.physicalTraits.size] ?? 1,
    seed: hashStr(g.id),
    carn: g.dna.diet === 'carnivore', herb: g.dna.diet === 'herbivore',
    producer: g.dna.diet === 'producer' || g.dna.metabolism === 'photosynthetic',
    aggr: g.dna.aggression, intel: g.dna.intelligence,
    sense: g.physicalTraits.sensorySystem, mobility: g.physicalTraits.mobilityType,
    body: g.physicalTraits.bodyStructure,
    deep: g.dna.environment === 'deep_sea',
  };
}

/** Eye style from the sensory system. */
function eyeStyle(t: Traits): Eye['style'] {
  if (t.sense === 'vision' || t.sense === 'magnetoreception') return 'vision';
  if (t.sense === 'compound eyes') return 'compound';
  if (t.sense === 'photoreception') return 'spot';
  return 'small';
}

/** Parts on a head at `h` (centre) with radius `hr`, facing +x. */
function headParts(B: Body, t: Traits, h: V3, hr: number, gHead: number, gNear: number, gFar: number): void {
  const [hx, hy] = h;
  // Senses.
  if (t.sense === 'chemoreception' || t.sense === 'tactile bristles' || t.sense === 'compound eyes') {
    for (const s of [1, -1]) {
      B.chain([[hx + hr * 0.4, hy + hr * 0.6, s * hr * 0.3], [hx + hr * 1.3, hy + hr * 1.6, s * hr * 0.6],
               [hx + hr * 2.3, hy + hr * 1.9, s * hr * 0.8]], hr * 0.09, hr * 0.05, ACCENT, s > 0 ? gNear : gFar);
    }
  }
  if (t.sense === 'echolocation') {
    for (const s of [1, -1]) {
      B.tri([hx - hr * 0.1, hy + hr * 0.6, s * hr * 0.4], [hx - hr * 0.5, hy + hr * 1.9, s * hr * 0.55],
            [hx - hr * 0.6, hy + hr * 0.5, s * hr * 0.4], hr * 0.07, ACCENT, s > 0 ? gNear : gFar);
    }
  }
  if (t.sense === 'electroreception') {
    for (const s of [1, -1]) {
      B.chain([[hx + hr * 0.8, hy - hr * 0.4, s * hr * 0.3], [hx + hr * 1.2, hy - hr * 1.1, s * hr * 0.4],
               [hx + hr * 1.0, hy - hr * 1.6, s * hr * 0.45]], hr * 0.08, hr * 0.04, ACCENT, s > 0 ? gNear : gFar);
    }
  }
  if (t.sense === 'magnetoreception') {
    B.tri([hx - hr * 0.6, hy + hr * 0.7, 0], [hx + hr * 0.3, hy + hr * 0.9, 0], [hx - hr * 0.5, hy + hr * 1.8, 0], hr * 0.08, ACCENT, gHead);
  }
  if (t.sense === 'thermal pits') {
    B.dots.push({ p: [hx + hr * 0.75, hy - hr * 0.1, hr * 0.55], mat: GLOW });
  }
  // Horns at high aggression.
  if (t.aggr >= 8) {
    for (const s of [1, -1]) {
      B.chain([[hx - hr * 0.05, hy + hr * 0.6, s * hr * 0.5], [hx - hr * 0.3, hy + hr * 1.6, s * hr * 0.75],
               [hx - hr * 1.0, hy + hr * 2.2, s * hr * 0.8], [hx - hr * 1.7, hy + hr * 2.0, s * hr * 0.8]],
        hr * 0.32, hr * 0.06, BONE, s > 0 ? gNear : gFar);
    }
  }
  const style = eyeStyle(t);
  const eyeSize = style === 'compound' ? 1.4 : style === 'vision' ? 1.1 : 0.8;
  B.eyes.push({ p: [hx + hr * 0.55, hy + hr * 0.35, hr * 0.62], style, size: eyeSize * (t.intel >= 6 ? 1.1 : 1) });
}

/** Dorsal spikes along a line at y above x0..x1 (aggression). */
function spikes(B: Body, t: Traits, x0: number, x1: number, yAt: (x: number) => number, g: number): void {
  if (t.aggr < 5) return;
  const n = t.aggr >= 8 ? 5 : 4;
  for (let i = 0; i < n; i++) {
    const x = x0 + (x1 - x0) * (i + 0.5) / n, y = yAt(x);
    const h = 0.07 + (t.aggr - 4) * 0.012;
    B.cone([x, y - 0.02, 0], [x - 0.04, y + h, 0], 0.035, 0.006, BONE, g);
  }
}

function planQuadruped(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.03), gBody = B.group(0, 0.09), gNear = B.group(1, 0.03), gHead = B.group(0, 0.05);
  const legTop = -0.04, ground = -0.5;
  B.ell([0, 0, 0], [0.4, 0.17 * k, 0.15 * k], PRIMARY, gBody);
  B.ell([0.22, 0.02, 0], [0.19, 0.19 * k, 0.16 * k], PRIMARY, gBody);
  B.ell([-0.23, 0.03, 0], [0.18, 0.18 * k, 0.15 * k], PRIMARY, gBody);
  B.cone([0.3, 0.06, 0], [0.45, 0.24, 0], 0.11 * k, 0.08 * k, PRIMARY, gBody);
  const h: V3 = [0.53, 0.28, 0], hr = 0.12 * k;
  B.ell(h, [hr * 1.15, hr, hr * 0.9], PRIMARY, gHead);
  // Muzzle: long and toothy on hunters, short and broad on grazers.
  const snoutLen = t.carn ? 0.17 : t.herb ? 0.1 : 0.13;
  B.cone([h[0] + hr * 0.5, h[1] - hr * 0.15, 0], [h[0] + hr * 0.5 + snoutLen, h[1] - hr * 0.45, 0],
    hr * 0.62, hr * (t.herb ? 0.5 : 0.36), PRIMARY, gHead);
  if (t.carn) B.cone([h[0] + hr * 0.9, h[1] - hr * 0.75, hr * 0.3], [h[0] + hr * 0.95, h[1] - hr * 1.1, hr * 0.3], 0.018, 0.004, BONE, gHead);
  headParts(B, t, h, hr, gHead, gNear, gFar);
  // Legs: front pair straight, hind pair with a bent hock.
  // A trot: diagonal pairs move together (near-front with far-hind).
  for (const [s, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
    const z = s * 0.1 * k;
    const of = s > 0 ? 0 : 0.5, oh = s > 0 ? 0.5 : 0;
    const [fs, fl] = step(of, 0.66), [hs, hl] = step(oh, 0.66);
    const fx = STRIDE * fs, fy = 0.06 * fl, hx = STRIDE * hs, hy = 0.06 * hl;
    B.cone([0.24, legTop, z], [0.27 + fx * 0.5, -0.3 + fy * 0.5, z], 0.07 * k, 0.05 * k, PRIMARY, g);
    B.cone([0.27 + fx * 0.5, -0.3 + fy * 0.5, z], [0.26 + fx, ground + fy, z], 0.05 * k, 0.04 * k, PRIMARY, g);
    B.ell([0.29 + fx, ground + 0.015 + fy, z], [0.05, 0.022, 0.035], s > 0 ? BELLY : MARK, g);
    B.cone([-0.25, legTop, z], [-0.31 + hx * 0.5, -0.25 + hy * 0.5, z], 0.09 * k, 0.06 * k, PRIMARY, g);
    B.cone([-0.31 + hx * 0.5, -0.25 + hy * 0.5, z], [-0.26 + hx, ground + hy, z], 0.05 * k, 0.04 * k, PRIMARY, g);
    B.ell([-0.23 + hx, ground + 0.015 + hy, z], [0.05, 0.022, 0.035], s > 0 ? BELLY : MARK, g);
  }
  const tw = 0.04 * sw(0.25);
  B.chain([[-0.36, 0.06, 0], [-0.52, 0.13 + tw * 0.5, 0], [-0.66, 0.1 + tw, 0]], 0.06 * k, 0.018, PRIMARY, gBody);
  spikes(B, t, -0.3, 0.28, x => 0.15 * k + 0.02 * Math.cos(x * 4), gBody);
}

function planBiped(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.03), gBody = B.group(0, 0.07), gNear = B.group(1, 0.03), gHead = B.group(0, 0.04);
  const brain = 1 + Math.max(0, t.intel - 5) * 0.05;
  B.ell([0, 0.12, 0], [0.15 * k, 0.22, 0.13 * k], PRIMARY, gBody);
  B.ell([0.0, -0.08, 0], [0.12 * k, 0.1, 0.1 * k], PRIMARY, gBody);
  B.cone([0.01, 0.3, 0], [0.03, 0.4, 0], 0.06, 0.05, PRIMARY, gBody);
  const h: V3 = [0.04, 0.5, 0], hr = 0.11 * brain;
  B.ell(h, [hr * 1.05, hr * 1.05, hr], PRIMARY, gHead);
  B.cone([h[0] + hr * 0.6, h[1] - hr * 0.3, 0], [h[0] + hr * 1.2, h[1] - hr * 0.55, 0], hr * 0.45, hr * 0.3, PRIMARY, gHead);
  headParts(B, t, h, hr, gHead, gNear, gFar);
  for (const [s, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
    const z = s * 0.08 * k;
    // Legs alternate; each arm swings against its leg.
    const o = s > 0 ? 0 : 0.5, [ls, ll] = step(o, 0.62);
    const lx = STRIDE * ls, ly = 0.07 * ll, ax = -0.4 * STRIDE * ls;
    B.cone([0, -0.1, z], [0.03 + lx * 0.5, -0.3 + ly * 0.6, z], 0.065 * k, 0.05 * k, PRIMARY, g);
    B.cone([0.03 + lx * 0.5, -0.3 + ly * 0.6, z], [lx, -0.5 + ly, z], 0.05 * k, 0.04 * k, PRIMARY, g);
    B.ell([0.04 + lx, -0.49 + ly, z], [0.06, 0.022, 0.035], MARK, g);
    // Arms: the near one reaches forward, as if to grasp.
    const az = s * 0.17 * k;
    B.ell([0.0, 0.27, az * 0.85], [0.06, 0.05, 0.05], PRIMARY, g);
    B.cone([0.0, 0.27, az], [(s > 0 ? 0.08 : 0.04) + ax * 0.6, 0.08, az * 1.1], 0.05 * k, 0.038 * k, PRIMARY, g);
    B.cone([(s > 0 ? 0.08 : 0.04) + ax * 0.6, 0.08, az * 1.1], [(s > 0 ? 0.2 : 0.1) + ax, 0.02, az * 1.1], 0.038 * k, 0.03 * k, PRIMARY, g);
    B.ell([(s > 0 ? 0.22 : 0.11) + ax, 0.01, az * 1.1], [0.035, 0.03, 0.03], BELLY, g);
  }
  spikes(B, t, -0.05, 0.05, () => 0.32, gBody);
}

function planInsectWalker(B: Body, t: Traits, legsPerSide = 3): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.02), gBody = B.group(0, 0.03), gNear = B.group(1, 0.02), gHead = B.group(0, 0.02);
  B.ell([-0.24, 0.0, 0], [0.24, 0.15 * k, 0.15 * k], PRIMARY, gBody);
  B.ell([0.08, 0.02, 0], [0.13, 0.1 * k, 0.1 * k], PRIMARY, gBody);
  const h: V3 = [0.26, 0.04, 0], hr = 0.09;
  B.ell(h, [hr * 1.1, hr, hr], PRIMARY, gHead);
  headParts(B, t, h, hr, gHead, gNear, gFar);
  for (const [s, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
    for (let i = 0; i < legsPerSide; i++) {
      const x = 0.12 - i * 0.12, z = s * 0.08;
      // Tripod gait: legs 0 and 2 of one side step with leg 1 of the other.
      const o = ((i & 1) === (s > 0 ? 0 : 1)) ? 0 : 0.5;
      const [ss, sl] = step(o, 0.6);
      const fx = STRIDE * ss, fy = 0.06 * sl;
      const knee: V3 = [x + 0.06 - i * 0.05 + fx * 0.5, 0.12 + fy, z * 2.6];
      B.cone([x, 0, z], knee, 0.03, 0.022, MARK, g);
      B.cone(knee, [x + 0.08 - i * 0.12 + fx, -0.3 + fy * 0.6, z * 3.2], 0.022, 0.012, MARK, g);
    }
  }
  if (t.carn) {
    for (const [s, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
      B.cone([h[0] + 0.06, h[1] - 0.04, s * 0.04], [h[0] + 0.13, h[1] - 0.08, s * 0.02], 0.02, 0.008, BONE, g);
    }
  }
  spikes(B, t, -0.4, -0.05, x => 0.13 * k + 0.02 * Math.cos(x * 6), gBody);
}

function planCrawler(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.02), gBody = B.group(0, 0.06), gNear = B.group(1, 0.02), gHead = B.group(0, 0.04);
  const segs = 6;
  for (let i = 0; i < segs; i++) {
    const u = i / (segs - 1), x = 0.32 - u * 0.7, r = (0.12 - u * 0.05) * k;
    // A wave runs back along the body; the little legs ripple with it.
    const y = -0.32 + r + Math.sin(u * 4) * 0.02 + 0.025 * sw(-u * 0.8);
    B.ell([x, y, 0], [r * 0.95, r, r], i % 2 ? PRIMARY : MARK, gBody);
    for (const [s, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
      B.cone([x, y - r * 0.4, s * r * 0.6], [x + 0.03 + 0.03 * sw(-u * 0.8 + (s > 0 ? 0 : 0.5)), -0.32, s * r * 1.1], 0.018, 0.01, ACCENT, g);
    }
  }
  const h: V3 = [0.44, -0.32 + 0.1 * k, 0], hr = 0.1 * k;
  B.ell(h, [hr, hr * 0.9, hr * 0.9], PRIMARY, gHead);
  headParts(B, t, h, hr, gHead, gNear, gFar);
  spikes(B, t, -0.35, 0.3, x => -0.32 + 0.22 * k - (0.3 - x) * 0.06, gBody);
}

function planCrab(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.02), gBody = B.group(0, 0.05), gNear = B.group(1, 0.02);
  B.ell([0, -0.08, 0], [0.28 * k, 0.13 * k, 0.24 * k], SHELL, gBody);
  B.ell([0, -0.14, 0], [0.24 * k, 0.07, 0.2 * k], BELLY, gBody);
  for (const [s, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
    for (let i = 0; i < 4; i++) {
      const x = 0.14 - i * 0.11, z = s * 0.2 * k;
      // Sidestepping: alternate legs lift and reach out sideways.
      const o = (i + (s > 0 ? 0 : 1)) & 1 ? 0.5 : 0;
      const fz = 0.05 * sw(o) * s, fy = 0.05 * up(o);
      const knee: V3 = [x - 0.03, 0.02 + fy, s * 0.36 * k + fz * 0.5];
      B.cone([x, -0.1, z], knee, 0.03, 0.025, MARK, g);
      B.cone(knee, [x - 0.08, -0.36 + fy * 0.6, s * 0.42 * k + fz], 0.025, 0.012, MARK, g);
    }
    // Claws: big pincers on hunters, small on the rest.
    const cl = t.carn ? 1.3 : 0.8;
    B.cone([0.2, -0.08, s * 0.16], [0.36, -0.02, s * 0.24], 0.04, 0.035, SHELL, g);
    B.ell([0.44, 0.0, s * 0.26], [0.08 * cl, 0.05 * cl, 0.045 * cl], SHELL, g);
    // The pincer's upper finger opens and snaps shut.
    B.cone([0.47, 0.03, s * 0.26], [0.58, 0.06 + 0.04 * up(0.25), s * 0.26], 0.025 * cl, 0.008, SHELL, g);
  }
  B.eyes.push({ p: [0.2, 0.08, 0.08], style: eyeStyle(t), size: 1 });
  B.cone([0.18, -0.02, 0.08], [0.2, 0.07, 0.08], 0.015, 0.012, MARK, gBody);
  spikes(B, t, -0.2, 0.15, () => 0.03 * k, gBody);
}

function planSnail(B: Body, t: Traits): void {
  const k = t.bulk;
  const gBody = B.group(0, 0.06, true), gShell = B.group(0, 0.02), gFar = B.group(-1, 0.02), gNear = B.group(1, 0.02);
  // The foot stretches forward and gathers back.
  const st = 0.03 * sw();
  B.ell([0.02 + st, -0.38, 0], [0.42 + st, 0.08, 0.13 * k], BELLY, gBody);
  B.cone([0.3 + st, -0.36, 0], [0.44 + st * 1.5, -0.24, 0], 0.08, 0.07, BELLY, gBody);
  B.ell([-0.06, -0.12, 0], [0.24 * k, 0.24 * k, 0.17 * k], SHELL, gShell);
  B.shell = [-0.06, -0.12, 0];
  for (const [s, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
    B.cone([0.44 + st * 1.5, -0.22, s * 0.04], [0.5 + st * 1.5 + 0.02 * sw(0.25 * s), -0.04, s * 0.06], 0.02, 0.015, BELLY, g);
  }
  B.eyes.push({ p: [0.5 + st * 1.5, -0.03, 0.08], style: eyeStyle(t), size: 0.8 });
  spikes(B, t, -0.2, 0.1, x => -0.12 + 0.24 * k * Math.sqrt(Math.max(0, 1 - ((x + 0.06) / (0.24 * k)) ** 2)), gShell);
}

function planFish(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.02), gBody = B.group(0, 0.09), gNear = B.group(1, 0.02), gFin = B.group(0, 0.02, true);
  const shark = t.body === 'cartilaginous' || t.carn;
  B.ell([0, 0, 0], [0.42, 0.19 * k, 0.12 * k], PRIMARY, gBody);
  B.ell([0.26, 0.0, 0], [0.2, 0.16 * k, 0.11 * k], PRIMARY, gBody);
  if (shark) B.cone([0.38, 0.0, 0], [0.56, -0.02, 0], 0.11 * k, 0.03, PRIMARY, gBody);
  // The tail sweeps side to side (and the flank follows a little).
  const tz = 0.13 * sw();
  B.cone([-0.3, 0, tz * 0.2], [-0.56, 0.01, tz * 0.6], 0.11 * k, 0.035, PRIMARY, gBody);
  B.tri([-0.52, 0, tz * 0.6], [-0.74, 0.22, tz * 1.2], [-0.7, -0.2, tz * 1.2], 0.012, ACCENT, gFin);
  B.tri([-0.12, 0.16 * k, 0], [0.12, 0.17 * k, 0], [-0.16, 0.36 * k + (shark ? 0.06 : 0), 0], 0.012, ACCENT, gFin);
  const pf = 0.05 * sw(0.25);
  B.tri([0.12, -0.08, 0.1], [-0.02, -0.24 + pf, 0.18], [0.18, -0.16 + pf, 0.14], 0.01, ACCENT, gNear);
  B.tri([0.12, -0.08, -0.1], [-0.02, -0.24 - pf, -0.18], [0.18, -0.16 - pf, -0.14], 0.01, ACCENT, gFar);
  B.eyes.push({ p: [0.36, 0.05, 0.085 * k], style: eyeStyle(t), size: 1 });
  if (t.carn && t.deep) {
    // Angler's lure: a rod off the brow with a glowing bulb.
    B.chain([[0.3, 0.14 * k, 0], [0.42, 0.34, 0], [0.56, 0.36, 0], [0.62, 0.28, 0]], 0.014, 0.008, ACCENT, gFin);
    B.ell([0.63, 0.25, 0], [0.035, 0.035, 0.035], GLOW, gFin);
  }
  if (t.carn) B.cone([0.5, -0.07, 0.04], [0.5, -0.11, 0.05], 0.012, 0.003, BONE, gBody);
  if (t.sense === 'electroreception' || t.sense === 'chemoreception') {
    for (const [s, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
      B.chain([[0.46, -0.06, s * 0.05], [0.52, -0.18, s * 0.07], [0.48, -0.28, s * 0.08]], 0.014, 0.006, ACCENT, g);
    }
  }
  spikes(B, t, -0.3, 0.2, () => 0.17 * k, gFin);
}

function planRay(B: Body, t: Traits): void {
  const gBody = B.group(0, 0.08), gTail = B.group(0, 0.02);
  // The wing disc rises and falls at its tips; the tail whips.
  const wv = 0.07 * sw();
  B.ell([0, 0, 0], [0.32, 0.06, 0.3], PRIMARY, gBody);
  for (const s of [-1, 1]) B.ell([-0.02, wv * 0.6, s * 0.28], [0.26, 0.045, 0.16], PRIMARY, gBody);
  B.ell([0.2, 0.02, 0], [0.12, 0.06, 0.1], PRIMARY, gBody);
  B.chain([[-0.28, 0, 0], [-0.55, 0.03, 0.05 * sw(0.3)], [-0.8, 0.07, 0.1 * sw(0.5)]], 0.03, 0.006, PRIMARY, gTail);
  B.eyes.push({ p: [0.24, 0.07, 0.08], style: eyeStyle(t), size: 0.9 });
  B.eyes.push({ p: [0.24, 0.07, -0.08], style: eyeStyle(t), size: 0.9 });
}

function planSquid(B: Body, t: Traits): void {
  const gBody = B.group(0, 0.06), gArms = B.group(0, 0.03), gFin = B.group(0, 0.02, true);
  B.ell([-0.1, 0.0, 0], [0.32, 0.13 * t.bulk, 0.12 * t.bulk], PRIMARY, gBody);
  B.tri([-0.36, 0.0, 0], [-0.5, 0.16, 0], [-0.5, -0.16, 0], 0.012, ACCENT, gFin);
  B.ell([0.24, 0.0, 0], [0.1, 0.09, 0.09], PRIMARY, gBody);
  for (let i = 0; i < 6; i++) {
    const a = (i / 5 - 0.5) * 1.2;
    const wv = 0.05 * sw(i / 6);
    B.chain([[0.3, Math.sin(a) * 0.04, Math.cos(i) * 0.04], [0.45, Math.sin(a) * 0.12 + wv * 0.5, Math.cos(i) * 0.06],
             [0.6 - 0.04 * up(), Math.sin(a) * 0.18 - 0.02 + wv, Math.cos(i) * 0.07]], 0.03, 0.008, PRIMARY, gArms);
  }
  B.eyes.push({ p: [0.27, 0.04, 0.08], style: eyeStyle(t), size: 1.2 });
}

function planJelly(B: Body, t: Traits): void {
  const gBell = B.group(0, 0.05, true), gT = B.group(0, 0.02, true);
  // The bell squeezes (narrow and tall) and relaxes (wide and flat).
  const pz = 0.1 * sw();
  B.ell([0, 0.1, 0], [0.3 * t.bulk * (1 - pz), 0.2 * t.bulk * (1 + pz), 0.3 * t.bulk * (1 - pz)], PRIMARY, gBell);
  B.ell([0, 0.0, 0], [0.26 * t.bulk * (1 - pz), 0.06, 0.26 * t.bulk * (1 - pz)], BELLY, gBell);
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, x = Math.cos(a) * 0.2, z = Math.sin(a) * 0.2;
    const wv = 0.05 * sw(-0.2 - i * 0.05);
    B.chain([[x * (1 - pz), -0.02, z * (1 - pz)], [x * 1.1 + 0.03 + wv * 0.5, -0.25, z * 1.1], [x * 0.9 - 0.04 - wv, -0.45, z], [x + 0.03 + wv, -0.62, z]],
      0.022, 0.006, i % 2 ? ACCENT : PRIMARY, gT);
  }
  B.dots.push({ p: [0.0, 0.2, 0.28], mat: GLOW });
}

function planBird(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.02), gBody = B.group(0, 0.07), gNear = B.group(1, 0.02), gHead = B.group(0, 0.04);
  const membrane = t.mobility === 'membrane wings';
  B.ell([0, 0.0, 0], [0.24, 0.13 * k, 0.12 * k], PRIMARY, gBody);
  const h: V3 = [0.24, 0.12, 0], hr = 0.09 * k;
  B.ell(h, [hr * 1.1, hr, hr], PRIMARY, gHead);
  B.cone([h[0] + hr * 0.8, h[1] - hr * 0.1, 0], [h[0] + hr * (t.carn ? 2.0 : 1.7), h[1] - hr * (t.carn ? 0.6 : 0.3), 0],
    hr * 0.35, hr * 0.06, membrane ? PRIMARY : BONE, gHead);
  headParts(B, t, h, hr, gHead, gNear, gFar);
  // Wings raised mid-beat, built from a fan of feathers (or a webbed hand
  // for membrane wings); the far wing peeks over the back.
  // The beat: phase 0 is the old raised pose; the wings sweep down to below
  // the body and back. Heights scale about the shoulder; reach widens at the
  // bottom of the stroke.
  const beat = 0.33 + 0.67 * flap();                       // 1 up … -0.33 down (level-ish)
  const reach = 1 + 0.25 * (1 - beat) / 1.6;
  const wy = (y: number) => 0.07 + (y - 0.07) * beat;
  for (const [sd, g] of [[1, gNear], [-1, gFar]] as Array<[number, number]>) {
    const root: V3 = [0.04, 0.07, sd * 0.08];
    const tips: V3[] = ([[-0.06, 0.52, sd * 0.3], [-0.2, 0.5, sd * 0.32], [-0.32, 0.38, sd * 0.28], [-0.38, 0.2, sd * 0.2]] as V3[])
      .map(([x, y, z]) => [x, wy(y), z * reach] as V3);
    if (membrane) {
      const elbow: V3 = [-0.02, wy(0.3), sd * 0.22 * reach];
      B.chain([root, elbow, tips[0]], 0.022, 0.012, PRIMARY, g);
      for (let i = 0; i < tips.length - 1; i++) B.tri(elbow, tips[i], tips[i + 1], 0.01, WING, g);
      B.tri(root, elbow, tips[3], 0.01, WING, g);
      B.tri(root, tips[3], [-0.22, 0.04, sd * 0.1], 0.01, WING, g);
    } else {
      B.ell([-0.06, wy(0.18), sd * 0.14], [0.12, 0.1, 0.04], PRIMARY, g);
      tips.forEach((tp, i) => B.tri([-0.04 - i * 0.05, wy(0.16), sd * 0.13], tp, [tp[0] - 0.07, tp[1] - 0.1 * beat, tp[2]], 0.012, i % 2 ? MARK : PRIMARY, g));
    }
  }
  B.tri([-0.2, 0.0, 0], [-0.46, 0.08, 0.05], [-0.44, -0.08, -0.05], 0.012, ACCENT, gBody);
  for (const [s, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
    B.cone([0.0, -0.1, s * 0.05], [0.02, -0.26, s * 0.05], 0.02, 0.012, BONE, g);
  }
}

function planFlyingInsect(B: Body, t: Traits): void {
  const gFar = B.group(-1, 0.02), gBody = B.group(0, 0.03), gNear = B.group(1, 0.02), gHead = B.group(0, 0.02);
  B.ell([-0.2, 0, 0], [0.22, 0.09, 0.09], MARK, gBody);
  B.ell([0.06, 0.02, 0], [0.1, 0.08, 0.08], PRIMARY, gBody);
  const h: V3 = [0.2, 0.03, 0], hr = 0.07;
  B.ell(h, [hr, hr, hr], PRIMARY, gHead);
  headParts(B, t, h, hr, gHead, gNear, gFar);
  for (const [s, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
    // Wings buzz: two beats per cycle, flicking between high and low.
    const hi = Math.cos(PH * TAU * 2) > 0 ? 1 : 0.35;
    const wy = (y: number) => 0.08 + (y - 0.08) * hi;
    B.tri([0.06, 0.08, s * 0.04], [-0.14, wy(0.42), s * 0.2], [-0.28, wy(0.3), s * 0.16], 0.008, WING, g);
    B.tri([0.02, 0.07, s * 0.04], [-0.3, wy(0.26), s * 0.14], [-0.34, wy(0.12), s * 0.1], 0.008, WING, g);
    for (let i = 0; i < 3; i++) B.cone([0.08 - i * 0.05, -0.04, s * 0.04], [0.12 - i * 0.1, -0.24, s * 0.1], 0.012, 0.007, MARK, g);
  }
}

function planBalloon(B: Body, t: Traits): void {
  const g = B.group(0, 0.05), gT = B.group(0, 0.02, true);
  B.ell([0, 0.12, 0], [0.26, 0.28, 0.26], PRIMARY, g);
  B.ell([0, -0.14, 0], [0.12, 0.06, 0.12], BELLY, g);
  for (let i = 0; i < 4; i++) {
    const x = -0.06 + i * 0.04;
    const wv = 0.04 * sw(i * 0.2);
    B.chain([[x, -0.16, 0.04 * (i - 1.5)], [x - 0.03 + wv * 0.5, -0.36, 0.05], [x + 0.02 + wv, -0.55, 0.05]], 0.016, 0.005, ACCENT, gT);
  }
  B.eyes.push({ p: [0.18, 0.12, 0.17], style: eyeStyle(t), size: 1 });
}

function planPolyp(B: Body, t: Traits): void {
  const gBody = B.group(0, 0.05), gCrown = B.group(0, 0.02, true);
  B.ell([0, -0.5, 0], [0.14, 0.04, 0.14], MARK, gBody);
  B.cone([0, -0.48, 0], [0, 0.05, 0], 0.08 * t.bulk, 0.11 * t.bulk, PRIMARY, gBody);
  B.ell([0, 0.06, 0], [0.13 * t.bulk, 0.06, 0.13 * t.bulk], BELLY, gBody);
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    // The crown opens wide and curls in.
    const open = 1 + 0.25 * sw(i / n * 0.3);
    B.chain([[dx * 0.08, 0.08, dz * 0.08], [dx * 0.2 * open, 0.22, dz * 0.2 * open], [dx * 0.26 * open, 0.36 - 0.04 * (open - 1), dz * 0.24 * open]],
      0.025, 0.008, i % 2 ? ACCENT : PRIMARY, gCrown);
  }
}

function planPlant(B: Body, t: Traits): void {
  const gStem = B.group(0, 0.04), gLeaf = B.group(0, 0.01, true), gNear = B.group(1, 0.01, true), gFar = B.group(-1, 0.01, true);
  B.ell([0, -0.5, 0], [0.12, 0.035, 0.12], MARK, gStem);
  // Sways in the breeze: more at the top.
  const sy = 0.035 * sw();
  B.chain([[0, -0.5, 0], [0.03 + sy * 0.2, -0.2, 0], [-0.02 + sy * 0.6, 0.1, 0], [0.01 + sy, 0.3, 0]], 0.05 * t.bulk, 0.025, PRIMARY, gStem);
  const leaves: Array<[number, number, number]> = [[-0.28, 1, -0.32], [-0.02, -1, -0.12], [0.18, 1, 0.08]];
  for (const [y, s, tilt] of leaves) {
    const g = s > 0 ? gNear : gFar;
    const lx = sy * (y + 0.5) / 0.8;
    B.tri([0.01 + lx, y, 0], [0.32 * s + 0.05 + lx, y + 0.12 + tilt * 0.1 + 0.02 * sw(0.2), s * 0.12], [0.18 * s + lx, y - 0.06, s * 0.1], 0.012, LEAF, g);
  }
  // Crown: a flower on a producer, a spore cap on anything else.
  if (t.producer) B.ell([0.01 + sy, 0.36, 0], [0.11, 0.07, 0.11], ACCENT, gLeaf);
  else B.ell([0.01 + sy, 0.34, 0], [0.2, 0.08, 0.2], ACCENT, gLeaf);
}

function planCell(B: Body, t: Traits): void {
  const g = B.group(0, 0.04), gF = B.group(0, 0.02, true);
  B.ell([0, 0, 0], [0.3, 0.24, 0.24], PRIMARY, g);
  B.ell([0.06, 0.03, 0.12], [0.09, 0.08, 0.08], MARK, g);
  if (t.mobility === 'flagella' || t.mobility === 'jet siphon') {
    const fl: V3[] = [];
    for (let i = 0; i < 5; i++) fl.push([-0.28 - i * 0.135, 0.07 * Math.sin(i * 1.4 - PH * TAU) * (i > 0 ? 1 : 0), 0]);
    B.chain(fl, 0.02, 0.008, ACCENT, gF);
  } else {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const ln = 1 + 0.25 * sw(i / 10);
      B.cone([Math.cos(a) * 0.28, Math.sin(a) * 0.22, 0.05], [Math.cos(a) * 0.38 * ln, Math.sin(a) * 0.31 * ln, 0.05], 0.012, 0.006, ACCENT, gF);
    }
  }
  if (t.sense === 'photoreception') B.eyes.push({ p: [0.24, 0.08, 0.14], style: 'spot', size: 0.9 });
}

function planColony(B: Body, t: Traits): void {
  const g = B.group(0, 0.08);
  const pts: V3[] = [[0, 0, 0], [0.2, 0.06, 0.05], [-0.18, 0.08, -0.04], [0.06, 0.22, -0.02], [-0.06, -0.14, 0.06], [0.18, -0.12, -0.05], [-0.22, -0.1, 0.02]];
  // The cells swell in turn.
  pts.forEach((p, i) => { const b = 1 + 0.08 * sw(i / pts.length); B.ell(p, [0.13 * b, 0.12 * b, 0.12 * b], i % 3 === 0 ? MARK : PRIMARY, g); });
  if (t.sense === 'photoreception') B.eyes.push({ p: [0.28, 0.08, 0.1], style: 'spot', size: 0.8 });
}

function planStar(B: Body, t: Traits): void {
  const g = B.group(0, 0.06);
  B.ell([0, -0.3, 0], [0.13, 0.06, 0.13], PRIMARY, g);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    // Arm tips lift in turn, a slow crawl.
    B.cone([0, -0.3, 0], [Math.cos(a) * 0.42, -0.33 + 0.05 * up(i / 5), Math.sin(a) * 0.42], 0.09 * t.bulk, 0.025, i % 2 ? PRIMARY : MARK, g);
  }
}

function planWorm(B: Body, t: Traits): void {
  const g = B.group(0, 0.06);
  const pts: V3[] = [];
  // A travelling wave: the bends slide back along the body.
  for (let i = 0; i < 8; i++) pts.push([0.4 - i * 0.12, -0.3 + Math.sin(i * 0.9 - PH * TAU) * 0.08, 0]);
  B.chain(pts, 0.07 * t.bulk, 0.03, PRIMARY, g);
  B.eyes.push({ p: [0.44, pts[0][1] + 0.03, 0.05], style: eyeStyle(t), size: 0.7 });
}

/** Pick and build the body plan for a genome. */
// ─── Sapient forms ───────────────────────────────────────────────────────────
//
// A walking lineage that has grown a mind stands up. WHICH people it becomes
// follows from what it was: vertebrates become humanoids, reptilians or
// avians; armoured lineages insectoids; soft-bodied ones cephaloids; fungal
// mats mycoids; silicate life crystallines; machine life mechanoids.

/** Two walking legs and one or two pairs of arms, for the upright forms. */
function uprightLimbs(B: Body, t: Traits, gNear: number, gFar: number, o: {
  hipY: number; shY: number; legW: number; armW: number; mat?: number; hand?: number; armPairs?: number; digitigrade?: boolean; robot?: boolean;
}): void {
  const k = t.bulk, mat = o.mat ?? PRIMARY, hand = o.hand ?? BELLY;
  for (const [s, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
    const z = s * 0.08 * k;
    const ph = s > 0 ? 0 : 0.5, [ls, ll] = step(ph, 0.62);
    const lx = STRIDE * ls, ly = 0.07 * ll, ax = -0.4 * STRIDE * ls;
    const knee: V3 = o.digitigrade ? [0.08 + lx * 0.5, o.hipY - 0.2 + ly * 0.6, z] : [0.03 + lx * 0.5, (o.hipY - 0.5) / 2 + ly * 0.6, z];
    B.cone([0, o.hipY, z], knee, o.legW * k, o.legW * 0.78 * k, mat, g);
    if (o.digitigrade) {
      const ankle: V3 = [-0.02 + lx * 0.8, -0.38 + ly, z];
      B.cone(knee, ankle, o.legW * 0.78 * k, o.legW * 0.6 * k, mat, g);
      B.cone(ankle, [0.03 + lx, -0.5 + ly, z], o.legW * 0.55 * k, o.legW * 0.45 * k, mat, g);
    } else {
      B.cone(knee, [lx, -0.5 + ly, z], o.legW * 0.78 * k, o.legW * 0.62 * k, mat, g);
    }
    if (o.robot) B.ell(knee, [0.045, 0.045, 0.045], ACCENT, g);
    B.ell([0.04 + lx, -0.49 + ly, z], [0.065, 0.024, 0.04], o.robot ? ACCENT : MARK, g);
    for (let pr = 0; pr < (o.armPairs ?? 1); pr++) {
      const ay = o.shY - pr * 0.12, az = s * (0.16 - pr * 0.02) * k, reach = s > 0 ? 1 : 0.5;
      const elbow: V3 = [0.05 * reach + ax * 0.6, ay - 0.17, az * 1.1];
      B.ell([0, ay, az * 0.85], [0.055, 0.05, 0.05], mat, g);
      B.cone([0, ay, az], elbow, o.armW * k, o.armW * 0.78 * k, mat, g);
      B.cone(elbow, [0.17 * reach + ax, ay - 0.24, az * 1.1], o.armW * 0.78 * k, o.armW * 0.6 * k, mat, g);
      if (o.robot) B.ell(elbow, [0.035, 0.035, 0.035], ACCENT, g);
      B.ell([0.19 * reach + ax, ay - 0.25, az * 1.1], [0.034, 0.03, 0.03], hand, g);
    }
  }
}

function planHumanoid(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.03), gBody = B.group(0, 0.07), gNear = B.group(1, 0.03), gHead = B.group(0, 0.04);
  // Build varies by lineage: slender and tall, or broad and stocky.
  const lean = hash3(t.seed, 11, 2, 7);
  const w = 0.13 + lean * 0.05, tall = 1 + (0.5 - lean) * 0.12;
  B.ell([0, 0.12 * tall, 0], [w * k, 0.22 * tall, w * 0.85 * k], PRIMARY, gBody);
  B.ell([0, -0.08, 0], [w * 0.8 * k, 0.1, w * 0.7 * k], PRIMARY, gBody);
  B.cone([0.01, 0.3 * tall, 0], [0.02, 0.4 * tall, 0], 0.055, 0.05, PRIMARY, gBody);
  const brain = 1 + Math.max(0, t.intel - 5) * 0.05;
  const h: V3 = [0.03, 0.5 * tall, 0], hr = 0.11 * brain;
  B.ell(h, [hr, hr * 1.12, hr * 0.95], PRIMARY, gHead);
  B.cone([h[0] + hr * 0.75, h[1] - hr * 0.05, 0], [h[0] + hr * 1.05, h[1] - hr * 0.3, 0], hr * 0.18, hr * 0.12, PRIMARY, gHead);
  // Hair, crest or crown of the lineage.
  if (lean > 0.35) B.ell([h[0] - hr * 0.2, h[1] + hr * 0.55, 0], [hr * 0.95, hr * 0.5, hr * 0.92], MARK, gHead);
  headParts(B, t, h, hr, gHead, gNear, gFar);
  // A tunic band: the first thing a people makes is clothing.
  B.ell([0, 0.0, 0], [w * 1.04 * k, 0.05, w * 0.9 * k], ACCENT, gBody);
  uprightLimbs(B, t, gNear, gFar, { hipY: -0.1, shY: 0.27 * tall, legW: 0.06, armW: 0.045 });
}

function planReptilian(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.03), gBody = B.group(0, 0.08), gNear = B.group(1, 0.03), gHead = B.group(0, 0.05);
  B.ell([0, 0.1, 0], [0.16 * k, 0.22, 0.14 * k], PRIMARY, gBody);
  B.ell([0.04, 0.06, 0], [0.11 * k, 0.17, 0.12 * k], BELLY, gBody);
  B.cone([0.02, 0.28, 0], [0.08, 0.42, 0], 0.07, 0.055, PRIMARY, gBody);
  const h: V3 = [0.12, 0.48, 0], hr = 0.1;
  B.ell(h, [hr * 1.1, hr * 0.9, hr * 0.85], PRIMARY, gHead);
  B.cone([h[0] + hr * 0.5, h[1] - hr * 0.2, 0], [h[0] + hr * 1.9, h[1] - hr * 0.4, 0], hr * 0.55, hr * 0.3, PRIMARY, gHead);
  headParts(B, t, h, hr, gHead, gNear, gFar);
  const tw = 0.05 * sw(0.25);
  B.chain([[-0.1, -0.08, 0], [-0.3, -0.2 + tw * 0.3, 0], [-0.5, -0.3 + tw, 0], [-0.62, -0.33 + tw, 0]], 0.08 * k, 0.015, PRIMARY, gBody);
  // Scutes down the back.
  for (let i = 0; i < 5; i++) B.cone([-0.1 - i * 0.03, 0.3 - i * 0.09, 0], [-0.16 - i * 0.03, 0.34 - i * 0.09, 0], 0.03, 0.006, MARK, gBody);
  uprightLimbs(B, t, gNear, gFar, { hipY: -0.08, shY: 0.26, legW: 0.075, armW: 0.045, digitigrade: true });
}

function planAvian(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.03), gBody = B.group(0, 0.08), gNear = B.group(1, 0.03), gHead = B.group(0, 0.04);
  B.ell([0, 0.12, 0], [0.15 * k, 0.21, 0.13 * k], PRIMARY, gBody);
  B.ell([0.05, 0.08, 0], [0.1 * k, 0.15, 0.11 * k], BELLY, gBody);
  B.cone([0.02, 0.3, 0], [0.06, 0.42, 0], 0.05, 0.045, PRIMARY, gBody);
  const h: V3 = [0.08, 0.5, 0], hr = 0.1 * (1 + Math.max(0, t.intel - 6) * 0.04);
  B.ell(h, [hr, hr, hr * 0.9], PRIMARY, gHead);
  // Beak and crest.
  B.cone([h[0] + hr * 0.7, h[1] - hr * 0.1, 0], [h[0] + hr * 1.8, h[1] - hr * 0.45, 0], hr * 0.32, hr * 0.04, BONE, gHead);
  for (let i = 0; i < 3; i++) B.cone([h[0] - hr * 0.3, h[1] + hr * 0.7, 0], [h[0] - hr * (1 + i * 0.4), h[1] + hr * (1.5 - i * 0.2), (i - 1) * 0.03], 0.03, 0.005, ACCENT, gHead);
  headParts(B, t, h, hr, gHead, gNear, gFar);
  // Folded wing-arms: feathered sleeves from shoulder to wrist.
  for (const [sd, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
    const z = sd * 0.15 * k, fl = 0.03 * flap();
    B.tri([0, 0.3, z], [-0.25, 0.0 + fl, z * 1.1], [-0.05, -0.05, z * 1.05], 0.012, WING, g);
  }
  // Tail fan.
  B.tri([-0.12, -0.04, 0], [-0.38, -0.2, 0.07], [-0.36, -0.08, -0.07], 0.012, WING, gBody);
  uprightLimbs(B, t, gNear, gFar, { hipY: -0.08, shY: 0.24, legW: 0.045, armW: 0.035, digitigrade: true, hand: BONE });
}

function planInsectoid(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.02), gBody = B.group(0, 0.03), gNear = B.group(1, 0.02), gHead = B.group(0, 0.02);
  // Abdomen behind, an upright thorax, a narrow waist.
  B.ell([-0.18, -0.08, 0], [0.2, 0.13 * k, 0.13 * k], PRIMARY, gBody);
  B.ell([0.0, 0.16, 0], [0.1 * k, 0.17, 0.1 * k], SHELL, gBody);
  B.ell([0.0, 0.0, 0], [0.06, 0.05, 0.06], MARK, gBody);
  for (let i = 0; i < 3; i++) B.ell([-0.12 - i * 0.08, -0.06 + i * 0.01, 0], [0.025, 0.12 * k, 0.12 * k], MARK, gBody);
  const h: V3 = [0.06, 0.42, 0], hr = 0.08 * (1 + Math.max(0, t.intel - 6) * 0.05);
  B.ell(h, [hr * 1.1, hr * 1.2, hr], PRIMARY, gHead);
  // Mandibles and antennae, whatever the senses.
  for (const sd of [1, -1]) {
    B.cone([h[0] + hr * 0.8, h[1] - hr * 0.6, sd * hr * 0.4], [h[0] + hr * 1.4, h[1] - hr * 1.0, sd * hr * 0.1], hr * 0.18, hr * 0.05, BONE, gHead);
    B.chain([[h[0] + hr * 0.3, h[1] + hr * 0.8, sd * hr * 0.3], [h[0] + hr * 0.9, h[1] + hr * 2.0, sd * hr * 0.5], [h[0] + hr * 1.8, h[1] + hr * 2.4, sd * hr * 0.6]], hr * 0.1, hr * 0.05, ACCENT, sd > 0 ? gNear : gFar);
  }
  B.eyes.push({ p: [h[0] + hr * 0.55, h[1] + hr * 0.3, hr * 0.62], style: 'compound', size: 1.4 });
  uprightLimbs(B, t, gNear, gFar, { hipY: -0.04, shY: 0.28, legW: 0.035, armW: 0.028, mat: MARK, hand: SHELL, armPairs: 2, digitigrade: true });
}

function planCephaloid(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.05), gBody = B.group(0, 0.1), gNear = B.group(1, 0.05);
  // A great mantle that holds the mind, carried on walking tentacles.
  const mh = 0.22 * (1 + Math.max(0, t.intel - 6) * 0.05);
  B.ell([0, 0.18, 0], [mh * 0.85 * k, mh * 1.15, mh * 0.85 * k], PRIMARY, gBody);
  B.ell([0.05, 0.1, 0], [mh * 0.6, mh * 0.7, mh * 0.7], BELLY, gBody);
  for (let i = 0; i < 4; i++) B.dots.push({ p: [-0.05 + i * 0.04, 0.32 - i * 0.02, mh * 0.75], mat: i % 2 ? MARK : GLOW });
  B.eyes.push({ p: [mh * 0.55, 0.12, mh * 0.62], style: 'vision', size: 1.3 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU, cz = Math.cos(a) * 0.12 * k, cx = Math.sin(a) * 0.1;
    const [ss, sl] = step(i / 6, 0.6);
    const g = cz >= 0 ? gNear : gFar;
    B.chain([[cx * 0.5, -0.02, cz * 0.5], [cx + 0.03 + ss * STRIDE * 0.5, -0.25 + sl * 0.05, cz], [cx * 1.3 + ss * STRIDE, -0.5 + sl * 0.06, cz * 1.2], [cx * 1.5 + 0.06 + ss * STRIDE, -0.5, cz * 1.25]], 0.05 * k, 0.012, PRIMARY, g);
  }
}

function planMycoid(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.04), gBody = B.group(0, 0.08), gNear = B.group(1, 0.04);
  // A stalk-body under a broad cap; it walks on root-legs.
  B.cone([0, -0.18, 0], [0.02, 0.3, 0], 0.11 * k, 0.08 * k, BELLY, gBody);
  B.ell([0.02, 0.38, 0], [0.26 * k, 0.11, 0.24 * k], PRIMARY, gBody);
  B.ell([0.02, 0.33, 0], [0.24 * k, 0.04, 0.22 * k], MARK, gBody);
  for (let i = 0; i < 7; i++) {
    const a = hash3(t.seed, i, 3, 1) * TAU, r = 0.08 + hash3(t.seed, i, 4, 1) * 0.12;
    B.dots.push({ p: [0.02 + Math.cos(a) * r, 0.47, Math.sin(a) * r], mat: i % 3 ? ACCENT : GLOW });
  }
  B.eyes.push({ p: [0.1, 0.14, 0.09], style: 'spot', size: 1 });
  for (const [sd, g] of [[-1, gFar], [1, gNear]] as Array<[number, number]>) {
    for (let i = 0; i < 2; i++) {
      const z = sd * (0.05 + i * 0.05) * k, [ss, sl] = step(sd > 0 ? i * 0.5 : 0.25 + i * 0.5, 0.6);
      B.chain([[0, -0.15, z * 0.6], [0.04 + ss * STRIDE * 0.5, -0.32 + sl * 0.05, z], [0.02 + ss * STRIDE, -0.5 + sl * 0.06, z * 1.3]], 0.05 * k, 0.02, BELLY, g);
    }
    // Arm-tendrils.
    B.chain([[0.04, 0.12, sd * 0.09], [0.14, 0.0, sd * 0.14], [0.2, -0.08, sd * 0.12]], 0.035, 0.012, BELLY, g);
  }
}

function planCrystalline(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.0, true, true), gBody = B.group(0, 0.01, true, true), gNear = B.group(1, 0.0, true, true);
  // Faceted shards around a glowing core.
  B.cone([0, -0.1, 0], [0.02, 0.3, 0], 0.14 * k, 0.08 * k, PRIMARY, gBody);
  B.ell([0.03, 0.12, 0.07], [0.05, 0.06, 0.05], GLOW, gBody);
  B.cone([0.03, 0.32, 0], [0.06, 0.58, 0], 0.09, 0.0, PRIMARY, gBody);
  for (let i = 0; i < 5; i++) {
    const a = hash3(t.seed, i, 9, 2) * TAU, r = 0.1;
    B.cone([Math.cos(a) * 0.05, 0.2, Math.sin(a) * 0.06], [Math.cos(a) * r * 2, 0.3 + hash3(t.seed, i, 8, 2) * 0.2, Math.sin(a) * r * 1.6], 0.04, 0.0, ACCENT, gBody);
  }
  B.eyes.push({ p: [0.11, 0.4, 0.05], style: 'spot', size: 0.9 });
  uprightLimbs(B, t, gNear, gFar, { hipY: -0.1, shY: 0.22, legW: 0.06, armW: 0.04, hand: GLOW });
}

function planMechanoid(B: Body, t: Traits): void {
  const k = t.bulk;
  const gFar = B.group(-1, 0.0, true, true), gBody = B.group(0, 0.005, true, true), gNear = B.group(1, 0.0, true, true), gHead = B.group(0, 0.005, true, true);
  // A machine body: a plated torso, a sensor head with a lit visor, jointed limbs.
  B.cone([0, -0.06, 0], [0, 0.3, 0], 0.15 * k, 0.17 * k, PRIMARY, gBody);
  B.ell([0.06, 0.16, 0], [0.12 * k, 0.1, 0.13 * k], SHELL, gBody);
  B.ell([0.14, 0.18, 0.05], [0.03, 0.03, 0.03], GLOW, gBody);
  B.cone([0, 0.3, 0], [0, 0.38, 0], 0.04, 0.04, ACCENT, gBody);
  const h: V3 = [0.02, 0.47, 0], hr = 0.1;
  B.cone([h[0], h[1] - hr * 0.8, 0], [h[0], h[1] + hr * 0.8, 0], hr * 1.0, hr * 0.95, PRIMARY, gHead);
  B.ell([h[0] + hr * 0.8, h[1] + hr * 0.1, 0], [hr * 0.25, hr * 0.28, hr * 0.85], GLOW, gHead);
  B.chain([[h[0] - hr * 0.3, h[1] + hr * 0.8, 0], [h[0] - hr * 0.5, h[1] + hr * 2.0, 0]], 0.012, 0.008, ACCENT, gHead);
  B.ell([h[0] - hr * 0.5, h[1] + hr * 2.05, 0], [0.025, 0.025, 0.025], GLOW, gHead);
  uprightLimbs(B, t, gNear, gFar, { hipY: -0.08, shY: 0.27, legW: 0.055, armW: 0.04, hand: ACCENT, robot: true });
}

/** Which people a walking, thinking lineage becomes (see Sapient forms). */
function planSapient(B: Body, t: Traits): void {
  const b = t.body;
  if (b === 'mechanical') return planMechanoid(B, t);
  if (b === 'crystalline') return planCrystalline(B, t);
  if (b === 'exoskeletal' || b === 'segmented') return planInsectoid(B, t);
  if (b === 'gelatinous' || b === 'radial' || b === 'cartilaginous' || b === 'shelled') return planCephaloid(B, t);
  if (b === 'filamentous' || b === 'colonial') return planMycoid(B, t);
  // Vertebrates: humanoid, reptilian or avian, by lineage.
  const r = hash3(t.seed, 5, 5, 5);
  if (t.mobility.includes('wing') || r < 0.22) return planAvian(B, t);
  if (r < 0.5 || t.aggr >= 7) return planReptilian(B, t);
  return planHumanoid(B, t);
}

/** The sapient form's name, for the UI ("an insectoid people"). */
export function sapientFormOf(g: SpeciesGenome): string | null {
  if (g.dna.intelligence < 6) return null;
  const b = g.physicalTraits.bodyStructure;
  if (b === 'mechanical') return 'mechanoid';
  if (b === 'crystalline') return 'crystalline';
  if (b === 'exoskeletal' || b === 'segmented') return 'insectoid';
  if (b === 'gelatinous' || b === 'radial' || b === 'cartilaginous' || b === 'shelled') return 'cephaloid';
  if (b === 'filamentous' || b === 'colonial') return 'mycoid';
  const r = hash3(hashStr(g.id), 5, 5, 5);
  if (g.physicalTraits.mobilityType.includes('wing') || r < 0.22) return 'avian';
  if (r < 0.5 || g.dna.aggression >= 7) return 'reptilian';
  return 'humanoid';
}

function planFor(g: SpeciesGenome, t: Traits): Body {
  const B = new Body();
  const loc = g.dna.locomotion, body = t.body;
  if (body === 'single-celled') planCell(B, t);
  else if (body === 'colonial') planColony(B, t);
  else if (body === 'radial' && loc !== 'flying') planStar(B, t);
  else if (body === 'gelatinous' && loc !== 'walking' && loc !== 'flying') planJelly(B, t);
  else if (loc === 'flying') {
    if (t.mobility === 'gas bladders') planBalloon(B, t);
    else if (body === 'exoskeletal' || body === 'segmented') planFlyingInsect(B, t);
    else planBird(B, t);
  } else if (loc === 'swimming') {
    if (t.mobility === 'jet siphon') planSquid(B, t);
    else if (t.mobility === 'undulating fringe') planRay(B, t);
    else if (body === 'filamentous' || body === 'segmented') planWorm(B, t);
    else planFish(B, t);
  } else if (loc === 'walking' || (t.intel >= 6 && (body === 'mechanical' || body === 'crystalline'))) {
    // A thinking walker stands up as one of the sapient forms.
    if (t.intel >= 6) planSapient(B, t);
    else if (body === 'exoskeletal' || body === 'segmented') planInsectWalker(B, t, 3);
    else planQuadruped(B, t);
  } else if (loc === 'crawling') {
    if (body === 'shelled') planSnail(B, t);
    else if (body === 'exoskeletal') planCrab(B, t);
    else if (body === 'filamentous') planWorm(B, t);
    else planCrawler(B, t);
  } else {
    // Stationary.
    if (body === 'shelled') planSnail(B, t);
    else if (t.producer) planPlant(B, t);
    else planPolyp(B, t);
  }
  return B;
}

// ─── Camera ──────────────────────────────────────────────────────────────────

/**
 * Orthographic camera: yaw turns the subject toward the viewer, pitch looks
 * down on it. Creatures use a three-quarter view seen from slightly above;
 * scenery uses a higher pitch to match the diorama's board.
 */
export class Camera3 {
  private cy: number; private sy: number; private cp: number; private sp: number;
  constructor(yaw: number, pitch: number) {
    this.cy = Math.cos(yaw); this.sy = Math.sin(yaw); this.cp = Math.cos(pitch); this.sp = Math.sin(pitch);
  }
  /** Body space → camera space. */
  toCam(p: V3): V3 {
    const x1 = p[0] * this.cy + p[2] * this.sy, z1 = -p[0] * this.sy + p[2] * this.cy;
    return [x1, p[1] * this.cp - z1 * this.sp, p[1] * this.sp + z1 * this.cp];
  }
  /** Camera space → body space. */
  toWorld(x: number, y: number, z: number): V3 {
    const y1 = y * this.cp + z * this.sp, z1 = -y * this.sp + z * this.cp;
    return [x * this.cy - z1 * this.sy, y1, x * this.sy + z1 * this.cy];
  }
}

const CREATURE_CAM = new Camera3(-0.42, 0.32);

const LIGHT: V3 = (() => { const v: V3 = [-0.45, 0.75, 0.5]; const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; })();

// ─── Render ──────────────────────────────────────────────────────────────────

export interface ForgedSprite { width: number; height: number; data: Uint8ClampedArray }

/** Everything a caller needs to stamp details after the core render. */
export interface RenderResult extends ForgedSprite {
  cover: Uint8Array; outline: Uint8Array; zbuf: Float32Array; mat: Uint8Array; lvl: Int8Array;
  /** Pixels per unit and the screen origin: screen = (cx * s + ox, oy - cy * s). */
  s: number; ox: number; oy: number;
  cam: Camera3;
  put(i: number, c: RGB, a: number): void;
}

/**
 * Surface hook: given the material, the hit point and normal in body space
 * and the group, return the material and a level offset (markings, grooves).
 */
export type SurfaceHook = (m: number, w: V3, n: V3, group: number) => { m: number; dl: number };

/**
 * The shared rasteriser. Every group is ray-marched as its own soft union;
 * the nearest group wins each pixel. Lit with five quantised levels per
 * material ramp, far-side groups one step darker, faceted groups lit by a
 * snapped normal; then interior contours and a 1-px outline.
 */
/** Camera-space bounds of a body: [minX, maxX, minY, maxY]. */
export function bodyBounds(B: Body, cam: Camera3 = CREATURE_CAM): [number, number, number, number] {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of B.prims) {
    const c = cam.toCam(p.bc), r = p.br * 0.85;
    minX = Math.min(minX, c[0] - r); maxX = Math.max(maxX, c[0] + r);
    minY = Math.min(minY, c[1] - r); maxY = Math.max(maxY, c[1] + r);
  }
  return [minX, maxX, minY, maxY];
}

/**
 * `frame`: render into these camera-space bounds instead of the body's own,
 * so every frame of an animation shares one size, scale and origin.
 */
export function renderBody(B: Body, pal: Ramp[], px: number, cam: Camera3 = CREATURE_CAM, hook?: SurfaceHook,
  frame?: [number, number, number, number]): RenderResult {
  const camC = B.prims.map(p => cam.toCam(p.bc));
  const [minX, maxX, minY, maxY] = frame ?? bodyBounds(B, cam);
  const span = Math.max(maxX - minX, maxY - minY);
  const s = Math.max(2, px - 3) / span;
  const W = Math.ceil((maxX - minX) * s) + 4, H = Math.ceil((maxY - minY) * s) + 4;
  const ox = 2 - minX * s, oy = 2 + maxY * s;

  const N = W * H;
  const cover = new Uint8Array(N), grp = new Int16Array(N).fill(-1);
  const zbuf = new Float32Array(N).fill(-Infinity);
  const mat = new Uint8Array(N), lvl = new Int8Array(N);

  const boxes = B.prims.map((p, i) => {
    const c = camC[i], r = p.br + B.groups[p.group].blend + 0.02;
    return [(c[0] - r) * s + ox, (c[0] + r) * s + ox, oy - (c[1] + r) * s, oy - (c[1] - r) * s];
  });
  const groupSdf = (gi: number, x: number, y: number, z: number, list: number[]): number => {
    let d = Infinity;
    const k = B.groups[gi].blend;
    for (const pi of list) if (B.prims[pi].group === gi) d = smin(d, sdPrim(B.prims[pi], x, y, z), k);
    return d;
  };

  const eps = 0.6 / s;
  for (let yy = 0; yy < H; yy++) {
    for (let xx = 0; xx < W; xx++) {
      const list: number[] = [];
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (xx + 0.5 >= b[0] && xx + 0.5 <= b[1] && yy + 0.5 >= b[2] && yy + 0.5 <= b[3]) list.push(i);
      }
      if (list.length === 0) continue;
      const groups = [...new Set(list.map(i => B.prims[i].group))];
      const cx = (xx + 0.5 - ox) / s, cyv = (oy - (yy + 0.5)) / s;
      let bestZ = -Infinity, bestG = -1;
      for (const gi of groups) {
        let zc = 2.0;
        for (let step = 0; step < 48; step++) {
          const w = cam.toWorld(cx, cyv, zc);
          const d = groupSdf(gi, w[0], w[1], w[2], list);
          if (d < eps * 0.5) {
            const z = zc + B.groups[gi].side * 0.01;
            if (z > bestZ) { bestZ = z; bestG = gi; }
            break;
          }
          zc -= Math.max(d, eps * 0.4);
          if (zc < -2.0) break;
        }
      }
      if (bestG < 0) continue;
      const i = yy * W + xx;
      const zc = bestZ - B.groups[bestG].side * 0.01;
      const w = cam.toWorld(cx, cyv, zc);
      let bp = -1, bd = Infinity;
      for (const pi of list) {
        if (B.prims[pi].group !== bestG) continue;
        const d = sdPrim(B.prims[pi], w[0], w[1], w[2]);
        if (d < bd) { bd = d; bp = pi; }
      }
      const h = 0.004;
      const gx = groupSdf(bestG, w[0] + h, w[1], w[2], list) - groupSdf(bestG, w[0] - h, w[1], w[2], list);
      const gy = groupSdf(bestG, w[0], w[1] + h, w[2], list) - groupSdf(bestG, w[0], w[1] - h, w[2], list);
      const gz = groupSdf(bestG, w[0], w[1], w[2] + h, list) - groupSdf(bestG, w[0], w[1], w[2] - h, list);
      const gl = Math.hypot(gx, gy, gz) || 1;
      let nW: V3 = [gx / gl, gy / gl, gz / gl];
      if (B.groups[bestG].facet) {
        // Faceted: snap the normal to a coarse lattice so rock and crystal
        // light in flat planes with hard edges between them.
        const q = (v: number) => Math.round(v * 1.6) / 1.6;
        const f: V3 = [q(nW[0]), q(nW[1]), q(nW[2])];
        const fl = Math.hypot(f[0], f[1], f[2]) || 1;
        nW = [f[0] / fl, f[1] / fl, f[2] / fl];
      }
      const nC = cam.toCam(nW);
      cover[i] = 1; grp[i] = bestG; zbuf[i] = zc;
      let m = B.prims[bp].mat, dl = 0;
      if (hook) { const r = hook(m, w, nW, bestG); m = r.m; dl = r.dl; }
      mat[i] = m;
      const ndl = nC[0] * LIGHT[0] + nC[1] * LIGHT[1] + nC[2] * LIGHT[2];
      let level = ndl > 0.86 ? 4 : ndl > 0.5 ? 3 : ndl > 0.1 ? 2 : ndl > -0.3 ? 1 : 0;
      if (m === GLOW) level = Math.max(3, level);
      if (B.groups[bestG].side < 0) level -= 1;
      level += dl;
      lvl[i] = Math.max(0, Math.min(4, level));
    }
  }

  const out = new Uint8ClampedArray(N * 4);
  const put = (i: number, c: RGB, a: number) => { out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = a; };
  for (let i = 0; i < N; i++) if (cover[i]) put(i, pal[mat[i]].lv[lvl[i]], pal[mat[i]].alpha);
  const contourGap = 0.06;
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const i = yy * W + xx;
    if (!cover[i]) continue;
    let front = -1, fz = -Infinity;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const x2 = xx + dx, y2 = yy + dy;
      if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
      const j = y2 * W + x2;
      if (!cover[j] || grp[j] === grp[i]) continue;
      if (zbuf[j] - zbuf[i] > contourGap && zbuf[j] > fz) { fz = zbuf[j]; front = j; }
    }
    if (front >= 0) put(i, pal[mat[i]].lv[0], pal[mat[i]].alpha);
  }
  const outline = new Uint8Array(N);
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const i = yy * W + xx;
    if (cover[i]) continue;
    let best = -1, bz = -Infinity;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const x2 = xx + dx, y2 = yy + dy;
      if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
      const j = y2 * W + x2;
      if (cover[j] && zbuf[j] > bz) { bz = zbuf[j]; best = j; }
    }
    if (best >= 0) { put(i, pal[mat[best]].outline, 255); outline[i] = 1; }
  }
  return { width: W, height: H, data: out, cover, outline, zbuf, mat, lvl, s, ox, oy, cam, put };
}

/**
 * Render a genome to RGBA with the long edge about `px` pixels (outline
 * included). Deterministic per genome.
 */
export function forgeCreature(g: SpeciesGenome, px: number): ForgedSprite {
  MOVING = false; PH = 0;
  const t = traitsOf(g);
  return forgePose(g, t, planFor(g, t), px);
}

/**
 * The creature's animation: `n` poses round one cycle of its body plan's
 * motion (gait, wingbeat, tail sweep, pulse…), all in one frame box so they
 * play back without jitter. Frame k is phase k / n.
 */
export function forgeCreatureFrames(g: SpeciesGenome, px: number, n = 4): ForgedSprite[] {
  const t = traitsOf(g);
  const bodies: Body[] = [];
  MOVING = true;
  try {
    for (let k = 0; k < n; k++) { PH = k / n; bodies.push(planFor(g, t)); }
  } finally { MOVING = false; PH = 0; }
  let box: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const B of bodies) {
    const b = bodyBounds(B);
    box = [Math.min(box[0], b[0]), Math.max(box[1], b[1]), Math.min(box[2], b[2]), Math.max(box[3], b[3])];
  }
  return bodies.map(B => forgePose(g, t, B, px, box));
}

/** How a body plan moves: frames per second of its cycle (see forgeCreatureFrames). */
export function motionRate(g: SpeciesGenome): number {
  const loc = g.dna.locomotion, mob = g.physicalTraits.mobilityType;
  if (loc === 'flying') return g.physicalTraits.bodyStructure === 'exoskeletal' || g.physicalTraits.bodyStructure === 'segmented' ? 16 : mob === 'gas bladders' ? 3 : 7;
  if (loc === 'walking') return 7;
  if (loc === 'swimming') return 5;
  if (loc === 'crawling') return 4;
  return 2;                                                  // sessile: a slow sway / pulse
}

function forgePose(g: SpeciesGenome, t: Traits, B: Body, px: number, frame?: [number, number, number, number]): ForgedSprite {
  const pal = buildPalette(g, t.seed);
  const R = renderBody(B, pal, px, CREATURE_CAM, (m0, w, nW, gi) => {
    let m = m0, dl = 0;
    // Countershading: undersides of the main body go pale.
    if (m === PRIMARY && nW[1] < -0.45) m = BELLY;
    // Body-anchored markings.
    if (m === PRIMARY && !B.groups[gi].noPattern && markAt(g, t, w)) m = MARK;
    // A coiled shell: a spiral groove winding in to its apex.
    if (m === SHELL && B.shell) {
      const dx = w[0] - B.shell[0], dy = w[1] - B.shell[1];
      if (Math.sin(Math.hypot(dx, dy) * 46 - Math.atan2(dy, dx)) > 0.55) dl = -1;
    }
    return { m, dl };
  }, frame);
  const { width: W, height: H, cover, outline, zbuf, mat, lvl, s, ox, oy, put } = R;
  const N = W * H;

  // Eyes and glow dots: stamped as designed clusters where visible.
  const unit = Math.max(1, Math.round(px / 34));
  const visible = (p: V3): [number, number] | null => {
    const c = CREATURE_CAM.toCam(p);
    const sx = Math.round(c[0] * s + ox - 0.5), sy = Math.round(oy - c[1] * s - 0.5);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
    const i = sy * W + sx;
    if (!cover[i] || c[2] < zbuf[i] - 0.08) return null;
    return [sx, sy];
  };
  const stamp = (x: number, y: number, c: RGB) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    if (!cover[i] && !outline[i]) return;
    put(i, c, 255);
  };
  const WHITE: RGB = [246, 246, 238], PUPIL: RGB = [12, 10, 20], SHINE: RGB = [255, 255, 255];
  for (const e of B.eyes) {
    const at = visible(e.p);
    if (!at) continue;
    const [x, y] = at;
    const r = Math.max(1, Math.round(unit * e.size * (px >= 40 ? 1.4 : 1)));
    if (e.style === 'vision') {
      for (let dy = 0; dy < r + 1; dy++) for (let dx = 0; dx < r + 1; dx++) stamp(x + dx, y + dy, WHITE);
      for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) stamp(x + 1 + dx, y + 1 + dy, PUPIL);
      if (r >= 2) stamp(x + 1, y + 1, SHINE);
    } else if (e.style === 'compound') {
      const C: RGB = [150, 30, 40], D: RGB = [60, 10, 22];
      for (let dy = 0; dy <= r + 1; dy++) for (let dx = 0; dx <= r + 1; dx++) stamp(x + dx - 1, y + dy - 1, (dx + dy) % 2 ? D : C);
      stamp(x - 1, y - 1, SHINE);
    } else if (e.style === 'spot') {
      for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) stamp(x + dx, y + dy, PUPIL);
    } else {
      stamp(x, y, PUPIL);
      if (r >= 2) stamp(x + 1, y, PUPIL);
    }
  }
  for (const d of B.dots) {
    const at = visible(d.p);
    if (at) { stamp(at[0], at[1], pal[d.mat].lv[4]); stamp(at[0] + 1, at[1], pal[d.mat].lv[3]); }
  }
  // Deep-sea life glows: a lateral line of bioluminescent dots.
  if (g.dna.environment === 'deep_sea') {
    for (let i = 0; i < N; i += 1) {
      if (!cover[i] || mat[i] !== PRIMARY) continue;
      const x = i % W, y = (i / W) | 0;
      if (hash3(x, y, 7, t.seed) < 0.035 && lvl[i] >= 2) put(i, pal[GLOW].lv[4], 255);
    }
  }
  return { width: W, height: H, data: R.data };
}

/** Body-anchored markings by diet: stripes on hunters, spots on grazers, mottling on the rest. */
function markAt(g: SpeciesGenome, t: Traits, w: V3): boolean {
  const pick = t.seed % 4;
  if (t.carn) return Math.sin(w[0] * 34 + w[1] * 8) > 0.55;                                   // stripes
  if (t.herb) {                                                                              // spots
    const cx = Math.floor(w[0] * 14), cy = Math.floor(w[1] * 14), cz = Math.floor(w[2] * 14);
    return hash3(cx, cy, cz, t.seed) > 0.72 && (w[0] * 14 - cx - 0.5) ** 2 + (w[1] * 14 - cy - 0.5) ** 2 < 0.16;
  }
  if (g.dna.diet === 'omnivore') return pick < 2 ? w[1] > 0.12 && w[0] > -0.2 && w[0] < 0.2 : Math.sin(w[0] * 22) * Math.sin(w[2] * 22) > 0.5; // saddle / checks
  if (g.dna.diet === 'decomposer') return hash3(Math.floor(w[0] * 9), Math.floor(w[1] * 9), Math.floor(w[2] * 9), t.seed) > 0.62; // mottle
  return false;
}
