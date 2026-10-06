/**
 * The player's hand of procedural Faith Cards (docs/CORE_LOOP_VISION.md §10–13),
 * shown in the Faith deck ahead of the fixed cosmic cards.
 *
 *  - SEEK A SIGN spends DP and offers three cards drawn from what the world is
 *    going through now; the player keeps one (or none).
 *  - A hand card casts on click: its target is read from the world as it is
 *    then, and each nation named may heed it or not.
 *  - THE CRUCIBLE burns two cards into one new card (fusion, refinement, or
 *    something wild) — shown only after the fact.
 *
 * The hand lives in gameState (saved); what a card does lives in the nations
 * (runtime). Hovering a card shows its anatomy.
 */
import { gameState, runtimeState } from '../simulation/GameState';
import {
  discover, forge, cast, signalsOf, describe, anatomy, isBane, iconOf,
  DURATIONS, type FaithCard, type ForgeKind, type ActionId,
} from '../simulation/FaithCards';
import { SeedRNG } from '../utils/SeedRNG';
import type { DivineEffectKind } from '../rendering/IsoDioramaRenderer';

export const SEEK_COST = 6;
export const HAND_MAX = 6;

export interface FaithHandDeps {
  chat(text: string, kind: 'god' | 'system'): void;
  /** DP changed: refresh chips and the rest of the deck. */
  dpChanged(): void;
  tick(): number;
  /** Show a card taking hold on the diorama (at a capital, if any). */
  effect?(kind: DivineEffectKind, cell: { row: number; col: number } | null): void;
}

let deps: FaithHandDeps | null = null;
let burnPick: string[] | null = null;
let lastSig = '';

const hand = (): FaithCard[] => (gameState.faithHand ??= []);
const rng = (what: string) => new SeedRNG(`${gameState.masterSeed}:faith:${what}:${gameState.faithSeq = (gameState.faithSeq ?? 0) + 1}`);
const nationsReady = () => !!runtimeState.playerNations?.isFounded && runtimeState.playerNations.nations.some(n => !n.fallen);

const EFFECT_OF: Record<ActionId, DivineEffectKind> = {
  harvest: 'bless', fertility: 'fertility', inspire: 'sight', veins: 'raise', cleanse: 'water',
  concord: 'prophet', discord: 'smite', zeal: 'revelation', calm: 'prophet', fervor: 'smite',
  exodus: 'nudge', blight: 'sink', pestilence: 'smite',
};

const KIND_LINE: Record<ForgeKind, string> = {
  fusion: 'The two burned into one: both purposes, both prices.',
  refinement: 'One purpose survived the fire, and came out stronger.',
  wild: 'The fire made something neither card held.',
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
}

/** Card face markup (same chrome as the fixed deck). */
function face(c: FaithCard, big = false): string {
  const tone = isBane(c) ? 'faith-red' : c.forged ? 'faith-purple' : c.actions[0] === 'harvest' || c.actions[0] === 'fertility' || c.actions[0] === 'cleanse' ? 'faith-green' : 'faith-gold';
  return `<button class="divine-action-btn faith-proc ${tone}${big ? ' faith-proc-big' : ''}" data-card="${esc(c.id)}">
    <span class="faith-notch-tr"></span><span class="faith-notch-bl"></span>
    <span class="divine-action-name">${esc(c.name)}</span>
    <span class="faith-icon-wrap"><img class="faith-icon" src="/assets/pixel/divine/${iconOf(c)}.png" alt="" width="32" height="32"/></span>
    <span class="fc-meta"><span class="fc-pips">${[1, 2, 3].map(i => `<i${i <= c.magnitude ? ' class="on"' : ''}></i>`).join('')}</span>${DURATIONS[c.duration - 1].replace(/^an? /, '')}</span>
    <span class="divine-action-desc">${esc(describe(c))}</span>
    ${c.sides.length ? `<span class="faith-proc-side">${c.sides.length === 1 ? '1 price' : `${c.sides.length} prices`}</span>` : ''}
    ${c.forged ? `<span class="faith-proc-forged">${'✦'.repeat(Math.min(3, c.forged))}</span>` : ''}
    <span class="divine-action-cost">✦ ${c.cost} DP</span>
  </button>`;
}

function tipFor(c: FaithCard): string {
  return `<div class="ft-name">${esc(c.name)}</div>
    <div class="ft-desc">${esc(describe(c))}</div>
    <table>${anatomy(c).map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    <div class="ft-origin">${esc(c.origin)}</div>
    <div class="ft-cost">✦ ${c.cost} DP to cast</div>`;
}

function showTip(c: FaithCard, el: HTMLElement): void {
  let tip = document.getElementById('faith-tip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'faith-tip'; document.body.appendChild(tip); }
  tip.innerHTML = tipFor(c);
  tip.style.display = 'block';
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2))}px`;
  tip.style.top = `${Math.max(8, r.top - t.height - 10)}px`;
}
const hideTip = () => { const t = document.getElementById('faith-tip'); if (t) t.style.display = 'none'; };

/** Wire hover tips onto card faces inside `root`, looking cards up in `pool`. */
function wireTips(root: HTMLElement, pool: FaithCard[]): void {
  root.querySelectorAll<HTMLElement>('.faith-proc').forEach(el => {
    const c = pool.find(x => x.id === el.dataset['card']);
    if (!c) return;
    el.addEventListener('mouseenter', () => showTip(c, el));
    el.addEventListener('mouseleave', hideTip);
  });
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function modal(title: string, sub: string, body: string, footer: string): HTMLElement {
  document.getElementById('faith-modal')?.remove();
  hideTip();
  const m = document.createElement('div');
  m.id = 'faith-modal';
  m.innerHTML = `<div class="fm-box">
    <div class="fm-title">${title}</div><div class="fm-sub">${sub}</div>
    <div class="fm-cards">${body}</div><div class="fm-foot">${footer}</div></div>`;
  document.body.appendChild(m);
  return m;
}
const closeModal = () => { document.getElementById('faith-modal')?.remove(); hideTip(); };

function seek(): void {
  if (!deps) return;
  if (!nationsReady()) { deps.chat('There are no nations yet for a sign to fall upon.', 'system'); return; }
  if (hand().length >= HAND_MAX) { deps.chat('Your hand is full. Cast a card, or burn two in the crucible.', 'system'); return; }
  if (gameState.divinePoints < SEEK_COST) { deps.chat(`Seeking a sign takes ${SEEK_COST} DP.`, 'system'); return; }
  gameState.divinePoints -= SEEK_COST;
  deps.dpChanged();
  const r = rng('seek');
  const offer = discover(signalsOf(runtimeState.playerNations!), r, 3, `c${gameState.faithSeq}-${Math.floor(r.next() * 1e6).toString(36)}`);
  const m = modal('SIGNS IN THE DARK', 'The world shows you what it could become. Keep one.',
    offer.map(c => face(c, true)).join(''), '<button class="fm-btn" data-act="fade">LET THEM FADE</button>');
  wireTips(m, offer);
  m.querySelectorAll<HTMLElement>('.faith-proc').forEach(el => el.addEventListener('click', () => {
    const c = offer.find(x => x.id === el.dataset['card']);
    if (!c) return;
    hand().push(c);
    closeModal();
    deps!.chat(`You keep a sign: ${c.name}.`, 'god');
    refresh(true);
  }));
  m.querySelector('[data-act="fade"]')?.addEventListener('click', () => { closeModal(); deps!.chat('The signs fade unclaimed.', 'system'); });
}

function burn(a: FaithCard, b: FaithCard): void {
  if (!deps) return;
  const { card, kind } = forge(a, b, rng('forge'), `f${gameState.faithSeq}-${a.id.slice(-3)}${b.id.slice(-3)}`);
  gameState.faithHand = hand().filter(c => c !== a && c !== b);
  hand().push(card);
  burnPick = null;
  const m = modal('THE CRUCIBLE', esc(KIND_LINE[kind]),
    `<div class="fm-burned">${esc(a.name)} + ${esc(b.name)}</div>${face(card, true)}`,
    '<button class="fm-btn" data-act="keep">KEEP IT</button>');
  wireTips(m, [card]);
  m.querySelector('[data-act="keep"]')?.addEventListener('click', closeModal);
  deps.chat(`You burned ${a.name} and ${b.name}. From the ashes: ${card.name}.`, 'god');
  refresh(true);
}

function play(c: FaithCard): void {
  if (!deps) return;
  if (!nationsReady()) { deps.chat('There are no nations yet for a sign to fall upon.', 'system'); return; }
  if (gameState.divinePoints < c.cost) { deps.chat(`${c.name} takes ${c.cost} DP.`, 'system'); return; }
  gameState.divinePoints -= c.cost;
  const ns = runtimeState.playerNations!;
  const res = cast(ns, c, rng('cast'), deps.tick());
  gameState.faithHand = hand().filter(x => x !== c);
  deps.chat(res.line, 'god');
  if (res.heeded.length) deps.effect?.(EFFECT_OF[c.actions[0]], res.heeded[0].capital);
  hideTip();
  deps.dpChanged();
  refresh(true);
}

// ─── The deck ─────────────────────────────────────────────────────────────────

/** Re-render the hand into the Faith deck (skipped when nothing visible changed). */
export function refresh(force = false): void {
  const panel = document.getElementById('faith-panel');
  if (!panel || !deps) return;
  const dp = gameState.divinePoints, ready = nationsReady();
  const sig = `${dp >= SEEK_COST}|${ready}|${burnPick?.join(',') ?? '-'}|${hand().map(c => `${c.id}:${dp >= c.cost}`).join(',')}`;
  if (!force && sig === lastSig && panel.querySelector('#faith-seek-btn')) return;
  lastSig = sig;
  hideTip();   // the card it hung over is about to be replaced
  panel.querySelectorAll('.faith-hand-el').forEach(el => el.remove());
  const burning = !!burnPick;
  const seekHtml = `<button class="divine-action-btn faith-violet faith-hand-el${ready && dp >= SEEK_COST && hand().length < HAND_MAX ? ' affordable' : ' faith-off'}" id="faith-seek-btn">
    <span class="faith-notch-tr"></span><span class="faith-notch-bl"></span>
    <span class="divine-action-name">SEEK A SIGN</span>
    <span class="faith-icon-wrap"><img class="faith-icon" src="/assets/pixel/divine/sight.png" alt="" width="32" height="32"/></span>
    <span class="divine-action-desc">${ready ? `Glimpse what the world could become. ${hand().length}/${HAND_MAX} in hand.` : 'No nations yet for a sign to fall upon.'}</span>
    <span class="divine-action-cost">✦ ${SEEK_COST} DP</span></button>`;
  const cards = hand().map(c => face(c)).join('');
  const crucible = hand().length >= 2 ? `<button class="divine-action-btn faith-orange faith-hand-el${burning ? ' selected' : ' affordable'}" id="faith-crucible-btn">
    <span class="faith-notch-tr"></span><span class="faith-notch-bl"></span>
    <span class="divine-action-name">THE CRUCIBLE</span>
    <span class="faith-icon-wrap"><img class="faith-icon" src="/assets/pixel/divine/smite.png" alt="" width="32" height="32"/></span>
    <span class="divine-action-desc">${burning ? `Choose ${2 - burnPick!.length} more to burn. Click here to stop.` : 'Burn two cards to forge one you cannot foresee.'}</span>
    <span class="divine-action-cost">${burning ? '✕ CANCEL' : '✦ FREE'}</span></button>` : '';
  const holder = document.createElement('div');
  holder.innerHTML = seekHtml + cards + crucible;
  const els = [...holder.children] as HTMLElement[];
  els.forEach(el => el.classList.add('faith-hand-el'));
  panel.prepend(...els);
  panel.classList.toggle('faith-burning', burning);
  for (const el of els) {
    const c = hand().find(x => x.id === el.dataset['card']);
    if (c) {
      el.classList.toggle('affordable', dp >= c.cost && ready);
      el.classList.toggle('faith-off', !(dp >= c.cost && ready) && !burning);
      el.classList.toggle('faith-pick', !!burnPick?.includes(c.id));
      el.addEventListener('mouseenter', () => showTip(c, el));
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('click', () => {
        if (panel.closest('.faith-deck')?.classList.contains('folded')) return;
        if (burnPick) {
          burnPick = burnPick.includes(c.id) ? burnPick.filter(x => x !== c.id) : [...burnPick, c.id];
          if (burnPick.length === 2) {
            const [a, b] = burnPick.map(id => hand().find(x => x.id === id)!);
            burn(a, b);
          } else refresh(true);
          return;
        }
        play(c);
      });
    }
  }
  holder.remove();
  document.getElementById('faith-seek-btn')?.addEventListener('click', () => {
    if (panel.closest('.faith-deck')?.classList.contains('folded')) return;
    seek();
  });
  document.getElementById('faith-crucible-btn')?.addEventListener('click', () => {
    if (panel.closest('.faith-deck')?.classList.contains('folded')) return;
    burnPick = burnPick ? null : [];
    refresh(true);
  });
}

export function initFaithHand(d: FaithHandDeps): void {
  deps = d;
  refresh(true);
}
