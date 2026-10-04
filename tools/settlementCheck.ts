/**
 * SettlementPlan (src/rendering/SettlementPlan.ts) and SettlementForge:
 * deterministic towns, stable when the territory grows, fields on farmland,
 * roads on land, ground marks and clear zones, a sprite for every kind.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/settlementCheck.ts --bundle --platform=node \
 *     --format=esm --outfile="$TEMP/stc.mjs" --log-level=error && node "$TEMP/stc.mjs"
 */
import { planSettlements, groundAt, keepClear, SQUASH, type PlanInput } from '../src/rendering/SettlementPlan';
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
  check(`era ${era}: fields only on farmland`, a.fields.every(f => [[f.x0, f.y0], [f.x1, f.y1], [(f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2]].every(([x, y]) => fertileAt(x, y) > 0)),
    `${a.fields.length} fields`);
  if (era >= 1) {
    check(`era ${era}: has fields and roads`, a.fields.length > 4 && a.roads.some(r => !r.street), `${a.roads.filter(r => !r.street).length} road segments`);
    let wet = 0, n = 0;
    for (const r of a.roads) for (let t = 0; t <= 1; t += 0.05) { n++; if (!isLand(r.ax + (r.bx - r.ax) * t, r.ay + (r.by - r.ay) * t)) wet++; }
    check(`era ${era}: roads keep to land (around the lake)`, wet / n < 0.02, `${wet}/${n} samples on water`);
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

console.log(fails ? `\n  ${fails} FAILED` : '\n  all ok');
