/**
 * The World Ledger: what the home world's nations have, what they need, and
 * where it is heading. Food, pollution, people, materials, cohesion,
 * inequality and knowledge, each as a stat tile (value, change over the last
 * generation, three ages of history); the pressures as meters; WHY each number
 * is what it is (NationSystem.explain: where pollution settles, what feeds the
 * harvest, where cohesion drifts); and the cards working on each nation now.
 *
 * Reads runtimeState.playerNations (the ledger samples and explain()); owns no
 * state but the selected nation. Refreshes once a second while open.
 */
import { runtimeState } from '../simulation/GameState';
import { LEDGER_EVERY, type NationSystem, type LedgerSample, type Nation } from '../simulation/Nations';
import { eraTitle } from '../simulation/Progression';

/** 'world' or a nation index. */
let view: 'world' | number = 'world';
let timer: ReturnType<typeof setInterval> | null = null;
/** A sparkline is being read: hold the refresh so the line and its readout stay put. */
let hovering = false;

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
/** Samples in a generation (half an age), the span a change is measured over. */
const GEN = Math.round(0.5 / LEDGER_EVERY);

const compact = (v: number) => {
  const a = Math.abs(v);
  return a >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e4 ? `${(v / 1e3).toFixed(0)}K`
    : a >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : a >= 10 ? v.toFixed(0) : v.toFixed(1);
};
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** A metric: how to read it from a sample, show it, and whether up is good. */
interface Metric {
  key: string; label: string;
  read: (s: LedgerSample) => number;
  /** For the world: sum across nations, or a population-weighted mean. */
  world: 'sum' | 'mean' | 'fed';
  show: (v: number) => string;
  /** Change as text (points for shares, % for counts). */
  delta: (now: number, then: number) => string;
  good: 'up' | 'down' | 'none';
}

const share = (now: number, then: number) => `${now >= then ? '+' : '−'}${Math.abs(Math.round((now - then) * 100))} pts`;
const growth = (now: number, then: number) => then > 0 ? `${now >= then ? '+' : '−'}${Math.abs(Math.round((now / then - 1) * 100))}%` : '—';

const METRICS: Metric[] = [
  { key: 'people', label: 'PEOPLE', read: s => s.population, world: 'sum', show: compact, delta: growth, good: 'none' },
  { key: 'fed', label: 'FED', read: s => s.foodYield / Math.max(1e-6, s.foodNeed), world: 'fed', show: pct, delta: share, good: 'up' },
  { key: 'pollution', label: 'POLLUTION', read: s => s.pollution, world: 'mean', show: pct, delta: share, good: 'down' },
  { key: 'materials', label: 'MATERIALS', read: s => s.materials, world: 'sum', show: compact, delta: growth, good: 'up' },
  { key: 'cohesion', label: 'COHESION', read: s => s.cohesion, world: 'mean', show: pct, delta: share, good: 'up' },
  { key: 'inequality', label: 'INEQUALITY', read: s => s.inequality, world: 'mean', show: pct, delta: share, good: 'down' },
  { key: 'techs', label: 'TECHNOLOGIES', read: s => s.techs, world: 'sum', show: v => String(Math.round(v)), delta: (a, b) => `${a >= b ? '+' : '−'}${Math.abs(Math.round(a - b))}`, good: 'up' },
];

/** One value per sample for the selected view (the world folds the nations together). */
function series(ns: NationSystem, m: Metric): number[] {
  if (view !== 'world') return (ns.ledger[view] ?? []).filter(s => !s.fallen).map(m.read);
  const logs = ns.ledger.filter((l, k) => l && !ns.nations[k]?.fallen);
  const len = Math.min(...logs.map(l => l.length));
  if (!isFinite(len) || len <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    const at = logs.map(l => l[l.length - len + i]);
    if (m.world === 'sum') out.push(at.reduce((a, s) => a + m.read(s), 0));
    else if (m.world === 'fed') out.push(at.reduce((a, s) => a + s.foodYield, 0) / Math.max(1e-6, at.reduce((a, s) => a + s.foodNeed, 0)));
    else {
      const w = at.reduce((a, s) => a + s.population, 0) || 1;
      out.push(at.reduce((a, s) => a + m.read(s) * s.population, 0) / w);
    }
  }
  return out;
}

/** A sparkline: the history line in a quiet ink, the current value as an accent dot. */
function spark(vals: number[], key: string): string {
  if (vals.length < 2) return '<div class="lg-spark lg-spark-empty">gathering…</div>';
  const W = 150, H = 34, P = 3;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { hi += 0.5; lo -= 0.5; }
  const x = (i: number) => P + (i / (vals.length - 1)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const last = vals.length - 1;
  return `<svg class="lg-spark" data-key="${key}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="history">
    <path d="${d}" fill="none" stroke="var(--lg-line)" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <circle cx="${x(last).toFixed(1)}" cy="${y(vals[last]).toFixed(1)}" r="2.6" fill="var(--lg-accent)" stroke="var(--lg-surface)" stroke-width="1.2"/>
    <line class="lg-cross" x1="0" x2="0" y1="0" y2="${H}" stroke="var(--lg-grid)" stroke-width="1" vector-effect="non-scaling-stroke" style="display:none"/>
  </svg>`;
}

function tile(ns: NationSystem, m: Metric): string {
  const vals = series(ns, m);
  const now = vals[vals.length - 1];
  const then = vals[Math.max(0, vals.length - 1 - GEN)];
  const has = vals.length > 1;
  const dir = !has || Math.abs(now - then) < 1e-6 ? 'flat' : now > then ? 'up' : 'down';
  const tone = m.good === 'none' || dir === 'flat' ? 'neutral' : (dir === m.good ? 'good' : 'bad');
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■';
  return `<div class="lg-tile">
    <div class="lg-label">${m.label}</div>
    <div class="lg-value">${now == null ? '—' : m.show(now)}</div>
    <div class="lg-delta lg-${tone}">${has ? `${arrow} ${m.delta(now, then)}` : '—'} <span class="lg-muted">${has ? 'in a generation' : ''}</span></div>
    ${spark(vals, m.key)}
  </div>`;
}

function meter(label: string, v: number, note: string): string {
  const sev = v >= 0.5 ? 'crit' : v >= 0.25 ? 'warn' : 'ok';
  const word = v >= 0.5 ? 'acute' : v >= 0.25 ? 'felt' : v > 0.02 ? 'faint' : 'none';
  return `<div class="lg-meter" title="${esc(note)}">
    <div class="lg-meter-top"><span class="lg-label">${label}</span><span class="lg-meter-val">${pct(v)} · ${word}</span></div>
    <div class="lg-track"><div class="lg-fill lg-${sev}" style="width:${Math.max(1, Math.min(100, v * 100))}%"></div></div>
  </div>`;
}

const PRESSURES: Array<[keyof Nation['pressures'], string, string]> = [
  ['hunger', 'HUNGER', 'How close the people are to eating all the land gives'],
  ['crowding', 'CROWDING', 'People per cell against what their towns can house'],
  ['scarcity', 'SHORTAGE', 'Wood, stone and ore against what the people need'],
  ['unrest', 'UNREST', 'Cohesion lost: below 60% the nation starts to quarrel'],
  ['pollution', 'FOULED LAND', 'Smoke and waste: they spoil the harvest'],
];

/** "×1.35" / "−12%" pieces of a cause line. */
const times = (v: number, label: string) => Math.abs(v - 1) < 0.005 ? '' : `<span class="lg-factor">${label} ×${v.toFixed(2)}</span>`;

function why(ns: NationSystem, k: number): string {
  const x = ns.explain(k);
  if (!x) return '';
  const n = ns.nations[k];
  const pol = x.pollution;
  const inNow = pol.fromTechs + pol.fromCards;
  const techLine = pol.techs.length ? pol.techs.map(t => `${esc(t.name)} ${t.perStep >= 0 ? '+' : '−'}${Math.abs(t.perStep * 100).toFixed(1)}`).join(' · ') : 'nothing they know fouls the land';
  const food = [
    times(x.food.techs, 'what they know'), times(x.food.cards, 'cards'), times(x.food.season, 'the season'),
    x.food.pollutionLoss > 0.005 ? `<span class="lg-factor">fouled land −${Math.round(x.food.pollutionLoss * 100)}%</span>` : '',
    x.food.offworld > 0.005 ? `<span class="lg-factor">from other stars +${Math.round(x.food.offworld * 100)}%</span>` : '',
    Math.abs(x.food.trade) > 0.005 ? `<span class="lg-factor">trade ${x.food.trade >= 0 ? '+' : '−'}${compact(Math.abs(x.food.trade))}</span>` : '',
  ].filter(Boolean).join('');
  const mats = [times(x.materials.techs, 'what they know'), times(x.materials.cards, 'cards'),
    x.materials.offworld > 0.005 ? `<span class="lg-factor">from other stars +${Math.round(x.materials.offworld * 100)}%</span>` : '',
    Math.abs(x.materials.trade) > 0.005 ? `<span class="lg-factor">trade ${x.materials.trade >= 0 ? '+' : '−'}${compact(Math.abs(x.materials.trade))}</span>` : ''].filter(Boolean).join('');
  const heading = (now: number, to: number) => Math.abs(to - now) < 0.01 ? 'holding' : to > now ? `rising toward ${pct(to)}` : `falling toward ${pct(to)}`;
  return `<div class="lg-why">
    <div class="lg-why-row"><div class="lg-why-k">FOOD</div><div class="lg-why-v">
      <b>${pct(x.fed)} fed</b> — the land feeds about ${compact(x.carries)} people; ${compact(n.state.population)} live there.
      <div class="lg-factors">${food || '<span class="lg-muted">an ordinary harvest, nothing helping or hurting it</span>'}</div></div></div>
    <div class="lg-why-row"><div class="lg-why-k">POLLUTION</div><div class="lg-why-v">
      <b>${pct(n.state.pollution)}, ${heading(n.state.pollution, pol.settles)}</b> — each step adds ${(inNow * 100).toFixed(2)} pts and ${Math.round(pol.clearsShare * 100)}% of what is there clears by itself.
      <div class="lg-factors"><span class="lg-factor">what they know: ${techLine}</span>${Math.abs(pol.fromCards) > 1e-4 ? `<span class="lg-factor">cards ${pol.fromCards >= 0 ? '+' : '−'}${Math.abs(pol.fromCards * 100).toFixed(1)}</span>` : ''}</div></div></div>
    <div class="lg-why-row"><div class="lg-why-k">MATERIALS</div><div class="lg-why-v">
      <b>${compact(n.state.materials)}</b> from ${n.state.land} cells of land.
      <div class="lg-factors">${mats || '<span class="lg-muted">what the land gives, nothing more</span>'}</div></div></div>
    <div class="lg-why-row"><div class="lg-why-k">COHESION</div><div class="lg-why-v">
      <b>${pct(n.state.cohesion)}, ${heading(n.state.cohesion, x.cohesionTarget)}</b> — sprawl, hunger, crowding, inequality and fouled land pull it down; a shared faith, a collective temper and some technologies hold it.</div></div>
    <div class="lg-why-row"><div class="lg-why-k">STUDY</div><div class="lg-why-v">
      ${x.research.studying ? `<b>${esc(x.research.studying)}</b>, ${pct(Math.min(1, x.research.progress))} learned — ${esc(x.research.why.join(', ') || 'tinkering')}.` : 'Studying nothing right now.'}
      <div class="lg-factors">${times(x.research.techs, 'what they know')}${times(x.research.cards, 'cards')}</div></div></div>
  </div>`;
}

function cards(ns: NationSystem, k: number): string {
  const x = ns.explain(k);
  const list = (x?.omens ?? []).sort((a, b) => Number(b.working) - Number(a.working) || a.endsIn - b.endsIn);
  if (!list.length) return '<div class="lg-muted lg-none">No card is working on this nation.</div>';
  const gens = (eras: number) => { const g = eras / 0.5; return g < 0.2 ? 'ending' : g < 1 ? `${Math.round(g * 10) / 10} generation` : `${g.toFixed(1)} generations`; };
  return list.slice(0, 12).map(o => `<div class="lg-card${o.working ? ' lg-working' : ''}">
      <span class="lg-card-name">${esc(o.card)}</span>
      <span class="lg-card-sign">${esc(o.sign)}${o.primary ? '' : ' <span class="lg-muted">(its price)</span>'}</span>
      <span class="lg-card-time">${o.startsIn > 0 ? `starts in ${gens(o.startsIn)}` : o.working ? `${gens(o.endsIn)} left` : `waiting · ${gens(o.endsIn)} left`}</span>
    </div>`).join('');
}

function worldTable(ns: NationSystem): string {
  const live = ns.nations.map((n, k) => ({ n, k })).filter(({ n }) => !n.fallen);
  return `<table class="lg-table"><thead><tr><th>NATION</th><th>AGE</th><th>PEOPLE</th><th>FED</th><th>POLLUTION</th><th>COHESION</th><th>INEQUALITY</th><th>TECHS</th></tr></thead><tbody>
    ${live.map(({ n, k }) => `<tr data-k="${k}"><td><span class="lg-swatch" style="background:${n.color}"></span>${esc(n.name)}</td>
      <td>${esc(eraTitle(n.era))}</td><td>${compact(n.state.population)}</td><td>${pct(n.state.foodYield / Math.max(1e-6, n.state.foodNeed))}</td>
      <td>${pct(n.state.pollution)}</td><td>${pct(n.state.cohesion)}</td><td>${pct(n.state.inequality)}</td><td>${n.techs.length}</td></tr>`).join('')}
  </tbody></table>`;
}

function render(force = false): void {
  const box = document.getElementById('ledger');
  if (!box || !box.classList.contains('open') || (hovering && !force)) return;
  const ns = runtimeState.playerNations;
  const chips = box.querySelector('.lg-chips')!;
  const body = box.querySelector('.lg-body')!;
  if (!ns?.isFounded) {
    chips.innerHTML = '';
    body.innerHTML = '<div class="lg-empty">Your people have not yet founded nations. The ledger opens when they do.</div>';
    return;
  }
  if (view !== 'world' && (!ns.nations[view] || ns.nations[view].fallen)) view = 'world';
  // Rebuild the chips only when the nations or the choice change: rebuilt
  // every refresh, a click landing mid-refresh hit a button already gone.
  const sig = `${view}|${ns.nations.map(n => `${n.name}:${n.fallen ? 1 : 0}`).join(',')}`;
  if ((chips as HTMLElement).dataset['sig'] !== sig) {
    (chips as HTMLElement).dataset['sig'] = sig;
    chips.innerHTML = `<button class="lg-chip${view === 'world' ? ' on' : ''}" data-v="world" style="--nc:#c8a96e">THE WORLD</button>` +
      ns.nations.map((n, k) => n.fallen ? '' : `<button class="lg-chip${view === k ? ' on' : ''}" data-v="${k}" style="--nc:${n.color}">${esc(n.name.toUpperCase())}</button>`).join('');
    chips.querySelectorAll<HTMLElement>('.lg-chip').forEach(c => c.addEventListener('click', () => {
      view = c.dataset['v'] === 'world' ? 'world' : Number(c.dataset['v']);
      render(true);
    }));
  }
  const tiles = METRICS.map(m => tile(ns, m)).join('');
  const press = (k: keyof Nation['pressures']) => {
    const live = ns.nations.filter(n => !n.fallen);
    return view === 'world' ? Math.max(0, ...live.map(n => n.pressures[k])) : ns.nations[view].pressures[k];
  };
  const meters = PRESSURES.map(([k, label, note]) => meter(label, press(k), note)).join('');
  const head = view === 'world'
    ? `<div class="lg-head">All ${ns.nations.filter(n => !n.fallen).length} nations together. Pressures show the worst-off nation. <span class="lg-muted">Choose a nation for why its numbers are what they are.</span></div>`
    : `<div class="lg-head"><span class="lg-swatch" style="background:${ns.nations[view].color}"></span><b>${esc(ns.nations[view].name)}</b> · ${esc(eraTitle(ns.nations[view].era))} · ${ns.nations[view].state.land} cells · ${esc(ns.nations[view].government)}</div>`;
  const detail = view === 'world'
    ? `<div class="lg-section">EVERY NATION</div>${worldTable(ns)}`
    : `<div class="lg-cols"><div><div class="lg-section">WHY</div>${why(ns, view)}</div><div><div class="lg-section">CARDS AT WORK</div>${cards(ns, view)}</div></div>`;
  const scroll = (body as HTMLElement).scrollTop;
  body.innerHTML = `${head}<div class="lg-tiles">${tiles}</div>
    <div class="lg-section">PRESSURES</div><div class="lg-meters">${meters}</div>${detail}
    <div class="lg-foot">Each line covers the last three ages; a generation is half an age.</div>`;
  (body as HTMLElement).scrollTop = scroll;
  body.querySelectorAll<HTMLElement>('.lg-table tr[data-k]').forEach(r => r.addEventListener('click', () => { view = Number(r.dataset['k']); render(true); }));
  wireHover(body, ns);
}

/** Hover a sparkline: a crosshair and the value then. */
function wireHover(body: Element, ns: NationSystem): void {
  const tip = document.getElementById('lg-tip') ?? Object.assign(document.createElement('div'), { id: 'lg-tip' });
  if (!tip.parentElement) document.body.appendChild(tip);
  body.querySelectorAll<SVGSVGElement>('svg.lg-spark').forEach(svg => {
    const m = METRICS.find(x => x.key === svg.dataset['key'])!;
    const vals = series(ns, m);
    const cross = svg.querySelector<SVGLineElement>('.lg-cross')!;
    svg.addEventListener('mouseenter', () => { hovering = true; });
    svg.addEventListener('mousemove', ev => {
      const r = svg.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const i = Math.round(f * (vals.length - 1));
      const xs = 3 + (i / Math.max(1, vals.length - 1)) * (150 - 6);
      cross.setAttribute('x1', String(xs)); cross.setAttribute('x2', String(xs)); cross.style.display = '';
      const ago = (vals.length - 1 - i) * LEDGER_EVERY / 0.5;
      tip.textContent = `${m.show(vals[i])} · ${ago < 0.05 ? 'now' : `${ago.toFixed(1)} generations ago`}`;
      tip.style.display = 'block';
      tip.style.left = `${ev.clientX + 12}px`; tip.style.top = `${ev.clientY - 28}px`;
    });
    svg.addEventListener('mouseleave', () => { hovering = false; cross.style.display = 'none'; tip.style.display = 'none'; });
  });
}

export function openLedger(nation?: number): void {
  let box = document.getElementById('ledger');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ledger';
    box.innerHTML = `<div class="lg-frame">
      <div class="lg-top"><div class="lg-title">THE WORLD LEDGER</div>
        <div class="lg-sub">What your nations have, what they need, and where it is heading.</div>
        <button class="lg-close" type="button">✕</button></div>
      <div class="lg-chips"></div>
      <div class="lg-body"></div></div>`;
    document.body.appendChild(box);
    box.addEventListener('click', e => { if (e.target === box) closeLedger(); });
    box.querySelector('.lg-close')!.addEventListener('click', closeLedger);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('ledger')?.classList.contains('open')) closeLedger(); });
  }
  if (nation != null) view = nation;
  box.classList.add('open');
  hovering = false;
  render(true);
  if (!timer) timer = setInterval(render, 1000);
}

export function closeLedger(): void {
  document.getElementById('ledger')?.classList.remove('open');
  document.getElementById('rail-ledger')?.classList.remove('active');
  const tip = document.getElementById('lg-tip');
  if (tip) tip.style.display = 'none';
  if (timer) { clearInterval(timer); timer = null; }
}
