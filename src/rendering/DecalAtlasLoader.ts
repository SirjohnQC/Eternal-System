/**
 * Loads the decal atlas from public/assets. Returns null on any failure — the
 * renderer falls back to procedural markers rather than breaking the bake, so
 * a missing or corrupt asset degrades the picture instead of the game.
 */
import type { DecalAtlas, DecalKind } from './SurfaceDecals';

export async function loadDecalAtlas(
  base = 'assets/pixel/decals',
): Promise<DecalAtlas | null> {
  try {
    const manifest = await fetch(`${base}/decals.json`).then(r => r.json());
    const img = new Image();
    img.src = `${base}/${manifest.atlas}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const rows = {} as Record<DecalKind, number>;
    let variants = 1;
    for (const [kind, entry] of Object.entries(manifest.kinds) as Array<[DecalKind, any]>) {
      rows[kind] = entry.row;
      variants = Math.max(variants, entry.variants ?? 1);
    }
    return {
      cell: manifest.cell, rows, variants,
      data, width: canvas.width, height: canvas.height,
    };
  } catch {
    return null;
  }
}
