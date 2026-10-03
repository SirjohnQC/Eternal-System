# ETERNAL SYSTEM — COMPLETE UI/UX REWORK

You are working on my game "Eternal System".

Eternal System is a simulation/strategy game where the player is an AI god observing and influencing a simulated universe. The player does not directly control civilizations. Instead, they manipulate the universe through divine powers, evolution, discoveries, interventions, etc.

The current UI is functional, but visually it feels too much like a conventional sci-fi dashboard. I want to completely rethink the presentation while preserving the existing game functionality and data.

IMPORTANT:

DO NOT rewrite the game logic unless absolutely necessary.

DO NOT remove existing functionality.

DO NOT replace working systems with fake/demo data.

DO NOT create a completely different game.

This is primarily a UI/UX and visual architecture rework.

Before modifying anything:

1. Inspect the existing project structure.
2. Identify the current UI components.
3. Identify where game state comes from.
4. Identify reusable components.
5. Identify which UI elements are currently responsible for:
   - Divine Powers
   - Evolution
   - System/planet information
   - Faith
   - DNA
   - Time/simulation speed
   - Events
   - AI/player information
   - Camera/view controls
   - End Turn
6. Understand how the current UI communicates with the game state.

Then implement the redesign incrementally.

==================================================
1. NEW VISUAL DIRECTION
==================================================

The new visual identity should be:

PIXEL ART + COSMIC SIMULATION + ANCIENT/ALIEN COMPUTER

Think:

- classic pixel-art strategy games
- late 80s / early 90s computer interfaces
- CRT terminals
- cosmic horror
- old observatory instruments
- alien civilization technology
- minimalist sci-fi
- cosmic simulation software
- an ancient machine designed to observe universes

The game should feel like the player is operating a mysterious machine capable of simulating an entire universe.

The UI should NOT look like:

- a modern SaaS dashboard
- a mobile app
- a generic cyberpunk HUD
- Star Citizen
- overly glossy sci-fi
- excessive glassmorphism
- huge rounded cards
- modern gradients everywhere

The UI should feel deliberate, restrained and slightly mysterious.

==================================================
2. PIXEL ART STYLE
==================================================

The game was originally intended to be pixel-art oriented because this makes it easier to create and replace assets.

Make this a core design principle.

Visual characteristics:

- crisp pixel edges
- limited color palette
- pixel-art icons
- pixel-art celestial bodies
- pixel-art planets
- pixel-art symbols
- pixel-art UI decorations
- subtle CRT-like imperfections where appropriate
- no unnecessary anti-aliased decorative artwork
- avoid overly detailed assets

Use a relatively small palette:

PRIMARY:
- almost black / deep space navy
- dark purple
- muted violet
- warm gold
- pale yellow

SECONDARY:
- teal/cyan
- muted green
- muted red/orange

The colors should communicate meaning.

For example:

GOLD:
Divine / important / cosmic authority

PURPLE:
Evolution / consciousness / mystery

GREEN:
Life / biosphere / biological systems

CYAN:
Technology / information / DNA

RED/ORANGE:
Danger / destruction / meteor / catastrophic events

Do not use every color everywhere.

Color should have semantic meaning.

==================================================
3. MAIN DESIGN PRINCIPLE
==================================================

The universe should be the STAR of the interface.

The current UI gives too much visual weight to the side panels.

The central universe view should occupy approximately 70–80% of the screen.

Everything else should feel like an instrument surrounding the universe.

The hierarchy should be:

1. Universe
2. Faith / divine actions
3. Current world/system information
4. Events
5. Secondary navigation
6. Detailed information

The player should immediately understand:

"I am looking at a living universe."

==================================================
4. NEW SCREEN STRUCTURE
==================================================

Use this general layout:

 ---------------------------------------------------------
| TOP BAR                                                  |
| Logo     Simulation Speed        Resources      Menu     |
 ---------------------------------------------------------
|         |                                      |         |
|         |                                      |         |
|  NAV    |                                      | EVENTS  |
|  RAIL   |           UNIVERSE VIEW              | / LOG   |
|         |                                      |         |
|         |                                      |         |
|         |                                      |         |
|         |                                      |         |
|         |                                      |         |
|         |                                      |         |
|         |                                      |         |
 ---------------------------------------------------------
|             FAITH / DIVINE ACTIONS                       |
 ---------------------------------------------------------
| WORLD STATUS / DNA / PHASE / VIEW / END TURN             |
 ---------------------------------------------------------

However:

Do NOT blindly reproduce this exact layout.

Use it as the conceptual structure.

The universe must visually dominate.

==================================================
5. TOP BAR
==================================================

Simplify the current top bar.

It should contain only information that is constantly useful.

LEFT:

ETERNAL SYSTEM

Under it, optionally:

ASCEND. INFLUENCE. TRANSCEND.

Keep the title small and elegant.

CENTER:

Simulation speed controls.

Example:

||   1x   10x   50x   200x   1000x

The currently selected speed should have a subtle pixel-art highlight.

Do NOT make the speed controls huge.

RIGHT:

DNA
TP / Faith resource
possibly a notification indicator
settings/menu

Avoid clutter.

==================================================
6. LEFT NAVIGATION
==================================================

Replace the current large left-side panels with a narrow vertical navigation rail.

The left rail should be approximately 60–80px wide.

Use icon + very small label.

Possible sections:

✦ GOD
DNA symbol EVOLVE
◎ SYSTEM

Potential future:

◇ CIVILIZATIONS
☄ EVENTS
✧ CODEX

The navigation rail should be visually quiet.

When the player selects an item, the corresponding panel should open as an overlay, drawer, or contextual panel rather than permanently consuming screen space.

Example:

[✦]
GOD

[DNA]
EVOLVE

[◎]
SYSTEM

The selected item receives a subtle glow/border.

This gives the game much more room for the universe.

==================================================
7. UNIVERSE VIEW
==================================================

This is the most important part of the UI.

The central canvas should feel almost like a digital star map.

The universe should have:

- stars
- subtle nebulae
- orbital paths
- planets
- suns
- small pixel particles
- selection indicators
- subtle movement

Do not overdecorate it.

The emptiness of space is important.

The player should feel scale.

Use pixel-art representations for planets and stars where possible.

For example:

A sun should not simply be a CSS circle.

It should eventually be replaceable by a small animated pixel-art sprite.

Planets should have:

- pixel texture
- tiny atmosphere effects
- optional rings
- small orbit indicator

Selected planets can have:

- animated pixel ring
- small brackets
- subtle pulse
- information marker

==================================================
8. CAMERA / VIEW CONTROLS
==================================================

Current views:

UNIVERSE
GALAXY
SYSTEM
PLANET

Keep this functionality.

However, redesign the controls so they feel like a small navigation instrument rather than generic buttons.

Example:

VIEW

[✦ UNIVERSE] [◉ GALAXY] [◎ SYSTEM] [● PLANET]

The currently selected view should be obvious.

Do not allow these controls to dominate the bottom bar.

==================================================
9. FAITH SYSTEM — MAJOR CHANGE
==================================================

This is one of the biggest changes.

The Divine Powers / Faith actions should NOT permanently occupy the entire left side.

Move them into a prominent horizontal "FAITH" deck at the bottom-center of the universe.

This should be one of the primary visual elements.

Think:

TACTICAL CARD HAND
+
COSMIC RELIGIOUS ARTIFACT
+
PIXEL ART

Example:

                     ✦ FAITH ✦

   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │  EYE    │ │  LIFE   │ │   DNA   │
   │         │ │         │ │         │
   │ DIVINE  │ │ BLESS   │ │ NUDGE   │
   │ SIGHT   │ │ HARVEST │ │EVOLUTION│
   │         │ │         │ │         │
   │ 20 DP   │ │  5 DP   │ │ 10 DP   │
   └─────────┘ └─────────┘ └─────────┘

   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ PROPHET │ │ REVEAL  │ │ METEOR  │
   └─────────┘ └─────────┘ └─────────┘

The deck can become horizontally scrollable if more powers are added.

IMPORTANT:

Do not make the cards enormous.

They should feel like "abilities" rather than trading cards.

Each card should have:

- pixel-art icon
- title
- one-line description
- cost
- state

Possible states:

AVAILABLE
LOCKED
INSUFFICIENT FAITH
COOLDOWN
SELECTED

Use color sparingly.

For example:

Gold = divine

Green = life

Purple = evolution

Red = destructive

Cards should have a pixel-art border.

Avoid giant rounded rectangles.

==================================================
10. FAITH DECK INTERACTION
==================================================

When hovering over a Faith ability:

- slightly brighten
- show pixel-art highlight
- show tooltip/details
- possibly animate the icon

When selected:

- card becomes visually "armed"
- cursor/targeting mode begins
- universe shows valid targets

Example:

SELECT DIVINE SIGHT

↓

The universe highlights unexplored regions.

SELECT METEOR

↓

Potential target planets glow red/orange.

This interaction should make the player feel like they are actually wielding a divine power.

==================================================
11. RIGHT EVENT / NARRATIVE PANEL
==================================================

The current right-side panel is useful but takes too much permanent space.

Keep the concept of:

NYX THE VAST

and the event log.

But redesign it into a compact narrative console.

The right panel should be approximately 250–320px wide.

It should feel like a cosmic intelligence reporting events.

Example:

NYX THE VAST
────────────────

[12:42]

THE FAITHFUL OF HUNHUN
CRY OUT IN WONDER.

[12:43]

A PROPHET WALKS AMONG
HUNHUN.

[12:44]

DIVINE SIGHT CAST EAST.

...

Make the event feed compact.

Events should be visually separated by time / category rather than huge boxes.

Use subtle vertical markers.

Potential event colors:

gold = divine
green = life
purple = evolution
red = catastrophe
cyan = discovery

At the bottom:

[ SPEAK TO THE GOD... ] [SEND]

This should remain.

The AI conversation is an important part of the game's identity.

==================================================
12. EVENT PANEL COLLAPSING
==================================================

The right panel should be collapsible.

When collapsed:

The universe gains almost the entire width.

Show a small indicator:

[EVENTS 7]

or

[✦ 7]

Clicking expands the narrative panel.

This should be implemented cleanly in the UI architecture.

Do not reload the game state when opening/closing it.

==================================================
13. BOTTOM STATUS BAR
==================================================

Create a very compact status bar below the Faith deck.

It should contain:

WORLD

TERRA NOVA

AGE

2.2M YRS

LIFE

DETECTED

PHASE

EARLY CIVILIZATION

DNA

6 / 100

VIEW

UNIVERSE / GALAXY / SYSTEM / PLANET

END TURN

The status bar should feel like instrumentation.

Use typography and dividers rather than large cards.

==================================================
14. END TURN
==================================================

The End Turn button should remain visually important.

However, it should feel like a command terminal rather than a giant modern button.

Example:

┌─────────────────────────────┐
│ END TURN                    │
│ PROCEED TO NEXT PHASE    →  │
└─────────────────────────────┘

Use gold.

It should be one of the strongest UI elements but not overwhelm the universe.

When hovering:

- subtle illumination
- arrow animation
- pixel shimmer

==================================================
15. DNA / EVOLUTION
==================================================

The current Evolution Lab is too large and permanently visible.

Collapse this into a small status indicator.

Example:

DNA
06 / 100

[OPEN EVOLUTION LAB]

When clicked, open a dedicated overlay/drawer.

The Evolution Lab itself can become a beautiful pixel-art research interface.

This allows the main universe screen to remain clean.

==================================================
16. PANELS SHOULD BE CONTEXTUAL
==================================================

General rule:

DO NOT keep every piece of information permanently visible.

If something is not needed every second, hide it behind interaction.

Examples:

Evolution → drawer
Planet details → contextual inspector
Civilization details → contextual inspector
Codex → overlay
Detailed event history → expandable panel
Advanced divine powers → Faith deck expansion

The main screen should answer:

"What is happening in my universe right now?"

Everything else should be one click away.

==================================================
17. PIXEL ART ASSET ARCHITECTURE
==================================================

Design the UI so that visual assets can easily be replaced later.

Do NOT hard-code visual representations everywhere.

Create reusable components/assets such as:

PixelIcon
PixelPlanet
PixelStar
PixelSun
PixelButton
PixelPanel
PixelCard
PixelBadge
PixelDivider
PixelIndicator
PixelTooltip

For image assets, use a consistent structure.

Example:

/assets/
    /pixel/
        /planets/
        /stars/
        /icons/
        /divine/
        /evolution/
        /events/
        /ui/

If an asset doesn't exist yet, use a temporary placeholder.

Do not block the UI implementation waiting for final artwork.

==================================================
18. ICONS
==================================================

Avoid generic modern icon libraries whenever possible for major game concepts.

Eventually I want custom pixel-art icons for:

DIVINE SIGHT
BLESS HARVEST
NUDGE EVOLUTION
SEND PROPHET
TRIGGER REVELATION
SEND METEOR

These icons should look like they belong to the same universe.

For now, create the UI in a way that makes replacing them with pixel-art assets trivial.

==================================================
19. TYPOGRAPHY
==================================================

Typography is extremely important.

Use:

- pixel/retro font for labels
- readable serif or sci-fi display font for important titles if appropriate
- highly readable font for event text

Do not make EVERYTHING pixel font.

Pixel fonts can become painful to read.

Hierarchy:

ETERNAL SYSTEM
large elegant display

SECTION LABELS
pixel / terminal

GAME DATA
clean readable font

EVENT NARRATIVE
slightly stylized readable font

Descriptions
small but readable

Avoid excessive uppercase text where it hurts readability.

==================================================
20. ANIMATION
==================================================

Use subtle animation.

The game is a simulation, so the interface should feel alive.

Examples:

Stars slowly moving
Planet orbiting
Tiny particle movement
Selected planet pulsing
Faith card icons subtly animating
Events appearing with a small terminal effect
DNA progress slowly animating
End Turn button reacting to hover
Panel transitions

But:

DO NOT turn the UI into a flashy cyberpunk mess.

Animation should reinforce the feeling of a living simulation.

Prefer:

100–300ms transitions
subtle opacity
small movement
pixel shimmer
very slow ambient motion

==================================================
21. CRT / RETRO EFFECTS
==================================================

Optional subtle CRT elements:

- faint scanlines
- slight noise
- tiny pixel flicker
- subtle vignette
- very subtle chromatic aberration

These should be almost invisible.

Do NOT put a giant CRT filter over the entire game.

The player should not feel like they're looking through a broken TV.

==================================================
22. RESPONSIVENESS
==================================================

The current game is primarily desktop.

Optimize for:

1920x1080
2560x1440
3440x1440

Also make sure the UI degrades gracefully at:

1600x900
1366x768

At smaller widths:

- collapse event panel
- reduce Faith card count visible
- compress bottom status
- maintain universe visibility

The universe should always remain the priority.

==================================================
23. VISUAL HIERARCHY
==================================================

The following hierarchy must be obvious:

LEVEL 1
UNIVERSE

LEVEL 2
FAITH / DIVINE POWERS

LEVEL 3
CURRENT WORLD / SIMULATION STATUS

LEVEL 4
EVENTS / NYX

LEVEL 5
ADVANCED INFORMATION

If everything has a border, glow and bright color, nothing has hierarchy.

Use restraint.

==================================================
24. INTERACTION PHILOSOPHY
==================================================

The player is GOD.

The UI should reinforce this psychologically.

Normal strategy games say:

"COMMAND YOUR UNITS."

Eternal System should say:

"OBSERVE."
"INFLUENCE."
"INTERVENE."
"ASCEND."

The player should feel like an intelligence observing a universe from outside it.

When selecting a planet:

The UI should feel like the player is focusing their attention.

When using Faith:

It should feel like applying a force to reality.

When advancing time:

It should feel like accelerating the simulation.

When an event happens:

It should feel like the universe is telling the player something.

==================================================
25. IMPORTANT: DON'T LOSE INFORMATION
==================================================

The current interface contains useful information.

Do not simply remove it.

Instead determine:

VISIBLE
IMPORTANT AT ALL TIMES

vs

CONTEXTUAL
ONLY NEEDED WHEN REQUESTED

vs

ADVANCED
ONLY NEEDED FOR POWER USERS

Reorganize information accordingly.

==================================================
26. IMPLEMENTATION STRATEGY
==================================================

Do this in phases.

PHASE 1:
Audit current UI and component structure.

PHASE 2:
Create the new main layout.

PHASE 3:
Move Faith abilities into bottom-center deck.

PHASE 4:
Convert left panels into compact navigation rail.

PHASE 5:
Convert right event feed into collapsible narrative panel.

PHASE 6:
Create bottom simulation status bar.

PHASE 7:
Create contextual drawers/overlays for advanced information.

PHASE 8:
Apply pixel-art visual language.

PHASE 9:
Add subtle animations.

PHASE 10:
Test every existing interaction.

==================================================
27. CODE QUALITY
==================================================

Do not create one enormous component.

Break the UI into logical reusable components.

For example:

GameShell
TopBar
NavigationRail
UniverseViewport
FaithDeck
FaithCard
EventPanel
EventFeed
SimulationStatusBar
ViewSelector
EvolutionDrawer
PlanetInspector
EndTurnButton
ResourceDisplay

Use the existing architecture where appropriate.

Do not introduce a huge new dependency just to achieve a visual effect.

Prefer CSS/HTML/canvas techniques already compatible with the project.

==================================================
28. VERY IMPORTANT — PRESERVE GAME LOGIC
==================================================

Before changing an existing component, understand what data it consumes.

Do not replace:

- game state
- event state
- simulation state
- resource calculations
- divine power logic
- DNA calculations
- turn logic
- planet selection
- camera controls

with hardcoded values.

The UI must remain connected to the actual game.

==================================================
29. FINAL VISUAL TARGET
==================================================

The final screen should feel approximately like:

A mysterious pixel-art cosmic operating system.

The player sees a huge universe in the center.

A small vertical rail on the left.

A compact cosmic intelligence/event console on the right.

A beautiful Faith ability deck floating at the bottom-center.

A thin simulation status bar along the bottom.

Minimal top controls.

Lots of negative space.

Dark space background.

Gold divine accents.

Purple evolution accents.

Green biological accents.

Cyan technological accents.

Pixel-art icons.

Pixel-art celestial bodies.

Subtle animations.

Minimal UI clutter.

The player should look at the screen and immediately think:

"I am an AI god watching an entire universe evolve."

==================================================
30. BEFORE YOU FINISH
==================================================

After implementing the redesign:

1. Check for UI regressions.
2. Check every button.
3. Check every Faith power.
4. Check simulation speed.
5. Check planet/system selection.
6. Check event feed.
7. Check End Turn.
8. Check DNA/Evolution.
9. Check view switching.
10. Check that panels open/close correctly.
11. Check 1920x1080/2k resolutions
12. Check smaller desktop resolutions.

Do not stop after making it "look better."

The goal is a coherent UI system.

If something in the current architecture prevents this design, explain the limitation and refactor only what is necessary.

Do not ask me to approve every small design decision.

Use your judgment.

Make the interface feel like a real game UI, not a web dashboard.

Most importantly:

PRESERVE THE GAME.

REWORK THE PRESENTATION.

==================================================
DESIGN NORTH STAR
==================================================

ETERNAL SYSTEM should feel like:

"An ancient cosmic computer that accidentally became God."

Not:

"An admin dashboard for a space game."

Build toward that feeling in every UI decision.