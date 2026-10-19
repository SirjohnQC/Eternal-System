# Sprite sources (SpriteCook)

Generated 2026-10-19 with model `gemini-nano-banana-2.1`, pixel mode, 12 credits per sheet. Sliced into strips by `tools/sliceSheet.py`; `<name>.json` lists each frame's rectangle, `tag` (what the game picks by) and `label`.

| Sheet | SpriteCook asset ID | Prompt summary |
|---|---|---|
| huts | `286bc449-5c31-45c8-8440-2c2901eba7c3` | 6 primitive dwellings (round/long thatched, mud-brick, stilt granary, shrine + totem, hide tent); got 9 |
| medieval | `081f0fa0-8694-4c51-93b4-67f26a714296` | timber house, stone cottage, chapel, watchtower, watermill, market hall |
| trees | `3317adc8-26c6-4f20-be11-ed1a5964703e` | 3 broadleaf, 3 conifer, birch, bush |
| volcano (not wired yet) | `7bb229b4-bff3-4086-a94f-997eb0d76127` | dormant / smoking / erupting |

Shared style words: "front-facing, seen from slightly above (front wall visible, roof seen from above, like a classic SNES RPG town), NOT diagonal isometric; light from the right; chunky 16-bit pixel art, 1px dark brown-black outline, 4-5 shade ramps, readable at small size, no ground tiles, no text".

## Species architecture families (Architecture.ts ShapeFamily)

One sheet per family, rows by age (`age0` primitive, `age1` middle, `age2` advanced); the game recolours each to the species' material (`TownStyle.tint`).

| Sheet | SpriteCook asset ID | Rows |
|---|---|---|
| hive | `375af626-cbd7-45d0-aacd-c11ec6b0a5c5` | mud mounds / resin honeycomb towers / glass hive spires |
| dome | `49c4d13d-1408-4028-958c-f73a1ad40d13` | woven + shell domes / nacre domes / glass geodesic |
| pod | `a8cce97a-7e70-4f68-979f-21a1c0c9669b` | jelly bubble pods / pods on stalks / glowing pod towers |
| spire | `f16e9f7d-2718-4a82-a9c7-56bb04001ac7` | bone-and-hide / stone needles / glass sky spires (sliced with tools/sliceBands.py) |
| burrow | `13a5ad44-449d-4be4-bae0-eb0b6b98e937` | earth mounds / terraced burrows / bunkers |
| grown | `ba68065d-654d-461f-a564-37dec576beec` | hollow trees / woven-branch halls / bio-towers |
| carved | `dd78c9fe-5652-4f47-8d86-b11dddfab537` | boulder dwellings / carved facades / monoliths (rock + ice) |

## Modular box kit (era 2–4 box builders)

| Sheet | SpriteCook asset ID | Parts |
|---|---|---|
| kit-walls | `6f9f97f0-e276-4e44-97b1-722f54f86781` | 14 roofless wall bodies |
| kit-roofs | `6c77a2cd-f7d8-4f06-a25b-787bb81702ea` | 8 roofs: 5 gables (house), cone / dome / parapet (landmarks) |
| kit-addons | `1c1828d8-dc8b-4eef-a992-e229769a5fc0` | 12 props: `roof` (chimneys, vane, bell) or `ground` (barrel, crates, banner…) |

Each town draws two walls and two roofs of its own; each house one of those plus a 55% chance of an add-on.
