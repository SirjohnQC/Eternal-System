/**
 * Dashed lines draw only what is on screen (#30). Part of `npm test`.
 *
 *   npm run test:lines
 *
 * A trade route to another galaxy, seen at a planet's zoom, used to be cut
 * into hundreds of thousands of dashes every frame. Checks: clipping math,
 * the dash count for that case, and that nothing on screen is lost.
 */
const { clipSegment, dashedLine, MAX_DASHES } = await import('../src/rendering/lineClip');

let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const sink = () => {
  let strokes = 0, len = 0, lx = 0, ly = 0, mx = 0, my = 0;
  const g = {
    moveTo(x: number, y: number) { mx = x; my = y; return g; },
    lineTo(x: number, y: number) { lx = x; ly = y; len += Math.hypot(x - mx, y - my); return g; },
    stroke() { strokes++; return g; },
  };
  return { g: g as any, get strokes() { return strokes; }, get len() { return len; }, get last() { return [lx, ly]; } };
};

check(JSON.stringify(clipSegment(-10, 0, 10, 0, -5, -5, 5, 5)) === '[0.25,0.75]', 'clip: horizontal line through a box');
check(clipSegment(-10, 20, 10, 20, -5, -5, 5, 5) === null, 'clip: line outside is dropped');
check(JSON.stringify(clipSegment(0, 0, 1, 1, -5, -5, 5, 5)) === '[0,1]', 'clip: line inside is kept whole');

// A cross-galaxy route (20 000 world units) at planet zoom: scale 60 px per unit.
const scale = 60, px = 1 / scale;
const view = { x: 5000, y: 0, halfW: 720 / scale, halfH: 450 / scale };
const s1 = sink();
dashedLine(s1.g, 0, 0, 20000, 0, 2 * px, 5 * px, 0, px, 1, view);
const unclipped = Math.ceil(20000 / (7 * px));
check(s1.strokes > 0 && s1.strokes < 1000, `planet zoom: ${s1.strokes} dashes drawn (was ~${unclipped.toLocaleString()})`);

// Off screen: nothing drawn.
const s2 = sink();
dashedLine(s2.g, 0, 100, 20000, 100, 2 * px, 5 * px, 0, px, 1, view);
check(s2.strokes === 0, 'route off screen draws nothing');

// Without a view, a huge line falls back to one solid stroke, never a flood.
const s3 = sink();
dashedLine(s3.g, 0, 0, 20000, 0, 2 * px, 5 * px, 0, px, 1);
check(s3.strokes <= MAX_DASHES, `no view: ${s3.strokes} stroke(s), at most ${MAX_DASHES}`);

// On screen the dashes cover the same share as before (~2/7 of the visible length).
const visible = 2 * view.halfW;
check(Math.abs(s1.len / visible - 2 / 7) < 0.05, `dash coverage on screen ${(s1.len / visible).toFixed(3)} ≈ ${(2 / 7).toFixed(3)}`);

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nline checks passed');
