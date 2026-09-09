# Open bugs

Reported 2026-09-05. Spacing/collapse fixed as **M25**; denser census + remnants
+ high-refresh pacing as **M25b** (2026-09-06).

- **Evolving species get stuck on the same pattern.**
- **Home-world view not in sync with the planet view.**
- Player needs to name their planet before rolling the dice, also we should have a random button for naming and remove the auto corrector
- Galaxy  are always spreading in the same pattern but it should be random, plus there should be more randomness in home world system assign, right now it is always showing up in the same type of galaxy
- Warning message that asteroid will struck and to spend 25 dp to smite it  but we don't have any power to do so
- Civilization show Primordial Ocean but I think this should be the planet phase and not Civilization
- Planet diorama doesnt reflect planet phase  
- Event should only comes from within our solar system or sighted system unless civ is advanced enough to have telescope


## Fixed

- **Systems too sparse / dead stars missing / 240Hz made 1× too fast**
  (fixed 2026-09-06, M25b). Census `18 + life×2.1` (~20–60), morph-weighted
  galaxy shares, primordial + post-event remnants with husk planets, wall-clock
  pacing + Settings frame-rate cap, Pixi cull/LOD. Guards:
  `tools/remnantCensusCheck.ts`, `tools/framePacingCheck.ts`,
  `tools/cosmicSpacingCheck.ts`.

- **Solar systems overlapping again / orrery years too fast at 1×**
  (fixed 2026-09-06, M25 follow-up). Inflation no longer collapses spaced
  targets; `MIN_STAR_SEPARATION = 360`; `PLANET_ORBIT_MU` slowed. Guard:
  `tools/cosmicSpacingCheck.ts`.

- **Planets and galaxies collapsing into one solar system / playerProgressCheck
  3/12** (fixed 2026-09-05, M25). Stars were packed and drifted into merger
  cascades that reset the home world to magma. Fix: `MIN_STAR_SEPARATION` at
  placement, weaker/shorter-range gravity, more damping. Measured 7/12 advanced,
  catastrophes 87 → 34. `COLLISION_SUPERNOVA_MASS` unchanged — collisions still
  fire. Guarded by `tools/playerProgressCheck.ts` (supports `off`/`both` control).

- **Primary species stuck on `primitive` regardless of DNA spending**
  (fixed 2026-09-04, see ROADMAP M20d).
  `LifeSystem.filterChance()` multiplied five penalties and clamped at 1.0, so a
  world could reach a genuinely absorbing state — 0 advances in 100,000 rolls at
  maximum player assistance. DNA points also never fed the filter at all.
  Fix: `MAX_FILTER_CHANCE`, `PLAYER_STALL_TIME_CAP`, and
  `BigBangEngine.playerBioAssistance()`. Guarded by `tools/smokeTest.ts` and
  measured by `tools/phaseProgressCheck.ts`.
