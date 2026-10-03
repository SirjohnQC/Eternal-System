"""
Per-world vegetation TARGET art — show before encoding into the baker.

Distinct flora personality per HabitableType (gas = none). 16×16 cells,
2 variants × 5 kinds, on type-tinted ground. Not wired into the game.
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "renders" / "veg-world-2026-10-01"
CELL, SCALE, GAP, LABEL_H = 16, 4, 6, 14


def blank() -> list[list[str]]:
    return [["."] * CELL for _ in range(CELL)]


def setp(g: list[list[str]], x: int, y: int, ch: str) -> None:
    if 0 <= x < CELL and 0 <= y < CELL:
        g[y][x] = ch


def disk(g, cx, cy, r, ch, hollow=False):
    r2 = r * r
    for y in range(cy - r, cy + r + 1):
        for x in range(cx - r, cx + r + 1):
            d = (x - cx) * (x - cx) + (y - cy) * (y - cy)
            if d <= r2 and (not hollow or d >= (r - 1) * (r - 1)):
                setp(g, x, y, ch)


def vline(g, x, y0, y1, ch):
    for y in range(min(y0, y1), max(y0, y1) + 1):
        setp(g, x, y, ch)


def paint(grid: list[list[str]], pal: dict) -> Image.Image:
    im = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    px = im.load()
    for y in range(CELL):
        for x in range(CELL):
            px[x, y] = pal.get(grid[y][x], (0, 0, 0, 0))
    return im


def up(im: Image.Image, n: int = SCALE) -> Image.Image:
    return im.resize((im.width * n, im.height * n), Image.NEAREST)


def shade_canopy(g, cx, cy, r):
    """Top-left light: highlight NW, shadow SE."""
    y0, y1 = max(0, cy - r), min(CELL, cy + r + 1)
    x0, x1 = max(0, cx - r), min(CELL, cx + r + 1)
    for y in range(y0, y1):
        for x in range(x0, x1):
            if g[y][x] == ".":
                continue
            if (x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r:
                continue
            nx = (x - cx) / max(1, r)
            ny = (y - cy) / max(1, r)
            lit = -nx - ny
            if lit > 0.45:
                setp(g, x, y, "e" if g[y][x] in "hlme" else "h")
            elif lit > 0.1:
                setp(g, x, y, "l")
            elif lit > -0.25:
                setp(g, x, y, "m")
            elif lit > -0.55:
                setp(g, x, y, "s")
            else:
                setp(g, x, y, "d")
    for y in range(CELL):
        for x in range(CELL):
            if g[y][x] == ".":
                continue
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                nx, ny = x + dx, y + dy
                if not (0 <= nx < CELL and 0 <= ny < CELL) or g[ny][nx] == ".":
                    if g[y][x] not in "tTuorOaAbSwzcCpC":
                        setp(g, x, y, "k")
                    break


def trunk(g, x, y0, y1, thick=1):
    for y in range(y0, y1 + 1):
        for t in range(-(thick // 2), thick // 2 + 1):
            ch = "u" if t < 0 else ("t" if t > 0 else "T")
            setp(g, x + t, y, ch)
    setp(g, x, y1, "r")
    if thick > 1:
        setp(g, x - 1, y1, "r")
        setp(g, x + 1, y1, "r")


# ── palettes ──────────────────────────────────────────────────────────────────
def pal(**kw):
    d = {".": (0, 0, 0, 0)}
    d.update(kw)
    return d


PALS = {
    "ocean": pal(
        k=(16, 40, 28, 255), d=(18, 56, 36, 255), s=(28, 88, 52, 255),
        m=(42, 130, 72, 255), l=(72, 168, 96, 255), h=(120, 200, 130, 255),
        e=(180, 220, 160, 255), t=(48, 28, 14, 255), T=(86, 52, 24, 255),
        u=(130, 86, 42, 255), r=(40, 26, 14, 255),
        f=(200, 90, 70, 255), c=(40, 120, 90, 255), w=(90, 180, 200, 255),
    ),
    "rocky": pal(
        k=(20, 32, 22, 255), d=(24, 44, 30, 255), s=(34, 64, 40, 255),
        m=(48, 90, 52, 255), l=(70, 118, 64, 255), h=(110, 148, 80, 255),
        e=(150, 170, 100, 255), t=(40, 30, 22, 255), T=(70, 52, 36, 255),
        u=(100, 78, 52, 255), r=(50, 38, 28, 255),
        a=(140, 130, 110, 255), A=(80, 76, 70, 255), g=(90, 110, 60, 255),
    ),
    "ice": pal(
        k=(30, 48, 58, 255), d=(36, 60, 72, 255), s=(48, 86, 100, 255),
        m=(70, 120, 130, 255), l=(110, 160, 170, 255), h=(160, 200, 210, 255),
        e=(210, 230, 235, 255), t=(50, 44, 48, 255), T=(78, 70, 76, 255),
        u=(120, 110, 118, 255), r=(60, 54, 58, 255),
        b=(140, 190, 220, 255), w=(230, 240, 245, 255), a=(100, 110, 120, 255),
    ),
    "lava": pal(
        k=(28, 18, 16, 255), d=(40, 24, 20, 255), s=(58, 34, 28, 255),
        m=(80, 48, 36, 255), l=(110, 60, 40, 255), h=(160, 80, 40, 255),
        e=(220, 140, 60, 255), t=(30, 22, 20, 255), T=(48, 34, 30, 255),
        u=(70, 48, 40, 255), r=(36, 26, 22, 255),
        o=(255, 120, 40, 255), O=(255, 200, 80, 255), a=(60, 50, 48, 255), A=(90, 78, 70, 255),
    ),
    "toxic": pal(
        k=(40, 28, 48, 255), d=(52, 36, 64, 255), s=(70, 48, 90, 255),
        m=(100, 60, 130, 255), l=(140, 80, 170, 255), h=(180, 120, 200, 255),
        e=(210, 170, 220, 255), t=(36, 40, 28, 255), T=(56, 64, 40, 255),
        u=(86, 100, 52, 255), r=(44, 48, 32, 255),
        y=(200, 230, 60, 255), g=(60, 180, 80, 255), p=(220, 80, 180, 255),
    ),
    "crystal": pal(
        k=(40, 36, 70, 255), d=(56, 48, 100, 255), s=(80, 70, 140, 255),
        m=(120, 100, 180, 255), l=(160, 140, 210, 255), h=(200, 190, 230, 255),
        e=(230, 225, 245, 255), t=(50, 40, 70, 255), T=(80, 60, 110, 255),
        u=(120, 90, 150, 255), r=(40, 32, 56, 255),
        c=(100, 220, 255, 255), C=(180, 240, 255, 255), p=(255, 140, 220, 255),
    ),
    "desert": pal(
        k=(36, 34, 16, 255), d=(46, 52, 22, 255), s=(62, 72, 28, 255),
        m=(86, 98, 36, 255), l=(118, 128, 48, 255), h=(156, 160, 72, 255),
        e=(198, 188, 110, 255), t=(58, 40, 22, 255), T=(88, 62, 32, 255),
        u=(122, 90, 48, 255), r=(58, 40, 24, 255),
        p=(186, 170, 120, 255), b=(164, 56, 40, 255), S=(160, 130, 80, 255),
    ),
    "storm": pal(
        k=(24, 32, 40, 255), d=(32, 44, 54, 255), s=(44, 62, 74, 255),
        m=(60, 88, 100, 255), l=(90, 120, 130, 255), h=(130, 160, 170, 255),
        e=(180, 200, 205, 255), t=(28, 28, 32, 255), T=(48, 48, 54, 255),
        u=(72, 72, 80, 255), r=(36, 36, 40, 255),
        z=(200, 220, 255, 255), Z=(140, 160, 200, 255),
    ),
    "carbon": pal(
        k=(18, 18, 20, 255), d=(28, 28, 32, 255), s=(42, 42, 48, 255),
        m=(60, 60, 68, 255), l=(90, 90, 100, 255), h=(130, 130, 140, 255),
        e=(170, 170, 180, 255), t=(20, 16, 16, 255), T=(40, 32, 32, 255),
        u=(64, 48, 48, 255), r=(24, 20, 20, 255),
        o=(180, 40, 40, 255), O=(220, 80, 40, 255), g=(40, 80, 50, 255),
    ),
}

GROUND = {
    "ocean": (34, 72, 58), "rocky": (72, 68, 58), "ice": (48, 72, 88),
    "lava": (48, 28, 24), "toxic": (48, 40, 56), "crystal": (52, 48, 72),
    "desert": (120, 96, 58), "storm": (40, 48, 56), "carbon": (28, 28, 30),
    "gas": (28, 32, 48),
}


# ── builders: return list of (kind_name, [var0, var1]) ────────────────────────

def build_ocean():
    out = []
    # palm
    vars_ = []
    for lean in (0, 1):
        g = blank()
        trunk(g, 8 + lean, 6, 14, 1)
        for i, (dx, dy, rr) in enumerate([(-2, 2, 2), (2, 2, 2), (0, 0, 3), (-3, 3, 2), (3, 3, 2)]):
            disk(g, 8 + lean + dx, 3 + dy, rr, "m")
        shade_canopy(g, 8 + lean, 3, 4)
        setp(g, 8 + lean, 2, "e")
        vars_.append(g)
    out.append(("palm", vars_))
    # fern
    vars_ = []
    for wide in (0, 1):
        g = blank()
        trunk(g, 8, 11, 14, 1)
        for ang in range(-3 - wide, 4 + wide):
            for t in range(4):
                setp(g, 8 + ang, 10 - t - abs(ang) // 2, "c" if t % 2 else "m")
        shade_canopy(g, 8, 8, 4)
        vars_.append(g)
    out.append(("fern", vars_))
    # vine tree
    vars_ = []
    for berry in (0, 1):
        g = blank()
        trunk(g, 8, 9, 14, 1)
        disk(g, 8, 5, 5, "m")
        shade_canopy(g, 8, 5, 5)
        setp(g, 5, 10, "c"); setp(g, 11, 11, "c"); setp(g, 6, 12, "c")
        if berry:
            setp(g, 6, 4, "f"); setp(g, 10, 5, "f")
        vars_.append(g)
    out.append(("vine", vars_))
    # moss rock
    vars_ = []
    for twin in (0, 1):
        g = blank()
        disk(g, 7, 11, 3, "s")
        if twin:
            disk(g, 11, 12, 2, "d")
        setp(g, 6, 10, "m"); setp(g, 8, 9, "l"); setp(g, 7, 11, "h")
        setp(g, 9, 12, "c"); setp(g, 5, 12, "n" if False else "c")
        shade_canopy(g, 8, 11, 4)
        vars_.append(g)
    out.append(("mossrock", vars_))
    # reed
    vars_ = []
    for n in (1, 2):
        g = blank()
        for i in range(n):
            x = 7 + i * 3
            vline(g, x, 4, 13, "c")
            setp(g, x, 3, "w"); setp(g, x, 14, "r")
        vars_.append(g)
    out.append(("reed", vars_))
    return out


def build_rocky():
    out = []
    vars_ = []
    for tall in (0, 1):
        g = blank()
        trunk(g, 8, 10 + tall, 14, 1)
        for i, rr in enumerate([2, 3, 4] if tall else [2, 3]):
            disk(g, 8, 3 + i * 3, rr, "m")
        shade_canopy(g, 8, 5, 5)
        vars_.append(g)
    out.append(("pine", vars_))
    vars_ = []
    for lobes in (1, 2):
        g = blank()
        for i in range(lobes):
            disk(g, 6 + i * 4, 12, 2, "m")
        shade_canopy(g, 8, 12, 4)
        vars_.append(g)
    out.append(("scrub", vars_))
    vars_ = []
    for twin in (0, 1):
        g = blank()
        disk(g, 7, 11, 3, "A")
        if twin:
            disk(g, 11, 12, 2, "a")
        setp(g, 6, 10, "g"); setp(g, 8, 9, "g"); setp(g, 9, 11, "g")
        shade_canopy(g, 8, 11, 4)
        vars_.append(g)
    out.append(("lichen", vars_))
    vars_ = []
    for lean in (2, 3):
        g = blank()
        for y in range(6, 15):
            setp(g, 8 + (y - 10) // 2, y, "T")
        disk(g, 8 + lean, 4, 3, "m")
        shade_canopy(g, 8 + lean, 4, 3)
        setp(g, 8, 14, "r")
        vars_.append(g)
    out.append(("windbent", vars_))
    vars_ = []
    for branch in (0, 1):
        g = blank()
        trunk(g, 8, 4, 14, 1)
        if branch:
            setp(g, 6, 6, "t"); setp(g, 5, 5, "t"); setp(g, 10, 8, "u")
        vars_.append(g)
    out.append(("snag", vars_))
    return out


def build_ice():
    out = []
    vars_ = []
    for snow in (0, 1):
        g = blank()
        trunk(g, 8, 10, 14, 1)
        for i, rr in enumerate([2, 3, 4]):
            disk(g, 8, 3 + i * 3, rr, "m")
        shade_canopy(g, 8, 5, 5)
        if snow:
            setp(g, 7, 2, "w"); setp(g, 9, 4, "w"); setp(g, 8, 6, "b")
        vars_.append(g)
    out.append(("frostpine", vars_))
    vars_ = []
    for n in (1, 2):
        g = blank()
        for i in range(n):
            disk(g, 6 + i * 4, 11, 2, "b")
            setp(g, 6 + i * 4, 10, "w")
        shade_canopy(g, 8, 11, 4)
        vars_.append(g)
    out.append(("icebrush", vars_))
    vars_ = []
    for twin in (0, 1):
        g = blank()
        disk(g, 7, 11, 3, "a")
        if twin:
            disk(g, 11, 12, 2, "a")
        setp(g, 7, 9, "b"); setp(g, 8, 10, "w"); setp(g, 6, 11, "h")
        shade_canopy(g, 8, 11, 4)
        vars_.append(g)
    out.append(("crystichen", vars_))
    vars_ = []
    for lobes in (1, 2):
        g = blank()
        for i in range(lobes):
            disk(g, 6 + i * 4, 12, 2, "m")
        shade_canopy(g, 8, 12, 4)
        vars_.append(g)
    out.append(("bluescrub", vars_))
    vars_ = []
    for twin in (0, 1):
        g = blank()
        disk(g, 8, 11, 3, "a")
        if twin:
            disk(g, 5, 12, 2, "a")
        for y in range(8, 12):
            for x in range(5, 12):
                if g[y][x] != "." and y < 10:
                    setp(g, x, y, "w")
        shade_canopy(g, 8, 11, 4)
        vars_.append(g)
    out.append(("snowrock", vars_))
    return out


def build_lava():
    out = []
    vars_ = []
    for twin in (0, 1):
        g = blank()
        trunk(g, 8, 8, 12, 1)
        disk(g, 8, 6, 2, "o")
        setp(g, 8, 5, "O"); setp(g, 7, 6, "h"); setp(g, 9, 6, "e")
        if twin:
            trunk(g, 11, 9, 12, 1)
            disk(g, 11, 7, 2, "o")
            setp(g, 11, 6, "O")
        vars_.append(g)
    out.append(("emberfungus", vars_))
    vars_ = []
    for tip in (0, 1):
        g = blank()
        trunk(g, 8, 5, 13, 1)
        setp(g, 8, 4, "a"); setp(g, 7, 4, "A")
        if tip:
            setp(g, 9, 7, "o")
        vars_.append(g)
    out.append(("charstalk", vars_))
    vars_ = []
    for lobes in (1, 2):
        g = blank()
        for i in range(lobes):
            disk(g, 6 + i * 4, 12, 2, "a")
        shade_canopy(g, 8, 12, 3)
        vars_.append(g)
    out.append(("ashscrub", vars_))
    vars_ = []
    for tall in (0, 1):
        g = blank()
        disk(g, 8, 11 - tall, 3 + tall, "m")
        shade_canopy(g, 8, 11 - tall, 3 + tall)
        vars_.append(g)
    out.append(("basalt", vars_))
    vars_ = []
    for n in (1, 2):
        g = blank()
        for i in range(n + 1):
            setp(g, 6 + i * 2, 12, "o" if i % 2 else "O")
            setp(g, 6 + i * 2, 13, "a")
        vars_.append(g)
    out.append(("cinder", vars_))
    return out


def build_toxic():
    out = []
    vars_ = []
    for twin in (0, 1):
        g = blank()
        trunk(g, 8, 9, 13, 1)
        disk(g, 8, 6, 3, "y")
        setp(g, 8, 5, "p"); setp(g, 7, 6, "h"); setp(g, 9, 7, "e")
        if twin:
            trunk(g, 4, 10, 13, 1)
            disk(g, 4, 7, 2, "y")
        vars_.append(g)
    out.append(("blister", vars_))
    vars_ = []
    for wide in (0, 1):
        g = blank()
        trunk(g, 8, 11, 14, 1)
        for ang in range(-3 - wide, 4 + wide):
            for t in range(4):
                setp(g, 8 + ang, 10 - t - abs(ang) // 2, "g" if t % 2 else "y")
        shade_canopy(g, 8, 8, 4)
        vars_.append(g)
    out.append(("acidfern", vars_))
    vars_ = []
    for berry in (0, 1):
        g = blank()
        trunk(g, 8, 9, 14, 1)
        disk(g, 8, 5, 5, "m")
        shade_canopy(g, 8, 5, 5)
        setp(g, 5, 10, "g"); setp(g, 11, 11, "y")
        if berry:
            setp(g, 6, 4, "p"); setp(g, 10, 5, "p")
        vars_.append(g)
    out.append(("venomvine", vars_))
    vars_ = []
    for twin in (0, 1):
        g = blank()
        trunk(g, 8, 9, 13, 1)
        disk(g, 8, 6, 3, "p")
        setp(g, 8, 5, "h")
        if twin:
            trunk(g, 12, 10, 13, 1)
            disk(g, 12, 7, 2, "p")
        vars_.append(g)
    out.append(("sporepuff", vars_))
    vars_ = []
    for twin in (0, 1):
        g = blank()
        disk(g, 8, 11, 3, "m")
        if twin:
            disk(g, 5, 12, 2, "m")
        setp(g, 7, 10, "y"); setp(g, 9, 11, "g"); setp(g, 8, 9, "p")
        shade_canopy(g, 8, 11, 4)
        vars_.append(g)
    out.append(("sludgerock", vars_))
    return out


def build_crystal():
    out = []
    vars_ = []
    for tall in (0, 1):
        g = blank()
        # prism tree — diamond stack
        h = 10 + tall * 2
        for i in range(h):
            w = max(1, 3 - abs(i - h // 3))
            for dx in range(-w, w + 1):
                ch = "C" if i < 3 else ("c" if abs(dx) < w else "k")
                setp(g, 8 + dx, 14 - i, ch)
        setp(g, 8, 14, "r")
        vars_.append(g)
    out.append(("prism", vars_))
    vars_ = []
    for n in (1, 2):
        g = blank()
        for i in range(n):
            x = 6 + i * 4
            for dy in range(4):
                setp(g, x, 12 - dy, "c")
                setp(g, x - 1, 11 - dy, "m")
                setp(g, x + 1, 11 - dy, "h")
            setp(g, x, 8, "C")
        vars_.append(g)
    out.append(("shard", vars_))
    vars_ = []
    for twin in (0, 1):
        g = blank()
        disk(g, 8, 11, 3, "m")
        shade_canopy(g, 8, 11, 3)
        setp(g, 8, 9, "C"); setp(g, 7, 10, "c"); setp(g, 9, 11, "p")
        if twin:
            disk(g, 4, 12, 2, "m")
            setp(g, 4, 11, "c")
        vars_.append(g)
    out.append(("geode", vars_))
    vars_ = []
    for lean in (0, 1):
        g = blank()
        trunk(g, 8, 8, 14, 1)
        disk(g, 8 + lean, 5, 3, "m")
        shade_canopy(g, 8 + lean, 5, 3)
        setp(g, 8 + lean, 3, "C"); setp(g, 7 + lean, 5, "p")
        vars_.append(g)
    out.append(("facetbush", vars_))
    vars_ = []
    for n in (2, 3):
        g = blank()
        for i in range(n):
            setp(g, 5 + i * 3, 12, "c")
            setp(g, 5 + i * 3, 11, "C")
            setp(g, 5 + i * 3, 13, "r")
        vars_.append(g)
    out.append(("spire", vars_))
    return out


def build_desert():
    out = []
    vars_ = []
    for arms in (0, 1):
        g = blank()
        trunk(g, 8, 4, 14, 1)
        for y in range(4, 14):
            setp(g, 7, y, "s"); setp(g, 9, y, "l")
        setp(g, 8, 3, "h")
        if arms:
            for x in range(5, 8):
                setp(g, x, 8, "m")
            setp(g, 5, 7, "h"); setp(g, 5, 9, "s")
            for x in range(9, 12):
                setp(g, x, 10, "m")
            setp(g, 11, 9, "h")
        # spines
        setp(g, 6, 6, "p"); setp(g, 10, 7, "p"); setp(g, 6, 11, "p")
        vars_.append(g)
    out.append(("cactus", vars_))
    vars_ = []
    for lobes in (1, 2):
        g = blank()
        for i in range(lobes):
            disk(g, 6 + i * 4, 12, 2, "m")
        shade_canopy(g, 8, 12, 4)
        vars_.append(g)
    out.append(("scrub", vars_))
    vars_ = []
    for branch in (0, 1):
        g = blank()
        trunk(g, 8, 5, 14, 1)
        if branch:
            setp(g, 6, 7, "t"); setp(g, 5, 6, "t"); setp(g, 10, 9, "u")
        vars_.append(g)
    out.append(("deadwood", vars_))
    vars_ = []
    for twin in (0, 1):
        g = blank()
        disk(g, 8, 11, 3, "S")
        if twin:
            disk(g, 5, 12, 2, "S")
        shade_canopy(g, 8, 11, 4)
        vars_.append(g)
    out.append(("sandrock", vars_))
    vars_ = []
    for flower in (0, 1):
        g = blank()
        trunk(g, 8, 10, 14, 1)
        disk(g, 8, 8, 2, "m")
        shade_canopy(g, 8, 8, 2)
        if flower:
            setp(g, 8, 6, "b"); setp(g, 7, 7, "b"); setp(g, 9, 7, "e")
        vars_.append(g)
    out.append(("yucca", vars_))
    return out


def build_storm():
    out = []
    vars_ = []
    for lean in (1, 2):
        g = blank()
        for y in range(5, 15):
            setp(g, 8 + (y - 10) // 3 * lean, y, "T")
        disk(g, 8 + lean, 4, 3, "m")
        shade_canopy(g, 8 + lean, 4, 3)
        setp(g, 8, 14, "r")
        # lightning scar
        setp(g, 8, 8, "z"); setp(g, 8 + lean // 2, 9, "Z")
        vars_.append(g)
    out.append(("scarred", vars_))
    vars_ = []
    for n in (2, 3):
        g = blank()
        for i in range(n):
            x = 5 + i * 3
            vline(g, x, 6, 13, "m")
            setp(g, x, 5, "h"); setp(g, x, 14, "r")
        vars_.append(g)
    out.append(("reed", vars_))
    vars_ = []
    for lobes in (1, 2):
        g = blank()
        for i in range(lobes):
            disk(g, 6 + i * 4, 13, 2, "m")
        shade_canopy(g, 8, 13, 3)
        vars_.append(g)
    out.append(("mat", vars_))
    vars_ = []
    for twin in (0, 1):
        g = blank()
        disk(g, 8, 11, 3, "m")
        if twin:
            disk(g, 5, 12, 2, "s")
        shade_canopy(g, 8, 11, 4)
        setp(g, 8, 9, "z")
        vars_.append(g)
    out.append(("wetrock", vars_))
    vars_ = []
    for arms in (0, 1):
        g = blank()
        trunk(g, 8, 6, 14, 1)
        disk(g, 8, 4, 2, "m")
        shade_canopy(g, 8, 4, 2)
        if arms:
            setp(g, 5, 8, "t"); setp(g, 4, 7, "t")
        vars_.append(g)
    out.append(("leanpine", vars_))
    return out


def build_carbon():
    out = []
    vars_ = []
    for tall in (0, 1):
        g = blank()
        trunk(g, 8, 8, 14, 1)
        disk(g, 8, 5, 3 + tall, "m")
        shade_canopy(g, 8, 5, 3 + tall)
        setp(g, 7, 4, "o"); setp(g, 9, 5, "O")
        vars_.append(g)
    out.append(("sootfungus", vars_))
    vars_ = []
    for lobes in (1, 2):
        g = blank()
        for i in range(lobes):
            disk(g, 6 + i * 4, 12, 2, "m")
        shade_canopy(g, 8, 12, 3)
        vars_.append(g)
    out.append(("graphite", vars_))
    vars_ = []
    for n in (1, 2):
        g = blank()
        for i in range(n):
            trunk(g, 6 + i * 4, 8, 13, 1)
            setp(g, 6 + i * 4, 7, "o")
            setp(g, 6 + i * 4, 6, "O")
        vars_.append(g)
    out.append(("coalbud", vars_))
    vars_ = []
    for twin in (0, 1):
        g = blank()
        disk(g, 8, 11, 3, "m")
        if twin:
            disk(g, 5, 12, 2, "s")
        setp(g, 7, 10, "g"); setp(g, 9, 11, "g")
        shade_canopy(g, 8, 11, 4)
        vars_.append(g)
    out.append(("tarlichen", vars_))
    vars_ = []
    for branch in (0, 1):
        g = blank()
        trunk(g, 8, 4, 14, 1)
        if branch:
            setp(g, 6, 6, "t"); setp(g, 10, 8, "u")
        setp(g, 8, 3, "o")
        vars_.append(g)
    out.append(("blacksnag", vars_))
    return out


BUILDERS = {
    "ocean": build_ocean,
    "rocky": build_rocky,
    "ice": build_ice,
    "lava": build_lava,
    "toxic": build_toxic,
    "crystal": build_crystal,
    "desert": build_desert,
    "storm": build_storm,
    "carbon": build_carbon,
}


def sheet_for(world: str) -> Image.Image:
    bg = GROUND[world]
    if world == "gas":
        W, H = 320, 80
        im = Image.new("RGBA", (W, H), (*bg, 255))
        ImageDraw.Draw(im).text((12, 30), "gas — no surface vegetation", fill=(180, 190, 210, 255))
        return im

    kinds = BUILDERS[world]()
    pal = PALS[world]
    n = len(kinds)
    cell_px = CELL * SCALE
    W = GAP + n * (2 * (cell_px + GAP))
    H = LABEL_H + GAP + cell_px + GAP
    im = Image.new("RGBA", (W, H), (*bg, 255))
    dr = ImageDraw.Draw(im)
    dr.text((4, 1), world, fill=(240, 240, 240, 255))
    x = GAP
    for name, vars_ in kinds:
        for v in vars_:
            spr = up(paint(v, pal))
            # ground pad
            pad = Image.new("RGBA", (spr.width + 4, spr.height + 4), (*bg, 255))
            pad.paste(spr, (2, 2), spr)
            im.alpha_composite(pad, (x, LABEL_H + GAP))
            x += pad.width + GAP
        x += GAP
    return im


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    worlds = list(BUILDERS.keys()) + ["gas"]
    panels = [sheet_for(w) for w in worlds]
    # mega sheet stacked
    W = max(p.width for p in panels)
    H = sum(p.height for p in panels) + GAP * (len(panels) - 1)
    mega = Image.new("RGBA", (W, H), (12, 10, 16, 255))
    y = 0
    for p in panels:
        mega.paste(p, (0, y))
        p.save(OUT / f"{worlds[panels.index(p)]}.png")
        y += p.height + GAP
    mega.save(OUT / "all_worlds.png")
    # also a grove strip: one hero kind per world on dark
    hero = Image.new("RGBA", (GAP + len(BUILDERS) * (cell := CELL * 5 + GAP), cell + LABEL_H + GAP), (12, 10, 16, 255))
    x = GAP
    for w, builder in BUILDERS.items():
        kinds = builder()
        spr = up(paint(kinds[0][1][0], PALS[w]), 5)
        pad = Image.new("RGBA", (spr.width + 6, spr.height + 6), (*GROUND[w], 255))
        pad.paste(spr, (3, 3), spr)
        hero.alpha_composite(pad, (x, LABEL_H))
        ImageDraw.Draw(hero).text((x, 1), w[:4], fill=(220, 220, 220, 255))
        x += pad.width + GAP
    hero.save(OUT / "heroes.png")
    print(f"wrote {OUT} ({len(worlds)} worlds)")


if __name__ == "__main__":
    main()
