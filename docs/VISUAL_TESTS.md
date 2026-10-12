# Visual regression tests

`npm run test:visual` renders seeded scenes of the planet diorama in headless
Chromium and compares each with a golden PNG in `tools/visual/goldens/`.
It runs on every PR (`.github/workflows/visual.yml`).

## When it fails

1. Open the failed run → **Artifacts → visual-diffs**. For each failing scene
   there is `<scene>.actual.png` and `<scene>.diff.png` (the golden dimmed,
   changed 8×8 blocks in red).
2. If the change is a bug, fix it.
3. If the change is intended (new art, tuned colours), re-capture the goldens:
   GitHub → **Actions → Visual → Run workflow**, pick your branch, keep
   "Re-capture" ticked. The workflow commits the new goldens to the branch —
   look at them in the PR's "Files changed" (GitHub shows image diffs) before
   merging.

## Why goldens come from CI

The goldens are captured by CI's Linux Chromium with software WebGL
(SwiftShader). A machine with a real GPU draws slightly different pixels, so
goldens captured on your PC would fail in CI. You can still run the check
locally to see what changed (`npm run test:visual`; `npx playwright install
chromium` once), but commit goldens only from the workflow.

## How it stays deterministic

- `Math.random` is seeded; Playwright's fake clock is paused during load and
  then advanced exactly 8 simulated seconds.
- `performance.now()` and animation frames are derived from that fake clock —
  otherwise each run starts 1–2 ms apart and dt-stepped state (weather) drifts.
- Each scene is loaded once to warm up before the capture.
- Only the game canvas (`#stage`) is captured: no fonts, no FPS counter.
- Comparison is per 8×8 block (changed when >20% of its pixels differ by >24),
  failing a scene above 2 changed blocks. Repeated runs change 0 blocks.

## Adding a scene

Add an entry to `SCENES` in `tools/visual/visualCheck.mjs` (any
`diorama-preview.html` parameters — see CLAUDE.md), then run the workflow to
capture its golden. Good candidates: a scene reproducing a fixed visual bug.
