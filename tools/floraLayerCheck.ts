/**
 * FloraLayer (src/rendering/FloraLayer.ts): plants sway, grow in and wilt
 * away; stone stays put. Drawn through the harness pixel canvas.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/floraLayerCheck.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/flc.mjs" --log-level=error && node "$TEMP/flc.mjs"
 */
import { installDom, PixelCanvas } from './zoomHarness';
installDom();
const { FloraLayer, GROW_SECONDS, WILT_SECONDS } = await import('../src/rendering/FloraLayer');
type Site = import('../src/rendering/SurfaceDecals').DecalSite;

let fails = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
};

const W = 320, H = 200;
const kinds = ['conifer', 'broadleaf', 'palm', 'grass', 'bush', 'rock', 'crystal', 'cactus'] as const;
const sites = (n: number, kindsOf: readonly string[], off = 0): Site[] => Array.from({ length: n }, (_, i) => ({
  x: 20 + (i % 10) * 28, y: 40 + Math.floor(i / 10) * 40 + off, wx: 20 + (i % 10) * 28, wy: 40 + Math.floor(i / 10) * 40 + off,
  kind: kindsOf[i % kindsOf.length] as Site['kind'], scale: 0.38, row: i + off, col: 3, foot: (90 << 16) | (130 << 8) | 70,
}));
const view = (K: number) => ({ K, fx: W / 2, fy: H / 2, W, H, r: 1, dx: 0, dy: 0, bob: 0, vw: W, vh: H });

function render(layer: InstanceType<typeof FloraLayer>, t: number, K = 1, frames = 1): Uint8ClampedArray {
  let c = new PixelCanvas(W, H);
  // Several draws let the per-frame forge budget fill the cache.
  for (let i = 0; i < frames; i++) { c = new PixelCanvas(W, H); layer.draw(c.getContext() as any, t, view(K), 'ocean', null); }
  return c.data;
}
const opaque = (d: Uint8ClampedArray) => { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
const differ = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 3] !== b[i + 3]) n++; return n; };

// ─── sway ───
{
  const L = new FloraLayer();
  L.setPlan(sites(20, ['conifer', 'palm', 'grass', 'broadleaf']), 0, true);
  const a = render(L, 0.0, 2, 8), b = render(L, 0.75, 2, 8);
  check('plants sway: two moments differ', differ(a, b) > 20, `${differ(a, b)} px differ, ${opaque(a)} drawn`);
  const S = new FloraLayer();
  S.setPlan(sites(20, ['rock', 'cactus']), 0, true);
  const c = render(S, 0.0, 2, 8), d = render(S, 0.75, 2, 8);
  check('stone and cacti stand still', differ(c, d) === 0 && opaque(c) > 100, `${differ(c, d)} px differ, ${opaque(c)} drawn`);
  L.wind = 0;
  const e = render(L, 0.0, 2, 2), f = render(L, 0.75, 2, 2);
  check('no wind: plants still', differ(e, f) === 0, `${differ(e, f)} px differ`);
}

// ─── growth ───
{
  const L = new FloraLayer();
  L.wind = 0;
  L.setPlan([], 0, true);
  const plan = sites(30, ['conifer', 'broadleaf', 'grass', 'bush', 'palm']);
  L.setPlan(plan, 10, false);
  const seq = [10, 10 + GROW_SECONDS * 0.3, 10 + GROW_SECONDS * 0.8, 10 + GROW_SECONDS * 2].map(t => opaque(render(L, t, 2, 12)));
  const M = new FloraLayer(); M.wind = 0; M.setPlan(plan, 0, true);
  const mature = opaque(render(M, 50, 2, 12));
  check('new plants start small', seq[0] < mature * 0.25, `${seq[0]} px at birth vs ${mature} grown`);
  check('and grow, stage by stage', seq[0] <= seq[1] && seq[1] < seq[2] && seq[2] < seq[3], seq.join(' -> '));
  check('to full size', seq[3] === mature, `${seq[3]} vs ${mature}`);
  // A plant that stays in the plan keeps its age.
  L.setPlan(plan, 60, false);
  check('a replan keeps grown plants grown', opaque(render(L, 60, 2, 2)) === mature, `${opaque(render(L, 60, 2, 2))}`);

  // ─── wilt ───
  L.setPlan([], 70, false);
  const w0 = render(L, 70.2, 2, 2), w1 = render(L, 70 + WILT_SECONDS * 0.6, 2, 2), w2 = render(L, 70 + WILT_SECONDS + 1, 2, 2);
  check('lost plants wilt, not vanish', opaque(w0) > 0 && opaque(w1) < opaque(w0), `${opaque(w0)} -> ${opaque(w1)}`);
  check('and are gone after wilting', opaque(w2) === 0, `${opaque(w2)}`);
  let g0 = 0, g1 = 0;
  for (let i = 0; i < w0.length; i += 4) if (w0[i + 3]) { g0 += w0[i + 1] - w0[i]; }
  const m0 = render(M, 50, 2, 2);
  for (let i = 0; i < m0.length; i += 4) if (m0[i + 3]) { g1 += m0[i + 1] - m0[i]; }
  check('wilting browns the leaves', g0 / Math.max(1, opaque(w0)) < g1 / Math.max(1, opaque(m0)) - 8,
    `green-red ${(g0 / opaque(w0)).toFixed(1)} vs ${(g1 / opaque(m0)).toFixed(1)} grown`);
}

// ─── stone ───
{
  const L = new FloraLayer();
  L.setPlan([], 0, true);
  L.setPlan(sites(10, ['rock', 'ore', 'crystal']), 5, false);
  const M = new FloraLayer(); M.setPlan(sites(10, ['rock', 'ore', 'crystal']), 0, true);
  check('stone appears whole (it does not grow)', opaque(render(L, 5, 2, 6)) === opaque(render(M, 5, 2, 6)), '');
}

// ─── footing ───
{
  const L = new FloraLayer();
  const s = sites(10, kinds);
  for (const x of s) x.foot = -1;
  L.setPlan(s, 0, true);
  check('no footing: nothing drawn', opaque(render(L, 0, 2, 2)) === 0, '');
}

console.log(fails ? `\n  ${fails} FAILED` : '\n  all ok');
