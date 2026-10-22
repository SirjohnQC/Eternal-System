/**
 * Full-card art (owner's ask, Oct 21): every card's picture fills the card
 * inside its frame, instead of a small icon that loaded after the card.
 *
 * All the pictures are one atlas, public/assets/pixel/divine/cards/frames/
 * card_art.webp (SpriteCook, five 4x2 sheets, sliced to 8x5 tiles
 * of 120x240), loaded and decoded once at launch with the frames
 * (IconPreload): a card can no longer appear before its art.
 */

export const CARD_ART_URL = '/assets/pixel/divine/cards/frames/card_art.webp';
const COLS = 8, ROWS = 5;

/** Tile index in the atlas, by icon name (the names the cards already use). */
const ART: Record<string, number> = {
  awaken: 0,
  blight: 1,
  calm: 2,
  cleanse: 3,
  comet: 4,
  concord: 5,
  crucible: 6,
  cure: 7,
  discord: 8,
  drought: 9,
  exodus: 10,
  fertility: 11,
  fervor: 12,
  foe: 13,
  golden: 14,
  hardy: 15,
  harvest: 16,
  herds: 17,
  ice_age: 18,
  inspire: 19,
  meteor: 20,
  murrain: 21,
  mutate: 22,
  pestilence: 23,
  quake: 24,
  rains: 25,
  revolt: 26,
  schism: 27,
  seafaring: 28,
  seed: 29,
  seek: 30,
  sight: 31,
  terraform: 32,
  theft: 33,
  veins: 34,
  volcano: 35,
  zeal: 36,
  evolution: 37,
  prophet: 38,
  smite: 39,
};

/** Icon names that share another's picture. */
const ALIAS: Record<string, string> = { revelation: 'awaken', golden_card: 'golden' };

/** The atlas tile for an icon name ('cards/blight', 'prophet', 'ice_age'…), or null. */
export function artTile(icon: string): number | null {
  const name = icon.replace(/^.*\//, '');
  const k = ART[name] ?? ART[ALIAS[name] ?? ''];
  return k == null ? null : k;
}

/**
 * The picture of a card, filling it (CSS .card-art). `cls` keeps the old
 * wrapper class so existing layouts still find it; with no tile it falls back
 * to the old small icon.
 */
export function cardArt(icon: string, cls = 'faith-icon-wrap', fallbackSrc = ''): string {
  const k = artTile(icon);
  if (k == null) return fallbackSrc ? `<span class="${cls}"><img class="faith-icon" src="${fallbackSrc}" alt="" width="32" height="32"/></span>` : `<span class="${cls}"></span>`;
  const x = k % COLS, y = Math.floor(k / COLS);
  return `<span class="${cls} card-art" aria-hidden="true"><i style="background-position:${(x / (COLS - 1) * 100).toFixed(4)}% ${(y / (ROWS - 1) * 100).toFixed(4)}%"></i></span>`;
}

export const CARD_ART_COLS = COLS;
export const CARD_ART_ROWS = ROWS;
