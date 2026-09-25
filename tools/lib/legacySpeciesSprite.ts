// FROZEN COPY of src/rendering/SpeciesSprite.ts as of 2d62867 (pre species-identity work).
// Kept only as the CONTROL for tools/speciesSpriteCheck.ts: the metric must reject it.
// Do not edit. Do not import from game code.
/**
 * SpeciesSprite — procedural pixel-art creatures and settlements.
 *
 * `EVOLUTION_SYSTEM.md` asks for species that are "visible on the planet and are
 * created procedurally", and `CIVILIZATION_SYSTEM.md` for architecture that
 * follows species morphology ("Aquatic species build Glass Spires"). The
 * simulation already evolves rich genomes — locomotion, metabolism, size,
 * sensory system — but nothing drew them, so the player never saw what their
 * world had actually produced.
 *
 * Every sprite here is derived from the genome, not chosen from a fixed set:
 *   locomotion  → silhouette (swimmer / walker / flier / crawler / sessile)
 *   metabolism  → palette
 *   size        → pixel dimensions
 *   sensory     → eyes
 *   aggression  → spines and jaw
 *   intelligence→ cranium
 *
 * Sprites are baked once per species into a small offscreen canvas and blitted,
 * so drawing a hundred creatures costs a hundred drawImage calls.
 */

import type { SpeciesGenome, Metabolism, SpeciesSize } from '../../src/simulation/SpeciesGenome';

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

// ─── Palettes ─────────────────────────────────────────────────────────────────

interface Palette { body: string; dark: string; light: string; accent: string }

const METABOLISM_PALETTE: Record<Metabolism, Palette> = {
  photosynthetic: { body: '#4c9a3f', dark: '#2c5f26', light: '#8ed36f', accent: '#d8f07a' },
  chemosynthetic: { body: '#8a6bb0', dark: '#4d3a68', light: '#c3a6e0', accent: '#7ce8d8' },
  heterotrophic:  { body: '#b06a44', dark: '#6b3c25', light: '#e0a077', accent: '#ffd9a0' },
  parasitic:      { body: '#9c4a5e', dark: '#5a2635', light: '#d68196', accent: '#c8f050' },
};

/** Longest edge of the sprite, in virtual pixels. */
const SIZE_PX: Record<SpeciesSize, number> = {
  microscopic: 3, tiny: 5, small: 7, medium: 10, large: 14, massive: 19,
};

// ─── Creature baking ──────────────────────────────────────────────────────────

const creatureCache = new Map<string, HTMLCanvasElement>();

/** Cache key — genome fields that actually change the drawing. */
function creatureKey(g: SpeciesGenome, scale: number): string {
  const d = g.dna, p = g.physicalTraits;
  return [
    g.id, scale, d.locomotion, d.metabolism, d.environment, d.aggression,
    d.intelligence, p.size, p.sensorySystem, p.bodyStructure,
  ].join('|');
}

/**
 * Draw one creature into its own canvas.
 * @param scale pixels per sprite unit — 1 for the world surface, larger for UI.
 */
export function bakeCreatureSprite(g: SpeciesGenome, scale = 1): HTMLCanvasElement {
  const key = creatureKey(g, scale);
  const cached = creatureCache.get(key);
  if (cached) return cached;

  const rng = new Stream(hashString(g.id));
  const pal = METABOLISM_PALETTE[g.dna.metabolism] ?? METABOLISM_PALETTE.heterotrophic;
  const unit = Math.max(3, SIZE_PX[g.physicalTraits.size] ?? 8);

  // Generous margin so fins, wings and spines are never clipped.
  const W = Math.ceil(unit * 2.0 * scale);
  const H = Math.ceil(unit * 1.6 * scale);
  const cv = document.createElement('canvas');
  cv.width = Math.max(4, W); cv.height = Math.max(4, H);
  const c = cv.getContext('2d');
  if (!c) return cv;
  c.imageSmoothingEnabled = false;

  const cx = cv.width / 2, cy = cv.height / 2;
  const s = unit * scale;                      // body half-length reference

  const fill = (color: string) => { c.fillStyle = color; };
  const blob = (x: number, y: number, rx: number, ry: number) => {
    c.beginPath(); c.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2); c.fill();
  };

  const aggro = g.dna.aggression / 10;
  const smart = g.dna.intelligence / 10;

  switch (g.dna.locomotion) {
    case 'stationary': {
      // Sessile: a holdfast with fronds or a polyp crown.
      fill(pal.dark);
      c.fillRect(cx - s * 0.10, cy - s * 0.1, s * 0.20, s * 0.75);
      const arms = 3 + rng.int(0, 4);
      for (let i = 0; i < arms; i++) {
        const a = -Math.PI / 2 + (i - (arms - 1) / 2) * rng.range(0.35, 0.6);
        const len = s * rng.range(0.5, 0.85);
        fill(i % 2 ? pal.body : pal.light);
        c.save();
        c.translate(cx, cy - s * 0.1);
        c.rotate(a);
        c.fillRect(-s * 0.06, -len, s * 0.12, len);
        blob(0, -len, s * 0.12, s * 0.12);
        c.restore();
      }
      break;
    }

    case 'swimming': {
      // Streamlined body, tail fluke, dorsal fin.
      fill(pal.body);
      blob(cx, cy, s * 0.62, s * 0.30);
      fill(pal.dark);                                   // tail
      c.beginPath();
      c.moveTo(cx - s * 0.55, cy);
      c.lineTo(cx - s * 0.95, cy - s * 0.34);
      c.lineTo(cx - s * 0.95, cy + s * 0.34);
      c.closePath(); c.fill();
      fill(pal.light);                                  // dorsal
      c.beginPath();
      c.moveTo(cx - s * 0.05, cy - s * 0.28);
      c.lineTo(cx + s * 0.12, cy - s * 0.62);
      c.lineTo(cx + s * 0.28, cy - s * 0.24);
      c.closePath(); c.fill();
      fill(pal.light); blob(cx + s * 0.1, cy + s * 0.16, s * 0.34, s * 0.10);
      break;
    }

    case 'crawling': {
      // Segmented, low-slung, many short legs.
      const segs = 3 + rng.int(0, 3);
      for (let i = 0; i < segs; i++) {
        const t = i / (segs - 1 || 1);
        const x = cx - s * 0.6 + t * s * 1.2;
        fill(i % 2 ? pal.body : pal.dark);
        blob(x, cy, s * 0.26, s * 0.22);
        fill(pal.dark);
        c.fillRect(x - s * 0.03, cy + s * 0.16, s * 0.06, s * 0.22);
      }
      if (aggro > 0.45) {                                // pincers
        fill(pal.accent);
        c.fillRect(cx + s * 0.62, cy - s * 0.18, s * 0.22, s * 0.07);
        c.fillRect(cx + s * 0.62, cy + s * 0.11, s * 0.22, s * 0.07);
      }
      break;
    }

    case 'walking': {
      // Upright torso on legs; braincase grows with intelligence.
      fill(pal.body);
      blob(cx, cy - s * 0.05, s * 0.34, s * 0.42);
      fill(pal.light);
      blob(cx + s * 0.05, cy - s * 0.42 - smart * s * 0.12,
           s * (0.20 + smart * 0.10), s * (0.18 + smart * 0.10));
      fill(pal.dark);
      const legs = rng.chance(0.25) ? 4 : 2;
      for (let i = 0; i < legs; i++) {
        const x = cx - s * 0.18 + (i / Math.max(1, legs - 1)) * s * 0.36;
        c.fillRect(x - s * 0.05, cy + s * 0.32, s * 0.10, s * 0.42);
      }
      if (aggro > 0.55) {                                // dorsal spines
        fill(pal.accent);
        for (let i = 0; i < 3; i++) {
          c.beginPath();
          c.moveTo(cx - s * 0.22 + i * s * 0.18, cy - s * 0.36);
          c.lineTo(cx - s * 0.16 + i * s * 0.18, cy - s * 0.60);
          c.lineTo(cx - s * 0.10 + i * s * 0.18, cy - s * 0.36);
          c.closePath(); c.fill();
        }
      }
      break;
    }

    case 'flying': {
      // Compact body, broad wings.
      fill(pal.light);
      const span = s * rng.range(0.80, 1.05);
      c.beginPath();
      c.moveTo(cx, cy);
      c.quadraticCurveTo(cx - span * 0.6, cy - s * 0.62, cx - span, cy - s * 0.05);
      c.quadraticCurveTo(cx - span * 0.5, cy + s * 0.14, cx, cy + s * 0.06);
      c.closePath(); c.fill();
      c.beginPath();
      c.moveTo(cx, cy);
      c.quadraticCurveTo(cx + span * 0.6, cy - s * 0.62, cx + span, cy - s * 0.05);
      c.quadraticCurveTo(cx + span * 0.5, cy + s * 0.14, cx, cy + s * 0.06);
      c.closePath(); c.fill();
      fill(pal.body);
      blob(cx, cy, s * 0.20, s * 0.32);
      break;
    }
  }

  // ── Eyes ────────────────────────────────────────────────────────────────
  // Sensory system decides how many and how prominent.
  const sensory = g.physicalTraits.sensorySystem.toLowerCase();
  let eyes = 0;
  if (sensory.includes('compound')) eyes = 2;
  else if (sensory.includes('eye') || sensory.includes('vision') || sensory.includes('sight')) eyes = 2;
  else if (sensory.includes('echo') || sensory.includes('sonar')) eyes = 1;
  else if (sensory.includes('chemo') || sensory.includes('tactile')) eyes = 0;
  else eyes = g.dna.intelligence > 2 ? 2 : 1;

  if (eyes > 0 && unit >= 5) {
    const ex = g.dna.locomotion === 'walking' ? cx + s * 0.10 : cx + s * 0.34;
    const ey = g.dna.locomotion === 'walking' ? cy - s * 0.44 - smart * s * 0.12 : cy - s * 0.06;
    const r = Math.max(0.6, s * (0.07 + smart * 0.04));
    for (let i = 0; i < eyes; i++) {
      const off = eyes === 1 ? 0 : (i === 0 ? -r * 1.4 : r * 1.4);
      fill('#0a0a12'); blob(ex, ey + off * 0.6, r, r);
      fill(sensory.includes('compound') ? pal.accent : '#ffffff');
      blob(ex + r * 0.3, ey + off * 0.6 - r * 0.3, r * 0.42, r * 0.42);
    }
  }

  creatureCache.set(key, cv);
  return cv;
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
