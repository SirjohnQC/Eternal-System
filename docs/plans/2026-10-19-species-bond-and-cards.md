# Your species: bond, cards that change their world, rigged peoples

*Design for review, 2026-10-19. From the playtest of the same day: "everything
that touches your species, from the evolution to the UI, feels out of touch.
You are supposed to bond with your planet and every species; right now it just
feels like you are giving it a name. And the cards should feel like you are
changing the world for your species."*

Judged against `docs/CORE_LOOP_VISION.md`: the player disturbs conditions and
never controls; consequences are shown, labels hidden; the payoff is *"I caused
this."* Nothing here breaks that. It is about **showing** the loop that already
exists, on the one species the player cares about.

## What is missing today

| The player does | The game shows | What is lost |
|---|---|---|
| Plays a card (rain, ice age, murrain, quickened minds…) | A toast; the land changes on the next bake; nation stats move | No moment of casting, no link from the card to what the people did about it |
| Evolves | A stat sheet (`INTELLECT 7/10`…), a mutation tree priced in DNA | Choices read as shopping, not as helping a people survive *their* world |
| Looks at their species | A name, a portrait in the lab, a codex entry | No sense of who they are, what they face, or what shaped them |
| Watches the diorama | Little figures wandering | The people never visibly *do* anything: farm, flee, fight, pray |

The simulation already has the substance: pressures per nation, divine works
that change the grid, a causal Chronicle with links back to casts, species
forms over time (`gameState.speciesForms`), spontaneous "gift" mutations. The
gap is presentation and a few connections.

## The principle

**Bond comes from cause → visible change → your people answer, over time.**
Every pillar below closes that loop on the player's own species, with the
consequence shown as something seen, not a label (vision §3).

## Pillar A — "Your People" (one panel)

Replaces the scattered species views as the main entry (tracker #38 asks for a
species panel with its own rail icon).

- **Their portrait, alive:** the walking people (rigged, pillar E), doing what
  most of them are doing right now (working the fields, sheltering, at war,
  at prayer).
- **What presses on them, as symptoms:** "the young go hungry in the north",
  "they huddle against the cold", "something hunts them at the shore". Read
  from nation pressures and ecology; never "FAMINE 0.7".
- **What they believe about you:** from faith and the casts they lived
  through ("they remember the long rain as a mercy").
- **Their lineage** (pillar B) as a strip of portraits.
- One line on where they are going: the pressure most likely to shape the
  next form.

## Pillar B — A lineage you can read

Each past form in `speciesForms` gets its portrait and **the one thing that
shaped it**, taken from the Chronicle's cause links: "Form III: the long winter
(your ice age) made them shaggy and slow." Clicking a form opens its causes in
the Chronicle. This is vision §15 ("I caused this 800 years ago") made
personal.

## Pillar C — Evolution answers the world

The Evolution Lab stays, but its frame changes (tracker #35, #36, #37):

- **Pressures beside the tree:** the lab opens on what the people face; the
  mutations that answer a present pressure glow and cost less DNA (fur in the
  cold, gills when the seas rise). Others still cost full price: the player
  may go against the world, it is just harder.
- **Gifts explained:** a spontaneous mutation says what brought it ("the
  drought favoured those who drank less").
- **The reveal (#36):** the next form stays a silhouette until EVOLVE, then is
  unveiled with its first steps (rig), and the lineage strip grows.
- Stats as words, not `/10`: "clever", "wary of strangers", "quick to anger".

## Pillar D — Cards change the world *for your species*

Cards keep their anatomy (action, target, condition, magnitude, side effects,
odds). What changes is how they land:

1. **Before:** hovering a card ghosts its reach on the diorama (where the rain
   will fall, how far the ice will creep, which herd it touches).
2. **The cast:** an in-world moment (clouds gathering and the rain line
   sweeping; frost creeping across the tiles; a comet's streak), then the land
   is changed under it. The grid change already happens (`DivineWorks.ts`);
   this adds the spectacle.
3. **The answer:** a **consequence beat** one to three generations later, tied
   to the cast through the Chronicle: "The Velari have moved their villages to
   the new river," pinned where it happened, with the people seen doing it
   (rig actions). Unforeseen outcomes count most (vision §13: the player
   should sometimes regret a success).
4. **Their words:** card text speaks of the people by name ("Your Velari
   will…"), and life cards (hardiness, quickened minds, mutation) show on the
   portrait at once.
5. **Card art** (later, SpriteCook): one illustration per card kind, framed in
   the species' colours.

## Pillar E — Rigged peoples that do things

The SpriteCook walk cycles barely move (a pixel of leg, the rest pasted) and
the UI draws a shadow glued under them. Agreed with the owner: rigging needs
its own tool.

**Art:** for each people form, one SpriteCook sheet of separate parts: head,
torso, upper arm ×2, forearm with hand ×2, thigh ×2, shin with foot ×2, tail
(if any), held tool. About 8 sheets, ~96 credits.

**The tool:** a dev page, `rig-editor.html` (`src/dev/rigEditor.ts`):

- load a parts sheet; parts are found by connected alpha and named by a
  template (biped, biped-with-tail, four-armed);
- joint pivots guessed (top centre of a limb, neck at the torso's top, hip at
  its bottom), then dragged to correct;
- draw order and near/far limbs (far limbs darker), mirrored where a form is
  symmetric;
- live preview of every action with speed and swing sliders;
- saves `public/assets/sprites/people-<form>.rig.json` (parts, pivots,
  order, per-action tweaks).

**Runtime:** `RigPlayer` (pure, `src/rendering/`) poses the parts per frame:
each bone a rotation about its pivot, drawn at 2× and reduced so rotated pixel
art stays crisp, cached per (form, action, frame, size, tint). Actions:
**idle, walk, work** (hoe, hammer), **carry, fight, flee, pray, celebrate**,
chosen from the simulation (a nation at war fights, a hungry one forages, a
pious one prays after a cast). A soft ground shadow is drawn separately and
stays on the ground while the body bobs.

**Variety bonus:** the forms share joint conventions, so parts can mix (a bird
head on a lizard body, four insect arms on a humanoid) under the look genes:
peoples become as varied as the creatures.

## Phases

| Phase | What | Cost |
|---|---|---|
| **P1** | Your People panel (portrait, symptoms, beliefs, lineage strip); species-aware card text; consequence beats from the Chronicle | code only |
| **P2** | Evolution answers the world: pressures in the lab, cheaper answering mutations, explained gifts, the reveal | code only |
| **P3** | Rig tool, parts sheets, RigPlayer, actions driven by the simulation, ground shadow | ~96 credits + code |
| **P4** | Card previews and cast moments in the diorama; card art | art budget to decide |

P1 is the biggest felt change for the least work: it connects pieces that
already exist.

## Questions for Sirjohn

1. **Panel:** should "Your People" replace the Evolution Lab as the species
   entry (the lab opening from it), or sit beside it on the rail?
2. **How explicit the answer is:** consequence beats are symptoms with a link
   to the cast ("they moved to the new river"), never "your card caused X".
   Is that the right line, or should the link to your card be spelled out?
3. **Discount for answering mutations:** should mutations that answer a
   present pressure be cheaper (a gentle nudge), or only highlighted?
4. **Art budget:** card art for 35 kinds is ~420 credits at one per image
   (less with sheets of three); after the rig (~96) about 270 remain. Card art
   now, or after the next pack?
