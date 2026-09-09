/**
 * Central constants file — all simulation balance numbers and magic values live here.
 * Tweak here to adjust game feel without hunting through multiple files.
 */
import type { BiologyPhase } from './simulation/GameState';

// ─── Universe / Rendering ──────────────────────────────────────────────────
export const WORLD_SIZE       = 5600;   // world-space extent — larger disc so galaxies sit in real void
export const INFLATION_TICKS  = 240;    // frames for Big Bang inflation phase
export const MAX_SPEED        = 5.0;    // initial shrapnel spread speed

/**
 * The universe is a DISC, not a box.
 *
 * Stars used to be clamped independently on x and y, which pinned anything that
 * flew far enough to one of four straight walls — so the cosmos visibly spread
 * out into a square with dense corners. Everything that bounds the universe now
 * works off this radius instead.
 */
export const UNIVERSE_RADIUS  = WORLD_SIZE / 2 - 40;
/** Per-tick velocity decay during inflation. */
export const INFLATION_DECAY  = 0.97;
/**
 * Total drift a star covers during inflation per unit of initial speed.
 * Sum of the geometric series v·d + v·d² + … = v·d/(1−d).
 */
export const INFLATION_DRIFT  = INFLATION_DECAY / (1 - INFLATION_DECAY);

// ─── Simulation Tick Rates ─────────────────────────────────────────────────
export const CIV_TICK_RATE       = 40000;  // ticks per civilisation tech advance (~7 real days at 1× to Space Age)
export const WAR_TICK_RATE       = 6000;   // ticks between war phase checks
export const RADIO_TICK_RATE     = 8000;   // min ticks between signals per NPC civ
export const RADIO_DECODE_TICKS  = 400;    // ticks until a garbled signal decodes
export const EVOLUTION_TICK_RATE = 2000;   // ticks between EvolutionEngine steps

// ─── Biology Phase Durations ───────────────────────────────────────────────
export const BIO_PHASE_TICKS: Record<BiologyPhase, number> = {
  microbial:     25000,
  multicellular: 20000,
  complex:       17500,
  primitive:     15000,
  intelligent:   Infinity,
};

// ─── Divine Points ─────────────────────────────────────────────────────────
export const DP_CAP                = 150;   // maximum divine points the player can hold
export const DP_REGEN_INTERVAL_MS  = 8000;  // real-time ms between DP regen ticks
export const DP_REGEN_BASE         = 1;     // DP gained per regen tick at low devotion
export const DP_DEVOTION_THRESHOLD_MID  = 0.4;  // devotion level for +1 extra DP/tick
export const DP_DEVOTION_THRESHOLD_HIGH = 0.7;  // devotion level for +1 more DP/tick

// ─── Gemini / AI ───────────────────────────────────────────────────────────
export const MAX_CALLS_PER_MINUTE      = 20;
export const PLAYER_MESSAGE_DEBOUNCE_MS = 3000;
