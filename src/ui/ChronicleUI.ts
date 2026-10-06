/**
 * The Chronicle panel (docs/CORE_LOOP_VISION.md §15): every event the nations
 * lived through and every card the player cast, newest first. Pick an event
 * to see WHY it happened (its causes, walked backward as a tree), WHAT CAME
 * OF IT (what followed), and — when the player's own act lies at its roots —
 * YOUR HAND: "this began with your Bountiful Harvest, 1.4 ages ago."
 *
 * Reads runtimeState.playerNations; owns no state but the current selection.
 */
import { runtimeState } from '../simulation/GameState';
import type { NationSystem, HistoryEntry } from '../simulation/Nations';
import { causeTree, descendants, yourHand, whenOf, type CauseNode } from '../simulation/Chronicle';

type Filter = 'all' | 'hand' | number;
let filter: Filter = 'all';
let selected = 0;

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

function colorOf(ns: NationSystem, e: HistoryEntry): string {
  return e.kind === 'divine' ? '#e0b85c' : ns.nations[e.nation]?.color ?? '#6a5d7a';
}

function nameOf(ns: NationSystem, e: HistoryEntry): string {
  return e.kind === 'divine' ? 'Your hand' : ns.nations[e.nation]?.name ?? 'The world';
}

function row(ns: NationSystem, e: HistoryEntry): string {
  return `<button class="ch-row${e.kind === 'divine' ? ' ch-divine' : ''}${e.id === selected ? ' ch-sel' : ''}" data-id="${e.id}" style="--nc:${colorOf(ns, e)}">
    <span class="ch-row-what">${e.kind === 'divine' ? '✦ ' : ''}${esc(e.what)}</span>
    <span class="ch-row-meta">${e.causes.length ? `${e.causes.length} cause${e.causes.length > 1 ? 's' : ''}` : ''}</span></button>`;
}

function tree(ns: NationSystem, n: CauseNode, top = true): string {
  const e = n.entry;
  const self = top ? '' : `<button class="ch-node${e.kind === 'divine' ? ' ch-divine' : ''}${n.seen ? ' ch-seen' : ''}" data-id="${e.id}" style="--nc:${colorOf(ns, e)}">
      <span class="ch-node-what">${e.kind === 'divine' ? '✦ ' : ''}${esc(e.what)}</span>${n.seen ? '<span class="ch-node-tag">see above</span>' : ''}</button>`;
  const kids = n.causes.length ? `<ul>${n.causes.map(c => `<li>${tree(ns, c, false)}</li>`).join('')}</ul>` : '';
  return top ? kids : self + kids;
}

function detail(ns: NationSystem, id: number): string {
  const e = ns.entry(id);
  if (!e) return '<div class="ch-empty">Pick an event to follow it back to its causes.</div>';
  const t = causeTree(ns, id, 6, 36);
  const hand = e.kind === 'divine' ? [] : yourHand(ns, id);
  const next = descendants(ns, id, 300);
  const direct = next.filter(x => x.causes.includes(id));
  const handHtml = hand.length ? `<div class="ch-hand">✦ <b>Your hand is in this.</b> It began with ${hand.slice(0, 3).map(h =>
    `<button class="ch-link" data-id="${h.id}">${esc(h.what.replace(/^You cast /, '').replace(/\.$/, ''))}</button>`).join(', ')}${hand.length > 3 ? ` and ${hand.length - 3} more` : ''}, ${esc(whenOf(ns, hand[0]).split(' · ')[1])}.</div>` : '';
  return `<div class="ch-head" style="--nc:${colorOf(ns, e)}">
      <div class="ch-who">${esc(nameOf(ns, e))}</div>
      <div class="ch-what">${esc(e.what)}</div>
      <div class="ch-when">${esc(whenOf(ns, e))}</div>
      ${e.because.length ? `<div class="ch-because">${e.because.map(b => `<span>${esc(b)}</span>`).join('')}</div>` : ''}
    </div>
    ${handHtml}
    <div class="ch-sect">WHY IT HAPPENED</div>
    ${t && t.causes.length ? `<div class="ch-tree">${tree(ns, t)}</div>` : `<div class="ch-empty">${e.kind === 'divine' ? 'Your own will. Nothing in the world made you do it.' : 'Nothing earlier is remembered to have caused it.'}</div>`}
    <div class="ch-sect">WHAT CAME OF IT</div>
    ${direct.length ? `<div class="ch-next">${direct.slice(0, 12).map(x => row(ns, x)).join('')}</div>` : '<div class="ch-empty">Nothing yet.</div>'}
    ${next.length > direct.length ? `<div class="ch-more">…and ${next.length - direct.length} more events after those.</div>` : ''}`;
}

function render(): void {
  const box = document.getElementById('chronicle');
  const ns = runtimeState.playerNations;
  if (!box) return;
  if (!ns?.isFounded) {
    box.querySelector('.ch-body')!.innerHTML = '<div class="ch-empty ch-pad">No nations yet. The chronicle begins when your people divide into nations.</div>';
    box.querySelector('.ch-filters')!.innerHTML = '';
    return;
  }
  const chips: Array<[Filter, string, string]> = [['all', 'ALL', '#8f7bc4'], ['hand', '✦ YOUR HAND', '#e0b85c'],
    ...ns.nations.map((n, i): [Filter, string, string] => [i, `${n.fallen ? '† ' : ''}${n.name}`, n.color])];
  box.querySelector('.ch-filters')!.innerHTML = chips.map(([f, label, c]) =>
    `<button class="ch-chip${filter === f ? ' on' : ''}" data-f="${f}" style="--nc:${c}">${esc(label)}</button>`).join('');
  const list = ns.chronicle.filter(e => filter === 'all' ? true : filter === 'hand' ? e.kind === 'divine' : e.nation === filter)
    .slice(-300).reverse();
  if (!selected || !ns.entry(selected)) selected = list[0]?.id ?? 0;
  box.querySelector('.ch-body')!.innerHTML = `<div class="ch-list">${list.length ? list.map(e => row(ns, e)).join('') : '<div class="ch-empty ch-pad">Nothing here yet.</div>'}</div>
    <div class="ch-detail">${detail(ns, selected)}</div>`;
  box.querySelectorAll<HTMLElement>('[data-id]').forEach(el => el.addEventListener('click', () => {
    selected = Number(el.dataset['id']);
    render();
    box.querySelector('.ch-detail')?.scrollTo({ top: 0 });
  }));
  box.querySelectorAll<HTMLElement>('[data-f]').forEach(el => el.addEventListener('click', () => {
    const f = el.dataset['f']!;
    filter = f === 'all' || f === 'hand' ? f : Number(f);
    selected = 0;
    render();
  }));
  box.querySelector('.ch-list .ch-sel')?.scrollIntoView({ block: 'nearest' });
}

/** Open the Chronicle, optionally on one nation's events and one event. */
export function openChronicle(opts: { nation?: number; entry?: number } = {}): void {
  let box = document.getElementById('chronicle');
  if (!box) {
    box = document.createElement('div');
    box.id = 'chronicle';
    box.innerHTML = `<div class="ch-frame">
      <div class="ch-top"><div class="ch-title">THE CHRONICLE</div>
        <div class="ch-sub">Every event remembers what caused it. Follow any of them back.</div>
        <button class="ch-close" type="button">✕</button></div>
      <div class="ch-filters"></div>
      <div class="ch-body"></div></div>`;
    document.body.appendChild(box);
    box.addEventListener('click', e => { if (e.target === box) closeChronicle(); });
    box.querySelector('.ch-close')!.addEventListener('click', closeChronicle);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('chronicle')?.classList.contains('open')) closeChronicle(); });
  }
  if (opts.nation != null) filter = opts.nation;
  if (opts.entry != null) selected = opts.entry;
  box.classList.add('open');
  render();
}

export function closeChronicle(): void {
  document.getElementById('chronicle')?.classList.remove('open');
  document.getElementById('rail-chronicle')?.classList.remove('active');
}
