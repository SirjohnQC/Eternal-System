/**
 * SettlementPlan (src/rendering/SettlementPlan.ts) and SettlementForge:
 * deterministic towns, stable when the territory grows, fields on farmland,
 * roads on land, ground marks and clear zones, a sprite for every kind.
 *
 * Grounded sites: nothing on water, a river or a cliff; a building on a
 * terrace step stands on a levelled pad with a foundation.
 *
 * Build + run (also `npm run test:settlements`, part of `npm test`):
 *   node_modules/.bin/esbuild tools/settlementCheck.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/stc.mjs" --log-level=error && node "$TEMP/stc.mjs"
 */
import { planSettlements, groundAt, keepClear, fieldUV, plotGround, SQUASH, MAX_PLOT_STEP, type PlanInput, type Field } from '../src/rendering/SettlementPlan';

/** A diamond field's corners and centre (face coordinates). */
const corners = (f: Field): Array<[number, number]> => {
  const pt = (u: number, v: number): [number, number] => [f.cx + (u - v) / Math.SQRT2, f.cy + (u + v) / Math.SQRT2 * SQUASH];
  return [pt(f.hu, 0), pt(-f.hu, 0), pt(0, f.hv), pt(0, -f.hv), [f.cx, f.cy]];
};
import { paintBuilding, townStyle } from '../src/rendering/SettlementForge';

let fails = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(56)} ${detail}`);
};

// A continent: an ellipse of land with a lake, a mountain band that cannot be farmed.
const isLand = (x: number, y: number) => {
  const e = Math.hypot((x - 200) / 150, (y - 120) / 70);
  const lake = Math.hypot((x - 200) / 18, (y - 120) / 9) < 1;
  return e < 1 && !lake;
};
const mountain = (x: number) => x > 300 && x < 330;
const fertileAt = (x: number, y: number) => (isLand(x, y) && !mountain(x) ? 0.7 : 0);
const sites = [{ x: 150, y: 110 }, { x: 260, y: 130 }, { x: 200, y: 160 }, { x: 120, y: 150 }];
const input = (era: number, s = sites): PlanInput => ({
  sites: s, civLevel: era, seed: 1234, rx: 93, isLand, fertileAt, aquatic: false, aggression: 3,
});

for (const era of [0, 2, 4, 6]) {
  const a = planSettlements(input(era)), b = planSettlements(input(era));
  check(`era ${era}: deterministic`, JSON.stringify(a.buildings) === JSON.stringify(b.buildings) && JSON.stringify(a.fields) === JSON.stringify(b.fields));
  check(`era ${era}: every town has buildings`, a.towns.every((_, i) => a.buildings.some(bb => bb.town === i)),
    `${a.buildings.length} buildings in ${a.towns.length} towns`);
  check(`era ${era}: buildings stand on land`, a.buildings.every(bb => isLand(bb.x, bb.y)));
  check(`era ${era}: fields only on farmland`, a.fields.every(f => corners(f).every(([x, y]) => fertileAt(x, y) > 0)),
    `${a.fields.length} fields`);
  if (era >= 1) {
    check(`era ${era}: has fields and roads`, a.fields.length > 4 && a.roads.some(r => !r.street), `${a.roads.filter(r => !r.street).length} road segments`);
    let wet = 0, n = 0;
    for (const r of a.roads) for (let t = 0; t <= 1; t += 0.05) { n++; if (!isLand(r.ax + (r.bx - r.ax) * t, r.ay + (r.by - r.ay) * t)) wet++; }
    check(`era ${era}: roads keep to land (around the lake)`, wet / n < 0.02, `${wet}/${n} samples on water`);
    // Roads between towns run on the isometric diagonals (#97): on the
    // unsquashed ground each leg's |dx| equals |dy|.
    let iso = 0, all = 0;
    for (const r of a.roads.filter(r => !r.street)) {
      const dX = r.bx - r.ax, dY = (r.by - r.ay) / SQUASH, len = Math.hypot(dX, dY);
      all += len;
      if (Math.abs(Math.abs(dX) - Math.abs(dY)) < 0.05 * len + 0.01) iso += len;
    }
    check(`era ${era}: roads run on the iso diagonals`, all > 0 && iso / all > 0.8, `${Math.round(100 * iso / Math.max(1e-9, all))}% of road length`);
  }
}

// Growth: a new town must not re-roll the others.
{
  const a = planSettlements(input(2)), b = planSettlements(input(2, [...sites, { x: 90, y: 115 }]));
  const town0 = (p: typeof a) => JSON.stringify(p.buildings.filter(x => x.town === 0));
  check('a new town leaves existing towns as they were', town0(a) === town0(b));
}

// Ground marks and clear zones.
{
  const p = planSettlements(input(4));
  const road = p.roads.find(r => !r.street)!;
  const mx = (road.ax + road.bx) / 2, my = (road.ay + road.by) / 2;
  check('a road paints the ground', groundAt(p, mx, my, 1, 90, 140, 70) >= 0);
  check('a road over a river is a bridge', groundAt(p, mx, my, 1, 90, 140, 70, true) >= 0);
  const f = p.fields[0];
  check('a field paints the ground', groundAt(p, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2, 1, 90, 140, 70) >= 0);
  // A diamond (#96): inside its corners paints, the bounding box's corner does not.
  const [u0, v0] = fieldUV(f, f.x0 + 0.01, f.y0 + 0.01);
  check('fields are diamonds on the iso axes', Math.abs(u0) > f.hu || Math.abs(v0) > f.hv);
  check('a field never covers a river', groundAt(p, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2, 1, 90, 140, 70, true) < 0 || p.roads.some(r => Math.hypot(r.ax - (f.x0 + f.x1) / 2, r.ay - (f.y0 + f.y1) / 2) < 3));
  check('open country is left alone', groundAt(p, 380, 120, 1, 90, 140, 70) === -1 && !keepClear(p, 30, 120));
  check('trees keep off towns, fields and roads', keepClear(p, p.towns[0].x, p.towns[0].y) && keepClear(p, mx, my) && keepClear(p, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2));
  const k1 = groundAt(p, mx, my, 1, 90, 140, 70), k4 = groundAt(p, mx, my, 4, 90, 140, 70);
  check('ground marks resolve at any zoom', k1 >= 0 && k4 >= 0);
  void SQUASH;
}

// Every building kind paints, at every scale.
{
  let bad = 0;
  const kinds = ['hut', 'house', 'gable', 'adobe', 'row', 'block', 'tower', 'dome', 'spire', 'ziggurat', 'keep', 'church', 'mill'] as const;
  for (const kind of kinds) for (const S of [1, 2, 4, 8]) for (const era of [0, 2, 3, 5, 6] as const) {
    const f = paintBuilding({ x: 0, y: 0, w: 3.6, d: 3.2, h: 3, kind, seed: 7, town: 0 }, S, townStyle(era));
    let px = 0;
    for (let i = 3; i < f.data.length; i += 4) if (f.data[i]) px++;
    const footOk = f.data[(f.footY * f.width + f.footX) * 4 + 3] > 0;
    if (px < 2 || !footOk) bad++;
  }
  check('every kind paints and stands on its foot', bad === 0, `${bad} bad of ${kinds.length * 4 * 5}`);
}

// Grounded sites: hilly land with terraces, a cliff and a river.
// Terraces rise eastward 3 px a step every 14 px; past x = 236 a 12 px cliff;
// a river runs north-south at x = 205.
const liftAt = (x: number, y: number) => 3 * Math.floor(Math.max(0, x - 100) / 14) + (x > 236 ? 12 : 0) + (y < 100 ? 3 : 0);
const waterAt = (x: number) => Math.abs(x - 205) < 1.2;
const hilly = (era: number): PlanInput => ({ ...input(era), liftAt, waterAt });
for (const era of [1, 3, 5]) {
  const p = planSettlements(hilly(era));
  check(`hilly era ${era}: towns still build`, p.buildings.length > 10, `${p.buildings.length} buildings`);
  const bad = p.buildings.filter(b => !plotGround({ isLand, liftAt, waterAt }, b.x, b.y, b.w, b.d));
  check(`hilly era ${era}: nothing on water, a river or a cliff`, bad.length === 0, `${bad.length} bad`);
  check(`hilly era ${era}: every building knows its ground`, p.buildings.every(b => b.lift !== undefined && (b.pad ?? -1) >= 0 && (b.pad ?? 9) <= MAX_PLOT_STEP));
  const padded = p.buildings.filter(b => (b.pad ?? 0) > 0);
  check(`hilly era ${era}: a building on a step is levelled (pad painted)`, padded.length === 0 || padded.every(b => groundAt(p, b.x, b.y + 0.2, 1, 90, 140, 70) >= 0),
    `${padded.length} padded`);
  check(`hilly era ${era}: deterministic`, JSON.stringify(p) === JSON.stringify(planSettlements(hilly(era))));
}
// Roads that make sense (hilly fixture): every town joined, roads off the
// water except short bridges, climbs bounded except in tunnels, iso legs.
for (const era of [2, 4]) {
  const inp = hilly(era), p = planSettlements(inp), n = p.towns.length;
  const root = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  for (const [a, b] of p.links) root[find(a)] = find(b);
  check(`hilly era ${era}: every town reachable by road`, new Set(root.map((_, i) => find(i))).size === 1, `${p.links.length} links, ${n} towns`);
  let wet = 0, river = 0, samples = 0, worst = 0, run = 0, longest = 0;
  const roads = p.roads.filter(r => !r.street && !r.tunnel);
  for (const r of roads) {
    const len = Math.hypot(r.bx - r.ax, r.by - r.ay), m = Math.max(2, Math.ceil(len * 2));
    let prev = liftAt(r.ax, r.ay);
    for (let i = 0; i <= m; i++) {
      const x = r.ax + (r.bx - r.ax) * i / m, y = r.ay + (r.by - r.ay) * i / m;
      samples++;
      if (!isLand(x, y)) wet++;
      if (waterAt(x)) { river++; run += len / m; longest = Math.max(longest, run); } else run = 0;
      const l = liftAt(x, y);
      worst = Math.max(worst, Math.abs(l - prev));
      prev = l;
    }
  }
  check(`hilly era ${era}: roads keep off the sea and lakes`, wet === 0, `${wet}/${samples} samples`);
  check(`hilly era ${era}: rivers are crossed by short bridges`, river > 0 && longest < 6, `${river} bridge samples, longest ${longest.toFixed(1)} px`);
  check(`hilly era ${era}: no road climbs more than a terrace step at once`, worst <= MAX_PLOT_STEP, `worst step ${worst} px`);
  const tunnels = p.roads.filter(r => r.tunnel).length;
  check(`hilly era ${era}: the cliff is crossed only where it must be (tunnels)`, tunnels >= 1 && tunnels <= p.links.length, `${tunnels} tunnel legs`);
  let iso = 0, all = 0;
  for (const r of p.roads.filter(r => !r.street)) {
    const dX = r.bx - r.ax, dY = (r.by - r.ay) / SQUASH, len = Math.hypot(dX, dY);
    all += len;
    if (Math.abs(Math.abs(dX) - Math.abs(dY)) < 0.05 * len + 0.01) iso += len;
  }
  check(`hilly era ${era}: roads run on the iso diagonals`, iso / Math.max(1e-9, all) > 0.9, `${Math.round(100 * iso / Math.max(1e-9, all))}%`);
  // Streets and lanes: every lane ends on a street of its town; no street over the sea.
  const streets = p.roads.filter(r => r.street);
  let streetWet = 0;
  for (const r of streets) for (let t = 0; t <= 1; t += 0.1) if (!isLand(r.ax + (r.bx - r.ax) * t, r.ay + (r.by - r.ay) * t)) streetWet++;
  check(`hilly era ${era}: streets and lanes stay on land`, streetWet === 0, `${streets.length} street segments`);
  const lanes = streets.filter(r => r.half < 0.4);
  check(`hilly era ${era}: houses have lanes to the streets`, lanes.length >= p.buildings.length * 0.3, `${lanes.length} lane legs for ${p.buildings.length} buildings`);
}
// A road network costs: a straight road over a ridge is replaced by one round it.
{
  const ridge = (x: number, y: number) => (Math.abs(x - 200) < 8 && Math.abs(y - 120) < 30 ? 15 : 0);
  const two = [{ x: 170, y: 120 }, { x: 230, y: 120 }];
  const p = planSettlements({ ...input(3, two), liftAt: ridge });
  let over = 0;
  for (const r of p.roads.filter(r => !r.street)) for (let t = 0; t <= 1; t += 0.05) if (ridge(r.ax + (r.bx - r.ax) * t, r.ay + (r.by - r.ay) * t) > 0 && !r.tunnel) over++;
  check('a road goes round a ridge it could not climb', p.links.length === 1 && over === 0, `${over} samples on the ridge`);
}
{
  // A foundation hangs below a levelled building, the foot unmoved.
  const b = { x: 0, y: 0, w: 3, d: 3, h: 3, kind: 'house' as const, seed: 3, town: 0 };
  const flat = paintBuilding(b, 3, townStyle(2)), raised = paintBuilding({ ...b, pad: 3, lift: 6 }, 3, townStyle(2));
  check('a pad adds a foundation under the foot', raised.height > flat.height && raised.footY === flat.footY
    && raised.data[((raised.footY + 4) * raised.width + raised.footX) * 4 + 3] > 0);
}

console.log(fails ? `\n  ${fails} FAILED` : '\n  all ok');
if (fails) process.exit(1);
