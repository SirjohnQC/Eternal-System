/**
 * The universe map's instruments (shown at the Universe and Sector scales):
 *   - the OBSERVATORY readout: what the player's people know of the universe,
 *     ticking live (sectors charted, galaxies seen, systems known,
 *     civilisations, wars, signals in transit, the universe's age);
 *   - overlay buttons that recolour the map by what the simulation is doing
 *     (life, civilisations, wars, trade, your faith);
 *   - a card for a dormant galaxy clicked in another sector.
 */

import type { BigBangEngine } from '../simulation/BigBangEngine';
import type { DormantGalaxy } from '../simulation/Universe';
import type { MapOverlay } from '../rendering/PixiBigBangRenderer';

export interface UniverseMapDeps {
  engine: () => BigBangEngine | null;
  setOverlay: (mode: MapOverlay) => void;
  /** Hidden while another phase owns the screen (cinematic, forge, planet view). */
  blocked: () => boolean;
}

const OVERLAYS: Array<[MapOverlay, string, string]> = [
  ['life', 'LIFE', 'Worlds where life is known'],
  ['civ', 'CIVS', 'Known civilisations, in their colours'],
  ['conflict', 'WARS', 'Wars among the known worlds'],
  ['trade', 'TRADE', 'Trade between the stars'],
  ['faith', 'FAITH', 'Where your faith has spread'],
];

let deps: UniverseMapDeps | null = null;
let mode: MapOverlay = 'none';

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

function age(tick: number): string {
  const y = tick * 10;
  return y > 1e9 ? `${(y / 1e9).toFixed(1)}B yrs` : y > 1e6 ? `${(y / 1e6).toFixed(1)}M yrs` : y > 1e3 ? `${Math.round(y / 1e3)}K yrs` : `${y} yrs`;
}

function panel(): HTMLElement {
  let el = document.getElementById('umap-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'umap-panel';
    el.innerHTML = `<div class="umap-title">OBSERVATORY</div>
      <div class="umap-sector"></div>
      <div class="umap-rows"></div>
      <div class="umap-overlays">${OVERLAYS.map(([m, label, tip]) => `<button class="umap-ov" data-mode="${m}" title="${esc(tip)}">${label}</button>`).join('')}</div>
      <div class="umap-hint">Click a sector to fly there</div>`;
    document.body.appendChild(el);
    el.querySelectorAll<HTMLButtonElement>('.umap-ov').forEach(b => b.addEventListener('click', () => {
      const m = b.dataset['mode'] as MapOverlay;
      mode = mode === m ? 'none' : m;
      deps?.setOverlay(mode);
      el!.querySelectorAll('.umap-ov').forEach(x => x.classList.toggle('on', (x as HTMLElement).dataset['mode'] === mode));
    }));
  }
  return el;
}

function refresh(): void {
  const e = deps?.engine();
  const el = panel();
  const tier = e?.zoomTier;
  const show = !!e && !!e.cosmos && (tier === 'cosmos' || tier === 'universe') && !deps!.blocked();
  el.classList.toggle('on', show);
  // The faith deck folds away on the universe map: the map needs the height.
  document.body.classList.toggle('umap-cosmos', show && tier === 'cosmos');
  if (!show || !e?.cosmos) return;
  const c = e.cosmos;
  const states = c.sectors.map(s => e.sectorStateOf(s.index));
  const charted = states.filter(s => s === 'home' || s === 'charted').length;
  const seenGalaxies = e.currentGalaxies.filter(g => g.starIds.length).length
    + c.sectors.filter(s => !s.home && states[s.index] !== 'unknown').reduce((a, s) => a + s.galaxyCount, 0);
  const known = e.stars.filter(s => !s.isDead && e.isStarKnownToPlayer(s));
  const civs = known.filter(s => !s.isPlayerStar && s.biologyPhase === 'intelligent' && s.civLevel >= 1).length;
  const knownIds = new Set(known.map(s => s.id));
  const wars = e.activeWars.filter(w => knownIds.has(w.attackerStarId) || knownIds.has(w.defenderStarId)).length;
  const signals = e.currentCosmicSignals.filter(sg => !sg.decoded).length;
  const view = e.viewSector;
  const here = view >= 0 ? c.sectors[view] : null;
  const hereState = view >= 0 ? states[view] : null;
  el.querySelector('.umap-sector')!.innerHTML = tier === 'cosmos'
    ? `The universe · ${c.sectors.length} sectors`
    : here ? `${hereState === 'unknown' ? 'An uncharted sector' : esc(here.name)}${hereState === 'home' ? ' <b>· your sector</b>' : ''}` : 'Between sectors';
  const rows: Array<[string, string]> = [
    ['Age', age(e.currentTick | 0)],
    ['Sectors charted', `${charted} / ${c.sectors.length}`],
    ['Galaxies seen', String(seenGalaxies)],
    ['Systems known', String(known.length)],
    ['Civilisations', String(civs)],
    ['Wars', String(wars)],
    ['Signals in transit', String(signals)],
  ];
  el.querySelector('.umap-rows')!.innerHTML = rows.map(([k, v]) => `<div class="umap-row"><span>${k}</span><b>${v}</b></div>`).join('');
  el.querySelector<HTMLElement>('.umap-hint')!.textContent = tier === 'cosmos' ? 'Click a sector to fly there · arrows to hop' : 'Arrows hop sectors · scroll out for all';
}

/** Start the instruments (once per page; they follow whichever engine is live). */
export function initUniverseMap(d: UniverseMapDeps): void {
  deps = d;
  panel();
  window.setInterval(refresh, 400);
  // Arrow keys hop to the neighbouring sector (on the map or in a sector).
  window.addEventListener('keydown', (ev) => {
    const e = deps?.engine();
    const t = ev.target as HTMLElement | null;
    if (!e?.cosmos || deps!.blocked() || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.zoomTier !== 'universe' && e.zoomTier !== 'cosmos') return;
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d0 = step[ev.key];
    if (!d0) return;
    const here = e.viewSector >= 0 ? e.cosmos.sectors[e.viewSector] : e.cosmos.sectors[e.cosmos.home];
    const to = e.cosmos.sectors.find(s => s.ix === here.ix + d0[0] && s.iy === here.iy + d0[1]);
    if (!to) return;
    ev.preventDefault();
    e.flyToSector(to.index);
  });
}

/** A dormant galaxy in another sector, clicked on the map. */
export function showDormantGalaxyCard(gal: DormantGalaxy, x: number, y: number, planetName: string): void {
  const e = deps?.engine();
  if (!e?.cosmos) return;
  document.getElementById('galaxy-card')?.remove();
  const sec = e.cosmos.sectors[gal.sector];
  const st = e.sectorStateOf(gal.sector);
  const known = st === 'charted' || st === 'glimpsed';
  const morph = gal.morph[0].toUpperCase() + gal.morph.slice(1);
  const line = st === 'charted'
    ? `Charted. About ${gal.systems} star systems turn in it. No one from ${planetName} has reached it yet.`
    : st === 'glimpsed'
      ? `Glimpsed through your sky. Its shape is clear; what lives there is not. Charting this sector takes space-age astronomy.`
      : `A smudge of light at the edge of sight. Only an interstellar people could chart this far.`;
  const card = document.createElement('div');
  card.id = 'galaxy-card';
  card.innerHTML = `<div class="gc-name">${known ? esc(gal.name) : '???'}</div>
    <div class="gc-sub">${known ? `${morph} galaxy · ` : ''}${st === 'unknown' ? 'Uncharted sector' : esc(sec.name)}</div>
    <div class="gc-line">${esc(line)}</div>
    <button class="gc-close">CLOSE</button>`;
  document.body.appendChild(card);
  const r = card.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 14))}px`;
  card.style.top = `${Math.max(8, Math.min(window.innerHeight - r.height - 8, y - r.height / 2))}px`;
  const close = () => { card.remove(); window.removeEventListener('keydown', onKey); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
  card.querySelector('.gc-close')?.addEventListener('click', close);
  window.addEventListener('keydown', onKey);
}

/** The overlay in use (for tests and the renderer on a fresh engine). */
export function currentOverlay(): MapOverlay { return mode; }
