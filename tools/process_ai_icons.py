"""Downscale AI-generated icons to crisp 32x32 game assets."""
from pathlib import Path
from PIL import Image

SRC = Path(r"C:\Users\Sirjohn\.cursor\projects\c-Users-Sirjohn-Documents-Eternal-System\assets")
ROOT = Path(r"C:\Users\Sirjohn\Documents\Eternal System")
OUT_DIV = ROOT / "assets" / "pixel" / "divine"
OUT_ICO = ROOT / "assets" / "pixel" / "icons"
PUB_DIV = ROOT / "public" / "assets" / "pixel" / "divine"
PUB_ICO = ROOT / "public" / "assets" / "pixel" / "icons"

for d in (OUT_DIV, OUT_ICO, PUB_DIV, PUB_ICO):
    d.mkdir(parents=True, exist_ok=True)

PALETTE = [
    (12, 8, 20, 255),
    (200, 169, 110, 255),
    (255, 221, 153, 255),
    (255, 244, 220, 255),
    (123, 94, 167, 255),
    (170, 136, 221, 255),
    (42, 28, 72, 255),
    (68, 255, 204, 255),
    (42, 148, 132, 255),
    (93, 204, 138, 255),
    (58, 140, 90, 255),
    (255, 85, 51, 255),
    (255, 153, 68, 255),
    (120, 82, 64, 255),
    (90, 212, 232, 255),
]


def near_bg(r: int, g: int, b: int, a: int) -> bool:
    if a < 40:
        return True
    if r < 40 and g < 30 and b < 55:
        return True
    if r < 55 and g < 40 and b < 70 and b >= r and b >= g:
        return True
    return False


def quantize(r: int, g: int, b: int, a: int) -> tuple[int, int, int, int]:
    if near_bg(r, g, b, a):
        return (0, 0, 0, 0)
    best, bd = (12, 8, 20, 255), 1e18
    for pr, pg, pb, pa in PALETTE:
        d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
        if d < bd:
            bd, best = d, (pr, pg, pb, 255)
    return best


def process(src: Path, dest: Path, size: int = 32) -> None:
    im = Image.open(src).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if near_bg(r, g, b, a):
                px[x, y] = (0, 0, 0, 0)
    bbox = im.getbbox()
    if bbox:
        x0, y0, x1, y1 = bbox
        pad = 6
        x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
        x1, y1 = min(w, x1 + pad), min(h, y1 + pad)
        im = im.crop((x0, y0, x1, y1))
    side = max(im.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(im, ((side - im.size[0]) // 2, (side - im.size[1]) // 2), im)
    # Downscale in two steps for cleaner silhouette: first to 64, then 32
    mid = sq.resize((64, 64), Image.Resampling.BILINEAR)
    # re-threshold soft alpha
    mpx = mid.load()
    for y in range(64):
        for x in range(64):
            r, g, b, a = mpx[x, y]
            if a < 90 or near_bg(r, g, b, a):
                mpx[x, y] = (0, 0, 0, 0)
            else:
                mpx[x, y] = (r, g, b, 255)
    small = mid.resize((size, size), Image.Resampling.NEAREST)
    px = small.load()
    for y in range(size):
        for x in range(size):
            px[x, y] = quantize(*px[x, y])
    small.save(dest)
    print("wrote", dest)


MAP = {
    "faith-sight.png": ("divine", "sight.png"),
    "faith-harvest.png": ("divine", "harvest.png"),
    "faith-evolution.png": ("divine", "evolution.png"),
    "faith-prophet.png": ("divine", "prophet.png"),
    "faith-revelation.png": ("divine", "revelation.png"),
    "faith-meteor.png": ("divine", "meteor.png"),
    "rail-god.png": ("icons", "god.png"),
    "rail-evolve.png": ("icons", "evolve.png"),
    "rail-system.png": ("icons", "system.png"),
    "rail-codex.png": ("icons", "codex.png"),
}


def main() -> None:
    for name, (folder, out_name) in MAP.items():
        src = SRC / name
        if not src.exists():
            print("MISSING", src)
            continue
        out = (OUT_DIV if folder == "divine" else OUT_ICO) / out_name
        pub = (PUB_DIV if folder == "divine" else PUB_ICO) / out_name
        process(src, out)
        process(src, pub)

    extras = [
        ("faith-meteor.png", "smite.png", True),
        ("faith-harvest.png", "terraform.png", True),
        ("faith-evolution.png", "dna.png", False),
        ("rail-god.png", "dp.png", False),
        ("rail-system.png", "tp.png", False),
    ]
    for src_name, out_name, divine in extras:
        src = SRC / src_name
        if not src.exists():
            continue
        out = (OUT_DIV if divine else OUT_ICO) / out_name
        pub = (PUB_DIV if divine else PUB_ICO) / out_name
        process(src, out)
        process(src, pub)

    print("done")


if __name__ == "__main__":
    main()
