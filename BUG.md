# Open bugs

Reported 2026-09-05. All three are tracked as **M25** in `ROADMAP.md`.

- **Planets and galaxies are way too close — they all end up collapsing into
  the same solar system.** Same root cause as the one failing check in the
  suite: `playerProgressCheck` sits at 3/12 because colliding stars keep
  resetting worlds to magma before biology can climb. Fix belongs in
  cosmology spacing, NOT in `LifeSystem.ts`.
- **Evolving species get stuck on the same pattern.**
- **Home-world view not in sync with the planet view.**


## Fixed

- **Primary species stuck on `primitive` regardless of DNA spending**
  (fixed 2026-09-04, see ROADMAP M20d).
  `LifeSystem.filterChance()` multiplied five penalties and clamped at 1.0, so a
  world could reach a genuinely absorbing state — 0 advances in 100,000 rolls at
  maximum player assistance. DNA points also never fed the filter at all.
  Fix: `MAX_FILTER_CHANCE`, `PLAYER_STALL_TIME_CAP`, and
  `BigBangEngine.playerBioAssistance()`. Guarded by `tools/smokeTest.ts` and
  measured by `tools/phaseProgressCheck.ts`.
