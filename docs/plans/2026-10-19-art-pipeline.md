# Art pipeline: SpriteCook sprite sheets alongside the procedural forges

*Plan written 2026-10-18; work starts Monday 2026-10-19. Budget: SpriteCook Adventurer pack, 3,000 credits.*

## Why

Playtest complaints that procedural pixels alone haven't fixed:

- buildings look ugly (#101, #56)
- trees and volcanoes look weak (#49)
- species don't feel endless (#112 helped, but not enough)
- the diorama could be prettier overall
- cards look plain

**No engine change.** PixiJS already handles atlases, tinting and batching. The problem is the art, not the renderer.

## The rule: hand-made where it shows, procedural where it must be endless

| Thing | Today | Plan |
|---|---|---|
| Buildings | `SettlementForge` boxes + roofs | **Sprite sheets** per era and per architecture family; the forge keeps placement (`SettlementPlan`) and becomes the fallback |
| Trees, bushes, rocks | `FloraForge` | **Sprite sheets** per biome (8–12 variants each), tinted by planet type as today; FloraForge stays for exotic worlds |
| Volcanoes | drawn cone | **Sheet**: dormant / smoking / erupting + animated lava loop (#49, #14) |
| Species | `CreatureForge` (3D primitives → pixels, body plans from the genome) | **Stay procedural.** A fixed sheet can't feel unlimited. Use SpriteCook for a **parts library** (heads, horns, tails, wings, shells, patterns) that CreatureForge composes from the genome, plus a hand-made "hero" look per body plan as a style target |
| Cards (Faith + 30 tech) | plain | **UI kit** (frame, back, rarity borders) + one illustration per card |
| Terrain | procedural grid | Optional: biome tilesets via `generate_tileset` later, only if the sprites above make the ground look flat next to them |

## Fitting the game (style lock), done first

Everything must match the diorama's own projection and lighting, or it will look pasted on.

- **View:** front wall facing the camera, top seen from above and squashed (`SQUASH = 0.52` in `SettlementPlan.ts`). This is not a 2:1 isometric diamond.
- **Light:** from the right, same as the land.
- **Shading:** quantised five-step ramps, 1-px dark outline (`CreatureForge` core).
- **Scale:** buildings are a few tiles wide at camera scale S=1; detail appears at higher S. We generate at 2–4× and downscale with nearest-neighbour, keeping one pixel density across all sheets.

Steps:
1. Capture 3–4 diorama screenshots (rocky, ocean, desert, late-era town) from the visual-test previews.
2. Upload them to SpriteCook (`create_asset_upload` → `finalize_asset_upload`).
3. Generate ~6 test pieces using them as `style_asset_ids`. Pick the best and save a **private preset** "Eternal diorama", so every later call shares the same model, palette and references.
4. Put the winners into the preview and judge them in place before mass-producing.

## Budget (~12 credits per image, 3,000 credits ≈ 250 images)

| Batch | Images | Credits |
|---|---|---|
| Style lock + tests | ~15 | ~180 |
| Buildings: 7 eras × ~6 buildings (huts → space), + 2 variants of key ones | ~60 | ~720 |
| Flora: 6 biomes × ~10 | ~60 | ~720 |
| Volcano states + lava animation | ~6 | ~120 |
| Creature parts library + 12 hero body plans | ~40 | ~480 |
| Card UI kit + first 15 card illustrations | ~25 | ~400 |
| **Reserve** (retries, edits) | | ~380 |

The remaining card illustrations go to a second pack or are drawn after we see how the first 15 land.

## Code changes

- **`SpriteAtlas` loader** (generalise `DecalAtlasLoader`): loads `public/assets/sprites/<set>.png` + `.json` frames, returns `null` on failure. Each forge falls back to its procedural drawing when an atlas is missing, so the game never breaks on a missing file.
- **Buildings:** `SettlementForge.paint` asks the atlas for `era/kind/variant` first. Wall tint keeps following `ArchGenome` via a greyscale wall layer + tint.
- **Flora:** same, keyed by biome; hue shift stays (foliage colour from planet type).
- **Creatures:** `CreatureForge` gains a parts layer: genome picks parts by tag and stamps them on the procedural body.
- **Cards:** card component reads frame + art from the card atlas.
- **Assets live in the repo** under `public/assets/sprites/` with a `SOURCES.md` listing each SpriteCook asset ID and prompt (so any piece can be regenerated or edited).
- **Guards:** visual goldens re-captured per batch (checked by eye first); a small `tools/atlasCheck.ts` that every frame named in JSON exists in its PNG.

## Workflow note (cloud vs local)

SpriteCook's MCP works from the cloud session (custom connector `https://mcp.spritecook.ai/mcp/claude`), but the cloud workspace can't download from `api.spritecook.ai`. Two options:

- **Local (preferred for batches):** Claude Code or the desktop app on the PC with the SpriteCook plugin, so files land in `public/assets/sprites/` directly.
- **Cloud:** generate there, then run `tools/fetch-sprites` locally (a small script that downloads by asset ID from `SOURCES.md`).

## Monday order

1. Buy the pack; check credits (`get_credit_balance`).
2. Style lock: screenshots → upload → 6 tests → preset.
3. First real batch: **early-era buildings (huts, era 0–1) + temperate trees.** These are the most visible pieces in a new game.
4. `SpriteAtlas` loader + building and flora hookup with fallback; judge in the diorama preview.
5. If it looks right, continue down the budget table.

Test assets already made (2026-10-18): a cat creature (`27c9364c-…`) and a primitive village (`ed5a7d14-…`). Treat them as references only; they were made before the style lock.
