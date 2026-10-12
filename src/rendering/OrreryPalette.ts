/**
 * Colours of planet types in the system panel's orrery (main.ts drawSystemOrrery).
 *
 * Every planet type has an entry — `Record<PlanetKind, …>` makes a missing
 * one a compile error — and every colour is six-digit hex, because the
 * orrery appends two alpha digits ('55', 'bb'). A type without an entry used
 * to fall back to '#888', so its glow became '#88855': the canvas threw and
 * the system panel never opened (clicking a sun did nothing).
 */
import type { PlanetKind } from '../simulation/LifeSystem';

export const ORRERY_COLORS: Record<PlanetKind, string> = {
  rocky: '#c8a96e', ocean: '#44aaff', gas: '#bb88ff', ice: '#aaddff', lava: '#ff4422',
  toxic: '#9acd32', crystal: '#c8a0ff', desert: '#e0b060', storm: '#7890c0', carbon: '#5a5048',
  mechanical: '#a0a8b0',
};

/** Any colour in the orrery takes a two-digit alpha suffix, so it must be '#rrggbb'. */
export const ORRERY_FALLBACK = '#888888';

export function orreryColor(type: string): string {
  return (ORRERY_COLORS as Record<string, string>)[type] ?? ORRERY_FALLBACK;
}
