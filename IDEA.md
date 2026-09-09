# IDEA — feature wishlist

**Status: all eleven items below are built.** They are tracked as **MILESTONE 22**
in `ROADMAP.md`, where each one records what was actually measured, including the
attempts that were wrong first. Verification tools live in `tools/`.

Keep adding new ideas at the bottom; move them into the roadmap once built.

---

- [x] **Zoom tiers** — zooming in/out steps between Universe / Galaxy / Solar
      System / Planet, with a button to switch between the views. → M22a
- [x] **Universe opening spawns galaxies, not solar systems**, and feels bigger
      and more visual. → M22b
- [x] **DNA points get harder to earn as evolution progresses**, only one thing
      can be evolved at a time, and species type decides where a lineage sits on
      the diorama (reptiles land and sea, big cats savanna, and so on). → M22c
- [x] **Double-clicking the diorama** opens a detailed map of the planet. → M22d
- [x] **Visible mountains** — the diorama terrain is extruded, not flat. → M22e
- [x] **Cloud engine** — storm / acid / pollution / ash / nebula / ice-haze
      clouds driven by real planet state, with matching rain, acid rain, snow and
      ashfall. → M22f
- [x] **Lines of collision** — bigger stars draw in smaller ones and clash,
      creating a supernova that eventually condenses into a new solar system
      running the young-system stages. Chance of life 1% (measured 2.0%, the
      remainder arriving as panspermia). A sufficiently advanced civilisation
      flees and colonises a new planet, which becomes the player's new default
      world. → M22g
- [x] **Evolution lab as a pixel-art pop-up**, after `dna_lab pop-up idea.jpg`.
      → M22h
- [x] **Divine power animations**. → M22j
- [x] **Moons** with different sizes and colours, settled once a civilisation is
      advanced enough. → M22k
- [x] **Codex pop-up** with search and species / vegetation / evolution sections,
      No Man's Sky style. → M22i
- [x] **Clicking a species on the map** gives information about it, divine powers
      aimed at it, and the ability to speak to it. → M22d

---

## New ideas (not yet built)

- [ ] When the pixel art assets are introduced, switch the rolling dice for
      universe generation to a **faith card system** instead — it fits the game
      style better. → tracked as **M24** in `ROADMAP.md`, gated on the art pass.

Raised 2026-09-05, now triaged into `ROADMAP.md`:

- [ ] Vegetation evolves on its own — DNA points buy cellular evolution only. -> M26
- [ ] Evolution Lab should let the player move between species to spend DNA on
      each, not only the primary lineage. -> M26
- [ ] A large asteroid could trigger an ice age and reshape the early planet. -> M26
- [ ] Solar systems should have exoplanets. -> M26
- [x] **Dead stars and dead planets stay visible** — primordial remnants and
      post-supernova/merger corpses (white dwarf / neutron / black hole + husk
      worlds). → M25b
- [ ] A supernova should leave a star-dust cloud that persists for a very long
      time instead of fading immediately. -> M26
- [ ] Reshade planets, suns and stars, and allow a closer zoom, so their scale
      actually reads. -> M26
- [ ] Species, settlements, vegetation and technology (satellites, say) should be
      visible from every view, not only the diorama. -> M26
- [ ] The planet map needs a legend for its colours. -> M26
- [ ] An asteroid striking another system should only notify the player if that
      system has been sighted. -> M26
- [x] Planets / systems too close (collapse into one). -> M25 + M25b spacing
      follow-up (`MIN_STAR_SEPARATION`, inflation snap, denser but still islanded).
	  - add codex in the left rail
	 **Important** updated civilization system framework under CIVILIZATION_SYSTEM.md
	  
- speeding up the game should have a negative effect on earning points and maximum should be 200x 
- ***IMPORTANR*** restructure the UI currently it is very confusing on most part especially the evolution lab which have have two menu and also reshape how we spend points
- A proper species pixal-art builder engine with animations 
- ***IMPORTANT*** rework the UI (check UI_REWORK.md) and (UI_rework.png) the only thing we won't implement or need to brainstorm about is the turn by turn idea
- ***IMPORTANT*** rework of the evolution lab and evolve species , they both should land in the same window. When point or evolution is avalaible the icon could blink. Also make the evolution of the species more meaningfull , right now when we get it we just choose then everytime we get the same window with all the things we already have selected (see Evolution.png)
- Rework of the planet diorama with more pixel art style cloud and default view should be closer so we can observe bette rthe lving planet (adding paning and zooming)
- Rework of the space to look more like pixel art especially planets sun/stars
- galaxy map should look a lot more like no man sky map , same goes for universe while keeping the pixel art
- Having mulitple colonized system should bring a new menu when clicking 'system' which would show up all the planets /system we have 
- event viewer should have his own window seperated from the right rail
- forming galaxies should be bewteen 3 to 8 depending on the rolling dice and faith at the begining
- Add blackholes (futur distant traveling) and asteroid belts
- Galaxies should be slowly twirling and look more liek a galaxy
- Add exo planets that are either star less (can be attraced by one) or have a star
- ***HUGE REWORK*** player should have the ability to draw their own species/vegetal with being guided to do so with pre-fab animation and rigging to the 2d skeleton. Player could also import pre-made species if the player doesn't want to do it. Then this will be the base for the generation of evolution


**Game mechanic**
- Faith card should be more precious, 3 available at all time but we can reroll but it is costly and can get negative cards
- A unique card can be drawn at each important phase

