/**
 * Tech cards: what the player's people have learned (TP) spent on what only
 * knowledge can do (#40; docs/plans/2026-10-14-tech-cards.md). Opened from the
 * TP chip in the top bar.
 *
 * The hand shows every card your nations' knowledge has opened, by age, and a
 * sealed count for the rest. A card opens to its detail (what it does, its
 * price, which nations it acts on) and plays from there. A NEW WORLD and
 * REMAKE A WORLD ask where / what first. The engine does every act
 * (BigBangEngine.playTechCard, relocateHome); this module only offers them.
 */
import { gameState } from '../simulation/GameState';
import { RELOCATE_STAR_ERA, type RelocationTarget, type BigBangEngine } from '../simulation/BigBangEngine';
import { ageName } from '../simulation/Progression';

export interface TechCardDeps {
  engine(): BigBangEngine | null;
  /** TP changed: refresh the chip. */
  tpChanged(): void;
  /** The people moved (to another star: `far`): views of the old home must close. */
  moved(line: string, far: boolean): void;
  /** A card was played: tell the player what happened. */
  played(line: string): void;
}

type View = ReturnType<BigBangEngine['techCardViews']>[number];

let deps: TechCardDeps | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

/** How the people would fare there, in a word. */
function harshness(t: RelocationTarget): string {
  return t.suitability >= 0.6 ? 'kind' : t.suitability >= 0.3 ? 'fair' : t.suitability >= 0.15 ? 'harsh' : 'brutal';
}

function close(): void { document.getElementById('tech-modal')?.remove(); }

function modal(title: string, sub: string, body: string, footer: string, wide = false): HTMLElement {
  close();
  const m = document.createElement('div');
  m.id = 'tech-modal';
  m.innerHTML = `<div class="tm-box${wide ? ' tm-wide' : ''}">
    <div class="tm-title">${title}</div><div class="tm-sub">${sub}</div>
    <div class="tm-body">${body}</div><div class="tm-foot">${footer}</div></div>`;
  m.addEventListener('click', e => { if (e.target === m) close(); });
  document.body.appendChild(m);
  m.querySelectorAll<HTMLElement>('[data-act="close"]').forEach(b => b.addEventListener('click', close));
  m.querySelector<HTMLElement>('[data-act="back"]')?.addEventListener('click', openTechCards);
  return m;
}

/** A card face (the hand and the detail use the same face). */
function face(v: View, big = false): string {
  const off = !!v.block;
  return `<button class="divine-action-btn faith-proc${big ? ' faith-proc-big' : ''} tech-card${off ? ' faith-off' : ' affordable'}" data-card="${v.card.id}">
    <span class="faith-notch-tr"></span><span class="faith-notch-bl"></span>
    <span class="divine-action-name">${esc(v.card.name)}</span>
    <span class="faith-icon-wrap"><img class="faith-icon" src="/assets/pixel/divine/cards/${v.card.icon}.png" alt="" width="32" height="32"/></span>
    <span class="divine-action-desc">${esc(v.card.does)}</span>
    <span class="divine-action-cost">◆ ${v.price} TP</span></button>`;
}

/** The hand of tech cards, by age. */
export function openTechCards(): void {
  const eng = deps?.engine();
  if (!eng) return;
  const views = eng.techCardViews();
  const open = views.filter(v => v.unlocked).length;
  // Ages up to one past the furthest open card are shown one by one; the rest fold into one line.
  const reach = Math.max(1, ...views.filter(v => v.unlocked).map(v => v.age)) + 1;
  const ages = [...new Set(views.map(v => v.age))].sort((a, b) => a - b).filter(a => a <= reach);
  const later = views.filter(v => v.age > reach).length;
  const body = ages.map(age => {
    const here = views.filter(v => v.age === age);
    const shown = here.filter(v => v.unlocked);
    const sealed = here.length - shown.length;
    if (!shown.length && !sealed) return '';
    return `<div class="tm-age">
      <div class="tm-group">${esc(ageName(age).toUpperCase())}${sealed ? ` · <span class="tm-sealed">${sealed} sealed</span>` : ''}</div>
      <div class="tm-row">${shown.map(v => face(v)).join('')}${!shown.length ? '<div class="tm-none">Your nations do not know enough yet.</div>' : ''}</div>
    </div>`;
  }).join('') + (later ? `<div class="tm-age"><div class="tm-group">LATER AGES · <span class="tm-sealed">${later} sealed</span></div></div>` : '');
  const sub = open
    ? `What your people know, put to use. You hold <b>${gameState.techPoints} TP</b>. Each new technology your nations learn earns 1, each new age 3.`
    : `Your nations know nothing a card can use yet. Each new technology they learn opens cards and earns 1 TP; each new age, 3. You hold <b>${gameState.techPoints} TP</b>.`;
  const m = modal('TECH CARDS', sub, `<div class="tm-hand">${body}</div>`, '<button class="fm-btn" data-act="close">CLOSE</button>', true);
  m.querySelectorAll<HTMLElement>('.tech-card').forEach(el => el.addEventListener('click', () => {
    const v = views.find(x => x.card.id === el.dataset['card']);
    if (v) detail(v);
  }));
}

/** One card: what it does, its price, who it acts on; play it from here. */
function detail(v: View): void {
  const eng = deps?.engine();
  if (!eng) return;
  const acts = v.card.who === 'world' ? '' : v.acts.length
    ? `<div class="tm-acts"><b>Acts on:</b> ${v.card.who === 'all' ? 'every nation' : esc(v.acts.join(', '))}</div>`
    : '<div class="tm-acts">No nation knows how yet.</div>';
  const info = `<div class="tm-detail">${face(v, true)}<div class="tm-text">
      <div class="tm-price"><b>Price:</b> ${esc(v.card.priceText)}</div>${acts}
      ${v.block ? `<div class="tm-block">${esc(v.block)}</div>` : ''}
    </div></div>`;
  const label = v.card.special === 'new_world' ? 'CHOOSE A WORLD' : v.card.special === 'terraform' ? 'CHOOSE WHAT IT BECOMES' : `PLAY · ${v.price} TP`;
  const m = modal(esc(v.card.name), '', info,
    `<button class="fm-btn" data-act="back">BACK</button><button class="fm-btn tm-go" data-act="play"${v.block ? ' disabled' : ''}>${label}</button>`);
  m.querySelector<HTMLElement>('[data-act="play"]')?.addEventListener('click', () => {
    if (v.card.special === 'new_world') { pickWorld(); return; }
    if (v.card.special === 'terraform') { pickTerraform(v); return; }
    const line = eng.playTechCard(v.card.id);
    close();
    deps?.tpChanged();
    if (line) deps?.played(line);
  });
}

/** REMAKE A WORLD: what the home world should become. */
function pickTerraform(v: View): void {
  const eng = deps?.engine();
  const opts = eng?.getTerraformInfo()?.options ?? [];
  if (!eng || !opts.length) return;
  const m = modal(esc(v.card.name), 'What should your world become? It changes over several stages.',
    `<div class="tm-worlds">${opts.map(o => `<button class="tm-world" data-t="${esc(o.targetType)}">
      <span class="tm-world-name">${esc(o.targetType.toUpperCase())}</span>
      <span class="tm-world-type">${esc(o.label)} · ${o.stages.length} stages</span></button>`).join('')}</div>`,
    `<button class="fm-btn" data-act="back">BACK</button><button class="fm-btn tm-go" data-act="go" disabled>REMAKE · ${v.price} TP</button>`);
  const go = m.querySelector<HTMLButtonElement>('[data-act="go"]')!;
  let chosen: string | null = null;
  m.querySelectorAll<HTMLElement>('.tm-world').forEach(el => el.addEventListener('click', () => {
    m.querySelectorAll('.tm-world').forEach(x => x.classList.remove('selected'));
    el.classList.add('selected');
    chosen = el.dataset['t'] ?? null;
    go.disabled = !chosen;
  }));
  go.addEventListener('click', () => {
    if (!chosen) return;
    const line = eng.playTechCard(v.card.id, chosen);
    close();
    deps?.tpChanged();
    if (line) deps?.played(line);
  });
}

/** Worlds of other stars offered at once (the kindest first). */
const OTHER_STARS_SHOWN = 10;

/** A NEW WORLD: choose where the people go, then confirm. */
function pickWorld(): void {
  const eng = deps?.engine();
  if (!eng) return;
  const all = eng.relocationTargets();
  const home = all.filter(t => !t.otherStar);
  const far = all.filter(t => t.otherStar).slice(0, OTHER_STARS_SHOWN);
  const targets = [...home, ...far];
  if (!targets.length) {
    modal('A NEW WORLD', 'No world you know has ground to stand on that is free to take.', '',
      '<button class="fm-btn" data-act="back">BACK</button>');
    return;
  }
  const key = (t: RelocationTarget) => `${t.starId}:${t.planetIndex}`;
  let chosen: RelocationTarget | null = null;
  const row = (t: RelocationTarget) => `<button class="tm-world" data-k="${key(t)}">
      <span class="tm-world-name">${esc(/^[IVX]+$/.test(t.name) && t.otherStar ? `${t.starName} ${t.name}` : t.name)}</span>
      <span class="tm-world-type">${esc(t.type)} · orbit ${t.planetIndex + 1}${t.otherStar ? ` of ${esc(t.starName)}` : ''}</span>
      <span class="tm-world-harsh tm-${harshness(t)}">${harshness(t).toUpperCase()}</span>
      ${t.colony ? '<span class="tm-world-note">your settlers are there</span>' : ''}
    </button>`;
  const section = (title: string, list: RelocationTarget[]) =>
    list.length ? `<div class="tm-group">${title}</div>${list.map(row).join('')}` : '';
  const anyFar = all.some(t => t.otherStar) || (eng.getPlayerStar()?.civLevel ?? 0) >= RELOCATE_STAR_ERA;
  const sub = anyFar
    ? 'Where will your people go? Your own system, or across the dark to another star. The whole people crosses; nothing is left behind but the wild.'
    : 'Where will your people go? The whole people crosses; nothing is left behind but the wild.';
  const m = modal('A NEW WORLD', sub,
    `<div class="tm-worlds">${section('YOUR SYSTEM', home)}${section(`OTHER STARS${all.filter(t => t.otherStar).length > far.length ? ` · the ${far.length} kindest` : ''}`, far)}</div>`,
    `<button class="fm-btn" data-act="back">NOT YET</button><button class="fm-btn tm-go" data-act="go" disabled>CROSS OVER · ${eng.newWorldPrice()} TP</button>`);
  const go = m.querySelector<HTMLButtonElement>('[data-act="go"]')!;
  m.querySelectorAll<HTMLElement>('.tm-world').forEach(el => el.addEventListener('click', () => {
    m.querySelectorAll('.tm-world').forEach(x => x.classList.remove('selected'));
    el.classList.add('selected');
    chosen = targets.find(t => key(t) === el.dataset['k']) ?? null;
    go.disabled = !chosen;
  }));
  go.addEventListener('click', () => {
    if (!chosen) return;
    const line = eng.relocateHome(chosen.starId, chosen.planetIndex);
    close();
    deps?.tpChanged();
    if (line) deps?.moved(line, chosen.otherStar);
  });
}

export function initTechCards(d: TechCardDeps): void {
  deps = d;
}
