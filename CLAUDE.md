# Eternal System — notes for Claude

Procedural god-sim in TypeScript + Vite + PixiJS. Design docs live at the repo root
(`DESIGN.md`, `ARCHITECTURE.md`, `DIORAMA.md`, `ROADMAP.md`, `BUG.md`, ...); `docs/` has specs.

**Design north star: `docs/CORE_LOOP_VISION.md`** (emergence over scripts: world state →
pressures → responses → consequences; the player disturbs conditions, never controls).
Judge new systems against it.

## Setup

```sh
npm install
```

## Dev server

```sh
npx vite --port 5173      # vite.config.ts defaults to port 3000 if --port is omitted
```

- Game: `http://localhost:5173/` (dev shortcut: `?dev=1&planet=Name`; add `&cine=0` to skip the opening cinematic, `&forge=0` to skip the Forge and use the old timed formation)
- Planet diorama preview (dev page, `src/dev/dioramaPreview.ts`):
  `http://localhost:5173/diorama-preview.html?type=…&formation=…`
  - `type` — `ocean | rocky | ice | lava | gas` (default `ocean`)
  - `formation` — `magma | cooling | volcanic | atmosphere | ice_age | primordial`
    (shows the home world mid-formation, no life); pair with `destiny=<type>`
  - other params: `seed`, `year`, `ecc`, `archetype`, `phase`, `civLevel`,
    `pressure`, `oxygen`, `nebula=1`, `fx`, `fxCell`, `storm=<vortex>`, `nations=0` (hide countries)

Chromium is available for screenshots via Playwright (`executablePath: '/opt/pw-browsers/chromium'`).

## Build / typecheck

```sh
npm run build             # tsc && vite build
npx tsc --noEmit          # typecheck only
```

## Test scripts (`tools/`)

```sh
npm test                  # typecheck + seeded invariants (~1 min) — run before every commit; CI enforces it
npm run test:invariants -- --seeds=8 --ticks=200000   # longer local run
npm run test:smoke        # 400k-tick smoke test (~4 min)
npm run test:visual       # diorama screenshots vs goldens (~2 min; see docs/VISUAL_TESTS.md)
```

`tools/invariantCheck.ts` checks per-star rules on every sampled tick across fixed seeds.
Add a rule there for every bug fix or new mechanic; if it reproduces an open issue, flag it
`knownIssue: <n>` so it is reported without blocking CI, and remove the flag once fixed.

Each other `tools/*Check.ts` / `*Render.ts` is a standalone script,
bundled with esbuild and run under Node against a DOM stub. Its header comment gives the
exact command and arguments. General form:

```sh
npx esbuild tools/smokeTest.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/smoke.mjs --log-level=error && node /tmp/smoke.mjs
```

- `smokeTest.ts` — whole-simulation "is everything still working" check; run after any sim change.
- `nationsCheck.ts`, `techCheck.ts`, `faithCardsCheck.ts`, `chronicleCheck.ts` — nations, technology, procedural Faith Cards (discovery, burning, omens vs an untouched twin), the causal Chronicle; `townsCheck.ts` — towns per country (each nation's architecture and era). `polityCheck.ts` — other stars' civilisations as agents, trade between stars. `universeCheck.ts` — the universe's 3×3 sectors (2–5 galaxies each, random home, Entropy lumpiness, charting by tech, the universe map frame). `forgeCheck.ts` — the Forge (Fate Cards forging the home world: deck, determinism, pacing, steering, engine hold until the golden spark). `cinematicCheck.ts` — the Big Bang cinematic (timeline, same universe with or without it, skip/end handoff, camera on home before the black-gap zone). `ecologyCheck.ts` — the living world's ecology (species per world, the food web, extinction pressure, the diorama's hunts and quarrels).
- `*Check.ts` — targeted checks (weather, zoom, formation, settlement, moon, sky, ...);
  exit non-zero on failure. `weatherCheck` and `zoomCheck` want `node --expose-gc`.
- `*Render.ts` — write PNGs for visual review (usually take `<out.png>` as the first arg).
- `zoomBench.ts` drives a running dev server (`--url http://localhost:<port>/diorama-preview.html?...`).
- `*.py` — asset/atlas generation helpers.

## Agents

`.claude/agents/game-designer-artist.md` owns pixel art, procedural bakers and game-design docs.

## Where the docs disagree

Trust order: **code → `ROADMAP.md` (CURRENT STATUS) → `cursor.md` → design docs.**
`ARCHITECTURE.md` is the original plan (Three.js, Web Workers, `src/core/`, …) and does
not describe the built game.

## Architecture rules

Most playtest bugs trace back to one of these being broken. Follow them in new code.

1. **Views render from simulation state; they never own it.** A view may cache a bake,
   but the cache must be keyed on the state it was built from and rebuilt when that
   state changes — never "built once on view entry". Things that only appear after
   leaving and re-entering a view are this rule broken (#8).
2. **Progression is derived in one place:** `src/simulation/Progression.ts`
   (`engine.progressionOf(star)` in views). Stage, phase, era, sub-era and every label
   for them come from it (#9). Don't read `TECH_LEVELS[...]`, `BIO_PHASE_LABELS[...]`,
   `CIV_PHASE_LABELS[...]` or `civLevelToPhase(...)` anywhere else. The player's era
   is what its nations know: move it from outside with `engine.shiftEra(star, to, cause)`,
   never by writing `civLevel` (the engine reconciles the nations every tick).
3. **Never assume the active planet is the homeworld.** Pass the star id and planet
   index explicitly. `isPlayerStar` means "owned by the player", not "being viewed"
   (#16, #17).
4. **The simulation stays deterministic.** All randomness goes through the engine's
   `SeedRNG` (`this.rng.fork(...)`). No `Math.random()`, `Date.now()` or
   `performance.now()` in anything that changes simulation state — frame pacing and
   input timing are fine.
5. **The simulation stays headless-runnable.** No new imports from `src/rendering`,
   `src/ui` or `main.ts` into `src/simulation`, and no new DOM access there.
6. **Creative mode (`gameState.playMode === 'creative'`) uses the same code paths.** It
   may override costs, limits and pace, never skip state updates or gates (#21, #23,
   #24).
7. **State changes keep every related record consistent in the same step.** E.g. a
   world demoted below `intelligent` loses its culture record and tech level together
   (#20). If you change a phase, check what else is keyed on it.
8. **Saves stay loadable.** New `gameState` / `StarBody` fields are optional or
   defaulted on load. Never rename or repurpose a saved field.
9. **Every fix and every new mechanic adds a guard** — preferably a rule in
   `tools/invariantCheck.ts`, otherwise a `tools/*Check.ts`.
10. **Keep `npm test` green.** No `@ts-ignore` / `@ts-expect-error` / `any` to silence
    the compiler. Small PRs, one concern each, issue number in the description.
11. **Performance is per-view.** A view does work proportional to what it shows;
    iterating every star, route or galaxy per frame for one planet's view is a bug (#30).

## Known debt — don't copy these patterns

- `BigBangEngine` imports `rendering/CosmicPixelSprites` and touches the DOM;
  `simulation/PlanetRenderer.ts` (imports `rendering/GasLook`), `BiosphereRenderer.ts`
  and `FactionFlag.ts` draw to canvas. They belong in `src/rendering/`.
- `main.ts` (~6k lines) writes `gameState` directly in ~48 places. New player actions
  go through an engine method, not a field write.
- `BigBangEngine.ts` (~6.7k lines) also handles input and camera. Don't add more
  non-simulation concerns to it.
