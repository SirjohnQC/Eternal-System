/**
 * SpriteOverride — hand-made sprite sheets (SpriteCook) standing in for the
 * procedural forges, behind the dev flag `?sprites=1`
 * (docs/plans/2026-10-19-art-pipeline.md).
 *
 * Pure: the sheets arrive already decoded (SpriteAtlasLoader does the DOM
 * part), and every lookup returns null when no sheet covers the request, so
 * the forge's own drawing is always the fallback.
 *
 * Sprites are painted larger than the game shows them and shrunk with an
 * area filter (alpha-weighted colour, hard alpha cut), cached per frame and
 * target width.
 */
import type { Building } from './SettlementPlan';

export interface SheetFrame { x: number; y: number; w: number; h: number; tag: string }
export interface Sheet { width: number; height: number; data: Uint8ClampedArray; frames: SheetFrame[] }

export interface OverrideSprite {
  width: number; height: number; data: Uint8ClampedArray;
  footX: number; footY: number;
}

const sheets = new Map<string, Sheet>();
const cache = new Map<string, OverrideSprite>();

export function registerSheet(name: string, sheet: Sheet): void {
  sheets.set(name, sheet);
  cache.clear();
}

export function spriteOverridesActive(): boolean {
  return sheets.size > 0;
}

/** Shrink (or keep) one frame to `tw` px wide; the foot is its bottom centre. */
function frameAt(sheetName: string, sheet: Sheet, fi: number, tw: number, tint?: Tint, th?: number): OverrideSprite {
  const key = `${sheetName}:${fi}:${tw}:${th ?? ''}:${tint ? `${Math.round(tint.hue)}:${tint.sat.toFixed(2)}` : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const f = sheet.frames[fi];
  const W = Math.max(2, Math.min(f.w, tw));
  const H = Math.max(2, th ?? Math.round(f.h * W / f.w));
  const out = new Uint8ClampedArray(W * H * 4);
  const sx = f.w / W, sy = f.h / H;
  for (let y = 0; y < H; y++) {
    const y0 = f.y + y * sy, y1 = y0 + sy;
    for (let x = 0; x < W; x++) {
      const x0 = f.x + x * sx, x1 = x0 + sx;
      let r = 0, g = 0, b = 0, a = 0, area = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        const wy = Math.min(y1, py + 1) - Math.max(y0, py);
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const wx = Math.min(x1, px + 1) - Math.max(x0, px);
          const w = wx * wy;
          const i = (py * sheet.width + px) * 4;
          const al = sheet.data[i + 3] / 255 * w;
          r += sheet.data[i] * al; g += sheet.data[i + 1] * al; b += sheet.data[i + 2] * al;
          a += al; area += w;
        }
      }
      const o = (y * W + x) * 4;
      if (a / area < 0.45) continue;
      out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = 255;
    }
  }
  if (tint) recolour(out, sheet, f, tint);
  const s: OverrideSprite = { width: W, height: H, data: out, footX: Math.floor(W / 2), footY: H - 1 };
  cache.set(key, s);
  return s;
}

function pick(sheetName: string, tags: string[], seed: number, tw: number, tint?: Tint): OverrideSprite | null {
  const sheet = sheets.get(sheetName);
  if (!sheet) return null;
  const idx: number[] = [];
  sheet.frames.forEach((f, i) => { if (tags.includes(f.tag)) idx.push(i); });
  if (!idx.length) return null;
  return frameAt(sheetName, sheet, idx[(seed >>> 0) % idx.length], tw, tint);
}


/** A species' own material colour: the sprite's main hue turns to `hue`. */
export interface Tint { hue: number; sat: number }

function toHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const mainHue = new Map<string, number>();

/** Saturation-weighted circular mean hue of a frame (its material colour). */
function frameHue(sheet: Sheet, f: SheetFrame): number {
  const key = `${f.x},${f.y},${sheet.width}`;
  const hit = mainHue.get(key);
  if (hit !== undefined) return hit;
  let sx = 0, sy = 0;
  for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) {
    const i = (y * sheet.width + x) * 4;
    if (sheet.data[i + 3] < 128) continue;
    const [h, s, l] = toHsl(sheet.data[i], sheet.data[i + 1], sheet.data[i + 2]);
    const w = s * (1 - Math.abs(l - 0.5) * 2);
    sx += Math.cos(h * Math.PI / 180) * w; sy += Math.sin(h * Math.PI / 180) * w;
  }
  const h = (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
  mainHue.set(key, h);
  return h;
}

/**
 * Turn the sprite's main hue to the species' material. Lit windows and glows
 * (bright and saturated) keep their light; greys and outlines barely move.
 */
function recolour(px: Uint8ClampedArray, sheet: Sheet, f: SheetFrame, t: Tint): void {
  const dh = t.hue - frameHue(sheet, f);
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3]) continue;
    const [h, s, l] = toHsl(px[i], px[i + 1], px[i + 2]);
    if (l > 0.72 && s > 0.5) continue;
    const k = Math.min(1, s * 3);
    const nh = (h + dh * k + 720) % 360;
    const ns = s * (1 - 0.5 * k) + t.sat * 0.5 * k;
    const [r, g, b] = fromHsl(nh, ns, l);
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  }
}

/**
 * A people's walk cycle from its hand-made sheet (`people-<form>`: frames
 * cropped to one shared box), `n` frames picked evenly round the loop, about
 * `targetH` px tall, recoloured to the species. Null without a sheet: the
 * forge draws the people.
 */
export function peopleFrames(form: string, tint: Tint | undefined, targetH: number, n: number): OverrideSprite[] | null {
  const name = `people-${form}`, sheet = sheets.get(name);
  if (!sheet || !sheet.frames.length) return null;
  const f0 = sheet.frames[0];
  const H = Math.max(4, Math.min(f0.h, Math.round(targetH)));
  const W = Math.max(2, Math.round(f0.w * H / f0.h));
  return Array.from({ length: Math.max(1, n) }, (_, k) =>
    frameAt(name, sheet, Math.floor(k * sheet.frames.length / Math.max(1, n)), W, tint, H));
}

/** Species architecture families with their own sheets (Architecture.ts ShapeFamily, minus 'box'). */
const FAMILIES = new Set(['hive', 'dome', 'pod', 'spire', 'burrow', 'grown', 'carved']);

/**
 * Species families use their own sheet (row by age, recoloured by `tint`);
 * box builders use the primitive sheet in era 0–1 and the medieval one in
 * 2–3; later box eras stay procedural.
 */
export function buildingOverride(b: Building, S: number, era: number, tint?: Tint): OverrideSprite | null {
  if (!sheets.size) return null;
  const tw = Math.max(3, Math.round(b.w * S * 1.35));
  // A species' own shape family: its sheet, the row for its age, its colour.
  if (FAMILIES.has(b.kind) && sheets.has(b.kind)) {
    const age = era <= 1 ? 'age0' : era <= 4 ? 'age1' : 'age2';
    return pick(b.kind, [age], b.seed, tw, tint);
  }
  if (era <= 1) {
    if (b.stilts) return pick('huts', ['stilts'], b.seed, tw);
    switch (b.kind) {
      case 'hut': return pick('huts', ['round', 'tent'], b.seed, tw);
      case 'adobe': case 'block': case 'ziggurat': return pick('huts', ['adobe'], b.seed, tw);
      case 'church': case 'keep': case 'tower': case 'spire': case 'dome': return pick('huts', ['shrine'], b.seed, tw);
      default: return pick('huts', ['long', 'gable'], b.seed, tw);
    }
  }
  if (era <= 3) {
    switch (b.kind) {
      case 'church': case 'spire': case 'dome': return pick('medieval', ['chapel'], b.seed, tw);
      case 'keep': case 'tower': return pick('medieval', ['tower'], b.seed, tw);
      case 'mill': return pick('medieval', ['mill'], b.seed, tw);
      case 'ziggurat': return pick('medieval', ['hall'], b.seed, tw);
      default: return composeBox(b, tw) ?? pick('medieval', ['timber', 'stone'], b.seed, tw);
    }
  }
  if (era === 4 && b.kind !== 'tower' && b.kind !== 'spire' && b.kind !== 'dome') return composeBox(b, tw);
  return null;
}

// ── Modular box buildings: wall + roof + add-on (kit-* sheets) ──────────────

function hash2(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Frame indices of a sheet carrying one of `tags`. */
function framesTagged(sheet: Sheet, tags: string[]): number[] {
  const out: number[] = [];
  sheet.frames.forEach((f, i) => { if (tags.includes(f.tag)) out.push(i); });
  return out;
}

/** Copy `src` onto `dst` at (x, y), opaque pixels only. */
function stamp(dst: OverrideSprite, src: OverrideSprite, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const si = (sy * src.width + sx) * 4;
      if (!src.data[si + 3]) continue;
      const di = (dy * dst.width + dx) * 4;
      dst.data[di] = src.data[si]; dst.data[di + 1] = src.data[si + 1]; dst.data[di + 2] = src.data[si + 2]; dst.data[di + 3] = 255;
    }
  }
}

/**
 * A gable roof is drawn open underneath: a dark hollow above its eaves. Fill
 * it with the wall's own colour (the gable end), flood-filling from the
 * middle of the eave line through dark pixels.
 */
function fillGable(roof: OverrideSprite, wallRGB: [number, number, number]): OverrideSprite {
  const { width: W, height: H } = roof;
  const out: OverrideSprite = { ...roof, data: new Uint8ClampedArray(roof.data) };
  const dark = (i: number) => out.data[i * 4 + 3] > 0 && out.data[i * 4] + out.data[i * 4 + 1] + out.data[i * 4 + 2] < 150;
  let start = -1;
  const cx = Math.floor(W / 2);
  for (let y = H - 2; y >= Math.floor(H * 0.55); y--) if (dark(y * W + cx)) { start = y * W + cx; break; }
  if (start < 0) return roof;
  const seen = new Uint8Array(W * H), stack = [start];
  let n = 0;
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i] || !dark(i)) continue;
    seen[i] = 1; n++;
    const x = i % W, y = (i - x) / W;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - W);
    if (y < H - 1) stack.push(i + W);
  }
  // A thin dark line is the outline, not a hollow.
  if (n < W * H * 0.04) return roof;
  for (let i = 0; i < W * H; i++) {
    if (!seen[i]) continue;
    const x = i % W, y = (i - x) / W;
    // Keep a 1-px dark edge where the hollow meets the roof, so the gable reads.
    const edge = (x > 0 && !seen[i - 1]) || (x < W - 1 && !seen[i + 1]) || (y > 0 && !seen[i - W]);
    const k = edge ? 0.55 : 0.88;
    out.data[i * 4] = wallRGB[0] * k; out.data[i * 4 + 1] = wallRGB[1] * k; out.data[i * 4 + 2] = wallRGB[2] * k;
  }
  return out;
}

/** Mean colour of the middle band of a wall (its material). */
function wallColour(w: OverrideSprite): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.floor(w.height * 0.3); y < Math.floor(w.height * 0.6); y++) for (let x = 0; x < w.width; x++) {
    const i = (y * w.width + x) * 4;
    if (!w.data[i + 3]) continue;
    r += w.data[i]; g += w.data[i + 1]; b += w.data[i + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : [180, 160, 130];
}

/**
 * A box building assembled from parts. A town picks two walls and two roofs
 * of its own (so a town looks of a piece and towns differ), each house one
 * of those plus, sometimes, an add-on on the roof or at the door. Landmark
 * kinds get the cone, dome or parapet roofs.
 */
function composeBox(b: Building, tw: number): OverrideSprite | null {
  const wallsS = sheets.get('kit-walls'), roofsS = sheets.get('kit-roofs');
  if (!wallsS || !roofsS) return null;
  const key = `box:${b.town}:${b.seed}:${b.kind}:${tw}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const walls = framesTagged(wallsS, ['wall']);
  const landmark = b.kind === 'church' || b.kind === 'keep' || b.kind === 'tower' || b.kind === 'mill';
  const roofs = framesTagged(roofsS, landmark ? ['cone', 'dome', 'flat'] : ['gable']);
  if (!walls.length || !roofs.length) return null;
  const t = hash2(b.town + 1, 0x51ed);
  const townWalls = [walls[t % walls.length], walls[(t >>> 8) % walls.length]];
  const townRoofs = [roofs[(t >>> 4) % roofs.length], roofs[(t >>> 12) % roofs.length]];
  const h = hash2(b.seed, b.town);
  const wallW = Math.max(3, Math.round(tw / 1.18));
  const wall = frameAt('kit-walls', wallsS, townWalls[h & 1], wallW);
  // Roofs are drawn tall; on a house they sit at about the wall's height
  // (towers keep their tall caps).
  const ri = townRoofs[(h >>> 1) & 1];
  const rw = landmark ? Math.round(wallW * 1.05) : tw;
  const rf = roofsS.frames[ri];
  const rh = landmark ? undefined : Math.max(2, Math.round(Math.min(rf.h * rw / rf.w, wall.height * 0.95)));
  let roof = frameAt('kit-roofs', roofsS, ri, rw, undefined, rh);
  roof = fillGable(roof, wallColour(wall));
  // Seat the roof over the wall's top rim.
  const seat = Math.round(wall.height * 0.18);
  const top = Math.max(0, roof.height - seat);
  let W = Math.max(wall.width, roof.width), H = wall.height + top;
  // Add-on: on the roof (chimney, vane, bell) or beside the door (barrel, crates…).
  const addS = sheets.get('kit-addons');
  let add: OverrideSprite | null = null, onRoof = false, right = false;
  if (addS && ((h >>> 3) % 100) < 55) {
    const adds = framesTagged(addS, ['roof', 'ground']);
    const ai = adds[(h >>> 9) % adds.length];
    onRoof = addS.frames[ai].tag === 'roof';
    right = ((h >>> 5) & 1) === 1;
    add = frameAt('kit-addons', addS, ai, Math.max(2, Math.round(wallW * (onRoof ? 0.28 : 0.32))));
    if (!onRoof) W += add.width;
    else H += Math.max(0, Math.round(add.height * 0.6) - Math.round(roof.height * 0.2));
  }
  const out: OverrideSprite = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4), footX: 0, footY: H - 1 };
  const wx = Math.floor((W - wall.width) / 2) - (add && !onRoof ? (right ? Math.floor(add.width / 2) : -Math.floor(add.width / 2)) : 0);
  stamp(out, wall, wx, H - wall.height);
  const rx = wx + Math.floor((wall.width - roof.width) / 2), ry = H - wall.height - top;
  if (add && onRoof) {
    // Behind the roof's ridge line, poking out of it.
    stamp(out, add, rx + Math.round(roof.width * (right ? 0.62 : 0.2)), ry - Math.round(add.height * 0.6) + Math.round(roof.height * 0.2));
  }
  stamp(out, roof, rx, ry);
  if (add && !onRoof) stamp(out, add, right ? wx + wall.width - 1 : wx - add.width + 1, H - add.height);
  out.footX = wx + Math.floor(wall.width / 2);
  cache.set(key, out);
  return out;
}

/** Worlds whose foliage the temperate sheet fits; elsewhere the forge keeps its hues. */
const TEMPERATE = new Set(['rocky', 'ocean']);

export function floraOverride(kind: string, variant: number, px: number, planetType: string): OverrideSprite | null {
  if (!sheets.size || !TEMPERATE.has(planetType)) return null;
  const tw = Math.max(3, Math.round(px * 0.9));
  switch (kind) {
    case 'conifer': return pick('trees', ['conifer'], variant, tw);
    case 'broadleaf': return pick('trees', ['broadleaf'], variant, tw);
    case 'bush': return pick('trees', ['bush'], variant, tw);
    default: return null;
  }
}
