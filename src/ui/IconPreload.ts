/**
 * Card icons (Faith cards, Fate cards, the divine actions) are small PNGs
 * under /assets/pixel/divine/. Fetched only when a card first shows, they
 * popped in a second or more after the card flipped. Load and decode them all
 * once at startup and keep them referenced, so the browser has them in its
 * memory cache when a card face is drawn.
 */
import { ACTIONS } from '../simulation/FaithCards';
import { FATE_CARDS } from '../simulation/Forge';

const held: HTMLImageElement[] = [];
let started = false;

/** Every divine icon URL the card faces use. */
export function divineIconUrls(): string[] {
  const names = new Set<string>(['seek', 'crucible', 'golden', 'seed']);
  for (const a of ACTIONS) { names.add(a.id); names.add(a.icon); }
  for (const f of FATE_CARDS) names.add(f.icon);
  const urls = [...names].map(n => `/assets/pixel/divine/cards/${n}.png`);
  // The fixed divine actions' own icons (one level up).
  for (const n of ['evolution', 'harvest', 'meteor', 'prophet', 'revelation', 'sight', 'smite', 'terraform']) urls.push(`/assets/pixel/divine/${n}.png`);
  return urls;
}

/** Start loading and decoding every card icon (idempotent; resolves when all settle). */
export function preloadDivineIcons(): Promise<void> {
  if (started || typeof Image === 'undefined') return Promise.resolve();
  started = true;
  return Promise.all(divineIconUrls().map(src => {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    held.push(img);
    // A missing icon must not hold anything up.
    return (img.decode ? img.decode() : Promise.resolve()).catch(() => undefined);
  })).then(() => undefined);
}
