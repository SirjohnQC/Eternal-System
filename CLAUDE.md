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

- Game: `http://localhost:5173/` (dev shortcut: `?dev=1&planet=Name`; add `&cine=0` to skip the opening cinematic)
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

There is no `npm test`. Each `tools/*Check.ts` / `*Render.ts` is a standalone script,
bundled with esbuild and run under Node against a DOM stub. Its header comment gives the
exact command and arguments. General form:

```sh
npx esbuild tools/smokeTest.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/smoke.mjs --log-level=error && node /tmp/smoke.mjs
```

- `smokeTest.ts` — whole-simulation "is everything still working" check; run after any sim change.
- `nationsCheck.ts`, `techCheck.ts`, `faithCardsCheck.ts`, `chronicleCheck.ts` — nations, technology, procedural Faith Cards (discovery, burning, omens vs an untouched twin), the causal Chronicle; `townsCheck.ts` — towns per country (each nation's architecture and era). `polityCheck.ts` — other stars' civilisations as agents, trade between stars. `cinematicCheck.ts` — the Big Bang cinematic (timeline, same universe with or without it, skip/end handoff, camera on home before the black-gap zone).
- `*Check.ts` — targeted checks (weather, zoom, formation, settlement, moon, sky, ...);
  exit non-zero on failure. `weatherCheck` and `zoomCheck` want `node --expose-gc`.
- `*Render.ts` — write PNGs for visual review (usually take `<out.png>` as the first arg).
- `zoomBench.ts` drives a running dev server (`--url http://localhost:<port>/diorama-preview.html?...`).
- `*.py` — asset/atlas generation helpers.

## Agents

`.claude/agents/game-designer-artist.md` owns pixel art, procedural bakers and game-design docs.
