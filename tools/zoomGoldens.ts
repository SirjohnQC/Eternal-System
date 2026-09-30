/**
 * Capture the identity-render golden hashes for the zoom camera checks.
 *
 * Renders every layer (see tools/zoomHarness.ts) for ocean, lava and gas at
 * seed 7 and writes `{ [type]: { [layer]: fnv1aHex } }` to tools/zoomGoldens.json
 * (relative to the working directory — run from the project root), printing the
 * same JSON to stdout. Per-layer painted-pixel counts and the Math.random guard
 * go to stderr, so stdout of two runs can be diffed for determinism.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/zoomGoldens.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/zoomGoldens.mjs" --log-level=error \
 *     && node "$TEMP/zoomGoldens.mjs"
 */
import { writeFileSync } from 'node:fs';
import { installDom, hashImage, renderLayers, lastRandomCalls } from './zoomHarness';

installDom();

const TYPES = ['ocean', 'lava', 'gas'] as const;
const SEED = 7;

const out: Record<string, Record<string, string>> = {};
for (const type of TYPES) {
  const layers = renderLayers(type, SEED);
  out[type] = {};
  const painted: string[] = [];
  for (const [name, data] of Object.entries(layers)) {
    out[type][name] = hashImage(data);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
    painted.push(`${name}=${n}`);
  }
  console.error(`  ${type.padEnd(6)} painted px: ${painted.join(' ')}  Math.random calls: ${lastRandomCalls}`);
}

const json = JSON.stringify(out, null, 2) + '\n';
writeFileSync('tools/zoomGoldens.json', json);
process.stdout.write(json);
