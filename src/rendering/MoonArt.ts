/**
 * MoonArt — one procedural pixel moon, shared by the system view and the
 * planet view so a moon looks the same in both.
 *
 * A pixel sphere lit from a given sun direction, with stepped shading and
 * a dithered terminator, and a surface by kind: cratered rock, dark iron
 * with metal glints, cracked ice, carbon soot, a volcanic moon whose lava
 * glows on its night side, a small ocean world with drifting cloud.
 * A colonised moon carries its colony: domes on the day side, lights on the
 * night side (kept data-driven for the colonisation systems to come).
 *
 * Pure: RGBA out, no DOM.
 */
export type MoonKindArt = 'rock' | 'ice' | 'iron' | 'volcanic' | 'carbon' | 'ocean';

export interface MoonArtOpts {
  kind: MoonKindArt;
  /** Base colour (the moon's own `color`). */
  rgb: [number, number, number];
  /** Diameter in px. */
  size: number;
  seed: number;
  /** Light direction in the image plane (x right, y down), any length; (0,0) = full face lit. */
  lx: number; ly: number;
  colonised?: boolean;
  /** A lumpy captured rock: the silhouette is a seeded potato, not a disc. */
  irregular?: boolean;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);

function hash(a: number, b: number, s: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise on the sphere's 2D projection (lattice `cell` px). */
function vnoise(x: number, y: number, cell: number, s: number): number {
  const fx = x / cell, fy = y / cell, ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function paintMoon(o: MoonArtOpts): { width: number; height: number; data: Uint8ClampedArray } {
  const N = Math.max(3, Math.round(o.size));
  const data = new Uint8ClampedArray(N * N * 4);
  const R = N / 2, s = o.seed | 0;
  // Light as a 3D direction: the image-plane part plus "towards the viewer".
  const ll = Math.hypot(o.lx, o.ly);
  const lz = ll < 1e-6 ? 1 : 0.35;
  const lx = ll < 1e-6 ? 0 : o.lx / ll, ly = ll < 1e-6 ? 0 : o.ly / ll;
  const lnorm = Math.hypot(lx, ly, lz);
  // Craters: a few discs, bigger moons get more.
  const craters: Array<[number, number, number]> = [];
  const nc = o.kind === 'ocean' ? 0 : Math.min(9, 2 + Math.floor(N / 6));
  for (let i = 0; i < nc; i++) {
    const a = hash(i, 1, s) * Math.PI * 2, d = Math.sqrt(hash(i, 2, s)) * 0.75;
    craters.push([Math.cos(a) * d, Math.sin(a) * d, 0.08 + hash(i, 3, s) * 0.16]);
  }
  const [br, bg, bb] = o.rgb;
  // Irregular body: the edge radius wobbles with angle (three seeded
  // harmonics, 0.62..1 of the box), and the shading normal is taken on the
  // sphere the point would sit on if the body were round, so the lumps shade.
  const irr = !!o.irregular;
  const h1 = hash(1, 91, s) * 6.283, h2 = hash(2, 91, s) * 6.283, h3 = hash(3, 91, s) * 6.283;
  const a1 = 0.10 + hash(4, 91, s) * 0.08, a2 = 0.06 + hash(5, 91, s) * 0.06, a3 = 0.04;
  const edgeAt = (th: number) => 1 - (a1 + a2 + a3) + a1 * Math.cos(2 * th + h1) + a2 * Math.cos(3 * th + h2) + a3 * Math.cos(5 * th + h3);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let u = (x + 0.5 - R) / R, v = (y + 0.5 - R) / R, rr = u * u + v * v;
    if (irr) {
      const e = edgeAt(Math.atan2(v, u));
      if (rr > e * e) continue;
      u /= e; v /= e; rr = Math.min(1, u * u + v * v);
    } else if (rr > 1) continue;
    const z = Math.sqrt(1 - rr);
    // Lambert, quantised to five steps with a dithered terminator.
    const lam = (u * lx + v * ly + z * lz) / lnorm;
    const b4 = BAYER4[(y & 3) * 4 + (x & 3)];
    const lit = lam <= 0 ? 0 : Math.min(4, Math.floor(lam * 4.2 + b4 * 0.8));
    const night = lam < -0.05 + b4 * 0.1;
    // Surface by kind (0..1 brightness factor, and an optional own colour).
    let f = 1, cr = br, cg = bg, cb = bb, glow: [number, number, number] | null = null;
    const n1 = vnoise(u * 8 + 9, v * 8 + 9, 1, s), n2 = vnoise(u * 3 + 3, v * 3 + 3, 1, s ^ 77);
    switch (o.kind) {
      case 'ice': {
        f = 0.92 + n2 * 0.1;
        const crack = Math.abs(vnoise(u * 5 + 1, v * 5 + 1, 1, s ^ 5) - 0.5) < 0.035;
        if (crack) { cr = br * 0.6; cg = bg * 0.75; cb = Math.min(255, bb * 1.05); }
        break;
      }
      case 'volcanic': {
        f = 0.55 + n2 * 0.3;
        const lava = vnoise(u * 4 + 7, v * 4 + 7, 1, s ^ 9);
        if (lava > 0.68) glow = lava > 0.78 ? [255, 210, 90] : [235, 110, 40];
        break;
      }
      case 'ocean': {
        cr = 50; cg = 105; cb = 170; f = 0.85 + n2 * 0.25;
        const cloud = vnoise(u * 4 + 2 + s % 7, v * 6 + 2, 1, s ^ 3);
        if (cloud > 0.62) { cr = 235; cg = 240; cb = 248; f = 1; }
        break;
      }
      case 'iron': f = 0.7 + n1 * 0.25; if (n1 > 0.86) { cr = 210; cg = 205; cb = 196; } break;
      case 'carbon': f = 0.55 + n1 * 0.3; break;
      default: f = 0.78 + n1 * 0.18 + (n2 - 0.5) * 0.12;
    }
    // Craters: dark floor, lit rim on the sun side.
    for (const [cx, cy, crd] of craters) {
      const d = Math.hypot(u - cx, v - cy);
      if (d < crd) {
        const toward = ((u - cx) * lx + (v - cy) * ly) / (crd || 1);
        f *= d > crd * 0.72 ? (toward > 0 ? 1.18 : 0.72) : 0.82;
        break;
      }
    }
    const shadeK = [0.16, 0.42, 0.66, 0.86, 1.04][lit];
    let r = cr * f * shadeK, g = cg * f * shadeK, b = cb * f * shadeK;
    // Cool shadow side, warm light side.
    if (lit <= 1) { r *= 0.86; b = b * 1.08 + 6; }
    if (glow && (night || lit <= 1)) { r = glow[0]; g = glow[1]; b = glow[2]; }
    else if (glow) { r = r * 0.6 + glow[0] * 0.4; g = g * 0.6 + glow[1] * 0.4; b = b * 0.6 + glow[2] * 0.4; }
    // Limb: a 1-px darker rim reads as a sphere at any size.
    if (rr > (1 - 2.2 / N) * (1 - 2.2 / N)) { r *= 0.7; g *= 0.7; b *= 0.75; }
    const i = (y * N + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  if (o.colonised && N >= 6) {
    // A few domes and their lights: bright points on the day side, warm
    // lights on the night side.
    for (let i = 0; i < 4 + Math.floor(N / 8); i++) {
      const a = hash(i, 11, s) * Math.PI * 2, d = Math.sqrt(hash(i, 12, s)) * 0.7;
      const x = Math.round(R + Math.cos(a) * d * R - 0.5), y = Math.round(R + Math.sin(a) * d * R - 0.5);
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const k = (y * N + x) * 4;
      if (!data[k + 3]) continue;
      const u = (x + 0.5 - R) / R, v = (y + 0.5 - R) / R, z = Math.sqrt(Math.max(0, 1 - u * u - v * v));
      const lam = (u * lx + v * ly + z * lz) / lnorm;
      const c = lam > 0.1 ? [236, 244, 255] : [255, 214, 120];
      data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2];
    }
  }
  return { width: N, height: N, data };
}
