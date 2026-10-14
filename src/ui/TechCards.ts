/**
 * Tech cards: what the player's people have learned (TP) spent on what only
 * knowledge can do (#40). Opened from the TP chip in the top bar.
 *
 * The first card is A NEW WORLD (Space Age): the whole people leaves its
 * world for another one in the same system. The engine does the move
 * (BigBangEngine.relocateHome); this module only offers it and asks where.
 */
import { gameState } from '../simulation/GameState';
import { RELOCATE_TP, type RelocationTarget, type BigBangEngine } from '../simulation/BigBangEngine';

export interface TechCardDeps {
  engine(): BigBangEngine | null;
  /** TP changed: refresh the chip. */
  tpChanged(): void;
  /** The people moved: views of the old home must close. */
  moved(line: string): void;
}

let deps: TechCardDeps | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

/** How the people would fare there, in a word. */
function harshness(t: RelocationTarget): string {
  return t.suitability >= 0.6 ? 'kind' : t.suitability >= 0.3 ? 'fair' : t.suitability >= 0.15 ? 'harsh' : 'brutal';
}

function close(): void { document.getElementById('tech-modal')?.remove(); }

function modal(title: string, sub: string, body: string, footer: string): HTMLElement {
  close();
  const m = document.createElement('div');
  m.id = 'tech-modal';
  m.innerHTML = `<div class="tm-box">
    <div class="tm-title">${title}</div><div class="tm-sub">${sub}</div>
    <div class="tm-body">${body}</div><div class="tm-foot">${footer}</div></div>`;
  m.addEventListener('click', e => { if (e.target === m) close(); });
  document.body.appendChild(m);
  m.querySelector<HTMLElement>('[data-act="close"]')?.addEventListener('click', close);
  return m;
}

/** The hand of tech cards. */
export function openTechCards(): void {
  const eng = deps?.engine();
  if (!eng) return;
  const block = eng.relocationBlock();
  const card = `<button class="divine-action-btn faith-proc faith-proc-big tech-card${block ? ' faith-off' : ' affordable'}" data-card="new-world">
    <span class="faith-notch-tr"></span><span class="faith-notch-bl"></span>
    <span class="divine-action-name">A NEW WORLD</span>
    <span class="faith-icon-wrap"><img class="faith-icon" src="/assets/pixel/divine/cards/exodus.png" alt="" width="32" height="32"/></span>
    <span class="divine-action-desc">${esc(block ?? 'Your whole people leaves its world for another in your system. They keep what they know; their old world is left to the wild.')}</span>
    <span class="divine-action-cost">◆ ${RELOCATE_TP} TP</span></button>`;
  const m = modal('TECH CARDS', `What your people have learned, spent. You hold <b>${gameState.techPoints} TP</b>.`,
    card, '<button class="fm-btn" data-act="close">CLOSE</button>');
  m.querySelector('[data-card="new-world"]')?.addEventListener('click', () => { if (!eng.relocationBlock()) pickWorld(); });
}

/** A NEW WORLD: choose where the people go, then confirm. */
function pickWorld(): void {
  const eng = deps?.engine();
  if (!eng) return;
  const targets = eng.relocationTargets();
  if (!targets.length) {
    modal('A NEW WORLD', 'No world in your system has ground to stand on that is free to take.', '',
      '<button class="fm-btn" data-act="close">CLOSE</button>');
    return;
  }
  let chosen: RelocationTarget | null = null;
  const rows = targets.map(t => `<button class="tm-world" data-i="${t.planetIndex}">
      <span class="tm-world-name">${esc(t.name)}</span>
      <span class="tm-world-type">${esc(t.type)} · orbit ${t.planetIndex + 1}</span>
      <span class="tm-world-harsh tm-${harshness(t)}">${harshness(t).toUpperCase()}</span>
      ${t.colony ? '<span class="tm-world-note">your settlers are there</span>' : ''}
    </button>`).join('');
  const m = modal('A NEW WORLD', 'Where will your people go? The whole people crosses; nothing is left behind but the wild.',
    `<div class="tm-worlds">${rows}</div>`,
    `<button class="fm-btn" data-act="close">NOT YET</button><button class="fm-btn tm-go" data-act="go" disabled>CROSS OVER · ${RELOCATE_TP} TP</button>`);
  const go = m.querySelector<HTMLButtonElement>('[data-act="go"]')!;
  m.querySelectorAll<HTMLElement>('.tm-world').forEach(el => el.addEventListener('click', () => {
    m.querySelectorAll('.tm-world').forEach(x => x.classList.remove('selected'));
    el.classList.add('selected');
    chosen = targets.find(t => t.planetIndex === Number(el.dataset['i'])) ?? null;
    go.disabled = !chosen;
  }));
  go.addEventListener('click', () => {
    if (!chosen) return;
    const line = eng.relocateHome(chosen.planetIndex);
    close();
    deps?.tpChanged();
    if (line) deps?.moved(line);
  });
}

export function initTechCards(d: TechCardDeps): void {
  deps = d;
}
