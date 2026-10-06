/**
 * Checks towns per country (src/rendering/Architecture.ts nationArch,
 * src/rendering/SettlementPlan.ts per-town era and architecture): each
 * nation's culture bends how its species builds, and each town stands in its
 * own nation's era.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/townsCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/towns.mjs --log-level=error && node /tmp/towns.mjs
 */
import { archGenome, nationArch, type NationCulture } from '../src/rendering/Architecture';
import { planSettlements, type Era, type Site } from '../src/rendering/SettlementPlan';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failed++;
};

const base = archGenome({ bodyStructure: 'vertebrate', environment: 'land', locomotion: 'walking', metabolism: 'heterotrophic', social: 5, size: 'medium', planetType: 'rocky', seed: 7 });
const culture = (id: number, color: string, v: Partial<NationCulture['values']> = {}): NationCulture => ({
  id, color, government: 'Republic',
  values: { militarism: 0.5, piety: 0.5, curiosity: 0.5, collectivism: 0.5, xenophobia: 0.4, ...v },
});

console.log('Towns: architecture per nation');
{
  const red = nationArch(base, culture(0, '#b8322a'));
  const blue = nationArch(base, culture(1, '#2f6fb3'));
  const hueDist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  check('a nation roofs its towns in its flag colour', hueDist(red.accent[0], 5) < 15 && hueDist(blue.accent[0], 211) < 15,
    `red ${red.accent[0].toFixed(0)}°, blue ${blue.accent[0].toFixed(0)}°`);
  check('the species\' shape and stilts carry across the border', red.shape === base.shape && blue.stilts === base.stilts, base.shape);
  check('neighbours\' stone differs', !!red.wall && !!blue.wall && (Math.abs(red.wall[0] - blue.wall[0]) > 2 || Math.abs(red.wall[2] - blue.wall[2]) > 0.02));
  check('an insular people builds walled ring towns', nationArch(base, culture(2, '#2e8b4e', { xenophobia: 0.85 })).layout === 'ring');
  check('a communal people packs close', nationArch(base, culture(3, '#2e8b4e', { collectivism: 0.85, xenophobia: 0.2 })).layout === 'cluster');
  check('an independent people scatters', nationArch(base, culture(4, '#2e8b4e', { collectivism: 0.1, xenophobia: 0.2 })).layout === 'scatter');
  check('the curious build tall', nationArch(base, culture(5, '#2e8b4e', { curiosity: 0.9 })).tall > red.tall);
  check('the pious raise great temples', nationArch(base, culture(6, '#2e8b4e', { piety: 0.9 })).quirks.includes('colossal'));
  check('it says how it builds', red.summary.startsWith('red-roofed'), red.summary);
  check('deterministic', JSON.stringify(nationArch(base, culture(0, '#b8322a'))) === JSON.stringify(red));
  check('a pale flag still gets a roof colour', nationArch(base, culture(7, '#e9e4d4')).accent[1] >= 0.12);
}

console.log('Towns: each town in its own nation\'s era');
{
  const land = () => true, fertile = () => 0.8;
  const sites: Site[] = [
    { x: 100, y: 100, nation: 0, era: 2 as Era, arch: nationArch(base, culture(0, '#b8322a', { militarism: 0.9 })), aggression: 9, capital: true },
    { x: 220, y: 110, nation: 1, era: 4 as Era, arch: nationArch(base, culture(1, '#2f6fb3')), aggression: 2, capital: true },
    { x: 140, y: 160, nation: 0, era: 2 as Era, arch: nationArch(base, culture(0, '#b8322a', { militarism: 0.9 })), aggression: 9 },
  ];
  const plan = planSettlements({ sites, civLevel: 4, seed: 11, rx: 262, isLand: land, fertileAt: fertile, aquatic: false, aggression: 3, arch: base });
  check('towns carry their nation and era', plan.towns.map(t => `${t.nation}:${t.era}`).join(' ') === '0:2 1:4 0:2', plan.towns.map(t => `${t.nation}:${t.era}`).join(' '));
  check('the plan\'s era is the most advanced town\'s', plan.era === 4, String(plan.era));
  check('both nations get a capital landmark', plan.towns.filter(t => t.capital).length === 2);
  const kinds = (ti: number) => new Set(plan.buildings.filter(b => b.town === ti).map(b => b.kind));
  const k0 = kinds(0), k1 = kinds(1);
  check('a medieval, martial capital has a keep', k0.has('keep'), [...k0].join(','));
  check('an atomic-age town has blocks and towers', k1.has('block') || k1.has('tower'), [...k1].join(','));
  check('no medieval town has atomic-age buildings', !kinds(2).has('block') && !kinds(2).has('tower'), [...kinds(2)].join(','));
  const again = planSettlements({ sites, civLevel: 4, seed: 11, rx: 262, isLand: land, fertileAt: fertile, aquatic: false, aggression: 3, arch: base });
  check('deterministic', JSON.stringify(again.buildings) === JSON.stringify(plan.buildings));
  // Without nations: the old behaviour (one era from the civ level).
  const old = planSettlements({ sites: [{ x: 100, y: 100 }, { x: 200, y: 120 }], civLevel: 3, seed: 11, rx: 262, isLand: land, fertileAt: fertile, aquatic: false, aggression: 3, arch: base });
  check('without nations every town stands in the civilisation\'s era', old.towns.every(t => t.era === 3 && t.nation === -1));
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall town checks passed');
process.exit(failed ? 1 : 0);
