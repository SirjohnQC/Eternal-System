/**
 * Meteors strike the sea as well as land (#26). Drives a running dev server:
 *
 *   npx vite --port 5173 &
 *   node tools/meteorSeaCheck.mjs [http://localhost:5173]
 *
 * On an ocean world and a rocky one, picks 200 strike sites the way the
 * diorama does and compares the share that falls in the sea with the share
 * of sea on the inner face. Before the fix no strike ever landed in the sea.
 * Fails when sea strikes are under half the sea share.
 */
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:5173';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
let bad = false;
for (const type of ['ocean', 'rocky']) {
  await p.goto(`${base}/diorama-preview.html?type=${type}&phase=complex&debug=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(4000);
  const r = await p.evaluate(() => {
    const d = window.__diorama, SEA = 0.48;
    const wet = (row, col) => { const dd = d.gridToDisc(row, col), gc = d.grid[row][col]; return gc.elevation - d.rimFalloff(Math.hypot(dd.dx, dd.dy)) < SEA; };
    let sea = 0, n = 0;
    for (let i = 0; i < 200; i++) { const c = d.pickStrikeCell(i); if (!c) continue; n++; if (wet(c.row, c.col)) sea++; }
    let faceSea = 0, face = 0;
    for (let row = 0; row < 256; row += 2) for (let col = 0; col < 256; col += 2) {
      const dd = d.gridToDisc(row, col); if (!dd || Math.hypot(dd.dx, dd.dy) > 0.7) continue;
      face++; if (wet(row, col)) faceSea++;
    }
    return { sea, n, share: faceSea / Math.max(1, face) };
  });
  const got = r.sea / Math.max(1, r.n);
  console.log(`${type}: ${r.sea}/${r.n} strikes in the sea (${(got * 100).toFixed(0)}%), sea is ${(r.share * 100).toFixed(0)}% of the inner face`);
  if (r.share > 0.1 && got < r.share * 0.5) bad = true;
}
await b.close();
process.exit(bad ? 1 : 0);
