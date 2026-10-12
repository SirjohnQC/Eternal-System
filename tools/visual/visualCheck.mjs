/**
 * Visual regression check: renders seeded scenes in headless Chromium and
 * compares them with the golden PNGs in tools/visual/goldens/.
 *
 *   npm run test:visual              compare against the goldens
 *   npm run test:visual -- --update  re-capture the goldens (review the diff!)
 *   npm run test:visual -- ocean     only scenes whose name contains "ocean"
 *
 * Goldens must come from the same renderer that checks them (CI's Linux
 * Chromium, software WebGL via SwiftShader); a GPU machine draws slightly
 * different pixels. Refresh them from GitHub: Actions → "Visual goldens" →
 * Run workflow on your branch. See docs/VISUAL_TESTS.md.
 *
 * Determinism: a seeded Math.random; Playwright's fake clock paused during
 * load, then advanced a fixed SIM_MS; performance.now() and animation frames
 * derived from that faked clock; one warm-up load per scene; and only the
 * game canvas (#stage) is captured — no fonts, no FPS counter.
 *
 * Comparison: the image is split into 8x8 blocks; a block counts as changed
 * when more than 20% of its pixels differ by more than 24 in any channel.
 * Isolated sparkle noise changes no blocks; a layer drawn in the wrong order
 * changes a contiguous patch of them. On failure, actual + diff PNGs are
 * written to .cache/visual/ (uploaded as a CI artifact).
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Scenes ────────────────────────────────────────────────────────────────
// Diorama preview (src/dev/dioramaPreview.ts); all params documented in CLAUDE.md.
const SCENES = [
  { name: 'ocean-world',          path: '/diorama-preview.html?type=ocean&seed=7' },
  { name: 'rocky-volcanic-forming', path: '/diorama-preview.html?type=rocky&formation=volcanic&seed=7' },
  { name: 'ocean-magma-forming',  path: '/diorama-preview.html?type=ocean&formation=magma&seed=7' },
  { name: 'lava-world',           path: '/diorama-preview.html?type=lava&seed=7' },
  { name: 'ice-world',            path: '/diorama-preview.html?type=ice&seed=7' },
  { name: 'gas-giant',            path: '/diorama-preview.html?type=gas&seed=7' },
  { name: 'ocean-primitive-life', path: '/diorama-preview.html?type=ocean&seed=7&phase=primitive&civLevel=0' },
];

const VIEWPORT = { width: 960, height: 640 };
const SIM_MS = 8000;
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const BLOCK = 8, CHANNEL_TOL = 24, BLOCK_FRAC = 0.2;
/** Changed 8x8 blocks tolerated per scene before it fails. */
const MAX_BLOCKS = 2;
const PORT = 4199;

const ROOT = process.cwd();
const GOLDENS = join(ROOT, 'tools', 'visual', 'goldens');
const OUT = join(ROOT, '.cache', 'visual');

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const filters = args.filter(a => !a.startsWith('--'));
const scenes = SCENES.filter(s => !filters.length || filters.some(f => s.name.includes(f)));

// ── Dev server ────────────────────────────────────────────────────────────
async function startServer() {
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  const base = `http://localhost:${PORT}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/')).ok) return { proc, base }; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  stopServer(proc);
  throw new Error(`dev server did not start on ${base}\n${log}`);
}
function stopServer(proc) {
  try { process.platform === 'win32' ? proc.kill() : process.kill(-proc.pid, 'SIGTERM'); } catch { /* gone */ }
}

// ── Capture ───────────────────────────────────────────────────────────────
function seededRandom() {
  let s = 0x9e3779b9;
  Math.random = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function capture(browser, url) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(seededRandom);
  await page.clock.install({ time: CLOCK_START });
  // Derive performance.now() and animation frames from the faked Date, which
  // is identical every run. Left alone, performance.now() starts 1-2 ms apart
  // between runs (navigation takes real time), every frame's dt shifts, and
  // dt-stepped state such as the weather drifts. Installed after the clock so
  // it wraps the faked timers.
  await page.addInitScript(start => {
    performance.now = () => Date.now() - start;
    window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 16);
    window.cancelAnimationFrame = id => clearTimeout(id);
  }, CLOCK_START.getTime());
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 1000));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.clock.runFor(SIM_MS);
  const png = await page.locator('#stage').screenshot();
  await ctx.close();
  return { png, errors };
}

// ── Compare ───────────────────────────────────────────────────────────────
function compare(goldenBuf, actualBuf) {
  const g = PNG.sync.read(goldenBuf), a = PNG.sync.read(actualBuf);
  if (g.width !== a.width || g.height !== a.height) {
    return { changed: Infinity, total: 0, diff: null, sizeMismatch: `${g.width}x${g.height} vs ${a.width}x${a.height}` };
  }
  const { width: W, height: H } = g;
  const diff = new PNG({ width: W, height: H });
  let changed = 0, total = 0;
  for (let by = 0; by < H; by += BLOCK) {
    for (let bx = 0; bx < W; bx += BLOCK) {
      let n = 0, d = 0;
      for (let y = by; y < Math.min(by + BLOCK, H); y++) {
        for (let x = bx; x < Math.min(bx + BLOCK, W); x++) {
          const i = (y * W + x) * 4;
          n++;
          if (Math.abs(g.data[i] - a.data[i]) > CHANNEL_TOL ||
              Math.abs(g.data[i + 1] - a.data[i + 1]) > CHANNEL_TOL ||
              Math.abs(g.data[i + 2] - a.data[i + 2]) > CHANNEL_TOL) d++;
        }
      }
      total++;
      const hit = d / n > BLOCK_FRAC;
      if (hit) changed++;
      // Diff image: the golden dimmed, changed blocks tinted red.
      for (let y = by; y < Math.min(by + BLOCK, H); y++) {
        for (let x = bx; x < Math.min(bx + BLOCK, W); x++) {
          const i = (y * W + x) * 4;
          const lum = (g.data[i] + g.data[i + 1] + g.data[i + 2]) / 3 * 0.35;
          diff.data[i] = hit ? 255 : lum; diff.data[i + 1] = hit ? 40 : lum; diff.data[i + 2] = hit ? 40 : lum;
          diff.data[i + 3] = 255;
        }
      }
    }
  }
  return { changed, total, diff: PNG.sync.write(diff) };
}

// ── Run ───────────────────────────────────────────────────────────────────
mkdirSync(GOLDENS, { recursive: true });
mkdirSync(OUT, { recursive: true });
const { proc, base } = await startServer();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = 0;
try {
  console.log(`Visual ${UPDATE ? 'UPDATE' : 'check'}: ${scenes.length} scene(s), Chromium ${browser.version()}\n`);
  for (const s of scenes) {
    const url = base + s.path;
    await capture(browser, url);                       // warm-up: caches, shader compile
    const { png, errors } = await capture(browser, url);
    const goldenPath = join(GOLDENS, `${s.name}.png`);
    if (errors.length) {
      failed++;
      console.log(`  FAIL  ${s.name.padEnd(24)} page error: ${errors[0]}`);
      continue;
    }
    if (UPDATE) {
      writeFileSync(goldenPath, png);
      console.log(`  SAVED ${s.name}`);
      continue;
    }
    if (!existsSync(goldenPath)) {
      failed++;
      writeFileSync(join(OUT, `${s.name}.actual.png`), png);
      console.log(`  FAIL  ${s.name.padEnd(24)} no golden — run with --update (see docs/VISUAL_TESTS.md)`);
      continue;
    }
    const r = compare(readFileSync(goldenPath), png);
    const ok = r.changed <= MAX_BLOCKS;
    const detail = r.sizeMismatch ? `size ${r.sizeMismatch}` : `${r.changed}/${r.total} blocks changed (max ${MAX_BLOCKS})`;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(24)} ${detail}`);
    if (!ok) {
      failed++;
      writeFileSync(join(OUT, `${s.name}.actual.png`), png);
      if (r.diff) writeFileSync(join(OUT, `${s.name}.diff.png`), r.diff);
    }
  }
} finally {
  await browser.close();
  stopServer(proc);
}
if (!UPDATE && failed) console.log(`\n  Actual and diff images: ${OUT}`);
console.log(`\n═══ ${failed ? `${failed} FAILED` : 'OK'} ═══`);
process.exit(failed ? 1 : 0);
