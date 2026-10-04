/**
 * Dev-only harness for IsoDioramaRenderer.
 * Served at /diorama-preview.html — lets the diorama be iterated on without
 * replaying a full game. Not imported by the game bundle.
 */
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
import { formationFaceType, isDestinyType, type DestinyType } from '../simulation/Formation';

const stage = document.getElementById('stage')!;
const renderer = new IsoDioramaRenderer();

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

function makePlanet(): Planet {
  return {
    orbitalAngle: 0, orbitalRadius: 40, orbitalSpeed: orbitSpeed(40),
    eccentricity: Number(params.get('ecc') ?? 0), periapsisAngle: 0,
    radius: 6, type, hasLife: true, biosphere: 0.8,
    color: '#3a8f3a', discovery: 'landing', name: `Preview-${seed}`,
    genomeSeed: seed,
    moons: [
      { name: 'I-a', radius: 1.6, orbitalRadius: 14, orbitalAngle: 0.6,
        orbitalSpeed: 0.09, color: '#d6ecf8', kind: 'ice',
        habitability: 0.52, colonised: false, colonisedTick: null },
      { name: 'I-b', radius: 0.9, orbitalRadius: 22, orbitalAngle: 3.1,
        orbitalSpeed: 0.05, color: '#8c7f78', kind: 'iron',
        habitability: 0.11, colonised: false, colonisedTick: null },
    ],
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
  renderer.refreshData(grid, bio, species, planet, star, 0);
  (window as any).__gallery?.(species, star.civLevel);
}

await renderer.init(stage);
renderer.setClock(() => (performance.now() / (1000 / 60)) * YEAR);
// Exposed for console poking while iterating on the look.
(window as any).__diorama = renderer;
// Frame-budget bench for the zoom camera (tools/zoomBench.ts drives it).
installZoomBench(renderer);

// ?fx=revelation — replay a divine power on a loop so the animation can be
// looked at without a running game and 15 Divine Points.
const fx = params.get('fx');
if (fx) {
  const at = params.get('fxCell');
  const cell = at ? { row: Number(at.split(',')[0]), col: Number(at.split(',')[1]) } : null;
  const fire = () => renderer.playDivineEffect(fx as never, cell);
  setTimeout(fire, 300);
  setInterval(fire, 3000);
}
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
