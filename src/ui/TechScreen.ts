/**
 * The technology screen (playtest mockup Oct 20; owner's model Oct 22): the
 * tree of what the people know, where the player spends TP.
 *
 *  - THE TREE: every technology by age (one column each). Known to a nation
 *    (green), unlocked by you (gold, lit), being studied (amber, progress),
 *    ready to unlock (cyan, with its price), open to the nations only (dim
 *    gold), not yet (dark). Every node gives a card: ◆ an authored one, ◇ a
 *    small one made from the technology's own effect.
 *  - The picked technology: what it does, who knows it, the card it gives,
 *    and UNLOCK (the neediest nation learns it at once; its card goes into
 *    your hand) or RECALL (a burned card bought back).
 *  - YOUR TP HAND: the cards your unlocks granted; one burns from its detail
 *    (ui/TechCards does the burning) and leaves the hand.
 *  - STUDYING NOW: what each nation is learning, and why.
 *  - THE PATH: the ages behind and ahead.
 *
 * Reads runtimeState.playerNations and the engine's node and card views;
 * owns nothing but the selection. Refreshes once a second while open.
 */
import { gameState, runtimeState } from '../simulation/GameState';
import { TECHS, TECH_BY_ID, type Tech } from '../simulation/Technology';
import { eraTitle } from '../simulation/Progression';
import type { BigBangEngine } from '../simulation/BigBangEngine';
import { techCardFace, openTechCardDetail } from './TechCards';

export interface TechScreenDeps {
  engine(): BigBangEngine | null;
  /** TP changed (an unlock): refresh the chip. */
  tpChanged?(): void;
}

let deps: TechScreenDeps | null = null;
let picked: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastSig = '';

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

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
      <div class="ts-foot"><button class="ts-btn" data-act="close" type="button">CLOSE</button>
        <span class="ts-legend"><i class="k unlocked"></i>unlocked <i class="k known"></i>known (or a green edge) <i class="k studying"></i>studied <i class="k buyable"></i>ready to unlock <span class="ts-c">◆</span> a great card <span class="ts-c">◇</span> a small card · the price shows when it can be unlocked</span></div></div>`;
    document.body.appendChild(box);
    box.addEventListener('click', e => {
      if (e.target === box) { closeTechScreen(); return; }
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-tech],[data-card]');
      if (!t) return;
      if (t.dataset.tech) { picked = t.dataset.tech; lastSig = ''; render(); }
      else if (t.dataset.card) openTechCardDetail(t.dataset.card);
      else if (t.dataset.act === 'close') closeTechScreen();
      else if (t.dataset.act === 'unlock' && picked) {
        const line = deps?.engine()?.unlockTech(picked);
        if (line) { deps?.tpChanged?.(); flash(line); }
        lastSig = ''; render();
      }
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

/** What an unlock did, shown over the hand for a few seconds. */
let flashLine = '', flashUntil = 0;
function flash(line: string): void { flashLine = line; flashUntil = Date.now() + 6000; }

type NodeState = 'unlocked' | 'known' | 'studying' | 'buyable' | 'open' | 'later';

function render(): void {
  const box = document.getElementById('tech-screen');
  const eng = deps?.engine();
  if (!box?.classList.contains('open') || !eng) return;
  const ns = runtimeState.playerNations;
  const live = ns?.isFounded ? ns.nations.filter(n => !n.fallen) : [];
  const known = new Set(live.flatMap(n => n.techs));
  const studying = new Map<string, number>();
  for (const n of live) if (n.research) studying.set(n.research.id, Math.max(studying.get(n.research.id) ?? 0, n.research.progress));
  const nodes = new Map(eng.techNodeViews().map(v => [v.tech.id, v]));
  const views = eng.techCardViews();
  const era = Math.max(0, ...live.map(n => n.era));
  const flashing = Date.now() < flashUntil;
  const sig = [picked, gameState.techPoints, flashing, [...known].join(','), [...studying].map(([k, v]) => `${k}${v.toFixed(2)}`).join(','),
    [...nodes.values()].map(v => `${v.unlocked ? 1 : 0}${v.price}${v.block ? 1 : 0}${v.inHand.length}`).join(''),
    views.map(v => `${v.card.id}${v.unlocked ? 1 : 0}${v.block ?? ''}${v.inEffect ? 1 : 0}`).join('|')].join('#');
  if (sig === lastSig) return;
  lastSig = sig;
  (box.querySelector('.ts-tp') as HTMLElement).innerHTML = `<b>${gameState.techPoints}</b> TP to spend`;
  const body = box.querySelector('.ts-body') as HTMLElement;
  if (!live.length) {
    body.innerHTML = `<div class="ts-empty">Your people have no nations yet, and no learning to speak of.<br>
      When they found their first nations, their knowledge grows here, and your TP can unlock it.</div>`;
    return;
  }

  const state = (t: Tech): NodeState => {
    const v = nodes.get(t.id)!;
    return v.unlocked ? 'unlocked' : v.ready ? 'buyable' : known.has(t.id) ? 'known' : studying.has(t.id) ? 'studying'
      : t.requires.every(r => known.has(r)) && t.era <= era + 1 ? 'open' : 'later';
  };
  if (!picked || !TECH_BY_ID[picked]) picked = TECHS.find(t => !nodes.get(t.id)!.block)?.id ?? TECHS.find(t => nodes.get(t.id)!.ready)?.id
    ?? [...studying.keys()][0] ?? TECHS[0].id;

  const eras = [...new Set(TECHS.map(t => t.era))].sort((a, b) => a - b);
  const cols = eras.map(e => `<div class="ts-col${e === era ? ' now' : e > era + 1 ? ' far' : ''}">
      <div class="ts-col-h">${esc(eraTitle(e).toUpperCase())}</div>
      ${TECHS.filter(t => t.era === e).map(t => {
        const st = state(t), v = nodes.get(t.id)!;
        const prog = studying.has(t.id) && !known.has(t.id) ? `<span class="ts-prog" style="width:${Math.round((studying.get(t.id) ?? 0) * 100)}%"></span>` : '';
        const tag = st === 'buyable' ? `<span class="ts-price${v.block ? ' short' : ''}">${v.price}</span>`
          : v.cards.length ? `<span class="ts-c" aria-label="gives ${v.cards.length} card${v.cards.length > 1 ? 's' : ''}">${v.cards.map(c => c.minor ? '◇' : '◆').join('')}</span>` : '';
        const both = known.has(t.id) && st !== 'known' ? ' k' : '';
        return `<button type="button" class="ts-node ${st}${both}${t.id === picked ? ' on' : ''}" data-tech="${t.id}" title="${esc(t.name)}">
          ${prog}<span class="ts-n">${esc(t.name)}</span>${tag}</button>`;
      }).join('')}</div>`).join('');

  const pt = TECH_BY_ID[picked!];
  const pv = nodes.get(pt.id)!;
  const pst = state(pt);
  const knowers = live.filter(n => n.techs.includes(pt.id)).map(n => n.name);
  const learners = live.filter(n => n.research?.id === pt.id);
  const effects = EFFECT_WORDS.map(([k, f]) => pt.effect[k] != null ? f(pt.effect[k]!) : null).filter(Boolean) as string[];
  const status = knowers.length ? `Known to ${esc(knowers.join(', '))}: they ${esc(pt.deed)}.`
    : learners.length ? `${esc(learners.map(n => n.name).join(', '))} ${learners.length > 1 ? 'are' : 'is'} studying it (${Math.round((studying.get(pt.id) ?? 0) * 100)}%).`
    : pst === 'later' ? 'Out of reach for now.' : 'No nation knows it yet.';
  const gives = pv.cards.length ? `<div class="ts-gives">${pv.cards.map(c => `<div>${c.minor ? 'Small card' : 'Card'} <b>${esc(c.name)}</b>${pv.inHand.includes(c.id) ? ' (in your hand)' : ''}: ${esc(c.does)} <span>Price: ${esc(c.priceText)}</span></div>`).join('')}</div>`
    : '<div class="ts-gives quiet">No card: the nations come to this on their own, when their needs call for it.</div>';
  const what = !pv.cards.length ? ''
    : pv.recall ? 'You unlocked it, and burned its card. Take the card up again:'
    : pv.unlocked ? 'You unlocked it.'
    : knowers.length ? 'Unlock it, and its card is yours (half price: a nation already knows it).'
    : 'Unlock it: the nation that needs it most learns it at once, and its card is yours.';
  const btn = !pv.cards.length ? '' : !pv.ready
    ? `<div class="ts-why${pv.unlocked ? ' calm' : ''}">${esc(pv.block ?? '')}</div>`
    : `<button type="button" class="ts-btn ts-go" data-act="unlock"${pv.block ? ' disabled' : ''}>${pv.recall ? 'RECALL' : 'UNLOCK'} · ${pv.price} TP</button>${pv.block ? `<div class="ts-why">${esc(pv.block)}</div>` : ''}`;
  const info = `<div class="ts-info">
      <div class="ts-info-main">
        <div class="ts-info-h">${esc(pt.name)} <span>${esc(eraTitle(pt.era))}${pv.unlocked ? ' · unlocked by you' : ''}</span></div>
        <div class="ts-info-l">${effects.length ? esc(effects.join(' · ')) : 'Changes how they live'}${pt.requires.length ? ` · needs ${esc(pt.requires.map(r => TECH_BY_ID[r]?.name ?? r).join(' and '))}` : ''}</div>
        <div class="ts-info-l">${status}</div>
        ${gives}
      </div>
      <div class="ts-info-act">${what ? `<div class="ts-what">${what}</div>` : ''}${btn}</div>
    </div>`;

  const held = views.filter(v => v.unlocked);
  const hand = `${flashing ? `<div class="ts-flash">${esc(flashLine)}</div>` : ''}<div class="ts-cards">${held.length ? held.map(v => techCardFace(v)).join('')
    : '<div class="ts-quiet">No card in hand. Pick a technology in the tree with a price on it and unlock it: you receive its card, to burn here when the moment is right.</div>'}</div>`;

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
      <div><div class="ts-sec">YOUR TP HAND</div>${hand}</div>
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
#tech-screen .ts-frame{width:min(1240px,calc(100vw - 24px));height:min(820px,calc(100vh - 28px));display:flex;flex-direction:column}
#tech-screen .ts-top{display:flex;justify-content:center;align-items:center;gap:18px;padding:2px 10px 0}
#tech-screen .ts-title{font-family:var(--font-display,Georgia,serif);letter-spacing:4px;color:var(--gold,#c8a96e);font-size:18px}
#tech-screen .ts-tp{font-family:var(--font-pixel);font-size:10px;color:#8fd8ff;letter-spacing:2px;padding:3px 12px;background:rgba(6,14,24,.8);
  box-shadow:inset 0 0 0 1px rgba(143,216,255,.35)}
#tech-screen .ts-tp b{font-size:16px;font-weight:normal;color:#e4f6ff;margin-right:4px}
#tech-screen .ts-body{flex:1;min-height:0;overflow-y:auto;padding:0 10px 4px;display:flex;flex-direction:column;gap:5px}
#tech-screen .ts-body > *{flex-shrink:0}
#tech-screen .ts-tree{position:relative;display:flex;gap:18px;overflow-x:auto;padding:4px 4px 6px}
#tech-screen .ts-links{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}
#tech-screen .ts-links path{fill:none;stroke:rgba(140,120,90,.22);stroke-width:1.2}
#tech-screen .ts-links path.open{stroke:rgba(200,169,110,.6)}
#tech-screen .ts-links path.known{stroke:#5dcc8a;stroke-width:2}
#tech-screen .ts-col{flex:1 1 0;min-width:112px;display:flex;flex-direction:column;gap:4px;position:relative;z-index:1}
#tech-screen .ts-col.far .ts-col-h{color:#6b604f}
#tech-screen .ts-col-h{font-family:var(--font-pixel);font-size:8.5px;letter-spacing:2px;color:#a99a80;text-align:center;padding-bottom:2px}
#tech-screen .ts-col.now .ts-col-h{color:#ffe08a}
#tech-screen .ts-node{position:relative;overflow:hidden;font:inherit;display:flex;align-items:center;gap:4px;text-align:left;padding:4px 6px;min-height:26px;
  background:#16121c;border:1px solid rgba(200,169,110,.22);color:#a99a80;cursor:pointer}
#tech-screen .ts-n{position:relative;flex:1;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#tech-screen .ts-c{position:relative;font-size:10px;color:#8fd8ff}
#tech-screen .ts-price{position:relative;font-family:var(--font-pixel);font-size:10px;color:#04121c;background:#8fd8ff;padding:1px 4px 0;line-height:13px}
#tech-screen .ts-price::after{content:' TP';font-size:7px}
#tech-screen .ts-price.short{background:#3d5566;color:#c9e6f5}
/* known to a nation: green */
#tech-screen .ts-node.known{background:#12231a;border-color:#4fae78;color:#d6f5e2}
/* studied now: amber, with its progress */
#tech-screen .ts-node.studying{border-color:#ffe08a;color:#fff1c4}
#tech-screen .ts-prog{position:absolute;left:0;top:0;bottom:0;background:rgba(255,224,138,.16)}
/* ready to unlock: cyan, its price shown */
#tech-screen .ts-node.buyable{border-color:#8fd8ff;color:#e4f6ff;background:#0f1d29;box-shadow:inset 0 0 10px rgba(143,216,255,.18)}
#tech-screen .ts-node.k{border-left:4px solid #4fae78;padding-left:4px}
/* unlocked by you: lit gold */
#tech-screen .ts-node.unlocked{border-color:#ffd77a;color:#fff4d6;background:linear-gradient(#3a2b10,#24190a);
  box-shadow:0 0 8px rgba(255,200,90,.45),inset 0 0 6px rgba(255,220,140,.35)}
#tech-screen .ts-node.unlocked .ts-c{color:#ffd77a}
#tech-screen .ts-node.open{border-color:rgba(200,169,110,.45);color:#d9ccaf}
#tech-screen .ts-node.later{color:#5f5648;border-color:rgba(200,169,110,.1);background:#121016}
#tech-screen .ts-node.later .ts-c{color:#3f6a85}
#tech-screen .ts-node.on{outline:2px solid #fff;outline-offset:1px;z-index:2}
#tech-screen .ts-node:hover{filter:brightness(1.25)}
#tech-screen .ts-info{display:flex;gap:14px;align-items:center;padding:6px 10px;min-height:96px}
#tech-screen .ts-info-main{flex:1;min-width:0}
#tech-screen .ts-info-h{font-family:var(--font-display,Georgia,serif);font-size:16px;color:#f3e6c4}
#tech-screen .ts-info-h span{font-family:inherit;font-size:11px;color:#a99a80;margin-left:8px}
#tech-screen .ts-info-l{font-size:11px;color:#cdbfa6;margin-top:2px}
#tech-screen .ts-gives{margin-top:5px;font-size:11px;color:#cfe6f2;display:flex;flex-direction:column;gap:2px}
#tech-screen .ts-gives b{color:#8fd8ff;font-weight:normal;letter-spacing:1px;margin-right:4px}
#tech-screen .ts-gives span{color:#a99a80;font-style:italic;margin-left:4px}
#tech-screen .ts-gives.quiet{color:#8d8170;font-style:italic}
#tech-screen .ts-info-act{flex:0 0 230px;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center}
#tech-screen .ts-what{font-size:10.5px;color:#cdbfa6;line-height:1.35}
#tech-screen .ts-why{font-size:10.5px;color:#ff9944;font-style:italic}
#tech-screen .ts-why.calm{color:#ffd77a;font-style:normal}
#tech-screen .ts-go{font-family:var(--font-pixel);letter-spacing:2px;color:#8fd8ff !important;min-width:170px}
#tech-screen .ts-go:disabled{filter:grayscale(.8) brightness(.65);cursor:default}
#tech-screen .ts-low{display:grid;grid-template-columns:1.7fr 1fr;gap:14px}
#tech-screen .ts-low > div{min-width:0}
#tech-screen .ts-flash{font-size:11px;color:#ffe08a;text-align:center;padding:2px 0}
#tech-screen .ts-cards{display:flex;gap:8px;overflow-x:auto;padding:8px 2px 4px;align-items:flex-start;min-height:120px}
#tech-screen .ts-cards .tech-card{flex:0 0 auto}
#tech-screen .ts-study{display:flex;flex-direction:column;gap:4px;padding-top:6px}
#tech-screen .ts-s{display:grid;grid-template-columns:1.2fr 1fr 70px;gap:6px;align-items:center;font-size:11px}
#tech-screen .ts-s-n{color:#f3e6c4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#tech-screen .ts-s-t{color:#ffe08a}
#tech-screen .ts-s-w{grid-column:1/-1;font-size:10px;color:#a99a80;margin-top:-3px}
#tech-screen .ts-bar{height:5px;background:#2a2238}
#tech-screen .ts-bar span{display:block;height:100%;background:#ffe08a}
#tech-screen .ts-path{display:flex;justify-content:space-between;padding:6px 20px 2px;position:relative}
#tech-screen .ts-path::before{content:'';position:absolute;left:30px;right:30px;top:11px;height:2px;background:#3a3040}
#tech-screen .ts-age{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:10px;color:#7d7060}
#tech-screen .ts-age i{width:11px;height:11px;border-radius:50%;background:#2a2238;border:2px solid #5a4d60}
#tech-screen .ts-age.past{color:#a99a80} #tech-screen .ts-age.past i{background:#c8a96e;border-color:#c8a96e}
#tech-screen .ts-age.now{color:#ffe08a} #tech-screen .ts-age.now i{background:#ffe08a;border-color:#fff;box-shadow:0 0 8px #ffe08a}
#tech-screen .ts-quiet{font-size:11px;color:#a99a80;padding:10px 4px;max-width:520px}
#tech-screen .ts-empty{padding:60px;text-align:center;color:#a99a80;line-height:1.7}
#tech-screen .ts-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:4px 10px 0}
#tech-screen .ts-legend{font-size:10px;color:#a99a80;display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
#tech-screen .ts-legend .k{display:inline-block;width:10px;height:10px;border:1px solid;margin-left:6px}
#tech-screen .ts-legend .k.unlocked{background:#3a2b10;border-color:#ffd77a}
#tech-screen .ts-legend .k.known{background:#12231a;border-color:#4fae78}
#tech-screen .ts-legend .k.studying{background:#2a2414;border-color:#ffe08a}
#tech-screen .ts-legend .k.buyable{background:#0f1d29;border-color:#8fd8ff}
#tech-screen .ts-btn{font:inherit;font-size:12px;letter-spacing:2px;color:#e8dcc4;background:#1b1530;border:1px solid rgba(200,169,110,.4);padding:7px 22px;cursor:pointer}
#tech-screen button:focus-visible{outline:2px solid #8fd8ff;outline-offset:1px}
@media (max-width:860px){#tech-screen .ts-low{grid-template-columns:1fr}#tech-screen .ts-info{flex-direction:column;align-items:stretch}#tech-screen .ts-info-act{flex:none}}
`;
function ensureStyles(): void {
  if (document.getElementById('tech-screen-css')) return;
  const st = document.createElement('style');
  st.id = 'tech-screen-css';
  st.textContent = TS_CSS;
  document.head.appendChild(st);
}

/**
 * The TP deck (owner's model, Oct 22): a pile beside the Faith deck in the
 * hand tray, shown once the people have nations, with the TP held, the cards
 * in hand and the technologies ready to unlock; a click opens this screen.
 */
export function refreshTechDeck(): void {
  const deck = document.getElementById('tech-deck');
  const eng = deps?.engine();
  if (!deck || !eng) return;
  const founded = !!runtimeState.playerNations?.isFounded;
  deck.style.display = founded ? '' : 'none';
  if (!founded) return;
  const held = eng.techCardViews().filter(v => v.unlocked);
  const playable = held.filter(v => !v.block).length;
  const buy = eng.techNodeViews().filter(v => !v.block).length;
  const sig = `${gameState.techPoints}|${held.length}|${playable}|${buy}`;
  if (deck.dataset.sig === sig) return;
  deck.dataset.sig = sig;
  (deck.querySelector('.td-tp') as HTMLElement).textContent = `${gameState.techPoints} TP`;
  (deck.querySelector('.td-n') as HTMLElement).textContent = [held.length ? `${held.length} in hand` : '', buy ? `${buy} to unlock` : '']
    .filter(Boolean).join(' · ') || 'nothing to unlock';
  deck.classList.toggle('ready', playable > 0 || buy > 0);
}
