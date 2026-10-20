/**
 * "Your People" (docs/plans/2026-10-19-species-bond-and-cards.md, pillar A):
 * the species entry. Who they are, what they are doing now, what presses on
 * them (as symptoms), what they believe about you, what came of your signs,
 * and their lineage with what shaped each form. The Evolution Lab opens from
 * here (decision 1).
 *
 * Reads the simulation (runtimeState.playerNations, gameState); words come
 * from simulation/PeopleStory. Owns no state but whether it is open. Refreshes
 * once a second while open, rebuilding only when what it shows has changed.
 */
import { gameState, runtimeState } from '../simulation/GameState';
import type { SpeciesGenome } from '../simulation/SpeciesGenome';
import {
  symptomsOf, activityOf, ACTIVITY_WORDS, natureOf, beliefsOf, shapedBy, headingOf, beatsSince, plural,
} from '../simulation/PeopleStory';
import { openChronicle } from './ChronicleUI';

export interface YourPeopleDeps {
  /** The player's own lineage now (the Evolution Lab's specimen). */
  specimen(): SpeciesGenome | null;
  /** A crisp portrait canvas (may be a shared cached canvas; the panel draws a copy). */
  portrait(g: SpeciesGenome, px: number): HTMLCanvasElement;
  mutationLabel(id: string): string;
  openLab(): void;
  /** "Microbial", "Intelligent"… (Progression's label). */
  phaseLabel(): string;
}

let deps: YourPeopleDeps | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastSig = '';

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const roman = (n: number) => ROMAN[n - 1] ?? String(n);

export function initYourPeople(d: YourPeopleDeps): void { deps = d; }

/** The people's name as the player knows it. */
export function peopleName(sp: SpeciesGenome | null): string {
  return (gameState.playerSpeciesName || sp?.name || 'your people').trim();
}

export function openYourPeople(): void {
  if (!deps) return;
  ensureStyles();
  let box = document.getElementById('your-people');
  if (!box) {
    box = document.createElement('div');
    box.id = 'your-people';
    box.innerHTML = `<div class="yp-frame" role="dialog" aria-label="Your People">
      <div class="yp-top">YOUR PEOPLE</div>
      <div class="yp-body"></div>
      <div class="yp-foot"><button class="yp-btn" data-act="close" type="button">CLOSE</button>
        <button class="yp-btn gold" data-act="lab" type="button">EVOLUTION LAB</button></div></div>`;
    document.body.appendChild(box);
    box.addEventListener('click', e => {
      if (e.target === box) { closeYourPeople(); return; }
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-entry]');
      if (!t) return;
      if (t.dataset.act === 'close') closeYourPeople();
      else if (t.dataset.act === 'lab') { closeYourPeople(); deps?.openLab(); }
      else if (t.dataset.entry) openChronicle({ entry: Number(t.dataset.entry) });
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeYourPeople(); });
  }
  box.classList.add('open');
  lastSig = '';
  render();
  if (!timer) timer = setInterval(render, 1000);
}

export function closeYourPeople(): void {
  document.getElementById('your-people')?.classList.remove('open');
  if (timer) { clearInterval(timer); timer = null; }
}

function render(): void {
  const box = document.getElementById('your-people');
  if (!box?.classList.contains('open') || !deps) return;
  const body = box.querySelector('.yp-body') as HTMLElement;
  const sp = deps.specimen();
  const ns = runtimeState.playerNations ?? null;
  const bio = gameState.playerBiosphere ?? null;
  const symptoms = symptomsOf(ns, bio);
  const activity = activityOf(ns, bio);
  const beliefs = beliefsOf(ns);
  const beats = beatsSince(ns, new Set(), 0.5, 3);
  const forms = gameState.speciesForms;
  const sig = [sp?.id, sp?.name, forms.length, deps.phaseLabel(), activity, gameState.dnaPoints,
    symptoms.map(s => s.text).join('|'), beliefs.map(b => b.text).join('|'), beats.map(b => b.entry.id).join(',')].join('#');
  if (sig === lastSig) return;
  lastSig = sig;

  if (!sp) {
    body.innerHTML = `<div class="yp-empty">Life has not yet taken hold on your world.<br>When it does, its story starts here.</div>`;
    return;
  }
  const name = peopleName(sp);
  const form = Math.max(1, forms.length);
  const nature = natureOf(sp);
  const sevDots = (n: number) => '●'.repeat(n) + '○'.repeat(3 - n);

  body.innerHTML = `
    <section class="yp-who">
      <div class="yp-art"></div>
      <div class="yp-name">${esc(plural(name))}</div>
      <div class="yp-sub">Form ${roman(form)} · ${esc(deps.phaseLabel())}</div>
      <div class="yp-doing">Most of them are <b>${esc(ACTIVITY_WORDS[activity])}</b>.</div>
      <div class="yp-nature">${nature.map(w => `<span>${esc(w)}</span>`).join('')}</div>
    </section>
    <section class="yp-col">
      <div class="yp-h">What presses on them</div>
      <div class="yp-list">${symptoms.length
        ? symptoms.map(s => `<div class="yp-sym s${s.severity}"><span class="yp-dots" aria-label="severity ${s.severity} of 3">${sevDots(s.severity)}</span>${esc(cap(s.text))}</div>`).join('')
        : '<div class="yp-quiet">Nothing presses hard on them now.</div>'}</div>
      <div class="yp-heading">${esc(headingOf(symptoms))}</div>
      <div class="yp-h">What they believe about you</div>
      <div class="yp-list">${beliefs.length
        ? beliefs.map(b => b.cast ? `<button type="button" class="yp-belief link" data-entry="${b.cast}">${esc(b.text)}</button>` : `<div class="yp-belief">${esc(b.text)}</div>`).join('')
        : '<div class="yp-quiet">They have no word for you yet.</div>'}</div>
      ${beats.length ? `<div class="yp-h">What came of your signs</div><div class="yp-list">${beats.map(b =>
        `<button type="button" class="yp-beat link" data-entry="${b.entry.id}">${esc(b.entry.what)}</button>`).join('')}</div>` : ''}
    </section>
    <section class="yp-lineage">
      <div class="yp-h">Their lineage</div>
      <div class="yp-strip"></div>
    </section>`;

  try { body.querySelector('.yp-art')!.appendChild(copyOf(deps.portrait(sp, 150))); } catch { /* portrait is decoration */ }
  const strip = body.querySelector('.yp-strip') as HTMLElement;
  forms.forEach((f, i) => {
    const shaped = shapedBy(f, i > 0 ? forms[i - 1].tick : -1, ns, deps!.mutationLabel);
    const el = document.createElement(shaped.entry ? 'button' : 'div');
    el.className = 'yp-form' + (i === forms.length - 1 ? ' now' : '') + (shaped.entry ? ' link' : '');
    if (shaped.entry) { (el as HTMLButtonElement).type = 'button'; el.dataset.entry = String(shaped.entry); }
    el.innerHTML = `<div class="yp-form-art"></div><div class="yp-form-num">FORM ${roman(f.form)}</div>
      <div class="yp-form-name">${esc(f.name)}</div><div class="yp-form-why">${esc(cap(shaped.text))}</div>`;
    try { el.querySelector('.yp-form-art')!.appendChild(copyOf(deps!.portrait(f.genome, 48))); } catch { /* decoration */ }
    strip.appendChild(el);
  });
  if (!forms.length) strip.innerHTML = '<div class="yp-quiet">They have not changed yet.</div>';
}

function copyOf(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d')?.drawImage(src, 0, 0);
  return c;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const YP_CSS = `
#your-people{position:fixed;inset:0;z-index:303;display:none;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at center,rgba(14,7,30,0.72),rgba(0,0,0,0.85))}
#your-people.open{display:flex}
#your-people .yp-frame{width:min(1000px,calc(100vw - 32px));max-height:calc(100vh - 48px);display:flex;flex-direction:column;
  background:#120d1f;border:2px solid #6b5537;box-shadow:0 0 0 4px #1a1209,0 12px 40px rgba(0,0,0,.7)}
#your-people .yp-top{text-align:center;padding:10px;font-family:var(--font-display,Georgia,serif);letter-spacing:4px;color:var(--gold,#c8a96e);
  font-size:17px;border-bottom:1px solid rgba(200,169,110,.3);background:linear-gradient(#1c1430,#140e22)}
#your-people .yp-body{display:grid;grid-template-columns:260px 1fr;grid-template-rows:auto auto;gap:12px;padding:12px;overflow:auto;min-height:0}
#your-people .yp-who{grid-row:1;text-align:center;background:#0d0919;border:1px solid rgba(200,169,110,.2);padding:12px}
#your-people .yp-art{height:170px;display:flex;align-items:flex-end;justify-content:center;
  background:radial-gradient(ellipse at 50% 90%,rgba(93,204,138,.18),transparent 60%)}
#your-people canvas{image-rendering:pixelated;max-width:100%;max-height:100%}
#your-people .yp-name{font-family:var(--font-display,Georgia,serif);font-size:20px;color:#f3e6c4;margin-top:8px}
#your-people .yp-sub{font-size:11px;color:#a99a80;letter-spacing:1px;margin-top:2px}
#your-people .yp-doing{font-size:12px;color:#cdbfa6;margin-top:10px}
#your-people .yp-doing b{color:#7fe0a4;font-weight:normal}
#your-people .yp-nature{display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-top:10px}
#your-people .yp-nature span{font-size:11px;color:#e8dcc4;border:1px solid rgba(200,169,110,.3);padding:2px 6px;background:#1b1530}
#your-people .yp-col{grid-row:1;display:flex;flex-direction:column;gap:6px;min-width:0}
#your-people .yp-h{font-size:12px;letter-spacing:1px;color:var(--gold,#c8a96e);padding:4px 8px;background:#1b1530;border:1px solid rgba(200,169,110,.25);margin-top:4px}
#your-people .yp-list{display:flex;flex-direction:column;gap:4px}
#your-people .yp-sym,#your-people .yp-belief,#your-people .yp-beat,#your-people .yp-quiet{font:inherit;font-size:12px;color:#e8dcc4;text-align:left;
  background:#0d0919;border:1px solid rgba(200,169,110,.15);padding:6px 8px}
#your-people .yp-quiet{color:#a99a80}
#your-people .yp-dots{letter-spacing:1px;margin-right:8px;font-size:9px}
#your-people .s1 .yp-dots{color:#e0b84f} #your-people .s2 .yp-dots{color:#ff9a5c} #your-people .s3 .yp-dots{color:#ff5c5c}
#your-people .yp-heading{font-size:12px;color:#a8d8ff;font-style:italic;padding:2px 8px}
#your-people .link{cursor:pointer}
#your-people .link:hover{border-color:var(--gold,#c8a96e)}
#your-people .link:focus-visible,#your-people .yp-btn:focus-visible{outline:2px solid var(--gold,#c8a96e);outline-offset:1px}
#your-people .yp-beat::before{content:'↳ ';color:var(--gold,#c8a96e)}
#your-people .yp-lineage{grid-column:1/-1}
#your-people .yp-strip{display:flex;gap:8px;overflow-x:auto;padding:6px 2px}
#your-people .yp-form{font:inherit;flex:0 0 150px;text-align:center;background:#0d0919;border:1px solid rgba(200,169,110,.2);padding:6px;color:#cdbfa6}
#your-people .yp-form.now{border-color:#7bd88f}
#your-people .yp-form-art{height:52px;display:flex;align-items:flex-end;justify-content:center}
#your-people .yp-form-num{font-size:10px;letter-spacing:1px;color:var(--gold,#c8a96e);margin-top:4px}
#your-people .yp-form-name{font-size:12px;color:#f3e6c4}
#your-people .yp-form-why{font-size:11px;color:#a99a80;margin-top:2px}
#your-people .yp-foot{display:flex;justify-content:space-between;padding:8px 10px;border-top:1px solid rgba(200,169,110,.25)}
#your-people .yp-btn{font:inherit;font-size:12px;letter-spacing:2px;color:#e8dcc4;background:#1b1530;border:1px solid rgba(200,169,110,.4);padding:7px 26px;cursor:pointer}
#your-people .yp-btn.gold{color:#f3e6c4;border-color:var(--gold,#c8a96e)}
#your-people .yp-btn:hover{border-color:var(--gold,#c8a96e)}
#your-people .yp-empty{grid-column:1/-1;padding:50px;text-align:center;color:#a99a80;line-height:1.7}
@media (max-width:760px){#your-people .yp-body{grid-template-columns:1fr}#your-people .yp-who,#your-people .yp-col{grid-row:auto}}
`;
function ensureStyles(): void {
  if (document.getElementById('your-people-css')) return;
  const st = document.createElement('style');
  st.id = 'your-people-css';
  st.textContent = YP_CSS;
  document.head.appendChild(st);
}
