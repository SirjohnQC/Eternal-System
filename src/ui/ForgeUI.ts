/**
 * The Forge's screens (src/simulation/Forge.ts is the rules).
 *
 * Over the planet view of the molten home world:
 *   draft    — three Fate Cards; pick one, the world visibly answers; the
 *              hardening meter; two rerolls ("let the fire turn").
 *   reveal   — THE FORGING IS COMPLETE, the world described line by line.
 *   cooling  — the last crust cools (COOLING_SECONDS), first rains.
 *   whisper  — a god who is not yours whispers a sealed golden card; breaking
 *              the seal wakes life, in a cradle chance picks.
 *
 * All state lives in gameState.forge (plain JSON), so a save mid-forge
 * resumes where it was.
 */

import { SeedRNG } from '../utils/SeedRNG';
import { gameState } from '../simulation/GameState';
import { ladderOf } from '../simulation/Formation';
import type { PlanetFormationStage } from '../simulation/BigBangEngine';
import {
  FATE_BY_ID, FORGE_TARGET, COOLING_SECONDS, type ForgeState, type ForgedCard,
  forgeCard, rerollHand, forgeProgress, valueOf, destinyOf, planetDNAOf,
  beginCooling, coolingLeft, rollCradle, sparkTempo, forceHint,
} from '../simulation/Forge';

export interface ForgeDeps {
  /** Repaint the home world: destiny, stage, surface DNA (engine.shapeForgedWorld). */
  shape: (destiny: ReturnType<typeof destinyOf>, stage: PlanetFormationStage, dna: ReturnType<typeof planetDNAOf>) => void;
  /** Regenerate the diorama (refreshHomeWorldSurface). */
  refreshWorld: () => void;
  /** Open the planet view on the home world. */
  openWorld: () => void;
  /** A new formation stage reached (bottom bar label, feed). */
  stageChanged: (stage: PlanetFormationStage) => void;
  /** The golden spark: finish the world and wake life. */
  spark: (tempo: number) => void;
  chat: (text: string, who: 'god' | 'system') => void;
  godName: () => string;
  planetName: () => string;
}

let deps: ForgeDeps | null = null;
let coolTimer = 0;
let lastShape = '';
let lastStage: PlanetFormationStage | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const st = (): ForgeState | null => gameState.forge;

// ─── World sync ───────────────────────────────────────────────────────────────

/** Paint the world as the forces make it: destiny from the DNA, stage from the hardening. */
function syncWorld(force = false): void {
  const s = st();
  if (!s || !deps) return;
  const destiny = s.outcome?.destiny ?? destinyOf(s.dna);
  const dna = s.outcome?.planetDNA ?? planetDNAOf(s.dna);
  const ladder = ladderOf(destiny);
  const stage = s.phase === 'draft'
    ? ladder[Math.min(ladder.length - 2, Math.floor(forgeProgress(s) * (ladder.length - 1)))]
    : ladder[ladder.length - 1];
  const key = `${destiny}|${stage}|${dna.climate}|${dna.oceans}|${dna.chaos}`;
  if (!force && key === lastShape) return;
  lastShape = key;
  deps.shape(destiny, stage, dna);
  if (stage !== lastStage) { lastStage = stage; deps.stageChanged(stage); }
  deps.refreshWorld();
}

// ─── DOM ──────────────────────────────────────────────────────────────────────

function root(): HTMLElement {
  let el = document.getElementById('forge-ui');
  if (!el) {
    el = document.createElement('div');
    el.id = 'forge-ui';
    document.body.appendChild(el);
  }
  return el;
}

function cardFace(card: ForgedCard, index: number): string {
  const def = FATE_BY_ID[card.id];
  const unknown = !!card.hidden;
  const value = unknown ? '?' : String(valueOf(card));
  return `<button class="fate-card fate-${def.tone}${unknown ? ' fate-unknown' : ''}${def.answers ? ' fate-reaction' : ''}" data-i="${index}" style="--deal:${index}">
    <span class="fate-notch tl"></span><span class="fate-notch br"></span>
    ${def.answers ? `<span class="fate-ribbon">The world answers</span>` : ''}
    <span class="fate-name">${esc(def.name)}</span>
    <span class="fate-icon-wrap"><img class="fate-icon" src="/assets/pixel/divine/cards/${def.icon}.png" alt="" width="40" height="40"/></span>
    <span class="fate-text">${esc(def.text)}</span>
    ${def.answers ? `<span class="fate-answers">${esc(def.answers)}</span>` : ''}
    <span class="fate-value">+${value} <i>forging</i></span>
  </button>`;
}

function meter(s: ForgeState): string {
  const p = forgeProgress(s), pct = Math.floor(p * 100);
  const segs = 24, on = Math.round(p * segs);
  const left = Math.max(0, FORGE_TARGET - s.points);
  return `<div class="forge-meter">
    <div class="forge-meter-label">THE WORLD IS HARDENING&hellip; <b>${pct}%</b></div>
    <div class="forge-bar">${Array.from({ length: segs }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>
    <div class="forge-meter-sub">${pct >= 80 ? `${left} point${left === 1 ? '' : 's'} remain` : '&nbsp;'}</div>
  </div>`;
}

function forgedStrip(s: ForgeState): string {
  if (!s.played.length) return '';
  return `<div class="forge-strip">${s.played.map(c => {
    const d = FATE_BY_ID[c.id];
    return `<img src="/assets/pixel/divine/cards/${d.icon}.png" alt="" width="20" height="20" title="${esc(d.name)}" class="fate-${d.tone}"/>`;
  }).join('')}</div>`;
}

function renderDraft(note = ''): void {
  const s = st();
  if (!s) return;
  const r = root();
  r.className = 'forge-draft';
  const first = s.round === 0;
  r.innerHTML = `
    <div class="forge-head">
      <div class="forge-title">THE FORGE</div>
      <div class="forge-sub">${esc(note || (first ? s.omen : 'Choose the next force. The others burn.'))}</div>
      ${meter(s)}
      ${forgedStrip(s)}
    </div>
    <div class="forge-foot">
      <div class="forge-hand">${s.hand.map(cardFace).join('')}</div>
      <button class="forge-reroll" ${s.rerolls > 0 ? '' : 'disabled'}>LET THE FIRE TURN <span>(${s.rerolls})</span></button>
    </div>
    <div id="forge-flash"></div>`;
  r.querySelectorAll<HTMLButtonElement>('.fate-card').forEach(btn => {
    btn.addEventListener('click', () => pick(Number(btn.dataset['i'])));
  });
  r.querySelector('.forge-reroll')?.addEventListener('click', () => {
    if (!rerollHand(s)) return;
    renderDraft('The fire turns. New forces rise from it.');
  });
}

let picking = false;
function pick(i: number): void {
  const s = st();
  if (!s || !deps || picking) return;
  const card = s.hand[i];
  if (!card) return;
  const def = FATE_BY_ID[card.id];
  picking = true;
  const r = root();
  r.querySelectorAll<HTMLElement>('.fate-card').forEach((el, k) => el.classList.add(k === i ? 'fate-forged' : 'fate-burned'));
  const flash = document.getElementById('forge-flash');
  if (flash) { flash.className = `fate-${def.tone} on`; }
  window.setTimeout(() => {
    forgeCard(s, i);
    picking = false;
    syncWorld();
    if (s.phase === 'reveal') { showReveal(); return; }
    renderDraft(forceHint(card));
  }, 650);
}

// ─── Reveal ───────────────────────────────────────────────────────────────────

function modal(cls: string, html: string): HTMLElement {
  document.getElementById('forge-modal')?.remove();
  const m = document.createElement('div');
  m.id = 'forge-modal';
  m.className = cls;
  m.innerHTML = `<div class="forge-modal-box">${html}</div>`;
  document.body.appendChild(m);
  return m;
}

function showReveal(): void {
  const s = st();
  if (!s?.outcome || !deps) return;
  root().className = 'forge-quiet';
  root().innerHTML = '';
  gameState.forgeMods = s.outcome.mods;
  const o = s.outcome;
  const lines: string[] = [];
  let k = 0;
  const line = (html: string, cls = '') => lines.push(`<div class="fr-line ${cls}" style="--k:${k++}">${html}</div>`);
  for (const [label, value] of o.traits) line(`<span class="fr-k">${esc(label)}</span><span class="fr-v">${esc(value)}</span>`);
  for (const u of o.unveiled) line(`<span class="fr-k">The unknown force</span><span class="fr-v">${esc(u.title)}: ${esc(u.line)}</span>`, 'fr-unknown');
  if (o.unusual) line(`<em>${esc(o.unusual)}</em>`, 'fr-unusual');
  line('PLANET DNA FORGED', 'fr-stamp');
  const m = modal('forge-reveal', `
    <div class="fm-title">THE FORGING IS COMPLETE</div>
    <div class="fm-sub">A young world emerges from the darkness: <b>${esc(deps.planetName())}</b>.</div>
    <div class="fr-lines">${lines.join('')}</div>
    <button class="forge-go" style="--k:${k + 1}">LET IT COOL</button>`);
  deps.chat(`${deps.planetName()} is forged. Now it must cool before anything can live on it.`, 'god');
  m.querySelector('.forge-go')?.addEventListener('click', () => {
    m.remove();
    beginCooling(s, Date.now());
    syncWorld(true);
    showCooling();
  });
}

// ─── Cooling ──────────────────────────────────────────────────────────────────

const COOL_LINES = [
  'Steam rises from new stone.',
  'The first rain falls, and does not boil away.',
  'Water gathers in the low places.',
  'The sky clears, a little.',
  'The crust stops cracking. Mostly.',
];

function showCooling(): void {
  const s = st();
  if (!s || !deps) return;
  const r = root();
  r.className = 'forge-cooling';
  window.clearInterval(coolTimer);
  const tick = () => {
    const left = coolingLeft(s, Date.now());
    s.coolingDone = COOLING_SECONDS - left;
    s.coolingStart = Date.now();
    if (left <= 0) { window.clearInterval(coolTimer); showWhisper(); return; }
    const p = 1 - left / COOLING_SECONDS, segs = 24, on = Math.round(p * segs);
    const m = Math.floor(left / 60), sec = Math.floor(left % 60);
    const flavour = COOL_LINES[Math.min(COOL_LINES.length - 1, Math.floor(p * COOL_LINES.length))];
    r.innerHTML = `<div class="forge-head">
      <div class="forge-title">THE LAST CRUST COOLS</div>
      <div class="forge-sub">${esc(flavour)}</div>
      <div class="forge-meter"><div class="forge-meter-label">${m}:${String(sec).padStart(2, '0')}</div>
      <div class="forge-bar forge-bar-cool">${Array.from({ length: segs }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div></div>
    </div>`;
  };
  tick();
  coolTimer = window.setInterval(tick, 1000);
}

// ─── The whisper and the spark ────────────────────────────────────────────────

function showWhisper(): void {
  const s = st();
  if (!s || !deps) return;
  s.phase = 'whisper';
  root().className = 'forge-quiet';
  root().innerHTML = '';
  const god = deps.godName();
  const m = modal('forge-whisper', `
    <div class="fm-title">A WHISPER</div>
    <div class="fm-sub">A voice that is not ${esc(god)}'s speaks, very close:</div>
    <div class="fw-quote">&ldquo;I am ${esc(s.whisperer)}. Take this. Break it when you are ready, and tell ${esc(god)} nothing.&rdquo;</div>
    <div class="fw-card-wrap"><div class="fate-card fate-golden fw-card">
      <span class="fate-notch tl"></span><span class="fate-notch br"></span>
      <span class="fate-name">???</span>
      <span class="fate-icon-wrap"><img class="fate-icon" src="/assets/pixel/divine/cards/golden.png" alt="" width="40" height="40"/></span>
      <span class="fate-text">Sealed. Warm to the touch.</span>
      <span class="fate-value">a gift</span>
    </div></div>
    <button class="forge-go">BREAK THE SEAL</button>`);
  deps.chat(`${god}: Someone has been speaking to you. I felt it.`, 'god');
  m.querySelector('.forge-go')?.addEventListener('click', () => breakSeal(m));
}

function breakSeal(m: HTMLElement): void {
  const s = st();
  if (!s || !deps) return;
  const rng = new SeedRNG(`${s.seed}_forge_spark`);
  s.cradle = rollCradle(s, rng);
  const tempo = sparkTempo(rng);
  const card = m.querySelector('.fw-card');
  card?.classList.add('fw-open');
  window.setTimeout(() => {
    if (card) card.innerHTML = `<span class="fate-notch tl"></span><span class="fate-notch br"></span>
      <span class="fate-name">THE SPARK</span>
      <span class="fate-icon-wrap"><img class="fate-icon" src="/assets/pixel/divine/cards/seed.png" alt="" width="40" height="40"/></span>
      <span class="fate-text">Life wakes ${esc(s.cradle!)}.</span>
      <span class="fate-value">life</span>`;
    const btn = m.querySelector<HTMLButtonElement>('.forge-go');
    if (btn) {
      btn.textContent = 'LET IT LIVE';
      btn.onclick = () => {
        m.remove();
        s.phase = 'done';
        root().remove();
        document.body.classList.remove('forging');
        deps!.spark(tempo);
        deps!.chat(`Life has woken on ${deps!.planetName()}, ${s.cradle}.`, 'god');
      };
    }
  }, 700);
}

// ─── Entry ────────────────────────────────────────────────────────────────────

/**
 * Show the Forge for gameState.forge, at whatever phase it is in (new game or
 * a reloaded save).
 */
export function runForge(d: ForgeDeps): void {
  const s = st();
  if (!s || s.phase === 'done') return;
  deps = d;
  lastShape = '';
  lastStage = null;
  document.body.classList.add('forging');
  d.openWorld();
  syncWorld(true);
  if (s.phase === 'draft') {
    renderDraft();
    d.chat(`${d.godName()}: The world is still fire. Shape it, and I will watch what you make.`, 'god');
  } else if (s.phase === 'reveal') showReveal();
  else if (s.phase === 'cooling') { s.coolingStart = Date.now(); showCooling(); }
  else if (s.phase === 'whisper') showWhisper();
}

/** True while the Forge is running (the HUD hides the faith deck, etc.). */
export function forgeActive(): boolean {
  const s = st();
  return !!s && s.phase !== 'done';
}
