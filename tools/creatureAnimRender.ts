/**
 * Renders CreatureForge's animation (forgeCreatureFrames) for one creature
 * per body plan: writes <outDir>/frame<k>.png, a grid of every creature at
 * frame k, so the frames can be stitched into a GIF to judge the motion.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/creatureAnimRender.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/anim.mjs" --log-level=error && node "$TEMP/anim.mjs" <outDir> [px] [frames]
 *   convert -delay 14 -loop 0 <outDir>/frame*.png anim.gif
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { forgeCreatureFrames } from '../src/rendering/CreatureForge';
import type { SpeciesGenome } from '../src/simulation/SpeciesGenome';

const outDir = process.argv[2] ?? 'renders/anim';
const PX = Number(process.argv[3] ?? 40);
const N = Number(process.argv[4] ?? 4);
const UP = 3;

function G(id: string, o: Partial<SpeciesGenome['dna']>, p: Partial<SpeciesGenome['physicalTraits']>): SpeciesGenome {
  return {
    id, name: id, originTick: 0, population: 1, isExtinct: false, ancestorId: null,
    dna: { metabolism: 'heterotrophic', locomotion: 'walking', environment: 'land', reproduction: 'sexual',
      diet: 'omnivore', respiration: 'aerobic', intelligence: 2, social: 3, aggression: 3, adaptability: 5, ...o },
    physicalTraits: { size: 'medium', bodyStructure: 'vertebrate', mobilityType: 'legs', sensorySystem: 'vision', ...p },
    habitat: { biome: 'forest', temperatureRange: 'temperate' },
    evolutionaryPotential: { landTransition: 1, intelligenceGrowth: 0.2, toolUse: 0 },
  };
}

const cast: SpeciesGenome[] = [
  G('quad', { diet: 'carnivore', aggression: 7 }, { size: 'large' }),
  G('biped', { intelligence: 8, social: 8 }, {}),
  G('insect', { diet: 'carnivore' }, { bodyStructure: 'exoskeletal', sensorySystem: 'compound eyes', size: 'small' }),
  G('crawler', { locomotion: 'crawling', diet: 'decomposer' }, { bodyStructure: 'segmented', sensorySystem: 'chemoreception', size: 'small' }),
  G('crab', { locomotion: 'crawling', environment: 'coastal', diet: 'carnivore' }, { bodyStructure: 'exoskeletal', size: 'small' }),
  G('snail', { locomotion: 'crawling', environment: 'coastal', diet: 'herbivore' }, { bodyStructure: 'shelled', size: 'small', sensorySystem: 'photoreception' }),
  G('fish', { locomotion: 'swimming', environment: 'ocean', diet: 'herbivore' }, { mobilityType: 'fins', size: 'small' }),
  G('squid', { locomotion: 'swimming', environment: 'ocean', diet: 'carnivore' }, { mobilityType: 'jet siphon', bodyStructure: 'cartilaginous' }),
  G('ray', { locomotion: 'swimming', environment: 'ocean' }, { mobilityType: 'undulating fringe', bodyStructure: 'cartilaginous' }),
  G('jelly', { locomotion: 'swimming', environment: 'ocean', diet: 'carnivore' }, { bodyStructure: 'gelatinous', size: 'small' }),
  G('bird', { locomotion: 'flying', environment: 'aerial', diet: 'carnivore' }, { mobilityType: 'feathered wings', size: 'small' }),
  G('bat', { locomotion: 'flying', environment: 'aerial' }, { mobilityType: 'membrane wings', sensorySystem: 'echolocation', size: 'small' }),
  G('fly', { locomotion: 'flying', environment: 'aerial', diet: 'herbivore' }, { bodyStructure: 'exoskeletal', mobilityType: 'membrane wings', sensorySystem: 'compound eyes', size: 'tiny' }),
  G('balloon', { locomotion: 'flying', environment: 'aerial', metabolism: 'photosynthetic', diet: 'producer' }, { mobilityType: 'gas bladders' }),
  G('polyp', { locomotion: 'stationary', environment: 'ocean', diet: 'carnivore' }, { bodyStructure: 'radial', mobilityType: 'holdfast', sensorySystem: 'chemoreception' }),
  G('plant', { locomotion: 'stationary', metabolism: 'photosynthetic', diet: 'producer' }, { bodyStructure: 'filamentous', mobilityType: 'root mat' }),
  G('cell', { locomotion: 'swimming', environment: 'ocean', metabolism: 'chemosynthetic', diet: 'producer' }, { bodyStructure: 'single-celled', mobilityType: 'flagella', size: 'microscopic', sensorySystem: 'photoreception' }),
  G('star', { locomotion: 'crawling', environment: 'coastal', diet: 'carnivore' }, { bodyStructure: 'radial' }),
  G('worm', { locomotion: 'swimming', environment: 'deep_sea', diet: 'decomposer' }, { bodyStructure: 'filamentous' }),
];

const frames = cast.map(g => forgeCreatureFrames(g, PX, N));
const CELL = Math.max(...frames.flat().map(f => Math.max(f.width, f.height))) + 4;
const COLS = 5, ROWS = Math.ceil(cast.length / COLS);
const W = COLS * CELL * UP, H = ROWS * CELL * UP;

function png(w: number, h: number, rgba: Uint8ClampedArray): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(outDir, { recursive: true });
for (let k = 0; k < N; k++) {
  const img = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { img[i * 4] = 30; img[i * 4 + 1] = 34; img[i * 4 + 2] = 48; img[i * 4 + 3] = 255; }
  frames.forEach((fs, ci) => {
    const f = fs[k];
    const ox = (ci % COLS) * CELL + ((CELL - f.width) >> 1), oy = Math.floor(ci / COLS) * CELL + (CELL - f.height - 2);
    for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
      const s = (y * f.width + x) * 4;
      if (f.data[s + 3] === 0) continue;
      for (let dy = 0; dy < UP; dy++) for (let dx = 0; dx < UP; dx++) {
        const d = (((oy + y) * UP + dy) * W + (ox + x) * UP + dx) * 4;
        img[d] = f.data[s]; img[d + 1] = f.data[s + 1]; img[d + 2] = f.data[s + 2];
      }
    }
  });
  writeFileSync(`${outDir}/frame${k}.png`, png(W, H, img));
}
console.log(`wrote ${N} frames of ${cast.length} creatures to ${outDir}`);
