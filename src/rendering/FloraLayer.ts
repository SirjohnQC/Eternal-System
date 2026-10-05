/**
 * FloraLayer — the diorama's plants and stones as a live layer.
 *
 * Decals used to be stamped into the baked land, which made them still and
 * made a changing biosphere swap one forest for another between bakes. Here
 * they are drawn every frame over the land (under the day/night veil), so:
 *
 * - Plants SWAY: each sprite is pre-sheared into a few frames (top bent
 *   left .. right, the foot fixed), and a wind wave rolling across the world
 *   picks the frame. Grass and palms move most, trees a little, cacti,
 *   fungi and stone not at all. Crystals and ore veins twinkle instead.
 * - Plants GROW: every planned site has a birth time. A site that appears
 *   when the plan changes starts as a seedling and steps up through growth
 *   stages; a site that leaves the plan wilts (browns and shrinks) and goes.
 *   A new planet or a resize shows everything fully grown.
 *
 * Sprites are the same art as before: FloraForge when big on screen, the
 * atlas (shaded from the ground) when small. Each is built once per kind,
 * variant, size, stage and footing colour and cached as a canvas strip of
 * frames, so a frame is one drawImage per visible decal.
 */
import type { DecalAtlas, DecalSite, DecalKind } from './SurfaceDecals';
import { isMineralKind, isWoody, FORGE_DECAL_MIN_PX } from './SurfaceDecals';
import { forgeFlora, groundKey, FLORA_VARIANTS } from './FloraForge';

/** Seconds a new plant takes from seedling to full size. */
export const GROW_SECONDS = 16;
/** Seconds a lost plant takes to wilt away. */
export const WILT_SECONDS = 8;
/** Growth stages, as a fraction of full size (seedling .. grown). */
const STAGES = [0.3, 0.5, 0.72, 1];
/** Sway frames: the top bent from full left to full right. */
const SWAY = [-1, -0.5, 0, 0.5, 1];
/** At most this many forged (ray-marched) sprites are made per frame; the atlas stands in meanwhile. */
const FORGES_PER_FRAME = 4;
const FORGE_MAX_PX = 72;
const CACHE_MAX = 2500;

interface Sheet {
  canvas: HTMLCanvasElement;
  fw: number;
  fh: number;
  frames: number;
  footX: number;
  footY: number;
  /** 'sway' frames follow the wind; 'twinkle' frame 1 is a sparkle. */
  mode: 'still' | 'sway' | 'twinkle';
  /** Forged sheets: the sprite size it was made at (a stand-in is scaled from it). */
  px?: number;
}

interface Live {
  key: string;
  site: DecalSite;
  born: number;
  died: number | null;
  /** Per-plant offset so neighbours don't move in lockstep. */
  phase: number;
}

/** Where the layer is drawn: the shown layer set's camera and its map to screen. */
export interface FloraView {
  /** The set's baked camera (zoom, focus) and size; identity: zoom 1, focus at the centre. */
  K: number; fx: number; fy: number; W: number; H: number;
  /** Set px -> screen: X * r + dx, Y * r + dy. */
  r: number; dx: number; dy: number;
  bob: number;
  /** Screen size, for culling. */
  vw: number; vh: number;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Worlds whose plants follow the seasons (green, temperate foliage). */
const SEASONAL_WORLDS = new Set(['ocean', 'rocky', 'ice', 'storm']);
/** Autumn foliage: rust, amber, crimson. */
const AUTUMN: Array<[number, number, number]> = [[196, 92, 38], [222, 160, 52], [170, 52, 40]];

/**
 * Seasonal colour on a sprite, in place. Deciduous plants (broadleaf, bush,
 * scrub, grass) go fresh in spring, turn in autumn and are bare (or straw)
 * in winter; conifers stay green and carry snow in winter. Foliage pixels
 * are the green-dominant ones, so trunks, flowers and stone are untouched.
 */
function seasonTint(
  src: { width: number; height: number; data: Uint8ClampedArray }, kind: DecalKind, season: number, variant: number,
): void {
  // Summer is the art as drawn; stone, palms and cacti have no seasons;
  // fungi only catch snow.
  if (season === 1 || isMineralKind(kind) || kind === 'palm' || kind === 'cactus') return;
  if (kind === 'mushroom' && season !== 3) return;
  const d = src.data, W = src.width;
  const deciduous = kind === 'broadleaf' || kind === 'bush' || kind === 'scrub' || kind === 'grass';
  const leaf = (i: number) => d[i + 3] > 0 && d[i + 1] > d[i] + 6 && d[i + 1] >= d[i + 2];
  const snowTop: number[] = [];
  for (let y = 0; y < src.height; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (d[i + 3] === 0) continue;
    const l = (d[i] + d[i + 1] + d[i + 2]) / 765;
    if (season === 3 && (y === 0 || d[i - W * 4 + 3] === 0)) snowTop.push(i);
    if (!leaf(i)) continue;
    if (season === 0 && deciduous) {
      // Fresh spring green.
      d[i] = d[i] * 0.75 + 150 * 0.25; d[i + 1] = Math.min(255, d[i + 1] * 0.75 + 205 * 0.25); d[i + 2] = d[i + 2] * 0.75 + 90 * 0.25;
    } else if (season === 2 && deciduous) {
      const c = AUTUMN[(variant + ((x * 7 + y * 3) >> 3)) % 3], m = 0.55 + l * 0.9;
      d[i] = c[0] * m; d[i + 1] = c[1] * m; d[i + 2] = c[2] * m;
    } else if (season === 3 && deciduous) {
      if (kind === 'grass' || kind === 'scrub') {
        d[i] = 168 * (0.6 + l * 0.7); d[i + 1] = 148 * (0.6 + l * 0.7); d[i + 2] = 100 * (0.6 + l * 0.7);
      } else {
        // Bare crown: a mass of grey-brown twigs, shaded as the foliage was.
        const m = 0.5 + l * 1.1;
        d[i] = 118 * m; d[i + 1] = 102 * m; d[i + 2] = 92 * m;
      }
    }
  }
  if (season === 3) {
    // Snow lies on top of every upper edge (conifers, bare crowns, bushes).
    for (const i of snowTop) if (d[i + 3] > 0) { d[i] = 236; d[i + 1] = 242; d[i + 2] = 250; }
  }
}

/** Sway amplitude at the top of the sprite, as a fraction of its height. */
function swayOf(kind: DecalKind): number {
  switch (kind) {
    case 'grass': return 0.16;
    case 'palm': return 0.1;
    case 'conifer': case 'broadleaf': return 0.06;
    case 'bush': case 'scrub': return 0.05;
    default: return 0;
  }
}

export class FloraLayer {
  private live = new Map<string, Live>();
  private order: Live[] = [];
  private cache = new Map<string, Sheet>();
  /** Last forged sheet per plant look, any size: the stand-in while a new size is forged. */
  private lastForged = new Map<string, Sheet>();
  private forgesLeft = 0;
  /** Wind strength (1 = a breeze; 0 stills every plant). */
  wind = 1;
  /**
   * Season shown: 0 spring, 1 summer, 2 autumn, 3 winter, -1 none (no axial
   * tilt, or a world whose plants do not follow seasons). Set by the host;
   * a change re-renders the layer (`setSeason`).
   */
  season = -1;
  setSeason(s: number): void {
    if (s === this.season) return;
    this.season = s;
    this.version++;
  }

  /** Bumped on every new plan: a cached render of the layer is stale. */
  version = 0;

  /** Number of plants currently drawn (growing, grown or wilting). */
  get count(): number { return this.order.length + this.props.length; }

  /**
   * Other things standing on the ground (the towns' buildings), drawn in the
   * same back-to-front pass so a tree in front of a house covers it and a
   * house in front of a tree covers the tree. `wy`: base-world foot row,
   * lifted, like a site's; `draw` paints into the layer through `v`.
   */
  private props: Array<{ wy: number; draw: (g: CanvasRenderingContext2D, v: FloraView) => void }> = [];
  setProps(list: Array<{ wy: number; draw: (g: CanvasRenderingContext2D, v: FloraView) => void }>): void {
    this.props = [...list].sort((a, b) => a.wy - b.wy);
    this.version++;
  }

  /**
   * A new plan. `mature`: everything appears fully grown and nothing wilts
   * (a new planet, a resize). Otherwise new sites grow in, staggered so a
   * forest spreads instead of popping, and dropped sites wilt.
   */
  setPlan(sites: DecalSite[] | null, now: number, mature: boolean): void {
    this.version++;
    const next = new Map<string, Live>();
    const seen = new Map<string, number>();
    for (const s of sites ?? []) {
      const base = `${s.row},${s.col},${s.kind}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const key = `${base}#${n}`;
      const old = this.live.get(key);
      if (old && !mature) {
        old.site = s;
        if (old.died !== null) { old.died = null; old.born = Math.min(old.born, now); }
        next.set(key, old);
      } else {
        const phase = hashStr(key);
        const born = mature || isMineralKind(s.kind) ? -Infinity : now + phase * GROW_SECONDS * 0.6;
        next.set(key, { key, site: s, born, died: null, phase });
      }
    }
    if (!mature) {
      for (const [key, l] of this.live) {
        if (next.has(key) || isMineralKind(l.site.kind)) continue;
        if (l.died === null) l.died = now;
        next.set(key, l);
      }
    }
    this.live = next;
    this.order = [...next.values()].sort((a, b) => (a.site.wy ?? a.site.y) - (b.site.wy ?? b.site.y));
  }

  /**
   * Forge, ahead of time, every sheet a view at zoom `K` (camera focus fx, fy;
   * set size W x H) will need — one forge per step. The host runs this inside
   * the time-sliced camera bake, so the sharp set swaps in with its plants
   * already made instead of restyling a few per frame afterwards.
   */
  *prewarmSteps(
    K: number, fx: number, fy: number, W: number, H: number,
    now: number, planetType: string, atlas: DecalAtlas | null,
  ): Generator<void, void, unknown> {
    for (const l of this.order) {
      const s = l.site;
      if (s.foot === undefined || s.foot < 0 || l.died !== null) continue;
      const full = Math.max(2, Math.round(16 * clamp(s.scale, 0.2, 1.35))) * K;
      const X = ((s.wx ?? s.x) - fx) * K + W / 2, Y = ((s.wy ?? s.y) - fy) * K + H / 2;
      const reach = full * 1.4 + 4;
      if (X < -reach || X > W + reach || Y < -4 || Y > H + reach) continue;
      // The stage it shows now, and grown (where a young plant is heading).
      let stage = STAGES.length - 1;
      if (now < l.born) continue;
      if (l.born !== -Infinity) {
        const gr = (now - l.born) / GROW_SECONDS;
        if (gr < 1) stage = Math.min(STAGES.length - 2, Math.floor(gr * (STAGES.length - 1)));
      }
      for (const st of stage === STAGES.length - 1 ? [stage] : [stage, STAGES.length - 1]) {
        const before = this.cache.size;
        this.forgesLeft = 1;
        this.sheetFor(l, Math.max(2, Math.round(full * STAGES[st])), planetType, atlas, false);
        if (this.cache.size !== before) yield;
      }
    }
    this.forgesLeft = 0;
  }

  /** Forget everything (a gas giant, or decals switched off). */
  clear(): void { this.live.clear(); this.order = []; this.version++; }

  draw(g: CanvasRenderingContext2D, now: number, v: FloraView, planetType: string, atlas: DecalAtlas | null): void {
    if (this.order.length === 0 && this.props.length === 0) return;
    this.forgesLeft = FORGES_PER_FRAME;
    const prevSmooth = g.imageSmoothingEnabled;
    g.imageSmoothingEnabled = false;
    let dead = 0, pi = 0;
    const props = this.props;
    for (const l of this.order) {
      const s = l.site;
      // Props behind this plant first (painter's order).
      const lwy = s.wy ?? s.y;
      while (pi < props.length && props[pi].wy <= lwy) props[pi++].draw(g, v);
      if (s.foot === undefined || s.foot < 0) continue;
      // Growth (or wilt) stage.
      let stage = STAGES.length - 1, wilt = false;
      if (l.died !== null) {
        const w = (now - l.died) / WILT_SECONDS;
        if (w >= 1) { dead++; continue; }
        stage = STAGES.length - 1 - Math.min(STAGES.length - 1, Math.floor(w * STAGES.length));
        wilt = true;
      } else if (now < l.born) {
        continue;                                   // not sprouted yet
      } else if (l.born !== -Infinity) {
        const gr = (now - l.born) / GROW_SECONDS;
        if (gr < 1) stage = Math.min(STAGES.length - 2, Math.floor(gr * (STAGES.length - 1)));
      }
      const wx = s.wx ?? s.x, wy = s.wy ?? s.y;
      const X = (wx - v.fx) * v.K + v.W / 2, Y = (wy - v.fy) * v.K + v.H / 2;
      const sx = X * v.r + v.dx, sy = Y * v.r + v.dy + v.bob;
      const dest = Math.max(2, Math.round(16 * clamp(s.scale, 0.2, 1.35)));
      const full = dest * v.K;
      const reach = full * v.r * 1.4 + 4;
      if (sx < -reach || sx > v.vw + reach || sy < -4 || sy > v.vh + reach) continue;
      const px = Math.max(2, Math.round(full * STAGES[stage]));
      const sheet = this.sheetFor(l, px, planetType, atlas, wilt);
      if (!sheet) continue;
      let f = 0;
      if (sheet.mode === 'sway') {
        const gust = 0.65 + 0.35 * Math.sin(now * 0.23 + wx * 0.011);
        const sw = Math.sin(now * 2.1 - wx * 0.05 - wy * 0.02 + l.phase * 1.3) * gust * this.wind;
        f = clamp(Math.round((sw + 1) * 2), 0, sheet.frames - 1);
      } else if (sheet.mode === 'twinkle') {
        f = ((now * 0.45 + l.phase * 7) % 1) < 0.06 ? 1 : 0;
      }
      // A stand-in sheet forged at another size is scaled to this one.
      const r = v.r * (sheet.px ? Math.min(FORGE_MAX_PX, px) / sheet.px : 1);
      g.drawImage(sheet.canvas, f * sheet.fw, 0, sheet.fw, sheet.fh,
        Math.round(sx - sheet.footX * r), Math.round(sy - sheet.footY * r), sheet.fw * r, sheet.fh * r);
    }
    while (pi < props.length) props[pi++].draw(g, v);
    g.imageSmoothingEnabled = prevSmooth;
    // Drop fully wilted plants now and then (not every frame).
    if (dead > 16) {
      for (const [key, l] of this.live) if (l.died !== null && now - l.died >= WILT_SECONDS) this.live.delete(key);
      this.order = this.order.filter(l => this.live.has(l.key));
    }
  }

  private sheetFor(l: Live, px: number, planetType: string, atlas: DecalAtlas | null, wilt: boolean): Sheet | null {
    const s = l.site, foot = s.foot!;
    const ur = (foot >> 16) & 255, ug = (foot >> 8) & 255, ub = foot & 255;
    const variant = Math.abs(Math.round(s.wx ?? s.x) * 7 + s.row * 31 + s.col * 17) % FLORA_VARIANTS;
    const forge = px >= FORGE_DECAL_MIN_PX;
    const mineral = isMineralKind(s.kind);
    // Ground matters for every atlas sprite (it is shaded from it) and for
    // forged stone; forged plants only get a light 12% pull toward it.
    const gk = forge && !mineral ? groundKey([ur, ug, ub]) : ((ur >> 3) << 10) | ((ug >> 3) << 5) | (ub >> 3);
    const pxk = Math.min(FORGE_MAX_PX, px);
    const season = SEASONAL_WORLDS.has(planetType) ? this.season : -1;
    const key = `${forge ? 'F' : 'A'}|${s.kind}|${variant}|${pxk}|${planetType}|${gk}|${wilt ? 1 : 0}|${season}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const look = `${s.kind}|${variant}|${planetType}|${gk}|${wilt ? 1 : 0}|${season}`;
    let rgba: { width: number; height: number; data: Uint8ClampedArray; footX: number; footY: number } | null = null;
    if (forge && this.forgesLeft > 0) {
      this.forgesLeft--;
      const f = forgeFlora(s.kind, variant, pxk, planetType, [ur, ug, ub]);
      // A light pull toward the ground keeps forged art in the planet's palette.
      const d = new Uint8ClampedArray(f.data);
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] !== 255) continue;
        d[i] = d[i] * 0.88 + ur * 0.12; d[i + 1] = d[i + 1] * 0.88 + ug * 0.12; d[i + 2] = d[i + 2] * 0.88 + ub * 0.12;
      }
      rgba = { width: f.width, height: f.height, data: d, footX: f.footX, footY: f.footY };
    } else if (forge) {
      // Out of forge budget this frame (a zoom changes every size at once):
      // the last forged sheet of this look stands in, scaled by the caller,
      // so plants sharpen in place instead of vanishing or swapping art.
      const prev = this.lastForged.get(look);
      if (prev) return prev;
      // Never forged yet: the atlas stands in until it is made.
      const tk = 'T' + key.slice(1);
      const t = this.cache.get(tk);
      if (t) return t;
      const a = atlasSprite(s, pxk, atlas, ur, ug, ub);
      if (!a) return null;
      const sheet = this.makeSheet(a, s.kind, wilt, season, variant);
      this.cache.set(tk, sheet);
      return sheet;
    } else {
      rgba = atlasSprite(s, pxk, atlas, ur, ug, ub);
    }
    if (!rgba) return null;
    const sheet = this.makeSheet(rgba, s.kind, wilt, season, variant);
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(key, sheet);
    if (forge) {
      sheet.px = pxk;
      if (this.lastForged.size >= CACHE_MAX) this.lastForged.clear();
      this.lastForged.set(look, sheet);
    }
    return sheet;
  }

  private makeSheet(
    src: { width: number; height: number; data: Uint8ClampedArray; footX: number; footY: number },
    kind: DecalKind, wilt: boolean, season = -1, variant = 0,
  ): Sheet {
    const data = src.data;
    if (season >= 0) seasonTint(src, kind, season, variant);
    if (wilt) {
      // Wilting: browned and dulled.
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
        data[i] = data[i] * 0.4 + (l * 0.7 + 52) * 0.6;
        data[i + 1] = data[i + 1] * 0.4 + (l * 0.55 + 30) * 0.6;
        data[i + 2] = data[i + 2] * 0.4 + (l * 0.35 + 12) * 0.6;
      }
    }
    const h = src.footY + 1;   // nothing below the foot sways
    const amp = swayOf(kind) * h;
    const twinkle = kind === 'crystal' || kind === 'ore';
    const mode: Sheet['mode'] = amp >= 0.5 ? 'sway' : twinkle ? 'twinkle' : 'still';
    const pad = mode === 'sway' ? Math.ceil(amp) + 1 : 0;
    const fw = src.width + pad * 2, fh = src.height;
    const frames = mode === 'sway' ? SWAY.length : mode === 'twinkle' ? 2 : 1;
    const out = new Uint8ClampedArray(fw * frames * fh * 4);
    const W = fw * frames;
    // Brightest pixels, for the twinkle frame.
    let hi = 255;
    if (mode === 'twinkle') {
      const lum: number[] = [];
      for (let i = 0; i < data.length; i += 4) if (data[i + 3]) lum.push(data[i] + data[i + 1] + data[i + 2]);
      lum.sort((a, b) => b - a);
      hi = lum[Math.max(0, Math.floor(lum.length * 0.06))] ?? 765;
    }
    for (let f = 0; f < frames; f++) {
      const sw = mode === 'sway' ? SWAY[f] : 0;
      for (let y = 0; y < src.height; y++) {
        const up = clamp((src.footY - y) / Math.max(1, src.footY), 0, 1);
        const off = Math.round(sw * amp * up * up);
        for (let x = 0; x < src.width; x++) {
          const si = (y * src.width + x) * 4;
          if (data[si + 3] === 0) continue;
          const X = f * fw + pad + x + off;
          const o = (y * W + X) * 4;
          let r = data[si], g = data[si + 1], b = data[si + 2];
          if (mode === 'twinkle' && f === 1 && r + g + b >= hi) { r = 255; g = 255; b = 240; }
          out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = data[si + 3];
        }
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = fh;
    const cg = canvas.getContext('2d');
    if (cg) {
      const img = cg.createImageData(W, fh);
      img.data.set(out);
      cg.putImageData(img, 0, 0);
    }
    return { canvas, fw, fh, frames, footX: src.footX + pad, footY: src.footY, mode };
  }
}

/**
 * The atlas sprite of a site at `px`, shaded from its ground exactly as the
 * old stamp did (shape and lit mask from the atlas, colour from the ground).
 * The crude procedural marker when there is no atlas yet.
 */
function atlasSprite(
  s: DecalSite, px: number, atlas: DecalAtlas | null, ur: number, ug: number, ub: number,
): { width: number; height: number; data: Uint8ClampedArray; footX: number; footY: number } | null {
  const mineral = isMineralKind(s.kind);
  const shade = (lit: number, o: Uint8ClampedArray, i: number) => {
    const m = 0.45 + (lit / 255) * 0.42;
    o[i] = ur * m + (mineral ? 8 : -12);
    o[i + 1] = ug * m + (mineral ? 8 : 34);
    o[i + 2] = ub * m + (mineral ? 10 : -10);
    o[i + 3] = 255;
  };
  const dest = Math.max(2, px);
  const data = new Uint8ClampedArray(dest * dest * 4);
  const fallback: Record<string, DecalKind> = { palm: 'broadleaf', bush: 'scrub', grass: 'scrub', mushroom: 'scrub', ore: 'rock', crystal: 'rock' };
  const row = atlas ? atlas.rows[s.kind] ?? atlas.rows[fallback[s.kind] ?? s.kind] : undefined;
  if (atlas && row !== undefined) {
    const cellN = atlas.cell;
    const variant = Math.abs(s.row * 31 + s.col * 17) % Math.max(1, atlas.variants);
    const sx0 = variant * cellN, sy0 = row * cellN;
    if (sx0 + cellN > atlas.width || sy0 + cellN > atlas.height) return null;
    const foot = Math.max(1, Math.round(2 * dest / cellN));
    for (let ay = 0; ay < dest; ay++) {
      const sy = Math.min(cellN - 1, (ay * cellN / dest) | 0);
      for (let ax = 0; ax < dest; ax++) {
        const sx = Math.min(cellN - 1, (ax * cellN / dest) | 0);
        const ao = ((sy0 + sy) * atlas.width + (sx0 + sx)) * 4;
        if (atlas.data[ao + 3] === 0) continue;
        shade(atlas.data[ao], data, (ay * dest + ax) * 4);
      }
    }
    return { width: dest, height: dest, data, footX: dest >> 1, footY: dest - foot };
  }
  // No atlas yet: a small marker, as the old stamp drew.
  const h = Math.min(dest, Math.round((isWoody(s.kind) || s.kind === 'cactus' ? 10 : 4) * s.scale * (px / 16) * 2 + 2));
  for (let i = 0; i < h; i++) {
    const hw = Math.max(0, Math.round((1 - i / h) * h * 0.4));
    for (let dx = -hw; dx <= hw; dx++) {
      const x = (dest >> 1) + dx, y = dest - 1 - i;
      if (x >= 0 && x < dest && y >= 0) shade(dx < 0 ? 210 : 70, data, (y * dest + x) * 4);
    }
  }
  return { width: dest, height: dest, data, footX: dest >> 1, footY: dest - 1 };
}
