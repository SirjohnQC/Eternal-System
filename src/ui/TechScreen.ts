/**
 * The technology screen (TP rework; playtest mockup Oct 20): what the
 * player's people know, as a tree, and what that knowledge lets the god do.
 *
 *  - THE TREE: every technology by age (one column each), with what it needs.
 *    Known (green), being studied (amber, with progress), open to study next
 *    (bright), not yet (dim). A ◆ marks the ones that open a TP card.
 *  - The selected technology: what it does, who knows it, what it opens.
 *  - TP CARDS: the cards your people's knowledge has opened; a card plays from
 *    its detail (ui/TechCards does the playing).
 *  - STUDYING NOW: what each nation is learning, and why.
 *  - THE PATH: the ages behind and ahead.
 *
 * Reads runtimeState.playerNations and the engine's card views; owns nothing
 * but the selection. Refreshes once a second while open.
 */
import { gameState, runtimeState } from '../simulation/GameState';
import { TECHS, TECH_BY_ID, type Tech } from '../simulation/Technology';
import { TECH_CARDS } from '../simulation/TechCards';
import { eraTitle } from '../simulation/Progression';
import type { BigBangEngine } from '../simulation/BigBangEngine';
import { techCardFace, openTechCardDetail } from './TechCards';

export interface TechScreenDeps {
  engine(): BigBangEngine | null;
}

let deps: TechScreenDeps | null = null;
let picked: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastSig = '';

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

/** The cards each technology opens (one or more). */
const CARDS_OF = new Map<string, typeof TECH_CARDS>();
for (const c of TECH_CARDS) if (c.needs.tech) CARDS_OF.set(c.needs.tech, [...(CARDS_OF.get(c.needs.tech) ?? []), c]);

const EFFECT_WORDS: Array<[keyof Tech['effect'], (v: number) => string | null]> = [
  ['food', v => v > 1 ? `+${Math.round((v - 1) * 100)}% food` : null],
  ['housing', v => v > 1 ? `+${Math.round((v - 1) * 100)}% room to live` : null],
  ['materials', v => v > 1 ? `+${Math.round((v - 1) * 100)}% wood, stone and ore` : null],
  ['knowledge', v => v > 1 ? `+${Math.round((v - 1) * 100)}% study` : v < 1 ? `−${Math.round((1 - v) * 100)}% study` : null],
  ['cohesion', v => v > 0 ? 'holds them together' : v < 0 ? 'pulls them apart' : null],
  ['pollution', v => v > 0 ? 'fouls the land' : v < 0 ? 'cleans the land' : null],
  ['inequality', v => v > 0 ? 'the few grow rich' : v < 0 ? 'narrows the gap' : null],
];

export function initTechScreen(d: TechScreenDeps): void { deps = d; }

export function openTechScreen(): void {
  if (!deps) return;
  ensureStyles();
  let box = document.getElementById('tech-screen');
  if (!box) {
    box = document.createElement('div');
    box.id = 'tech-screen';
    box.innerHTML = `<div class="ts-frame" role="dialog" aria-label="Technological advancement">
      <div class="ts-top"><span class="ts-title">TECHNOLOGICAL ADVANCEMENT</span><span class="ts-tp"></span></div>
      <div class="ts-body"></div>
      <div class="ts-foot"><button class="ts-btn" data-act="close" type="button">CLOSE</button></div></div>`;
    document.body.appendChild(box);
    box.addEventListener('click', e => {
      if (e.target === box) { closeTechScreen(); return; }
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-tech],[data-card]');
      if (!t) return;
      if (t.dataset.tech) { picked = t.dataset.tech; lastSig = ''; render(); }
      else if (t.dataset.card) openTechCardDetail(t.dataset.card);
      else if (t.dataset.act === 'close') closeTechScreen();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !document.getElementById('tech-modal')) closeTechScreen();
    });
  }
  box.classList.add('open');
  lastSig = '';
  render();
  if (!timer) timer = setInterval(render, 1000);
}

export function closeTechScreen(): void {
  document.getElementById('tech-screen')?.classList.remove('open');
  if (timer) { clearInterval(timer); timer = null; }
}

type NodeState = 'known' | 'studying' | 'open' | 'later';

function render(): void {
  const box = document.getElementById('tech-screen');
  const eng = deps?.engine();
  if (!box?.classList.contains('open') || !eng) return;
  const ns = runtimeState.playerNations;
  const live = ns?.isFounded ? ns.nations.filter(n => !n.fallen) : [];
  const known = new Set(live.flatMap(n => n.techs));
  const studying = new Map<string, number>();
  for (const n of live) if (n.research) studying.set(n.research.id, Math.max(studying.get(n.research.id) ?? 0, n.research.progress));
  const views = eng.techCardViews();
  const era = Math.max(0, ...live.map(n => n.era));
  const sig = [picked, gameState.techPoints, [...known].join(','), [...studying].map(([k, v]) => `${k}${v.toFixed(2)}`).join(','),
    views.map(v => `${v.card.id}${v.unlocked ? 1 : 0}${v.price}${v.block ?? ''}`).join('|')].join('#');
  if (sig === lastSig) return;
  lastSig = sig;
  (box.querySelector('.ts-tp') as HTMLElement).innerHTML = `<b>${gameState.techPoints}</b> TP`;
  const body = box.querySelector('.ts-body') as HTMLElement;
  if (!live.length) {
    body.innerHTML = `<div class="ts-empty">Your people have no nations yet, and no learning to speak of.<br>
      When they found their first nations, what they discover will grow here, and open cards only knowledge can play.</div>`;
    return;
  }

  const state = (t: Tech): NodeState => known.has(t.id) ? 'known' : studying.has(t.id) ? 'studying'
    : t.requires.every(r => known.has(r)) && t.era <= era + 1 ? 'open' : 'later';
  if (!picked || !TECH_BY_ID[picked]) picked = [...studying.keys()][0] ?? TECHS.find(t => state(t) === 'open')?.id ?? TECHS[0].id;

  const eras = [...new Set(TECHS.map(t => t.era))].sort((a, b) => a - b);
  const cols = eras.map(e => `<div class="ts-col${e === era ? ' now' : e > era + 1 ? ' far' : ''}">
      <div class="ts-col-h">${esc(eraTitle(e).toUpperCase())}</div>
      ${TECHS.filter(t => t.era === e).map(t => {
        const st = state(t), cards = CARDS_OF.get(t.id) ?? [];
        const prog = st === 'studying' ? `<span class="ts-prog" style="width:${Math.round((studying.get(t.id) ?? 0) * 100)}%"></span>` : '';
        return `<button type="button" class="ts-node ${st}${t.id === picked ? ' on' : ''}" data-tech="${t.id}" title="${esc(t.name)}">
          ${prog}<span class="ts-n">${esc(t.name)}</span>${cards.length ? `<span class="ts-c" aria-label="opens ${cards.length} card${cards.length > 1 ? 's' : ''}">${'◆'.repeat(cards.length)}</span>` : ''}</button>`;
      }).join('')}</div>`).join('');

  const pt = TECH_BY_ID[picked!];
  const pst = state(pt);
  const knowers = live.filter(n => n.techs.includes(pt.id)).map(n => n.name);
  const learners = live.filter(n => n.research?.id === pt.id);
  const opens = CARDS_OF.get(pt.id) ?? [];
  const effects = EFFECT_WORDS.map(([k, f]) => pt.effect[k] != null ? f(pt.effect[k]!) : null).filter(Boolean) as string[];
  const info = `<div class="ts-info">
      <div class="ts-info-h">${esc(pt.name)} <span>${esc(eraTitle(pt.era))}</span></div>
      <div class="ts-info-l">${effects.length ? esc(effects.join(' · ')) : 'Changes how they live'}${pt.requires.length ? ` · needs ${esc(pt.requires.map(r => TECH_BY_ID[r]?.name ?? r).join(' and '))}` : ''}</div>
      <div class="ts-info-l">${pst === 'known' ? `Known to ${esc(knowers.join(', '))}: they ${esc(pt.deed)}.`
        : pst === 'studying' ? `${esc(learners.map(n => n.name).join(', '))} ${learners.length > 1 ? 'are' : 'is'} studying it (${Math.round((studying.get(pt.id) ?? 0) * 100)}%).`
        : pst === 'open' ? 'Open to study: a nation will take it up when its needs call for it.'
        : 'Out of reach for now.'}${opens.length ? ` <b>Opens ${opens.length > 1 ? 'the cards' : 'the card'} ${esc(opens.map(c => c.name).join(' and '))}.</b>` : ''}</div>
    </div>`;

  const open = views.filter(v => v.unlocked);
  const nextCards = views.filter(v => !v.unlocked).sort((a, b) => a.age - b.age).slice(0, 3);
  const cards = `<div class="ts-cards">${open.length ? open.map(v => techCardFace(v)).join('')
    : '<div class="ts-quiet">No card yet: the first opens when a nation learns something a god can use.</div>'}</div>
    ${nextCards.length ? `<div class="ts-next">Next to open: ${nextCards.map(v => `${esc(v.card.name)} <span>(${esc(v.card.needs.tech ? TECH_BY_ID[v.card.needs.tech]?.name ?? '' : `the ${eraTitle(v.card.needs.era ?? 1)} age`)})</span>`).join(' · ')}</div>` : ''}`;

  const study = `<div class="ts-study">${live.map(n => {
    const r = n.research, t = r ? TECH_BY_ID[r.id] : null;
    return `<div class="ts-s"><span class="ts-s-n">${esc(n.name)}</span>${t
      ? `<span class="ts-s-t">${esc(t.name)}</span><span class="ts-bar"><span style="width:${Math.round(r!.progress * 100)}%"></span></span><span class="ts-s-w">${esc((r!.why ?? []).slice(0, 1).join(''))}</span>`
      : '<span class="ts-s-w">nothing new for now</span>'}</div>`;
  }).join('')}</div>`;

  const path = `<div class="ts-path">${eras.map(i =>
    `<span class="ts-age${i < era ? ' past' : i === era ? ' now' : ''}"><i></i>${esc(eraTitle(i))}</span>`).join('')}</div>`;

  body.innerHTML = `
    <div class="ts-sec">CENTRAL TECHNOLOGY TREE</div>
    <div class="ts-tree"><svg class="ts-links" aria-hidden="true"></svg>${cols}</div>
    ${info}
    <div class="ts-low">
      <div><div class="ts-sec">YOUR TP CARDS</div>${cards}</div>
      <div><div class="ts-sec">STUDYING NOW</div>${study}</div>
    </div>
    <div class="ts-sec">THE PATH OF THE AGES</div>${path}`;
  drawLinks(body.querySelector('.ts-tree') as HTMLElement, known);
}

function drawLinks(tree: HTMLElement | null, known: ReadonlySet<string>): void {
  const svg = tree?.querySelector('svg.ts-links') as SVGSVGElement | null;
  if (!tree || !svg) return;
  const box = tree.getBoundingClientRect();
  svg.setAttribute('width', String(tree.scrollWidth));
  svg.setAttribute('height', String(tree.scrollHeight));
  const at = (id: string, side: 'l' | 'r') => {
    const el = tree.querySelector<HTMLElement>(`[data-tech="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: (side === 'l' ? r.left : r.right) - box.left + tree.scrollLeft, y: r.top + r.height / 2 - box.top + tree.scrollTop };
  };
  const out: string[] = [];
  for (const t of TECHS) for (const r of t.requires) {
    const a = at(r, 'r'), b = at(t.id, 'l');
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2;
    out.push(`<path d="M${a.x},${a.y} H${mx} V${b.y} H${b.x}" class="${known.has(r) && known.has(t.id) ? 'known' : known.has(r) ? 'open' : ''}"/>`);
  }
  svg.innerHTML = out.join('');
}

const TS_CSS = `
#tech-screen{position:fixed;inset:0;z-index:302;display:none;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at center,rgba(20,14,6,0.72),rgba(0,0,0,0.86))}
#tech-screen.open{display:flex}
#tech-screen .ts-frame{width:min(1240px,calc(100vw - 32px));height:min(780px,calc(100vh - 40px));display:flex;flex-direction:column;
  background:#110e14;border:2px solid #6b5537;box-shadow:0 0 0 4px #1a1209,0 12px 40px rgba(0,0,0,.7)}
#tech-screen .ts-top{display:flex;justify-content:center;align-items:baseline;gap:18px;padding:10px;border-bottom:1px solid rgba(200,169,110,.3);background:linear-gradient(#1c1626,#130f1a)}
#tech-screen .ts-title{font-family:var(--font-display,Georgia,serif);letter-spacing:4px;color:var(--gold,#c8a96e);font-size:18px}
#tech-screen .ts-tp{font-size:12px;color:#8fd8ff;letter-spacing:2px}
#tech-screen .ts-tp b{font-size:18px;font-weight:normal;color:#bfe9ff}
#tech-screen .ts-body{flex:1;min-height:0;overflow-y:auto;padding:8px 14px;display:flex;flex-direction:column;gap:6px}
#tech-screen .ts-sec{text-align:center;font-size:11px;letter-spacing:3px;color:var(--gold,#c8a96e);border-bottom:1px solid rgba(200,169,110,.2);padding:3px 0;margin-top:4px}
#tech-screen .ts-tree{position:relative;display:flex;gap:22px;overflow-x:auto;padding:6px 4px 8px}
#tech-screen .ts-links{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}
#tech-screen .ts-links path{fill:none;stroke:rgba(140,120,90,.22);stroke-width:1.2}
#tech-screen .ts-links path.open{stroke:rgba(200,169,110,.7)}
#tech-screen .ts-links path.known{stroke:#5dcc8a;stroke-width:2}
#tech-screen .ts-col{flex:1 1 0;min-width:118px;display:flex;flex-direction:column;gap:5px;position:relative;z-index:1}
#tech-screen .ts-col.far .ts-col-h{color:#6b604f}
#tech-screen .ts-col-h{font-size:9px;letter-spacing:2px;color:#a99a80;text-align:center;padding-bottom:3px}
#tech-screen .ts-col.now .ts-col-h{color:#ffe08a}
#tech-screen .ts-node{position:relative;overflow:hidden;font:inherit;display:flex;align-items:center;gap:4px;text-align:left;padding:5px 7px;
  background:#1a1520;border:1px solid rgba(200,169,110,.25);color:#a99a80;cursor:pointer}
#tech-screen .ts-n{position:relative;flex:1;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#tech-screen .ts-c{position:relative;font-size:10px;color:#8fd8ff}
#tech-screen .ts-node.known{background:#14261c;border-color:#5dcc8a;color:#d6f5e2}
#tech-screen .ts-node.studying{border-color:#ffe08a;color:#fff1c4;box-shadow:0 0 8px rgba(255,224,138,.35)}
#tech-screen .ts-prog{position:absolute;left:0;top:0;bottom:0;background:rgba(255,224,138,.16)}
#tech-screen .ts-node.open{border-color:rgba(200,169,110,.6);color:#f3e6c4}
#tech-screen .ts-node.later{color:#5f5648;border-color:rgba(200,169,110,.12);background:#141118}
#tech-screen .ts-node.later .ts-c{color:#3f6a85}
#tech-screen .ts-node.on{outline:2px solid #8fd8ff;outline-offset:0}
#tech-screen .ts-node:hover{border-color:#8fd8ff}
#tech-screen .ts-info{background:#0d0a12;border:1px solid rgba(143,216,255,.3);padding:6px 10px}
#tech-screen .ts-info-h{font-family:var(--font-display,Georgia,serif);font-size:15px;color:#f3e6c4}
#tech-screen .ts-info-h span{font-family:inherit;font-size:11px;color:#a99a80;margin-left:8px}
#tech-screen .ts-info-l{font-size:11px;color:#cdbfa6;margin-top:2px}
#tech-screen .ts-info-l b{color:#8fd8ff;font-weight:normal}
#tech-screen .ts-low{display:grid;grid-template-columns:1.6fr 1fr;gap:14px}
#tech-screen .ts-low > div{min-width:0}
#tech-screen .ts-cards{display:flex;gap:8px;overflow-x:auto;padding:8px 2px;align-items:flex-start}
#tech-screen .ts-cards .tech-card{flex:0 0 auto}
#tech-screen .ts-next{font-size:10px;color:#a99a80}
#tech-screen .ts-next span{color:#7d7060}
#tech-screen .ts-study{display:flex;flex-direction:column;gap:4px;padding-top:6px}
#tech-screen .ts-s{display:grid;grid-template-columns:1.2fr 1fr 70px;gap:6px;align-items:center;font-size:11px}
#tech-screen .ts-s-n{color:#f3e6c4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#tech-screen .ts-s-t{color:#ffe08a}
#tech-screen .ts-s-w{grid-column:1/-1;font-size:10px;color:#a99a80;margin-top:-3px}
#tech-screen .ts-bar{height:5px;background:#2a2238}
#tech-screen .ts-bar span{display:block;height:100%;background:#ffe08a}
#tech-screen .ts-path{display:flex;justify-content:space-between;padding:10px 20px 4px;position:relative}
#tech-screen .ts-path::before{content:'';position:absolute;left:30px;right:30px;top:15px;height:2px;background:#3a3040}
#tech-screen .ts-age{position:relative;display:flex;flex-direction:column;align-items:center;gap:5px;font-size:10px;color:#7d7060}
#tech-screen .ts-age i{width:11px;height:11px;border-radius:50%;background:#2a2238;border:2px solid #5a4d60}
#tech-screen .ts-age.past{color:#a99a80} #tech-screen .ts-age.past i{background:#c8a96e;border-color:#c8a96e}
#tech-screen .ts-age.now{color:#ffe08a} #tech-screen .ts-age.now i{background:#ffe08a;border-color:#fff;box-shadow:0 0 8px #ffe08a}
#tech-screen .ts-quiet{font-size:11px;color:#a99a80}
#tech-screen .ts-empty{padding:60px;text-align:center;color:#a99a80;line-height:1.7}
#tech-screen .ts-foot{display:flex;justify-content:flex-start;padding:8px 12px;border-top:1px solid rgba(200,169,110,.25)}
#tech-screen .ts-btn{font:inherit;font-size:12px;letter-spacing:2px;color:#e8dcc4;background:#1b1530;border:1px solid rgba(200,169,110,.4);padding:7px 22px;cursor:pointer}
#tech-screen button:focus-visible{outline:2px solid #8fd8ff;outline-offset:1px}
@media (max-width:860px){#tech-screen .ts-low{grid-template-columns:1fr}}
`;
function ensureStyles(): void {
  if (document.getElementById('tech-screen-css')) return;
  const st = document.createElement('style');
  st.id = 'tech-screen-css';
  st.textContent = TS_CSS;
  document.head.appendChild(st);
}

/**
 * The TP deck (tracker: "TP cards as a second deck when TP arrives"): a pile
 * beside the Faith deck, shown once the people have nations, with the TP held
 * and the cards open; a click opens this screen.
 */
export function refreshTechDeck(): void {
  const deck = document.getElementById('tech-deck');
  const eng = deps?.engine();
  if (!deck || !eng) return;
  const founded = !!runtimeState.playerNations?.isFounded;
  deck.style.display = founded ? '' : 'none';
  if (!founded) return;
  const views = eng.techCardViews();
  const open = views.filter(v => v.unlocked);
  const playable = open.filter(v => !v.block).length;
  const sig = `${gameState.techPoints}|${open.length}|${playable}`;
  if (deck.dataset.sig === sig) return;
  deck.dataset.sig = sig;
  (deck.querySelector('.td-tp') as HTMLElement).textContent = `${gameState.techPoints} TP`;
  (deck.querySelector('.td-n') as HTMLElement).textContent = open.length
    ? `${open.length} card${open.length > 1 ? 's' : ''}${playable ? ` · ${playable} ready` : ''}` : 'no cards yet';
  deck.classList.toggle('ready', playable > 0);
}
