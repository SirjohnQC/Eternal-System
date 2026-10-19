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
function frameAt(sheetName: string, sheet: Sheet, fi: number, tw: number): OverrideSprite {
  const key = `${sheetName}:${fi}:${tw}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const f = sheet.frames[fi];
  const W = Math.max(2, Math.min(f.w, tw));
  const H = Math.max(2, Math.round(f.h * W / f.w));
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
  const s: OverrideSprite = { width: W, height: H, data: out, footX: Math.floor(W / 2), footY: H - 1 };
  cache.set(key, s);
  return s;
}

function pick(sheetName: string, tags: string[], seed: number, tw: number): OverrideSprite | null {
  const sheet = sheets.get(sheetName);
  if (!sheet) return null;
  const idx: number[] = [];
  sheet.frames.forEach((f, i) => { if (tags.includes(f.tag)) idx.push(i); });
  if (!idx.length) return null;
  return frameAt(sheetName, sheet, idx[(seed >>> 0) % idx.length], tw);
}

/** Era 0–1 use the primitive sheet, 2–3 the medieval one; later eras stay procedural. */
export function buildingOverride(b: Building, S: number, era: number): OverrideSprite | null {
  if (!sheets.size) return null;
  const tw = Math.max(3, Math.round(b.w * S * 1.35));
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
      case 'row': case 'block': case 'ziggurat': return pick('medieval', ['hall', 'timber'], b.seed, tw);
      default: return pick('medieval', ['timber', 'stone'], b.seed, tw);
    }
  }
  return null;
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
