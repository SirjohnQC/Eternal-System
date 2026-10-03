/**
 * Preview per-world vegetation baker packs + a creature marking strip.
 *
 *   npx esbuild tools/floraAdoptRender.ts --bundle --platform=node --format=esm \
 *     --outfile=%TEMP%/far.mjs && node %TEMP%/far.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { deflateSync } from 'zlib';
import { join } from 'path';
import { installSoftCanvas, SoftCanvas } from './lib/softCanvas';

installSoftCanvas();

const { bakeVegetationSprite, clearVegetationAtlasCache } = await import('../src/rendering/VegetationBaker');
const { FLORA_WORLDS } = await import('../src/rendering/VegetationWorlds');
const { dioramaCreatureSprite, clearSpriteCaches } = await import('../src/rendering/SpeciesSprite');
const { SeedRNG } = await import('../src/utils/SeedRNG');
const { initPlayerSpecies, stepEvolution } = await import('../src/simulation/EvolutionEngine');
const { DEFAULT_BIOSPHERE } = await import('../src/simulation/SpeciesGenome');
type SpeciesGenome = import('../src/simulation/SpeciesGenome').SpeciesGenome;
type DecalKind = import('../src/rendering/SurfaceDecals').DecalKind;

const OUT = join('renders', 'flora-adopt-2026-10-02');
const KINDS: DecalKind[] = ['conifer', 'broadleaf', 'scrub', 'cactus', 'rock'];
const GROUND: Record<string, [number, number, number]> = {
  ocean: [34, 72, 58], rocky: [72, 68, 58], ice: [48, 72, 88],
  lava: [48, 28, 24], toxic: [48, 40, 56], crystal: [52, 48, 72],
  desert: [120, 96, 58], storm: [40, 48, 56], carbon: [28, 28, 30],
};

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function writePng(path: string, w: number, h: number, rgba: Uint8ClampedArray): void {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4)
      .copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (tag: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const type = Buffer.from(tag);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([len, type, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

function up(src: Uint8ClampedArray, sw: number, sh: number, n: number) {
  const w = sw * n, h = sh * n, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const so = (((y / n) | 0) * sw + ((x / n) | 0)) * 4, o = (y * w + x) * 4;
    d[o] = src[so]; d[o + 1] = src[so + 1]; d[o + 2] = src[so + 2]; d[o + 3] = src[so + 3];
  }
  return { w, h, d };
}

clearVegetationAtlasCache();
clearSpriteCaches();
mkdirSync(OUT, { recursive: true });

const cell = 16, scale = 4, gap = 4, label = 14;
const rowH = label + cell * scale + gap;
const colW = (cell * scale + gap) * 3 + gap;
const W = gap + FLORA_WORLDS.length * colW;
const H = gap + KINDS.length * rowH;
const sheet = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < sheet.length; i += 4) {
  sheet[i] = 14; sheet[i + 1] = 12; sheet[i + 2] = 18; sheet[i + 3] = 255;
}

FLORA_WORLDS.forEach((world, wi) => {
  const gnd = GROUND[world] ?? [40, 40, 40];
  KINDS.forEach((kind, ki) => {
    for (let v = 0; v < 3; v++) {
      const spr = bakeVegetationSprite(kind, v, 16, world);
      const u = up(spr, cell, cell, scale);
      const bx = gap + wi * colW + v * (cell * scale + gap);
      const by = gap + ki * rowH + label;
      for (let y = 0; y < u.h; y++) for (let x = 0; x < u.w; x++) {
        const dx = bx + x, dy = by + y;
        if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
        const o = (dy * W + dx) * 4, so = (y * u.w + x) * 4;
        if (!u.d[so + 3]) {
          sheet[o] = gnd[0]; sheet[o + 1] = gnd[1]; sheet[o + 2] = gnd[2]; sheet[o + 3] = 255;
          continue;
        }
        sheet[o] = u.d[so]; sheet[o + 1] = u.d[so + 1]; sheet[o + 2] = u.d[so + 2]; sheet[o + 3] = 255;
      }
    }
  });
});
writePng(join(OUT, 'world_flora_baker.png'), W, H, sheet);

// Creature strip — diets show markings
const PHASES = ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'] as const;
let species = initPlayerSpecies(0, new SeedRNG('adopt_founder'));
let bio = { ...DEFAULT_BIOSPHERE };
let tick = 0;
const rng = new SeedRNG('adopt_evo');
for (const phase of PHASES) {
  for (let i = 0; i < 25; i++) {
    tick += 2000;
    const r = stepEvolution(phase, {}, species, bio, rng, tick, []);
    species = r.updatedSpecies; bio = r.updatedBiosphere;
  }
}
const living = species.filter(s => !s.isExtinct).slice(0, 24);
const cW = 48, cH = 48, cols = 8;
const cw = cols * cW, ch = Math.ceil(living.length / cols) * cH;
const creatures = new Uint8ClampedArray(cw * ch * 4);
for (let i = 0; i < creatures.length; i += 4) {
  creatures[i] = 36; creatures[i + 1] = 48; creatures[i + 2] = 28; creatures[i + 3] = 255;
}
living.forEach((g: SpeciesGenome, i: number) => {
  const cv = dioramaCreatureSprite(g, 'intelligent', 0.7, 4) as unknown as SoftCanvas;
  const n = Math.max(1, Math.floor(40 / Math.max(cv.width, cv.height)));
  const u = up(cv.data, cv.width, cv.height, n);
  const ox = (i % cols) * cW + ((cW - u.w) / 2 | 0);
  const oy = ((i / cols) | 0) * cH + ((cH - u.h) / 2 | 0);
  for (let y = 0; y < u.h; y++) for (let x = 0; x < u.w; x++) {
    const so = (y * u.w + x) * 4;
    if (!u.d[so + 3]) continue;
    const o = ((oy + y) * cw + (ox + x)) * 4;
    creatures[o] = u.d[so]; creatures[o + 1] = u.d[so + 1]; creatures[o + 2] = u.d[so + 2]; creatures[o + 3] = 255;
  }
});
writePng(join(OUT, 'creatures_markings.png'), cw, ch, creatures);

// Tree-zoom crowns for the habitable worlds — directional light lives here.
{
  const worlds = ['rocky', 'ocean', 'desert'] as const;
  const cell48 = 48, sc = 2, g48 = 6;
  const col = (cell48 * sc + g48) * 3;
  const W48 = g48 + worlds.length * col;
  const H48 = g48 + KINDS.length * (cell48 * sc + g48);
  const sheet48 = new Uint8ClampedArray(W48 * H48 * 4);
  for (let i = 0; i < sheet48.length; i += 4) {
    sheet48[i] = 18; sheet48[i + 1] = 22; sheet48[i + 2] = 16; sheet48[i + 3] = 255;
  }
  worlds.forEach((world, wi) => {
    const gnd = GROUND[world] ?? [40, 40, 40];
    KINDS.forEach((kind, ki) => {
      for (let v = 0; v < 3; v++) {
        const spr = bakeVegetationSprite(kind, v, 48, world);
        const u = up(spr, cell48, cell48, sc);
        const bx = g48 + wi * col + v * (cell48 * sc + g48);
        const by = g48 + ki * (cell48 * sc + g48);
        for (let y = 0; y < u.h; y++) for (let x = 0; x < u.w; x++) {
          const dx = bx + x, dy = by + y;
          if (dx < 0 || dy < 0 || dx >= W48 || dy >= H48) continue;
          const o = (dy * W48 + dx) * 4, so = (y * u.w + x) * 4;
          if (!u.d[so + 3]) {
            sheet48[o] = gnd[0]; sheet48[o + 1] = gnd[1]; sheet48[o + 2] = gnd[2]; sheet48[o + 3] = 255;
            continue;
          }
          sheet48[o] = u.d[so]; sheet48[o + 1] = u.d[so + 1]; sheet48[o + 2] = u.d[so + 2]; sheet48[o + 3] = 255;
        }
      }
    });
  });
  writePng(join(OUT, 'trees_z48.png'), W48, H48, sheet48);
}

console.log(`wrote ${OUT} (${FLORA_WORLDS.length} worlds, ${living.length} creatures)`);
