/**
 * Dev check: settlements prefer visual inland (elev − rimFalloff coastline).
 */
import { generatePlanetGrid, isHabitable, GRID_SIZE, SEA_LEVEL } from '../src/simulation/PlanetGrid';

const grid = generatePlanetGrid('ocean', 7777, null);
for (let r = 0; r < GRID_SIZE; r++) {
  for (let c = 0; c < GRID_SIZE; c++) {
    const cell = grid[r][c];
    if (isHabitable(cell.biome) && cell.fertility > 0.45) cell.civId = '0';
  }
}

function rimFalloff(r: number): number {
  const t = Math.max(0, Math.min(1, (r - 0.34) / 0.66));
  return t * t * 0.30;
}

const CX = 200, CY = 150, RX = 120, RY = 120;
const focusLat = 0, focusLon = 0;
const step = 3;
const MAX_SETTLEMENTS = 13;

function discToGrid(dx: number, dy: number): { row: number; col: number } | null {
  const r = Math.hypot(dx, dy);
  if (r > 1) return null;
  const c = r * (Math.PI / 2);
  const sinC = Math.sin(c), cosC = Math.cos(c);
  const sinF = Math.sin(focusLat), cosF = Math.cos(focusLat);
  const ny = -dy;
  const clampAbs = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  const lat = r < 1e-6
    ? focusLat
    : Math.asin(clampAbs(cosC * sinF + (ny * sinC * cosF) / r, 1));
  const lon = focusLon + Math.atan2(dx * sinC, r * cosF * cosC - ny * sinF * sinC);
  const v = 0.5 - lat / Math.PI;
  const u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;
  return {
    row: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(v * (GRID_SIZE - 1)))),
    col: Math.min(GRID_SIZE - 1, Math.floor(u * GRID_SIZE)),
  };
}

const landKeys = new Set<string>();
const sampleKey = (px: number, py: number) =>
  `${Math.round(px / step)},${Math.round(py / step)}`;

type Spot = { x: number; y: number; sx: number; sy: number; fertility: number; row: number; col: number };

const spots: Spot[] = [];
for (let py = CY - RY; py <= CY + RY; py += step) {
  const dy = (py - CY) / RY;
  for (let px = CX - RX; px <= CX + RX; px += step) {
    const dx = (px - CX) / RX;
    const r = Math.hypot(dx, dy);
    if (r > 0.97) continue;
    const gp = discToGrid(dx, dy);
    if (!gp) continue;
    const cell = grid[gp.row][gp.col];
    const onLand = cell.elevation - rimFalloff(r) >= SEA_LEVEL;
    if (onLand) landKeys.add(sampleKey(px, py));
    if (cell.civId != null && onLand) {
      spots.push({ x: px, y: py, sx: px, sy: py, fertility: cell.fertility, row: gp.row, col: gp.col });
    }
  }
}

function distToVisualCoast(px: number, py: number): number {
  for (let rad = 0; rad < 48; rad++) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const sx = px + Math.cos(ang) * rad * step;
      const sy = py + Math.sin(ang) * rad * step;
      const dx = (sx - CX) / RX;
      const dy = (sy - CY) / RY;
      if (dx * dx + dy * dy > 0.97) return rad;
      if (!landKeys.has(sampleKey(sx, sy))) return rad;
    }
  }
  return 48;
}

let seed = 0x5bf03635;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};
function scatter<T extends { x: number; y: number }>(arr: T[], max: number, minDist: number): T[] {
  const out: T[] = [];
  const d2 = minDist * minDist;
  const order = arr.map((_, k) => k);
  for (let k = order.length - 1; k > 0; k--) {
    const j2 = Math.floor(next() * (k + 1));
    [order[k], order[j2]] = [order[j2], order[k]];
  }
  for (const k of order) {
    if (out.length >= max) break;
    const cand = arr[k];
    let ok = true;
    for (const got of out) {
      const ddx = got.x - cand.x, ddy = got.y - cand.y;
      if (ddx * ddx + ddy * ddy < d2) { ok = false; break; }
    }
    if (ok) out.push(cand);
  }
  return out;
}

// Legacy fertility-only
const legacy = [...spots].sort((a, b) => b.fertility - a.fertility);
const legacyPool = legacy.slice(0, Math.max(60, legacy.length >> 2));
const legacyPicked = scatter(legacyPool, MAX_SETTLEMENTS, RX * 0.13);

// New inland score
const byCell = new Map<string, Spot & { score: number; dCoast: number }>();
for (const spot of spots) {
  const dCoast = distToVisualCoast(spot.sx, spot.sy);
  const inland = Math.min(1, dCoast / 6);
  const score = spot.fertility * (0.2 + 0.8 * inland);
  const key = `${spot.row},${spot.col}`;
  const prev = byCell.get(key);
  if (!prev || score > prev.score) byCell.set(key, { ...spot, score, dCoast });
}
const scored = [...byCell.values()].sort((a, b) => b.score - a.score);
const inlandEnough = scored.filter(s => s.dCoast >= 2);
const ranked = inlandEnough.length >= MAX_SETTLEMENTS ? inlandEnough : scored;
const townPool = ranked.slice(0, Math.max(60, ranked.length >> 2));
seed = 0x5bf03635; // reset for fair shuffle compare? actually different pools — ok
const picked = scatter(townPool, MAX_SETTLEMENTS, RX * 0.13);

const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
const withD = (xs: Spot[]) => xs.map(s => ({ ...s, dCoast: distToVisualCoast(s.sx, s.sy) }));
const legacyD = withD(legacyPicked);

const shareCoast2 = (xs: { dCoast: number }[]) =>
  xs.filter(s => s.dCoast <= 2).length / Math.max(1, xs.length);

const result = {
  spots: spots.length,
  unique: byCell.size,
  legacyAvgD: +avg(legacyD.map(s => s.dCoast)).toFixed(2),
  legacyCoast2: +shareCoast2(legacyD).toFixed(3),
  newAvgD: +avg(picked.map(s => s.dCoast)).toFixed(2),
  newCoast2: +shareCoast2(picked).toFixed(3),
  newMinD: Math.min(...picked.map(s => s.dCoast)),
  picked: picked.length,
};

console.log(JSON.stringify(result, null, 2));

if (result.newCoast2 > 0.05) {
  console.error('FAIL: too many settlements within 2 steps of visual coast');
  process.exit(1);
}
if (result.newAvgD < result.legacyAvgD) {
  console.error('FAIL: inland scoring did not improve average coast distance');
  process.exit(1);
}
if (result.newMinD < 2) {
  console.error('FAIL: at least one settlement still on the coastal shelf');
  process.exit(1);
}
console.log('PASS');
