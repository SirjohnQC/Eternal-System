/**
 * The Species screen (playtest Oct 20): life on the home world, as biology.
 * Your People is the civilisation; this is every kind of life the planet has
 * held. Three tabs:
 *
 *  - LIVING: every living lineage (yours first, branches under their parent),
 *    and for the one selected: what it is, how it stands to your people, where
 *    it holds the land, its share of the world's life, where it came from.
 *  - EVOLUTION: your lineage's forms and what shaped each; the Evolution Lab
 *    opens from here (its path view is the next step).
 *  - ARCHIVE: every lineage that died out: when, how long it lasted, what
 *    killed it, what it left behind.
 *
 * Reads gameState.playerSpecies / speciesForms and the home grid; the words
 * come from simulation/SpeciesCatalog and PeopleStory. Owns no state but the
 * open tab and the selection. Refreshes once a second while open.
 */
import { gameState, runtimeState } from '../simulation/GameState';
import type { SpeciesGenome } from '../simulation/SpeciesGenome';
import { GRID_SIZE, BIOME_COLORS, isWater } from '../simulation/PlanetGrid';
import {
  kindOf, relationTo, RELATION_WORDS, lifeClassOf, LIFE_CLASS_WORDS, type LifeClass, censusOf, livingRows, archiveRows, childrenOf, deathOf, yearsSpan,
} from '../simulation/SpeciesCatalog';
import { natureOf, shapedBy, symptomsOf } from '../simulation/PeopleStory';
import {
  MUTATIONS, MUTATION_BY_ID, DRAWBACKS, PRESSURE_TIMES, type CardState,
} from '../simulation/Mutations';
import { BIO_PHASE_SEQUENCE, type BiologyPhase } from '../simulation/GameState';
import { bioPhaseLabel } from '../simulation/Progression';
import { openChronicle } from './ChronicleUI';

export interface SpeciesScreenDeps {
  /** The player's own lineage (the Evolution Lab's specimen). */
  yours(): SpeciesGenome | null;
  /** A portrait canvas (may be shared and cached; the screen draws a copy). */
  portrait(g: SpeciesGenome, px: number): HTMLCanvasElement;
  mutationLabel(id: string): string;
  openLab(): void;
  tick(): number;
  /** The Evolution Lab's engine side (main.ts keeps the economy). Absent: the tab only shows the lineage. */
  lab?: {
    states(): CardState[];
    phase(): BiologyPhase;
    queue(id: string): void;
    unqueue(id: string): void;
    ready(): boolean;
    evolve(): void;
    /** The form the queue would make (drawn as a silhouette until EVOLVE). */
    preview(): SpeciesGenome | null;
    threshold: number;
  };
}

type Tab = 'living' | 'evolution' | 'archive';

let deps: SpeciesScreenDeps | null = null;
let tab: Tab = 'living';
let chosen: string | null = null;
/** The mutation selected on the path. */
let picked: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastSig = '';

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const roman = (n: number) => ROMAN[n - 1] ?? String(n);
const pct = (v: number) => v >= 0.995 ? '100%' : v < 0.01 ? '<1%' : `${Math.round(v * 100)}%`;

export function initSpeciesScreen(d: SpeciesScreenDeps): void { deps = d; }

export function openSpeciesScreen(which: Tab = 'living'): void {
  if (!deps) return;
  ensureStyles();
  tab = which;
  let box = document.getElementById('species-screen');
  if (!box) {
    box = document.createElement('div');
    box.id = 'species-screen';
    box.innerHTML = `<div class="sp-frame" role="dialog" aria-label="Species">
      <div class="sp-top"><span class="sp-title">SPECIES</span><span class="sp-census"></span></div>
      <div class="sp-tabs" role="tablist">
        <button type="button" role="tab" data-tab="living">LIVING</button>
        <button type="button" role="tab" data-tab="evolution">EVOLUTION</button>
        <button type="button" role="tab" data-tab="archive">ARCHIVE</button>
      </div>
      <div class="sp-body"></div>
      <div class="sp-foot"><button class="sp-btn" data-act="close" type="button">CLOSE</button>
        <button class="sp-btn gold" data-act="lab" type="button">EVOLUTION LAB</button></div></div>`;
    document.body.appendChild(box);
    box.addEventListener('click', e => {
      if (e.target === box) { closeSpeciesScreen(); return; }
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-tab],[data-sp],[data-entry],[data-mut]');
      if (!t) return;
      if (t.dataset.mut) { picked = t.dataset.mut; lastSig = ''; render(); return; }
      if (t.dataset.act === 'queue' && picked) { deps?.lab?.queue(picked); lastSig = ''; render(); return; }
      if (t.dataset.act === 'unqueue') { const id = t.dataset.id ?? picked; if (id) deps?.lab?.unqueue(id); lastSig = ''; render(); return; }
      if (t.dataset.act === 'evolve') { deps?.lab?.evolve(); lastSig = ''; render(); return; }
      if (t.dataset.tab) { tab = t.dataset.tab as Tab; chosen = null; lastSig = ''; render(); }
      else if (t.dataset.sp) { chosen = t.dataset.sp; lastSig = ''; render(); }
      else if (t.dataset.entry) openChronicle({ entry: Number(t.dataset.entry) });
      else if (t.dataset.act === 'close') closeSpeciesScreen();
      else if (t.dataset.act === 'lab') {
        if (deps?.lab) { tab = 'evolution'; lastSig = ''; render(); } else { closeSpeciesScreen(); deps?.openLab(); }
      }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSpeciesScreen(); });
  }
  box.classList.add('open');
  lastSig = '';
  render();
  if (!timer) timer = setInterval(render, 1000);
}

export function closeSpeciesScreen(): void {
  document.getElementById('species-screen')?.classList.remove('open');
  if (timer) { clearInterval(timer); timer = null; }
}

function render(): void {
  const box = document.getElementById('species-screen');
  if (!box?.classList.contains('open') || !deps) return;
  const pool = gameState.playerSpecies;
  const yours = deps.yours();
  const census = censusOf(pool, yours?.id ?? null);
  const sig = [tab, chosen, picked, gameState.dnaPoints, gameState.mutationQueue.join(','), gameState.mutationsOwned.length, pool.length, census.living, census.extinct, yours?.id, yours?.name, gameState.speciesForms.length,
    pool.map(s => s.population.toFixed(2)).join(',')].join('#');
  if (sig === lastSig) return;
  lastSig = sig;

  (box.querySelector('.sp-foot [data-act="lab"]') as HTMLElement).style.visibility = tab === 'evolution' ? 'hidden' : '';
  box.querySelectorAll<HTMLElement>('[data-tab]').forEach(b => {
    b.classList.toggle('on', b.dataset.tab === tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });
  (box.querySelector('.sp-census') as HTMLElement).textContent = pool.length
    ? `${census.living} living · ${census.extinct} extinct${census.branches ? ` · ${census.branches} branched from yours` : ''} · ${census.ever} in all`
    : '';
  const body = box.querySelector('.sp-body') as HTMLElement;
  if (!pool.length) {
    body.innerHTML = '<div class="sp-empty">Nothing lives on your world yet.<br>Every kind of life it ever holds will be recorded here.</div>';
    return;
  }
  if (tab === 'living') renderLiving(body, pool, yours);
  else if (tab === 'archive') renderArchive(body, pool, yours);
  else if (deps.lab) renderLab(body, yours, deps.lab);
  else renderEvolution(body, yours);
}

// ── Living ───────────────────────────────────────────────────────────────────

function renderLiving(body: HTMLElement, pool: readonly SpeciesGenome[], yours: SpeciesGenome | null): void {
  // Grouped by class of life (playtest Oct 20): intelligent peoples first,
  // then animals, plants, microbes; within each, yours first and branches
  // under their parent (a branch shown under a parent of another class is not indented).
  const all = livingRows(pool, yours?.id ?? null);
  const cls = new Map(all.map(r => [r.g.id, lifeClassOf(r.g, yours?.id ?? null)]));
  const groups = (['mind', 'animal', 'plant', 'microbe'] as LifeClass[])
    .map(c => ({ c, rows: all.filter(r => cls.get(r.g.id) === c) })).filter(x => x.rows.length);
  const rows = groups.flatMap(x => x.rows);
  if (!rows.some(r => r.g.id === chosen)) chosen = rows[0]?.g.id ?? null;
  const rowHtml = (r: typeof rows[number]) => {
    const sub = r.depth && cls.get(r.g.ancestorId ?? '') === cls.get(r.g.id);
    return `<button type="button" class="sp-row${r.g.id === chosen ? ' on' : ''}${r.g.id === yours?.id ? ' yours' : ''}${sub ? ' sub' : ''}" data-sp="${esc(r.g.id)}" role="option" aria-selected="${r.g.id === chosen}">
        <span class="sp-row-art"></span>
        <span class="sp-row-txt"><span class="sp-row-name">${esc(r.g.name)}</span><span class="sp-row-kind">${esc(kindOf(r.g))}</span></span>
        <span class="sp-row-pct">${pct(r.share)}</span>
      </button>`;
  };
  body.innerHTML = `<div class="sp-list" role="listbox" aria-label="Living species">${groups.map(x =>
      `<div class="sp-group sp-g-${x.c}">${esc(LIFE_CLASS_WORDS[x.c].many.toUpperCase())} <span>${x.rows.length}</span></div>${x.rows.map(rowHtml).join('')}`).join('')}</div>
    <div class="sp-detail"></div>`;
  body.querySelectorAll<HTMLElement>('.sp-row').forEach((el, i) => {
    try { el.querySelector('.sp-row-art')!.appendChild(copyOf(deps!.portrait(rows[i].g, 28))); } catch { /* decoration */ }
  });
  const row = rows.find(r => r.g.id === chosen);
  if (row) detail(body.querySelector('.sp-detail') as HTMLElement, row.g, pool, yours, row.share);
}

function detail(el: HTMLElement, g: SpeciesGenome, pool: readonly SpeciesGenome[], yours: SpeciesGenome | null, share: number): void {
  const rel = relationTo(g, yours, pool);
  const parent = g.ancestorId ? pool.find(s => s.id === g.ancestorId) : null;
  const kids = childrenOf(g, pool);
  const d = g.dna;
  el.innerHTML = `
    <div class="sp-d-head">
      <div class="sp-d-art"></div>
      <div>
        <div class="sp-d-name">${esc(g.name)}</div>
        <div class="sp-d-kind"><span class="sp-class sp-g-${lifeClassOf(g, yours?.id ?? null)}">${esc(cap(LIFE_CLASS_WORDS[lifeClassOf(g, yours?.id ?? null)].one))}</span> ${esc(cap(kindOf(g)))} · ${esc(g.physicalTraits.size)} · ${esc(d.locomotion)}</div>
        <div class="sp-rel r-${rel}">${esc(cap(RELATION_WORDS[rel]))}</div>
        ${hasTemper(g) ? `<div class="sp-nature">${natureOf(g).map(w => `<span>${esc(w)}</span>`).join('')}</div>` : ''}
      </div>
    </div>
    <div class="sp-d-grid">
      <div class="sp-panel"><div class="sp-h">Where it holds the land</div><canvas class="sp-map" width="256" height="128"></canvas><div class="sp-map-note"></div></div>
      <div class="sp-panel"><div class="sp-h">Share of the world's life</div>${ring(share, rel === 'yours')}</div>
    </div>
    <div class="sp-facts">
      ${fact('Body', `${g.physicalTraits.bodyStructure}, ${g.physicalTraits.mobilityType}`)}
      ${fact('Senses', g.physicalTraits.sensorySystem)}
      ${fact('Eats', d.diet === 'producer' ? (d.metabolism === 'chemosynthetic' ? 'the heat and sulphur of the vents' : 'light') : d.diet)}
      ${fact('Breathes', d.respiration)}
      ${fact('Lives', `${d.environment.replace('_', ' ')}, ${g.habitat.biome.replace(/_/g, ' ')}, ${g.habitat.temperatureRange}`)}
      ${fact('Has lived', yearsSpan((deps?.tick() ?? 0) - g.originTick))}
      ${fact('Came from', parent ? `${parent.name}${parent.isExtinct ? ' (extinct)' : ''}` : 'the first life')}
      ${fact('Gave rise to', kids.length ? kids.map(k => k.name + (k.isExtinct ? ' †' : '')).join(', ') : 'none yet')}
    </div>`;
  try { el.querySelector('.sp-d-art')!.appendChild(copyOf(deps!.portrait(g, 96))); } catch { /* decoration */ }
  drawRange(el.querySelector('.sp-map') as HTMLCanvasElement, el.querySelector('.sp-map-note') as HTMLElement, g);
}

/** Temperament words fit animals, not plants or microbes. */
const hasTemper = (g: SpeciesGenome) => g.dna.diet !== 'producer' && g.physicalTraits.bodyStructure !== 'single-celled';

const fact = (k: string, v: string) => `<div class="sp-fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;

function ring(share: number, yours: boolean): string {
  const r = 34, c = 2 * Math.PI * r, on = Math.max(0.01, Math.min(1, share)) * c;
  return `<svg class="sp-ring" viewBox="0 0 100 100" role="img" aria-label="${pct(share)} of the world's life">
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="#2a2238" stroke-width="12"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="${yours ? '#c8a96e' : '#5dcc8a'}" stroke-width="12"
      stroke-dasharray="${on.toFixed(1)} ${(c - on).toFixed(1)}" transform="rotate(-90 50 50)"/>
    <text x="50" y="56" text-anchor="middle" font-size="16" fill="#f3e6c4">${pct(share)}</text></svg>`;
}

/** The home world, dimmed, with the cells this lineage holds lit. */
function drawRange(cv: HTMLCanvasElement, note: HTMLElement, g: SpeciesGenome): void {
  const grid = runtimeState.playerPlanetGrid, ctx = cv.getContext('2d');
  if (!grid || !ctx) { note.textContent = 'The world is not mapped yet.'; return; }
  const W = cv.width, H = cv.height, img = ctx.createImageData(W, H);
  let held = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = grid[Math.floor(y * GRID_SIZE / H)][Math.floor(x * GRID_SIZE / W)];
    const mine = c.dominantSpeciesId === g.id;
    if (mine) held++;
    const [r0, g0, b0] = BIOME_COLORS[c.biome];
    const k = mine ? 1 : isWater(c.biome) ? 0.28 : 0.38;
    const i = (y * W + x) * 4;
    img.data[i] = mine ? 255 : r0 * k; img.data[i + 1] = mine ? 214 : g0 * k; img.data[i + 2] = mine ? 120 : b0 * k; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const share = held / (W * H);
  note.textContent = held === 0 ? 'Scattered: it rules no ground of its own.'
    : share > 0.3 ? 'It rules much of the world.' : share > 0.08 ? 'It holds wide ground.' : 'It holds a few pockets.';
}

// ── Evolution ────────────────────────────────────────────────────────────────

function renderEvolution(body: HTMLElement, yours: SpeciesGenome | null): void {
  const forms = gameState.speciesForms;
  const ns = runtimeState.playerNations ?? null;
  body.innerHTML = `<div class="sp-evo">
    <div class="sp-evo-now"><div class="sp-d-art"></div>
      <div><div class="sp-d-name">${esc(yours?.name ?? 'No lineage yet')}</div>
      <div class="sp-d-kind">${yours ? `Form ${roman(Math.max(1, forms.length))} · ${esc(cap(kindOf(yours)))}` : ''}</div>
      <div class="sp-evo-dna">${gameState.dnaPoints} DNA · ${gameState.mutationQueue.length} queued · ${gameState.mutationsOwned.length} taken</div>
      <button type="button" class="sp-btn gold" data-act="lab">OPEN THE EVOLUTION LAB</button></div></div>
    <div class="sp-h">Their lineage</div>
    <div class="sp-strip"></div></div>`;
  if (yours) try { body.querySelector('.sp-d-art')!.appendChild(copyOf(deps!.portrait(yours, 96))); } catch { /* decoration */ }
  const strip = body.querySelector('.sp-strip') as HTMLElement;
  forms.forEach((f, i) => {
    const shaped = shapedBy(f, i > 0 ? forms[i - 1].tick : -1, ns, deps!.mutationLabel);
    const el = document.createElement(shaped.entry ? 'button' : 'div');
    el.className = 'sp-form' + (i === forms.length - 1 ? ' now' : '') + (shaped.entry ? ' link' : '');
    if (shaped.entry) { (el as HTMLButtonElement).type = 'button'; el.dataset.entry = String(shaped.entry); }
    el.innerHTML = `<div class="sp-form-art"></div><div class="sp-form-num">FORM ${roman(f.form)}</div>
      <div class="sp-form-name">${esc(f.name)}</div><div class="sp-form-why">${esc(cap(shaped.text))}</div>`;
    try { el.querySelector('.sp-form-art')!.appendChild(copyOf(deps!.portrait(f.genome, 48))); } catch { /* decoration */ }
    strip.appendChild(el);
  });
  if (!forms.length) strip.innerHTML = '<div class="sp-quiet">They have not changed yet.</div>';
}


// ── Evolution: the path (evolution rework, #35) ──────────────────────────────

/** What a mutation's effects give, in words. */
const GAIN_WORDS: Record<string, string> = {
  techSpeed: 'learns faster', bioResilience: 'hardier; spreads faster', bodySize: 'grows larger', mobility: 'moves farther',
  social: 'closer bonds', aggression: 'fiercer', sensory: 'keener senses', longevity: 'lives longer',
  mutability: 'changes faster', divergence: 'branches more readily', metabolism: 'new ways to feed',
  intellectGrowth: 'room for a bigger mind',
};

function renderLab(body: HTMLElement, yours: SpeciesGenome | null, lab: NonNullable<SpeciesScreenDeps['lab']>): void {
  const states = lab.states();
  const byId = new Map(states.map(c => [c.def.id, c]));
  const phase = lab.phase();
  const phIdx = BIO_PHASE_SEQUENCE.indexOf(phase);
  const queue = gameState.mutationQueue, owned = gameState.mutationsOwned;
  if (!picked || !byId.has(picked)) {
    picked = (states.find(c => c.status === 'available' && c.answers) ?? states.find(c => c.status === 'available') ?? states[0])?.def.id ?? null;
  }
  const forms = gameState.speciesForms;
  const ready = lab.ready();
  const syms = symptomsOf(runtimeState.playerNations ?? null, gameState.playerBiosphere, 2);

  // Who took each fork: the owned or queued card of that group.
  const forkTaker = new Map<string, string>();
  for (const id of [...owned, ...queue]) { const g = MUTATION_BY_ID[id]?.group; if (g && !forkTaker.has(g)) forkTaker.set(g, id); }

  const node = (c: CardState): string => {
    const closed = !!c.def.group && forkTaker.has(c.def.group) && forkTaker.get(c.def.group) !== c.def.id;
    const poor = c.status === 'available' && !c.affordable;
    const cls = ['sp-mut', c.status, closed ? 'closed' : '', poor ? 'poor' : '', c.status === 'available' && c.answers ? 'answers' : '',
      c.def.major ? 'major' : '', c.def.id === picked ? 'on' : ''].filter(Boolean).join(' ');
    const right = c.status === 'owned' ? '✓' : c.status === 'queued' ? '◆' : closed ? '✕' : String(c.price);
    return `<button type="button" class="${cls}" data-mut="${esc(c.def.id)}" title="${esc(c.def.label)}">
      <span class="g">${esc(c.def.glyph)}</span><span class="n">${esc(c.def.label)}</span><span class="p">${right}</span></button>`;
  };

  const cols = BIO_PHASE_SEQUENCE.map((ph, i) => {
    const cards = states.filter(c => c.def.phase === ph);
    if (!cards.length) return '';
    const groups = new Map<string, CardState[]>();
    const singles: CardState[] = [];
    for (const c of cards) { if (c.def.group) { const g = groups.get(c.def.group) ?? []; g.push(c); groups.set(c.def.group, g); } else singles.push(c); }
    const forkHtml = [...groups.entries()].map(([g, cs]) => cs.length > 1
      ? `<div class="sp-fork${forkTaker.has(g) ? ' taken' : ''}"><div class="sp-fork-h">${esc(g.toUpperCase())} · PICK ONE</div>${cs.map(node).join('')}</div>`
      : cs.map(node).join('')).join('');
    return `<div class="sp-col${i === phIdx ? ' now' : i > phIdx ? ' later' : ''}">
      <div class="sp-col-h">${esc(bioPhaseLabel(ph).toUpperCase())}<span>${i === phIdx ? 'NOW' : i > phIdx ? 'LATER' : ''}</span></div>
      ${singles.map(node).join('')}${forkHtml}</div>`;
  }).join('');

  const pc = picked ? byId.get(picked) : undefined;
  const nextLeft = ready ? '' : queue.length ? `Queue ${Math.max(0, lab.threshold - queue.length)} more, or one major change` : `Queue ${lab.threshold} changes, or one major change`;

  body.innerHTML = `<div class="sp-lab">
    <div class="sp-lab-left">
      <div class="sp-d-art lab-now"></div>
      <div class="sp-d-name">${esc(yours?.name ?? 'No lineage yet')}</div>
      <div class="sp-d-kind">${yours ? `Form ${roman(Math.max(1, forms.length))} · ${esc(cap(kindOf(yours)))}` : ''}</div>
      <div class="sp-dna"><b>${gameState.dnaPoints}</b> DNA</div>
      <div class="sp-h">Waiting to evolve</div>
      <div class="sp-queue">${queue.length ? queue.map(id => {
        const gift = gameState.mutationGifts.includes(id), why = gameState.mutationGiftWhy?.[id];
        return `<button type="button" class="sp-q${gift ? ' gift' : ''}" data-act="unqueue" data-id="${esc(id)}" title="${gift ? `A spontaneous change${why ? `: ${esc(why)}` : ''}. Click to discard.` : 'Click to take back (refund)'}">${esc(MUTATION_BY_ID[id]?.glyph ?? '')} ${esc(MUTATION_BY_ID[id]?.label ?? id)} ✕</button>`
          + (gift && why ? `<div class="sp-gift">✦ ${esc(cap(why))}.</div>` : '');
      }).join('') : '<div class="sp-quiet">Nothing yet.</div>'}</div>
      <div class="sp-next">${queue.length ? '<div class="sp-d-art lab-next"></div><div class="sp-next-note">What they will become stays hidden until they evolve.</div>' : ''}</div>
      <button type="button" class="sp-evolve${ready ? ' ready' : ''}" data-act="evolve" ${ready ? '' : 'disabled'}>${ready ? '◈ EVOLVE ◈' : esc(nextLeft)}</button>
    </div>
    <div class="sp-lab-mid">
      <div class="sp-face">${syms.length ? `<b>What they face:</b> ${syms.map(x => esc(x.text)).join(' · ')}` : 'Nothing presses hard on them now.'}</div>
      <div class="sp-path"><svg class="sp-links" aria-hidden="true"></svg>${cols}</div>
      <div class="sp-legend"><span class="k owned">✓ taken</span><span class="k queued">◆ waiting</span><span class="k answers">answers what they face</span><span class="k closed">✕ path closed</span></div>
    </div>
    <div class="sp-lab-right">${pc ? detailOf(pc, forkTaker) : ''}</div>
  </div>`;

  if (yours) try { body.querySelector('.lab-now')!.appendChild(copyOf(deps!.portrait(yours, 96))); } catch { /* decoration */ }
  const pv = lab.preview();
  const nx = body.querySelector('.lab-next');
  if (pv && nx) try { nx.appendChild(silhouette(deps!.portrait(pv, 72))); } catch { /* decoration */ }
  drawLinks(body.querySelector('.sp-path') as HTMLElement, states, owned, queue);
}

function detailOf(c: CardState, forkTaker: ReadonlyMap<string, string>): string {
  const d = c.def, dr = DRAWBACKS[d.id];
  const gains = Object.entries(d.effects).filter(([, v]) => (v ?? 0) > 0).map(([k]) => GAIN_WORDS[k] ?? k);
  const siblings = d.group ? MUTATIONS.filter(m => m.group === d.group && m.id !== d.id && (gameState.offeredMutations ?? []).includes(m.id)) : [];
  const taker = d.group ? forkTaker.get(d.group) : undefined;
  const closedBy = taker && taker !== d.id ? MUTATION_BY_ID[taker]?.label : null;
  const req = d.requiresAny?.map(r => MUTATION_BY_ID[r]?.label ?? r) ?? [];
  const action = c.status === 'queued' ? `<button type="button" class="sp-btn" data-act="unqueue">TAKE BACK</button>`
    : c.status === 'owned' ? '<div class="sp-owned">Part of them now.</div>'
    : closedBy ? `<div class="sp-closed">This path closed when they took ${esc(closedBy)}.</div>`
    : c.status === 'locked' ? `<div class="sp-closed">${esc(c.reason ?? 'Not yet')}</div>`
    : `<button type="button" class="sp-btn gold" data-act="queue" ${c.affordable ? '' : 'disabled'}>${c.affordable ? `QUEUE FOR ${c.price} DNA` : `NEEDS ${c.price - gameState.dnaPoints} MORE DNA`}</button>`;
  return `<div class="sp-mut-h"><span class="g">${esc(d.glyph)}</span>${esc(d.label)}${d.major ? '<span class="major-tag">MAJOR</span>' : ''}</div>
    <div class="sp-d-kind">${esc(bioPhaseLabel(d.phase))} · ${c.price < d.cost ? `<s>${d.cost}</s> ` : ''}${c.price} DNA</div>
    <div class="sp-blurb">${esc(d.blurb)}</div>
    ${c.answers ? `<div class="sp-ans">Answers ${esc(PRESSURE_TIMES[c.answers])}: it costs less now.</div>` : ''}
    <div class="sp-h">Gives</div><div class="sp-gain">${gains.length ? gains.map(g => `+ ${esc(g)}`).join('<br>') : '+ a new shape'}</div>
    <div class="sp-h">Costs them</div><div class="sp-cost">${dr ? `− ${esc(dr.text)}` : '− nothing more than DNA'}</div>
    ${d.major ? '<div class="sp-note">A major change: it can evolve them on its own.</div>' : ''}
    ${req.length ? `<div class="sp-note">Needs ${esc(req.join(' or '))} first.</div>` : ''}
    ${siblings.length ? `<div class="sp-note">${closedBy ? '' : `Taking it closes: ${esc(siblings.map(m => m.label).join(', '))}.`}</div>` : ''}
    <div class="sp-act">${action}</div>`;
}

/** Lines between a mutation and what it needs, and the path taken, drawn over the columns. */
function drawLinks(path: HTMLElement | null, states: readonly CardState[], owned: readonly string[], queue: readonly string[]): void {
  const svg = path?.querySelector('svg.sp-links') as SVGSVGElement | null;
  if (!path || !svg) return;
  const box = path.getBoundingClientRect();
  svg.setAttribute('width', String(path.scrollWidth));
  svg.setAttribute('height', String(path.scrollHeight));
  const at = (id: string, side: 'l' | 'r') => {
    const el = path.querySelector<HTMLElement>(`[data-mut="${CSS.escape(id)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: (side === 'l' ? r.left : r.right) - box.left + path.scrollLeft, y: r.top + r.height / 2 - box.top + path.scrollTop };
  };
  const lines: string[] = [];
  for (const c of states) for (const req of c.def.requiresAny ?? []) {
    const a = at(req, 'r'), b = at(c.def.id, 'l');
    if (!a || !b) continue;
    const lit = (owned.includes(req) || queue.includes(req)) && c.status !== 'locked';
    lines.push(`<path d="M${a.x},${a.y} C${a.x + 18},${a.y} ${b.x - 18},${b.y} ${b.x},${b.y}" class="${lit ? 'lit' : ''}"/>`);
  }
  // The path taken: each owned card to the next, then into the queue.
  const walk = [...owned, ...queue];
  for (let i = 1; i < walk.length; i++) {
    const a = at(walk[i - 1], 'r'), b = at(walk[i], 'l');
    if (!a || !b || b.x <= a.x) continue;
    lines.push(`<path d="M${a.x},${a.y} C${a.x + 18},${a.y} ${b.x - 18},${b.y} ${b.x},${b.y}" class="${i >= owned.length ? 'next' : 'taken'}"/>`);
  }
  svg.innerHTML = lines.join('');
}

function silhouette(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = copyOf(src), x = c.getContext('2d')!;
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = '#16302a';
  x.fillRect(0, 0, c.width, c.height);
  c.style.filter = 'drop-shadow(0 0 3px rgba(125,255,180,0.6))';
  return c;
}

// ── Archive ──────────────────────────────────────────────────────────────────

function renderArchive(body: HTMLElement, pool: readonly SpeciesGenome[], yours: SpeciesGenome | null): void {
  const gone = archiveRows(pool);
  if (!gone.length) { body.innerHTML = '<div class="sp-empty">No lineage has died out yet.</div>'; return; }
  const now = deps?.tick() ?? 0;
  body.innerHTML = `<div class="sp-arch">${gone.map(g => {
    const lived = g.extinct ? yearsSpan(g.extinct.tick - g.originTick) : null;
    const ago = g.extinct ? yearsSpan(now - g.extinct.tick) : null;
    const kids = childrenOf(g, pool);
    return `<div class="sp-arch-row">
      <div class="sp-arch-art"></div>
      <div class="sp-arch-txt">
        <div class="sp-arch-name">${esc(g.name)} <span class="sp-row-kind">${esc(kindOf(g))}</span></div>
        <div class="sp-arch-death">${esc(cap(deathOf(g, pool, yours?.id ?? null) ?? ''))}${ago ? ` · ${esc(ago)} ago` : ''}</div>
        <div class="sp-arch-line">${lived ? `Lasted ${esc(lived)}` : 'Lasted an age no one counted'}${kids.length ? ` · left ${esc(kids.map(k => k.name).join(', '))}` : ' · left no descendants'}</div>
      </div></div>`;
  }).join('')}</div>`;
  body.querySelectorAll<HTMLElement>('.sp-arch-art').forEach((el, i) => {
    try { el.appendChild(copyOf(deps!.portrait(gone[i], 40))); } catch { /* decoration */ }
  });
}

function copyOf(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d')?.drawImage(src, 0, 0);
  return c;
}

const SP_CSS = `
#species-screen{position:fixed;inset:0;z-index:303;display:none;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at center,rgba(8,20,16,0.72),rgba(0,0,0,0.86))}
#species-screen.open{display:flex}
#species-screen .sp-frame{width:min(1200px,calc(100vw - 32px));height:min(720px,calc(100vh - 48px));display:flex;flex-direction:column;
  background:#0f1416;border:2px solid #3f6a58;box-shadow:0 0 0 4px #0a1210,0 12px 40px rgba(0,0,0,.7)}
#species-screen .sp-top{display:flex;align-items:baseline;justify-content:center;gap:16px;padding:10px;border-bottom:1px solid rgba(93,204,138,.25);
  background:linear-gradient(#142520,#0f1a17)}
#species-screen .sp-title{font-family:var(--font-display,Georgia,serif);letter-spacing:4px;color:#7fe0a4;font-size:17px}
#species-screen .sp-census{font-size:11px;color:#9fb8ad;letter-spacing:1px}
#species-screen .sp-tabs{display:flex;gap:2px;padding:8px 12px 0;border-bottom:1px solid rgba(93,204,138,.25)}
#species-screen .sp-tabs button{font:inherit;font-size:12px;letter-spacing:2px;color:#9fb8ad;background:#121c1a;border:1px solid rgba(93,204,138,.2);
  border-bottom:none;padding:7px 22px;cursor:pointer}
#species-screen .sp-tabs button.on{color:#e6f5ec;background:#1a2b26;border-color:#5dcc8a}
#species-screen .sp-body{flex:1;min-height:0;display:flex;gap:10px;padding:10px 12px;overflow:hidden}
#species-screen .sp-list{flex:0 0 270px;overflow-y:auto;display:flex;flex-direction:column;gap:3px;padding-right:4px}
#species-screen .sp-row{font:inherit;display:flex;align-items:center;gap:8px;text-align:left;padding:4px 8px;background:#121c1a;
  border:1px solid rgba(93,204,138,.15);color:#cfe3d8;cursor:pointer}
#species-screen .sp-row.sub{margin-left:18px}
#species-screen .sp-group{font-size:10px;letter-spacing:2px;color:#86a396;padding:8px 2px 3px;border-bottom:1px solid rgba(93,204,138,.15);margin-bottom:2px}
#species-screen .sp-group:first-child{padding-top:0}
#species-screen .sp-group span{color:#e6f5ec;margin-left:4px}
#species-screen .sp-group.sp-g-mind{color:#e8c98a}
#species-screen .sp-class{display:inline-block;font-size:10px;letter-spacing:1px;padding:0 5px;margin-right:6px;border:1px solid currentColor;color:#9fb8ad}
#species-screen .sp-class.sp-g-mind{color:#e8c98a} #species-screen .sp-class.sp-g-animal{color:#7fe0a4}
#species-screen .sp-class.sp-g-plant{color:#9be27a} #species-screen .sp-class.sp-g-microbe{color:#8fd8ff}
#species-screen .sp-row.on{border-color:#5dcc8a;background:#1a2b26}
#species-screen .sp-row.yours{border-color:#c8a96e}
#species-screen .sp-row:hover{border-color:#7fe0a4}
#species-screen .sp-row-art{width:32px;height:32px;display:flex;align-items:center;justify-content:center;flex:0 0 32px}
#species-screen canvas{image-rendering:pixelated;max-width:100%;max-height:100%}
#species-screen .sp-row-txt{flex:1;min-width:0;display:flex;flex-direction:column}
#species-screen .sp-row-name{font-size:12px;color:#e6f5ec;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#species-screen .sp-row-kind{font-size:10px;color:#86a396}
#species-screen .sp-row-pct{font-size:11px;color:#7fe0a4}
#species-screen .sp-detail{flex:1;min-width:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
#species-screen .sp-d-head{display:flex;gap:14px;align-items:center}
#species-screen .sp-d-art{width:110px;height:110px;flex:0 0 110px;display:flex;align-items:flex-end;justify-content:center;
  background:radial-gradient(ellipse at 50% 85%,rgba(93,204,138,.2),transparent 65%);border:1px solid rgba(93,204,138,.2)}
#species-screen .sp-d-name{font-family:var(--font-display,Georgia,serif);font-size:20px;color:#e6f5ec}
#species-screen .sp-d-kind{font-size:11px;color:#9fb8ad;margin-top:2px}
#species-screen .sp-rel{display:inline-block;font-size:11px;margin-top:6px;padding:2px 8px;border:1px solid currentColor}
#species-screen .r-yours{color:#e8c98a} #species-screen .r-branch,#species-screen .r-ancestor{color:#c8a0ff}
#species-screen .r-predator{color:#ff7a5c} #species-screen .r-prey{color:#7fe0a4} #species-screen .r-rival{color:#ffb27a}
#species-screen .r-harmless{color:#9fb8ad}
#species-screen .sp-nature{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
#species-screen .sp-nature span{font-size:10px;color:#cfe3d8;border:1px solid rgba(93,204,138,.3);padding:1px 6px}
#species-screen .sp-d-grid{display:grid;grid-template-columns:2fr 1fr;gap:10px}
#species-screen .sp-panel{background:#0b1110;border:1px solid rgba(93,204,138,.18);padding:6px}
#species-screen .sp-h{font-size:11px;letter-spacing:1px;color:#7fe0a4;margin-bottom:5px}
#species-screen .sp-map{display:block;width:100%;height:auto}
#species-screen .sp-map-note{font-size:10px;color:#9fb8ad;margin-top:4px}
#species-screen .sp-ring{display:block;width:120px;height:120px;margin:4px auto}
#species-screen .sp-facts{display:grid;grid-template-columns:1fr 1fr;gap:4px 14px}
#species-screen .sp-fact{display:flex;justify-content:space-between;gap:10px;font-size:11px;border-bottom:1px dotted rgba(93,204,138,.15);padding:3px 0}
#species-screen .sp-fact span{color:#86a396} #species-screen .sp-fact b{color:#e6f5ec;font-weight:normal;text-align:right}
#species-screen .sp-evo{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
#species-screen .sp-evo-now{display:flex;gap:14px;align-items:center}
#species-screen .sp-evo-dna{font-size:11px;color:#ffe08a;margin:6px 0}
#species-screen .sp-strip{display:flex;gap:8px;overflow-x:auto;padding:4px 2px}
#species-screen .sp-form{font:inherit;flex:0 0 150px;text-align:center;background:#0b1110;border:1px solid rgba(93,204,138,.2);padding:6px;color:#cfe3d8}
#species-screen .sp-form.now{border-color:#c8a96e}
#species-screen .sp-form.link{cursor:pointer} #species-screen .sp-form.link:hover{border-color:#7fe0a4}
#species-screen .sp-form-art{height:52px;display:flex;align-items:flex-end;justify-content:center}
#species-screen .sp-form-num{font-size:10px;letter-spacing:1px;color:#7fe0a4;margin-top:4px}
#species-screen .sp-form-name{font-size:12px;color:#e6f5ec}
#species-screen .sp-form-why{font-size:10px;color:#9fb8ad;margin-top:2px}
#species-screen .sp-lab{flex:1;min-height:0;display:grid;grid-template-columns:170px 1fr 230px;gap:10px}
#species-screen .sp-lab-left,#species-screen .sp-lab-right{overflow-y:auto;display:flex;flex-direction:column;gap:6px;min-height:0}
#species-screen .sp-lab-right{background:#0b1110;border:1px solid rgba(93,204,138,.18);padding:10px}
#species-screen .sp-dna{font-size:11px;color:#9fb8ad;letter-spacing:2px}
#species-screen .sp-dna b{font-size:28px;color:#ffe08a;font-weight:normal;letter-spacing:0;margin-right:4px}
#species-screen .sp-queue{display:flex;flex-direction:column;gap:3px}
#species-screen .sp-q{font:inherit;font-size:11px;text-align:left;color:#ffe08a;background:rgba(255,224,138,.08);border:1px solid rgba(255,224,138,.4);padding:3px 6px;cursor:pointer}
#species-screen .sp-q.gift{color:#c8a0ff;border-color:rgba(200,160,255,.5);background:rgba(200,160,255,.08)}
#species-screen .sp-gift{font-size:10px;color:#c8a0ff;font-style:italic;margin:0 0 3px 4px}
#species-screen .sp-next{display:flex;flex-direction:column;align-items:center;gap:3px}
#species-screen .sp-next .sp-d-art{width:84px;height:84px;flex:0 0 84px}
#species-screen .sp-next-note{font-size:10px;color:#86a396;text-align:center}
#species-screen .sp-evolve{font:inherit;font-size:11px;letter-spacing:1px;padding:9px 6px;color:#86a396;background:transparent;border:1px solid rgba(93,204,138,.3);cursor:not-allowed}
#species-screen .sp-evolve.ready{cursor:pointer;color:#04140d;background:#ffe08a;border-color:#ffe08a;letter-spacing:3px;font-size:13px;animation:spPulse 1.1s ease-in-out infinite}
@keyframes spPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,224,138,.6)}50%{box-shadow:0 0 18px 3px rgba(255,224,138,.55)}}
#species-screen .sp-lab-mid{min-width:0;min-height:0;display:flex;flex-direction:column;gap:6px}
#species-screen .sp-face{font-size:11px;color:#ffcfa8;background:rgba(60,30,20,.3);border:1px solid rgba(255,154,92,.3);padding:5px 8px}
#species-screen .sp-face b{color:#ffb27a;font-weight:normal;letter-spacing:1px}
#species-screen .sp-path{position:relative;flex:1;min-height:0;overflow:auto;display:flex;gap:12px;padding:4px 4px 8px}
#species-screen .sp-links{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}
#species-screen .sp-links path{fill:none;stroke:rgba(134,163,150,.35);stroke-width:1.5}
#species-screen .sp-links path.lit{stroke:rgba(127,224,164,.7)}
#species-screen .sp-links path.taken{stroke:#c8a96e;stroke-width:2.5}
#species-screen .sp-links path.next{stroke:#ffe08a;stroke-width:2;stroke-dasharray:4 3}
#species-screen .sp-col{flex:1 1 0;min-width:112px;display:flex;flex-direction:column;gap:4px;position:relative;z-index:1}
#species-screen .sp-col-h{font-size:9px;letter-spacing:2px;color:#86a396;display:flex;justify-content:space-between;padding-bottom:3px;border-bottom:1px solid rgba(93,204,138,.15);margin-bottom:2px}
#species-screen .sp-col.now .sp-col-h{color:#7fe0a4}
#species-screen .sp-col-h span{color:#ffe08a}
#species-screen .sp-col.later{opacity:.55}
#species-screen .sp-fork{border:1px dashed rgba(93,204,138,.35);padding:3px;display:flex;flex-direction:column;gap:3px}
#species-screen .sp-fork.taken{border-color:rgba(200,169,110,.5)}
#species-screen .sp-fork-h{font-size:8px;letter-spacing:1.5px;color:#86a396}
#species-screen .sp-mut{font:inherit;display:flex;align-items:center;gap:5px;text-align:left;padding:4px 5px;background:#121c1a;border:1px solid rgba(93,204,138,.22);color:#cfe3d8;cursor:pointer}
#species-screen .sp-mut .g{width:14px;text-align:center;font-size:12px}
#species-screen .sp-mut .n{flex:1;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#species-screen .sp-mut .p{font-size:10px;color:#ffe08a}
#species-screen .sp-mut.major{box-shadow:inset 3px 0 0 #ffe08a}
#species-screen .sp-mut.owned{background:rgba(200,169,110,.22);border-color:#c8a96e;color:#f3e6c4}
#species-screen .sp-mut.owned .p{color:#c8a96e}
#species-screen .sp-mut.queued{border-color:#ffe08a;background:rgba(255,224,138,.12)}
#species-screen .sp-mut.answers{border-color:#ffb27a;box-shadow:0 0 0 1px rgba(255,178,122,.35),0 0 8px rgba(255,178,122,.3)}
#species-screen .sp-mut.locked{opacity:.45}
#species-screen .sp-mut.poor .p{color:#ff8a6a}
#species-screen .sp-mut.closed{opacity:.3;text-decoration:line-through}
#species-screen .sp-mut.on{outline:2px solid #7fe0a4;outline-offset:0}
#species-screen .sp-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:10px;color:#86a396}
#species-screen .sp-legend .owned{color:#c8a96e} #species-screen .sp-legend .queued{color:#ffe08a}
#species-screen .sp-legend .answers{color:#ffb27a} #species-screen .sp-legend .closed{color:#86a396;text-decoration:line-through}
#species-screen .sp-mut-h{font-family:var(--font-display,Georgia,serif);font-size:17px;color:#e6f5ec;display:flex;align-items:center;gap:8px}
#species-screen .sp-mut-h .g{font-family:inherit;font-size:18px}
#species-screen .major-tag{font-size:9px;letter-spacing:1px;color:#ffe08a;border:1px solid rgba(255,224,138,.5);padding:0 4px;font-family:monospace}
#species-screen .sp-blurb{font-size:11px;color:#cfe3d8;line-height:1.5}
#species-screen .sp-ans{font-size:11px;color:#ffb27a}
#species-screen .sp-gain{font-size:11px;color:#7fe0a4;line-height:1.6}
#species-screen .sp-cost{font-size:11px;color:#ff9a80}
#species-screen .sp-note{font-size:10px;color:#9fb8ad}
#species-screen .sp-act{margin-top:auto;padding-top:8px}
#species-screen .sp-act .sp-btn{width:100%}
#species-screen .sp-btn:disabled{opacity:.5;cursor:not-allowed}
#species-screen .sp-owned{font-size:11px;color:#c8a96e}
#species-screen .sp-closed{font-size:11px;color:#86a396;font-style:italic}
@media (max-width:900px){#species-screen .sp-lab{grid-template-columns:1fr}}
#species-screen .sp-arch{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:6px;align-content:start}
#species-screen .sp-arch-row{display:flex;gap:10px;align-items:center;background:#0b1110;border:1px solid rgba(255,255,255,.08);padding:6px}
#species-screen .sp-arch-art{width:44px;height:44px;flex:0 0 44px;display:flex;align-items:center;justify-content:center;filter:grayscale(1) brightness(.7)}
#species-screen .sp-arch-name{font-size:12px;color:#cfd6d2}
#species-screen .sp-arch-death{font-size:11px;color:#ff9a80;margin-top:2px}
#species-screen .sp-arch-line{font-size:10px;color:#86a396;margin-top:2px}
#species-screen .sp-quiet{font-size:12px;color:#86a396}
#species-screen .sp-empty{flex:1;padding:50px;text-align:center;color:#9fb8ad;line-height:1.7}
#species-screen .sp-foot{display:flex;justify-content:space-between;padding:8px 12px;border-top:1px solid rgba(93,204,138,.25)}
#species-screen .sp-btn{font:inherit;font-size:12px;letter-spacing:2px;color:#e6f5ec;background:#142520;border:1px solid rgba(93,204,138,.4);padding:7px 22px;cursor:pointer}
#species-screen .sp-btn.gold{border-color:#c8a96e;color:#f3e6c4}
#species-screen .sp-btn:hover{border-color:#7fe0a4}
#species-screen button:focus-visible{outline:2px solid #7fe0a4;outline-offset:1px}
@media (max-width:760px){#species-screen .sp-body{flex-direction:column;overflow-y:auto}#species-screen .sp-list{flex:none;max-height:220px}
  #species-screen .sp-d-grid,#species-screen .sp-facts{grid-template-columns:1fr}}
`;
function ensureStyles(): void {
  if (document.getElementById('species-screen-css')) return;
  const st = document.createElement('style');
  st.id = 'species-screen-css';
  st.textContent = SP_CSS;
  document.head.appendChild(st);
}
