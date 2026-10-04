/**
 * FloraForge — procedural pixel vegetation and minerals for the diorama's
 * surface, built from 3D primitives and rendered by CreatureForge's shared
 * core (soft-union distance fields, quantised ramps, outlines).
 *
 * Each kind has a family of seeded variants so no two trees match: conifers
 * of stacked cones, broadleaf crowns of blended spheres, palms, bushes, grass
 * tufts, cacti, fungi; and minerals: faceted boulders, ore outcrops with
 * metal veins, crystal clusters that glow at the tips.
 *
 * Colour follows the world: foliage hue is set by the planet type (green on
 * living worlds, lime and violet on toxic ones, cyan on crystal ones), rock
 * comes from the ground the decal stands on, so scenery stays inside the
 * planet's palette.
 *
 * Pure: RGBA out, no DOM.
 */
import {
  Body, Camera3, renderBody, ramp, toward, hash3, GLOW,
  type Ramp, type RGB, type V3, type ForgedSprite,
} from './CreatureForge';

export type FloraKind =
  | 'conifer' | 'broadleaf' | 'palm' | 'bush' | 'grass' | 'scrub' | 'cactus' | 'mushroom'
  | 'rock' | 'boulder' | 'ore' | 'crystal';

// Materials (indices into this module's palette).
const LEAF = 0, LEAF2 = 1, TRUNK = 2, ROCK = 3, ROCK2 = 4, CRYST = 5, ORE = 6, FLOWER = 8, MOSS = 9;
const MATS = 10;

/** Scenery is seen from the diorama's high camera, straight on. */
const SCENE_CAM = new Camera3(0.0, 0.5);

/** Foliage hue and saturation per planet type. */
const FOLIAGE: Record<string, { h: number; s: number; l: number; h2: number }> = {
  ocean:   { h: 112, s: 0.5,  l: 0.36, h2: 88 },
  rocky:   { h: 100, s: 0.46, l: 0.36, h2: 78 },
  ice:     { h: 158, s: 0.32, l: 0.34, h2: 140 },
  desert:  { h: 78,  s: 0.38, l: 0.42, h2: 60 },
  toxic:   { h: 72,  s: 0.7,  l: 0.44, h2: 290 },
  carbon:  { h: 28,  s: 0.4,  l: 0.3,  h2: 8 },
  crystal: { h: 186, s: 0.55, l: 0.5,  h2: 260 },
  storm:   { h: 140, s: 0.36, l: 0.34, h2: 118 },
  lava:    { h: 20,  s: 0.5,  l: 0.3,  h2: 0 },
  gas:     { h: 40,  s: 0.4,  l: 0.5,  h2: 20 },
};

/** Worlds whose boulders grow moss. */
const FOLIAGE_WORLDS = new Set(['ocean', 'rocky', 'ice', 'storm']);

/** Crystal and ore colours per planet type. */
const CRYSTAL_HUE: Record<string, number> = { crystal: 190, toxic: 290, carbon: 330, ice: 200, lava: 20, desert: 40 };

function rgbToHsl(c: RGB): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function palette(planetType: string, ground: RGB, seed: number): Ramp[] {
  const f = FOLIAGE[planetType] ?? FOLIAGE.rocky;
  const j = (hash3(seed, 3, 5, 7) - 0.5) * 14;
  const [gh, gs, gl] = rgbToHsl(ground);
  const pal: Ramp[] = new Array(MATS);
  pal[LEAF] = ramp(f.h + j, f.s, f.l);
  pal[LEAF2] = ramp(f.h2 + j, f.s * 1.05, f.l + 0.05);
  pal[TRUNK] = ramp(28 + j * 0.5, 0.35, 0.28);
  // Rock is the ground's own stone: same hue, greyer, a step lighter.
  pal[ROCK] = ramp(gh, Math.min(0.28, gs * 0.6), Math.max(0.3, Math.min(0.62, gl + 0.06)));
  pal[ROCK2] = ramp(toward(gh, 230, 20), Math.min(0.22, gs * 0.5), Math.max(0.22, gl - 0.08));
  const ch = CRYSTAL_HUE[planetType] ?? (180 + hash3(seed, 9, 9, 9) * 120);
  pal[CRYST] = ramp(ch, 0.6, 0.58, 235);
  const metals: Array<[number, number, number]> = [[45, 0.75, 0.55], [22, 0.65, 0.5], [200, 0.15, 0.62]];  // gold, copper, silver
  const m = metals[seed % metals.length];
  pal[ORE] = ramp(m[0], m[1], m[2]);
  pal[GLOW] = ramp(ch, 0.85, 0.72);
  pal[FLOWER] = ramp((f.h + 180 + j * 4) % 360, 0.65, 0.6);
  pal[MOSS] = ramp(f.h, f.s * 0.8, f.l - 0.04);
  return pal;
}

// ─── Plans ───────────────────────────────────────────────────────────────────

const rnd = (seed: number, k: number) => hash3(seed, k, 31, 17);

function planConifer(B: Body, v: number): void {
  const gT = B.group(0, 0.01), gL = B.group(0, 0.02);
  const h = 0.9 + rnd(v, 1) * 0.35, w = 0.22 + rnd(v, 2) * 0.08, tiers = 3 + (v % 2);
  B.cone([0, -0.5, 0], [0, -0.5 + h * 0.3, 0], 0.05, 0.04, TRUNK, gT);
  for (let i = 0; i < tiers; i++) {
    const y0 = -0.5 + h * (0.18 + i * 0.22), r = w * (1 - i * 0.2);
    B.cone([0, y0, 0], [rnd(v, 10 + i) * 0.02, y0 + h * 0.34, 0], r, 0.012, i % 2 ? LEAF : LEAF2, gL);
  }
}

function planBroadleaf(B: Body, v: number): void {
  const gT = B.group(0, 0.03), gL = B.group(0, 0.08);
  const lean = (rnd(v, 1) - 0.5) * 0.12;
  B.chain([[0, -0.5, 0], [lean * 0.5, -0.3, 0], [lean, -0.12, 0]], 0.06, 0.04, TRUNK, gT);
  // Two forking boughs into the crown.
  B.cone([lean, -0.16, 0], [lean - 0.12, 0.0, 0.04], 0.03, 0.02, TRUNK, gT);
  B.cone([lean, -0.16, 0], [lean + 0.11, -0.02, 0.03], 0.03, 0.02, TRUNK, gT);
  const n = 5 + (v % 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd(v, 3) * 2;
    const r = 0.17 + rnd(v, 20 + i) * 0.07;
    B.ell([lean + Math.cos(a) * 0.2, 0.06 + rnd(v, 30 + i) * 0.14, Math.sin(a) * 0.14], [r, r * 0.85, r], i % 3 === 0 ? LEAF2 : LEAF, gL);
  }
  B.ell([lean, 0.2, 0], [0.22, 0.17, 0.2], LEAF, gL);
}

function planPalm(B: Body, v: number): void {
  const gT = B.group(0, 0.02), gL = B.group(0, 0.01);
  const bend = 0.12 + rnd(v, 1) * 0.12;
  const top: V3 = [bend, 0.32, 0];
  B.chain([[0, -0.5, 0], [bend * 0.2, -0.15, 0], [bend * 0.6, 0.12, 0], top], 0.05, 0.035, TRUNK, gT);
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd(v, 2);
    const tip: V3 = [top[0] + Math.cos(a) * 0.36, top[1] - 0.12 - rnd(v, 3 + i) * 0.1, Math.sin(a) * 0.3];
    const mid: V3 = [top[0] + Math.cos(a) * 0.2, top[1] + 0.06, Math.sin(a) * 0.17];
    B.tri(top, mid, [mid[0] + Math.sin(a) * 0.05, mid[1], mid[2] - Math.cos(a) * 0.05], 0.012, i % 2 ? LEAF : LEAF2, gL);
    B.tri(mid, tip, [mid[0] + Math.sin(a) * 0.06, mid[1] - 0.04, mid[2] - Math.cos(a) * 0.06], 0.012, i % 2 ? LEAF : LEAF2, gL);
  }
  B.ell([top[0], top[1] - 0.03, 0.03], [0.04, 0.04, 0.04], TRUNK, gT);
}

function planBush(B: Body, v: number, berries: boolean): void {
  const g = B.group(0, 0.07), gF = B.group(0, 0.0);
  const n = 3 + (v % 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd(v, 1);
    const r = 0.14 + rnd(v, 5 + i) * 0.06;
    B.ell([Math.cos(a) * 0.16, -0.5 + r * 0.9 + rnd(v, 9 + i) * 0.06, Math.sin(a) * 0.1], [r, r * 0.85, r], i % 2 ? LEAF2 : LEAF, g);
  }
  if (berries) {
    for (let i = 0; i < 4; i++) {
      const a = rnd(v, 40 + i) * Math.PI * 2;
      B.ell([Math.cos(a) * 0.18, -0.3 + rnd(v, 50 + i) * 0.1, 0.16], [0.03, 0.03, 0.03], FLOWER, gF);
    }
  }
}

function planGrass(B: Body, v: number): void {
  const g = B.group(0, 0.0);
  const n = 5 + (v % 3);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1) - 0.5) * 0.36 + (rnd(v, i) - 0.5) * 0.06;
    const lean = (x * 0.9) + (rnd(v, 10 + i) - 0.5) * 0.2;
    const h = 0.35 + rnd(v, 20 + i) * 0.35;
    B.cone([x, -0.5, (rnd(v, 30 + i) - 0.5) * 0.1], [x + lean, -0.5 + h, 0], 0.035, 0.006, i % 2 ? LEAF : LEAF2, g);
  }
}

function planCactus(B: Body, v: number): void {
  const g = B.group(0, 0.05), gF = B.group(0, 0.0);
  const h = 0.75 + rnd(v, 1) * 0.3;
  B.cone([0, -0.5, 0], [0, -0.5 + h, 0], 0.11, 0.1, LEAF, g);
  const arms = 1 + (v % 2);
  for (let i = 0; i < arms; i++) {
    const sd = i === 0 ? 1 : -1, y = -0.5 + h * (0.35 + rnd(v, 2 + i) * 0.2);
    B.chain([[0, y, 0], [sd * 0.2, y + 0.02, 0], [sd * 0.22, y + 0.24, 0]], 0.065, 0.06, LEAF, g);
  }
  if (rnd(v, 9) > 0.5) B.ell([0, -0.5 + h + 0.04, 0.02], [0.05, 0.04, 0.05], FLOWER, gF);
}

function planMushroom(B: Body, v: number): void {
  const gS = B.group(0, 0.03), gC = B.group(0, 0.04);
  const n = 1 + (v % 3);
  for (let i = 0; i < n; i++) {
    const x = i === 0 ? 0 : (i === 1 ? 0.24 : -0.22), sc = i === 0 ? 1 : 0.55;
    const h = (0.5 + rnd(v, i) * 0.25) * sc;
    B.cone([x, -0.5, 0], [x, -0.5 + h, 0], 0.06 * sc, 0.05 * sc, TRUNK, gS);
    B.ell([x, -0.5 + h + 0.02, 0], [0.24 * sc, 0.1 * sc, 0.24 * sc], i % 2 ? LEAF2 : LEAF, gC);
  }
}

function planBoulder(B: Body, v: number): void {
  const g = B.group(0, 0.05, false, true);
  const n = 1 + (v % 3);
  const r0 = 0.3;
  B.ell([0, -0.5 + r0 * 0.5, 0], [r0 * (1.15 + rnd(v, 1) * 0.3), r0 * (0.62 + rnd(v, 2) * 0.2), r0 * 0.95], ROCK, g);
  for (let i = 1; i <= n; i++) {
    const sd = i % 2 ? 1 : -1, r = 0.12 + rnd(v, 10 + i) * 0.07;
    B.ell([sd * (0.28 + rnd(v, i) * 0.1), -0.5 + r * 0.55, 0.05 + (rnd(v, 20 + i) - 0.5) * 0.15],
      [r * 1.2, r * 0.75, r], ROCK2, g);
  }
}

function planOre(B: Body, v: number): void {
  planBoulder(B, v);
}

function planCrystal(B: Body, v: number): void {
  const gB = B.group(0, 0.04, false, true), gC = B.group(0, 0.0, false, true);
  B.ell([0, -0.48, 0], [0.24, 0.06, 0.18], ROCK2, gB);
  const n = 3 + (v % 4);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd(v, 1);
    const tilt = i === 0 ? 0 : 0.15 + rnd(v, 2 + i) * 0.25;
    const h = i === 0 ? 0.75 : 0.35 + rnd(v, 10 + i) * 0.3;
    const base: V3 = [Math.cos(a) * 0.08 * (i ? 1 : 0), -0.48, Math.sin(a) * 0.06 * (i ? 1 : 0)];
    const tip: V3 = [base[0] + Math.cos(a) * tilt * h, base[1] + h, base[2] + Math.sin(a) * tilt * h * 0.6];
    B.cone(base, tip, 0.07 * (i ? 0.75 : 1), 0.008, CRYST, gC);
    B.dots.push({ p: tip, mat: GLOW });
  }
}

function planFor(kind: FloraKind, v: number): Body {
  const B = new Body();
  switch (kind) {
    case 'conifer': planConifer(B, v); break;
    case 'broadleaf': planBroadleaf(B, v); break;
    case 'palm': planPalm(B, v); break;
    case 'bush': planBush(B, v, v % 3 === 0); break;
    case 'scrub': planBush(B, v + 7, false); break;
    case 'grass': planGrass(B, v); break;
    case 'cactus': planCactus(B, v); break;
    case 'mushroom': planMushroom(B, v); break;
    case 'crystal': planCrystal(B, v); break;
    case 'ore': planOre(B, v); break;
    case 'rock': case 'boulder': default: planBoulder(B, v); break;
  }
  return B;
}

/** Variants per kind before shapes repeat. */
export const FLORA_VARIANTS = 6;

/**
 * Render one scenery sprite, long edge about `px` pixels. `ground` is the
 * colour of the land it stands on (rock takes its stone from it).
 */
export interface FloraSprite extends ForgedSprite {
  /** The pixel the object stands on: its base centre. */
  footX: number;
  footY: number;
}

export function forgeFlora(kind: FloraKind, variant: number, px: number, planetType: string, ground: RGB): FloraSprite {
  const v = ((variant % FLORA_VARIANTS) + FLORA_VARIANTS) % FLORA_VARIANTS + 1;
  const B = planFor(kind, v);
  const pal = palette(planetType, ground, v);
  const mossy = FOLIAGE_WORLDS.has(planetType);
  const R = renderBody(B, pal, px, SCENE_CAM, (m, w, n) => {
    // Ore: metal veins glint through the stone in bands.
    if (kind === 'ore' && (m === ROCK || m === ROCK2)) {
      const vein = Math.sin(w[0] * 30 + w[1] * 18 + w[2] * 11 + v) + Math.sin(w[1] * 42 - w[0] * 9);
      if (vein > 1.35) return { m: ORE, dl: 1 };
    }
    // Moss caps the tops of boulders on living worlds.
    if (kind === 'boulder' && m === ROCK && n[1] > 0.75 && mossy && hash3(Math.floor(w[0] * 30), Math.floor(w[2] * 30), 3, v) > 0.25) return { m: MOSS, dl: 0 };
    // Mushroom caps carry pale spots.
    if (kind === 'mushroom' && (m === LEAF || m === LEAF2) && n[1] > 0.2 &&
        hash3(Math.floor(w[0] * 22), Math.floor(w[2] * 22), 1, v) > 0.8) return { m: FLOWER, dl: 1 };
    return { m, dl: 0 };
  });
  // Glow tips on crystals.
  for (const d of B.dots) {
    const c = SCENE_CAM.toCam(d.p);
    const x = Math.round(c[0] * R.s + R.ox - 0.5), y = Math.round(R.oy - c[1] * R.s - 0.5);
    if (x < 0 || y < 0 || x >= R.width || y >= R.height) continue;
    const i = y * R.width + x;
    if (!R.cover[i]) continue;
    R.put(i, pal[d.mat].lv[4], 255);
  }
  const f = SCENE_CAM.toCam([0, -0.5, 0]);
  return {
    width: R.width, height: R.height, data: R.data,
    footX: Math.round(f[0] * R.s + R.ox - 0.5),
    footY: Math.min(R.height - 1, Math.round(R.oy - f[1] * R.s - 0.5)),
  };
}

/** Minerals take their stone from the ground; plants do not. */
export function isMineral(kind: FloraKind): boolean {
  return kind === 'rock' || kind === 'boulder' || kind === 'ore' || kind === 'crystal';
}

/** Quantise a ground colour so nearby shades share one cached sprite. */
export function groundKey(c: RGB): number {
  return ((c[0] >> 5) << 6) | ((c[1] >> 5) << 3) | (c[2] >> 5);
}
export function groundFromKey(k: number): RGB {
  return [((k >> 6) & 7) * 32 + 16, ((k >> 3) & 7) * 32 + 16, (k & 7) * 32 + 16];
}

