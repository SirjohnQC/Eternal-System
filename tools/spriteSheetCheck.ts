/**
 * Sprite sheets (public/assets/sprites): every sheet the loader asks for has
 * a PNG and a JSON, every frame lies inside its PNG, carries a tag the
 * override picks by, and is not empty.
 *
 *   npx esbuild tools/spriteSheetCheck.ts --bundle --platform=node --format=esm --packages=external \
 *     --outfile=.cache/spriteSheetCheck.mjs --log-level=error && node .cache/spriteSheetCheck.mjs
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const DIR = 'public/assets/sprites';
const SHEETS = ['huts', 'medieval', 'trees', 'hive', 'dome', 'pod', 'spire', 'burrow', 'grown', 'carved', 'kit-walls', 'kit-roofs', 'kit-addons', 'islets', 'hangings', 'sun', 'skirt-earth', 'skirt-water',
  ...['humanoid', 'simian', 'reptilian', 'avian', 'insectoid', 'cephaloid', 'mycoid', 'crystalline'].map(f => `people-${f}`)];
let failed = 0;
const fail = (m: string) => { console.error('FAIL ' + m); failed++; };

for (const name of SHEETS) {
  const png = PNG.sync.read(readFileSync(`${DIR}/${name}.png`));
  const { frames } = JSON.parse(readFileSync(`${DIR}/${name}.json`, 'utf8')) as {
    frames: Array<{ x: number; y: number; w: number; h: number; tag?: string }>;
  };
  if (!frames.length) fail(`${name}: no frames`);
  frames.forEach((f, i) => {
    if (f.x < 0 || f.y < 0 || f.x + f.w > png.width || f.y + f.h > png.height) fail(`${name}[${i}] outside the PNG`);
    if (!f.tag) fail(`${name}[${i}] has no tag`);
    let opaque = 0;
    for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) if (png.data[(y * png.width + x) * 4 + 3] > 127) opaque++;
    if (opaque < f.w * f.h * 0.15) fail(`${name}[${i}] is nearly empty`);
  });
  console.log(`ok   ${name}: ${frames.length} frames`);
}
if (failed) process.exit(1);
console.log('sprite sheet checks passed');
