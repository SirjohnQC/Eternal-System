"""
Vegetation TARGET art — Step 1 only.

Hand-authored 16x16 pixel trees/scrub/cacti/rocks at the diorama's real cell
size. Not wired into the game. Renders a comparison against the live lighting
atlas and a grove composition so the look can be judged before any baker work.

Light is top-left. Palettes are hue-shifted ramps (cool shadows, warm lights).
No anti-aliasing. Transparent outside the silhouette.
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "renders" / "veg-target-2026-10-01"
LIVE_ATLAS = ROOT / "assets" / "pixel" / "decals" / "decals.png"

CELL = 16
KINDS = ("conifer", "broadleaf", "scrub", "cactus", "rock")

# ── Palettes ──────────────────────────────────────────────────────────────────
# Keys are one character in the sprite grids.
FOREST = {
    ".": (0, 0, 0, 0),
    "k": (22, 32, 16, 255),       # outline — dark green, not black sticker
    "d": (24, 46, 22, 255),       # deep (cool)
    "s": (32, 68, 28, 255),       # shadow
    "m": (48, 98, 36, 255),       # mid
    "l": (78, 128, 46, 255),      # light (warm)
    "h": (126, 164, 68, 255),     # highlight
    "e": (178, 192, 102, 255),    # rim
    "t": (42, 28, 16, 255),       # trunk dark
    "T": (72, 50, 30, 255),       # trunk
    "u": (104, 76, 44, 255),      # trunk light
    "r": (58, 40, 24, 255),       # root
    "b": (156, 48, 52, 255),      # berry
    "y": (196, 168, 64, 255),     # flower
}

PINE = {
    **FOREST,
    "k": (18, 34, 22, 255),       # cooler outline
    "d": (20, 42, 28, 255),       # cooler, more blue-green
    "s": (28, 62, 34, 255),
    "m": (40, 88, 42, 255),
    "l": (64, 114, 50, 255),
    "h": (108, 148, 70, 255),
    "e": (160, 180, 96, 255),
}

ARID = {
    ".": (0, 0, 0, 0),
    "k": (36, 34, 16, 255),       # olive outline
    "d": (46, 52, 22, 255),
    "s": (62, 72, 28, 255),
    "m": (86, 98, 36, 255),
    "l": (118, 128, 48, 255),
    "h": (156, 160, 72, 255),
    "e": (198, 188, 110, 255),
    "t": (58, 40, 22, 255),
    "T": (88, 62, 32, 255),
    "u": (122, 90, 48, 255),
    "p": (186, 170, 120, 255),    # spine
    "b": (164, 56, 40, 255),
}

STONE = {
    ".": (0, 0, 0, 0),
    "k": (36, 34, 32, 255),       # stone outline, not black
    "d": (44, 46, 50, 255),       # cool shadow
    "s": (62, 62, 64, 255),
    "m": (96, 92, 86, 255),
    "l": (138, 130, 118, 255),
    "h": (188, 178, 156, 255),    # warm highlight
    "e": (220, 210, 186, 255),
    "n": (72, 58, 46, 255),       # lichen / dirt
    "g": (70, 92, 48, 255),       # moss
}

def _rows(*lines: str) -> list[str]:
    out = []
    for ln in lines:
        if len(ln) != CELL:
            raise ValueError(f"row width {len(ln)} != {CELL}: {ln!r}")
        out.append(ln)
    if len(out) != CELL:
        raise ValueError(f"row count {len(out)} != {CELL}")
    return out


# ── Sprites. Each is 16 lines of 16 chars. Anchor is the bottom centre. ──────
# Conifers are TIERED (stacked skirts), not diamonds. Outline is the canopy's
# own dark, not a black sticker. Trunks are 2px with a lit left edge.

CONIFER = [
    # young — three stacked skirts, narrow
    _rows(
        ".......kk.......",
        "......kehk......",
        ".....klhmlk.....",
        "......kmsk......",
        ".....klhmlk.....",
        "....klhmlmsk....",
        ".....kslmsk.....",
        "....klhmlmlk....",
        "...kslhmlmlsk...",
        "....kdssmlsk....",
        ".....kdssdk.....",
        ".......uT.......",
        ".......kT.......",
        ".......kT.......",
        "......kTTk......",
        ".......rr.......",
    ),
    # mature — four skirts, irregular right edge, denser
    _rows(
        ".......kk.......",
        "......kehk......",
        ".....klhmlk.....",
        "....klhmlmsk....",
        ".....klmlsk.....",
        "....klhmlmlk....",
        "...kslhmlmlsk...",
        "....kmlhmlsk....",
        "...klhmlmlmsk...",
        "..kslhmlmlmlsk..",
        "...kdssmlssdk...",
        "....kdssssdk....",
        ".......uT.......",
        ".......kT.......",
        "......kTTk......",
        "......krrk......",
    ),
    # old — broken tip, wide skirt, one canopy gap, thicker trunk
    _rows(
        "........k.......",
        "......kmlk......",
        ".....klh.sk.....",
        "....klhmlmsk....",
        "...kslhmlmlsk...",
        "....kml.mlsk....",
        "...klhmlmlmsk...",
        "..kslhmlmlmlsk..",
        "...kssmlhmlsk...",
        "..kdssmlmlssdk..",
        "...kdsssmlsdk...",
        "....kdssssdk....",
        "......kuTk......",
        ".......kT.......",
        "......kTTTk.....",
        "......krrr......",
    ),
]

BROADLEAF = [
    # round canopy, scalloped edge, warm left rim, 2px trunk
    _rows(
        "......kkkk......",
        "....kkehmlkk....",
        "...klhmlmlmsk...",
        "..kslhmlmlmlsk..",
        ".kdssmlhmlmlssk.",
        "..kssmlhmlmlsk..",
        "..kdssmlmlmlsdk.",
        "...kdssmlmlsdk..",
        "....kdsssssdk...",
        ".....kdsssdk....",
        ".......uT.......",
        ".......kT.......",
        ".......kT.......",
        ".......kT.......",
        "......kTTk......",
        ".......rr.......",
    ),
    # two-lobe oak, berries, slightly wider
    _rows(
        "....kkkk.kkk....",
        "...klhmlklhlk...",
        "..kslhmlmlmlsk..",
        ".kdssmlbmlmlssk.",
        "..kssmlhmlmlsk..",
        ".kdssml.mlmlsdk.",
        "..kdssmlmlssdk..",
        "...kdssmlssdk...",
        "....kdssssdk....",
        ".......uT.......",
        ".......kT.......",
        ".......kT.......",
        ".......kT.......",
        "......kTTk......",
        ".....krTTrk.....",
        ".......rr.......",
    ),
    # spreading, low canopy, heavy left rim
    _rows(
        ".....kkkkkk.....",
        "...kkehmlhlkk...",
        "..klhmlmlmlmsk..",
        ".kslhmlmlmlmlsk.",
        "kdssmlhmlmlmlssk",
        ".kdssmlhmlmlsdk.",
        "..kdssmlmlsssdk.",
        "...kdsssssssdk..",
        "....kdsssssdk...",
        ".....k.ssd.k....",
        ".......uT.......",
        ".......kT.......",
        ".......kT.......",
        "......kTTk......",
        "......krrr......",
        "................",
    ),
]

SCRUB = [
    # single low bush, sits on the ground
    _rows(
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "......kkkkk.....",
        ".....klhmlsk....",
        "....kslhmlssk...",
        "...kdssmlmlsdk..",
        "....kdsssssdk...",
        ".....kdsssdk....",
        "......krrrk.....",
        "................",
    ),
    # berry bush, two lobes sharing a base
    _rows(
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "....kkk..kkk....",
        "...klhsk.lhsk...",
        "..kslbmlslbmsk..",
        ".kdssmlmlmlssdk.",
        "..kdssmlmlssdk..",
        "...kdssssssdk...",
        "....krr..rrk....",
        "................",
        "................",
    ),
    # three tufts, one in front
    _rows(
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "...kkk....kkk...",
        "..klhsk..klhsk..",
        ".kssmsk..dssmsk.",
        ".kdssdk..kdssdk.",
        "..krrk..kkkrrk..",
        "......klhsk.....",
        ".....kssmsk.....",
        ".....kdssdk.....",
        "......krrk......",
    ),
]

CACTUS = [
    # saguaro, left arm joined at the column
    _rows(
        "................",
        "................",
        ".......hlk......",
        "......lmlsk.....",
        "......mlmlk.....",
        "..hlkklmlsk.....",
        ".mlmskmlk.......",
        ".lmsk.kmlk......",
        ".ssdk.kmlk......",
        "..k...kmlk......",
        "......kmlk......",
        "......kmlk......",
        "......kssk......",
        "......kdsk......",
        "......krrk......",
        "................",
    ),
    # two arms, taller, both joined
    _rows(
        "................",
        ".......hlk......",
        "......lmlsk.....",
        "......mlmlk.....",
        "..hlkklmlsk.hlk.",
        ".mlmskmlk..mlsk.",
        ".lmsk.kmlk.lmsk.",
        ".ssdk.kmlk.ssdk.",
        "..k...kmlk..k...",
        "......kmlk......",
        "......kmlk......",
        "......kmlk......",
        "......kssk......",
        "......kdsk......",
        ".....krrrrk.....",
        "................",
    ),
    # barrel
    _rows(
        "................",
        "................",
        "................",
        "................",
        "................",
        "......kkkk......",
        ".....klhmlk.....",
        "....kslhmlsk....",
        "...kdssmlmlsdk..",
        "...kdssmlmlsdk..",
        "....kdssmlsdk...",
        ".....kdsssdk....",
        "......krrrk.....",
        "................",
        "................",
        "................",
    ),
]

ROCK = [
    _rows(
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".......kkk......",
        "......klhmk.....",
        ".....kslmlsk....",
        "....kdssmmlsdk..",
        ".....kdssssdk...",
        "......kddddk....",
        "................",
        "................",
    ),
    _rows(
        "................",
        "................",
        "................",
        "................",
        "................",
        "......kkkkk.....",
        ".....klhmlsk....",
        "....kslhmlmsk...",
        "...kdssmlmlssk..",
        "..kdssmlmlmlsdk.",
        "...kdssssmlsdk..",
        "....kddddssdk...",
        ".....k....kk....",
        "................",
        "................",
        "................",
    ),
    # pair + moss patch
    _rows(
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "....kkk...kkk...",
        "...klhmk.klgmk..",
        "..kslmlskdssmsk.",
        ".kdssmlsdkdsssdk",
        "..kddddk.kddddk.",
        "................",
        "................",
        "................",
        "................",
        "................",
    ),
]

SPRITES: dict[str, tuple[list[list[str]], dict]] = {
    "conifer": (CONIFER, PINE),
    "broadleaf": (BROADLEAF, FOREST),
    "scrub": (SCRUB, FOREST),
    "cactus": (CACTUS, ARID),
    "rock": (ROCK, STONE),
}


def paint(grid: list[str], pal: dict) -> Image.Image:
    im = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    px = im.load()
    for y, row in enumerate(grid):
        row = row.ljust(CELL, ".")[:CELL]
        for x, ch in enumerate(row):
            px[x, y] = pal.get(ch, pal["."])
    return im


def upscale(im: Image.Image, n: int) -> Image.Image:
    return im.resize((im.width * n, im.height * n), Image.Resampling.NEAREST)


def lighting_mask(im: Image.Image) -> Image.Image:
    """Engine atlas format: red = lighting, alpha = shape."""
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    sp, dp = im.load(), out.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = sp[x, y]
            if a == 0:
                continue
            # luminance as lighting; keep a little contrast
            lit = int(0.3 * r + 0.59 * g + 0.11 * b)
            dp[x, y] = (lit, 0, 0, 255)
    return out


def engine_tint(mask: Image.Image, ground: tuple[int, int, int], kind: str) -> Image.Image:
    """Replay SurfaceDecals.stampDecals shade() so the comparison is honest."""
    out = Image.new("RGBA", mask.size, (0, 0, 0, 0))
    sp, dp = mask.load(), out.load()
    ur, ug, ub = ground
    push = 0 if kind == "rock" else 1
    for y in range(mask.height):
        for x in range(mask.width):
            r, g, b, a = sp[x, y]
            if a == 0:
                continue
            t = r / 255
            m = 0.45 + t * 0.42
            cr = max(0, min(255, int(ur * m + (-12 if push else 8))))
            cg = max(0, min(255, int(ug * m + (34 if push else 8))))
            cb = max(0, min(255, int(ub * m + (-10 if push else 10))))
            dp[x, y] = (cr, cg, cb, 255)
    return out


def checker(w: int, h: int, a: tuple, b: tuple, cell: int = 8) -> Image.Image:
    im = Image.new("RGBA", (w, h), a)
    px = im.load()
    for y in range(h):
        for x in range(w):
            if ((x // cell) + (y // cell)) & 1:
                px[x, y] = b
    return im


def blit(dst: Image.Image, src: Image.Image, x: int, y: int) -> None:
    dst.alpha_composite(src, (x, y))


def label(im: Image.Image, text: str, x: int, y: int, color=(220, 214, 196, 255)) -> None:
    # Tiny 3x5 pixel font for a few letters so the sheet is readable without TTF.
    F = {
        "A": ["010", "101", "111", "101", "101"],
        "B": ["110", "101", "110", "101", "110"],
        "C": ["011", "100", "100", "100", "011"],
        "D": ["110", "101", "101", "101", "110"],
        "E": ["111", "100", "110", "100", "111"],
        "F": ["111", "100", "110", "100", "100"],
        "G": ["011", "100", "101", "101", "011"],
        "H": ["101", "101", "111", "101", "101"],
        "I": ["111", "010", "010", "010", "111"],
        "K": ["101", "101", "110", "101", "101"],
        "L": ["100", "100", "100", "100", "111"],
        "N": ["101", "111", "111", "101", "101"],
        "O": ["010", "101", "101", "101", "010"],
        "P": ["110", "101", "110", "100", "100"],
        "R": ["110", "101", "110", "101", "101"],
        "S": ["011", "100", "010", "001", "110"],
        "T": ["111", "010", "010", "010", "010"],
        "U": ["101", "101", "101", "101", "010"],
        "V": ["101", "101", "101", "101", "010"],
        "W": ["101", "101", "111", "111", "101"],
        "Y": ["101", "101", "010", "010", "010"],
        " ": ["000", "000", "000", "000", "000"],
        "-": ["000", "000", "111", "000", "000"],
        "1": ["010", "110", "010", "010", "111"],
        "2": ["110", "001", "010", "100", "111"],
        "3": ["110", "001", "010", "001", "110"],
        "4": ["101", "101", "111", "001", "001"],
        "6": ["011", "100", "110", "101", "010"],
        "8": ["010", "101", "010", "101", "010"],
        "X": ["101", "101", "010", "101", "101"],
    }
    px = im.load()
    cx = x
    for ch in text.upper():
        g = F.get(ch, F[" "])
        for yy, row in enumerate(g):
            for xx, bit in enumerate(row):
                if bit == "1":
                    px[cx + xx, y + yy] = color
        cx += 4


def build_atlas_color() -> Image.Image:
    im = Image.new("RGBA", (CELL * 3, CELL * 5), (0, 0, 0, 0))
    for row, kind in enumerate(KINDS):
        grids, pal = SPRITES[kind]
        for col, grid in enumerate(grids):
            blit(im, paint(grid, pal), col * CELL, row * CELL)
    return im


def build_atlas_mask(color: Image.Image) -> Image.Image:
    return lighting_mask(color)


def sheet_preview(color: Image.Image, mask: Image.Image, live: Image.Image | None) -> Image.Image:
    scale = 6
    pad = 10
    col_w = CELL * scale + 8
    row_h = CELL * scale + 14
    header = 22
    cols = 3
    # color | mask-tinted | live-tinted
    panels = 3 if live is not None else 2
    W = pad * 2 + panels * (cols * col_w + 28) + (panels - 1) * 16
    H = pad * 2 + header + 5 * row_h + 8
    bg = (12, 10, 16, 255)
    im = Image.new("RGBA", (W, H), bg)
    grass = (58, 118, 52)

    titles = ["TARGET COLOR", "TARGET AS ENGINE TINT", "LIVE ATLAS TINT"]
    for p in range(panels):
        ox = pad + p * (cols * col_w + 44)
        label(im, titles[p], ox, pad + 4, (210, 200, 170, 255))
        for row, kind in enumerate(KINDS):
            for col in range(3):
                x = ox + col * col_w
                y = pad + header + row * row_h
                cell_bg = Image.new("RGBA", (CELL * scale, CELL * scale), (*grass, 255))
                blit(im, cell_bg, x, y)
                src_x, src_y = col * CELL, row * CELL
                if p == 0:
                    spr = color.crop((src_x, src_y, src_x + CELL, src_y + CELL))
                    blit(im, upscale(spr, scale), x, y)
                elif p == 1:
                    spr = mask.crop((src_x, src_y, src_x + CELL, src_y + CELL))
                    tinted = engine_tint(spr, grass, kind)
                    blit(im, upscale(tinted, scale), x, y)
                else:
                    spr = live.crop((src_x, src_y, src_x + CELL, src_y + CELL))
                    tinted = engine_tint(spr, grass, kind)
                    blit(im, upscale(tinted, scale), x, y)
            label(im, kind, ox, pad + header + row * row_h + CELL * scale + 2, (160, 150, 130, 255))
    return im


def hash2(x: int, y: int, s: int) -> float:
    n = (x * 374761393 + y * 668265263 + s * 1442695041) & 0xFFFFFFFF
    n = (n ^ (n >> 13)) * 1274126177 & 0xFFFFFFFF
    return (n ^ (n >> 16)) / 4294967296


def grove_scene(color_atlas: Image.Image) -> Image.Image:
    """A woodland patch at native pixels — clustered, overlapping, with a clearing."""
    W, H = 168, 100
    im = Image.new("RGBA", (W, H), (10, 8, 14, 255))
    px = im.load()

    grass_a = (62, 112, 48, 255)
    grass_b = (54, 100, 42, 255)
    grass_c = (46, 88, 36, 255)
    grass_lit = (74, 122, 52, 255)
    dirt = (96, 72, 42, 255)
    dirt_d = (72, 52, 32, 255)
    tuft = (40, 78, 30, 255)
    tuft_l = (88, 132, 54, 255)

    def terrace_y(x: int, base: int) -> int:
        return base + int((hash2(x, base, 2) - 0.5) * 5 + (hash2(x // 6, base, 5) - 0.5) * 4)

    t1 = [terrace_y(x, 36) for x in range(W)]
    t2 = [terrace_y(x, 68) for x in range(W)]

    for y in range(H):
        for x in range(W):
            n = hash2(x, y, 7)
            n2 = hash2(x, y, 13)
            band = 0 if y < t1[x] else 1 if y < t2[x] else 2
            g = (grass_a, grass_b, grass_c)[band]
            if n > 0.78:
                g = grass_b if band == 0 else grass_c
            if n2 > 0.93:
                g = grass_lit
            px[x, y] = g
            if abs(y - t1[x]) == 0 or abs(y - t2[x]) == 0:
                px[x, y] = dirt_d if n < 0.55 else dirt

    # Dirt path through a clearing — wider, worn edges
    for y in range(40, 98):
        cx = int(82 + (y - 40) * 0.12 + (hash2(y, 0, 3) - 0.5) * 6)
        half = 4 + int(hash2(y, 1, 4) * 2)
        for dx in range(-half - 1, half + 2):
            x = cx + dx
            if 0 <= x < W:
                t = abs(dx) / (half + 1)
                if t < 0.7 or hash2(x, y, 9) > 0.4:
                    px[x, y] = dirt if t < 0.45 else dirt_d

    # Lighter grass in the clearing
    for y in range(46, 90):
        for x in range(58, 120):
            if hash2(x, y, 11) > 0.55 and 60 < px[x, y][1] < 130:
                px[x, y] = grass_lit if hash2(x, y, 17) > 0.5 else grass_a

    # Grass tufts — 2-3px, denser at forest edges, none on the path
    for i in range(90):
        tx = int(hash2(i, 1, 21) * W)
        ty = int(8 + hash2(i, 2, 22) * (H - 12))
        if px[tx, ty][0] > 80:  # skip dirt
            continue
        px[tx, ty] = tuft
        if ty > 0:
            px[tx, ty - 1] = tuft_l if hash2(i, 3, 23) > 0.4 else tuft
        if tx + 1 < W and hash2(i, 4, 24) > 0.5:
            px[tx + 1, ty] = tuft

    def stamp(kind: str, variant: int, ax: int, ay: int) -> None:
        grids, pal = SPRITES[kind]
        spr = paint(grids[variant % 3], pal)
        blit(im, spr, ax - 8, ay - 14)

    # Depth-sorted (small y first). Overlapping on purpose — a forest, not a grid.
    plants = [
        # back thicket
        ("conifer", 1, 14, 24), ("broadleaf", 0, 24, 30), ("conifer", 0, 32, 22),
        ("conifer", 2, 42, 28), ("broadleaf", 1, 52, 24), ("conifer", 1, 60, 32),
        ("broadleaf", 2, 70, 26), ("conifer", 0, 80, 22), ("broadleaf", 0, 90, 30),
        ("conifer", 2, 100, 24), ("broadleaf", 1, 110, 28), ("conifer", 1, 122, 22),
        ("broadleaf", 2, 132, 30), ("conifer", 0, 144, 26), ("broadleaf", 0, 154, 22),
        ("conifer", 1, 8, 36), ("scrub", 0, 38, 36), ("scrub", 2, 96, 36),
        # mid — dense left & right, open centre
        ("broadleaf", 1, 18, 48), ("conifer", 2, 10, 56), ("scrub", 1, 30, 52),
        ("broadleaf", 0, 40, 58), ("scrub", 0, 50, 50),
        ("conifer", 0, 126, 50), ("broadleaf", 2, 138, 56), ("scrub", 2, 150, 48),
        ("conifer", 1, 158, 58), ("broadleaf", 1, 148, 64),
        ("scrub", 1, 22, 64), ("conifer", 0, 34, 68),
        ("broadleaf", 2, 154, 72),
        # front — individuals, rocks, path-edge scrub
        ("rock", 2, 56, 76), ("rock", 1, 72, 82), ("scrub", 0, 64, 78),
        ("scrub", 1, 96, 84), ("rock", 0, 104, 88),
        ("broadleaf", 0, 16, 80), ("conifer", 0, 28, 88), ("scrub", 2, 42, 86),
        ("conifer", 1, 158, 84), ("broadleaf", 2, 6, 90), ("scrub", 0, 118, 78),
        ("rock", 0, 88, 92),
    ]
    plants.sort(key=lambda p: p[3])
    for kind, v, x, y in plants:
        stamp(kind, v, x, y)

    return im


def compare_strip(color: Image.Image, mask: Image.Image, live: Image.Image | None) -> Image.Image:
    """Same three trees, current engine look vs authored color, 8x."""
    scale = 8
    grass = (58, 118, 52)
    W, H = 16 * scale * 6 + 40, 16 * scale + 36
    im = Image.new("RGBA", (W, H), (12, 10, 16, 255))
    label(im, "LIVE ENGINE TINT", 8, 6)
    label(im, "TARGET COLOR", 16 * scale * 3 + 24, 6)
    samples = [("conifer", 1), ("broadleaf", 1), ("scrub", 1)]
    for i, (kind, v) in enumerate(samples):
        src = (v * CELL, KINDS.index(kind) * CELL)
        box = (*src, src[0] + CELL, src[1] + CELL)
        ground = Image.new("RGBA", (CELL * scale, CELL * scale), (*grass, 255))
        # live
        x0 = 8 + i * (CELL * scale + 6)
        blit(im, ground, x0, 20)
        if live is not None:
            tinted = engine_tint(live.crop(box), grass, kind)
            blit(im, upscale(tinted, scale), x0, 20)
        # target
        x1 = 16 * scale * 3 + 24 + i * (CELL * scale + 6)
        blit(im, ground, x1, 20)
        blit(im, upscale(color.crop(box), scale), x1, 20)
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    color = build_atlas_color()
    mask = build_atlas_mask(color)
    live = None
    if LIVE_ATLAS.exists():
        live = Image.open(LIVE_ATLAS).convert("RGBA")

    color.save(OUT / "atlas_color.png")
    mask.save(OUT / "atlas_mask.png")
    upscale(color, 8).save(OUT / "atlas_color_x8.png")
    sheet_preview(color, mask, live).save(OUT / "sheet_compare.png")
    grove = grove_scene(color)
    grove.save(OUT / "grove_1x.png")
    upscale(grove, 5).save(OUT / "grove_x5.png")
    compare_strip(color, mask, live).save(OUT / "strip_compare.png")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
