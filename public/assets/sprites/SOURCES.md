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

## Peoples (walk cycles, People.ts)

One upright people per form (CreatureForge `peopleFormOf`), cut from sheet `7f1c1dd8-f0df-4040-9fa6-8b69b37c2243` with SpriteCook's slicer, each animated (`animate_game_art`, 8 frames, 20 credits) and cropped to one shared box by `tools/peopleSheet.py`. The game recolours each to its species (`creatureTint`). `mechanoid` has no sheet yet (stays procedural).

| Sheet | Still slice | Walk animation asset |
|---|---|---|
| people-humanoid | `feada876-1c70-45da-93fc-66cd69f31cb2` | `6d0ec988-0605-44a3-a4c2-2c68d7bc5e64` |
| people-simian | `f258c707-a137-47fc-9cc1-bbc54717dc18` | `2dfc1103-4391-4809-831c-35850314b374` |
| people-reptilian | `ba5a7fbf-890f-4750-9b14-cd700f577c29` | `00f0e6b9-bde5-43be-8334-273e66375c11` |
| people-avian | `b381e298-4133-486f-a8a3-05bc9720d220` | `8e5387b1-ce0b-440c-bee0-be42f4c4dd08` |
| people-insectoid | `d0b00799-a393-40de-a6dc-e5438cd0793c` | `ec8872fc-e360-4459-955c-e485de4879b0` |
| people-cephaloid | `d9debc49-0201-4032-ac2c-6cfcdaefab12` | `022765af-6769-4923-a889-ff015b8ed78c` |
| people-mycoid | `4380949e-f96a-4702-b2f6-ce7c10a3a0d4` | `eaa72b69-560f-4a32-84aa-57b0a5ca8358` |
| people-crystalline | `c1da7458-1fa7-491d-a5bd-24e4edb24abc` | `fcc65967-1bfa-4dc5-90d7-e76c1fe6aa33` |

Animal test sheet (not wired): `5ddb03aa-d442-428e-8700-5ecbb2e5cc67`.
