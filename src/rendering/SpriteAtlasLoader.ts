/**
 * Loads the SpriteCook sprite sheets (public/assets/sprites/<name>.png +
 * .json) into SpriteOverride. On by default (`?sprites=0` or Settings > ART turns them off). Any sheet
 * that fails to load is skipped: the forges draw what it would have covered.
 */
import { registerSheet, type SheetFrame } from './SpriteOverride';

const SHEETS = ['huts', 'medieval', 'trees', 'hive', 'dome', 'pod', 'spire', 'burrow', 'grown', 'carved', 'kit-walls', 'kit-roofs', 'kit-addons', 'islets', 'hangings', 'civic', 'industry', 'future', 'aircraft', 'skirt-earth', 'skirt-water',
  ...['humanoid', 'simian', 'reptilian', 'avian', 'insectoid', 'cephaloid', 'mycoid', 'crystalline'].map(f => `people-${f}`)];

/** The player's choice (Settings > ART), remembered between sessions. */
export const SPRITES_PREF = 'eternal_sprites';

/**
 * Hand-made sprites are on by default (playtest Oct 20: "use the new sprites
 * in the game"). `?sprites=0` / `?sprites=1` in the address wins (to compare);
 * otherwise the player's setting; otherwise on.
 */
export function spritesRequested(): boolean {
  const q = new URLSearchParams(location.search).get('sprites');
  if (q === '0' || q === '1') return q === '1';
  try { return localStorage.getItem(SPRITES_PREF) !== '0'; } catch { return true; }
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
