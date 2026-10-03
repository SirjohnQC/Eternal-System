/**
 * Preview the creature baker at zoom LODs 1 / 2 / 4.
 *
 *   npx esbuild tools/speciesBakerRender.ts --bundle --platform=node --format=esm \
 *     --outfile=%TEMP%/sbr.mjs && node %TEMP%/sbr.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { deflateSync } from 'zlib';
import { join } from 'path';
import { installSoftCanvas, SoftCanvas } from './lib/softCanvas';

installSoftCanvas();

const { SeedRNG } = await import('../src/utils/SeedRNG');
const { initPlayerSpecies, stepEvolution } = await import('../src/simulation/EvolutionEngine');
const { DEFAULT_BIOSPHERE } = await import('../src/simulation/SpeciesGenome');
const { dioramaCreatureSprite, clearSpriteCaches } = await import('../src/rendering/SpeciesSprite');
type SpeciesGenome = import('../src/simulation/SpeciesGenome').SpeciesGenome;

const OUT = join('renders', 'species-baker-2026-10-01');

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

function onGrass(
  spr: { w: number; h: number; d: Uint8ClampedArray },
  pad = 2,
  alpha = 1,
) {
  const W = spr.w + pad * 2, H = spr.h + pad * 2;
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4; d[o] = 42; d[o + 1] = 78; d[o + 2] = 48; d[o + 3] = 255;
  }
  for (let y = 0; y < spr.h; y++) for (let x = 0; x < spr.w; x++) {
    const so = (y * spr.w + x) * 4;
    if (!spr.d[so + 3]) continue;
    const o = ((y + pad) * W + (x + pad)) * 4;
    const a = Math.max(0, Math.min(1, alpha));
    d[o] = Math.round(spr.d[so] * a + d[o] * (1 - a));
    d[o + 1] = Math.round(spr.d[so + 1] * a + d[o + 1] * (1 - a));
    d[o + 2] = Math.round(spr.d[so + 2] * a + d[o + 2] * (1 - a));
    d[o + 3] = 255;
  }
  return { w: W, h: H, d };
}

/** Matches SpeciesSprite.creaturePlanetAlpha — readable, still secondary. */
function planetAlpha(z: number): number {
  if (z <= 1) return 0.82;
  if (z === 2) return 0.94;
  return 1;
}

function pickDiverse(living: SpeciesGenome[]): SpeciesGenome[] {
  const byLoco = new Map<string, SpeciesGenome>();
  for (const sp of living) {
    if (sp.isExtinct) continue;
    const k = sp.dna.locomotion;
    const prev = byLoco.get(k);
    if (!prev || (CREATURE_SIZE_RANK[sp.physicalTraits.size] ?? 0) > (CREATURE_SIZE_RANK[prev.physicalTraits.size] ?? 0)) {
      byLoco.set(k, sp);
    }
  }
  return [...byLoco.values()];
}

const CREATURE_SIZE_RANK: Record<string, number> = {
  microscopic: 0, tiny: 1, small: 2, medium: 3, large: 4, massive: 5,
};

clearSpriteCaches();
mkdirSync(OUT, { recursive: true });

const PHASES = ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'] as const;

// Evolve a few worlds until we have walkers/swimmers/etc.
const picked: SpeciesGenome[] = [];
for (let seed = 1; seed <= 40 && picked.length < 8; seed++) {
  const rng = new SeedRNG(`sbr_${seed}`);
  let species = initPlayerSpecies(0, new SeedRNG(`founder_sbr_${seed}`));
  let bio = { ...DEFAULT_BIOSPHERE };
  let tick = 0;
  for (const phase of PHASES) {
    for (let i = 0; i < 20; i++) {
      tick += 2000;
      const r = stepEvolution(phase, {}, species, bio, rng, tick, []);
      species = r.updatedSpecies; bio = r.updatedBiosphere;
    }
  }
  for (const sp of pickDiverse(species)) {
    if (!picked.some(p => p.dna.locomotion === sp.dna.locomotion)) picked.push(sp);
  }
}

const zooms = [1, 2, 4] as const;
const viewScale = [8, 5, 3];
const pad = 10;
const rowH = 80;
const colW = 90;
const W = pad * 2 + zooms.length * colW + 40;
const H = pad * 2 + 20 + picked.length * rowH;
const sheet = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < sheet.length; i += 4) { sheet[i] = 12; sheet[i + 1] = 10; sheet[i + 2] = 16; sheet[i + 3] = 255; }

function blit(dst: Uint8ClampedArray, dw: number, src: { w: number; h: number; d: Uint8ClampedArray }, x: number, y: number) {
  for (let yy = 0; yy < src.h; yy++) for (let xx = 0; xx < src.w; xx++) {
    const dx = x + xx, dy = y + yy;
    if (dx < 0 || dy < 0 || dx >= dw || dy >= H) continue;
    const o = (dy * dw + dx) * 4, so = (yy * src.w + xx) * 4;
    if (!src.d[so + 3]) continue;
    dst[o] = src.d[so]; dst[o + 1] = src.d[so + 1]; dst[o + 2] = src.d[so + 2]; dst[o + 3] = 255;
  }
}

picked.forEach((g, row) => {
  zooms.forEach((z, col) => {
    const cv = dioramaCreatureSprite(g, 'intelligent', 0.6, z) as unknown as SoftCanvas;
    const spr = fromCanvas(cv);
    const u = upscale(spr.d, spr.w, spr.h, viewScale[col]);
    const cell = onGrass({ w: u.w, h: u.h, d: u.d }, 2, planetAlpha(z));
    blit(sheet, W, cell, pad + col * colW, pad + 20 + row * rowH);
  });
});

writePng(join(OUT, 'lod_by_locomotion.png'), W, H, sheet);

// Fat vs authored for one medium walker if we have one
const walker = picked.find(p => p.dna.locomotion === 'walking') ?? picked[0];
if (walker) {
  const z1 = fromCanvas(dioramaCreatureSprite(walker, 'intelligent', 0.6, 1) as unknown as SoftCanvas);
  const z2 = fromCanvas(dioramaCreatureSprite(walker, 'intelligent', 0.6, 2) as unknown as SoftCanvas);
  const z4 = fromCanvas(dioramaCreatureSprite(walker, 'intelligent', 0.6, 4) as unknown as SoftCanvas);
  // fat path: upscale z1 by 2 and 4
  const fat2 = upscale(z1.d, z1.w, z1.h, 2);
  const fat4 = upscale(z1.d, z1.w, z1.h, 4);
  const cells = [
    onGrass(upscale(z1.d, z1.w, z1.h, 6)),
    onGrass(upscale(fat2.d, fat2.w, fat2.h, 3)),
    onGrass(upscale(fat4.d, fat4.w, fat4.h, 2)),
    onGrass(upscale(z1.d, z1.w, z1.h, 6)),
    onGrass(upscale(z2.d, z2.w, z2.h, 3)),
    onGrass(upscale(z4.d, z4.w, z4.h, 2)),
  ];
  const ww = pad * 2 + cells.reduce((a, c) => a + c.w + 8, 0);
  const hh = pad * 2 + 24 + Math.max(...cells.map(c => c.h));
  const cmp = new Uint8ClampedArray(ww * hh * 4);
  for (let i = 0; i < cmp.length; i += 4) { cmp[i] = 12; cmp[i + 1] = 10; cmp[i + 2] = 16; cmp[i + 3] = 255; }
  let x = pad;
  cells.forEach((c, i) => {
    blit(cmp, ww, c, x, pad + 20);
    x += c.w + 8;
  });
  writePng(join(OUT, 'fat_vs_lod_walker.png'), ww, hh, cmp);
}

// Contact sheet at zoom 1 (game identity — smaller than a town, still readable)
{
  const cols = 12, cell = 48;
  const many: SpeciesGenome[] = [];
  for (let seed = 1; seed <= 20; seed++) {
    const rng = new SeedRNG(`sbr_many_${seed}`);
    let species = initPlayerSpecies(0, new SeedRNG(`founder_sbr_m_${seed}`));
    let bio = { ...DEFAULT_BIOSPHERE };
    let tick = 0;
    for (const phase of PHASES) {
      for (let i = 0; i < 12; i++) {
        tick += 2000;
        const r = stepEvolution(phase, {}, species, bio, rng, tick, []);
        species = r.updatedSpecies; bio = r.updatedBiosphere;
      }
    }
    for (const sp of species) if (!sp.isExtinct) many.push(sp);
  }
  const show = many.slice(0, 96);
  const sw = cols * cell, sh = Math.ceil(show.length / cols) * cell;
  const contact = new Uint8ClampedArray(sw * sh * 4);
  for (let i = 0; i < contact.length; i += 4) {
    contact[i] = 36; contact[i + 1] = 48; contact[i + 2] = 28; contact[i + 3] = 255;
  }
  const a = planetAlpha(1);
  show.forEach((g, i) => {
    const cv = dioramaCreatureSprite(g, 'intelligent', 0.5, 1) as unknown as SoftCanvas;
    const spr = fromCanvas(cv);
    const n = Math.max(1, Math.floor((cell - 4) / Math.max(spr.w, spr.h)));
    const u = upscale(spr.d, spr.w, spr.h, n);
    for (let yy = 0; yy < u.h; yy++) for (let xx = 0; xx < u.w; xx++) {
      const so = (yy * u.w + xx) * 4;
      if (!u.d[so + 3]) continue;
      const dx = (i % cols) * cell + ((cell - u.w) / 2 | 0) + xx;
      const dy = ((i / cols) | 0) * cell + ((cell - u.h) / 2 | 0) + yy;
      if (dx < 0 || dy < 0 || dx >= sw || dy >= sh) continue;
      const o = (dy * sw + dx) * 4;
      contact[o] = Math.round(u.d[so] * a + contact[o] * (1 - a));
      contact[o + 1] = Math.round(u.d[so + 1] * a + contact[o + 1] * (1 - a));
      contact[o + 2] = Math.round(u.d[so + 2] * a + contact[o + 2] * (1 - a));
      contact[o + 3] = 255;
    }
  });
  writePng(join(OUT, 'contact_z1.png'), sw, sh, contact);
}

console.log(`wrote ${OUT} (${picked.map(p => p.dna.locomotion).join(', ')})`);
