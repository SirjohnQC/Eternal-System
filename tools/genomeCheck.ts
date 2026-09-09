/**
 * PlanetGenome guards.
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/genomeCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/genomeCheck.mjs && node /tmp/genomeCheck.mjs
 */
const { rollPlanetGenome, genomeFromLegacy, genomeSeedFor } =
  await import('../src/simulation/PlanetGenome');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  failed++;
}

const TYPES = ['rocky', 'ocean', 'gas', 'ice', 'lava',
               'toxic', 'crystal', 'desert', 'storm', 'carbon'];

// 1. Determinism — same inputs, deep-equal output, every time.
for (const t of TYPES) {
  const a = rollPlanetGenome(4242, t, null);
  const b = rollPlanetGenome(4242, t, null);
  check(`deterministic: ${t}`, JSON.stringify(a) === JSON.stringify(b));
}

// 2. Different seeds must actually differ.
const s1 = rollPlanetGenome(1, 'ocean', null);
const s2 = rollPlanetGenome(2, 'ocean', null);
check('distinct seeds differ', JSON.stringify(s1) !== JSON.stringify(s2));

// 3. The genome records the type it was rolled from and never re-reads it.
const g = rollPlanetGenome(77, 'lava', null);
check('sourceType captured', g.sourceType === 'lava');
check('seed captured', g.seed === 77);

// 4. Legacy shim is deterministic and type-keyed.
for (const t of TYPES) {
  const a = genomeFromLegacy(t, 9);
  const b = genomeFromLegacy(t, 9);
  check(`legacy deterministic: ${t}`, JSON.stringify(a) === JSON.stringify(b));
}

// 4b. Legacy parity is the whole point of the shim, so assert the ACTUAL
//     values against the shipped renderer's palette — not merely that a
//     number is present. These densities are copied from
//     src/rendering/HabitableCutawayEngine.ts (`atmoDensity` per palette);
//     if that file changes, this check must be updated deliberately.
const REAL_DENSITY: Record<string, number> = {
  ocean: 1.00, rocky: 1.00, ice: 1.05, lava: 1.55, gas: 1.45,
  toxic: 1.25, crystal: 1.15, desert: 0.70, storm: 1.60, carbon: 0.65,
};
for (const t of TYPES) {
  const a = genomeFromLegacy(t, 9);
  check(`legacy density matches renderer: ${t}`,
    a.atmosphere.density === REAL_DENSITY[t],
    `got ${a.atmosphere.density}, renderer has ${REAL_DENSITY[t]}`);
  check(`legacy thickness is OZONE_FADE_PX: ${t}`, a.atmosphere.thicknessPx === 8,
    `got ${a.atmosphere.thicknessPx}`);
  check(`legacy hue in range: ${t}`,
    a.atmosphere.hue >= 0 && a.atmosphere.hue < 360, `got ${a.atmosphere.hue}`);
  check(`legacy saturation in range: ${t}`,
    a.atmosphere.saturation >= 0 && a.atmosphere.saturation <= 1,
    `got ${a.atmosphere.saturation}`);
}

// 4c. Distinct palettes must stay distinct — this is what catches a
//     scrambled or misassigned table, which a per-field range check cannot.
const sig = (t: string) => {
  const a = genomeFromLegacy(t, 0).atmosphere;
  return `${a.hue.toFixed(2)}|${a.saturation.toFixed(3)}|${a.density}`;
};
const sigs = new Map<string, string>();
let dupes = 0;
for (const t of TYPES) {
  for (const [other, v] of sigs) if (v === sig(t)) { dupes++; console.log(`  FAIL  ${t} and ${other} share an atmosphere signature`); }
  sigs.set(t, sig(t));
}
check('all ten types have distinct atmospheres', dupes === 0, `${dupes} collisions`);

// 5. Seed derivation is stable and collision-free for a plausible cosmos.
const seen = new Set<number>();
let collisions = 0;
for (let star = 0; star < 80; star++) {
  for (let i = 0; i < 8; i++) {
    const s = genomeSeedFor(star, i);
    if (seen.has(s)) collisions++;
    seen.add(s);
  }
}
check('genomeSeedFor collision-free over 640 planets', collisions === 0,
  `${collisions} collisions`);
check('genomeSeedFor stable', genomeSeedFor(5, 3) === genomeSeedFor(5, 3));

console.log(failed === 0 ? '\nAll genome checks passed.' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
