/**
 * Write a save fixture exactly as the game's buildSaveFile() would.
 *
 *   npx esbuild tools/makeSaveFixture.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/mkfix.mjs && node /tmp/mkfix.mjs tools/fixtures/save-v1-YYYY-MM-DD.eternal
 *
 * Run it against the build whose saves you want to keep loading, then commit
 * the file. `tools/saveCheck.ts` loads every fixture in tools/fixtures/.
 * Deliberately self-contained (no SaveFormat import) so it also runs on older
 * checkouts that predate it.
 */
import { makeCanvas } from './lib/headlessDom';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState } = await import('../src/simulation/GameState');

const out = process.argv[2];
if (!out) { console.error('usage: node mkfix.mjs <out.eternal> [ticks]'); process.exit(2); }
const ticks = Number(process.argv[3] ?? 20_000);

const stats = { life: 15, evolution: 13, hostility: 12, entropy: 11, divine: 10 };
const seed = 'fixture_seed';
Object.assign(gameState, {
  screen: 'game', stats, masterSeed: seed, universeName: 'Fixture Universe',
  godName: 'Fixture God', playerPlanetName: 'Fixture', divinePoints: 42,
});
const engine = new BigBangEngine(makeCanvas()) as any;
engine.init(stats, seed);
for (let i = 0; i < ticks; i++) engine.update();
gameState.tick = engine.tick;

const save = {
  version: 1,
  savedAt: Date.UTC(2026, 9, 12),
  gameState: { ...gameState },
  engine: engine.serialize(),
  eventLog: [{ tick: 1, text: 'fixture', kind: 'system' }],
};
writeFileSync(out, gzipSync(JSON.stringify(save)));
console.log(`wrote ${out}: tick ${engine.tick}, ${engine.stars.length} stars`);
