/**
 * SpeciesSprite — procedural pixel-art creatures and settlements.
 *
 * `EVOLUTION_SYSTEM.md` asks for species that are "visible on the planet and are
 * created procedurally", and `CIVILIZATION_SYSTEM.md` for architecture that
 * follows species morphology ("Aquatic species build Glass Spires").
 *
 * ── Creatures ────────────────────────────────────────────────────────────────
 * Drawn pixel by pixel at the size they appear on screen. The previous baker
 * drew anti-aliased canvas paths at ~2.7x and let the diorama decimate them to
 * 7px, so eyes, spines and craniums existed in the bake and not in the game,
 * and six of nine genome axes never reached the screen at all (measured by
 * `tools/speciesSpriteCheck.ts`, which runs the old baker as its control).
 *
 * Each genome axis owns ONE visual channel, so they do not mask each other:
 *   locomotion     → template silhouette (swimmer / walker / flier / crawler / sessile)
 *   mobilityType   → limb variant within the template (fins vs jet siphon, …)
 *   size           → pixel budget
 *   bodyStructure  → body silhouette (lumpy colony, notched segments, shell dome, …)
 *   metabolism     → hue family
 *   environment    → value/saturation (deep sea dark + bioluminescent, aerial pale)
 *   diet           → surface pattern and mouth (dapple, countershade, spots, saddle, rot)
 *   sensorySystem  → head features (feelers, eyespot, eye, compound eye, ears, …)
 *   aggression     → dorsal spikes, horn, red eye
 *   intelligence   → cranium and posture (walkers stand up)
 * The species id contributes only a small hue/value jitter. Genomes the
 * engine flags as incoherent (its "anomalies") carry a visible glitch — the
 * one lawful violation in an otherwise lawful system.
 *
 * Sprites are baked once per (genome, size) into a small canvas and blitted 1:1.
 */

import type {
  SpeciesGenome, Metabolism, SpeciesSize, Environment,
} from '../simulation/SpeciesGenome';
import { isCoherent } from '../simulation/EvolutionEngine';

// ─── Deterministic per-species randomness ─────────────────────────────────────

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class Stream {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 1; }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  range(a: number, b: number): number { return a + this.next() * (b - a); }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
  chance(p: number): boolean { return this.next() < p; }
}

// ─── Colour ───────────────────────────────────────────────────────────────────

type RGB = [number, number, number];

function hsl(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s)); l = Math.max(0.03, Math.min(0.95, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
                  : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Rotate hue `h` toward `target` by up to `amt` degrees along the short arc. */
function toward(h: number, target: number, amt: number): number {
  let d = ((target - h + 540) % 360) - 180;
  if (Math.abs(d) < amt) return target;
  return h + Math.sign(d) * amt;
}

const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

/** Hue family per metabolism, in degrees. */
const META_HUE: Record<Metabolism, number> = {
  photosynthetic: 110, chemosynthetic: 268, heterotrophic: 34, parasitic: 328,
};
/** Chlorophyll / chemistry accent, used for producer dapple. */
const META_ACCENT: Record<Metabolism, RGB> = {
  photosynthetic: hex('#e6f47c'), chemosynthetic: hex('#7cf0dc'),
  heterotrophic:  hex('#ffe0a0'), parasitic:      hex('#c8f050'),
};
/**
 * Environment sets value and saturation, with a small hue lean. Lightness is
 * spaced so any two habitats differ by more than the metric's perceptible
 * colour step; hue leans stay under 20 degrees so no family wraps into another
 * (the pink-sky failure).
 */
const ENV_TONE: Record<Environment, { dh: number; l: number; s: number }> = {
  deep_sea: { dh: -12, l: 0.27, s: 0.80 },
  ocean:    { dh:  -8, l: 0.46, s: 0.72 },
  coastal:  { dh:   6, l: 0.62, s: 0.66 },
  land:     { dh:  10, l: 0.34, s: 0.66 },
  aerial:   { dh:   0, l: 0.74, s: 0.70 },
};

// Palette slots.
const OUTLINE = 0, DARK = 1, BODY = 2, LIGHT = 3, HIGH = 4, BONE = 5, EYE_W = 6,
      PUPIL = 7, GLOW = 8, LATERAL = 9, COMPOUND = 10, PIT = 11, TIP = 12, MOUTH = 13,
      BELLY = 14, DAPPLE = 15, ROT = 16, SHELL = 17, RED_EYE = 18, SHELL_D = 19, GLITCH = 20;
const SLOTS = 21;

interface Pal { rgb: RGB[]; alpha: number[] }

function buildPalette(g: SpeciesGenome, jitter: Stream): Pal {
  const env = ENV_TONE[g.dna.environment] ?? ENV_TONE.land;
  const H = (META_HUE[g.dna.metabolism] ?? 30) + env.dh + jitter.range(-5, 5);
  let S = env.s, L = env.l + jitter.range(-0.02, 0.02);
  // Decomposers are drab: rot takes the colour out of a body.
  if (g.dna.diet === 'decomposer') S *= 0.85;

  const rgb: RGB[] = new Array(SLOTS);
  rgb[BODY]    = hsl(H, S, L);
  // Ramp ends are compressed so a dark habitat does not crush every hue to
  // black, nor a pale one bleach every hue to white.
  rgb[DARK]    = hsl(toward(H, 250, 14), S * 1.05, Math.max(L - 0.13, L * 0.6));
  rgb[LIGHT]   = hsl(toward(H, 55, 10), S * 0.95, Math.min(L + 0.13, L + (1 - L) * 0.4));
  rgb[HIGH]    = hsl(toward(H, 55, 18), S * 0.80, Math.min(L + 0.26, L + (1 - L) * 0.65));
  rgb[OUTLINE] = hsl(toward(H, 250, 26), Math.min(1, S * 0.9), Math.max(0.07, L * 0.32));
  rgb[BONE]    = hex('#efe4c6');
  rgb[EYE_W]   = hex('#f6f6ee');
  rgb[PUPIL]   = hex('#0b0912');
  rgb[GLOW]    = hex('#7ff8ec');
  rgb[LATERAL] = hex('#9ad8ff');
  rgb[COMPOUND] = hex('#e0503a');
  rgb[PIT]     = hex('#ff8a2a');
  rgb[TIP]     = hex('#ffd84a');
  rgb[MOUTH]   = hex('#c0203a');
  rgb[RED_EYE] = hex('#ff3030');
  rgb[BELLY]   = hsl(toward(H, 50, 30), S * 0.45, Math.min(0.9, L + 0.36));
  rgb[DAPPLE]  = META_ACCENT[g.dna.metabolism] ?? META_ACCENT.heterotrophic;
  rgb[ROT]     = hsl(70, 0.12, Math.max(0.18, Math.min(0.8, L > 0.5 ? L - 0.30 : L + 0.30)));
  rgb[SHELL]   = hsl(toward(H, 40, 40), S * 0.35, Math.min(0.88, L + 0.30));
  rgb[SHELL_D] = hsl(toward(H, 40, 40), S * 0.35, Math.max(0.12, L - 0.06));
  rgb[GLITCH]  = hex('#ff2bd6');

  const alpha = new Array(SLOTS).fill(255);
  if (g.physicalTraits.bodyStructure === 'gelatinous') {
    // Translucent flesh; the rim reads the shape instead of the dark outline.
    alpha[BODY] = 165; alpha[DARK] = 165; alpha[LIGHT] = 190;
    rgb[OUTLINE] = rgb[HIGH]; alpha[OUTLINE] = 220;
  }
  return { rgb, alpha };
}

// ─── Pixel grid ───────────────────────────────────────────────────────────────

const NONE = 0, FLESH = 1, LIMB = 2, FEATURE = 3;

class Grid {
  readonly slot: Int8Array;
  readonly part: Uint8Array;
  constructor(readonly w: number, readonly h: number) {
    this.slot = new Int8Array(w * h).fill(-1);
    this.part = new Uint8Array(w * h);
  }
  in(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  set(x: number, y: number, slot: number, part: number): void {
    x = Math.floor(x); y = Math.floor(y);
    if (!this.in(x, y)) return;
    this.slot[y * this.w + x] = slot; this.part[y * this.w + x] = part;
  }
  /** Recolour an already-filled pixel without changing what part it is. */
  paint(x: number, y: number, slot: number): void {
    x = Math.floor(x); y = Math.floor(y);
    if (this.in(x, y) && this.part[y * this.w + x] !== NONE) this.slot[y * this.w + x] = slot;
  }
  clear(x: number, y: number): void {
    x = Math.floor(x); y = Math.floor(y);
    if (!this.in(x, y)) return;
    this.slot[y * this.w + x] = -1; this.part[y * this.w + x] = NONE;
  }
  partAt(x: number, y: number): number { return this.in(x, y) ? this.part[y * this.w + x] : NONE; }
  filled(x: number, y: number): boolean { return this.partAt(x, y) !== NONE; }

  /** Filled ellipse by pixel-centre test; never vanishes below one pixel. */
  disc(cx: number, cy: number, rx: number, ry: number, slot: number, part: number): void {
    rx = Math.max(0.5, rx); ry = Math.max(0.5, ry);
    let any = false;
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
      for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
        const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1.0) { this.set(x, y, slot, part); any = true; }
      }
    }
    if (!any) this.set(cx, cy, slot, part);
  }
  rect(x: number, y: number, w: number, h: number, slot: number, part: number): void {
    for (let yy = Math.floor(y); yy < Math.floor(y) + Math.max(1, Math.round(h)); yy++)
      for (let xx = Math.floor(x); xx < Math.floor(x) + Math.max(1, Math.round(w)); xx++)
        this.set(xx, yy, slot, part);
  }
  line(x0: number, y0: number, x1: number, y1: number, slot: number, part: number): void {
    x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.floor(x1); y1 = Math.floor(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 64; guard++) {
      this.set(x0, y0, slot, part);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  /** Filled triangle by pixel-centre barycentric test. */
  tri(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, slot: number, part: number): void {
    const x0 = Math.floor(Math.min(ax, bx, cx)), x1 = Math.ceil(Math.max(ax, bx, cx));
    const y0 = Math.floor(Math.min(ay, by, cy)), y1 = Math.ceil(Math.max(ay, by, cy));
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-6) { this.line(ax, ay, bx, by, slot, part); return; }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
      const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 >= -0.02 && w1 >= -0.02 && w2 >= -0.02) this.set(x, y, slot, part);
    }
    this.line(ax, ay, bx, by, slot, part);
  }
  /** Top-most flesh pixel in a column, or -1. */
  topFlesh(x: number): number {
    for (let y = 0; y < this.h; y++) if (this.partAt(x, y) === FLESH) return y;
    return -1;
  }
  bottomFlesh(x: number): number {
    for (let y = this.h - 1; y >= 0; y--) if (this.partAt(x, y) === FLESH) return y;
    return -1;
  }
}

// ─── Anatomy ──────────────────────────────────────────────────────────────────

/**
 * Interior long edge in pixels, before the outline, at full phase and mid depth.
 * Ordinary life stays a speck on the disc so the terrain stays readable.
 * `massive` is the genome's gigantic class and keeps a body that can tower.
 */
export const CREATURE_SIZE_PX: Record<SpeciesSize, number> = {
  microscopic: 2, tiny: 2, small: 3, medium: 4, large: 5, massive: 12,
};

interface Anatomy {
  /** Main body ellipse. */
  bx: number; by: number; brx: number; bry: number;
  /** Head centre and radius; the creature faces +x. */
  hx: number; hy: number; hr: number;
  /** x-range the dorsal line spans, for spikes/bristles. */
  dorsal0: number; dorsal1: number;
}

const M = 6; // margin for spikes, antennae, cranium and outline

function drawBody(gr: Grid, cx: number, cy: number, rx: number, ry: number, plan: string, n: number): void {
  switch (plan) {
    case 'single-celled': {
      const r = Math.min(rx, ry) * 1.05;
      gr.disc(cx, cy, r, r, BODY, FLESH);
      gr.set(cx, cy, PUPIL, FLESH);                           // one nucleus
      break;
    }
    case 'colonial': {
      // A clump of cells: three overlapping lobes make a lumpy outline, each
      // with its own nucleus.
      const r = Math.max(0.8, Math.min(rx, ry) * 0.75);
      const lobes: Array<[number, number]> = [
        [cx - rx * 0.5, cy + ry * 0.25], [cx + rx * 0.5, cy + ry * 0.25], [cx, cy - ry * 0.45]];
      for (const [x, y] of lobes) gr.disc(x, y, r, r, BODY, FLESH);
      for (const [x, y] of lobes) gr.set(x, y, LIGHT, FLESH);
      break;
    }
    case 'segmented': {
      gr.disc(cx, cy, rx, ry, BODY, FLESH);
      // Pinch every third column: notched outline reads as segments.
      const x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx);
      for (let x = x0 + 2; x < x1 - 1; x += 3) {
        const t = gr.topFlesh(x), b = gr.bottomFlesh(x);
        if (t >= 0 && b - t >= 2) {
          gr.clear(x, t); gr.clear(x, b);
          for (let y = t + 1; y < b; y++) gr.set(x, y, DARK, FLESH);   // segment seam
        }
      }
      break;
    }
    case 'radial': {
      const r = Math.min(rx, ry) * 1.1;
      gr.disc(cx, cy, r, r, BODY, FLESH);
      const arm = r + Math.max(1, Math.round(n * 0.18));
      for (let k = 0; k < 5; k++) {
        const a = -Math.PI / 2 + k * (Math.PI * 2 / 5);
        gr.line(cx, cy, cx + Math.cos(a) * arm, cy + Math.sin(a) * arm, BODY, FLESH);
      }
      break;
    }
    case 'shelled': {
      gr.disc(cx, cy, rx, ry, BODY, FLESH);
      // A dome over the back, one pixel proud of the body, ridged.
      const x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx);
      gr.disc(cx - rx * 0.1, cy - ry * 0.25, rx * 0.95, ry * 0.95 + 0.6, SHELL, FEATURE);
      for (let x = x0; x <= x1; x++) {
        for (let y = 0; y < gr.h; y++) {
          if (gr.partAt(x, y) === FEATURE && y > cy) gr.set(x, y, BODY, FLESH);
        }
        if ((x - x0) % 2 === 1) {
          const t = (() => { for (let y = 0; y < gr.h; y++) if (gr.partAt(x, y) === FEATURE) return y; return -1; })();
          if (t >= 0) gr.paint(x, t + 1, SHELL_D);
        }
      }
      break;
    }
    case 'cartilaginous': {
      // Long, smooth, flattened — shark and ray plans.
      gr.disc(cx, cy, rx * 1.18, ry * 0.78, BODY, FLESH);
      // Swept dorsal fin.
      const t = gr.topFlesh(Math.floor(cx));
      if (t >= 0) {
        gr.set(cx, t - 1, BODY, LIMB); gr.set(cx - 1, t - 1, BODY, LIMB);
        if (n >= 6) gr.set(cx - 1, t - 2, BODY, LIMB);
      }
      break;
    }
    case 'vertebrate': {
      gr.disc(cx, cy, rx, ry, BODY, FLESH);
      // Spine ridge running out into a tail.
      const x0 = Math.floor(cx - rx * 0.7), x1 = Math.ceil(cx + rx * 0.5);
      for (let x = x0; x <= x1; x++) { const t = gr.topFlesh(x); if (t >= 0) gr.paint(x, t, DARK); }
      const tail = Math.max(1, Math.round(n * 0.25));
      const rear = Math.floor(cx - rx);
      for (let k = 1; k <= tail; k++) gr.set(rear - k + 1, Math.floor(cy) - Math.floor(k / 2), DARK, LIMB);
      break;
    }
    case 'exoskeletal': {
      // Chamfered box: hard angular plates rather than a soft oval.
      const x0 = Math.round(cx - rx), x1 = Math.round(cx + rx) - 1;
      const y0 = Math.round(cy - ry), y1 = Math.round(cy + ry) - 1;
      for (let y = y0; y <= Math.max(y0, y1); y++) for (let x = x0; x <= Math.max(x0, x1); x++) {
        const corner = (x === x0 || x === x1) && (y === y0 || y === y1) && x1 - x0 >= 2 && y1 - y0 >= 2;
        if (!corner) gr.set(x, y, BODY, FLESH);
      }
      // Plate seams and a hard glint.
      for (let x = x0 + 2; x < x1; x += 3) for (let y = y0; y <= y1; y++) gr.paint(x, y, DARK);
      gr.set(x0 + 1, y0, HIGH, FLESH);
      break;
    }
    case 'gelatinous': {
      gr.disc(cx, cy - ry * 0.1, rx * 1.05, ry * 1.1, BODY, FLESH);
      break;
    }
    case 'filamentous': {
      gr.disc(cx, cy, rx * 0.8, ry * 0.8, BODY, FLESH);
      // Trailing threads.
      const len = Math.max(2, Math.round(ry * 2 + 1));
      for (let k = -1; k <= 1; k++) {
        const sx = cx - rx * 0.35 + k * Math.max(1, rx * 0.5);
        gr.line(sx, cy + ry * 0.6, sx - 1, cy + ry * 0.6 + len, DARK, LIMB);
      }
      break;
    }
    default:
      gr.disc(cx, cy, rx, ry, BODY, FLESH);
  }
}

function layout(gr: Grid, g: SpeciesGenome, n: number): Anatomy {
  const loco = g.dna.locomotion;
  const mob = g.physicalTraits.mobilityType;
  const plan = g.physicalTraits.bodyStructure;
  const smart = g.dna.intelligence >= 5;

  switch (loco) {
    case 'swimming': {
      const w = n, h = Math.max(2, Math.round(n * 0.55));
      const bx = M + w * 0.56, by = M + h * 0.5, brx = w * 0.36, bry = h * 0.46;
      // Propulsion first, body over it.
      if (mob === 'jet siphon') {
        gr.rect(M, by - 0.5, Math.max(1, w * 0.2), 1, DARK, LIMB);
      } else if (mob === 'flagella') {
        for (let x = 0; x < Math.max(2, Math.round(w * 0.3)); x++) gr.set(M + x, by + ((x % 2) ? 1 : 0) - 0.5, DARK, LIMB);
      } else if (mob === 'undulating fringe') {
        for (let x = Math.round(bx - brx); x <= Math.round(bx + brx * 0.6); x += 2) gr.set(x, by + bry + 0.5, LIGHT, LIMB);
        gr.tri(M + w * 0.22, by, M, by - h * 0.3, M, by + h * 0.3, BODY, LIMB);
      } else {
        gr.tri(M + w * 0.24, by, M, by - h * 0.5, M, by + h * 0.45, BODY, LIMB); // fluke
        if (n >= 6) gr.set(bx - 1, by - bry - 0.5, BODY, LIMB);                    // dorsal fin
      }
      drawBody(gr, bx, by, brx, bry, plan, n);
      return { bx, by, brx, bry, hx: bx + brx * 0.6, hy: by - bry * 0.2, hr: Math.max(0.8, bry * 0.7),
               dorsal0: bx - brx * 0.6, dorsal1: bx + brx * 0.4 };
    }
    case 'crawling': {
      const w = n, h = Math.max(2, Math.round(n * 0.45));
      const bx = M + w * 0.46, by = M + h * 0.5, brx = w * 0.46, bry = h * 0.5;
      drawBody(gr, bx, by, brx, bry, plan, n);
      const bottom = Math.floor(by + bry);
      if (mob === 'muscular foot') {
        gr.rect(bx - brx * 0.8, bottom, brx * 1.6, 1, DARK, LIMB);
      } else if (mob === 'tube feet') {
        for (let x = Math.round(bx - brx * 0.8); x <= bx + brx * 0.8; x += 2) gr.set(x, bottom, LIGHT, LIMB);
      } else {
        for (let x = Math.round(bx - brx * 0.8); x <= bx + brx * 0.8; x += 2) gr.set(x, bottom, DARK, LIMB);
      }
      return { bx, by, brx, bry, hx: bx + brx * 0.85, hy: by - bry * 0.15, hr: Math.max(0.8, bry * 0.75),
               dorsal0: bx - brx * 0.7, dorsal1: bx + brx * 0.5 };
    }
    case 'walking': {
      if (smart) {
        // Upright biped: a mind stands up and looks around.
        const w = Math.max(2, Math.round(n * 0.6)), h = n;
        const bx = M + w * 0.5, by = M + h * 0.52, brx = w * 0.42, bry = h * 0.24;
        const legTop = by + bry * 0.6, legLen = M + h - legTop;
        const thick = mob === 'columnar limbs' && n >= 8 ? 2 : 1;
        gr.rect(bx - brx * 0.55, legTop, thick, legLen, DARK, LIMB);
        gr.rect(bx + brx * 0.55 - thick, legTop, thick, legLen, DARK, LIMB);
        drawBody(gr, bx, by, brx, bry, plan, n);
        const hr = Math.max(0.9, n * 0.16);
        gr.disc(bx + 0.5, by - bry - hr * 0.7, hr, hr, BODY, FLESH);
        return { bx, by, brx, bry, hx: bx + 0.5, hy: by - bry - hr * 0.7, hr,
                 dorsal0: bx - brx * 0.6, dorsal1: bx - brx * 0.1 };
      }
      const w = n, h = Math.max(3, Math.round(n * 0.8));
      const bx = M + w * 0.44, by = M + h * 0.42, brx = w * 0.36, bry = h * 0.22;
      const legTop = by + bry * 0.5, legLen = M + h - legTop;
      const thick = mob === 'columnar limbs' && n >= 8 ? 2 : 1;
      const legs = [bx - brx * 0.7, bx + brx * 0.55];
      if (n >= 7) legs.push(bx - brx * 0.2, bx + brx * 0.9);
      for (const lx of legs) {
        if (mob === 'digitigrade limbs' && n >= 6) {
          gr.line(lx, legTop, lx - 1, legTop + legLen * 0.5, DARK, LIMB);
          gr.line(lx - 1, legTop + legLen * 0.5, lx, M + h - 1, DARK, LIMB);
        } else gr.rect(lx, legTop, thick, legLen, DARK, LIMB);
      }
      drawBody(gr, bx, by, brx, bry, plan, n);
      const hr = Math.max(0.8, n * 0.14);
      const hx = bx + brx + hr * 0.5, hy = by - bry * 0.9;
      gr.disc(hx, hy, hr, hr, BODY, FLESH);
      return { bx, by, brx, bry, hx, hy, hr, dorsal0: bx - brx * 0.7, dorsal1: bx + brx * 0.5 };
    }
    case 'flying': {
      const w = n, h = Math.max(2, Math.round(n * 0.6));
      const bx = M + w * 0.5, by = M + h * 0.6, brx = Math.max(0.8, w * 0.16), bry = Math.max(0.8, h * 0.3);
      if (mob === 'gas bladders') {
        // A floating bladder over a small body.
        gr.disc(bx, M + h * 0.3, w * 0.42, h * 0.34, LIGHT, LIMB);
        drawBody(gr, bx, by + h * 0.12, brx * 1.2, bry * 0.8, plan, n);
        return { bx, by: by + h * 0.12, brx, bry, hx: bx + brx, hy: by + h * 0.1, hr: Math.max(0.7, bry * 0.6),
                 dorsal0: bx - w * 0.3, dorsal1: bx + w * 0.3 };
      }
      const tipY = M + (mob === 'feathered wings' ? 0 : h * 0.12);
      const trail = mob === 'membrane wings' ? h * 0.8 : h * 0.65;
      gr.tri(bx, by - bry * 0.4, M, tipY, bx - w * 0.18, M + trail, BODY, LIMB);
      gr.tri(bx, by - bry * 0.4, M + w - 1, tipY, bx + w * 0.18, M + trail, BODY, LIMB);
      if (mob === 'membrane wings' && n >= 7) {
        // Scalloped trailing edge.
        gr.clear(M + w * 0.2, M + trail * 0.6); gr.clear(M + w * 0.8, M + trail * 0.6);
      }
      drawBody(gr, bx, by, brx, bry, plan, n);
      return { bx, by, brx, bry, hx: bx + brx * 0.4, hy: by - bry * 0.9, hr: Math.max(0.7, brx),
               dorsal0: bx - w * 0.35, dorsal1: bx + w * 0.35 };
    }
    case 'stationary':
    default: {
      const w = Math.max(2, Math.round(n * 0.7)), h = n;
      const cx = M + w * 0.5;
      const stalkTop = M + h * 0.45;
      gr.rect(cx - 0.5, stalkTop, n >= 10 ? 2 : 1, M + h - stalkTop, DARK, LIMB);
      if (mob === 'root mat') gr.rect(cx - w * 0.45, M + h - 1, w * 0.9, 1, DARK, LIMB);
      else if (mob === 'holdfast') { gr.set(cx - 1.5, M + h - 1, DARK, LIMB); gr.set(cx + 1.5, M + h - 1, DARK, LIMB); }
      const by = M + h * 0.3, brx = w * 0.48, bry = h * 0.28;
      drawBody(gr, cx, by, brx, bry, plan, n);
      return { bx: cx, by, brx, bry, hx: cx + brx * 0.5, hy: by - bry * 0.5, hr: Math.max(0.8, bry * 0.6),
               dorsal0: cx - brx * 0.8, dorsal1: cx + brx * 0.8 };
    }
  }
}

/**
 * Body plans reshape the body (a radial plan is a small disc, a colony is three
 * lobes), so the template's head point can land in empty space, and every
 * head feature anchored there would silently vanish. Snap the head to the
 * nearest flesh pixel and the dorsal range to columns that have flesh.
 */
function snapToFlesh(gr: Grid, a: Anatomy): Anatomy {
  let best = Infinity, bx = a.hx, by = a.hy;
  let fx0 = Infinity, fx1 = -Infinity;
  for (let y = 0; y < gr.h; y++) for (let x = 0; x < gr.w; x++) {
    if (gr.partAt(x, y) !== FLESH) continue;
    fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x);
    const d = (x + 0.5 - a.hx) ** 2 + (y + 0.5 - a.hy) ** 2;
    if (d < best) { best = d; bx = x + 0.5; by = y + 0.5; }
  }
  if (fx1 < 0) return a;
  return {
    ...a, hx: bx, hy: by,
    dorsal0: Math.max(fx0, Math.min(a.dorsal0, fx1)),
    dorsal1: Math.min(fx1, Math.max(a.dorsal1, fx0)),
  };
}

// ─── Surface: shading, pattern ────────────────────────────────────────────────

function shade(gr: Grid, n: number): void {
  const out = gr.slot.slice();
  for (let y = 0; y < gr.h; y++) for (let x = 0; x < gr.w; x++) {
    const p = gr.partAt(x, y);
    if ((p !== FLESH && p !== LIMB) || gr.slot[y * gr.w + x] !== BODY) continue;
    const up = gr.filled(x, y - 1), dn = gr.filled(x, y + 1), lf = gr.filled(x - 1, y);
    // Light from the upper left.
    if (!up && !lf && n >= 6) out[y * gr.w + x] = HIGH;
    else if (!up) out[y * gr.w + x] = LIGHT;
    else if (!dn) out[y * gr.w + x] = DARK;
  }
  gr.slot.set(out);
}

function pattern(gr: Grid, g: SpeciesGenome, a: Anatomy, n: number): void {
  const diet = g.dna.diet;
  const isFlesh = (x: number, y: number) => gr.partAt(x, y) === FLESH;
  for (let y = 0; y < gr.h; y++) for (let x = 0; x < gr.w; x++) {
    if (!isFlesh(x, y)) continue;
    const s = gr.slot[y * gr.w + x];
    if (s !== BODY && s !== LIGHT && s !== DARK && s !== HIGH) continue;
    // Small bodies carry the pattern over the whole body, or it is one pixel.
    const upper = n < 6 || y + 0.5 < a.by;
    switch (diet) {
      case 'producer':   // photosynthetic dapple over the back
        if (upper && (x + y) % 2 === 0) gr.slot[y * gr.w + x] = DAPPLE;
        break;
      case 'herbivore':  // countershaded: pale belly
        if (y + 0.5 > a.by - (n < 6 ? 1 : 0)) gr.slot[y * gr.w + x] = BELLY;
        break;
      case 'omnivore':   // spots
        if ((x * 2 + y * 3) % 4 === 0) gr.slot[y * gr.w + x] = BELLY;
        break;
      case 'carnivore':  // dark saddle bars
        if (x % 3 === 0) gr.slot[y * gr.w + x] = OUTLINE;
        break;
      case 'decomposer': // rot speckle
        if (((x * 7 + y * 13) ^ (x * y)) % 3 === 0) gr.slot[y * gr.w + x] = ROT;
        break;
    }
  }
  // Feeding parts change the silhouette, not only the skin — at 6px most of a
  // sprite is outline, and a pattern alone does not survive.
  const hx = Math.floor(a.hx), hy = Math.floor(a.hy);
  let front = hx; while (gr.partAt(front + 1, hy) === FLESH) front++;
  const topAt = (x: number) => { for (let y = 0; y < gr.h; y++) if (gr.filled(x, y)) return y; return -1; };
  switch (diet) {
    case 'producer': {      // a photosynthetic sail on the back
      const sx = Math.floor((a.dorsal0 + a.dorsal1) / 2), t = topAt(sx);
      if (t >= 0) { gr.set(sx, t - 1, DAPPLE, FEATURE); if (n >= 6) gr.set(sx - 1, t - 1, DAPPLE, FEATURE); }
      break;
    }
    case 'herbivore':       // blunt pale snout
      gr.set(front + 1, hy, BELLY, FEATURE);
      break;
    case 'omnivore':        // underslung jaw
      gr.set(front + 1, hy + 1, DARK, FEATURE); gr.set(front, hy + 1, DARK, FEATURE);
      break;
    case 'carnivore':       // open jaw and fang
      gr.set(front + 1, hy, MOUTH, FEATURE); gr.set(front + 1, hy + 1, BONE, FEATURE);
      if (n >= 6) gr.set(front + 2, hy, MOUTH, FEATURE);
      break;
    case 'decomposer':      // feeding proboscis toward the ground
      gr.set(front + 1, hy + 1, ROT, FEATURE); gr.set(front + 1, hy + 2, ROT, FEATURE);
      break;
  }
}

// ─── Features: senses, aggression, intellect, habitat ─────────────────────────

function features(gr: Grid, g: SpeciesGenome, a: Anatomy, n: number): void {
  const hx = Math.floor(a.hx), hy = Math.floor(a.hy);
  const top = (x: number) => { for (let y = 0; y < gr.h; y++) if (gr.filled(x, y)) return y; return -1; };
  const aggro = g.dna.aggression, smart = g.dna.intelligence;

  // Intellect: a raised cranium over the head.
  if (smart >= 5) {
    // Bulge above the head's highest pixel, so it always adds silhouette.
    const t = Math.min(top(hx), top(hx - 1) < 0 ? 99 : top(hx - 1));
    if (t >= 0 && t < 99) {
      gr.set(hx - 1, t - 1, LIGHT, FLESH); gr.set(hx, t - 1, LIGHT, FLESH);
      if (n >= 6) gr.set(hx - 2, t - 1, BODY, FLESH);
      if (n >= 8) { gr.set(hx - 1, t - 2, LIGHT, FLESH); gr.set(hx - 2, t - 2, BODY, FLESH); }
      if (smart >= 8) gr.set(hx, t - (n >= 8 ? 2 : 1) - 1, TIP, FEATURE);   // mind-light
    }
  }

  // Aggression: dorsal spikes, then a horn.
  if (aggro >= 5) {
    const count = (aggro >= 9 ? 4 : aggro >= 7 ? 3 : 2) + (n >= 7 ? 1 : 0);
    const x0 = a.dorsal0, x1 = a.dorsal1;
    const tall = n >= 5 ? 2 : 1;
    for (let k = 0; k < count; k++) {
      // At least one column apart, so small bodies still get separate spikes.
      const span = Math.max(x1 - x0, (count - 1) * 2);
      const x = Math.round(x0 + span * (k / (count - 1)));
      const t = top(x); if (t < 0) continue;
      for (let d = 1; d <= tall; d++) gr.set(x, t - d, BONE, FEATURE);
    }
    const t = top(hx + 1);                                    // horn
    if (t >= 0) { gr.set(hx + 1, t - 1, BONE, FEATURE); if (aggro >= 8) gr.set(hx + 2, t - 2, BONE, FEATURE); }
  }

  // Senses, placed on the head.
  const eye = (slot: number) => gr.set(hx, hy, slot, FEATURE);
  const redEye = aggro >= 5;
  switch (g.physicalTraits.sensorySystem) {
    case 'chemoreception': {       // two feelers swept forward
      const t = top(hx); if (t < 0) break;
      gr.line(hx, t - 1, hx + 2, t - 2, DARK, FEATURE);
      gr.line(hx - 1, t - 1, hx, t - 3, DARK, FEATURE);
      break;
    }
    case 'photoreception': {       // eyespot plus a row of ocelli down the back
      eye(TIP);
      for (let x = Math.round(a.dorsal0); x <= a.dorsal1; x += 2) { const t = top(x); if (t >= 0) gr.paint(x, t, TIP); }
      break;
    }
    case 'vision': {
      eye(redEye ? RED_EYE : EYE_W);
      gr.set(hx + 1, hy, PUPIL, FEATURE);
      if (n >= 8) { gr.set(hx, hy + 1, EYE_W, FEATURE); gr.set(hx + 1, hy - 1, DARK, FEATURE); }
      break;
    }
    case 'compound eyes': {
      gr.rect(hx, hy - 1, 2, 2, COMPOUND, FEATURE);
      gr.set(hx + 1, hy - 1, redEye ? RED_EYE : PIT, FEATURE);
      break;
    }
    case 'echolocation': {         // tall ears / sonar crest
      const t = top(hx - 1); if (t < 0) break;
      gr.set(hx - 1, t - 1, BODY, FLESH); gr.set(hx - 1, t - 2, LIGHT, FLESH);
      gr.set(hx + 1, t - 1, BODY, FLESH);
      gr.set(hx, hy, PUPIL, FEATURE);
      break;
    }
    case 'electroreception': {     // glowing lateral line
      const y = Math.round(a.by);
      for (let x = Math.round(a.bx - a.brx * 0.8); x <= a.bx + a.brx; x++) if (gr.partAt(x, y) === FLESH) gr.paint(x, y, LATERAL);
      break;
    }
    case 'tactile bristles': {     // bristles off the dorsal line
      for (let x = Math.round(a.dorsal0) - 1; x <= a.dorsal1 + 1; x += 2) { const t = top(x); if (t >= 0) gr.set(x, t - 1, DARK, FEATURE); }
      break;
    }
    case 'thermal pits': {         // heat pits along the snout
      const sx = Math.round(a.hx + a.hr * 0.6);
      gr.set(sx, hy, PIT, FEATURE); gr.set(sx, hy + 1, PIT, FEATURE); gr.set(sx - 1, hy - 1, PUPIL, FEATURE);
      break;
    }
    case 'magnetoreception': {     // one tall antenna with a lodestone tip
      const t = top(hx - 1); if (t < 0) break;
      gr.line(hx - 1, t - 1, hx - 1, t - 3, DARK, FEATURE); gr.set(hx - 1, t - 4, TIP, FEATURE);
      break;
    }
    default: eye(EYE_W);
  }

  // A hunter's eye is red whatever it sees with.
  if (redEye) gr.set(hx, hy, RED_EYE, FEATURE);

  // Habitat: the deep sea glows.
  if (g.dna.environment === 'deep_sea') {
    const y = Math.round(a.by + a.bry * 0.4);
    for (let x = Math.round(a.bx - a.brx * 0.7); x <= a.bx + a.brx * 0.7; x += 2) gr.paint(x, y, GLOW);
    gr.paint(Math.round(a.bx), Math.round(a.by - a.bry * 0.3), GLOW);
  }
}

// ─── Outline, glitch, emit ────────────────────────────────────────────────────

function outline(gr: Grid): void {
  const add: number[] = [];
  for (let y = 0; y < gr.h; y++) for (let x = 0; x < gr.w; x++) {
    if (gr.filled(x, y)) continue;
    if (gr.filled(x - 1, y) || gr.filled(x + 1, y) || gr.filled(x, y - 1) || gr.filled(x, y + 1)) add.push(y * gr.w + x);
  }
  for (const i of add) { gr.slot[i] = OUTLINE; gr.part[i] = FEATURE; }
}

/**
 * Anomalies — genomes the engine's own coherence rules call impossible —
 * carry a visible fault: a scanline tear and one off-palette pixel. Lawful
 * (it follows the genome), rare (about one mutation in thirty is an anomaly),
 * and a little wrong, which is the point.
 */
function glitch(gr: Grid, seed: number): void {
  let y0 = -1, y1 = -1;
  for (let y = 0; y < gr.h; y++) for (let x = 0; x < gr.w; x++) if (gr.filled(x, y)) { if (y0 < 0) y0 = y; y1 = y; }
  if (y0 < 0) return;
  const row = y0 + 1 + (seed % Math.max(1, y1 - y0 - 1));
  for (let y = row; y <= Math.min(y1, row + 1); y++) {
    for (let x = gr.w - 1; x > 0; x--) {
      gr.slot[y * gr.w + x] = gr.slot[y * gr.w + x - 1]; gr.part[y * gr.w + x] = gr.part[y * gr.w + x - 1];
    }
    gr.slot[y * gr.w] = -1; gr.part[y * gr.w] = NONE;
  }
  for (let x = 0; x < gr.w; x++) if (gr.filled(x, row)) { gr.slot[row * gr.w + x] = GLITCH; break; }
}

function emit(gr: Grid, pal: Pal, upscale: number): HTMLCanvasElement {
  let x0 = gr.w, x1 = -1, y0 = gr.h, y1 = -1;
  for (let y = 0; y < gr.h; y++) for (let x = 0; x < gr.w; x++) if (gr.filled(x, y)) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const cw = Math.max(1, x1 - x0 + 1), ch = Math.max(1, y1 - y0 + 1);
  const cv = document.createElement('canvas');
  cv.width = cw * upscale; cv.height = ch * upscale;
  const c = cv.getContext('2d');
  if (!c || x1 < 0) return cv;
  const img = c.createImageData(cv.width, cv.height);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const s = gr.slot[(y + y0) * gr.w + (x + x0)];
    if (s < 0) continue;
    const [r, g, b] = pal.rgb[s]; const a = pal.alpha[s];
    for (let uy = 0; uy < upscale; uy++) for (let ux = 0; ux < upscale; ux++) {
      const i = ((y * upscale + uy) * cv.width + (x * upscale + ux)) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a;
    }
  }
  c.putImageData(img, 0, 0);
  return cv;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const creatureCache = new Map<string, HTMLCanvasElement>();

/** Cache key — every genome field that changes the drawing, plus the size. */
function creatureKey(g: SpeciesGenome, n: number, upscale: number): string {
  const d = g.dna, p = g.physicalTraits;
  return [
    g.id, n, upscale, d.locomotion, d.metabolism, d.environment, d.diet, d.aggression >= 5 ? d.aggression : 0,
    d.intelligence, p.size, p.sensorySystem, p.bodyStructure, p.mobilityType,
  ].join('|');
}

/**
 * Bake a creature with an interior long edge of `n` pixels (the outline adds
 * one pixel all round), each pixel drawn `upscale` times.
 */
export function bakeCreatureAt(g: SpeciesGenome, n: number, upscale = 1): HTMLCanvasElement {
  n = Math.max(2, Math.round(n));
  upscale = Math.max(1, Math.round(upscale));
  const key = creatureKey(g, n, upscale);
  const cached = creatureCache.get(key);
  if (cached) return cached;

  const idSeed = hashString(g.id);
  const pal = buildPalette(g, new Stream(idSeed));
  const gr = new Grid(n + M * 2 + 2, n + M * 2 + 2);
  const anatomy = snapToFlesh(gr, layout(gr, g, n));
  if (n >= 4) shade(gr, n);
  if (n >= 2) {
    pattern(gr, g, anatomy, n);
    features(gr, g, anatomy, n);
  } else if (g.dna.environment === 'deep_sea') gr.paint(Math.round(anatomy.bx), Math.round(anatomy.by), GLOW);
  outline(gr);
  if (n >= 4 && !isCoherent(g)) glitch(gr, idSeed);

  const cv = emit(gr, pal, upscale);
  creatureCache.set(key, cv);
  return cv;
}

/** How much of its adult size a creature shows at each biology phase. */
const PHASE_SCALE: Record<string, number> = {
  microbial: 0.7, multicellular: 0.8, complex: 0.9, primitive: 1.0, intelligent: 1.0,
};

/**
 * The sprite the diorama blits 1:1 for a creature. `depth` 0 (back of the disc)
 * to 1 (front) adds a little perspective. Used by `IsoDioramaRenderer` and by
 * `tools/speciesSpriteCheck.ts`, so the metric judges exactly what is drawn.
 */
export function dioramaCreatureSprite(g: SpeciesGenome, phase: string, depth: number): HTMLCanvasElement {
  const base = CREATURE_SIZE_PX[g.physicalTraits.size] ?? 5;
  const n = base * (PHASE_SCALE[phase] ?? 1) * (0.85 + Math.max(0, Math.min(1, depth)) * 0.3);
  return bakeCreatureAt(g, Math.max(2, Math.round(n)));
}

/** Portrait detail, for the specimen tank and the Codex. */
const PORTRAIT_PX: Record<SpeciesSize, number> = {
  microscopic: 9, tiny: 10, small: 12, medium: 14, large: 16, massive: 18,
};

/**
 * Portrait sprite for UI panels: the same genome drawn with more pixels, then
 * scaled by an integer so it stays crisp. `scale` keeps its old meaning of
 * roughly how large the panel wants it.
 */
export function bakeCreatureSprite(g: SpeciesGenome, scale = 1): HTMLCanvasElement {
  if (scale <= 1) return dioramaCreatureSprite(g, 'intelligent', 0.5);
  const n = PORTRAIT_PX[g.physicalTraits.size] ?? 12;
  return bakeCreatureAt(g, n, Math.max(2, Math.round(scale * 0.8)));
}

// ─── Settlements ──────────────────────────────────────────────────────────────

const settlementCache = new Map<string, HTMLCanvasElement>();

/**
 * Architecture follows the builders. An aquatic civilisation raises spires from
 * the seabed; a terrestrial one builds huts, then towers as its tech rises.
 *
 * @param techLevel civLevel 0–8
 */
export function bakeSettlementSprite(
  g: SpeciesGenome | null, techLevel: number, seed: number, scale = 1,
): HTMLCanvasElement {
  const env = g?.dna.environment ?? 'land';
  const key = `${env}|${Math.min(8, techLevel)}|${seed % 8}|${scale}`;
  const cached = settlementCache.get(key);
  if (cached) return cached;

  const rng = new Stream(hashString(key));
  const W = Math.ceil(14 * scale), H = Math.ceil(14 * scale);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  if (!c) return cv;
  c.imageSmoothingEnabled = false;

  const aquatic = env === 'ocean' || env === 'deep_sea' || env === 'coastal';
  const baseY = H * 0.86;

  // Palette shifts from earthy to luminous as technology advances.
  const t = Math.min(1, techLevel / 6);
  const wall = aquatic
    ? `rgb(${Math.round(120 + t * 90)},${Math.round(180 + t * 50)},${Math.round(210 + t * 40)})`
    : `rgb(${Math.round(150 - t * 40)},${Math.round(120 - t * 10)},${Math.round(95 + t * 60)})`;
  const roof = aquatic ? '#e8fbff' : t > 0.5 ? '#9fd8ff' : '#7a4a32';
  const glow = t > 0.4 ? (aquatic ? '#a8f0ff' : '#ffd98a') : null;

  const count = 2 + rng.int(0, 2) + (techLevel > 3 ? 1 : 0);
  for (let i = 0; i < count; i++) {
    const bx = W * (0.2 + (i / Math.max(1, count - 1)) * 0.6) + rng.range(-1, 1) * scale;
    const bw = scale * rng.range(2.0, 3.4);
    const bh = scale * (aquatic
      ? rng.range(4.5, 8.5) * (0.6 + t)      // spires: tall and thin
      : rng.range(2.5, 4.5) * (0.7 + t));

    c.fillStyle = wall;
    if (aquatic) {
      // Tapered spire
      c.beginPath();
      c.moveTo(bx - bw / 2, baseY);
      c.lineTo(bx - bw * 0.18, baseY - bh);
      c.lineTo(bx + bw * 0.18, baseY - bh);
      c.lineTo(bx + bw / 2, baseY);
      c.closePath(); c.fill();
      c.fillStyle = roof;
      c.fillRect(bx - bw * 0.2, baseY - bh - scale * 0.8, bw * 0.4, scale * 0.9);
    } else {
      c.fillRect(bx - bw / 2, baseY - bh, bw, bh);
      c.fillStyle = roof;                     // pitched roof
      c.beginPath();
      c.moveTo(bx - bw * 0.62, baseY - bh);
      c.lineTo(bx, baseY - bh - scale * 1.6);
      c.lineTo(bx + bw * 0.62, baseY - bh);
      c.closePath(); c.fill();
    }

    if (glow) {                                // lit windows
      c.fillStyle = glow;
      const rows = Math.max(1, Math.floor(bh / (scale * 2)));
      for (let r = 0; r < rows; r++) {
        if (!rng.chance(0.7)) continue;
        c.fillRect(bx - scale * 0.4, baseY - bh + scale * (0.9 + r * 2), scale * 0.8, scale * 0.8);
      }
    }
  }

  settlementCache.set(key, cv);
  return cv;
}

/** Drop every cached sprite. Call on a new game so old species art is not reused. */
export function clearSpriteCaches(): void {
  creatureCache.clear();
  settlementCache.clear();
}
