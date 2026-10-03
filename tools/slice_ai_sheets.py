"""Slice GenerateImage sheets → individual sources → crisp 32x32 game icons."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

from process_ai_icons import process

CURSOR_ASSETS = Path(
    r"C:\Users\Sirjohn\.cursor\projects\c-Users-Sirjohn-Documents-Eternal-System\assets"
)
ROOT = Path(__file__).resolve().parents[1]
STAGING = CURSOR_ASSETS
OUT_DIV = ROOT / "assets" / "pixel" / "divine"
OUT_ICO = ROOT / "assets" / "pixel" / "icons"
PUB_DIV = ROOT / "public" / "assets" / "pixel" / "divine"
PUB_ICO = ROOT / "public" / "assets" / "pixel" / "icons"


def is_fg(px) -> bool:
    r, g, b, a = px
    if a < 40:
        return False
    # near-black / deep navy bg
    if r < 45 and g < 35 and b < 55:
        return False
    return True


def crop_content(im: Image.Image, pad: int = 8) -> Image.Image:
    px = im.load()
    w, h = im.size
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            if is_fg(px[x, y]):
                xs.append(x)
                ys.append(y)
    if not xs:
        return im
    x0, x1 = max(0, min(xs) - pad), min(w, max(xs) + pad + 1)
    y0, y1 = max(0, min(ys) - pad), min(h, max(ys) + pad + 1)
    return im.crop((x0, y0, x1, y1))


def slice_grid(path: Path, cols: int, rows: int, names: list[str]) -> list[Path]:
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    cw, rh = w // cols, h // rows
    out_paths = []
    for i, name in enumerate(names):
        c, r = i % cols, i // cols
        cell = im.crop((c * cw, r * rh, (c + 1) * cw, (r + 1) * rh))
        # drop text band: keep upper ~72% of cell if tall
        cw2, ch2 = cell.size
        cell = cell.crop((0, 0, cw2, int(ch2 * 0.72)))
        cell = crop_content(cell)
        dest = STAGING / name
        cell.save(dest)
        out_paths.append(dest)
        print("sliced", dest)
    return out_paths


def slice_row(path: Path, n: int, names: list[str], text_cut: float = 0.62) -> list[Path]:
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    # Prefer top icon band (exclude labels)
    band = im.crop((0, 0, w, int(h * text_cut)))
    bw, bh = band.size
    cw = bw // n
    out_paths = []
    for i, name in enumerate(names):
        cell = band.crop((i * cw, 0, (i + 1) * cw, bh))
        cell = crop_content(cell)
        dest = STAGING / name
        cell.save(dest)
        out_paths.append(dest)
        print("sliced", dest)
    return out_paths


def save_both(src: Path, folder: str, out_name: str) -> None:
    out = (OUT_DIV if folder == "divine" else OUT_ICO) / out_name
    pub = (PUB_DIV if folder == "divine" else PUB_ICO) / out_name
    process(src, out)
    process(src, pub)


def main() -> None:
    for d in (OUT_DIV, OUT_ICO, PUB_DIV, PUB_ICO, STAGING):
        d.mkdir(parents=True, exist_ok=True)

    rail = CURSOR_ASSETS / "rail_icons_sheet.png"
    faith = CURSOR_ASSETS / "faith_icons_sheet.png"

    if rail.exists():
        slice_grid(
            rail,
            2,
            2,
            ["rail-god.png", "rail-evolve.png", "rail-system.png", "rail-codex.png"],
        )
    if faith.exists():
        slice_row(
            faith,
            6,
            [
                "faith-sight.png",
                "faith-harvest.png",
                "faith-evolution.png",
                "faith-prophet.png",
                "faith-revelation.png",
                "faith-meteor.png",
            ],
        )

    mapping = [
        ("faith-sight.png", "divine", "sight.png"),
        ("faith-harvest.png", "divine", "harvest.png"),
        ("faith-evolution.png", "divine", "evolution.png"),
        ("faith-prophet.png", "divine", "prophet.png"),
        ("faith-revelation.png", "divine", "revelation.png"),
        ("faith-meteor.png", "divine", "meteor.png"),
        ("rail-god.png", "icons", "god.png"),
        ("rail-evolve.png", "icons", "evolve.png"),
        ("rail-system.png", "icons", "system.png"),
        ("rail-codex.png", "icons", "codex.png"),
    ]
    for name, folder, out_name in mapping:
        src = STAGING / name
        if src.exists():
            save_both(src, folder, out_name)
        else:
            print("MISSING", src)

    # extras derived from closest icons
    extras = [
        ("faith-meteor.png", "smite.png", True),
        ("faith-harvest.png", "terraform.png", True),
        ("faith-evolution.png", "dna.png", False),
        ("rail-god.png", "dp.png", False),
        ("rail-system.png", "tp.png", False),
    ]
    for src_name, out_name, divine in extras:
        src = STAGING / src_name
        if not src.exists():
            continue
        save_both(src, "divine" if divine else "icons", out_name)

    print("done")


if __name__ == "__main__":
    main()
