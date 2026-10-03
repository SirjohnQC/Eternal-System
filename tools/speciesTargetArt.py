"""
Species TARGET art — Step 1 of the creature rework.

Shows the live baker (what the diorama draws today) against hand-authored
targets at planet / grove / tree zoom. Not wired into the game.

Budget truth:
  CREATURE_SIZE_PX: microscopic 2 … massive 12 (interior long edge)
  Zoom fattening today: nearest-neighbour × round(zoom) — same problem vegetation had
  Genome axes stay procedural — these targets teach the baker WHAT to aim for
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "renders" / "species-target-2026-10-01"
LIVE = Path(__file__).resolve().parents[1] / "renders" / "veg-baker-2026-10-01" / "species_live_sheet.png"

# Shared creature palette — hue-shifted shadows (cool) / highlights (warm)
PAL = {
    ".": (0, 0, 0, 0),
    "k": (18, 12, 22, 255),       # outline
    "d": (48, 28, 36, 255),       # deep shadow
    "s": (78, 42, 38, 255),       # shadow (cool red-brown)
    "m": (118, 72, 48, 255),      # mid body
    "l": (168, 112, 70, 255),     # light
    "h": (220, 168, 110, 255),    # highlight
    "e": (245, 220, 180, 255),    # rim / belly
    "w": (240, 236, 230, 255),    # eye white
    "p": (12, 8, 14, 255),        # pupil
    "g": (80, 220, 200, 255),     # glow / deep-sea
    "y": (255, 210, 70, 255),     # tip / beak accent
    "r": (220, 48, 48, 255),      # aggression eye
    "c": (60, 140, 90, 255),      # photosynthetic tint
    "b": (90, 70, 160, 255),      # chemosynthetic tint
    "a": (40, 90, 140, 255),      # aquatic cool mid
    "A": (70, 140, 180, 255),     # aquatic light
    "f": (200, 90, 50, 255),      # membrane / fin
}


def paint(rows: list[str], pal=PAL) -> Image.Image:
    h, w = len(rows), max(len(r) for r in rows)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = im.load()
    for y, row in enumerate(rows):
        row = row.ljust(w, ".")
        for x, ch in enumerate(row):
            px[x, y] = pal.get(ch, pal["."])
    return im


def up(im: Image.Image, n: int) -> Image.Image:
    return im.resize((im.width * n, im.height * n), Image.Resampling.NEAREST)


def on_bg(im: Image.Image, color=(42, 78, 48, 255), pad=2) -> Image.Image:
    bg = Image.new("RGBA", (im.width + pad * 2, im.height + pad * 2), color)
    bg.alpha_composite(im, (pad, pad))
    return bg


# ── Planet zoom (≈ medium 7–9 px interior, drawn ~9–11 with outline) ──────────
# Readable silhouette + 1 eye. No limbs thinner than 1px.

WALKER_Z1 = [
    "...kkkk...",
    "..klhmsk..",
    ".ksmhhmsk.",
    "..kmmmsk..",
    "...kmsk...",
    "..ks.sk...",
    "..k...k...",
    ".kk...kk..",
]
BIPED_Z1 = [
    "...kkk....",
    "..klhpk...",
    "...kmsk...",
    "..ksmmskk.",
    ".k.kmmk.k.",
    "...ks.sk..",
    "...k...k..",
    "..kk...kk.",
]
SWIMMER_Z1 = [
    "..........",
    "..kkkAa...",
    ".ksmhAAfk.",
    "k.kmmAAf.k",
    ".ksmdAAfk.",
    "..kkkAa...",
    "..........",
    "..........",
]
FLYER_Z1 = [
    "kk.....kk.",
    ".kklhkk.k.",
    "..ksmsk...",
    "...kmk....",
    "...ksk....",
    "....k.....",
    "..........",
    "..........",
]
CRAWLER_Z1 = [
    "..........",
    ".kkkkkkk..",
    "ksmlhmssk.",
    "kssmmmssk.",
    ".k.k.k.k..",
    "..........",
    "..........",
    "..........",
]
SESSILE_Z1 = [
    "...kkk....",
    "..klhmk...",
    "..ksmmskk.",
    "...kmsk...",
    "....k.....",
    "....k.....",
    "...kkk....",
    "..k...k...",
]

# ── Grove zoom (~2×) — limbs, belly, face ─────────────────────────────────────

WALKER_Z2 = [
    "......kkkkkk......",
    ".....klhhmsk......",
    "....ksmhwhmssk....",
    "....ksmmmmmsk.....",
    ".....kemmmske.....",
    "......kmmmsk......",
    ".....ks.k.sk......",
    "....ks...k.sk.....",
    "....k.....k.......",
    "...kk.....kk......",
    "..k.k.....k.k.....",
    "..................",
]
BIPED_Z2 = [
    "......kkk.........",
    ".....klhpk........",
    ".....ksmsk........",
    "......kmk.........",
    "....kkmmmkk.......",
    "...k.esmmse.k.....",
    "...k..kmmk..k.....",
    "......ks.sk.......",
    "......k...k.......",
    ".....kk...kk......",
    "....k.k...k.k.....",
    "..................",
]
SWIMMER_Z2 = [
    "..................",
    "....kkkkAAa.......",
    "...ksmhhwAAfk.....",
    "..k.kmmmAAAffk....",
    ".kk.kemmAAAff.k...",
    "..k.ksmdAAAfkk....",
    "...kkk.kAAa.......",
    "......k...........",
    "..................",
    "..................",
    "..................",
    "..................",
]
FLYER_Z2 = [
    "kkk..........kkk..",
    ".kklhkk....kk.k...",
    "..ksmhssk.k.......",
    "...kemmsk.........",
    "....kmmk..........",
    ".....ksk..........",
    "......k...........",
    "......k...........",
    "..................",
    "..................",
    "..................",
    "..................",
]
CRAWLER_Z2 = [
    "..................",
    "..kkkkkkkkkk......",
    ".ksmlhhmssssk.....",
    "kssmmmmmmssek.....",
    "k.ksdmmmmsk.k.....",
    ".k..k.k.k.k.......",
    "..................",
    "..................",
    "..................",
    "..................",
    "..................",
    "..................",
]
SESSILE_Z2 = [
    ".....kkkkk........",
    "....klhhmssk......",
    "...ksmmmmmsk......",
    "....kemmmske......",
    ".....kmmmsk.......",
    "......kmsk........",
    ".......k..........",
    ".......k..........",
    "......kkk.........",
    ".....k...k........",
    "....k.....k.......",
    "..................",
]

# ── Tree zoom (~3×) — muscle volumes, claws, pupil glint, shell ridges ────────

WALKER_Z3 = [
    "........kkkkkk........",
    ".......klhhhmsk.......",
    "......ksmhwhhmssk.....",
    "......ksmmhmmmssk.....",
    ".....k.kemmmmmske.k...",
    "......kkmmmmmmsk......",
    ".......ksmmmsk........",
    "......ks.kmm.sk.......",
    ".....ks...kk..sk......",
    ".....k.....k...k......",
    "....kk.....k...kk.....",
    "...k.k.....kk..k.k....",
    "..k........k....k.....",
    "......................",
    "......................",
    "......................",
]
BIPED_Z3 = [
    "........kkk...........",
    ".......klhpwk.........",
    ".......ksmhsk.........",
    "........kmsk..........",
    ".......kkmmkk.........",
    ".....k.esmmmse.k......",
    "....k..kkmmmkk..k.....",
    "....k...ks.sk...k.....",
    ".........k...k........",
    "........kk...kk.......",
    ".......k.k...k.k......",
    "......k......k..k.....",
    "......................",
    "......................",
    "......................",
    "......................",
]
SWIMMER_Z3 = [
    "......................",
    "......kkkkAAAa........",
    ".....ksmhhwAAAfk......",
    "....k.kmmmAAAAffk.....",
    "...kk.kemmAAAAfffk....",
    "...k..ksmdAAAAff.k....",
    "....k.kkk.kAAAfkk.....",
    ".....kkk...AAa........",
    ".......k..............",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
]
FLYER_Z3 = [
    "kkkk............kkkk..",
    ".kklhhkk......kk.k.k..",
    "..ksmhhmssk..k........",
    "...kemmmmssk..........",
    "....kkmmmsk...........",
    ".....ksmmk............",
    "......kmsk............",
    ".......ksk............",
    "........k.............",
    "........k.............",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
]
CRAWLER_Z3 = [
    "......................",
    "...kkkkkkkkkkkk.......",
    "..ksmlhhhhmssssk......",
    ".kssmmmhmmmmssek......",
    "k.ksdmmmmmmsk..k......",
    "k..kssmmmssk...k......",
    ".k..k.k.k.k.k.........",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
]
SESSILE_Z3 = [
    ".......kkkkk..........",
    "......klhhhmssk.......",
    ".....ksmmhmmmssk......",
    "......kemmmmske.......",
    ".......kmmmmsk........",
    "........kmmsk.........",
    ".........kmsk.........",
    "..........k...........",
    "..........k...........",
    "..........k...........",
    ".........kkk..........",
    "........k...k.........",
    ".......k.....k........",
    "......................",
    "......................",
    "......................",
]

ARCHETYPES = [
    ("walker", WALKER_Z1, WALKER_Z2, WALKER_Z3),
    ("biped", BIPED_Z1, BIPED_Z2, BIPED_Z3),
    ("swimmer", SWIMMER_Z1, SWIMMER_Z2, SWIMMER_Z3),
    ("flyer", FLYER_Z1, FLYER_Z2, FLYER_Z3),
    ("crawler", CRAWLER_Z1, CRAWLER_Z2, CRAWLER_Z3),
    ("sessile", SESSILE_Z1, SESSILE_Z2, SESSILE_Z3),
]


def tiny_label(im: Image.Image, text: str, x: int, y: int, color=(210, 200, 170, 255)) -> None:
    # Minimal 3×5 — only letters we need
    F = {
        "A": ["010", "101", "111", "101", "101"],
        "B": ["110", "101", "110", "101", "110"],
        "C": ["011", "100", "100", "100", "011"],
        "D": ["110", "101", "101", "101", "110"],
        "E": ["111", "100", "110", "100", "111"],
        "F": ["111", "100", "110", "100", "100"],
        "G": ["011", "100", "101", "101", "011"],
        "I": ["111", "010", "010", "010", "111"],
        "K": ["101", "101", "110", "101", "101"],
        "L": ["100", "100", "100", "100", "111"],
        "M": ["101", "111", "111", "101", "101"],
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
        "Z": ["111", "001", "010", "100", "111"],
        "1": ["010", "110", "010", "010", "111"],
        "2": ["110", "001", "010", "100", "111"],
        "4": ["101", "101", "111", "001", "001"],
        " ": ["000", "000", "000", "000", "000"],
        "/": ["001", "001", "010", "100", "100"],
        "-": ["000", "000", "111", "000", "000"],
    }
    px = im.load()
    cx = x
    for ch in text.upper():
        g = F.get(ch, F[" "])
        for yy, row in enumerate(g):
            for xx, bit in enumerate(row):
                if bit == "1" and 0 <= cx + xx < im.width and 0 <= y + yy < im.height:
                    px[cx + xx, y + yy] = color
        cx += 4


def sheet_targets() -> Image.Image:
    """Rows = archetypes, cols = Z1 / Z2 / Z4 authored."""
    scale = (8, 5, 4)  # display each band at similar on-screen size
    cell_h = 16 * 4 + 24
    pad = 14
    W = pad * 2 + 8 * 8 + 12 * 5 + 16 * 4 + 40
    H = pad * 2 + 18 + len(ARCHETYPES) * cell_h
    im = Image.new("RGBA", (W, H), (12, 10, 16, 255))
    tiny_label(im, "TARGET PLANET Z1", pad, pad)
    tiny_label(im, "GROVE Z2", pad + 8 * 8 + 20, pad)
    tiny_label(im, "TREE Z4", pad + 8 * 8 + 12 * 5 + 40, pad)
    for i, (name, z1, z2, z3) in enumerate(ARCHETYPES):
        y = pad + 18 + i * cell_h
        tiny_label(im, name, pad, y, (160, 150, 130, 255))
        imgs = [paint(z1), paint(z2), paint(z3)]
        x = pad
        for spr, sc in zip(imgs, scale):
            cell = on_bg(up(spr, sc))
            im.alpha_composite(cell, (x, y + 10))
            x += cell.width + 12
    return im


def lod_hero(name: str, z1, z2, z3) -> Image.Image:
    titles = ("ZOOM 1  PLANET", "ZOOM 2  GROVE", "ZOOM 4  TREE")
    scales = (8, 5, 4)
    cells = [on_bg(up(paint(z), s)) for z, s in zip((z1, z2, z3), scales)]
    pad = 14
    W = pad * 4 + sum(c.width for c in cells)
    H = pad * 3 + 14 + max(c.height for c in cells)
    im = Image.new("RGBA", (W, H), (12, 10, 16, 255))
    x = pad
    for title, cell in zip(titles, cells):
        tiny_label(im, title, x, pad)
        im.alpha_composite(cell, (x, pad + 14))
        x += cell.width + pad
    return im


def fat_vs_authored(name: str, z1, z2, z3) -> Image.Image:
    """Left: 7px target fattened (what the engine does today). Right: authored LOD."""
    base = paint(z1)
    pad = 12
    scales_fat = (1, 2, 4)
    scales_auth = (8, 5, 4)  # display
    auth = [paint(z1), paint(z2), paint(z3)]
    # Make display rows
    fat_cells = [on_bg(up(base, 8 * s // 1 if s == 1 else (5 if s == 2 else 4) * s)) for s in scales_fat]
    # clearer: fatten then upscale for viewing
    fat_view = []
    for s, view in ((1, 8), (2, 5), (4, 3)):
        fat_view.append(on_bg(up(up(base, s), view)))
    auth_view = [on_bg(up(a, sc)) for a, sc in zip(auth, (8, 5, 3))]
    W = pad * 3 + sum(c.width for c in fat_view) + 20 + sum(c.width for c in auth_view)
    H = pad * 3 + 16 + max(c.height for c in fat_view + auth_view)
    im = Image.new("RGBA", (W, H), (12, 10, 16, 255))
    tiny_label(im, "NOW - FATTEN " + name.upper(), pad, pad)
    tiny_label(im, "TARGET - NEW PIXELS", pad + sum(c.width for c in fat_view) + 28, pad)
    x = pad
    for c in fat_view:
        im.alpha_composite(c, (x, pad + 16))
        x += c.width + 6
    x += 14
    for c in auth_view:
        im.alpha_composite(c, (x, pad + 16))
        x += c.width + 6
    return im


def herd_scene() -> Image.Image:
    """A few creatures on grass — planet scale composition."""
    W, H = 160, 72
    im = Image.new("RGBA", (W, H), (48, 92, 42, 255))
    px = im.load()
    for y in range(H):
        for x in range(W):
            if (x * 17 + y * 31) % 23 == 0:
                px[x, y] = (40, 78, 34, 255)
    # dirt patch
    for y in range(30, 55):
        for x in range(70, 95):
            if abs(x - 82) + abs(y - 42) < 14:
                px[x, y] = (92, 70, 42, 255)

    def stamp(rows, ax, ay):
        spr = paint(rows)
        im.alpha_composite(spr, (ax - spr.width // 2, ay - spr.height + 1))

    # back row
    stamp(WALKER_Z1, 28, 28)
    stamp(WALKER_Z1, 48, 26)
    stamp(BIPED_Z1, 100, 30)
    stamp(SESSILE_Z1, 130, 32)
    # mid
    stamp(CRAWLER_Z1, 36, 44)
    stamp(WALKER_Z1, 60, 46)
    stamp(FLYER_Z1, 88, 38)
    stamp(SWIMMER_Z1, 20, 58)  # near "shore" edge
    # front
    stamp(BIPED_Z1, 110, 58)
    stamp(WALKER_Z1, 75, 60)
    stamp(CRAWLER_Z1, 140, 55)
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    sheet_targets().save(OUT / "targets_sheet.png")
    lod_hero("walker", *ARCHETYPES[0][1:]).save(OUT / "hero_walker.png")
    lod_hero("biped", *ARCHETYPES[1][1:]).save(OUT / "hero_biped.png")
    lod_hero("swimmer", *ARCHETYPES[2][1:]).save(OUT / "hero_swimmer.png")
    fat_vs_authored("walker", *ARCHETYPES[0][1:]).save(OUT / "fat_vs_authored_walker.png")
    fat_vs_authored("biped", *ARCHETYPES[1][1:]).save(OUT / "fat_vs_authored_biped.png")
    herd = herd_scene()
    herd.save(OUT / "herd_1x.png")
    up(herd, 5).save(OUT / "herd_x5.png")
    if LIVE.exists():
        live = Image.open(LIVE).convert("RGBA")
        # crop a readable strip from the contact sheet if huge
        live.save(OUT / "live_baker_sheet.png")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
