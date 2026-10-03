"""
Settlement TARGET art — Step 1 only (show before baker).

16×16 modular buildings for the diorama: land huts → village → lit town,
plus aquatic spires / coastal terraces / aerial stilts. Not wired into the game.
Inspired by ref/concept-sheets/building/human_type_village_pri.png silhouettes,
shrunk to diorama pixel budget.
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "renders" / "settle-target-2026-10-02"
CELL, SCALE, GAP, LABEL = 16, 5, 6, 14


def blank():
    return [["."] * CELL for _ in range(CELL)]


def setp(g, x, y, ch):
    if 0 <= x < CELL and 0 <= y < CELL:
        g[y][x] = ch


def paint(grid, pal):
    im = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    px = im.load()
    for y in range(CELL):
        for x in range(CELL):
            px[x, y] = pal.get(grid[y][x], (0, 0, 0, 0))
    return im


def up(im, n=SCALE):
    return im.resize((im.width * n, im.height * n), Image.NEAREST)


def P(**kw):
    d = {".": (0, 0, 0, 0)}
    d.update(kw)
    return d


# wall / roof / wood / stone / thatch / window / door / glow / outline
LAND = P(
    k=(28, 22, 18, 255),
    w=(86, 68, 48, 255), W=(110, 88, 62, 255),  # wall mid/light
    d=(58, 44, 32, 255),                          # wall dark
    t=(120, 92, 48, 255), T=(150, 118, 64, 255),  # thatch
    r=(72, 48, 32, 255), R=(98, 64, 40, 255),     # wood roof
    s=(110, 108, 102, 255), S=(140, 136, 128, 255),  # stone
    o=(40, 28, 20, 255),                          # door
    g=(255, 210, 120, 255), G=(255, 240, 180, 255),  # window glow
    c=(70, 70, 72, 255),                          # chimney
    f=(220, 90, 40, 255),                         # forge fire
    b=(160, 40, 40, 255),                         # banner
)

AQUA = P(
    k=(20, 40, 55, 255),
    w=(90, 150, 170, 255), W=(130, 190, 210, 255),
    d=(50, 90, 120, 255),
    t=(200, 240, 250, 255), T=(230, 250, 255, 255),
    r=(160, 210, 230, 255), R=(190, 230, 245, 255),
    s=(100, 140, 160, 255), S=(140, 180, 200, 255),
    o=(40, 70, 90, 255),
    g=(160, 240, 255, 255), G=(210, 250, 255, 255),
    c=(80, 120, 140, 255),
    f=(180, 255, 255, 255),
    b=(100, 200, 230, 255),
)

AERIAL = P(
    k=(30, 28, 40, 255),
    w=(100, 90, 120, 255), W=(130, 120, 150, 255),
    d=(60, 52, 78, 255),
    t=(180, 170, 200, 255), T=(210, 200, 230, 255),
    r=(90, 80, 110, 255), R=(120, 108, 140, 255),
    s=(120, 118, 130, 255), S=(150, 148, 160, 255),
    o=(40, 36, 50, 255),
    g=(255, 220, 140, 255), G=(255, 245, 200, 255),
    c=(70, 68, 80, 255),
    f=(255, 180, 80, 255),
    b=(200, 80, 100, 255),
)


def hut(g, cx=8, base=14, wide=5, tall=4, roof="thatch", lit=False):
    """Roundish primordial hut."""
    # wall block
    for y in range(base - tall, base):
        for x in range(cx - wide // 2, cx + wide // 2 + 1):
            ch = "d" if x == cx - wide // 2 else ("W" if x == cx + wide // 2 else "w")
            setp(g, x, y, ch)
    # door
    setp(g, cx, base - 1, "o")
    setp(g, cx, base - 2, "o")
    # roof dome / thatch
    for dy, half in ((1, wide // 2 + 1), (2, wide // 2), (3, max(1, wide // 2 - 1))):
        y = base - tall - dy
        for x in range(cx - half, cx + half + 1):
            setp(g, x, y, "T" if abs(x - cx) < half else "t")
    if lit:
        setp(g, cx - 1, base - tall + 1, "g")
        setp(g, cx + 1, base - tall + 1, "g")


def longhouse(g, cx=8, base=14, lit=False):
    for y in range(base - 4, base):
        for x in range(cx - 5, cx + 6):
            setp(g, x, y, "d" if x in (cx - 5, cx + 5) else "w")
    setp(g, cx - 2, base - 1, "o")
    setp(g, cx - 2, base - 2, "o")
    # pitched roof
    for x in range(cx - 6, cx + 7):
        setp(g, x, base - 5, "R")
    for x in range(cx - 4, cx + 5):
        setp(g, x, base - 6, "r")
    setp(g, cx, base - 7, "r")
    # chimney
    setp(g, cx + 3, base - 7, "c")
    setp(g, cx + 3, base - 8, "c")
    if lit:
        for x in (cx - 3, cx, cx + 2):
            setp(g, x, base - 3, "g")


def tower(g, cx=8, base=14, lit=True):
    for y in range(base - 8, base):
        for x in range(cx - 2, cx + 3):
            setp(g, x, y, "d" if x in (cx - 2, cx + 2) else "s")
    setp(g, cx, base - 1, "o")
    # roof cap
    for x in range(cx - 3, cx + 4):
        setp(g, x, base - 9, "R")
    setp(g, cx, base - 10, "r")
    # banner
    setp(g, cx + 3, base - 8, "b")
    setp(g, cx + 3, base - 7, "b")
    if lit:
        setp(g, cx - 1, base - 5, "g")
        setp(g, cx + 1, base - 5, "G")
        setp(g, cx - 1, base - 3, "g")


def forge(g, cx=8, base=14):
    for y in range(base - 4, base):
        for x in range(cx - 3, cx + 4):
            setp(g, x, y, "s" if (x + y) % 2 == 0 else "S")
    setp(g, cx, base - 1, "o")
    for x in range(cx - 4, cx + 5):
        setp(g, x, base - 5, "r")
    setp(g, cx, base - 3, "f")
    setp(g, cx, base - 2, "f")
    setp(g, cx + 1, base - 3, "G")


def spire(g, cx=8, base=14, tall=9, lit=True):
    """Aquatic glass/coral spire."""
    for i, y in enumerate(range(base - 1, base - tall - 1, -1)):
        half = max(0, 2 - i // 3)
        for x in range(cx - half, cx + half + 1):
            setp(g, x, y, "d" if abs(x - cx) == half else "W")
    setp(g, cx, base - tall - 1, "T")
    setp(g, cx, base - tall, "t")
    if lit:
        setp(g, cx, base - tall // 2, "g")
        setp(g, cx, base - tall // 2 - 2, "G")


def dome(g, cx=8, base=14, lit=True):
    """Pressure dome cluster."""
    for y in range(base - 3, base):
        for x in range(cx - 3, cx + 4):
            setp(g, x, y, "w")
    for dy, half in ((1, 3), (2, 2), (3, 1)):
        for x in range(cx - half, cx + half + 1):
            setp(g, x, base - 3 - dy, "W" if abs(x - cx) < half else "d")
    setp(g, cx, base - 1, "o")
    if lit:
        setp(g, cx - 1, base - 4, "g")
        setp(g, cx + 1, base - 4, "g")


def stilts(g, cx=8, base=14, lit=True):
    """Aerial suspended hut on stilts."""
    # stilts
    for x in (cx - 2, cx + 2):
        for y in range(base - 5, base):
            setp(g, x, y, "d")
    # cabin
    for y in range(base - 8, base - 5):
        for x in range(cx - 3, cx + 4):
            setp(g, x, y, "w")
    for x in range(cx - 4, cx + 5):
        setp(g, x, base - 9, "t")
    setp(g, cx, base - 10, "T")
    if lit:
        setp(g, cx - 1, base - 7, "g")
        setp(g, cx + 1, base - 7, "G")


def village_cluster(lit=False):
    g = blank()
    hut(g, 5, 14, 4, 3, lit=lit)
    hut(g, 11, 14, 5, 4, lit=lit)
    return g


def town_cluster():
    g = blank()
    longhouse(g, 7, 14, lit=True)
    tower(g, 13, 14, lit=True)
    return g


PACKS = [
    ("land_hut", LAND, lambda: (lambda g: (hut(g), g))(blank())[1]),
    ("land_hut2", LAND, lambda: (lambda g: (hut(g, 8, 14, 6, 5), g))(blank())[1]),
    ("land_village", LAND, village_cluster),
    ("land_longhouse", LAND, lambda: (lambda g: (longhouse(g), g))(blank())[1]),
    ("land_tower", LAND, lambda: (lambda g: (tower(g), g))(blank())[1]),
    ("land_forge", LAND, lambda: (lambda g: (forge(g), g))(blank())[1]),
    ("land_town", LAND, town_cluster),
    ("aqua_spire", AQUA, lambda: (lambda g: (spire(g), g))(blank())[1]),
    ("aqua_spire2", AQUA, lambda: (lambda g: (spire(g, 8, 14, 11), g))(blank())[1]),
    ("aqua_dome", AQUA, lambda: (lambda g: (dome(g), g))(blank())[1]),
    ("aerial_stilt", AERIAL, lambda: (lambda g: (stilts(g), g))(blank())[1]),
    ("aerial_stilt2", AERIAL, lambda: (lambda g: (stilts(g, 7, 14), g))(blank())[1]),
]


def on_ground(spr: Image.Image, rgb=(52, 88, 48)):
    pad = Image.new("RGBA", (spr.width + 4, spr.height + 4), (*rgb, 255))
    pad.paste(spr, (2, 2), spr)
    return pad


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cols = 6
    rows = (len(PACKS) + cols - 1) // cols
    cell_px = CELL * SCALE + 4
    W = GAP + cols * (cell_px + GAP)
    H = LABEL + GAP + rows * (cell_px + LABEL + GAP)
    sheet = Image.new("RGBA", (W, H), (14, 12, 18, 255))
    dr = ImageDraw.Draw(sheet)
    dr.text((4, 2), "settlement targets 16px — hut / village / town / aqua / aerial", fill=(220, 220, 220, 255))

    for i, (name, pal, builder) in enumerate(PACKS):
        g = builder()
        spr = up(paint(g, pal))
        # ground tint by pack
        gnd = (52, 88, 48) if "land" in name else ((30, 60, 90) if "aqua" in name else (48, 44, 64))
        cell = on_ground(spr, gnd)
        col, row = i % cols, i // cols
        x = GAP + col * (cell_px + GAP)
        y = LABEL + GAP + row * (cell_px + LABEL + GAP)
        sheet.alpha_composite(cell, (x, y + 12))
        dr.text((x, y), name.replace("_", " ")[:14], fill=(200, 200, 200, 255))
        cell.save(OUT / f"{name}.png")

    # tech ladder strip
    ladder = Image.new("RGBA", (GAP + 5 * (cell_px + GAP), LABEL + cell_px + GAP * 2), (14, 12, 18, 255))
    ldr = ImageDraw.Draw(ladder)
    ldr.text((4, 2), "tech: hut → village → longhouse → tower → town", fill=(220, 220, 220, 255))
    ladder_builders = [
        lambda: (lambda g: (hut(g, lit=False), g))(blank())[1],
        village_cluster,
        lambda: (lambda g: (longhouse(g, lit=False), g))(blank())[1],
        lambda: (lambda g: (tower(g, lit=True), g))(blank())[1],
        town_cluster,
    ]
    for i, b in enumerate(ladder_builders):
        cell = on_ground(up(paint(b(), LAND)))
        ladder.alpha_composite(cell, (GAP + i * (cell_px + GAP), LABEL + GAP))
    ladder.save(OUT / "tech_ladder.png")
    sheet.save(OUT / "sheet.png")

    # vs live fillRect baker note — just the targets for now
    print(f"wrote {OUT} ({len(PACKS)} sprites)")


if __name__ == "__main__":
    main()
