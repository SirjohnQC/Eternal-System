/**
 * Preview the modular settlement baker vs tech ladder / env packs.
 *
 *   npx esbuild tools/settleBakerRender.ts --bundle --platform=node --format=esm \
 *     --outfile=%TEMP%/sbr_settle.mjs && node %TEMP%/sbr_settle.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { deflateSync } from 'zlib';
import { join } from 'path';
import { installSoftCanvas, SoftCanvas } from './lib/softCanvas';

installSoftCanvas();

const { bakeSettlementSprite, clearSpriteCaches } = await import('../src/rendering/SpeciesSprite');
type SpeciesGenome = import('../src/simulation/SpeciesGenome').SpeciesGenome;
type Environment = import('../src/simulation/SpeciesGenome').Environment;

const OUT = join('renders', 'settle-baker-2026-10-02');

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

function fromCanvas(cv: SoftCanvas): { w: number; h: number; d: Uint8ClampedArray } {
  return { w: cv.width, h: cv.height, d: cv.data };
}

function upscale(src: Uint8ClampedArray, sw: number, sh: number, n: number) {
  const w = sw * n, h = sh * n, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const so = (((y / n) | 0) * sw + ((x / n) | 0)) * 4, o = (y * w + x) * 4;
    d[o] = src[so]; d[o + 1] = src[so + 1]; d[o + 2] = src[so + 2]; d[o + 3] = src[so + 3];
  }
  return { w, h, d };
}

function onPad(
  spr: { w: number; h: number; d: Uint8ClampedArray },
  rgb: [number, number, number],
  pad = 3,
) {
  const W = spr.w + pad * 2, H = spr.h + pad * 2;
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4; d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
  }
  for (let y = 0; y < spr.h; y++) for (let x = 0; x < spr.w; x++) {
    const so = (y * spr.w + x) * 4;
    if (!spr.d[so + 3]) continue;
    const o = ((y + pad) * W + (x + pad)) * 4;
    d[o] = spr.d[so]; d[o + 1] = spr.d[so + 1]; d[o + 2] = spr.d[so + 2]; d[o + 3] = 255;
  }
  return { w: W, h: H, d };
}

function stub(env: Environment): SpeciesGenome {
  return {
    id: `settle-${env}`,
    name: env,
    originTick: 0,
    population: 1,
    isExtinct: false,
    ancestorId: null,
    dna: {
      locomotion: 'walking',
      metabolism: 'heterotrophic',
      environment: env,
      reproduction: 'sexual',
      diet: 'omnivore',
      respiration: 'aerobic',
      aggression: 3,
      intelligence: 5,
      social: 5,
      adaptability: 5,
    },
    physicalTraits: {
      size: 'medium',
      sensorySystem: 'eyes',
      bodyStructure: 'bilateral',
      mobilityType: 'legs',
    },
    habitat: { biome: 'temperate', temperatureRange: 'mild' },
    evolutionaryPotential: { landTransition: 1, intelligenceGrowth: 1, toolUse: 1 },
  };
}

function blit(
  dst: Uint8ClampedArray, dw: number,
  src: { w: number; h: number; d: Uint8ClampedArray },
  dx: number, dy: number,
): void {
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const so = (y * src.w + x) * 4;
    if (!src.d[so + 3]) continue;
    const o = ((dy + y) * dw + (dx + x)) * 4;
    dst[o] = src.d[so]; dst[o + 1] = src.d[so + 1];
    dst[o + 2] = src.d[so + 2]; dst[o + 3] = 255;
  }
}

const GND: Record<string, [number, number, number]> = {
  land: [52, 88, 48],
  coastal: [40, 72, 70],
  ocean: [30, 60, 90],
  deep_sea: [20, 36, 60],
  aerial: [48, 44, 64],
};

clearSpriteCaches();
mkdirSync(OUT, { recursive: true });

const SCALE = 3;
const GAP = 8;
const CELL = 130 * SCALE + 8; // 96px compound + cast-shadow pad

// Tech ladder — land
{
  const techs = [0, 2, 3, 4, 5, 7];
  const labels = ['hut', 'village', 'longhouse', 'tower/forge', 'town', 'metropolis'];
  const W = GAP + techs.length * (CELL + GAP);
  const H = 22 + CELL + GAP;
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4; d[o] = 14; d[o + 1] = 12; d[o + 2] = 18; d[o + 3] = 255;
  }
  const g = stub('land');
  for (let i = 0; i < techs.length; i++) {
    clearSpriteCaches();
    const spr = fromCanvas(bakeSettlementSprite(g, techs[i], i, 1) as unknown as SoftCanvas);
    const up = upscale(spr.d, spr.w, spr.h, SCALE);
    const cell = onPad(up, GND.land);
    blit(d, W, cell, GAP + i * (CELL + GAP), 18);
    writePng(join(OUT, `land_t${techs[i]}.png`), cell.w, cell.h, cell.d);
  }
  writePng(join(OUT, 'tech_ladder.png'), W, H, d);
  console.log('tech ladder', labels.join(' → '));
}

// Env packs at mid tech
{
  const envs: Environment[] = ['land', 'coastal', 'ocean', 'deep_sea', 'aerial'];
  const techs = [1, 4, 7];
  const cols = envs.length;
  const rows = techs.length;
  const W = GAP + cols * (CELL + GAP);
  const H = 22 + rows * (CELL + 16);
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4; d[o] = 14; d[o + 1] = 12; d[o + 2] = 18; d[o + 3] = 255;
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      clearSpriteCaches();
      const env = envs[c];
      const spr = fromCanvas(bakeSettlementSprite(stub(env), techs[r], c + r * 3, 1) as unknown as SoftCanvas);
      const up = upscale(spr.d, spr.w, spr.h, SCALE);
      const cell = onPad(up, GND[env] ?? GND.land);
      blit(d, W, cell, GAP + c * (CELL + GAP), 18 + r * (CELL + 16));
      writePng(join(OUT, `${env}_t${techs[r]}.png`), cell.w, cell.h, cell.d);
    }
  }
  writePng(join(OUT, 'env_sheet.png'), W, H, d);
}

console.log('wrote', OUT);

// Zoom LOD strip — opaque at every zoom. Capital blits near native width;
// this preview shows the compound itself, not a speck-shrunk ghost.
{
  const zooms = [1, 2, 4];
  const g = stub('land');
  const SHOW = 2;
  let maxW = 0, maxH = 0;
  const frames: Array<{ w: number; h: number; d: Uint8ClampedArray }> = [];
  for (const z of zooms) {
    clearSpriteCaches();
    const bakeScale = z >= 3 ? 4 : z >= 2 ? 2 : 1;
    const spr = fromCanvas(bakeSettlementSprite(g, 5, 0, bakeScale) as unknown as SoftCanvas);
    const up = upscale(spr.d, spr.w, spr.h, SHOW);
    const cell = onPad(up, GND.land, 4);
    frames.push(cell);
    maxW = Math.max(maxW, cell.w);
    maxH = Math.max(maxH, cell.h);
    writePng(join(OUT, `lod_z${z}.png`), cell.w, cell.h, cell.d);
  }
  const W = GAP + frames.length * (maxW + GAP);
  const H = 22 + maxH + GAP;
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4; d[o] = 14; d[o + 1] = 12; d[o + 2] = 18; d[o + 3] = 255;
  }
  frames.forEach((cell, i) => blit(d, W, cell, GAP + i * (maxW + GAP), 18));
  writePng(join(OUT, 'lod_strip.png'), W, H, d);
  console.log('lod strip z1 / z2 / z4 (opaque, native)');
}

// Two seeds, same tech and genome — style should match, skyline should not.
{
  const g = stub('land');
  const coast = stub('coastal');
  for (const seed of [3, 11]) {
    clearSpriteCaches();
    const land = fromCanvas(bakeSettlementSprite(g, 7, seed, 1) as unknown as SoftCanvas);
    const up = upscale(land.d, land.w, land.h, SCALE);
    const cell = onPad(up, GND.land);
    writePng(join(OUT, `land_t7_s${seed}.png`), cell.w, cell.h, cell.d);
    clearSpriteCaches();
    const port = fromCanvas(bakeSettlementSprite(coast, 7, seed, 1) as unknown as SoftCanvas);
    const upC = upscale(port.d, port.w, port.h, SCALE);
    const cellC = onPad(upC, GND.coastal);
    writePng(join(OUT, `coastal_t7_s${seed}.png`), cellC.w, cellC.h, cellC.d);
  }
  console.log('seed pair land/coastal t7 @ 3 and 11');
}

