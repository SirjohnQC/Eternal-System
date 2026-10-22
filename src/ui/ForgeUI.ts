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

import { cardArt } from './CardArt';
import { playSealBreak } from './SealBreak';
import { SeedRNG } from '../utils/SeedRNG';
import { gameState } from '../simulation/GameState';
import { ladderOf } from '../simulation/Formation';
import type { PlanetFormationStage } from '../simulation/BigBangEngine';
import {
  FATE_BY_ID, FORGE_TARGET, COOLING_SECONDS, type ForgeState, type ForgedCard,
  forgeCard, rerollHand, forgeProgress, valueOf, destinyOf, planetDNAOf,
  beginCooling, coolingLeft, advanceCooling, rollCradle, sparkTempo, forceHint,
  DECREES, decreeWorld, forgeDestiny, letFateDecide,
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
  const destiny = forgeDestiny(s);
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
    ${cardArt(def.icon, 'fate-icon-wrap', `/assets/pixel/divine/cards/${def.icon}.png`)}
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

/**
 * Creative mode: the Decree row — pick the world's type outright (testing).
 * Click the decreed card again to give the choice back to the forces.
 */
function decreeRow(s: ForgeState): string {
  if (gameState.playMode !== 'creative') return '';
  return `<div class="forge-decrees">
    <span class="forge-decree-label">CREATIVE · DECREE THE WORLD</span>
    ${DECREES.map(d => `<button class="forge-decree fate-${d.tone}${s.decree === d.destiny ? ' on' : ''}" data-destiny="${d.destiny}" title="${esc(d.text)}">
      <img src="/assets/pixel/divine/cards/${d.icon}.png" alt="" width="20" height="20"/>${esc(d.name.replace('Decree: ', ''))}
    </button>`).join('')}
  </div>`;
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
      ${decreeRow(s)}
    </div>
    <div class="forge-foot">
      <div class="forge-hand">${s.hand.map(cardFace).join('')}</div>
      <div class="forge-actions">
        <button class="forge-reroll" ${s.rerolls > 0 ? '' : 'disabled'}>LET THE FIRE TURN <span>(${s.rerolls})</span></button>
        <button class="forge-reroll forge-fate" title="Fate forges the rest: a random world${s.decree ? ` (kept ${s.decree})` : ''}.">LET FATE DECIDE</button>
      </div>
    </div>
    <div id="forge-flash"></div>`;
  r.querySelectorAll<HTMLButtonElement>('.fate-card').forEach(btn => {
    btn.addEventListener('click', () => pick(Number(btn.dataset['i'])));
  });
  r.querySelector('.forge-reroll:not(.forge-fate)')?.addEventListener('click', () => {
    if (!rerollHand(s)) return;
    renderDraft('The fire turns. New forces rise from it.');
  });
  r.querySelector('.forge-fate')?.addEventListener('click', () => fateDecides());
  r.querySelectorAll<HTMLButtonElement>('.forge-decree').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = btn.dataset['destiny'] as ForgeState['decree'];
      const again = s.decree === d;
      if (!decreeWorld(s, again ? null : d ?? null)) return;
      syncWorld();
      renderDraft(again ? 'The decree is lifted. The forces decide again.'
        : `It will be ${d === 'ice' ? 'an' : 'a'} ${d === 'rocky' ? 'rocky' : d} world. The forces still shape the rest.`);
    });
  });
}

/** "Let fate decide": the rest of the forging played by fate, then the reveal. */
function fateDecides(): void {
  const s = st();
  if (!s || !deps || picking || s.phase !== 'draft') return;
  picking = true;
  const r = root();
  r.querySelectorAll<HTMLElement>('.fate-card').forEach(el => el.classList.add('fate-burned'));
  const flash = document.getElementById('forge-flash');
  if (flash) flash.className = 'fate-void on';
  deps.chat('You step back from the forge. Fate takes the hammer.', 'god');
  window.setTimeout(() => {
    letFateDecide(s);
    picking = false;
    syncWorld();
    if (s.phase === 'reveal') showReveal();
    else renderDraft();
  }, 650);
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
  let last = Date.now();
  const tick = () => {
    const now = Date.now();
    advanceCooling(s, now, (now - last) / 1000, gameState.speed);
    last = now;
    const left = coolingLeft(s, now);
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
  coolTimer = window.setInterval(tick, 250);
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
    <div class="fw-card-wrap"><div class="fate-card fate-golden fw-card fw-sprite" role="img" aria-label="A sealed golden card">
      <span class="fate-name">???</span>
      <span class="fate-value">a gift</span>
    </div><div class="fw-caption">Sealed. Warm to the touch.</div></div>
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
  const card = m.querySelector<HTMLElement>('.fw-card');
  const go = m.querySelector<HTMLButtonElement>('.forge-go');
  if (go) go.disabled = true;
  // The seal breaks (ui/SealBreak): tremble, a crack, the halves fly, the seed shows.
  const reveal = () => {
    if (card) {
      card.classList.add('fw-opened');
      card.setAttribute('aria-label', 'The golden card, broken open: a seed of light');
      card.innerHTML = `<span class="fate-name">THE SPARK</span><span class="fate-value">life</span>`;
    }
    const cap = m.querySelector('.fw-caption');
    if (cap) cap.textContent = `Life wakes ${s.cradle!}.`;
  };
  const after = () => {
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
      btn.disabled = false;
    }
  };
  if (card) playSealBreak(card, reveal, after);
  else { reveal(); after(); }
}

// ─── Entry ────────────────────────────────────────────────────────────────────

/**
 * Show the Forge for gameState.forge, at whatever phase it is in (new game or
 * a reloaded save).
 */
export function runForge(d: ForgeDeps, opts: { holdInSystem?: boolean } = {}): void {
  const s = st();
  if (!s || s.phase === 'done') return;
  deps = d;
  lastShape = '';
  lastStage = null;
  document.body.classList.add('forging');
  syncWorld(true);
  // Straight out of the Big Bang: linger on the home system (the new star,
  // its worlds still glowing) and let the player descend when ready.
  if (opts.holdInSystem && s.phase === 'draft' && s.played.length === 0) {
    awaitingDescent = true;
    document.body.classList.add('forge-await');
    showDescend();
    return;
  }
  d.openWorld();
  if (s.phase === 'draft') {
    renderDraft();
    d.chat(`${d.godName()}: The world is still fire. Shape it, and I will watch what you make.`, 'god');
  } else if (s.phase === 'reveal') showReveal();
  else if (s.phase === 'cooling') { s.coolingStart = Date.now(); showCooling(); }
  else if (s.phase === 'whisper') showWhisper();
}

let awaitingDescent = false;

/** True while the Forge waits on the system view for the player to descend. */
export function forgeAwaitingDescent(): boolean { return awaitingDescent; }

function showDescend(): void {
  document.getElementById('forge-descend')?.remove();
  const el = document.createElement('div');
  el.id = 'forge-descend';
  el.innerHTML = `<div class="fd-line">A new star burns. Around it, ${deps!.planetName()} is still fire.</div>
    <button class="forge-go fd-go">DESCEND TO ${deps!.planetName().toUpperCase()}</button>`;
  document.body.appendChild(el);
  el.querySelector<HTMLButtonElement>('.fd-go')!.onclick = () => forgeDescend(true);
}

/**
 * Leave the system view for the molten world and start the draft.
 * `open`: also open the world (false when the host is already opening it).
 */
export function forgeDescend(open: boolean): void {
  if (!awaitingDescent || !deps) return;
  awaitingDescent = false;
  document.body.classList.remove('forge-await');
  document.getElementById('forge-descend')?.remove();
  if (open) deps.openWorld();
  syncWorld(true);
  renderDraft();
  deps.chat(`${deps.godName()}: The world is still fire. Shape it, and I will watch what you make.`, 'god');
}

/** True while the Forge is running (the HUD hides the faith deck, etc.). */
export function forgeActive(): boolean {
  const s = st();
  return !!s && s.phase !== 'done';
}
