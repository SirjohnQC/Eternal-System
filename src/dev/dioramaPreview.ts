/**
 * Dev-only harness for IsoDioramaRenderer.
 * Served at /diorama-preview.html — lets the diorama be iterated on without
 * replaying a full game. Not imported by the game bundle.
 */
import { VX_NAMES } from '../rendering/weather/WeatherEvents';
import { IsoDioramaRenderer } from '../rendering/IsoDioramaRenderer';
import { generatePlanetGrid, isHabitable, isWater, GRID_SIZE } from '../simulation/PlanetGrid';
import { DEFAULT_BIOSPHERE } from '../simulation/SpeciesGenome';
import type { SpeciesGenome } from '../simulation/SpeciesGenome';
import { stepEvolution, createFoundingSpecies } from '../simulation/EvolutionEngine';
import { assignDominantSpecies } from '../simulation/SpeciesDistribution';
import { generateBranchSet, emptyInvestment } from '../simulation/DnaBranches';
import { bakeCreaturePortrait, bakeSettlementSprite } from '../rendering/SpeciesSprite';
import { SeedRNG } from '../utils/SeedRNG';
import type { Planet, StarBody } from '../simulation/BigBangEngine';
import type { BiologyPhase } from '../simulation/GameState';
import { installZoomBench } from './zoomBench';
import { NationSystem } from '../simulation/Nations';
import { summariseGenome, valuesFromGenome } from '../simulation/Civilization';
import { rollMoons } from '../simulation/MoonSize';
import { formationFaceType, isDestinyType, type DestinyType } from '../simulation/Formation';

const stage = document.getElementById('stage')!;
const renderer = new IsoDioramaRenderer();
let nations: NationSystem | null = null;
renderer.setNationSource(() => nations);

const params = new URLSearchParams(location.search);
// BigBangEngine's PLANET_ORBIT_MU (0.0012 rad per 60 Hz tick at radius 10), so
// the preview's year matches the game's. ?year=N runs the clock N times faster.
const orbitSpeed = (r: number) => 0.0012 / Math.sqrt(Math.max(0.5, r / 10));
const YEAR = Number(params.get('year') ?? 1);
let type: Planet['type'] = (params.get('type') as Planet['type']) || 'ocean';
// ?formation=magma|cooling|volcanic|atmosphere|ice_age|primordial&destiny=ocean
// shows the home world part-way through formation: its stage face, no life.
const formation = params.get('formation') as StarBody['formationStage'];
const destinyParam = params.get('destiny');
const destiny: DestinyType = isDestinyType(destinyParam) ? destinyParam : 'ocean';
if (formation) type = formationFaceType(formation, destiny);
let seed = Number(params.get('seed')) || 1;

/**
 * The home world's moons, rolled by the engine's own generator (rollMoons).
 * ?moons=N re-rolls until the world has exactly N (1-3; a gas giant 2-6);
 * ?moons=0 gives none. Omitted: the roll for this seed as it falls.
 */
function previewMoons(): Planet['moons'] {
  const want = params.get('moons');
  const parent = { type, radius: type === 'gas' ? 2.4 : 1.1 };
  // The preview planet has radius 6: rescale so size relative to it holds.
  const fit = (ms: Planet['moons']) => ms.map(m => ({ ...m, radius: m.radius * 6 / parent.radius }));
  if (want === null) return fit(rollMoons(parent, 'I', seed * 7919));
  // The generator caps an ordinary world at 3 moons and a gas giant at 6.
  const n = Math.max(0, Math.min(type === 'gas' ? 6 : 3, Number(want) || 0));
  if (n === 0) return [];
  for (let s = 0; s < 4000; s++) {
    const ms = rollMoons(parent, 'I', seed * 7919 + s * 104729);
    if (ms.length === n) return fit(ms);
  }
  return fit(rollMoons(parent, 'I', seed * 7919));
}

function makePlanet(): Planet {
  return {
    orbitalAngle: 0, orbitalRadius: 40, orbitalSpeed: orbitSpeed(40),
    eccentricity: Number(params.get('ecc') ?? 0), periapsisAngle: 0,
    radius: 6, type, hasLife: true, biosphere: 0.8,
    color: '#3a8f3a', discovery: 'landing', name: `Preview-${seed}`,
    genomeSeed: seed,
    moons: previewMoons(),
  };
}

function makeStar(): StarBody {
  return {
    id: 0, x: 0, y: 0, vx: 0, vy: 0, mass: 4, radius: 6,
    temperature: 5800, age: 0, hasLife: true, civLevel: 4,
    civName: 'Preview', planets: [
      makePlanet(),
      { ...makePlanet(), type: 'rocky', name: 'A', orbitalRadius: 18, orbitalAngle: 2.2,
        orbitalSpeed: orbitSpeed(18), radius: 3, eccentricity: 0 },
      { ...makePlanet(), type: 'gas', name: 'B', orbitalRadius: 72, orbitalAngle: 1.2,
        orbitalSpeed: orbitSpeed(72), radius: 11 },
      { ...makePlanet(), type: 'ice', name: 'C', orbitalRadius: 118, orbitalAngle: 4.0,
        orbitalSpeed: orbitSpeed(118), radius: 4 },
    ],
    explorationRadius: 30, isPlayerStar: true, isDead: false,
    asteroidBelt: false, asteroidBeltDensity: 0, lastEventTick: 0,
    formationStage: null, formationTick: 0,
    terraformStage: null, terraformTick: 0, terraformTargetType: null,
    religionName: '', religionDevotion: 0,
    biologyPhase: 'intelligent', bioPhaseProgress: 0,
    dna: {
      intelligence: 0, aggression: 0, adaptation: 0, social: 0,
      mobility: 0, sensory: 0, longevity: 0, size: 0,
    },
  };
}

function rebuild(): void {
  const planet = makePlanet();
  // ?archetype=supercontinent|archipelago|hemispheric — omit to roll from the type
  const rawArchetype = params.get('archetype');
  const archetype = rawArchetype ? (rawArchetype as any) : undefined;
  const grid = generatePlanetGrid(type, seed * 7777, null, archetype);

  // Fake some life + civilisation coverage so lights and vegetation show.
  const wantCiv = !formation && (document.getElementById('civ') as HTMLInputElement).checked;
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const cell = grid[r][c];
      // Water gets life too. `isHabitable` is `!isWater && !mountain &&
      // !volcanic`, so gating on it alone left every ocean dead — and the
      // microbial phase of `stepLifeSpread` spreads ONLY in water, so that is
      // the opposite of the game. PlanetGrid.ts carries the same lesson at the
      // fertility layer. Measuring species range on a dry-ocean preview made
      // every aquatic lineage look homeless and the map look like a monoculture.
      const alive = isHabitable(cell.biome) || isWater(cell.biome);
      cell.lifeDensity = alive && !formation ? Math.min(1, cell.fertility * 1.4) : 0;
      if (wantCiv && isHabitable(cell.biome) && cell.fertility > 0.45) cell.civId = '0';
    }
  }

  // Run the REAL evolution engine so the creatures on screen come from evolved
  // genomes rather than hand-written stand-ins.
  const phase = (params.get('phase') as BiologyPhase) || 'intelligent';
  const rng = new SeedRNG(`preview_${seed}`);
  const defs = generateBranchSet(new SeedRNG(`branches_preview_${seed}`));
  const dna = emptyInvestment(defs);
  // Spend into the first two branches so the preview shows an invested world.
  dna[defs[0].id] = 50;
  dna[defs[1].id] = 30;
  let species: SpeciesGenome[] = [createFoundingSpecies(0, rng)];
  let bio = { ...DEFAULT_BIOSPHERE };
  // Walk the real phase ladder up to the requested phase, so lineages diversify
  // the way they would in a game rather than sitting in one phase forever.
  const LADDER: BiologyPhase[] =
    ['microbial', 'multicellular', 'complex', 'primitive', 'intelligent'];
  const upto = Math.max(0, LADDER.indexOf(phase));
  for (let p = 0; p <= upto; p++) {
    for (let i = 0; i < 120; i++) {
      const r = stepEvolution(LADDER[p], dna, species, bio, rng, (p * 120 + i) * 2000, defs);
      species = r.updatedSpecies;
      bio = r.updatedBiosphere;
    }
  }
  assignDominantSpecies(grid, species);

  const star = makeStar();
  star.planets[0] = planet;   // the home planet must BE the star's planet (siblings are excluded by identity)
  if (formation) {
    star.formationStage = formation;
    star.formationDestiny = destiny;
    star.hasLife = false;
    planet.hasLife = false;
    planet.destinyType = destiny;
    species = [];
  }
  star.biologyPhase = phase;
  star.civLevel = Number(params.get('civLevel') ?? params.get('civ') ?? 4);

  // Weather overrides, so each cloud kind can be looked at without waiting for a
  // world to industrialise or its biosphere to collapse on its own.
  //   ?pressure=0..1   biosphere under strain  → storms
  //   ?oxygen=0..1     thin / unbreathable air → acid clouds
  //   ?civLevel=0..8   industry                → pollution
  //   ?nebula=1        sit the star in the nebula band
  const pressure = params.get('pressure');
  const oxygen   = params.get('oxygen');
  if (pressure !== null) bio.extinctionPressure = Number(pressure);
  if (oxygen   !== null) bio.oxygenLevel        = Number(oxygen);
  if (params.get('nebula') === '1') { star.x = 100; star.y = 30; }

  (document.getElementById('fps') as HTMLElement).title =
    species.filter(sp => !sp.isExtinct).map(sp => sp.name).join(', ');
  // Nations, as BigBangEngine founds them once a civilisation stands
  // (?nations=0 hides them). Stepped a while so their pressures have moved.
  nations = null;
  const lead = species.filter(sp => !sp.isExtinct).sort((a, b) => b.dna.intelligence - a.dna.intelligence)[0];
  if (!formation && star.civLevel >= 1 && lead && params.get('nations') !== '0') {
    const ns = new NationSystem(seed);
    const g = summariseGenome(lead);
    ns.found(grid, valuesFromGenome(g), g, 0);
    // Stepped at the engine's cadence (every 2000 ticks, 40000 an era) for
    // about as many eras as ?civLevel, so they have learned and polluted.
    for (let t = 1; t <= Math.max(10, 20 * star.civLevel); t++) ns.step(grid, t * 2000, 40000);
    if (ns.isFounded) nations = ns;
  }
  renderer.refreshData(grid, bio, species, planet, star, 0);
  (window as any).__gallery?.(species, star.civLevel);
}

await renderer.init(stage);
renderer.setClock(() => (performance.now() / (1000 / 60)) * YEAR);
// Exposed for console poking while iterating on the look.
(window as any).__diorama = renderer;
// Frame-budget bench for the zoom camera (tools/zoomBench.ts drives it).
installZoomBench(renderer);

// ?fx=revelation | meteor — replay a divine power (or a meteor strike) on a loop so the animation can be
// looked at without a running game and 15 Divine Points.
const fx = params.get('fx');
if (fx) {
  const at = params.get('fxCell');
  const cell = at ? { row: Number(at.split(',')[0]), col: Number(at.split(',')[1]) } : null;
  // ?fx=meteor[&fxSize=0.4..1.2] — the meteor strike sequence (11 s cycle,
  // so each crater can be seen cooling before the next one lands).
  const meteorSize = Number(params.get('fxSize') ?? 0.8);
  const fire = fx === 'meteor'
    ? () => renderer.playMeteorStrike(cell, meteorSize)
    : () => renderer.playDivineEffect(fx as never, cell);
  setTimeout(fire, 300);
  if (params.get('fxOnce') !== '1') setInterval(fire, fx === 'meteor' ? 11000 : 3000);
}
// A strike button in the top bar, for poking at it by hand.
{
  const btn = document.createElement('button');
  btn.textContent = 'meteor';
  btn.title = 'Play a meteor strike on a land cell in view';
  btn.addEventListener('click', () => renderer.playMeteorStrike(null, Number(params.get('fxSize') ?? 0.8)));
  document.getElementById('reroll')?.after(btn);
}
// Dev console / test access.
(window as unknown as { __renderer?: unknown }).__renderer = renderer;
(window as unknown as { __nations?: () => unknown }).__nations = () => nations;

// ?storm=tornado|typhoon|dust_devil|haboob|blizzard|supercell|fire_whirl —
// keep one of that kind on the visible face.
const storm = params.get('storm');
const stormKind = storm ? (VX_NAMES as readonly string[]).indexOf(storm) : -1;
if (stormKind >= 0) setInterval(() => renderer.forceVortex(stormKind, true), 1000);
rebuild();
renderer.start();

document.querySelectorAll<HTMLButtonElement>('#bar button[data-t]').forEach(b => {
  b.addEventListener('click', () => { type = b.dataset.t as Planet['type']; rebuild(); });
});
document.getElementById('reroll')!.addEventListener('click', () => {
  seed = Math.floor(Math.random() * 100000);
  (document.getElementById('seed') as HTMLInputElement).value = String(seed);
  rebuild();
});
document.getElementById('seed')!.addEventListener('change', (e) => {
  seed = Number((e.target as HTMLInputElement).value) || 1;
  rebuild();
});

// FPS meter
let frames = 0, last = performance.now();
const fpsEl = document.getElementById('fps')!;
function tickFps() {
  frames++;
  const now = performance.now();
  if (now - last > 500) {
    fpsEl.textContent = `${Math.round(frames * 1000 / (now - last))} fps`;
    frames = 0; last = now;
  }
  requestAnimationFrame(tickFps);
}
tickFps();


// Species gallery — draws each evolved creature and a settlement at 6x in the
// top bar, so the procedural art can be judged at 1:1 instead of guessed at
// from 5px specks on the globe.
(window as any).__gallery = (species: SpeciesGenome[], civLevel: number) => {
  const old = document.getElementById('gallery');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'gallery';
  wrap.style.cssText =
    'position:fixed;left:8px;bottom:8px;display:flex;gap:10px;align-items:flex-end;' +
    'background:rgba(8,8,20,0.85);padding:8px 10px;border:1px solid #33335a;z-index:99';

  const cell = (canvas: HTMLCanvasElement, label: string) => {
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px';
    const big = document.createElement('canvas');
    const S = 6;
    big.width = canvas.width * S; big.height = canvas.height * S;
    const g = big.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.drawImage(canvas, 0, 0, big.width, big.height);
    big.style.cssText = 'image-rendering:pixelated;border:1px solid #2a2a44';
    const cap = document.createElement('div');
    cap.textContent = label;
    cap.style.cssText = 'font:9px monospace;color:#9a94c0;max-width:130px;text-align:center';
    box.appendChild(big); box.appendChild(cap);
    return box;
  };

  for (const sp of species.filter(s => !s.isExtinct).slice(0, 6)) {
    wrap.appendChild(cell(bakeCreaturePortrait(sp, 24),
      `${sp.name}\n${sp.dna.locomotion}/${sp.dna.diet}`));
  }
  const builder = species.find(s => !s.isExtinct) ?? null;
  wrap.appendChild(cell(bakeSettlementSprite(builder, civLevel, 3, 1), 'settlement'));
  document.body.appendChild(wrap);
};
