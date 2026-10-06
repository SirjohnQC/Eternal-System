"""Faith Card icons for Eternal System -- one 32x32 RGBA icon per card kind.

Same model as tools/gen_pixel_icons.py: every sprite is a 32x32 grid of palette
characters (PAL, extended below), written as raw PNG bytes. Instead of typing
each grid by hand, sprites are rasterised from a handful of primitives (line,
disc, ellipse, polygon) into the character grid, then given an automatic bevel
(light on the upper-left edge, hue-shifted shadow on the lower-right) and a 1px
dark outline so they hold up over the coloured glow on the cards.

Output: public/assets/pixel/divine/cards/<id>.png (the path the game serves as
/assets/pixel/divine/cards/<id>.png). The original 8 icons are not touched.

    python3 tools/gen_card_icons.py            # icons only
    python3 tools/gen_card_icons.py --sheet    # icons + review contact sheet (needs Pillow)
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gen_pixel_icons import PAL as BASE_PAL, write_png  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "assets" / "pixel" / "divine" / "cards"
SHEET = ROOT / "renders" / "faith-cards-2026-10-06" / "card-icons-sheet.png"

PAL = dict(BASE_PAL)
PAL.update({
    # stone / bone ramp (cool shadow, warm light)
    "r": (58, 52, 74, 255),
    "a": (128, 118, 136, 255),
    "q": (206, 198, 190, 255),
    # water / ice ramp
    "1": (26, 40, 98, 255),
    "2": (52, 106, 190, 255),
    "3": (124, 186, 238, 255),
    "4": (214, 238, 255, 255),
    # skin
    "S": (236, 190, 150, 255),
    "T": (168, 104, 82, 255),
    # flesh pink (brain)
    "P": (232, 138, 170, 255),
    "Q": (150, 64, 104, 255),
    "R": (255, 196, 214, 255),
    # sickly olive (blight)
    "O": (112, 98, 40, 255),
    "Y": (178, 166, 70, 255),
    # dry earth
    "B": (176, 116, 64, 255),
})

T = "."


class G:
    def __init__(self):
        self.a = [[T] * 32 for _ in range(32)]

    def get(self, x, y):
        return self.a[y][x] if 0 <= x < 32 and 0 <= y < 32 else T

    def p(self, x, y, c):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < 32 and 0 <= y < 32:
            self.a[y][x] = c

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.p(x, y, c)

    def disc(self, cx, cy, r, c, cond=None):
        for y in range(32):
            for x in range(32):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r + r * 0.6:
                    if cond is None or cond(x, y):
                        self.a[y][x] = c

    def ell(self, cx, cy, rx, ry, c, cond=None):
        for y in range(32):
            for x in range(32):
                if ((x - cx) / (rx + 0.45)) ** 2 + ((y - cy) / (ry + 0.45)) ** 2 <= 1.0:
                    if cond is None or cond(x, y):
                        self.a[y][x] = c

    def ring(self, cx, cy, r, c, t=1):
        for y in range(32):
            for x in range(32):
                d = math.hypot(x - cx, y - cy)
                if r - t + 0.5 <= d + 0.0 < r + 0.5:
                    self.a[y][x] = c

    def poly(self, pts, c):
        n = len(pts)
        for y in range(32):
            for x in range(32):
                px, py = x + 0.0, y + 0.0
                inside = False
                j = n - 1
                for i in range(n):
                    xi, yi = pts[i]
                    xj, yj = pts[j]
                    if (yi > py) != (yj > py):
                        xc = xi + (py - yi) * (xj - xi) / (yj - yi)
                        if px < xc:
                            inside = not inside
                    j = i
                if inside:
                    self.a[y][x] = c
        # make sure thin edges get drawn
        for i in range(n):
            self.line(*pts[i], *pts[(i + 1) % n], c)

    def line(self, x0, y0, x1, y1, c, w=1):
        steps = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 1
        for s in range(steps + 1):
            t = s / steps
            x = x0 + (x1 - x0) * t
            y = y0 + (y1 - y0) * t
            if w <= 1:
                self.p(x, y, c)
            else:
                rr = (w - 1) / 2
                for dy in range(-int(rr) - 1, int(rr) + 2):
                    for dx in range(-int(rr) - 1, int(rr) + 2):
                        if dx * dx + dy * dy <= rr * rr + 0.3:
                            self.p(x + dx, y + dy, c)

    def path(self, pts, c, w=1):
        for i in range(len(pts) - 1):
            self.line(*pts[i], *pts[i + 1], c, w)

    def bevel(self, c, lt, dk):
        """Light on upper/left edge of colour c, shadow on lower/right edge."""
        src = [row[:] for row in self.a]
        for y in range(32):
            for x in range(32):
                if src[y][x] != c:
                    continue
                g = lambda xx, yy: src[yy][xx] if 0 <= xx < 32 and 0 <= yy < 32 else T
                if dk and (g(x + 1, y) != c and g(x + 1, y) != lt or g(x, y + 1) != c and g(x, y + 1) != lt):
                    self.a[y][x] = dk
                elif lt and (g(x - 1, y) != c or g(x, y - 1) != c):
                    self.a[y][x] = lt

    def outline(self, c="k"):
        src = [row[:] for row in self.a]
        for y in range(32):
            for x in range(32):
                if src[y][x] != T:
                    continue
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    xx, yy = x + dx, y + dy
                    if 0 <= xx < 32 and 0 <= yy < 32 and src[yy][xx] not in (T, c):
                        self.a[y][x] = c
                        break

    def clear(self, cond):
        for y in range(32):
            for x in range(32):
                if cond(x, y):
                    self.a[y][x] = T

    def recolor(self, frm, to, cond=lambda x, y: True):
        for y in range(32):
            for x in range(32):
                if self.a[y][x] == frm and cond(x, y):
                    self.a[y][x] = to

    def sparkle(self, x, y, c="w", arm="h", n=1):
        self.p(x, y, c)
        for k in range(1, n + 1):
            for dx, dy in ((k, 0), (-k, 0), (0, k), (0, -k)):
                self.p(x + dx, y + dy, arm)

    def flame(self, cx, base, h, w, cols=("x", "o", "y", "w")):
        """Teardrop flame, base row `base`, tip `h` rows above, half width w."""
        layers = len(cols)
        for i, c in enumerate(cols):
            s = 1 - i / layers
            r = max(1, w * s)
            cy = base - r
            self.disc(cx, cy, r, c)
            self.poly([(cx, base - h * (0.55 + 0.45 * s) - i * 0.5), (cx - r * 0.9, cy - r * 0.2), (cx + r * 0.9, cy - r * 0.2)], c)

    def img(self):
        return [[PAL[ch] for ch in row] for row in self.a]


def heart(g, x, y, c="x", lt="o"):
    for dx, dy in [(1, 0), (2, 0), (4, 0), (5, 0), (0, 1), (1, 1), (2, 1), (3, 1), (4, 1), (5, 1), (6, 1),
                   (0, 2), (1, 2), (2, 2), (3, 2), (4, 2), (5, 2), (6, 2), (1, 3), (2, 3), (3, 3), (4, 3), (5, 3),
                   (2, 4), (3, 4), (4, 4), (3, 5)]:
        g.p(x + dx, y + dy, c)
    g.p(x + 1, y + 1, lt)


def rays(g, cx, cy, r0, r1, n, c, phase=0.0):
    for i in range(n):
        a = phase + i * 2 * math.pi / n
        g.line(cx + r0 * math.cos(a), cy + r0 * math.sin(a), cx + r1 * math.cos(a), cy + r1 * math.sin(a), c)


# --------------------------------------------------------------------------- NATIONS

def i_harvest():
    g = G()
    # bound sheaf: three fat grain heads over a flared bundle of stalks
    g.poly([(12, 18), (20, 18), (25, 30), (7, 30)], "g")
    for x in (11, 16, 21):
        g.line(16 + (x - 16) * 0.3, 21, x, 28, "s")
    heads = ((8, 10, 6, 3), (16, 7, 16, 1), (24, 10, 26, 3))      # base x,y -> tip x,y
    for bx, by, tx, ty in heads:
        g.line(16, 18, bx, by + 2, "g", 2)
    for bx, by, tx, ty in heads:
        for t in (0.0, 0.2, 0.4, 0.6, 0.8):
            g.disc(bx + (tx - bx) * t, by + (ty - by) * t, 2 if t < 0.7 else 1, "g")
        g.line(tx, ty, tx + (tx - bx) * 0.4, ty + (ty - by) * 0.4, "h")   # awn
    g.bevel("g", "h", "s")
    for bx, by, tx, ty in heads:                                   # kernel notches
        for t in (0.25, 0.55):
            g.p(bx + (tx - bx) * t, by + (ty - by) * t, "s")
    g.rect(11, 18, 21, 20, "x")
    g.bevel("x", "o", "d")
    g.outline()
    return g


def i_fertility():
    g = G()
    g.ell(16, 24, 13, 4, "s", cond=lambda x, y: y >= 26)          # rocker
    g.clear(lambda x, y: y == 25 or (y >= 26 and abs(x - 16) < 10 and y < 28))
    g.ell(16, 18, 11, 8, "b", cond=lambda x, y: y >= 17)          # bowl
    g.disc(8, 18, 6, "s", cond=lambda x, y: y < 18 and x <= 9)     # hood
    g.bevel("b", "g", "m")
    g.bevel("s", "b", "m")
    g.rect(12, 15, 25, 17, "h")                                  # blanket
    g.bevel("h", "w", "g")
    g.disc(14, 12, 3, "S")                                       # baby head
    g.bevel("S", None, "T")
    g.outline()
    heart(g, 20, 4)
    return g


def i_inspire():
    g = G()
    g.ring(16, 3, 2, "g")
    g.poly([(12, 7), (20, 7), (18, 5), (14, 5)], "g")
    g.rect(11, 8, 21, 8, "s")
    g.rect(12, 9, 20, 22, "h")                                    # glass
    g.flame(16, 21, 11, 4)
    for x in (11, 21):
        g.rect(x, 9, x, 22, "s")
    g.rect(10, 23, 22, 25, "g")
    g.bevel("g", "h", "s")
    g.outline()
    for a, b in (((7, 11), (5, 9)), ((25, 11), (27, 9)), ((7, 17), (4, 17)), ((25, 17), (28, 17)),
                 ((7, 23), (5, 25)), ((25, 23), (27, 25))):
        g.line(*a, *b, "h")
    return g


def i_veins():
    g = G()
    g.poly([(3, 29), (5, 21), (10, 17), (16, 18), (22, 14), (28, 19), (30, 29)], "a")
    g.bevel("a", "q", "r")
    g.path([(8, 26), (12, 23), (18, 24), (24, 21), (27, 24)], "y")
    g.outline()
    g.line(10, 6, 23, 19, "b", 2)                                 # handle
    g.path([(3, 12), (6, 8), (10, 5), (14, 3), (19, 2)], "a", 2)  # head
    g.path([(4, 11), (7, 7), (11, 4)], "q")
    g.outline()
    for x, y, c in ((9, 24, "c"), (18, 23, "y"), (24, 22, "c"), (13, 26, "y")):
        g.sparkle(x, y, "w", c)
    return g


def i_cleanse():
    g = G()
    g.disc(16, 19, 8, "2")
    g.poly([(16, 3), (9, 16), (23, 16)], "2")
    g.bevel("2", "3", "1")
    g.path([(11, 16), (11, 20), (13, 23)], "4")
    g.p(12, 14, "4")
    g.outline()
    for x, y in ((5, 4), (27, 7), (6, 12), (26, 15)):
        g.line(x, y, x - 1, y + 3, "3")
    g.sparkle(24, 24, "w", "4")
    return g


def i_concord():
    g = G()
    g.poly([(0, 25), (4, 30), (13, 21), (8, 16)], "g")           # left sleeve
    g.poly([(31, 25), (27, 30), (18, 21), (23, 16)], "u")        # right sleeve
    g.bevel("g", "h", "s")
    g.bevel("u", "v", "i")
    g.ell(16, 18, 7, 4, "S")                                      # clasped hands
    g.rect(13, 13, 18, 15, "S")                                   # thumb
    g.bevel("S", None, "T")
    for x in (12, 15, 18):
        g.line(x, 17, x + 1, 21, "T")
    g.outline()
    # olive branch held over the clasp: one stem, paired leaves, two olives
    g.path([(5, 10), (11, 7), (18, 5), (26, 3)], "n", 2)
    for x, y, d in ((8, 8, 1), (13, 6, -1), (17, 5, 1), (22, 4, -1)):
        g.ell(x + 1, y - 2 * d + (d < 0) * 0, 2, 1, "f")
    g.bevel("f", "l", "n")
    g.disc(24, 7, 1, "i"); g.disc(11, 11, 1, "i")
    g.outline()
    return g


def i_discord():
    g = G()
    body = [(5, 28), (18, 28), (24, 24), (20, 19), (11, 17), (8, 13), (12, 9), (18, 8)]
    g.path(body, "i", 4)
    g.ell(21, 8, 4, 3, "i")
    g.bevel("i", "v", "p")
    g.p(22, 6, "y"); g.p(23, 6, "y")
    g.outline()
    g.path([(26, 9), (28, 9), (30, 7)], "x")
    g.line(28, 9, 30, 11, "x")
    return g


def i_zeal():
    g = G()
    g.rect(9, 22, 23, 28, "a")
    g.rect(7, 20, 25, 21, "q")
    g.bevel("a", "q", "r")
    g.rect(14, 24, 18, 26, "g")
    g.flame(16, 19, 18, 7)
    g.outline()
    return g


def i_calm():
    g = G()
    g.poly([(2, 13), (8, 17), (8, 21), (2, 23)], "q")             # tail
    g.ell(15, 19, 8, 4, "q")                                      # body
    g.disc(23, 14, 3, "q")                                        # head
    g.bevel("q", "w", "a")
    g.poly([(9, 17), (11, 3), (17, 6), (20, 17)], "w")            # wing
    for x in (12, 15, 17):
        g.line(x, 7, x + 1, 15, "q")
    g.poly([(26, 13), (29, 15), (26, 16)], "o")                   # beak
    g.p(24, 13, "k")
    g.outline()
    g.path([(28, 16), (27, 19), (25, 21)], "n")                   # olive twig
    g.p(28, 18, "l"); g.p(26, 20, "l")
    return g


def i_fervor():
    g = G()
    g.line(5, 5, 27, 27, "b", 2)
    g.line(26, 5, 4, 27, "b", 2)
    g.poly([(1, 1), (7, 3), (3, 7)], "q")
    g.poly([(30, 1), (24, 3), (28, 7)], "q")
    g.bevel("q", "w", "a")
    g.rect(9, 13, 23, 25, "x")
    g.bevel("x", "o", "d")
    g.path([(9, 15), (12, 23), (16, 15), (20, 23), (23, 15)], "h")
    g.ell(16, 12, 7, 2, "q")
    g.rect(9, 25, 23, 26, "g")
    g.bevel("g", "h", "s")
    g.outline()
    return g


def i_exodus():
    g = G()
    # low horizon, huge setting sun; two black silhouettes walk the road into it
    H = 22
    g.disc(16, H, 14, "o", cond=lambda x, y: y <= H)
    g.disc(16, H, 11, "y", cond=lambda x, y: y <= H)
    g.disc(16, H, 6, "h", cond=lambda x, y: y <= H)
    g.rect(1, H + 1, 30, 30, "m")
    g.bevel("m", "b", None)
    g.poly([(15, H + 1), (17, H + 1), (27, 30), (5, 30)], "B")
    g.bevel("B", "h", None)
    g.outline()

    def walker(hx, fy, h, staff):          # feet at fy, height h (rows)
        top = fy - h
        g.disc(hx, top + 1, 1, "k")
        g.rect(hx - 1, top + 3, hx + 1, fy - 4, "k")
        g.p(hx - 2, top + 4, "k"); g.p(hx + 2, top + 4, "k")
        g.line(hx - 1, fy - 3, hx - 2, fy, "k")
        g.line(hx + 1, fy - 3, hx + 2, fy, "k")
        if staff:
            g.line(hx + 3, top + 2, hx + 3, fy, "k")
            g.p(hx + 2, top + 5, "k")
        else:
            g.rect(hx - 3, top + 3, hx - 2, top + 6, "k")      # pack
    walker(12, 26, 13, True)
    walker(20, 23, 10, False)
    return g


def i_blight():
    g = G()
    g.ell(16, 29, 10, 2, "m")
    g.path([(20, 28), (20, 16), (22, 12), (25, 11), (27, 14)], "O", 2)
    g.ell(28, 18, 2, 4, "O")
    g.path([(20, 23), (25, 25), (26, 28)], "O", 2)
    g.path([(20, 19), (15, 22), (14, 26)], "O", 2)
    g.bevel("O", "Y", "m")
    g.p(28, 17, "d"); g.p(27, 20, "d"); g.p(15, 23, "d")
    g.outline()
    # locust in profile: segmented body, folded hind leg, wings, antennae
    g.ell(9, 10, 7, 2, "Y")
    g.disc(16, 9, 2, "Y")
    g.poly([(3, 7), (13, 6), (13, 9), (3, 10)], "f")
    g.bevel("f", "l", "n")
    g.bevel("Y", "h", "O")
    for x in (4, 6, 8, 10):
        g.p(x, 11, "O")
    g.p(17, 8, "k")
    g.outline()
    g.path([(10, 12), (5, 6), (3, 14)], "s", 1)                    # hind leg
    g.path([(14, 12), (13, 15)], "s"); g.path([(16, 12), (17, 15)], "s")
    g.path([(17, 7), (19, 3), (22, 2)], "s")
    return g


def i_pestilence():
    g = G()
    g.disc(13, 13, 10, "p")                                       # hood
    g.disc(14, 14, 7, "q")                                        # mask
    g.poly([(17, 12), (29, 27), (25, 28), (14, 19)], "q")         # beak
    g.bevel("q", "w", "a")
    g.bevel("p", "u", None)
    for x, y in ((10, 12), (17, 11)):
        g.disc(x, y, 2, "k")
        g.disc(x, y, 1, "x")
        g.p(x - 1, y - 1, "o")
    g.outline()
    for x, y, r in ((4, 26, 2), (9, 28, 2), (3, 20, 1), (14, 29, 1)):
        g.ring(x, y, r + 0.5, "l")
    return g


def i_theft():
    g = G()
    g.poly([(2, 9), (30, 9), (29, 16), (21, 18), (16, 15), (11, 18), (3, 16)], "i")
    g.bevel("i", "v", "p")
    g.ell(10, 13, 3, 1, T)
    g.ell(22, 13, 3, 1, T)
    g.outline()
    g.disc(8, 25, 3, "g")
    g.line(11, 25, 28, 25, "g", 2)
    g.rect(22, 26, 23, 28, "g")
    g.rect(26, 26, 27, 29, "g")
    g.bevel("g", "h", "s")
    g.p(8, 25, T)
    g.outline()
    return g


def i_foe():
    g = G()
    for i in range(8):
        a = i * math.pi / 4 + math.pi / 8
        ca, sa = math.cos(a), math.sin(a)
        g.line(16 + 15 * ca, 16 + 15 * sa, 16 + 10 * ca, 16 + 10 * sa, "b", 2)
    g.outline()
    for i in range(8):
        a = i * math.pi / 4 + math.pi / 8
        ca, sa = math.cos(a), math.sin(a)
        px, py = -sa, ca
        g.poly([(16 + 6.5 * ca, 16 + 6.5 * sa),
                (16 + 10 * ca + 1.8 * px, 16 + 10 * sa + 1.8 * py),
                (16 + 10 * ca - 1.8 * px, 16 + 10 * sa - 1.8 * py)], "q")
    g.disc(16, 13, 2, "x")
    g.poly([(14, 16), (18, 16), (19, 20), (13, 20)], "x")
    g.bevel("x", "o", "d")
    g.bevel("q", "w", "a")
    g.outline()
    return g


def i_schism():
    s = G()
    s.ring(16, 16, 11, "g", 3)
    s.rect(14, 4, 18, 28, "g")
    s.rect(5, 13, 27, 17, "g")
    s.disc(16, 15, 3, "y")
    s.bevel("g", "h", "s")
    zig = [0, 1, 2, 1, 0, -1, -2, -1]
    g = G()
    for y in range(32):
        c = 16 + zig[y % 8]
        for x in range(32):
            if x < c:
                g.a[y][x] = s.get(x + 1, y + 2)
            elif x > c + 1:
                g.a[y][x] = s.get(x - 1, y - 2)
    g.outline()
    for y in range(3, 30, 4):
        g.p(16.5 + zig[y % 8], y, "x")
    return g


def i_golden():
    g = G()
    g.poly([(7, 22), (6, 11), (11, 16), (16, 7), (21, 16), (26, 11), (25, 22)], "g")
    g.rect(7, 21, 25, 25, "g")
    g.bevel("g", "h", "s")
    for x, y in ((6, 10), (16, 6), (26, 10)):
        g.disc(x, y, 1, "h")
    g.disc(16, 23, 1, "x"); g.p(11, 23, "c"); g.p(21, 23, "c")
    # laurels
    for side in (-1, 1):
        for k, (dy) in enumerate((27, 24, 21, 18)):
            x = 16 + side * (12 + (k == 0) * -1 + (k == 3) * 1)
            g.ell(x, dy, 1, 1, "f")
            g.p(x - side, dy - 1, "l")
    g.outline()
    rays(g, 16, 14, 13, 15, 7, "h", phase=-math.pi)
    for x, y in ((3, 4), (29, 4), (16, 1)):
        g.sparkle(x, y, "w", "h")
    return g


def i_revolt():
    g = G()
    # one crown, snapped in two and toppled at the torch's foot
    g.poly([(1, 30), (2, 23), (5, 26), (8, 21), (11, 25), (12, 30)], "g")
    g.poly([(20, 30), (21, 25), (24, 21), (27, 26), (30, 23), (30, 30)], "g")
    g.rect(1, 28, 12, 30, "g"); g.rect(20, 28, 30, 30, "g")
    g.bevel("g", "h", "s")
    for x, y in ((2, 22), (8, 20), (24, 20), (30, 22)):
        g.p(x, y, "h")
    g.p(6, 28, "x"); g.p(25, 28, "c")
    g.path([(12, 27), (13, 29)], "s"); g.path([(20, 26), (19, 29)], "s")
    g.outline()
    g.line(16, 15, 16, 30, "b", 3)
    g.rect(15, 20, 17, 21, "s")
    g.poly([(11, 11), (21, 11), (19, 15), (13, 15)], "a")
    g.bevel("a", "q", "r")
    g.bevel("b", None, "m")
    g.flame(16, 11, 10, 5)
    g.outline()
    return g


def i_cure():
    g = G()
    # three-leaf healing sprig rising from a bowl
    g.path([(16, 19), (16, 12), (17, 6)], "n", 2)
    g.ell(17, 5, 2, 4, "f")
    g.poly([(15, 14), (9, 9), (6, 10), (9, 15)], "f")
    g.poly([(17, 13), (23, 8), (26, 9), (23, 14)], "f")
    g.bevel("f", "l", "n")
    g.line(15, 14, 8, 10, "n"); g.line(17, 13, 24, 9, "n")
    g.ell(16, 21, 10, 7, "b", cond=lambda x, y: y >= 21)
    g.bevel("b", "B", "m")
    g.ell(16, 20, 10, 2, "g")
    g.ell(16, 20, 8, 1, "l")
    g.outline()
    g.sparkle(5, 4, "w", "l")
    g.sparkle(27, 15, "w", "l")
    return g


def i_seafaring():
    g = G()
    g.line(15, 3, 15, 21, "m", 2)
    g.poly([(17, 4), (27, 18), (17, 18)], "q")
    g.poly([(13, 6), (13, 18), (5, 18)], "q")
    g.bevel("q", "w", "a")
    g.poly([(4, 20), (28, 20), (24, 25), (8, 25)], "b")
    g.bevel("b", "B", "m")
    g.rect(16, 2, 19, 3, "x")
    g.rect(1, 25, 30, 29, "2")
    for x in range(1, 31):
        if x % 6 in (0, 1, 2):
            g.p(x, 25 - (x % 6 == 1), "3")
    g.bevel("2", None, "1")
    g.outline()
    return g


# --------------------------------------------------------------------------- WORLD

def i_rains():
    g = G()
    g.disc(10, 13, 5, "q"); g.disc(18, 9, 6, "q"); g.disc(24, 13, 4, "q")
    g.rect(6, 13, 27, 17, "q")
    g.bevel("q", "w", "a")
    for x, y in ((8, 21), (13, 23), (18, 21), (23, 23), (11, 27), (21, 27)):
        g.line(x, y, x - 1, y + 3, "3")
    g.outline()
    return g


def i_drought():
    g = G()
    g.disc(16, 9, 5, "w")
    g.ring(16, 9, 5, "h")
    g.ell(16, 25, 14, 5, "B")
    g.bevel("B", "o", "m")
    g.outline()
    for pts in ([(5, 24), (10, 26), (13, 23), (18, 25)], [(13, 23), (14, 21)], [(18, 25), (23, 23), (27, 25)],
                [(10, 26), (9, 29)], [(18, 25), (19, 29)], [(23, 23), (24, 21)]):
        g.path(pts, "m")
    rays(g, 16, 9, 7, 10, 12, "h")
    return g


def i_quake():
    g = G()
    # two slabs: left sunk, right heaved up, a jagged rift between
    g.poly([(1, 19), (14, 19), (12, 23), (15, 26), (13, 30), (1, 30)], "b")
    g.poly([(17, 12), (30, 12), (30, 30), (16, 30), (18, 26), (15, 23)], "b")
    g.bevel("b", "B", "m")
    g.rect(1, 19, 14, 20, "f"); g.rect(17, 12, 30, 13, "f")
    g.bevel("f", "l", None)
    g.rect(17, 14, 17, 29, "m")
    for x, y in ((4, 25), (9, 27), (22, 18), (26, 23), (21, 26)):
        g.p(x, y, "s")
    g.outline()
    for x, y in ((8, 14), (11, 9), (15, 5)):                       # flung stones
        g.rect(x, y, x + 1, y + 1, "a")
        g.p(x, y, "q")
    g.path([(3, 6), (5, 4), (3, 2)], "q"); g.path([(4, 13), (6, 11), (4, 9)], "q")
    g.path([(27, 7), (25, 5), (27, 3)], "q")
    return g


def i_volcano():
    g = G()
    g.poly([(1, 30), (11, 13), (21, 13), (31, 30)], "m")
    g.bevel("m", "b", "r")
    g.rect(11, 13, 21, 14, "x")
    g.path([(13, 14), (11, 19), (9, 24)], "o")
    g.path([(19, 14), (21, 20), (24, 25)], "x")
    g.disc(7, 7, 3, "a"); g.disc(4, 3, 2, "a")
    g.bevel("a", "q", "r")
    g.flame(16, 13, 12, 4)
    g.outline()
    for x, y in ((24, 4), (27, 9), (10, 2)):
        g.rect(x, y, x + 1, y + 1, "o")
        g.p(x, y, "y")
    return g


def i_ice_age():
    g = G()
    g.poly([(2, 30), (5, 23), (9, 25), (13, 20), (18, 24), (22, 19), (27, 24), (30, 30)], "3")
    g.bevel("3", "4", "2")
    g.path([(13, 21), (13, 29)], "2"); g.path([(22, 20), (21, 29)], "2")
    for a in range(6):
        ang = a * math.pi / 3 + math.pi / 2
        x1, y1 = 16 + 7 * math.cos(ang), 10 + 7 * math.sin(ang)
        g.line(16, 10, x1, y1, "4", 2)
        for side in (-1, 1):
            b = ang + side * 0.8
            mx, my = 16 + 4.5 * math.cos(ang), 10 + 4.5 * math.sin(ang)
            g.line(mx, my, mx + 2.5 * math.cos(b), my + 2.5 * math.sin(b), "4")
    g.disc(16, 10, 1, "w")
    g.outline()
    return g


def i_comet():
    g = G()
    g.disc(-2, 40, 15, "n")                                       # world edge
    g.disc(-2, 40, 13, "f")
    g.bevel("f", "l", None)
    g.poly([(7, 17), (13, 23), (31, 3), (28, 0)], "2")
    g.poly([(9, 18), (12, 21), (30, 2)], "3")
    g.disc(10, 20, 4, "4")
    g.bevel("4", "w", "3")
    g.outline()
    g.sparkle(6, 25, "w", "y", 2)
    return g


# --------------------------------------------------------------------------- LIFE

def i_hardy():
    g = G()
    g.poly([(2, 30), (4, 22), (10, 18), (17, 19), (22, 15), (28, 20), (30, 30)], "a")
    g.bevel("a", "q", "r")
    for x, y, r in ((7, 22, 1), (12, 21, 2), (25, 19, 1), (21, 25, 1), (8, 27, 1)):
        g.disc(x, y, r, "Y")
        g.p(x, y, "l")
    g.outline()
    g.path([(17, 19), (16, 13), (19, 8), (18, 3)], "f", 2)
    for x, y, d in ((16, 15, -1), (18, 11, 1), (17, 7, -1), (19, 5, 1)):
        g.p(x + 2 * d, y, "l"); g.p(x + 2 * d, y - 1, "l")
    g.ell(20, 9, 2, 1, "f"); g.ell(14, 12, 2, 1, "f")
    g.bevel("f", "l", "n")
    g.outline()
    return g


def i_herds():
    g = G()
    g.ell(14, 18, 10, 6, "b")
    g.disc(19, 13, 5, "b")
    g.ell(26, 18, 3, 4, "b")
    for x in (6, 10, 18, 22):
        g.rect(x, 22, x + 1, 28, "b")
    g.line(4, 15, 2, 22, "b")
    g.bevel("b", "B", "m")
    g.ell(22, 16, 3, 5, "m")
    g.outline()
    g.path([(25, 13), (27, 9), (30, 9)], "q", 2)
    g.p(27, 17, "y")
    g.outline()
    return g


def i_murrain():
    g = G()
    g.path([(10, 11), (5, 9), (2, 4)], "q", 2)
    g.path([(22, 11), (27, 9), (30, 4)], "q", 2)
    g.ell(16, 12, 7, 6, "q")
    g.poly([(10, 14), (22, 14), (20, 28), (12, 28)], "q")
    g.bevel("q", "w", "a")
    g.ell(12, 15, 2, 2, "k"); g.ell(20, 15, 2, 2, "k")
    g.p(15, 25, "r"); g.p(17, 25, "r")
    g.path([(16, 7), (15, 10), (17, 12)], "a")
    g.outline()
    return g


def i_awaken():
    g = G()
    g.ell(16, 18, 11, 8, "P")
    g.rect(14, 25, 18, 29, "Q")
    g.bevel("P", "R", "Q")
    g.line(16, 10, 16, 25, "Q")
    for pts in ([(8, 15), (11, 14), (12, 17)], [(6, 20), (10, 21)], [(11, 23), (13, 20)],
                [(20, 14), (23, 15), (22, 18)], [(22, 22), (26, 20)], [(19, 20), (20, 23)]):
        g.path(pts, "Q")
    g.outline()
    g.path([(24, 1), (21, 6), (25, 6), (22, 11)], "y", 2)
    g.p(23, 6, "w")
    g.outline()
    return g


def i_mutate():
    g = G()
    f = lambda y: math.sin((y - 1) * 0.36)
    # rungs, then back strand, then front strand (depth from sign of derivative)
    for y in range(3, 30, 3):
        g.line(16 + 9 * f(y), y, 16 - 9 * f(y), y, "u")
    back = G(); front = G()
    for y in range(1, 31):
        for sgn, col in ((1, "f"), (-1, "e")):
            x = 16 + sgn * 9 * f(y)
            d = sgn * math.cos((y - 1) * 0.36)
            tgt = front if d > 0 else back
            tgt.line(x - 1, y, x + 1, y, col)
    for src in (back, front):
        for y in range(32):
            for x in range(32):
                if src.a[y][x] != T:
                    g.a[y][x] = src.a[y][x]
    g.bevel("f", "l", "n")
    g.bevel("e", "c", "t")
    # the mutation: one rung burns orange and the strand kinks out of true
    g.line(16 + 9 * f(15), 15, 16 - 9 * f(15), 15, "o")
    g.outline()
    g.sparkle(16, 15, "w", "y", 2)
    return g


# --------------------------------------------------------------------------- HEAVENS

def i_sight():
    g = G()
    g.poly([(16, 3), (3, 27), (29, 27)], "u")
    g.poly([(16, 7), (6, 25), (26, 25)], "p")
    g.bevel("u", "v", "i")
    g.ell(16, 19, 7, 3, "w")
    g.disc(16, 19, 2, "v")
    g.p(16, 19, "k"); g.p(15, 18, "w")
    g.outline()
    rays(g, 16, 17, 14, 16, 10, "v", phase=-math.pi / 2)
    return g


def i_meteor():
    g = G()
    g.disc(16, 44, 18, "2")
    g.disc(10, 30, 3, "f"); g.disc(22, 29, 2, "f")
    g.bevel("2", "3", None)
    g.bevel("f", "l", None)
    g.poly([(1, 1), (6, 1), (15, 10), (10, 15), (1, 6)], "i")
    g.poly([(3, 3), (13, 11), (11, 13)], "u")
    g.disc(14, 14, 4, "b")
    g.bevel("b", "B", "m")
    g.p(15, 10, "l"); g.p(16, 9, "l"); g.p(17, 10, "l")
    g.outline()
    g.sparkle(26, 9, "w", "v")
    return g


def i_seed():
    g = G()
    g.ell(16, 29, 7, 2, "m")
    g.line(16, 28, 16, 13, "f", 2)
    g.ell(11, 23, 4, 2, "f"); g.ell(21, 20, 4, 2, "f")
    g.bevel("f", "l", "n")
    for k in range(5):
        a = -math.pi / 2 + k * 2 * math.pi / 5
        g.disc(16 + 4 * math.cos(a), 9 + 4 * math.sin(a), 3, "v")
    g.bevel("v", "w", "u")
    g.disc(16, 9, 2, "y")
    g.outline()
    return g


def i_terraform():
    g = G()
    g.ell(16, 17, 14, 5, "h", cond=lambda x, y: y <= 15)
    g.ell(16, 17, 12, 3, T, cond=lambda x, y: y <= 15)
    g.disc(16, 17, 10, "2")
    for x, y, r in ((12, 13, 3), (19, 20, 4), (21, 11, 2)):
        g.disc(x, y, r, "f")
    g.disc(16, 17, 10, "1", cond=lambda x, y: (x - 16) + (y - 17) > 9)
    g.bevel("f", "l", "n")
    g.bevel("2", "3", None)
    g.ell(16, 17, 14, 5, "h", cond=lambda x, y: y > 17)
    g.ell(16, 17, 12, 3, "2", cond=lambda x, y: y > 17 and (x - 16) ** 2 + (y - 17) ** 2 <= 110)
    g.ell(16, 17, 12, 3, T, cond=lambda x, y: y > 17 and (x - 16) ** 2 + (y - 17) ** 2 > 110)
    g.poly([(27, 13), (31, 16), (26, 18)], "h")
    g.bevel("h", "w", "s")
    g.outline()
    return g


# --------------------------------------------------------------------------- UTILITY

def i_seek():
    g = G()
    g.disc(16, 16, 13, "g")
    g.disc(16, 16, 11, "p")
    g.bevel("g", "h", "s")
    for a in range(4):
        ang = a * math.pi / 2
        g.p(16 + 12 * math.cos(ang), 16 + 12 * math.sin(ang), "w")
    stars = [(9, 10), (14, 13), (19, 9), (23, 14), (20, 20), (12, 21)]
    g.path(stars[:5], "i")
    g.path([stars[1], stars[5]], "i")
    for x, y in stars:
        g.p(x, y, "w")
    g.sparkle(19, 9, "w", "v")
    g.sparkle(12, 21, "w", "v")
    g.outline()
    return g


def i_crucible():
    g = G()
    g.flame(10, 17, 12, 3)
    g.flame(22, 17, 11, 3)
    g.flame(16, 17, 16, 5)
    g.line(9, 23, 6, 30, "r", 2)
    g.line(23, 23, 26, 30, "r", 2)
    g.ell(16, 18, 10, 7, "a", cond=lambda x, y: y >= 18)
    g.bevel("a", "q", "r")
    g.ell(16, 18, 10, 2, "a")
    g.ell(16, 18, 8, 1, "o")
    g.p(14, 18, "y"); g.p(18, 18, "y")
    g.outline()
    return g


SCOPES = [
    ("NATIONS", [
        ("harvest", "gold"), ("fertility", "gold"), ("inspire", "gold"), ("veins", "gold"),
        ("cleanse", "gold"), ("concord", "gold"), ("discord", "red"), ("zeal", "gold"),
        ("calm", "gold"), ("fervor", "gold"), ("exodus", "gold"), ("blight", "red"),
        ("pestilence", "red"), ("theft", "gold"), ("foe", "red"), ("schism", "red"),
        ("golden", "gold"), ("revolt", "gold"), ("cure", "gold"), ("seafaring", "gold"),
    ]),
    ("WORLD", [("rains", "green"), ("drought", "red"), ("quake", "red"), ("volcano", "red"),
               ("ice_age", "red"), ("comet", "red")]),
    ("LIFE", [("hardy", "green"), ("herds", "green"), ("murrain", "red"), ("awaken", "green"),
              ("mutate", "green")]),
    ("HEAVENS", [("sight", "violet"), ("meteor", "violet"), ("seed", "violet"), ("terraform", "violet")]),
    ("UTILITY", [("seek", "violet"), ("crucible", "gold")]),
]
GLOW = {"gold": (200, 169, 110), "green": (93, 204, 138), "red": (255, 107, 74), "violet": (143, 123, 196)}


def build():
    icons = {}
    for _, items in SCOPES:
        for cid, _tone in items:
            icons[cid] = globals()["i_" + cid]().img()
    return icons


def contact_sheet(icons, path: Path):
    from PIL import Image, ImageDraw, ImageFont

    S = 4
    cell_w, cell_h = 128 + 72, 128 + 26
    cols = 6
    bg = (10, 7, 22, 255)
    try:
        font = ImageFont.load_default(size=13)
        hfont = ImageFont.load_default(size=16)
    except TypeError:
        font = hfont = ImageFont.load_default()
    rows = sum(1 + (len(items) + cols - 1) // cols for _, items in SCOPES)
    W = cols * cell_w + 16
    H = sum(24 + ((len(items) + cols - 1) // cols) * cell_h for _, items in SCOPES) + 16
    sheet = Image.new("RGBA", (W, H), bg)
    d = ImageDraw.Draw(sheet)
    y0 = 8
    for scope, items in SCOPES:
        d.text((10, y0 + 2), scope, fill=(200, 190, 230, 255), font=hfont)
        y0 += 24
        for i, (cid, tone) in enumerate(items):
            ox = 8 + (i % cols) * cell_w
            oy = y0 + (i // cols) * cell_h
            gr = GLOW[tone]
            glow = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
            gp = glow.load()
            for yy in range(128):
                for xx in range(128):
                    r = math.hypot(xx - 64, yy - 64) / 64
                    a = max(0.0, 1 - r) ** 1.6 * 0.55
                    gp[xx, yy] = (*gr, int(a * 255))
            sheet.alpha_composite(glow, (ox, oy))
            im = Image.new("RGBA", (32, 32))
            im.putdata([p for row in icons[cid] for p in row])
            sheet.alpha_composite(im.resize((128, 128), Image.NEAREST), (ox, oy))
            # in-game sizes for readability review: 36px deck, 1x
            sheet.alpha_composite(glow.resize((36, 36)), (ox + 132, oy + 4))
            sheet.alpha_composite(im.resize((36, 36), Image.NEAREST), (ox + 132, oy + 4))
            sheet.alpha_composite(im, (ox + 134, oy + 48))
            d.text((ox + 2, oy + 130), f"{cid}", fill=(*gr, 255), font=font)
        y0 += ((len(items) + cols - 1) // cols) * cell_h
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def main():
    icons = build()
    for cid, img in icons.items():
        write_png(OUT / f"{cid}.png", img)
    print(f"wrote {len(icons)} icons to {OUT}")
    if "--sheet" in sys.argv:
        contact_sheet(icons, SHEET)
        print(f"wrote {SHEET}")


if __name__ == "__main__":
    main()
