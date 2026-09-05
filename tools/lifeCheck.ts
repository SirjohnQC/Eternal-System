/**
 * Dev-only Monte-Carlo check for the LifeSystem model.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/lifeCheck.ts --bundle --platform=node  *     --format=esm --outfile=/tmp/lifecheck.mjs && node /tmp/lifecheck.mjs
 *
 * The point of the life model is that outcomes VARY. This prints the actual
 * distributions so the claim can be checked rather than assumed.
 */

import { SeedRNG } from '../src/utils/SeedRNG';
import { BIO_PHASE_SEQUENCE, type BiologyPhase } from '../src/simulation/GameState';
import {
  ARCHETYPES, planetHabitability, pickArchetype, rollBioTempo,
  resolveTransition, survivesFloorCollapse, STALL_TIME_PENALTY,
  type LifeArchetype, type PlanetKind,
} from '../src/simulation/LifeSystem';

const TYPES: PlanetKind[] = ['rocky', 'ocean', 'gas', 'ice', 'lava'];

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`.padStart(6);
}

// ── 1. Habitability spread across randomly generated systems ─────────────────
{
  const rng = new SeedRNG('hab');
  const buckets = [0, 0, 0, 0, 0];
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const starT = rng.nextFloat(3000, 30000);
    const starMass = rng.nextFloat(1, 8);
    const inner = 2.5 + starMass * 0.8 + 5;
    let best = 0;
    const count = rng.nextInt(1, 4);
    for (let k = 0; k < count; k++) {
      best = Math.max(best, planetHabitability({
        planetType: TYPES[rng.nextInt(0, 4)],
        orbitalRadius: inner + k * 7 + rng.nextFloat(0, 5),
        starTemperature: starT,
      }));
    }
    buckets[Math.min(4, Math.floor(best * 5))]++;
  }
  console.log('\n── System habitability (best planet) ──');
  ['0.0–0.2', '0.2–0.4', '0.4–0.6', '0.6–0.8', '0.8–1.0'].forEach((label, i) => {
    console.log(`  ${label}  ${pct(buckets[i], N)}`);
  });
}

// ── 2. Tempo spread ─────────────────────────────────────────────────────────
{
  const rng = new SeedRNG('tempo');
  const samples: number[] = [];
  for (let i = 0; i < 20000; i++) samples.push(rollBioTempo(rng, 'carbon_water'));
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.floor(p * samples.length)].toFixed(2);
  console.log('\n── Carbon/water evolutionary tempo ──');
  console.log(`  p05 ${q(0.05)}×   p25 ${q(0.25)}×   median ${q(0.5)}×   p75 ${q(0.75)}×   p95 ${q(0.95)}×`);
}

// ── 3. Where biospheres actually end up, given a real tick budget ───────────
//
// Stalls do not block a world outright — they cost it TIME, because the retry
// rate scales with the stall count. So the honest measure is: simulate the tick
// loop for a plausible session length and see where worlds actually are.
const BIO_PHASE_TICKS: Record<BiologyPhase, number> = {
  microbial: 25000, multicellular: 20000, complex: 17500, primitive: 15000,
  intelligent: Infinity,
};

function simulateWorld(
  hab: number, arch: LifeArchetype, tempo: number, budget: number, rng: SeedRNG,
): BiologyPhase | 'extinct' {
  const evoMod = 1.1;      // evolution stat 10
  const speedMult = 0.12;  // NPC world
  let phase: BiologyPhase = 'microbial';
  let stalls = 0;
  let t = 0;

  while (t < budget) {
    if (phase === 'intelligent') return phase;
    const rate = BIO_PHASE_TICKS[phase] * evoMod * speedMult
               / Math.max(0.15, tempo) * (1 + stalls * STALL_TIME_PENALTY);
    t += rate;
    if (t >= budget) break;

    const outcome = resolveTransition(
      { phase, habitability: hab, archetype: arch, stalls, assistance: 0 }, rng);
    const idx = BIO_PHASE_SEQUENCE.indexOf(phase);
    if (outcome === 'stall') { stalls++; continue; }
    if (outcome === 'collapse') {
      if (idx === 0) {
        if (!survivesFloorCollapse(rng, arch)) return 'extinct';
        stalls++;
        continue;
      }
      phase = BIO_PHASE_SEQUENCE[idx - 1];
      stalls = 0;
      continue;
    }
    stalls = 0;
    phase = BIO_PHASE_SEQUENCE[Math.min(4, idx + (outcome === 'burst' ? 2 : 1))];
  }
  return phase;
}

for (const budget of [200_000, 1_000_000]) {
  console.log(`\n── Where seeded biospheres are after ${budget.toLocaleString()} ticks ──`);
  console.log('    type   extinct  microb  multic  complx  primit  INTELL   (of worlds that got life)');
  for (const type of TYPES) {
    const rng = new SeedRNG(`out_${type}_${budget}`);
    const tally: Record<string, number> = {
      extinct: 0, microbial: 0, multicellular: 0, complex: 0, primitive: 0, intelligent: 0,
    };
    let seeded = 0;
    let attempts = 0;

    while (seeded < 4000 && attempts < 400000) {
      attempts++;
      const hab = planetHabitability({
        planetType: type,
        orbitalRadius: rng.nextFloat(8, 50),
        starTemperature: rng.nextFloat(3000, 30000),
      });
      // Worlds below the floor never get life at all — that is a different
      // outcome from a biosphere that arose and died, so it is not tallied here.
      if (hab <= 0.08) continue;
      seeded++;

      const arch: LifeArchetype = pickArchetype(type, rng);
      const tempo = rollBioTempo(rng, arch);
      tally[simulateWorld(hab, arch, tempo, budget, rng)]++;
    }

    const cells = ['extinct', 'microbial', 'multicellular', 'complex', 'primitive', 'intelligent']
      .map(k => pct(tally[k], seeded)).join(' ');
    console.log(`  ${type.padEnd(6)} ${cells}`);
  }
}

// ── 4. Archetype pick distribution ──────────────────────────────────────────
{
  console.log('\n── Biochemistry that takes hold, by planet type ──');
  for (const type of TYPES) {
    const rng = new SeedRNG(`arch_${type}`);
    const tally: Record<string, number> = {};
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const a = pickArchetype(type, rng);
      tally[a] = (tally[a] ?? 0) + 1;
    }
    const parts = Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${ARCHETYPES[k as LifeArchetype].label} ${pct(v, N).trim()}`)
      .join(', ');
    console.log(`  ${type.padEnd(6)} ${parts}`);
  }
}
