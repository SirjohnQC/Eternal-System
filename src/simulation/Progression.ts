/**
 * Progression, derived in one place (#9, CLAUDE.md rule 2).
 *
 * A world's progression is one ladder: it forms, life wakes and climbs the
 * biology phases, and an intelligent people climbs the eras. Every view that
 * names where a world stands (the bottom bar, the planet panel, the Codex,
 * the old planet renderer, the engine's own news) reads it from here, so
 * they cannot disagree. The tables in GameState (TECH_LEVELS, BIO_PHASE_LABELS,
 * CIV_PHASE_LABELS, civLevelToPhase) are only read through this module.
 *
 * The era itself is `star.civLevel`; for the player's world the engine keeps
 * it equal to what its nations know (BigBangEngine.reconcilePlayerEra), and
 * other stars' polities reconcile themselves to it (StarPolities). The
 * sub-era (Early / Middle / Late) comes from what they know of that era.
 *
 * Pure: no engine, no DOM.
 */
import {
  BIO_PHASE_LABELS, BIO_PHASE_SEQUENCE, CIV_PHASE_LABELS, TECH_LEVELS, civLevelToPhase,
  type BiologyPhase, type CivPhase,
} from './GameState';
import { SUB_ERA_NAMES } from './Technology';

/** Where on the ladder a world stands. */
export type ProgressionStage = 'forming' | 'lifeless' | 'life' | 'civilization';

/** The formation stages' names, everywhere they are shown. */
export const FORMATION_STAGE_LABELS: Record<string, string> = {
  magma: 'Magma Ocean',
  cooling: 'Cooling Crust',
  volcanic: 'Volcanic Era',
  atmosphere: 'First Air',
  ice_age: 'Ice Age',
  primordial: 'Primordial Sea',
};

/** The highest era index. */
export const TOP_ERA = TECH_LEVELS.length - 1;

/** What progression reads off a star (a StarBody fits). */
export interface ProgressionSource {
  formationStage?: string | null;
  hasLife: boolean;
  biologyPhase: BiologyPhase;
  civLevel: number;
}

export interface ProgressionContext {
  /** 0 Early, 1 Middle, 2 Late within the era (engine.civSubOf). */
  sub?: number;
  /** The Forge is drafting this world: its DNA is not decided yet. */
  forging?: boolean;
}

export interface Progression {
  stage: ProgressionStage;
  /** Set while forming. */
  formationStage: string | null;
  /** Set once life has woken (it stays 'intelligent' through the eras). */
  bioPhase: BiologyPhase | null;
  /** 0..4 along BIO_PHASE_SEQUENCE; -1 before life. */
  bioIndex: number;
  /** 0..TOP_ERA; 0 before a civilisation. */
  era: number;
  /** 0 Early, 1 Middle, 2 Late. */
  sub: number;
  civPhase: CivPhase | null;
  /** "Late Medieval", "Early Space Age"; "Primitive" before the first age. */
  eraName: string;
  /** The world's headline: "Ice Age", "Complex Life", "Industrial Civilisation", "No Life Detected". */
  phaseLabel: string;
  /** The headline with the era: "Industrial Civilisation — Late Atomic". */
  fullLabel: string;
  /** 0..1 along the stage's own ladder (biology phases, or eras), for bars. */
  fraction: number;
  /**
   * Whether the world's own DNA (climate, oceans, chaos) is settled enough to
   * show (#18): not while it is still a magma ocean, nor while the Forge is
   * drafting it.
   */
  worldDnaKnown: boolean;
}

/** "Late Medieval"; the first age has no sub-era ("Primitive"). */
export function eraLabel(era: number, sub = 0): string {
  const e = Math.max(0, Math.min(TOP_ERA, Math.round(era)));
  const name = TECH_LEVELS[e] ?? 'Primitive';
  return e < 1 ? name : `${SUB_ERA_NAMES[Math.max(0, Math.min(2, sub))]} ${name}`;
}

/** "Medieval" (no sub-era): what an era is called on its own. */
export function eraTitle(era: number): string {
  return TECH_LEVELS[Math.max(0, Math.min(TOP_ERA, Math.round(era)))] ?? 'Primitive';
}

/** Every era's name, in order (the tech track, the Creative era picker). */
export const ERA_TITLES: readonly string[] = TECH_LEVELS;

/** "the Medieval age", "the Space Age". */
export function ageName(era: number): string {
  const l = eraTitle(era);
  return /Age$/.test(l) ? l : `${l} age`;
}

export function bioPhaseLabel(phase: BiologyPhase): string {
  return BIO_PHASE_LABELS[phase] ?? phase;
}

export function formationStageLabel(stage: string): string {
  return FORMATION_STAGE_LABELS[stage] ?? stage;
}

/** The civilisation phase an era belongs to, and its name. */
export function civPhaseOf(era: number): { phase: CivPhase; label: string } {
  const phase = civLevelToPhase(era);
  return { phase, label: CIV_PHASE_LABELS[phase] };
}

/** Where a world stands, and everything shown about it. */
export function progressionOf(star: ProgressionSource, ctx: ProgressionContext = {}): Progression {
  const forming = !!star.formationStage;
  const dnaKnown = !ctx.forging && star.formationStage !== 'magma';
  if (forming) {
    const label = formationStageLabel(star.formationStage!);
    return {
      stage: 'forming', formationStage: star.formationStage!, bioPhase: null, bioIndex: -1, era: 0, sub: 0, civPhase: null,
      eraName: eraTitle(0), phaseLabel: label, fullLabel: label, fraction: 0, worldDnaKnown: dnaKnown,
    };
  }
  if (!star.hasLife) {
    return {
      stage: 'lifeless', formationStage: null, bioPhase: null, bioIndex: -1, era: 0, sub: 0, civPhase: null,
      eraName: eraTitle(0), phaseLabel: 'No Life Detected', fullLabel: 'No Life Detected', fraction: 0, worldDnaKnown: dnaKnown,
    };
  }
  const bioIndex = Math.max(0, BIO_PHASE_SEQUENCE.indexOf(star.biologyPhase));
  if (star.biologyPhase !== 'intelligent') {
    const label = bioPhaseLabel(star.biologyPhase);
    return {
      stage: 'life', formationStage: null, bioPhase: star.biologyPhase, bioIndex, era: 0, sub: 0, civPhase: null,
      eraName: eraTitle(0), phaseLabel: label, fullLabel: label,
      fraction: (bioIndex + 1) / BIO_PHASE_SEQUENCE.length, worldDnaKnown: dnaKnown,
    };
  }
  const era = Math.max(0, Math.min(TOP_ERA, star.civLevel));
  const sub = era < 1 ? 0 : Math.max(0, Math.min(2, ctx.sub ?? 0));
  const { phase, label } = civPhaseOf(era);
  const eraName = eraLabel(era, sub);
  return {
    stage: 'civilization', formationStage: null, bioPhase: 'intelligent', bioIndex, era, sub, civPhase: phase,
    eraName, phaseLabel: label, fullLabel: `${label} — ${eraName}`,
    fraction: (era + 1) / (TOP_ERA + 1), worldDnaKnown: dnaKnown,
  };
}
