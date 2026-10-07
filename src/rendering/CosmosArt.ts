/**
 * Art for the universe map's depth: tileable parallax starfields (far and
 * near layers that drift slower than the map as it pans) and soft nebula
 * clouds that hang between the sectors. Canvas bakes, made once.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

/** A tileable field of pixel stars. `near` layers are brighter, a few tinted. */
export function starfieldTile(size: number, seed: number, count: number, near: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const r = rng(seed);
  const tints = near ? ['#ffffff', '#cfdcff', '#ffe6c8', '#d8c8ff'] : ['#9aa4c8', '#b8b0d8', '#8890b0'];
  for (let i = 0; i < count; i++) {
    const x = Math.floor(r() * size), y = Math.floor(r() * size);
    const big = near && r() < 0.12;
    g.globalAlpha = near ? 0.5 + r() * 0.5 : 0.25 + r() * 0.35;
    g.fillStyle = tints[Math.floor(r() * tints.length)];
    g.fillRect(x, y, big ? 2 : 1, big ? 2 : 1);
    if (big && r() < 0.4) {               // a faint cross on the brightest
      g.globalAlpha *= 0.35;
      g.fillRect(x - 1, y, 4, 1);
      g.fillRect(x, y - 1, 1, 4);
    }
  }
  return c;
}

/** A soft, lumpy cloud of gas (white; tinted by the sprite), alpha falling to the edge. */
export function nebulaBlob(size: number, seed: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const r = rng(seed);
  // A few octaves of value noise on a coarse lattice.
  const oct = [4, 8, 16, 32].map(n => ({ n, v: Array.from({ length: (n + 1) * (n + 1) }, () => r()) }));
  const sample = (o: { n: number; v: number[] }, u: number, v: number) => {
    const x = u * o.n, y = v * o.n, x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (i: number, j: number) => o.v[Math.min(o.n, j) * (o.n + 1) + Math.min(o.n, i)];
    const a = at(x0, y0), b = at(x0 + 1, y0), cc = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return (a + (b - a) * sx) + ((cc + (d - cc) * sx) - (a + (b - a) * sx)) * sy;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    let n = 0, amp = 1, tot = 0;
    for (const o of oct) { n += sample(o, u, v) * amp; tot += amp; amp *= 0.55; }
    n /= tot;
    const dx = u - 0.5, dy = v - 0.5;
    const fall = Math.max(0, 1 - Math.hypot(dx, dy) * 2);
    const a = Math.max(0, Math.min(1, (n - 0.35) * 2.2)) * fall * fall;
    const o = (y * size + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
    img.data[o + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  return c;
}
