# Settlements, Farms and Roads — Design

**Status:** implemented 2026-10-04 (`src/rendering/SettlementPlan.ts`,
`src/rendering/SettlementForge.ts`; check: `tools/settlementCheck.ts`;
contact sheet: `tools/settlementForgeRender.ts`)

## Goal
A civilisation should read on its world: towns with streets and a landmark,
farm fields around them, roads between them, and a look that follows its
tech era. This is the base the later factory / technology / transportation
work builds on.

## Model
- **Inputs:** the civ's territory (`cell.civId`), the civ level (era =
  `TECH_LEVELS` index, capped at 6), the intelligent species (aquatic species
  build domes and spires; body plan tints early building materials;
  aggression picks a keep over a church).
- **Towns:** sites chosen greedily by fertility × inland depth, at least
  `max(0.15 rx, 26 px)` apart, `3 + 2 × era` of them (max 13). The best site
  is the capital. Greedy selection plus a per-town random stream seeded by the
  town's position mean a growing territory **adds** towns without moving or
  re-rolling the existing ones.
- **Inside a town:** a main street (and a cross street from the medieval era),
  a landmark fronting the main street in the capital and big towns, building
  lots on a jittered grid, densest at the centre.
- **Fields** ring each town on farmland only (no mountain, tundra, beach;
  desert only from the industrial era). Crops: ripe grain, young green,
  ploughed, second crop, gardens (primitive era).
- **Roads** link towns along a minimum spanning tree, straight with a bend or
  two when the line stays on land, else routed around water by a lattice
  search; towns on other islands stay unlinked. A road over a river is a
  bridge.

## Eras
| Era | Buildings | Landmark | Roads |
|---|---|---|---|
| 0 Primitive | conical huts | big hut | none (gardens only) |
| 1 Ancient | adobe, small houses | ziggurat | dirt |
| 2 Medieval | timber gable houses | keep / church | dirt |
| 3 Industrial | brick rows with chimneys, houses | mill with stack | cobbles |
| 4 Atomic | concrete blocks, towers | tower | asphalt, lane marks |
| 5 Space Age | blocks, glass towers with antennas | spire | asphalt |
| 6+ | white domes and spires | spire | asphalt |

## Rendering
- **Ground marks** (fields, roads, streets) are painted by the surface bake
  per pixel from the world point (`CutawayBakeOpts.groundAt`), so they hold
  still under the camera and gain crop rows, hedges, cobbles and lane marks
  as it closes in. Decals (trees, rocks) keep off them (`decalBlocked`).
- **Buildings** are drawn by SettlementForge straight into pixels in the
  diorama's own view (front wall + foreshortened top/roof, lit from the
  right, quantised ramps, 1-px outline), at the camera scale, with detail by
  scale. They stand on the lifted ground, are drawn after plants and **under
  the night veil** (engine hook `drawProps`), and the whole layer is rendered
  once per view and blitted every frame (Unlimited frame cap).

## Next (not in this pass)
Factories and industry districts, power and technology props, transport
(rail, ports, vehicles, air traffic), settlement growth animation, night
window lights per building.
