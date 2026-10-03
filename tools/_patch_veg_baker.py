"""Patch VegetationBaker to use per-world packs from VegetationWorlds."""
from pathlib import Path

p = Path('src/rendering/VegetationBaker.ts')
t = p.read_text(encoding='utf-8')

# Keep from hash2 onward (utilities after GRIDS)
marker = 'function hash2('
idx = t.find(marker)
assert idx > 0
rest = t[idx:]

# Rewrite rest: paint16, isFoliage, refine, atlas, bake
# Find rebuildTrunk start - keep rebuildTrunk as-is until refine
rt = rest.find('function rebuildTrunk(')
assert rt > 0
# Find refine
rf = rest.find('function refine(')
assert rf > rt
# Keep hash2..end of rebuildTrunk (before refine)
before_refine = rest[:rf]
# Replace paint16 to use pack - it's before rebuildTrunk
# before_refine starts with hash2, includes paint16, upscale, put, ramp, ellipse, isBark, isFoliage, rebuildTrunk

# Replace paint16 and isFoliage in before_refine
old_paint = '''function paint16(kind: DecalKind, variant: number): Uint8ClampedArray {
  const { pal, rows } = GRIDS[kind];
'''
new_paint = '''function paint16(kind: DecalKind, variant: number, pack: WorldPack): Uint8ClampedArray {
  const { pal, rows } = pack[kind];
'''
if old_paint not in before_refine:
    raise SystemExit('paint16 not found')
before_refine = before_refine.replace(old_paint, new_paint)

old_fol = '''function isFoliage(r: number, g: number, b: number, a: number): boolean {
  return a > 0 && g > r + 6 && g > b;
}'''
new_fol = '''/** Non-bark mass — works for purple toxic / cyan crystal / ember canopies. */
function isFoliage(r: number, g: number, b: number, a: number): boolean {
  return a > 0 && !isBark(r, g, b, a);
}'''
if old_fol not in before_refine:
    raise SystemExit('isFoliage not found')
before_refine = before_refine.replace(old_fol, new_fol)

# Hole-fill used green check - update in refine below
new_tail = r'''
function refine(kind: DecalKind, variant: number, cell: number, pack: WorldPack): Uint8ClampedArray {
  const base = paint16(kind, variant, pack);
  if (cell === 16) return base;
  const px = upscaleNN(base, 16, cell);
  const pal = pack[kind].pal;
  const w = cell, h = cell;

  // Close 1px canopy holes that become wounds when fattened.
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4;
      if (px[o + 3]) continue;
      let nfol = 0;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const p = ((y + dy) * w + (x + dx)) * 4;
        if (px[p + 3] && isFoliage(px[p], px[p + 1], px[p + 2], px[p + 3])) nfol++;
      }
      if (nfol >= 3) {
        const c = pal.m;
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
      }
    }
  }

  if (kind === 'broadleaf' && cell >= 32) {
    const ox = w / 2 + (cell === 32 ? 7 : 11);
    const oy = h / 3 + 2;
    ellipse(px, w, h, ox, oy, cell === 32 ? 4.2 : 6.5, cell === 32 ? 3.4 : 5.2,
      pal, 'dsmlhe', 50 + variant, cell >= 48);
  }
  if (kind === 'conifer' && cell >= 32) {
    ellipse(px, w, h, w / 2, (h * 0.52) | 0, cell === 32 ? 6 : 8, cell === 32 ? 2.8 : 3.8,
      pal, 'dsmlhe', 60 + variant, cell >= 48);
  }

  rebuildTrunk(px, w, h, pal, kind, variant, cell);

  if (cell >= 48) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (!isFoliage(px[o], px[o + 1], px[o + 2], px[o + 3])) continue;
      if (hash2(x, y, 19) > 0.84) {
        const c = pal.s ?? pal.m;
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
      }
    }
    if (kind === 'broadleaf' && variant === 1 && pal.b) {
      for (const [bx, by] of [[w / 2 - 4, h / 3], [w / 2 + 5, h / 3 + 3], [w / 2 + 1, h / 3 - 4]] as const) {
        const o = ((by | 0) * w + (bx | 0)) * 4;
        if (px[o + 3] && isFoliage(px[o], px[o + 1], px[o + 2], px[o + 3])) {
          px[o] = pal.b[0]; px[o + 1] = pal.b[1]; px[o + 2] = pal.b[2];
        }
      }
    }
  }
  return px;
}

function atlasFromCells(cell: number, pack: WorldPack): DecalAtlas {
  const cols = VARIANTS, rowsN = KINDS.length;
  const width = cell * cols, height = cell * rowsN;
  const data = new Uint8ClampedArray(width * height * 4);
  const rows = {} as Record<DecalKind, number>;
  KINDS.forEach((kind, row) => {
    rows[kind] = row;
    for (let v = 0; v < VARIANTS; v++) {
      const spr = refine(kind, v, cell, pack);
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        const so = (y * cell + x) * 4;
        const o = ((row * cell + y) * width + (v * cell + x)) * 4;
        data[o] = spr[so]; data[o + 1] = spr[so + 1]; data[o + 2] = spr[so + 2]; data[o + 3] = spr[so + 3];
      }
    }
  });
  return { cell, rows, variants: VARIANTS, data, width, height, color: true };
}

const atlasCache = new Map<string, DecalAtlas>();

/**
 * Bake the full vegetation set for a world type: planet (16), grove (32), tree (48).
 * Cached per world — swapping planets only rebakes once.
 */
export function bakeVegetationAtlasSet(world: HabitableType | string = 'rocky'): DecalAtlas {
  const key = String(world || 'rocky');
  const hit = atlasCache.get(key);
  if (hit) return hit;
  const pack = getWorldPack(key);
  const a16 = atlasFromCells(16, pack);
  a16.lod32 = atlasFromCells(32, pack);
  a16.lod48 = atlasFromCells(48, pack);
  atlasCache.set(key, a16);
  return a16;
}

/** Drop cached atlases (tests / hot-reload). */
export function clearVegetationAtlasCache(): void {
  atlasCache.clear();
}

/** Pick the LOD atlas for a camera stamp scale (`round(zoom)`). */
export function atlasForScale(root: DecalAtlas | null, scale: number): { atlas: DecalAtlas | null; fat: number } {
  if (!root) return { atlas: null, fat: Math.max(1, Math.round(scale)) };
  const S = Math.max(1, Math.round(scale));
  if (!root.color) return { atlas: root, fat: S };
  if (S >= 3 && root.lod48) {
    return { atlas: root.lod48, fat: Math.max(1, Math.round((S * 16) / root.lod48.cell)) };
  }
  if (S >= 2 && root.lod32) {
    return { atlas: root.lod32, fat: Math.max(1, Math.round((S * 16) / root.lod32.cell)) };
  }
  return { atlas: root, fat: S };
}

/** Test / preview: one sprite's RGBA for a world pack. */
export function bakeVegetationSprite(
  kind: DecalKind, variant: number, cell: 16 | 32 | 48 = 16,
  world: HabitableType | string = 'rocky',
): Uint8ClampedArray {
  return refine(kind, variant, cell, getWorldPack(world));
}
'''

header = '''/**
 * Procedural vegetation sprites for the diorama surface.
 *
 * Per-world flora packs (VegetationWorlds) supply silhouette + palette.
 * Authored at planet zoom (16×16), refined for grove (32) and tree (48).
 * Placement stays in SurfaceDecals.planSurfaceDecals; this module only draws.
 */
import type { DecalAtlas, DecalKind } from './SurfaceDecals';
import type { HabitableType } from './HabitableCutawayEngine';
import { getWorldPack, type WorldPack, type RGBA } from './VegetationWorlds';

const KINDS: DecalKind[] = ['conifer', 'broadleaf', 'scrub', 'cactus', 'rock'];
const VARIANTS = 3;

'''

out = header + before_refine + new_tail
p.write_text(out, encoding='utf-8')
print('wrote', p, 'lines', out.count(chr(10))+1)
