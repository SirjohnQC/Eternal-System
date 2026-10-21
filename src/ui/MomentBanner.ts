/**
 * The great-moment banner (stage-moments plan, P1): a card that rises over
 * the top of the screen when life, the nations or the ages reach a new high.
 * It never blocks play: no backdrop, clicks pass through except on its own
 * close mark, and it fades by itself. Moments that land while one is showing
 * join it (at most three lines) rather than queue up.
 */
import type { StageMoment } from '../simulation/BigBangEngine';

const SHOW_MS = 9000;
const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

let el: HTMLElement | null = null;
let timer = 0;
let shown: StageMoment[] = [];

function root(): HTMLElement {
  if (el && el.isConnected) return el;
  el = document.createElement('div');
  el.id = 'moment-banner';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  return el;
}

function hide(): void {
  window.clearTimeout(timer);
  el?.classList.remove('show');
  document.body.classList.remove('moment-on');
  shown = [];
}

/** A naming dialog or other modal is up: a moment waits for it (alpha round 2, B4). */
const MODALS = ['#ingame-naming-overlay.open', '#speciation-overlay.open', '#first-contact-overlay.active'];
let waiting: StageMoment[] = [];
let waitTimer = 0;

export function showMoment(m: StageMoment): void {
  if (MODALS.some(q => document.querySelector(q))) {
    waiting.push(m);
    if (!waitTimer) waitTimer = window.setInterval(() => {
      if (MODALS.some(q => document.querySelector(q))) return;
      window.clearInterval(waitTimer); waitTimer = 0;
      const all = waiting; waiting = [];
      for (const w of all) present(w);
    }, 400);
    return;
  }
  present(m);
}

function present(m: StageMoment): void {
  const r = root();
  const joining = r.classList.contains('show');
  shown = joining ? [...shown, m].slice(-3) : [m];
  const head = shown[shown.length - 1];
  const earlier = shown.slice(0, -1);
  r.innerHTML = `
    <button type="button" class="mb-x" aria-label="Dismiss">✕</button>
    <img class="mb-icon" src="/assets/pixel/divine/cards/${esc(head.icon)}.png" alt="" width="32" height="32"/>
    <div class="mb-body">
      <div class="mb-kicker">${head.kind === 'era' || head.kind === 'leap' ? 'A NEW AGE' : head.kind === 'fall' ? 'A FALL' : head.kind === 'turn' ? 'A TURNING POINT' : head.kind === 'nations' ? 'A GREAT MOMENT · NATIONS' : 'A GREAT MOMENT · LIFE'}</div>
      <div class="mb-title">${esc(head.title)}</div>
      <div class="mb-line">${esc(head.line)}</div>
      ${head.learned?.length ? `<div class="mb-learned">Learned: ${head.learned.map(esc).join(' · ')}</div>` : ''}
      ${earlier.length ? `<div class="mb-earlier">${earlier.map(e => `<span>${esc(e.title)}</span>`).join(' → ')} → <b>${esc(head.title)}</b></div>` : ''}
      <div class="mb-hint">The world slows to ▶ so you can watch. Speed up whenever you like.</div>
    </div>`;
  r.querySelector('.mb-x')?.addEventListener('click', hide);
  // Restart the rise when it was hidden; a joining moment only refreshes the text.
  if (!joining) { r.classList.remove('show'); void r.offsetWidth; }
  r.classList.add('show');
  document.body.classList.add('moment-on');   // toasts step down out of its lane
  window.clearTimeout(timer);
  timer = window.setTimeout(hide, SHOW_MS);
}
