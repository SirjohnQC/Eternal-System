# Open bugs

None outstanding.

## Fixed

- **Primary species stuck on `primitive` regardless of DNA spending**
  (fixed 2026-09-04, see ROADMAP M20d).
  `LifeSystem.filterChance()` multiplied five penalties and clamped at 1.0, so a
  world could reach a genuinely absorbing state — 0 advances in 100,000 rolls at
  maximum player assistance. DNA points also never fed the filter at all.
  Fix: `MAX_FILTER_CHANCE`, `PLAYER_STALL_TIME_CAP`, and
  `BigBangEngine.playerBioAssistance()`. Guarded by `tools/smokeTest.ts` and
  measured by `tools/phaseProgressCheck.ts`.
