/**
 * Land walkers stay on land (#25). Drives a running dev server:
 *
 *   npx vite --port 5173 &
 *   node tools/walkerLandCheck.mjs [http://localhost:5173]
 *
 * Opens the diorama preview (?debug=1 exposes the renderer), follows every
 * walking or crawling land creature through 300 s of wandering, and counts
 * positions over water. Before the fix ~8% were; the gate is 1%. Exits
 * non-zero above it.
 */
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:5173';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const res = [];
for (const type of ['ocean', 'rocky', 'ice']) {
  await p.goto(`${base}/diorama-preview.html?type=${type}&phase=intelligent&civLevel=1&debug=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(4000);
  const r = await p.evaluate(() => {
    const d = window.__diorama; if (!d) return 'no renderer';
    let tested = 0, wet = 0, walkers = 0;
    for (const c of d.inhabitants) {
      const loc = c.genome.dna.locomotion;
      if (!(loc === 'walking' || loc === 'crawling') || c.submersion > 0) continue;
      walkers++;
      const f = { cvs: [1,2,3,4,5,6], rate: 8, foot: 0, scale: 1 };
      for (let t = 0; t < 300; t += 0.5) {
        const w = d.wanderOf(c, t, 6, f);
        tested++;
        if (!d.landAtBase(c.wx + w.dx, c.wy + w.dy + (c.gy - c.wy))) wet++;
      }
    }
    return { walkers, tested, wet };
  });
  res.push([type, r]);
}
await b.close();
let bad = false;
for (const [type, r] of res) {
  const share = r.tested ? r.wet / r.tested : 0;
  console.log(`${type}: ${r.walkers} walkers, ${r.wet}/${r.tested} positions over water (${(share * 100).toFixed(2)}%)`);
  if (typeof r === 'string' || share > 0.01) bad = true;
}
process.exit(bad ? 1 : 0);
