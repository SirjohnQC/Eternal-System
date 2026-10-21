/**
 * Who is holding the game speed down, and what to come back to (stage-moments
 * plan, P1). Replaces main.ts's single `_preEventSpeed` slot, which the second
 * of two overlapping modals overwrote with the first one's slowed speed.
 *
 * - A modal *holds* the speed (hold / release, by reason). The speed it found
 *   comes back only when the last hold is released.
 * - A great moment *slows* to ▶ and stays there: if a modal is holding, the
 *   speed it will come back to is lowered too.
 * - The player pressing a speed button clears every hold: their choice wins.
 *
 * Pure: it returns the speeds to set; main.ts applies them.
 */
export class SpeedHold {
  private saved: number | null = null;
  private readonly reasons = new Set<string>();

  get held(): boolean { return this.reasons.size > 0; }

  /** Hold for `reason`; returns the speed to set now. */
  hold(reason: string, current: number, target: number): number {
    if (!this.reasons.size) this.saved = current;
    this.reasons.add(reason);
    return target;
  }

  /** Release `reason`; returns the speed to restore, or null while others still hold. */
  release(reason: string): number | null {
    if (!this.reasons.delete(reason) || this.reasons.size) return null;
    const back = this.saved;
    this.saved = null;
    return back;
  }

  /**
   * A great moment: slow to `pace` if running faster. Returns the speed to
   * set now, or null when nothing changes. A paused game stays paused.
   */
  moment(current: number, pace: number): number | null {
    if (this.saved !== null && this.saved > pace) this.saved = pace;
    return current > pace ? pace : null;
  }

  /** The player chose a speed: every hold is forgotten. */
  clear(): void {
    this.reasons.clear();
    this.saved = null;
  }
}
