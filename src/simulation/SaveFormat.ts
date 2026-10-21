/**
 * Save file format: versioning, migration and validation.
 *
 * Pure (no DOM), so `tools/saveCheck.ts` can test it headless.
 *
 * Changing the shape of a save:
 *   1. Prefer an optional/defaulted field — that needs no version bump, because
 *      `gameStateFromSave` fills missing fields from `createDefaultGameState()`
 *      and `BigBangEngine.loadState` treats new snapshot fields as optional.
 *   2. If an existing field changes meaning, is renamed or removed: bump
 *      `SAVE_VERSION` and add `MIGRATIONS[old]`, which turns a version-`old`
 *      save into a version-`old + 1` save. Never edit an existing migration.
 *   3. Keep `tools/fixtures/save-v1.eternal` loading — it is the oldest format
 *      players may still hold. Add a fixture for each new version.
 */
import type { GameStateData } from './GameState';
import { createDefaultGameState, gameState } from './GameState';
import type { EngineSnapshot } from './BigBangEngine';

/** Current save format. Written into every new save. */
export const SAVE_VERSION = 1;

export interface EternalSaveFile<LogEntry = unknown> {
  version: number;
  savedAt: number;
  gameState: GameStateData;
  engine: EngineSnapshot;
  eventLog: LogEntry[];
}

/** `MIGRATIONS[n]` upgrades a version-n save to version n + 1. */
const MIGRATIONS: Record<number, (save: Record<string, unknown>) => Record<string, unknown>> = {
  // 1: save => ({ ...save, version: 2, /* reshape here */ }),
};

export type ParsedSave =
  | { ok: true; save: EternalSaveFile; migratedFrom: number | null }
  | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate a decoded save and upgrade it to `SAVE_VERSION`.
 *
 * `reason` is written for the player: it is shown when a load fails.
 */
export function migrateSave(raw: unknown): ParsedSave {
  if (!isObject(raw)) return { ok: false, reason: 'This is not an Eternal save file.' };

  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'This save file has no valid version — it may be corrupt.' };
  }
  if (version > SAVE_VERSION) {
    return {
      ok: false,
      reason: `This save was made by a newer version of Eternal System (save format ${version}; ` +
        `this game reads up to ${SAVE_VERSION}). Update the game to load it.`,
    };
  }

  let save: Record<string, unknown> = raw;
  for (let v = version; v < SAVE_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) return { ok: false, reason: `No upgrade path from save format ${v}.` };
    save = step(save);
  }

  if (!isObject(save['gameState']) || !isObject(save['engine'])) {
    return { ok: false, reason: 'This save file is incomplete — it may be corrupt.' };
  }
  if (!Array.isArray(save['eventLog'])) save = { ...save, eventLog: [] };

  return {
    ok: true,
    save: save as unknown as EternalSaveFile,
    migratedFrom: version === SAVE_VERSION ? null : version,
  };
}

/**
 * The game state to restore: defaults for every field, then the saved values.
 *
 * Assigning the saved object straight onto the live `gameState` left any field
 * newer than the save holding the CURRENT session's value — e.g. loading an
 * older save during a Creative run kept `playMode: 'creative'`.
 */
export function gameStateFromSave(saved: Partial<GameStateData>): GameStateData {
  const out = createDefaultGameState();
  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Put a save into a fresh engine: the game state, a universe built from its
 * seed, then the saved simulation over it.
 *
 * `init()` starts a new universe and clears the player's own records (their
 * lineage, its mutations and forms, the landmarks...). Applying the saved
 * state only before it lost all of those on every load (alpha playtest
 * round 2), so the saved state goes back on after it too.
 */
export function restoreSave(engine: { init(stats: NonNullable<GameStateData['stats']>, seed: string): void; loadState(snap: EngineSnapshot): void },
  save: EternalSaveFile): void {
  Object.assign(gameState, gameStateFromSave(save.gameState));
  engine.init(gameState.stats!, gameState.masterSeed);
  Object.assign(gameState, gameStateFromSave(save.gameState));
  engine.loadState(save.engine);
}
