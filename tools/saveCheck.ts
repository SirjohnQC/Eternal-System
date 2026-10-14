/**
 * Save compatibility checks (part of `npm test`).
 *
 *   npm run test:saves
 *
 * - Every fixture in tools/fixtures/ (saves written by earlier builds) must
 *   still load and keep running.
 * - Fields newer than a save get defaults, not the current session's values.
 * - Save → load continues the same universe tick-for-tick.
 * - Saves from a newer format, and corrupt saves, are refused with a reason.
 *
 * Exits non-zero on any failure.
 */
import { makeCanvas } from './lib/headlessDom';
import { gunzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { gameState, createDefaultGameState } = await import('../src/simulation/GameState');
const { SAVE_VERSION, migrateSave, gameStateFromSave } = await import('../src/simulation/SaveFormat');

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(`${name}${detail ? ': ' + detail : ''}`); console.log(`  FAIL  ${name}  — ${detail}`); }
}

/** What applyLoadedSave() does to the simulation, minus the DOM. */
function loadIntoEngine(save: any): any {
  Object.assign(gameState, gameStateFromSave(save.gameState));
  const e = new BigBangEngine(makeCanvas()) as any;
  e.init(save.gameState.stats, save.gameState.masterSeed);
  e.loadState(save.engine);
  return e;
}

const fingerprint = (e: any): string => (e.stars as any[])
  .map(s => `${s.id}:${s.x.toFixed(4)},${s.y.toFixed(4)},${s.biologyPhase},${s.civLevel},${s.isDead ? 1 : 0}`)
  .join('|');

// ── Fixtures from earlier builds ─────────────────────────────────────────────
const dir = join(process.cwd(), 'tools', 'fixtures');
const fixtures = readdirSync(dir).filter(f => f.endsWith('.eternal')).sort();
check('save fixtures exist', fixtures.length > 0, fixtures.join(', '));
const defaultKeys = Object.keys(createDefaultGameState());

for (const f of fixtures) {
  console.log(`\n═══ ${f} ═══`);
  const raw = JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString('utf8'));
  // Load it during a Creative session: nothing from that session may leak in.
  gameState.playMode = 'creative';
  const parsed = migrateSave(raw);
  check('parses and migrates', parsed.ok, parsed.ok ? `v${raw.version} → v${SAVE_VERSION}` : parsed.reason);
  if (!parsed.ok) continue;

  let e: any;
  try { e = loadIntoEngine(parsed.save); } catch (err) { check('loads into the engine', false, String(err)); continue; }
  check('loads into the engine', true);
  check('resumes at the saved tick', e.tick === parsed.save.engine.tick, `${e.tick}`);
  const missing = defaultKeys.filter(k => !(k in gameState));
  check('every current gameState field is present', missing.length === 0, missing.join(', '));
  const savedMode = (parsed.save.gameState as any).playMode;
  check('playMode comes from the save, else defaults to normal',
    gameState.playMode === (savedMode ?? 'normal'), `${gameState.playMode} (saved: ${savedMode ?? 'absent'})`);

  let threw: string | null = null;
  try { for (let i = 0; i < 3_000; i++) e.update(); } catch (err) { threw = (err as Error).message; }
  check('keeps running for 3k ticks', threw === null, threw ?? '');
  check('player still has a home star', !!e.getPlayerStar());
}

// ── Round trip with the current build ────────────────────────────────────────
console.log('\n═══ round trip ═══');
{
  const stats = { life: 15, evolution: 13, hostility: 12, entropy: 11, divine: 10 };
  Object.assign(gameState, createDefaultGameState(), { stats, masterSeed: 'roundtrip' });
  const a = new BigBangEngine(makeCanvas()) as any;
  a.init(stats, 'roundtrip');
  for (let i = 0; i < 10_000; i++) a.update();
  // The home surface carries what happened on it (#77): mark some of it the
  // way life spread, settling and divine land edits do.
  const ga = a.ensurePlayerGrid();
  if (ga) for (let r = 40; r < 60; r++) for (let c = 100; c < 140; c++) {
    ga[r][c].lifeDensity = (r * 7 + c) % 10 / 10;
    ga[r][c].civId = String(a.getPlayerStar().id);
    if (c < 110) { ga[r][c].elevation = 0.83 + r / 1000; ga[r][c].biome = 'mountain'; }
  }
  const json = JSON.stringify({ version: SAVE_VERSION, savedAt: 0, gameState: { ...gameState }, engine: a.serialize(), eventLog: [] });
  const gridBefore = ga ? ga.map((row: any[]) => row.map(c => ({ ...c }))) : null;
  const parsed = migrateSave(JSON.parse(json));
  check('current save parses', parsed.ok);
  if (parsed.ok) {
    const b = loadIntoEngine(parsed.save);
    check('identical at load', fingerprint(a) === fingerprint(b));
    // The grid is one global (runtimeState), so compare b's against a copy of a's.
    const gridDiff = (gx: any, gy: any): number => {
      if (!gx || !gy) return gx === gy ? 0 : -1;
      let n = 0;
      for (let r = 0; r < gx.length; r++) for (let c = 0; c < gx[r].length; c++) {
        for (const k of Object.keys(gx[r][c])) if (gx[r][c][k] !== gy[r][c][k]) n++;
      }
      return n;
    };
    const d0 = gridDiff(gridBefore, b.ensurePlayerGrid());
    check('home surface restored exactly (#77)', d0 === 0, d0 === 0 ? `${(JSON.stringify(parsed.save.engine.playerGrid ?? {}).length / 1024).toFixed(1)} KB of changes saved` : `${d0} fields differ`);
    check('identical 5k ticks after load', fingerprint(a) === fingerprint(b));

  }
}

// ── Refusals ─────────────────────────────────────────────────────────────────
console.log('\n═══ refusals ═══');
{
  const refused = (name: string, raw: unknown, mustMention: RegExp) => {
    const r = migrateSave(raw);
    check(name, !r.ok && mustMention.test(r.reason), r.ok ? 'was accepted' : r.reason);
  };
  const ok = { gameState: {}, engine: {}, eventLog: [] };
  refused('newer format is refused, with update advice', { ...ok, version: SAVE_VERSION + 1 }, /newer version/i);
  refused('missing version is refused', { ...ok }, /version/i);
  refused('non-object is refused', 'garbage', /not an Eternal save/i);
  refused('missing engine snapshot is refused', { version: SAVE_VERSION, gameState: {} }, /incomplete/i);
  const r = migrateSave({ version: SAVE_VERSION, gameState: {}, engine: {} });
  check('missing event log becomes empty', r.ok && Array.isArray(r.save.eventLog));
}

console.log(`\n═══ ${failures.length ? `${failures.length} FAILED` : 'OK'} — ${passed} passed ═══`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
