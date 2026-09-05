import { SeedRNG } from '../utils/SeedRNG';

export type FlagSymbol = 'star' | 'cross' | 'spiral' | 'flame' | 'eye' | 'wave';

export interface FactionFlag {
  primaryColor: string;
  secondaryColor: string;
  symbol: FlagSymbol;
}

// ─── Color pool ──────────────────────────────────────────────────────────────

const FLAG_COLORS: string[] = [
  '#c0392b', // crimson
  '#2980b9', // cobalt
  '#27ae60', // forest green
  '#8e44ad', // violet
  '#d35400', // burnt orange
  '#16a085', // teal
  '#f39c12', // amber
  '#2c3e50', // dark navy
  '#bdc3c7', // silver
  '#e8d44d', // gold
];

// ─── Symbol → unicode character mapping ──────────────────────────────────────
// Using reliable ASCII/Latin-1 glyphs that render consistently on Canvas 2D.

const SYMBOL_CHARS: Record<FlagSymbol, string> = {
  star:   '\u2605', // ★  BLACK STAR
  cross:  '+',
  spiral: '@',
  flame:  '^',
  eye:    'O',
  wave:   '~',
};

const ALL_SYMBOLS: FlagSymbol[] = ['star', 'cross', 'spiral', 'flame', 'eye', 'wave'];

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Generates a randomised faction flag using a seeded RNG.
 * Guarantees primaryColor !== secondaryColor.
 */
export function generateFactionFlag(rng: SeedRNG): FactionFlag {
  const primaryIdx   = rng.nextInt(0, FLAG_COLORS.length - 1);
  let secondaryIdx   = rng.nextInt(0, FLAG_COLORS.length - 1);

  // Ensure the two colors differ
  if (secondaryIdx === primaryIdx) {
    secondaryIdx = (secondaryIdx + 1) % FLAG_COLORS.length;
  }

  const symbol: FlagSymbol = rng.pick(ALL_SYMBOLS);

  return {
    primaryColor:   FLAG_COLORS[primaryIdx],
    secondaryColor: FLAG_COLORS[secondaryIdx],
    symbol,
  };
}

// ─── Canvas renderer ─────────────────────────────────────────────────────────

/**
 * Draws a small faction flag icon centred at (cx, cy).
 *
 * @param ctx   Canvas 2D rendering context
 * @param flag  FactionFlag to draw
 * @param cx    Centre x coordinate
 * @param cy    Centre y coordinate
 * @param size  Base size — flag will be size*1.5 wide × size tall
 */
export function drawFactionFlag(
  ctx: CanvasRenderingContext2D,
  flag: FactionFlag,
  cx: number,
  cy: number,
  size: number,
): void {
  if (size <= 0) return;
  const flagW  = size * 1.5;
  const flagH  = size;
  const left   = cx - flagW / 2;
  const top    = cy - flagH / 2;

  ctx.save();

  // Filled rectangle in primary color
  ctx.fillStyle = flag.primaryColor;
  ctx.fillRect(left, top, flagW, flagH);

  // Border in secondary color
  ctx.strokeStyle = flag.secondaryColor;
  ctx.lineWidth   = size * 0.08;
  ctx.strokeRect(left, top, flagW, flagH);

  // Symbol centred on flag
  const char     = SYMBOL_CHARS[flag.symbol];
  const fontSize = Math.round(size * 0.65);
  ctx.fillStyle  = flag.secondaryColor;
  ctx.font       = `bold ${fontSize}px monospace`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(char, cx, cy);

  ctx.restore();
}
