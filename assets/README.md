# Eternal Systems — Asset Directory

## Structure

```
assets/
  ships/
    SPEC.md       ← Full spritesheet specification (READ THIS FIRST)
    ships.json    ← Frame data consumed by SpriteSystem at runtime
    ships.png     ← [ PENDING — artist delivery ]
  icons/
    [ future — UI icons, event type badges ]
  ui/
    [ future — panel backgrounds, button frames ]
```

## Ship Assets

See [ships/SPEC.md](ships/SPEC.md) for the complete art specification.

**Summary:**
- Single atlas: `ships.png`, 1024 × 384 px, PNG-32
- 64 × 64 px per frame, 16 columns × 6 rows
- All ships face **UP (north)**, engine at bottom
- Draw in greyscale — engine tints by civilization color at runtime
- 6 ship types: Scout, Cargo, Capital, Pirate, Divine (player), Colony Ship
- 4 animation states per ship: idle (2f), thrust (4f), attack (4f), destroyed (6f)
