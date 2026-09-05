/**
 * speciesPalette — stable, well-spread colours per species.
 *
 * Extracted from `main.ts` so the surface map's species layer can be checked
 * headlessly (`tools/mapLayerCheck.ts`) rather than only by looking at it. Pure
 * functions of a species id, with no DOM dependency.
 */

/** Cached colours, so a lineage keeps its colour between redraws. */
const colorCache = new Map<string, string>();
/**
 * The same colours pre-parsed to 0–255 RGB.
 *
 * The species layer colours every one of the grid's 65,536 cells; re-parsing an
 * `hsl(...)` string with a regex per cell costs more than the rest of the draw
 * put together.
 */
const rgbCache = new Map<string, [number, number, number]>();

/** A stable colour for a species id. */
export function speciesColor(id: string): string {
  const cached = colorCache.get(id);
  if (cached) return cached;

  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Golden-angle hue rotation, so ids that hash close together still land far
  // apart on the wheel. A plain `hash % 360` clusters sibling species — and
  // sibling species are exactly the ones a player needs to tell apart, since
  // speciation names them similarly too.
  const hue = (((h >>> 0) % 360) + 137.508 * ((h >>> 8) % 7)) % 360;
  const sat = 58 + ((h >>> 16) % 22);
  const lig = 52 + ((h >>> 20) % 14);
  const col = `hsl(${hue.toFixed(0)},${sat}%,${lig}%)`;
  colorCache.set(id, col);
  return col;
}

/** The same colour as 0–255 RGB, cached. */
export function speciesRGB(id: string): [number, number, number] {
  let v = rgbCache.get(id);
  if (!v) { v = hslToRgb(speciesColor(id)); rgbCache.set(id, v); }
  return v;
}

/** Hue in degrees for a species, for separation checks. */
export function speciesHue(id: string): number {
  const m = /hsl\((\d+(?:\.\d+)?),/.exec(speciesColor(id));
  return m ? Number(m[1]) : 0;
}

/**
 * Species ids are per-universe, so these caches must be cleared with the rest of
 * the game state. Leaking state across games in one session is the most repeated
 * bug in this codebase — see ROADMAP M20b.
 */
export function clearSpeciesPalette(): void {
  colorCache.clear();
  rgbCache.clear();
}

/** Parse the `hsl(...)` strings `speciesColor` produces into 0–255 RGB. */
export function hslToRgb(css: string): [number, number, number] {
  const m = /hsl\((\d+(?:\.\d+)?),\s*(\d+)%,\s*(\d+)%\)/.exec(css);
  if (!m) return [200, 200, 200];
  const h = Number(m[1]) / 360, sat = Number(m[2]) / 100, l = Number(m[3]) / 100;
  if (sat === 0) return [l * 255, l * 255, l * 255];

  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}
