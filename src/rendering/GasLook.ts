/**
 * How a gas giant looks, shared by every view of it (the planet view's cloud
 * sea and the map orbs): its family, its bands, its great storm's colour.
 * Pure: seeded from the planet's genome seed.
 */
export interface RGB { r: number; g: number; b: number }
const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });

function hash1(n: number, seed: number): number {
  let h = (n * 374761393 + seed * 2654435761) | 0;
  h = ((h ^ (h >>> 13)) * 1540483477) | 0;
  h = h ^ (h >>> 15);
  return ((h >>> 0) & 0xffff) / 0xffff;
}

class Stream {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 1; }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  range(a: number, b: number): number { return a + this.next() * (b - a); }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
}

export function hsvToRGB(hDeg: number, s: number, v: number): RGB {
  const h = ((hDeg % 360) + 360) % 360 / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 1)      { r = c; g = x; }
  else if (h < 2) { r = x; g = c; }
  else if (h < 3) { g = c; b = x; }
  else if (h < 4) { g = x; b = c; }
  else if (h < 5) { r = x; b = c; }
  else            { r = c; b = x; }
  return rgb((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/**
 * A gas giant's look, by family: Jovian (cream zones, ochre and rust belts),
 * Saturnine (pale gold, soft), Neptunian (deep blues, white streaks), hot
 * Jupiter (dark plum and ember), ammonia (teal and jade). The bands alternate
 * light ZONES and darker BELTS, the way real giants do, with seeded jitter so
 * no two giants of a family match.
 */
export type GasFamily = 'jovian' | 'saturnine' | 'neptunian' | 'hot' | 'ammonia';
const GAS_FAMILIES: Record<GasFamily, { zone: [number, number, number]; belt: [number, number, number]; storm: [number, number, number]; spread: number }> = {
  jovian:    { zone: [38, 0.22, 0.94], belt: [22, 0.62, 0.66], storm: [12, 0.72, 0.78], spread: 14 },
  saturnine: { zone: [46, 0.28, 0.95], belt: [36, 0.42, 0.80], storm: [40, 0.18, 0.98], spread: 8 },
  neptunian: { zone: [205, 0.45, 0.88], belt: [222, 0.72, 0.60], storm: [230, 0.85, 0.36], spread: 12 },
  hot:       { zone: [345, 0.40, 0.72], belt: [10, 0.75, 0.42], storm: [28, 0.85, 0.95], spread: 18 },
  ammonia:   { zone: [168, 0.30, 0.90], belt: [150, 0.55, 0.58], storm: [190, 0.2, 0.98], spread: 12 },
};
export function gasFamilyOf(seed: number): GasFamily {
  // A hash, not the LCG: neighbouring seeds must not share a family.
  const r = hash1(seed * 7 + 3, 0x3c6e);
  return r < 0.36 ? 'jovian' : r < 0.58 ? 'saturnine' : r < 0.80 ? 'neptunian' : r < 0.91 ? 'ammonia' : 'hot';
}
export function makeGasBands(seed: number): RGB[] {
  const s = new Stream(seed ^ 0x6a09e667);
  const f = GAS_FAMILIES[gasFamilyOf(seed)];
  const bandCount = 9 + s.int(0, 5);
  const bands: RGB[] = [];
  for (let i = 0; i < bandCount; i++) {
    // Polar bands darken toward the caps; the equator is the brightest zone.
    const lat = Math.abs(i / (bandCount - 1) - 0.5) * 2;
    const zone = i % 2 === 0;
    const b = zone ? f.zone : f.belt;
    const hue = (b[0] + s.range(-f.spread, f.spread) + 360) % 360;
    const sat = Math.max(0, Math.min(1, b[1] * s.range(0.8, 1.2)));
    const val = Math.max(0, Math.min(1, b[2] * s.range(0.9, 1.05) * (1 - lat * lat * 0.28)));
    bands.push(hsvToRGB(hue, sat, val));
  }
  return bands;
}
/** The colour of a giant's great storm. */
export function gasStormColor(seed: number): RGB {
  const st = GAS_FAMILIES[gasFamilyOf(seed)].storm;
  return hsvToRGB(st[0], st[1], st[2]);
}
