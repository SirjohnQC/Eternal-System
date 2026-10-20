/**
 * Nations overview: double-click the home world to open it (playtest Oct 19).
 *
 * Left, the nations; middle, the chosen nation — its territory as a minimap,
 * its people and the wildlife on its land, what it has; right, its council of
 * state. FULL LEDGER opens the World Ledger (LedgerUI) on that nation for the
 * detail: history, why each number is what it is, the cards at work.
 *
 * Everything is read from runtimeState (rule 1: the view owns nothing but the
 * selected nation). The council is derived for display — roles from the
 * government, standing from cohesion and unrest, names stable until the
 * government changes — the simulation has no individual politicians.
 */
import { runtimeState, gameState } from '../simulation/GameState';
import { GRID_SIZE, BIOME_COLORS, isWater, type PlanetGrid } from '../simulation/PlanetGrid';
import type { Nation, NationSystem } from '../simulation/Nations';
import type { SpeciesGenome } from '../simulation/SpeciesGenome';
import { eraTitle } from '../simulation/Progression';
import { peopleOf } from '../simulation/People';
import { bakeCreaturePortrait } from '../rendering/SpeciesSprite';
import { peopleFormOf } from '../rendering/CreatureForge';
import { openLedger } from './LedgerUI';

let chosen = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let onSurfaceMap: ((at: { row: number; col: number } | null) => void) | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const pct = (v: number) => `${Math.round(Math.max(0, v) * 100)}%`;
const compact = (v: number) => {
  const a = Math.abs(v);
  return a >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0);
};
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
function hash(a: number, b: number, c = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ── The council (derived) ────────────────────────────────────────────────────

interface Seat { title: string; icon: string; weight: number }

/** Three seats per government: who holds power in such a state. */
const SEATS: Record<string, Seat[]> = {
  Theocracy:     [{ title: 'High Priest', icon: '✦', weight: 1 }, { title: 'Keeper of Rites', icon: '☽', weight: 0.7 }, { title: 'Inquisitor', icon: '⚔', weight: 0.6 }],
  Republic:      [{ title: 'Chancellor', icon: '⚖', weight: 1 }, { title: 'Speaker', icon: '❝', weight: 0.75 }, { title: 'Marshal', icon: '⚔', weight: 0.6 }],
  Empire:        [{ title: 'Sovereign', icon: '♛', weight: 1 }, { title: 'Grand Vizier', icon: '⚖', weight: 0.7 }, { title: 'Warlord', icon: '⚔', weight: 0.75 }],
  Confederation: [{ title: 'First Delegate', icon: '⚖', weight: 0.85 }, { title: 'Treasurer', icon: '⛁', weight: 0.7 }, { title: 'Marshal', icon: '⚔', weight: 0.6 }],
  Technocracy:   [{ title: 'Chief Engineer', icon: '⚙', weight: 1 }, { title: 'Archivist', icon: '❖', weight: 0.7 }, { title: 'Director of Works', icon: '⚒', weight: 0.65 }],
  Warband:       [{ title: 'Warchief', icon: '⚔', weight: 1 }, { title: 'Champion', icon: '⛨', weight: 0.75 }, { title: 'Shaman', icon: '✦', weight: 0.6 }],
  Hive:          [{ title: 'Voice of the Hive', icon: '⬢', weight: 1 }, { title: 'Brood Warden', icon: '⬡', weight: 0.7 }, { title: 'Swarm Captain', icon: '⚔', weight: 0.65 }],
  Council:       [{ title: 'Elder of the Council', icon: '⚖', weight: 0.85 }, { title: 'Lawgiver', icon: '❝', weight: 0.75 }, { title: 'Warden', icon: '⛨', weight: 0.6 }],
};

const ONSETS = ['Ar', 'Bel', 'Cor', 'Dra', 'El', 'Fen', 'Gal', 'Hal', 'Is', 'Ka', 'Lor', 'Mae', 'Nyr', 'Or', 'Pel', 'Quo', 'Ra', 'Sel', 'Tor', 'Ul', 'Vae', 'Wyn', 'Xa', 'Yl', 'Zor'];
const CODAS = ['an', 'eth', 'ira', 'on', 'us', 'ael', 'ix', 'ora', 'en', 'is', 'ul', 'ane', 'ar', 'yr', 'eus'];

function personName(seed: number): string {
  const p = (k: number) => Math.floor(hash(seed, k) * 1e6);
  const first = ONSETS[p(1) % ONSETS.length] + CODAS[p(2) % CODAS.length];
  const last = ONSETS[p(3) % ONSETS.length] + CODAS[p(4) % CODAS.length].toLowerCase() + (p(5) % 3 === 0 ? 'son' : '');
  return `${first} ${last}`;
}

const level = (v: number) => (v > 0.8 ? 'Very High' : v > 0.6 ? 'High' : v > 0.4 ? 'Medium' : v > 0.2 ? 'Low' : 'Very Low');
const levelClass = (v: number) => (v > 0.6 ? 'good' : v > 0.35 ? 'mid' : 'bad');

interface Member { name: string; seat: Seat; influence: number; loyalty: number; mood: string }

/** The nation's council: stable until its government changes (a revolt brings new faces). */
function councilOf(n: Nation): Member[] {
  const seats = SEATS[n.government] ?? SEATS.Council;
  const revolts = n.history.filter(h => /rose against|revolt/i.test(JSON.stringify(h))).length;
  const base = hashStr(`${n.name}|${n.government}|${revolts}`);
  const unrest = n.pressures.unrest;
  return seats.map((seat, i) => {
    const seed = base + i * 7919;
    const influence = clamp01(seat.weight * (0.55 + 0.4 * hash(seed, 11)) + (i === 0 ? 0.1 : 0));
    const loyalty = clamp01(n.state.cohesion * 0.8 + 0.25 - unrest * 0.5 + (hash(seed, 12) - 0.5) * 0.3);
    const mood = loyalty > 0.7 ? 'Steadfast' : loyalty > 0.45 ? 'Stable' : loyalty > 0.25 ? 'Wavering' : 'Plotting';
    return { name: personName(seed), seat, influence, loyalty, mood };
  });
}

// ── Territory, people, resources ─────────────────────────────────────────────

/** The nation's cells, and the column offset that keeps it in one piece across the seam. */
function territory(ns: NationSystem, id: number): { cells: number[]; c0: number; c1: number; r0: number; r1: number; shift: number } | null {
  const cells: number[] = [];
  const cols = new Uint8Array(GRID_SIZE);
  let r0 = GRID_SIZE, r1 = -1;
  for (let i = 0; i < ns.owner.length; i++) {
    if (ns.owner[i] !== id) continue;
    cells.push(i);
    const r = (i / GRID_SIZE) | 0;
    cols[i % GRID_SIZE] = 1;
    r0 = Math.min(r0, r); r1 = Math.max(r1, r);
  }
  if (!cells.length) return null;
  // Start just after the widest run of empty columns, so a nation straddling
  // the date line is drawn whole.
  let best = 0, bestStart = 0, run = 0;
  for (let k = 0; k < GRID_SIZE * 2; k++) {
    if (!cols[k % GRID_SIZE]) { run++; if (run > best) { best = run; bestStart = (k + 1) % GRID_SIZE; } } else run = 0;
  }
  const shift = bestStart;
  let c0 = GRID_SIZE, c1 = -1;
  for (const i of cells) { const c = ((i % GRID_SIZE) - shift + GRID_SIZE) % GRID_SIZE; c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
  return { cells, c0, c1, r0, r1, shift };
}

function drawTerritory(cv: HTMLCanvasElement, grid: PlanetGrid, ns: NationSystem, n: Nation): void {
  const t = territory(ns, n.id);
  const g = cv.getContext('2d');
  if (!g) return;
  g.fillStyle = '#0b0816';
  g.fillRect(0, 0, cv.width, cv.height);
  if (!t) return;
  // Frame the territory with a margin, keeping the map's aspect.
  const pad = 6;
  let c0 = t.c0 - pad, c1 = t.c1 + pad, r0 = Math.max(0, t.r0 - pad), r1 = Math.min(GRID_SIZE - 1, t.r1 + pad);
  const aspect = cv.width / cv.height;
  const w = c1 - c0 + 1, h = r1 - r0 + 1;
  if (w / h < aspect) { const extra = Math.round(h * aspect - w); c0 -= extra >> 1; c1 += extra - (extra >> 1); }
  else { const extra = Math.round(w / aspect - h); r0 = Math.max(0, r0 - (extra >> 1)); r1 = Math.min(GRID_SIZE - 1, r1 + extra - (extra >> 1)); }
  const W = c1 - c0 + 1, H = r1 - r0 + 1;
  const img = g.createImageData(cv.width, cv.height);
  const nc = hexRgb(n.color);
  for (let y = 0; y < cv.height; y++) {
    const r = Math.min(GRID_SIZE - 1, r0 + Math.floor(y * H / cv.height));
    for (let x = 0; x < cv.width; x++) {
      const cc = c0 + Math.floor(x * W / cv.width);
      const c = ((cc + t.shift) % GRID_SIZE + GRID_SIZE) % GRID_SIZE;
      const cell = grid[r]?.[c];
      const o = (y * cv.width + x) * 4;
      if (!cell) continue;
      let [R, G, B] = BIOME_COLORS[cell.biome] ?? [60, 60, 60];
      const own = ns.owner[r * GRID_SIZE + c];
      if (own === n.id) {
        // Its land: full colour, a little of its banner in it.
        R = R * 0.8 + nc[0] * 0.2; G = G * 0.8 + nc[1] * 0.2; B = B * 0.8 + nc[2] * 0.2;
        // A border where it ends.
        const edge = [[0, 1], [1, 0], [0, -1], [-1, 0]].some(([dr, dc]) => {
          const rr = r + dr, cc2 = ((c + dc) % GRID_SIZE + GRID_SIZE) % GRID_SIZE;
          return rr >= 0 && rr < GRID_SIZE && ns.owner[rr * GRID_SIZE + cc2] !== n.id;
        });
        if (edge) { R = nc[0]; G = nc[1]; B = nc[2]; }
      } else {
        const dim = isWater(cell.biome) ? 0.55 : own >= 0 ? 0.5 : 0.42;
        R *= dim; G *= dim; B *= dim;
      }
      img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // The capital.
  const cc = ((n.capital.col - t.shift) % GRID_SIZE + GRID_SIZE) % GRID_SIZE;
  const x = (cc - c0 + 0.5) * cv.width / W, y = (n.capital.row - r0 + 0.5) * cv.height / H;
  g.fillStyle = '#ffe9a8'; g.strokeStyle = '#2a1a08'; g.lineWidth = 2;
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? 3 : 7;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath(); g.stroke(); g.fill();
  g.font = '11px monospace'; g.fillStyle = '#f3e6c4'; g.strokeStyle = 'rgba(0,0,0,.8)'; g.lineWidth = 3;
  g.strokeText('Capital', x + 9, y + 4); g.fillText('Capital', x + 9, y + 4);
}

function hexRgb(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255]; }
  const r = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  return r ? [+r[1], +r[2], +r[3]] : [200, 169, 110];
}

/** Who lives on the nation's land: its people, then the wildlife holding the most of it. */
function inhabitants(grid: PlanetGrid, ns: NationSystem, n: Nation, people: SpeciesGenome | null): Array<{ g: SpeciesGenome; share: number; people: boolean }> {
  const count = new Map<string, number>();
  let land = 0;
  for (let i = 0; i < ns.owner.length; i++) {
    if (ns.owner[i] !== n.id) continue;
    const cell = grid[(i / GRID_SIZE) | 0]?.[i % GRID_SIZE];
    if (!cell?.dominantSpeciesId) continue;
    land++;
    count.set(cell.dominantSpeciesId, (count.get(cell.dominantSpeciesId) ?? 0) + 1);
  }
  const byId = new Map(gameState.playerSpecies.filter(s => !s.isExtinct).map(s => [s.id, s]));
  const out: Array<{ g: SpeciesGenome; share: number; people: boolean }> = [];
  if (people) out.push({ g: people, share: 1, people: true });
  const wild = [...count.entries()].filter(([id]) => id !== people?.id && byId.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [id, k] of wild) out.push({ g: byId.get(id)!, share: land ? k / land : 0, people: false });
  return out;
}

/** Portraits come from a shared cache: draw a copy rather than move the cached canvas. */
function copyOf(src: HTMLCanvasElement): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = src.width; cv.height = src.height;
  cv.getContext('2d')?.drawImage(src, 0, 0);
  return cv;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render(force = false): void {
  const box = document.getElementById('nations-ov');
  if (!box || !box.classList.contains('open')) return;
  const ns = runtimeState.playerNations, grid = runtimeState.playerPlanetGrid;
  const body = box.querySelector<HTMLElement>('.nv-body')!;
  if (!ns?.isFounded || !grid) {
    body.innerHTML = '<div class="nv-empty">Your people have not yet founded nations. Their council meets when they do.</div>';
    return;
  }
  const live = ns.nations.filter(n => !n.fallen);
  if (!live.some(n => n.id === chosen)) chosen = live[0]?.id ?? 0;
  const n = ns.nations.find(x => x.id === chosen)!;
  const people = peopleOf(gameState.playerSpecies, 3);
  const sig = `${chosen}|${live.map(x => x.id).join(',')}|${n.government}|${Math.round(n.state.cohesion * 20)}|${Math.round(n.pressures.unrest * 20)}`;
  if (!force && body.dataset['sig'] === sig) return;
  body.dataset['sig'] = sig;
  const s = n.state;
  const fed = s.foodYield / Math.max(1e-6, s.foodNeed);
  const res: Array<[string, string, number, string]> = [
    ['Food', `${pct(fed)} fed`, clamp01(fed), fed >= 1 ? 'good' : fed > 0.8 ? 'mid' : 'bad'],
    ['Materials', compact(s.materials), clamp01(s.materials / Math.max(1, s.population * 0.6)), 'mid'],
    ['Land', `${s.land} cells`, clamp01(s.land / 600), 'mid'],
    ['Knowledge', `${n.techs.length} techs`, clamp01(n.techs.length / 40), 'good'],
    ['Pollution', pct(s.pollution), clamp01(s.pollution), s.pollution > 0.5 ? 'bad' : s.pollution > 0.25 ? 'mid' : 'good'],
    ['Trade in', compact(Math.max(0, s.tradeFood) + Math.max(0, s.tradeMaterials)), clamp01((Math.max(0, s.tradeFood) + Math.max(0, s.tradeMaterials)) / Math.max(1, s.population * 0.2)), 'mid'],
  ];
  const council = councilOf(n);
  const who = inhabitants(grid, ns, n, people);
  body.innerHTML = `
    <div class="nv-col nv-list"><div class="nv-h">Nations</div>
      ${live.map(x => `<button class="nv-nation${x.id === chosen ? ' on' : ''}" data-id="${x.id}" type="button">
        <span class="nv-flag" style="background:${x.color}"></span>${esc(x.name)}</button>`).join('')}
    </div>
    <div class="nv-col nv-main">
      <div class="nv-title"><span class="nv-flag big" style="background:${n.color}"></span>
        <div><div class="nv-name">${esc(n.name)}</div>
        <div class="nv-sub">${esc(n.government)} · ${esc(n.ideology)} · ${esc(eraTitle(n.era))}</div></div></div>
      <div class="nv-panel"><div class="nv-h">Territory <button class="nv-link" data-act="map" type="button">SURFACE MAP</button></div>
        <canvas class="nv-map" width="300" height="130"></canvas></div>
      <div class="nv-panel"><div class="nv-h">Species</div><div class="nv-species">
        ${who.map((w, i) => `<div class="nv-sp"><div class="nv-sp-art" data-i="${i}"></div>
          <div class="nv-sp-name">${esc(w.g.name)}</div>
          <div class="nv-sp-kind">${w.people ? `the people · ${esc(peopleFormOf(w.g))} · ${compact(s.population)}` : `wildlife · ${pct(w.share)} of its land`}</div>
          <div class="nv-bar"><span style="width:${Math.round((w.people ? 1 : w.share) * 100)}%"></span></div></div>`).join('')}
      </div></div>
      <div class="nv-panel"><div class="nv-h">Resources</div><div class="nv-res">
        ${res.map(([k, v, f, c]) => `<div class="nv-r"><div class="nv-r-k">${k}</div><div class="nv-r-v ${c}">${v}</div>
          <div class="nv-bar ${c}"><span style="width:${Math.round(f * 100)}%"></span></div></div>`).join('')}
      </div></div>
    </div>
    <div class="nv-col nv-council"><div class="nv-h">Council of State</div>
      ${council.map((m, i) => `<div class="nv-m">
        <div class="nv-m-art" data-m="${i}"></div>
        <div class="nv-m-txt"><div class="nv-m-name">${esc(m.name)}</div>
          <div class="nv-m-line">${people ? esc(people.name) : ''}</div>
          <div class="nv-m-line">Influence: <b class="${levelClass(m.influence)}">${level(m.influence)}</b></div>
          <div class="nv-m-line">Loyalty: <b class="${levelClass(m.loyalty)}">${m.mood}</b></div>
          <div class="nv-m-role"><span>${m.seat.icon}</span>${esc(m.seat.title)}</div>
          <div class="nv-bar ${levelClass(m.influence)}"><span style="width:${Math.round(m.influence * 100)}%"></span></div>
        </div></div>`).join('')}
    </div>`;
  drawTerritory(body.querySelector<HTMLCanvasElement>('.nv-map')!, grid, ns, n);
  body.querySelectorAll<HTMLElement>('.nv-sp-art').forEach(el => {
    const w = who[Number(el.dataset['i'])];
    try { el.appendChild(copyOf(bakeCreaturePortrait(w.g, 44, w.people))); } catch { /* portrait is decoration */ }
  });
  // The council are of the people; each a little different in hue.
  body.querySelectorAll<HTMLElement>('.nv-m-art').forEach(el => {
    if (!people) return;
    const i = Number(el.dataset['m']);
    try {
      const cv = copyOf(bakeCreaturePortrait(people, 56, true));
      cv.style.filter = `hue-rotate(${(i - 1) * 18}deg) brightness(${1 - i * 0.06})`;
      el.appendChild(cv);
    } catch { /* portrait is decoration */ }
  });
  body.querySelectorAll<HTMLElement>('.nv-nation').forEach(b => b.addEventListener('click', () => { chosen = Number(b.dataset['id']); render(true); }));
  body.querySelector<HTMLElement>('[data-act="map"]')?.addEventListener('click', () => {
    closeNationsOverview();
    onSurfaceMap?.({ row: n.capital.row, col: n.capital.col });
  });
}

/**
 * Open the overview, on `nationId` if given. `surfaceMap` opens the full
 * surface map (double-click used to; it stays one button away).
 */
/** The overview carries its own styles, so it looks the same in the game and
 *  on dev pages that do not load index.html's stylesheet. */
const NV_CSS = `/* ── Nations overview (double-click the world) ── */
#nations-ov{position:fixed;inset:0;z-index:304;display:none;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at center,rgba(14,7,30,0.72),rgba(0,0,0,0.85))}
#nations-ov.open{display:flex}
#nations-ov .nv-frame{width:min(1020px,calc(100vw - 32px));max-height:calc(100vh - 48px);display:flex;flex-direction:column;
  background:#120d1f;border:2px solid #6b5537;outline:1px solid #2a1f14;box-shadow:0 0 0 4px #1a1209,0 12px 40px rgba(0,0,0,.7)}
#nations-ov .nv-top{text-align:center;padding:10px;font-family:var(--font-display,Georgia,serif);letter-spacing:4px;color:var(--gold,#c8a96e);
  font-size:17px;border-bottom:1px solid rgba(200,169,110,.3);background:linear-gradient(#1c1430,#140e22)}
#nations-ov .nv-body{display:grid;grid-template-columns:200px 1fr 260px;gap:10px;padding:10px;overflow:auto;min-height:0}
#nations-ov .nv-col{display:flex;flex-direction:column;gap:8px;min-width:0}
#nations-ov .nv-h{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#e8dcc4;
  padding:4px 8px;background:#1b1530;border:1px solid rgba(200,169,110,.25)}
#nations-ov .nv-list{background:#0d0919;border:1px solid rgba(200,169,110,.2);padding:6px}
#nations-ov .nv-nation{display:flex;align-items:center;gap:8px;text-align:left;padding:7px 8px;font:inherit;font-size:12px;
  color:#cdbfa6;background:#171126;border:1px solid rgba(200,169,110,.18);cursor:pointer}
#nations-ov .nv-nation.on{color:#f3e6c4;border-color:#7bd88f;background:#1d2a22;box-shadow:inset 0 0 0 1px rgba(123,216,143,.4)}
#nations-ov .nv-nation:focus-visible,#nations-ov .nv-btn:focus-visible,#nations-ov .nv-link:focus-visible{outline:2px solid var(--gold,#c8a96e);outline-offset:1px}
#nations-ov .nv-flag{display:inline-block;width:14px;height:10px;border:1px solid rgba(0,0,0,.6);flex:0 0 auto}
#nations-ov .nv-flag.big{width:30px;height:22px}
#nations-ov .nv-title{display:flex;gap:10px;align-items:center;padding:6px 8px;background:#1b1530;border:1px solid rgba(200,169,110,.25)}
#nations-ov .nv-name{font-family:var(--font-display,Georgia,serif);font-size:16px;color:#f3e6c4;letter-spacing:1px}
#nations-ov .nv-sub{font-size:11px;color:#a99a80}
#nations-ov .nv-panel{background:#0d0919;border:1px solid rgba(200,169,110,.2)}
#nations-ov .nv-map{display:block;width:100%;height:auto;image-rendering:pixelated}
#nations-ov .nv-link{font:inherit;font-size:10px;letter-spacing:1px;color:var(--gold,#c8a96e);background:none;border:1px solid rgba(200,169,110,.4);padding:2px 6px;cursor:pointer}
#nations-ov .nv-species{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:8px}
#nations-ov .nv-sp{text-align:center;font-size:11px;color:#cdbfa6}
#nations-ov .nv-sp-art{height:50px;display:flex;align-items:flex-end;justify-content:center}
#nations-ov .nv-sp-art canvas,#nations-ov .nv-m-art canvas{image-rendering:pixelated;max-height:100%;max-width:100%}
#nations-ov .nv-sp-name{color:#f3e6c4;margin-top:2px}
#nations-ov .nv-sp-kind{font-size:10px;color:#a99a80;min-height:26px}
#nations-ov .nv-res{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 12px;padding:8px}
#nations-ov .nv-r-k{font-size:11px;color:#a99a80}
#nations-ov .nv-r-v{font-size:13px;color:#e8dcc4}
#nations-ov .nv-bar{height:4px;background:#2a2238;margin-top:3px}
#nations-ov .nv-bar span{display:block;height:100%;background:#c8a96e}
#nations-ov .nv-bar.good span,#nations-ov .nv-sp .nv-bar span{background:#5dcc8a}
#nations-ov .nv-bar.mid span{background:#e0b84f}
#nations-ov .nv-bar.bad span{background:#ff7a5c}
#nations-ov b.good{color:#5dcc8a;font-weight:normal} #nations-ov b.mid{color:#e0b84f;font-weight:normal} #nations-ov b.bad{color:#ff7a5c;font-weight:normal}
#nations-ov .nv-r-v.good{color:#7fe0a4} #nations-ov .nv-r-v.bad{color:#ff9a80}
#nations-ov .nv-m{display:flex;gap:8px;padding:8px;background:#0d0919;border:1px solid rgba(200,169,110,.2)}
#nations-ov .nv-m-art{width:64px;height:72px;flex:0 0 64px;display:flex;align-items:flex-end;justify-content:center;
  background:linear-gradient(#2a3b2e,#141d17);border:2px solid #6b5537}
#nations-ov .nv-m-txt{min-width:0;font-size:11px;color:#cdbfa6;flex:1}
#nations-ov .nv-m-name{font-size:12px;color:#f3e6c4}
#nations-ov .nv-m-role{margin-top:3px;color:#f3e6c4;font-size:12px}
#nations-ov .nv-m-role span{color:var(--gold,#c8a96e);margin-right:5px}
#nations-ov .nv-foot{display:flex;justify-content:space-between;padding:8px 10px;border-top:1px solid rgba(200,169,110,.25)}
#nations-ov .nv-btn{font:inherit;font-size:12px;letter-spacing:2px;color:#e8dcc4;background:#1b1530;border:1px solid rgba(200,169,110,.4);padding:7px 26px;cursor:pointer}
#nations-ov .nv-btn:hover,#nations-ov .nv-nation:hover{border-color:var(--gold,#c8a96e)}
#nations-ov .nv-empty{grid-column:1/-1;padding:40px;text-align:center;color:#a99a80}
@media (max-width:760px){#nations-ov .nv-body{grid-template-columns:1fr}}`;
function ensureStyles(): void {
  if (document.getElementById('nations-ov-css')) return;
  const st = document.createElement('style');
  st.id = 'nations-ov-css';
  st.textContent = NV_CSS;
  document.head.appendChild(st);
}

export function openNationsOverview(nationId?: number | null, surfaceMap?: (at: { row: number; col: number } | null) => void): void {
  if (surfaceMap) onSurfaceMap = surfaceMap;
  ensureStyles();
  let box = document.getElementById('nations-ov');
  if (!box) {
    box = document.createElement('div');
    box.id = 'nations-ov';
    box.innerHTML = `<div class="nv-frame">
      <div class="nv-top">NATIONS &amp; COUNCILS</div>
      <div class="nv-body"></div>
      <div class="nv-foot"><button class="nv-btn" data-act="close" type="button">CLOSE</button>
        <button class="nv-btn" data-act="ledger" type="button">FULL LEDGER</button></div></div>`;
    document.body.appendChild(box);
    box.addEventListener('click', e => { if (e.target === box) closeNationsOverview(); });
    box.querySelector('[data-act="close"]')!.addEventListener('click', closeNationsOverview);
    box.querySelector('[data-act="ledger"]')!.addEventListener('click', () => {
      const ns = runtimeState.playerNations;
      const k = ns ? ns.nations.findIndex(x => x.id === chosen) : -1;
      closeNationsOverview();
      openLedger(k >= 0 ? k : undefined);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('nations-ov')?.classList.contains('open')) closeNationsOverview(); });
  }
  if (nationId != null) chosen = nationId;
  box.classList.add('open');
  render(true);
  if (!timer) timer = setInterval(() => render(), 1000);
}

export function closeNationsOverview(): void {
  document.getElementById('nations-ov')?.classList.remove('open');
  if (timer) { clearInterval(timer); timer = null; }
}
