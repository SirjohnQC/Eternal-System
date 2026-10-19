/**
 * Loads the SpriteCook sprite sheets (public/assets/sprites/<name>.png +
 * .json) into SpriteOverride. Dev flag `?sprites=1` only for now. Any sheet
 * that fails to load is skipped: the forges draw what it would have covered.
 */
import { registerSheet, type SheetFrame } from './SpriteOverride';

const SHEETS = ['huts', 'medieval', 'trees', 'hive', 'dome', 'pod', 'spire', 'burrow', 'grown', 'carved', 'kit-walls', 'kit-roofs', 'kit-addons', 'islets', 'hangings', 'skirt-earth', 'skirt-water',
  ...['humanoid', 'simian', 'reptilian', 'avian', 'insectoid', 'cephaloid', 'mycoid', 'crystalline'].map(f => `people-${f}`)];

export function spritesRequested(): boolean {
  return new URLSearchParams(location.search).get('sprites') === '1';
}

async function loadSheet(base: string, name: string): Promise<void> {
  try {
    const manifest = await fetch(`${base}/${name}.json`).then(r => r.json()) as { frames: SheetFrame[] };
    const img = new Image();
    img.src = `${base}/${name}.png`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    registerSheet(name, { width: canvas.width, height: canvas.height, data, frames: manifest.frames });
  } catch {
    // Missing or corrupt sheet: the procedural art stays.
  }
}

export async function loadSpriteOverrides(base = 'assets/sprites'): Promise<void> {
  if (!spritesRequested()) return;
  await Promise.all(SHEETS.map(n => loadSheet(base, n)));
}
