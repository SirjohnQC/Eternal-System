# Gas Giants — Design

**Status:** design, not yet planned
**Origin:** the visual companion from 2026-09-08 —
`gas-and-scale-v2.html` and `gas-sky-islands.html` in
`.superpowers/brainstorm/17325-1788911701/content/`. Their open questions were
answered on 2026-09-14 after looking at the current gas giant in the browser.

## The problem

A gas giant has no surface to stand on and no crust to cut. Today it gets one
anyway: rock strata, a silt lip, stalactites and ember lights hanging beneath
it. The root cause is precise — `planetType === 'gas'` swaps the tabletop and
**never gates the crust**, so a gas giant is a striped pancake with a rocky
underside. The rings are drawn coplanar with the tabletop, so they read as a
hoop lying on it rather than a ring system around a body.

Seen in the browser at the real render size, this is the weakest planet type in
the game by a clear margin, and it is wrong at the concept level rather than
the shading level.

A second problem shares the root: **nothing in the renderer knows how big a
planet is.** `planet.radius` reaches only `dayPeriod` and moon sizes, never the
diorama body, so a gas giant and a moon render identically sized.

## Decisions taken

- **Composition: B — atmospheric cutaway.** Gas giants keep the "see inside the
  world" language with the right materials: cloud decks, descending into deep
  cloud, into a hydrogen ocean, into metallic hydrogen, around a small blazing
  core. **Nested shells, not rock strata.** The crust painter is gated off for
  this type entirely.
- **Scale: yes, via a compressive mapping.** Body size derives from
  `planet.radius` through a compressive curve so a gas giant visibly dwarfs a
  rocky world while everything still fits the viewport. The nested shells only
  read as *deep* if the body also reads as *huge*; the two decisions reinforce
  each other.
- **Sky islands: C — sky archipelago.** Dozens of small floaters at varied
  depths within the survivable band between the cloud decks and the crush.
  Dense, busy, navigable — trade routes and airships rather than isolated
  kingdoms. This is what makes a gas giant a place you go rather than a place
  you look at, and it is what the cutaway is *for*.

## Non-goals

- **No change to solid-world composition.** This gates a different path for one
  planet type; the pancake stays the pancake everywhere else.
- **No airship or travel mechanics.** The islands are terrain, not a transport
  system. What they unlock is a separate design.
- **Not the ring system.** Rings need to be occluded by the body rather than
  lying on the tabletop plane, which follows from the composition change, but
  ring *appearance* is out of scope.

## Shape of the work

Three pieces that can land independently, in this order:

1. **Gate the crust and give the body its shells.** `planetType === 'gas'`
   stops calling `paintCutawayCrust` and calls a new nested-shell painter
   instead. This alone removes the stalactites and the rock underside, which is
   the single most wrong thing about the current render.
2. **Compressive scale mapping.** `planet.radius` reaches the diorama geometry
   through a curve. Touches every planet's framing, so it wants its own
   verification pass — a gas giant beside a moon, measured, not eyeballed.
3. **Sky archipelago.** Floating land within the survivable band, placed on a
   spherical shell at constant pressure so islands ring the core rather than
   sitting on a plane. This is where the decal and terrain machinery may be
   reusable — the islands need surfaces, and those surfaces want the same
   biome-driven decals.

## Verification, non-negotiable given this project's history

- **Look at it at 480 virtual pixels**, the size the game actually renders. The
  decal work was calibrated at `rx`=262 for a game that runs at `rx`=105 and the
  error was invisible until someone opened Chrome.
- **Render every planet type after gating the crust**, not just `gas`. The
  gating is a branch on planet type, and this codebase has shipped a gate that
  only ever rendered `ocean` while guarding a bug that appeared on `lava`.
- **Assert the absence of rock under a gas giant**, not just the presence of
  shells. A check that only looks for what should be there will pass while the
  stalactites are still hanging.

## Open questions

- How does a sky island interact with `PlanetGrid`? The grid is a lat/lon field
  for a surface; islands on a pressure shell may need their own representation
  rather than a reuse of it.
- Does a gas giant have a `biologyPhase`? If life can live on sky islands, the
  existing biosphere machinery may apply unchanged — which would be a large
  gain for free, or a large mess, and it should be decided before islands are
  built rather than after.
