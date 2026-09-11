"""Generate the surface-decal atlas.

Cells are 16x16 RGBA. R carries a SHADING MASK (0 = shadow side, 255 = lit
side), A carries coverage. No colour: `stampDecals` derives hue from the
terrain pixel under each decal, which is what keeps decals inside the planet's
palette on every planet type without re-authoring them.

Run:  python tools/genDecalAtlas.py
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "pixel" / "decals"
PUB = ROOT / "public" / "assets" / "pixel" / "decals"
CELL = 16
KINDS = ["conifer", "broadleaf", "scrub", "cactus", "rock"]
VARIANTS = 3


def put(px, x: int, y: int, lit: int, a: int = 255) -> None:
    if 0 <= x < CELL and 0 <= y < CELL:
        px[x, y] = (lit, 0, 0, a)


def conifer(px, ox: int, oy: int, v: int) -> None:
    h = 12 + v
    for i in range(h):
        t = i / h
        half = max(0, int((1 - t) * h * 0.42))
        for dx in range(-half, half + 1):
            put(px, ox + dx, oy - 3 - i, 70 if dx >= 0 else 210)
    for i in range(3):
        put(px, ox, oy - i, 110)


def broadleaf(px, ox: int, oy: int, v: int) -> None:
    import math
    h = 11 + v
    for i in range(h):
        t = i / h
        half = int(math.sin((0.25 + t * 0.75) * math.pi) * h * 0.38)
        for dx in range(-half, half + 1):
            put(px, ox + dx, oy - 3 - i, 70 if dx >= 0 else 210)
    for i in range(3):
        put(px, ox, oy - i, 110)


def scrub(px, ox: int, oy: int, v: int) -> None:
    h = 4 + (v % 2)
    for i in range(h):
        w = max(0, 2 - abs(i - h // 2))
        for dx in range(-w, w + 1):
            put(px, ox + dx, oy - i, 90 if dx >= 0 else 190)


def cactus(px, ox: int, oy: int, v: int) -> None:
    h = 8 + v
    for i in range(h):
        put(px, ox, oy - i, 200 if i % 3 else 120)
        put(px, ox - 1, oy - i, 200)
    arm = int(h * 0.45)
    if v != 1:
        for i in range(3):
            put(px, ox + 1 + i, oy - arm, 150)
    if v != 2:
        for i in range(3):
            put(px, ox - 2 - i, oy - arm + 1, 150)


def rock(px, ox: int, oy: int, v: int) -> None:
    h = 4 + v
    for i in range(h):
        w = max(0, int((1 - i / h) * h * 0.7))
        for dx in range(-w, w + 1):
            put(px, ox + dx, oy - i, 60 if dx >= 0 else 235)


DRAW = {"conifer": conifer, "broadleaf": broadleaf, "scrub": scrub,
        "cactus": cactus, "rock": rock}


def main() -> None:
    img = Image.new("RGBA", (CELL * VARIANTS, CELL * len(KINDS)), (0, 0, 0, 0))
    px = img.load()
    for row, kind in enumerate(KINDS):
        for v in range(VARIANTS):
            # local origin: bottom-centre of the cell
            ox = v * CELL + CELL // 2
            oy = row * CELL + CELL - 2
            sub = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
            spx = sub.load()
            DRAW[kind](spx, CELL // 2, CELL - 2, v)
            img.paste(sub, (v * CELL, row * CELL))
    OUT.mkdir(parents=True, exist_ok=True)
    PUB.mkdir(parents=True, exist_ok=True)
    img.save(OUT / "decals.png")
    manifest = {
        "atlas": "decals.png",
        "cell": CELL,
        "kinds": {k: {"row": i, "variants": VARIANTS} for i, k in enumerate(KINDS)},
    }
    (OUT / "decals.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    shutil.copy(OUT / "decals.png", PUB / "decals.png")
    shutil.copy(OUT / "decals.json", PUB / "decals.json")
    print(f"wrote {img.size[0]}x{img.size[1]} atlas, {len(KINDS)} kinds x {VARIANTS} variants")


if __name__ == "__main__":
    main()
