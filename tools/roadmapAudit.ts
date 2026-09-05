/**
 * Dev-only: audit ROADMAP.md claims against the actual source.
 *
 * Checkboxes drift. This greps the code for the concrete symbol each claim
 * depends on and reports three outcomes:
 *   OK        — marked done, and the code backs it up
 *   MISSING   — marked done, but the symbol is not there  (false positive)
 *   UNDERSOLD — marked NOT done, but the code has it      (false negative)
 *   STALE     — the claim's own wording no longer matches the code
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/roadmapAudit.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/audit.mjs && node /tmp/audit.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();

function collect(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, acc);
    else if (['.ts', '.html', '.json'].includes(extname(name))) acc.push(full);
  }
  return acc;
}

const files = collect(ROOT);
const hasSchemaFile = files.some(f => f.includes('universeDNA.schema.json'));
const corpus = new Map<string, string>();
for (const f of files) corpus.set(f, readFileSync(f, 'utf8'));

/** Does any source file contain this literal? */
function has(needle: string, only?: string): boolean {
  for (const [path, text] of corpus) {
    if (only && !path.includes(only)) continue;
    if (path.includes('tools')) continue;           // don't match the audit itself
    // universeDNA.schema.json is a SPEC. Symbols named there are not evidence
    // that anything implements them, and matching it reported DNAModifier and
    // playerActions as built when neither exists.
    if (path.includes('universeDNA.schema.json')) continue;
    if (text.includes(needle)) return true;
  }
  return false;
}

type Verdict = 'OK' | 'MISSING' | 'UNDERSOLD' | 'STALE';
interface Claim {
  milestone: string;
  claim: string;
  /** true if the roadmap has it ticked */
  marked: boolean;
  /** symbols that must ALL be present for the claim to hold */
  needs: string[];
  /** optional note explaining a STALE verdict */
  stale?: string;
}

const CLAIMS: Claim[] = [
  // ── M0–M2 ────────────────────────────────────────────────────────────────
  { milestone: 'M0', claim: 'SeedRNG mulberry32, no Math.random in sim', marked: true,
    needs: ['export class SeedRNG', 'mulberry32'] },
  // Matched against the schema file itself, which the corpus keeps but has() skips
  // for every other claim.
  { milestone: 'M1', claim: 'universeDNA.schema.json exists', marked: true,
    needs: ['SCHEMA_FILE_PRESENT'] },
  { milestone: 'M1', claim: 'Camera zoom + pan with lerp', marked: true,
    needs: ['private camera: Camera'] },
  { milestone: 'M2', claim: 'D20 roll: 4 player stats + God rolls divine', marked: true,
    needs: ['godDivineRoll', 'roll-btn'] },
  { milestone: 'M2', claim: 'Seed from stat rolls + name hash', marked: true,
    needs: ['const seed = `eternal_'] },
  { milestone: 'M2', claim: 'Fog of war destination-out punch-holes', marked: true,
    needs: ['destination-out'] },

  // ── M3 ───────────────────────────────────────────────────────────────────
  { milestone: 'M3', claim: 'Speed controls include PAUSE', marked: true,
    needs: ['data-speed="0"', 'speed <= 0'] },
  { milestone: 'M3', claim: 'animTick separation', marked: true,
    needs: ['private animTick', 'settledSinceAnimTick'] },
  { milestone: 'M3', claim: 'War phases skirmish/campaign/siege/resolution', marked: true,
    needs: ["'skirmish'", "'campaign'", "'siege'", "'resolution'"] },
  { milestone: 'M3', claim: 'War type HOMELAND DEFENSE vs INTERGALACTIC', marked: true,
    needs: ['HOMELAND DEFENSE', 'INTERGALACTIC'] },
  { milestone: 'M3', claim: 'Tier 2 abstract sim for distant stars', marked: false,
    needs: ['tier2', 'Tier2'] },
  { milestone: 'M3', claim: 'Batch evolution at high speed', marked: false,
    needs: ['batchEvolution'] },

  // ── M4 ───────────────────────────────────────────────────────────────────
  { milestone: 'M4', claim: 'GeminiService with rate limit', marked: true,
    needs: ['class GeminiService', 'MAX_CALLS_PER_MINUTE'] },
  { milestone: 'M4', claim: 'FallbackNarrator offline narrative', marked: true,
    needs: ['class FallbackNarrator'] },
  { milestone: 'M4', claim: 'Player chat 3s debounce', marked: true,
    needs: ['PLAYER_MESSAGE_DEBOUNCE_MS'] },
  { milestone: 'M4', claim: 'AIEventQueue', marked: false, needs: ['AIEventQueue'] },
  { milestone: 'M4', claim: 'EventResolver', marked: false, needs: ['class EventResolver'] },
  { milestone: 'M4', claim: 'DNAModifier.safeApply', marked: false, needs: ['DNAModifier'] },

  // ── M5 ───────────────────────────────────────────────────────────────────
  { milestone: 'M5', claim: 'Codex modal with category tabs', marked: true,
    needs: ['codex-overlay', 'codexEntries'] },
  { milestone: 'M5', claim: 'Solar System Panel + mini orrery', marked: true,
    needs: ['sys-orrery', 'drawSystemOrrery'] },
  { milestone: 'M5', claim: 'Custom 3-state cursor', marked: true,
    needs: ['cursor: url("data:image/svg', 'aria-disabled'] },
  { milestone: 'M5', claim: 'NotificationToast for cosmic events', marked: true,
    needs: ['showToast'] },

  // ── M6 ───────────────────────────────────────────────────────────────────
  { milestone: 'M6', claim: 'Divine Sight 20 DP', marked: true,
    needs: ['divine sight', 'spendDPToExplore'] },
  { milestone: 'M6', claim: 'Bless Harvest', marked: true, needs: ['blessHarvest'] },
  { milestone: 'M6', claim: 'Send Prophet', marked: true, needs: ['prophetBoostActive'] },
  { milestone: 'M6', claim: 'Trigger Revelation', marked: true, needs: ['triggerRevelation'] },
  { milestone: 'M6', claim: 'Send Meteor + onMeteorLifeSeeded', marked: true,
    needs: ['sendMeteor', 'onMeteorLifeSeeded'] },
  { milestone: 'M6', claim: 'Meteor impact overlay', marked: true,
    needs: ['meteor-impact-overlay', 'METEOR_IMPACT_IMAGES'] },
  { milestone: 'M6', claim: 'Smite Asteroid', marked: true, needs: ['smiteAsteroid'] },
  { milestone: 'M6', claim: 'Planet Formation Cycle 6 stages', marked: true,
    needs: ['FORMATION_SEQUENCE', 'primordial'] },
  { milestone: 'M6', claim: 'Terraforming', marked: true,
    needs: ['TERRAFORM_SEQUENCES', 'onTerraformComplete'] },
  { milestone: 'M6', claim: 'Religion system + devotion', marked: true,
    needs: ['religionDevotion', 'generateReligionName'] },
  { milestone: 'M6', claim: 'War dice modal', marked: true,
    needs: ['war-dice-overlay', 'applyBattleResult'] },
  { milestone: 'M6', claim: 'Enemy war occupation overlay', marked: true,
    needs: ['drawWarOccupation', 'OCCUPIED'] },
  { milestone: 'M6', claim: 'DP economy: cap 150, devotion regen', marked: true,
    needs: ['DP_CAP', 'DP_DEVOTION_THRESHOLD_HIGH'] },
  { milestone: 'M6', claim: 'Nudge Evolution = mutation + bioAssistance', marked: true,
    needs: ['nudgePlayerEvolution', 'bioAssistance'] },
  { milestone: 'M6', claim: 'DP regen is real-time, devotion-scaled', marked: true,
    needs: ['DP_REGEN_INTERVAL_MS'] },
  { milestone: 'M6', claim: 'PlayerActionLog for replay determinism', marked: false,
    needs: ['playerActions'] },
  { milestone: 'M6', claim: 'Trade routes', marked: false, needs: ['tradeRoute'] },

  // ── M7 / M7b / M7c ───────────────────────────────────────────────────────
  // The diorama draws a moon for the home world; M7 asks for moons with orbital
  // paths in the UNIVERSE view, which is a different thing.
  { milestone: 'M7', claim: 'Moon rendering + orbital paths (universe view)', marked: false,
    needs: ['moonOrbit'] },
  // Nebulae exist as event debris in the engine; M7 asks for a dedicated sprite
  // layer behind the star field.
  { milestone: 'M7', claim: 'Nebula SPRITE layer behind star field', marked: false,
    needs: ['nebulaSprite'] },
  { milestone: 'M7b', claim: 'GRID_SIZE = 256', marked: true,
    needs: ['export const GRID_SIZE = 256'] },
  { milestone: 'M7b', claim: 'stepLifeSpread wired in engine (Phase 3)', marked: true,
    needs: ['stepLifeSpread(runtimeState.playerPlanetGrid'] },
  { milestone: 'M7b', claim: 'Phase 4 — civId claimed as tech advances', marked: true,
    needs: ['cell.civId = activeCivId'] },
  // Satisfied in substance by the M19 diorama, though on Canvas 2D rather than Pixi.
  { milestone: 'M7b', claim: 'Phase 5 — planet view reads grid tiles directly', marked: true,
    needs: ['discToGrid'] },
  { milestone: 'M7c', claim: 'PixiBigBangRenderer + onPixiFrame', marked: true,
    needs: ['class PixiBigBangRenderer', 'onPixiFrame'] },

  // ── M8 / M8b ─────────────────────────────────────────────────────────────
  { milestone: 'M8', claim: 'pako-compressed .eternal saves', marked: true,
    needs: ['gzip', 'ungzip'] },
  { milestone: 'M8b', claim: 'Frame budget enforcement', marked: false,
    needs: ['budgetViolation'] },
  { milestone: 'M8b', claim: 'Object pooling', marked: false, needs: ['ObjectPool'] },
  { milestone: 'M8b', claim: 'Spatial index for O(n^2) loops', marked: false,
    needs: ['spatialIndex'] },
  { milestone: 'M8b', claim: 'Texture cache eviction (cap 64, LRU)', marked: false,
    needs: ['planetTextureCache.delete'] },
  { milestone: 'M8b', claim: 'Unit tests', marked: false, needs: ['describe('] },

  // ── M9 ───────────────────────────────────────────────────────────────────
  { milestone: 'M9', claim: 'Settings modal', marked: true, needs: ['settings-overlay'] },
  { milestone: 'M9', claim: 'Music volume slider', marked: true, needs: ['vol-music'] },
  { milestone: 'M9', claim: 'i18n locale map', marked: false, needs: ['i18n'] },

  // ── M10 / M11 ────────────────────────────────────────────────────────────
  { milestone: 'M10', claim: 'Planet-defining questions modify PlanetDNA', marked: true,
    needs: ['answeredQuestions'] },
  { milestone: 'M10', claim: 'PlanetHistoryLog', marked: false, needs: ['PlanetHistoryLog'] },
  { milestone: 'M11', claim: 'Mineral resources distribution', marked: false,
    needs: ['MINERAL'] },

  // ── M13 / M14 ────────────────────────────────────────────────────────────
  { milestone: 'M13', claim: 'AI God alignment / TrustLevel', marked: false,
    needs: ['TrustLevel'] },
  { milestone: 'M14', claim: 'SpriteSystem for ship sprites', marked: false,
    needs: ['class SpriteSystem'] },

  // ── M15 / M16 ────────────────────────────────────────────────────────────
  { milestone: 'M15', claim: 'Universe Timeline modal', marked: true,
    needs: ['timeline-overlay', 'eventLogEntries'] },
  { milestone: 'M15', claim: 'First Contact modal', marked: true,
    needs: ['first-contact-overlay', 'firstContactFired'] },
  { milestone: 'M15', claim: 'Cosmic Radio signals', marked: true,
    needs: ['CosmicSignal', 'RADIO_DECODE_TICKS'] },
  { milestone: 'M16', claim: 'Leader generation + memory', marked: true,
    needs: ['generateLeader', 'LeaderMemory'] },
  { milestone: 'M16', claim: 'Faction flag object per civ', marked: true,
    needs: ['generateFactionFlag'] },
  // Must be present in the PIXI path: the Canvas 2D branch is dead under pixiMode.
  { milestone: 'M16', claim: 'Flag rendered on star at zoom >= 0.6 (Pixi path)', marked: true,
    needs: ['drawFactionFlags', 'flagTexture'] },
  { milestone: 'M16', claim: 'leaderMemories persisted in save', marked: true,
    needs: ['leaderMemories'] },
  { milestone: 'M16', claim: 'Memory entry after every interaction', marked: true,
    needs: ['appendLeaderMemory'] },

  // ── M17 / M18 ────────────────────────────────────────────────────────────
  { milestone: 'M17', claim: 'EvolutionEngine stepEvolution', marked: true,
    needs: ['export function stepEvolution', 'EVOLUTION_TICK_RATE'] },
  { milestone: 'M17', claim: 'BiosphereRenderer', marked: true,
    needs: ['BiosphereRenderer'] },
  { milestone: 'M18', claim: 'slowForEvent / restoreSpeed', marked: true,
    needs: ['slowForEvent', 'restoreSpeed'] },
  { milestone: 'M18', claim: 'applyNudgeMutation', marked: true,
    needs: ['applyNudgeMutation'] },

  // ── M19 / M19b / M19c / M20 ──────────────────────────────────────────────
  { milestone: 'M19', claim: 'Canvas 2D diorama (not Pixi)', marked: true,
    needs: ['IsoDioramaRenderer', 'imageRendering'] },
  { milestone: 'M19', claim: 'fbmWrapX seam fix', marked: true, needs: ['fbmWrapX'] },
  { milestone: 'M19b', claim: 'LifeSystem archetypes + filters', marked: true,
    needs: ['ARCHETYPES', 'resolveTransition', 'survivesFloorCollapse'] },
  { milestone: 'M19c', claim: 'constrainToUniverse + star formation', marked: true,
    needs: ['constrainToUniverse', 'updateStarFormation', 'stellarNurseries'] },
  { milestone: 'M20', claim: 'pickTile + gridToDisc + tile actions', marked: true,
    needs: ['pickTile', 'gridToDisc', 'TILE_ACTIONS'] },
  { milestone: 'M20', claim: 'Subterranean data layer', marked: false,
    needs: ['subterranean'] },
];

const results: Array<{ v: Verdict; c: Claim; missing: string[] }> = [];

for (const c of CLAIMS) {
  const missing = c.needs.filter(n =>
    n === 'SCHEMA_FILE_PRESENT' ? !hasSchemaFile : !has(n));
  const present = missing.length === 0;

  let v: Verdict;
  if (c.marked && present && c.stale) v = 'STALE';   // symbol found but wording wrong
  else if (c.marked && present) v = 'OK';
  else if (c.marked && !present) v = c.stale ? 'STALE' : 'MISSING';
  else if (!c.marked && present) v = 'UNDERSOLD';
  else v = 'OK';                                     // not marked, not present — consistent

  results.push({ v, c, missing });
}

const order: Verdict[] = ['MISSING', 'STALE', 'UNDERSOLD', 'OK'];
const label: Record<Verdict, string> = {
  MISSING:   'MARKED DONE BUT NOT FOUND',
  STALE:     'CLAIM WORDING NO LONGER MATCHES CODE',
  UNDERSOLD: 'MARKED NOT-DONE BUT ALREADY IMPLEMENTED',
  OK:        'CONSISTENT',
};

for (const v of order) {
  const rows = results.filter(r => r.v === v);
  if (v === 'OK') { console.log(`\n── ${label[v]}: ${rows.length} claims ──`); continue; }
  console.log(`\n── ${label[v]} (${rows.length}) ──`);
  for (const r of rows) {
    console.log(`  [${r.c.milestone}] ${r.c.claim}`);
    if (r.c.stale) console.log(`        → ${r.c.stale}`);
    else if (r.missing.length) console.log(`        → missing: ${r.missing.join(', ')}`);
  }
}

const bad = results.filter(r => r.v !== 'OK').length;
console.log(`\n${results.length} claims audited, ${bad} need attention.\n`);
