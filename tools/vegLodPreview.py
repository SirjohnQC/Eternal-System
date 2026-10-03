"""
Vegetation LOD targets — zoom 1 / 2 / 4.

The live engine nearest-neighbour-fattens the 16px atlas by round(k).
This file authors the SAME plants at 16, 32 and 48 px so each zoom
band adds structure, not just bigger pixels.

Not wired into the game.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vegTargetAtlas import (  # type: ignore
    CELL, FOREST, OUT, PINE, SPRITES, blit, label, paint, upscale,
)

GRASS = (58, 118, 52, 255)
DIRT = (92, 70, 42, 255)


def _rgba(pal: dict, ch: str) -> tuple[int, int, int, int]:
    return pal[ch]


def _put(px, w: int, h: int, x: int, y: int, c: tuple[int, int, int, int]) -> None:
    if 0 <= x < w and 0 <= y < h and c[3]:
        px[x, y] = c


def _hash(x: int, y: int, s: int) -> float:
    n = (x * 374761393 + y * 668265263 + s * 1442695041) & 0xFFFFFFFF
    n = (n ^ (n >> 13)) * 1274126177 & 0xFFFFFFFF
    return (n ^ (n >> 16)) / 4294967296


def _ramp(pal: dict, keys: str, t: float):
    t = 0 if t < 0 else 1 if t > 1 else t
    i = t * (len(keys) - 1)
    a = int(i)
    return pal[keys[min(a, len(keys) - 1)]]


def _lit(nx: float, ny: float) -> float:
    """0..1 lighting, key from top-left."""
    return 0.48 + 0.42 * max(-1.0, min(1.0, -nx * 0.55 - ny * 0.75))


def _ellipse(px, w, h, cx, cy, rx, ry, pal, keys, seed, dither=False, hole=None):
    rx, ry = max(1, rx), max(1, ry)
    for y in range(int(cy - ry - 1), int(cy + ry + 2)):
        for x in range(int(cx - rx - 1), int(cx + rx + 2)):
            if hole and (x - hole[0]) ** 2 / (hole[2] ** 2) + (y - hole[1]) ** 2 / (hole[3] ** 2) <= 1:
                continue
            nx = (x - cx) / rx
            ny = (y - cy) / ry
            d = nx * nx + ny * ny
            if d > 1.05:
                continue
            if d > 0.86:
                # scallop the rim so it is not a perfect oval
                if _hash(x, y, seed) > 0.55:
                    continue
            t = _lit(nx, ny)
            if dither and _hash(x, y, seed + 3) > 0.72:
                t -= 0.12
            # darker toward the bottom of the clump
            t -= 0.18 * max(0, ny)
            _put(px, w, h, x, y, _ramp(pal, keys, t))


def _trunk(px, w, h, x0, y0, x1, y1, pal, bark=False):
    tw = x1 - x0
    for y in range(y0, y1):
        for x in range(x0, x1):
            u = (x - x0) / max(1, tw - 1)
            if u < 0.25:
                c = pal["u"]
            elif u < 0.7:
                c = pal["T"]
            else:
                c = pal["t"]
            if bark and _hash(x, y, 41) > 0.82:
                c = pal["t"] if u < 0.6 else pal["r"]
            _put(px, w, h, x, y, c)
    # roots
    mid = (x0 + x1) // 2
    _put(px, w, h, mid - 1, y1 - 1, pal["r"])
    _put(px, w, h, mid, y1 - 1, pal["r"])
    if tw >= 3:
        _put(px, w, h, x0 - 1, y1 - 1, pal["r"])
        _put(px, w, h, x1, y1 - 1, pal["r"])


def _shadow(px, w, h, cx, cy, rx, ry):
    sh = (28, 36, 18, 70)
    for y in range(int(cy - ry), int(cy + ry + 1)):
        for x in range(int(cx - rx), int(cx + rx + 1)):
            nx = (x - cx) / max(1, rx)
            ny = (y - cy) / max(1, ry)
            if nx * nx + ny * ny <= 1 and 0 <= x < w and 0 <= y < h:
                r, g, b, a = px[x, y]
                if a == 0:
                    px[x, y] = (sh[0], sh[1], sh[2], 90)


def _outline(im: Image.Image, pal: dict) -> None:
    """Shadow-side outline only — not a black sticker around the whole sprite."""
    w, h = im.size
    px = im.load()
    dark = pal["k"]
    src = [px[x, y] for y in range(h) for x in range(w)]

    def a_at(x, y):
        if 0 <= x < w and 0 <= y < h:
            return src[y * w + x][3]
        return 0

    for y in range(h):
        for x in range(w):
            if src[y * w + x][3] == 0:
                continue
            # only outline where the empty neighbor is down or right (away from light)
            if a_at(x + 1, y) == 0 or a_at(x, y + 1) == 0:
                px[x, y] = dark


def _branch(px, w, h, x0, y0, x1, y1, pal):
    dx, dy = x1 - x0, y1 - y0
    n = max(abs(dx), abs(dy), 1)
    for i in range(n + 1):
        x = x0 + round(dx * i / n)
        y = y0 + round(dy * i / n)
        _put(px, w, h, x, y, pal["T"])
        _put(px, w, h, x, y + 1, pal["t"])


def _from16(kind: str, variant: int, n: int) -> Image.Image:
    """Keep the authored 16px silhouette; higher LODs only add pixels."""
    grids, pal = SPRITES[kind]
    return upscale(paint(grids[variant], pal), n // 16)


def _refine_common(im: Image.Image, pal: dict, n: int, kind: str, variant: int) -> Image.Image:
    px = im.load()
    w, h = im.size
    # Find trunk column from the 16px core (brown-ish pixels in the lower third).
    browns = []
    for y in range(h * 2 // 3, h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a and r > g and r > 40:
                browns.append((x, y))
    if browns:
        xs = [p[0] for p in browns]
        x0, x1 = min(xs), max(xs)
        y0 = min(p[1] for p in browns)
        # thicken trunk toward the light
        if n >= 32:
            for x, y in list(browns):
                if x == x0:
                    _put(px, w, h, x - 1, y, pal["u"])
        if n >= 48:
            for y in range(y0, h - 1):
                if _hash(x0, y, 41) > 0.75:
                    _put(px, w, h, x0, y, pal["t"])
                if _hash(x1, y, 42) > 0.8:
                    _put(px, w, h, x1, y, pal["r"])
            # roots
            mid = (x0 + x1) // 2
            _put(px, w, h, mid - 2, h - 1, pal["r"])
            _put(px, w, h, mid + 2, h - 1, pal["r"])

    # A new lobe that only exists past planet-scale — still a cluster, not a new oval.
    if kind == "broadleaf" and n >= 32:
        ox = w // 2 + (7 if n == 32 else 11)
        oy = h // 3 + 2
        _ellipse(px, w, h, ox, oy, 4.2 if n == 32 else 6.5, 3.4 if n == 32 else 5.2,
                 pal, "dsmlhe", 50 + variant, dither=n >= 48)
    if kind == "conifer" and n >= 32:
        # extra lowest skirt, attached to the existing body
        _ellipse(px, w, h, w // 2, int(h * 0.52), 6 if n == 32 else 8, 2.8 if n == 32 else 3.8,
                 pal, "dsmlhe", 60 + variant, dither=n >= 48)

    # A 1px sky hole in the 16px core becomes a white wound when fattened — close it.
    if n >= 32:
        for y in range(1, h - 1):
            for x in range(1, w - 1):
                if px[x, y][3]:
                    continue
                nfol = 0
                for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    r, g, b, a = px[x + dx, y + dy]
                    if a and g > r:
                        nfol += 1
                if nfol >= 3:
                    px[x, y] = pal["m"]

    # Extra canopy pixels on the rim — clusters, not a new oval.
    extras = 8 if n == 32 else 12
    for i in range(extras):
        x = int(_hash(i, variant, 7) * w)
        y = int(_hash(i, variant, 8) * (h * 0.62))
        r, g, b, a = px[x, y] if 0 <= x < w and 0 <= y < h else (0, 0, 0, 0)
        if a == 0:
            # only grow off an existing foliage pixel
            grow = False
            for dx, dy in ((-1, 0), (1, 0), (0, 1), (0, -1)):
                xx, yy = x + dx, y + dy
                if 0 <= xx < w and 0 <= yy < h and px[xx, yy][3] and px[xx, yy][1] > px[xx, yy][0]:
                    grow = True
                    break
            if grow:
                t = _lit((x / w) * 2 - 1, (y / h) * 2 - 1)
                _put(px, w, h, x, y, _ramp(pal, "dsmlhe", t))

    if n >= 48:
        # dither a few midtones so the canopy is not a flat upscale
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a and g > r and _hash(x, y, 19) > 0.84:
                    px[x, y] = pal["s"] if g > 80 else pal["m"]
        # cast shadow to the right of the base
        for dx in range(2, 9):
            x, y = w // 2 + dx, h - 1
            if 0 <= x < w:
                _put(px, w, h, x, y, (32, 42, 20, 120))
        # grass at the roots
        for gx in range(w // 2 - 5, w // 2 + 6):
            if _hash(gx, 1, 21) > 0.4:
                _put(px, w, h, gx, h - 1, (40, 86, 32, 255))
                if _hash(gx, 2, 22) > 0.65:
                    _put(px, w, h, gx, h - 2, (72, 124, 48, 255))

    if kind == "broadleaf" and n >= 48 and variant == 1:
        # berries only resolve at tree-scale zoom
        for bx, by in ((w // 2 - 4, h // 3), (w // 2 + 5, h // 3 + 3), (w // 2 + 1, h // 3 - 4)):
            if 0 <= bx < w and 0 <= by < h and px[bx, by][3]:
                px[bx, by] = pal["b"]

    if kind == "conifer" and n >= 48:
        # a short branch stub out of the lower skirt
        cx = w // 2
        by = int(h * 0.62)
        _branch(px, w, h, cx + 3, by, cx + 8, by - 3, pal)

    return im


def conifer_lod(n: int, variant: int) -> Image.Image:
    if n == 16:
        return paint(SPRITES["conifer"][0][variant], SPRITES["conifer"][1])
    return _refine_common(_from16("conifer", variant, n), PINE, n, "conifer", variant)


def broadleaf_lod(n: int, variant: int) -> Image.Image:
    if n == 16:
        return paint(SPRITES["broadleaf"][0][variant], SPRITES["broadleaf"][1])
    return _refine_common(_from16("broadleaf", variant, n), FOREST, n, "broadleaf", variant)


def scrub_lod(n: int, variant: int) -> Image.Image:
    if n == 16:
        return paint(SPRITES["scrub"][0][variant], SPRITES["scrub"][1])
    return _refine_common(_from16("scrub", variant, n), FOREST, n, "scrub", variant)


PAINT = {
    "conifer": conifer_lod,
    "broadleaf": broadleaf_lod,
    "scrub": scrub_lod,
}


def on_grass(spr: Image.Image) -> Image.Image:
    bg = Image.new("RGBA", spr.size, GRASS)
    bg.alpha_composite(spr)
    return bg


def lod_compare_sheet() -> Image.Image:
    """Row per plant: fat 16px vs authored 16 / 32 / 48."""
    kinds = ("conifer", "broadleaf", "scrub")
    sizes = (16, 32, 48)
    pad, gap, header = 12, 10, 20
    col_w = 48 + 8
    # 2 groups of 3 sizes: FAT | AUTHORED
    group_w = 3 * col_w + 20
    W = pad * 2 + group_w * 2 + 24
    H = pad * 2 + header + 3 * (48 + 16)
    im = Image.new("RGBA", (W, H), (12, 10, 16, 255))
    label(im, "NOW - 16PX FATTENED", pad, pad)
    label(im, "TARGET - NEW PIXELS PER ZOOM", pad + group_w + 24, pad)
    for row, kind in enumerate(kinds):
        y = pad + header + row * (48 + 16)
        src16 = PAINT[kind](16, 1)
        for i, n in enumerate(sizes):
            fat = on_grass(upscale(src16, n // 16))
            x0 = pad + i * col_w + (48 - n) // 2
            blit(im, fat, x0, y + (48 - n))
            authored = on_grass(PAINT[kind](n, 1))
            x1 = pad + group_w + 24 + i * col_w + (48 - n) // 2
            blit(im, authored, x1, y + (48 - n))
        label(im, kind, pad, y + 50, (160, 150, 130, 255))
    return im


def zoom_bands_hero() -> Image.Image:
    """One broadleaf, three zoom bands, labeled as the player would see them."""
    titles = ("ZOOM 1  PLANET", "ZOOM 2  GROVE", "ZOOM 4  TREE")
    sizes = (16, 32, 48)
    scale_up = (6, 4, 3)  # display sizes ~96 / 128 / 144
    pad = 16
    cells = [upscale(on_grass(broadleaf_lod(n, 1)), s) for n, s in zip(sizes, scale_up)]
    W = pad * 4 + sum(c.width for c in cells)
    H = pad * 3 + 14 + max(c.height for c in cells)
    im = Image.new("RGBA", (W, H), (12, 10, 16, 255))
    x = pad
    for title, cell in zip(titles, cells):
        label(im, title, x, pad)
        blit(im, cell, x, pad + 14)
        x += cell.width + pad
    return im


def clearing_zoom() -> Image.Image:
    """The same three plants at the path edge, rebuilt at each LOD."""
    # world positions of a small cluster (in 16px-world units)
    plants = [
        ("broadleaf", 1, 18, 28),
        ("conifer", 0, 30, 32),
        ("scrub", 1, 40, 34),
        ("broadleaf", 0, 8, 36),
        ("scrub", 0, 24, 38),
        ("conifer", 1, 46, 40),
    ]
    panels = []
    for n, label_s in ((16, "Z1"), (32, "Z2"), (48, "Z4")):
        k = n / 16
        W, H = int(56 * k), int(44 * k)
        panel = Image.new("RGBA", (W, H), GRASS)
        px = panel.load()
        # dirt path
        for y in range(H):
            cx = int(W * 0.55 + (y / max(1, H - 1) - 0.5) * 4 * k)
            for dx in range(-int(3 * k), int(3 * k) + 1):
                x = cx + dx
                if 0 <= x < W:
                    px[x, y] = DIRT if abs(dx) < 2 * k else (72, 52, 32, 255)
        # grass speckle
        for y in range(H):
            for x in range(W):
                if px[x, y] == GRASS and _hash(x, y, 3) > 0.88:
                    px[x, y] = (48, 96, 40, 255)
        placed = []
        for kind, v, wx, wy in plants:
            placed.append((kind, v, int(wx * k), int(wy * k)))
        placed.sort(key=lambda p: p[3])
        for kind, v, ax, ay in placed:
            spr = PAINT[kind](n, v)
            blit(panel, spr, ax - n // 2, ay - (n - 2))
        panels.append((label_s, panel))

    # display: z1 x5, z2 x3, z4 x2 so they read at similar on-screen size
    shown = [
        (t, upscale(p, s))
        for (t, p), s in zip(panels, (5, 3, 2))
    ]
    pad = 14
    W = pad * 4 + sum(p.width for _, p in shown)
    H = pad * 3 + 12 + max(p.height for _, p in shown)
    im = Image.new("RGBA", (W, H), (12, 10, 16, 255))
    x = pad
    names = ("ZOOM 1", "ZOOM 2", "ZOOM 4")
    for name, (_, panel) in zip(names, shown):
        label(im, name, x, pad)
        blit(im, panel, x, pad + 12)
        x += panel.width + pad
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    lod_compare_sheet().save(OUT / "lod_fat_vs_authored.png")
    zoom_bands_hero().save(OUT / "lod_hero_broadleaf.png")
    clearing_zoom().save(OUT / "lod_clearing.png")
    # also dump the raw lod sprites for inspection
    sheet = Image.new("RGBA", (16 + 32 + 48 + 16, 48 * 3 + 8), (0, 0, 0, 0))
    for i, kind in enumerate(("conifer", "broadleaf", "scrub")):
        x = 0
        for n in (16, 32, 48):
            blit(sheet, PAINT[kind](n, 1), x, i * 48 + (48 - n))
            x += n + 4
    upscale(sheet, 4).save(OUT / "lod_sprites_x4.png")
    print(f"wrote LOD previews to {OUT}")


if __name__ == "__main__":
    main()
