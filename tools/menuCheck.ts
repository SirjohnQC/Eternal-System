/**
 * Title screen and dice console checks (part of `npm test`).
 *
 *   npm run test:menu
 *
 * - The d20 is a true icosahedron (12 vertices, 30 edges, 20 faces), and a
 *   settled die always shows one face squarely to the viewer.
 * - The menu's glitches stay rare (7–13 s apart) and short.
 * - Hover notes stay in the scale, whatever the button index.
 * - The UI sounds never run without an audio context (no throw before the first click).
 *
 * Exits non-zero on any failure.
 */
import './lib/headlessDom';

const { icosahedron, faceOn } = await import('../src/ui/D20');
const { nextGlitchDelay, GLITCH_MS, CONSOLE_LINES } = await import('../src/ui/MenuScene');
const { scaleNote, UiSound } = await import('../src/audio/UiSound');

let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};

const g = icosahedron();
check(g.verts.length === 12 && g.edges.length === 30 && g.faces.length === 20, `icosahedron: ${g.verts.length} v, ${g.edges.length} e, ${g.faces.length} f`);

// A settled die faces the viewer: the face nearest the viewer ends with its normal on +z.
let worst = 1;
for (let i = 0; i < 200; i++) {
  const a = i * 0.731, b = i * 1.917, c = i * 0.389;
  const n = Math.hypot(Math.cos(a), Math.sin(b), Math.cos(c), Math.sin(a + c));
  const q: [number, number, number, number] = [Math.cos(a) / n, Math.sin(b) / n, Math.cos(c) / n, Math.sin(a + c) / n];
  const r = faceOn(q);
  // Rotate every face centre; the best one must point straight at the viewer.
  const rot = (v: number[]) => {
    const [w, x, y, z] = r;
    const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2];
    const iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  };
  let best = -2;
  for (const f of g.faces) {
    const cen = [0, 1, 2].map(k => (g.verts[f[0]][k] + g.verts[f[1]][k] + g.verts[f[2]][k]) / 3);
    const v = rot(cen);
    best = Math.max(best, v[2] / Math.hypot(v[0], v[1], v[2]));
  }
  worst = Math.min(worst, best);
}
check(worst > 0.9999, `settled d20 shows a face squarely (worst cos ${worst.toFixed(6)})`);

const lo = nextGlitchDelay(0), hi = nextGlitchDelay(1), out = [nextGlitchDelay(-5), nextGlitchDelay(9)];
check(lo === 7000 && hi === 13000 && out[0] === 7000 && out[1] === 13000, `glitches 7–13 s apart (${lo}..${hi})`);
check(GLITCH_MS > 0 && GLITCH_MS <= 300, `a glitch lasts ${GLITCH_MS} ms (≤ 300)`);
check(CONSOLE_LINES.length > 0 && CONSOLE_LINES.every(l => l.length > 0 && l.length <= 64), 'console lines present and short');

const notes = Array.from({ length: 40 }, (_, i) => scaleNote(i - 20));
check(notes.every(f => Number.isFinite(f) && f >= 220 && f <= 2000), 'hover notes stay in the scale');

let threw = false;
try { UiSound.hover(3); UiSound.click(); UiSound.tick(0.5); UiSound.lock(20); UiSound.glitch(); UiSound.awaken(); } catch { threw = true; }
check(!threw, 'UI sounds are silent, not broken, before audio starts');

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nmenu checks passed');
