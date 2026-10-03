# Ship Spritesheet Specification
## Eternal Systems — Asset Pipeline

---

## Canvas 2D Integration Model

The engine uses `ctx.drawImage(atlas, srcX, srcY, srcW, srcH, destX, destY, destW, destH)` combined with
`ctx.rotate(angle)` around the ship's center point. **You do not need to draw rotated variants** —
draw every ship facing straight UP (north / 12 o'clock). The engine handles all rotation.

---

## Atlas File

**File:** `assets/ships/ships.png`
**Format:** PNG-32 with full alpha (transparent background)
**Total size:** 1024 × 384 px
**Cell size:** 64 × 64 px per frame
**Grid:** 16 columns × 6 rows

---

## Row Layout (one ship type per row)

| Row | Ship Type       | In-game use                                    |
|-----|-----------------|------------------------------------------------|
|  0  | Scout           | Exploration fleet, sent to reveal unknown stars|
|  1  | Cargo           | Resource / colony transport between systems    |
|  2  | Capital         | War fleet, launched on hostile attacks         |
|  3  | Pirate / Raider | Rogue NPC fleets, no civ affiliation           |
|  4  | Divine Fleet    | Player's own fleet — more ornate/glowing       |
|  5  | Colony Ship     | Large slow vessel for seeding new worlds       |

---

## Column Layout (animation states, left to right)

Each row is divided into four animation states. All frames are 64 × 64 px.

```
Columns 0–1   : IDLE       (2 frames — subtle pulse/glow, or just 2 identical for static)
Columns 2–5   : THRUST     (4 frames — engine trail / movement animation)
Columns 6–9   : ATTACK     (4 frames — weapon flash or charging effect)
Columns 10–15 : DESTROYED  (6 frames — explosion / break apart sequence)
```

Full row width: 16 × 64 = 1024 px  ✓

---

## Frame Data File

**File:** `assets/ships/ships.json`  ← generated from this spec, used by SpriteSystem at runtime

```json
{
  "atlas": "ships.png",
  "frameWidth": 64,
  "frameHeight": 64,
  "ships": {
    "scout":    { "row": 0 },
    "cargo":    { "row": 1 },
    "capital":  { "row": 2 },
    "pirate":   { "row": 3 },
    "divine":   { "row": 4 },
    "colony":   { "row": 5 }
  },
  "states": {
    "idle":      { "colStart": 0,  "frameCount": 2,  "fps": 2  },
    "thrust":    { "colStart": 2,  "frameCount": 4,  "fps": 8  },
    "attack":    { "colStart": 6,  "frameCount": 4,  "fps": 12 },
    "destroyed": { "colStart": 10, "frameCount": 6,  "fps": 10 }
  }
}
```

---

## Art Guidelines

### Orientation
- **All ships face straight UP (north)**
- Engine exhaust / thruster nozzle at the BOTTOM
- Weapon hardpoints facing UP or to the sides

### Style
- Top-down view (bird's eye), slight isometric tilt is acceptable
- Hard pixel edges are fine; soft glow effects via alpha are encouraged
- Keep detail readable at **16 × 16 px** (smallest in-game render size at far zoom)
- At full 64 × 64 the ship should fill roughly 70–80% of the cell, leaving ~10px padding all around

### Color coding by allegiance (applied in-engine via tinting — draw ships in neutral grey/white)
The engine will tint ship sprites with `ctx.globalCompositeOperation = 'multiply'` to color them
by civilization. Draw ships in **greyscale or near-white** so tinting works cleanly.

Exception: **Divine Fleet (row 4)** can be drawn in full color since it is always the player's.

### Alpha
- Transparent background (no black fill)
- Engine glow, weapon charge effects: use alpha gradient, not solid shapes
- Destroyed frames: fade alpha toward 0 on the last frame

---

## Ship Size Reference (relative to each other)

| Ship        | Suggested art size within cell | Notes                        |
|-------------|-------------------------------|------------------------------|
| Scout       | ~28 × 36 px                   | Narrow, fast silhouette      |
| Cargo       | ~40 × 44 px                   | Wide, boxy, utilitarian      |
| Capital     | ~44 × 52 px                   | Imposing, angular, armored   |
| Pirate      | ~32 × 40 px                   | Asymmetric, weathered        |
| Divine      | ~48 × 56 px                   | Ornate, glowing trim         |
| Colony Ship | ~52 × 48 px                   | Massive, cylindrical/modular |

---

## Pixel Grid Reference

```
Each cell (64 × 64):

 0                              63
 ┌──────────────────────────────┐  0
 │  ░░░░░░░░░░░░░░░░░░░░░░░░░░  │
 │  ░  10px padding all sides ░  │
 │  ░                          ░  │
 │  ░    SHIP ART GOES HERE    ░  │
 │  ░    facing UP (north)     ░  │
 │  ░    engine at bottom      ░  │
 │  ░                          ░  │
 │  ░░░░░░░░░░░░░░░░░░░░░░░░░░  │
 └──────────────────────────────┘  63
```

---

## Delivery Checklist

- [ ] `ships.png` — 1024 × 384 px, PNG-32, transparent background
- [ ] All 6 rows complete (96 frames total)
- [ ] Ships facing UP in all frames
- [ ] Greyscale / near-white (except Divine row 4)
- [ ] Readable at 16 × 16 (zoom out test)
- [ ] Destroyed sequence ends on transparent or near-transparent frame

---

## Engine Integration (when assets are ready)

A `SpriteSystem` class will be added to `src/rendering/SpriteSystem.ts` that:
1. Loads `ships.png` + `ships.json` on game init
2. Exposes `draw(ctx, shipType, state, frame, x, y, angleDeg, scale, tintColor?)`
3. BigBangEngine replaces fleet triangle drawing with `spriteSystem.draw(...)`
4. Fleet type determined by fleet hostility + civ level + isPlayerFleet flag
