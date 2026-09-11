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
    if v == 0:
        # Narrow spire
        h = 15
        width_mult = 0.22
        taper_curve = lambda t: (1 - t)
    elif v == 1:
        # Broad squat
        h = 10
        width_mult = 0.50
        taper_curve = lambda t: (1 - t)
    else:  # v == 2
        # Medium with fast taper (double-taper)
        h = 13
        width_mult = 0.38
        taper_curve = lambda t: (1 - t * t)

    for i in range(h):
        t = i / h
        half = max(0, int(taper_curve(t) * h * width_mult))
        for dx in range(-half, half + 1):
            put(px, ox + dx, oy - 3 - i, 70 if dx >= 0 else 210)

    trunk_len = 2 if v == 1 else 3
    for i in range(trunk_len):
        put(px, ox, oy - i, 110)


def broadleaf(px, ox: int, oy: int, v: int) -> None:
    import math
    if v == 0:
        # Round canopy - symmetric
        h = 11
        phase_start = 0.25
        phase_range = 0.75
    elif v == 1:
        # Tall narrow - peak higher
        h = 13
        phase_start = 0.10
        phase_range = 0.90
    else:  # v == 2
        # Short wide - peak lower
        h = 10
        phase_start = 0.35
        phase_range = 0.65

    for i in range(h):
        t = i / h
        half = int(math.sin((phase_start + t * phase_range) * math.pi) * h * 0.38)
        half = max(0, half)
        for dx in range(-half, half + 1):
            put(px, ox + dx, oy - 3 - i, 70 if dx >= 0 else 210)

    trunk_len = 2 if v == 1 else 3
    for i in range(trunk_len):
        put(px, ox, oy - i, 110)


def scrub(px, ox: int, oy: int, v: int) -> None:
    if v == 0:
        # Low and wide
        h = 4
        for i in range(h):
            w = 2
            for dx in range(-w, w + 1):
                put(px, ox + dx, oy - i, 90 if dx >= 0 else 190)
    elif v == 1:
        # Two separated clumps
        # Lower clump
        for i in range(3):
            w = 2
            for dx in range(-w, w + 1):
                put(px, ox + dx, oy - i, 90 if dx >= 0 else 190)
        # Upper clump (gap in between)
        for i in range(1, 3):
            w = 1
            for dx in range(-w, w + 1):
                put(px, ox + dx, oy - i - 3, 90 if dx >= 0 else 190)
    else:  # v == 2
        # Tall and sparse
        h = 5
        for i in range(h):
            w = max(0, 1 - abs(i - h // 2) // 2)
            for dx in range(-w, w + 1):
                put(px, ox + dx, oy - i, 90 if dx >= 0 else 190)


def cactus(px, ox: int, oy: int, v: int) -> None:
    if v == 0:
        h = 8
        trunk_offset = 0
    elif v == 1:
        h = 9
        trunk_offset = 0
    else:  # v == 2
        h = 10
        trunk_offset = 1  # Offset trunk for asymmetry

    for i in range(h):
        put(px, ox + trunk_offset, oy - i, 200 if i % 3 else 120)
        # Left ribbing
        if v != 2:
            put(px, ox - 1 + trunk_offset, oy - i, 200)

    arm = int(h * 0.45)
    if v != 1:
        # Right arm (shorter on v=1)
        for i in range(3):
            put(px, ox + 1 + i, oy - arm, 150)
    if v != 2:
        # Left arm (shorter on v=2)
        for i in range(3):
            put(px, ox - 2 - i + trunk_offset, oy - arm + 1, 150)


def rock(px, ox: int, oy: int, v: int) -> None:
    if v == 0:
        # Squat and wide
        h = 4
        for i in range(h):
            w = max(0, int((1 - i / h) * h * 0.8))
            for dx in range(-w, w + 1):
                put(px, ox + dx, oy - i, 60 if dx >= 0 else 235)
    elif v == 1:
        # Taller with notch
        h = 6
        for i in range(h):
            if i == 3:
                # Notch in the middle
                w = 1
            else:
                w = max(0, int((1 - i / h) * h * 0.65))
            for dx in range(-w, w + 1):
                put(px, ox + dx, oy - i, 60 if dx >= 0 else 235)
    else:  # v == 2
        # Angular/asymmetric - faster taper, lean right
        h = 5
        for i in range(h):
            t = i / h
            w = max(0, int((1 - t * t) * h * 0.7))
            x_offset = 0 if i < 2 else 1  # Lean right on upper half
            for dx in range(-w, w + 1):
                # Stronger shadow on left
                lit = 70 if (dx + x_offset) >= 1 else 180
                put(px, ox + dx + x_offset, oy - i, lit)


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
