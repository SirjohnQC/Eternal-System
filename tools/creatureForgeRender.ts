/**
 * Renders CreatureForge (src/rendering/CreatureForge.ts) to a PNG contact
 * sheet: one creature per body plan, plus evolved species from the real
 * evolution engine, upscaled so the pixels can be judged.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/creatureForgeRender.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/forge.mjs" --log-level=error && node "$TEMP/forge.mjs" <out.png> [px] [evolved]
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { forgeCreature } from '../src/rendering/CreatureForge';
import type { SpeciesGenome } from '../src/simulation/SpeciesGenome';
import { initPlayerSpecies, stepEvolution } from '../src/simulation/EvolutionEngine';
import { DEFAULT_BIOSPHERE } from '../src/simulation/SpeciesGenome';
import { SeedRNG } from '../src/utils/SeedRNG';

const out = process.argv[2] ?? 'renders/forge.png';
const PX = Number(process.argv[3] ?? 48);
const EVOLVED = Number(process.argv[4] ?? 8);

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

const showcase: Array<[string, SpeciesGenome]> = [
  ['quadruped hunter', G('q1', { diet: 'carnivore', aggression: 7 }, { size: 'large' })],
  ['quadruped grazer', G('q2', { diet: 'herbivore', aggression: 1 }, {})],
  ['horned brute', G('q3', { diet: 'omnivore', aggression: 9 }, { size: 'massive', sensorySystem: 'echolocation' })],
  ['biped thinker', G('b1', { intelligence: 8, diet: 'omnivore', social: 8 }, {})],
  ['insect walker', G('i1', { diet: 'carnivore' }, { bodyStructure: 'exoskeletal', sensorySystem: 'compound eyes', size: 'small' })],
  ['crawler', G('c1', { locomotion: 'crawling', diet: 'decomposer' }, { bodyStructure: 'segmented', sensorySystem: 'chemoreception', size: 'small' })],
  ['crab', G('k1', { locomotion: 'crawling', environment: 'coastal', diet: 'carnivore' }, { bodyStructure: 'exoskeletal', size: 'small' })],
  ['snail', G('s1', { locomotion: 'crawling', environment: 'coastal', diet: 'herbivore' }, { bodyStructure: 'shelled', size: 'small', sensorySystem: 'photoreception' })],
  ['fish', G('f1', { locomotion: 'swimming', environment: 'ocean', diet: 'herbivore' }, { mobilityType: 'fins', size: 'small' })],
  ['shark', G('f2', { locomotion: 'swimming', environment: 'ocean', diet: 'carnivore', aggression: 7 }, { bodyStructure: 'cartilaginous', mobilityType: 'fins', size: 'large' })],
  ['deep angler', G('f3', { locomotion: 'swimming', environment: 'deep_sea', diet: 'carnivore', metabolism: 'heterotrophic' }, { mobilityType: 'fins', sensorySystem: 'electroreception' })],
  ['squid', G('sq', { locomotion: 'swimming', environment: 'ocean', diet: 'carnivore' }, { mobilityType: 'jet siphon', bodyStructure: 'cartilaginous' })],
  ['ray', G('ry', { locomotion: 'swimming', environment: 'ocean' }, { mobilityType: 'undulating fringe', bodyStructure: 'cartilaginous' })],
  ['jelly', G('j1', { locomotion: 'swimming', environment: 'ocean', diet: 'carnivore', metabolism: 'heterotrophic' }, { bodyStructure: 'gelatinous', size: 'small' })],
  ['bird', G('bd', { locomotion: 'flying', environment: 'aerial', diet: 'carnivore' }, { mobilityType: 'feathered wings', size: 'small' })],
  ['bat', G('bt', { locomotion: 'flying', environment: 'aerial', diet: 'omnivore' }, { mobilityType: 'membrane wings', sensorySystem: 'echolocation', size: 'small' })],
  ['flying insect', G('fi', { locomotion: 'flying', environment: 'aerial', diet: 'herbivore' }, { bodyStructure: 'exoskeletal', mobilityType: 'membrane wings', sensorySystem: 'compound eyes', size: 'tiny' })],
  ['gas balloon', G('gb', { locomotion: 'flying', environment: 'aerial', metabolism: 'photosynthetic', diet: 'producer' }, { mobilityType: 'gas bladders', size: 'medium' })],
  ['polyp', G('po', { locomotion: 'stationary', environment: 'ocean', diet: 'carnivore' }, { bodyStructure: 'radial', mobilityType: 'holdfast', sensorySystem: 'chemoreception' })],
  ['plant', G('pl', { locomotion: 'stationary', environment: 'land', metabolism: 'photosynthetic', diet: 'producer' }, { bodyStructure: 'filamentous', mobilityType: 'root mat' })],
  ['cell', G('ce', { locomotion: 'swimming', environment: 'ocean', metabolism: 'chemosynthetic', diet: 'producer' }, { bodyStructure: 'single-celled', mobilityType: 'flagella', size: 'microscopic', sensorySystem: 'photoreception' })],
  ['colony', G('co', { locomotion: 'stationary', environment: 'ocean', metabolism: 'photosynthetic', diet: 'producer' }, { bodyStructure: 'colonial', size: 'tiny' })],
  ['starfish', G('st', { locomotion: 'crawling', environment: 'coastal', diet: 'carnivore' }, { bodyStructure: 'radial' })],
  ['worm', G('wo', { locomotion: 'swimming', environment: 'deep_sea', diet: 'decomposer', metabolism: 'chemosynthetic' }, { bodyStructure: 'filamentous', mobilityType: 'undulating fringe2' })],
];

// Evolved species from the real engine, to see what the game actually breeds.
const rng = new SeedRNG('forge_sheet');
let sp = initPlayerSpecies(0, rng), bio = { ...DEFAULT_BIOSPHERE };
const phases = ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'];
for (let p = 0; p < phases.length; p++) for (let i = 0; i < 90; i++) {
  const r = stepEvolution(phases[p], {}, sp, bio, rng, (p * 90 + i) * 2000, []);
  sp = r.updatedSpecies; bio = r.updatedBiosphere;
}
const evolved = sp.filter(s => !s.isExtinct).slice(0, EVOLVED).map(s => [s.name.slice(0, 18), s] as [string, SpeciesGenome]);
const all = [...showcase, ...evolved];

const COLS = 8, CELL = PX + 8, SCALE = 4;
const rows = Math.ceil(all.length / COLS);
const W = COLS * CELL, H = rows * CELL;
const img = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { const c = ((i % W) / CELL | 0) + ((i / W / CELL) | 0); const v = c % 2 ? 26 : 20; img[i * 4] = v; img[i * 4 + 1] = v + 6; img[i * 4 + 2] = v + 4; img[i * 4 + 3] = 255; }
const t0 = Date.now();
all.forEach(([, g], k) => {
  const f = forgeCreature(g, PX);
  const cx = (k % COLS) * CELL + ((CELL - f.width) >> 1), cy = ((k / COLS) | 0) * CELL + (CELL - f.height) - 2;
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const s = (y * f.width + x) * 4, a = f.data[s + 3] / 255;
    const X = cx + x, Y = cy + y;
    if (a === 0 || X < 0 || Y < 0 || X >= W || Y >= H) continue;
    const o = (Y * W + X) * 4;
    for (let c = 0; c < 3; c++) img[o + c] = img[o + c] * (1 - a) + f.data[s + c] * a;
  }
});
console.log(`${all.length} creatures in ${Date.now() - t0} ms; ${all.map(a => a[0]).join(' | ')}`);
const SW = W * SCALE, SH = H * SCALE, up = new Uint8ClampedArray(SW * SH * 4);
for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
  const s = (((y / SCALE) | 0) * W + ((x / SCALE) | 0)) * 4, o = (y * SW + x) * 4;
  up[o] = img[s]; up[o + 1] = img[s + 1]; up[o + 2] = img[s + 2]; up[o + 3] = 255;
}
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
writeFileSync(out, png(SW, SH, up));
