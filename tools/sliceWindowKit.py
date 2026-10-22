"""Slice the window kit (gaming-style windows, owner's ask Oct 22) into 9-slice pieces.

Source: assets/pixel/ui/window_kit_sheet.png, one SpriteCook sheet (Nano Banana 2.1,
in the card-frame sheet's style): a gilded gunmetal window, a title plate, an inset
panel and a button, all drawn at their final pixel size.

Writes to public/assets/pixel/ui/ and mirrors to assets/pixel/ui/:
  window.png    96x96   9-slice 40 (filigree corners); centre filled dark indigo
  plate.png     104x59  3-slice 44 (pointed end caps, diamond studs) at a fixed height; titles
  plate_s.png   72x29   3-slice 22: the plate redrawn at half size, for section heads
  panel.png     40x40   9-slice 12 (gold corner studs); centre filled darker
  button.png    36x38   9-slice 12 10; the face recoloured to the plate's indigo

Every edge between the corners is rebuilt from one clean column/row, so a stretched
edge never smears a gem or noise. Run:  python tools/sliceWindowKit.py
"""
import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'pixel', 'ui', 'window_kit_sheet.png')
OUTS = [os.path.join(ROOT, 'public', 'assets', 'pixel', 'ui'), os.path.join(ROOT, 'assets', 'pixel', 'ui')]

sheet = np.array(Image.open(SRC).convert('RGBA'))
# Pieces on the sheet (x, y, w, h), from its connected components.
WIN, PLATE, PANEL, BTN = (41, 18, 161, 167), (229, 40, 263, 59), (85, 198, 74, 74), (384, 188, 82, 38)


def crop(b):
    x, y, w, h = b
    return sheet[y:y + h, x:x + w].copy()


def harden(a):
    """Alpha to 0/255: pixel art has no half-covered pixels."""
    a[..., 3] = np.where(a[..., 3] >= 128, 255, 0)
    return a


def nine(src, cl, ct, cr, cb, mid_w, mid_h, col_x=None, row_y=None):
    """Rebuild `src` as corners + edges tiled from one column/row, middle `mid_w` x `mid_h`."""
    h, w = src.shape[:2]
    cx = col_x if col_x is not None else w // 2
    ry = row_y if row_y is not None else h // 2
    out = np.zeros((ct + mid_h + cb, cl + mid_w + cr, 4), np.uint8)
    W, H = out.shape[1], out.shape[0]
    out[:ct, :cl] = src[:ct, :cl]
    out[:ct, W - cr:] = src[:ct, w - cr:]
    out[H - cb:, :cl] = src[h - cb:, :cl]
    out[H - cb:, W - cr:] = src[h - cb:, w - cr:]
    out[:ct, cl:W - cr] = src[:ct, cx:cx + 1]
    out[H - cb:, cl:W - cr] = src[h - cb:, cx:cx + 1]
    out[ct:H - cb, :cl] = src[ry:ry + 1, :cl]
    out[ct:H - cb, W - cr:] = src[ry:ry + 1, w - cr:]
    out[ct:H - cb, cl:W - cr] = src[ry, cx]
    return out


def hstretch(src, cl, cr, mid_w, col_x=None):
    """Rebuild `src` as its full-height end caps plus a middle tiled from one column (a plate keeps its height)."""
    h, w = src.shape[:2]
    cx = col_x if col_x is not None else w // 2
    out = np.zeros((h, cl + mid_w + cr, 4), np.uint8)
    out[:, :cl] = src[:, :cl]
    out[:, cl + mid_w:] = src[:, w - cr:]
    out[:, cl:cl + mid_w] = src[:, cx:cx + 1]
    return out


def fill_inside(a, rgba):
    """Fill the transparent region connected to the centre (the window's opening)."""
    from collections import deque
    h, w = a.shape[:2]
    seen = np.zeros((h, w), bool)
    q = deque([(h // 2, w // 2)])
    while q:
        y, x = q.popleft()
        if y < 0 or x < 0 or y >= h or x >= w or seen[y, x] or a[y, x, 3] > 0:
            continue
        seen[y, x] = True
        q.extend(((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)))
    a[seen] = rgba
    return a


def save(a, name):
    im = Image.fromarray(a, 'RGBA')
    for d in OUTS:
        os.makedirs(d, exist_ok=True)
        im.save(os.path.join(d, name), optimize=True)
    print(name, im.size)


# The window: 40 px corners hold the filigree; the top edge's gem is left out
# (the title plate sits there). Its opening is filled with the window's ground.
win = harden(crop(WIN))
win = nine(win, 40, 40, 40, 40, 16, 16, col_x=54, row_y=win.shape[0] // 2)
save(fill_inside(win, (16, 12, 24, 255)), 'window.png')

# The title plate: pointed caps and studs in 44 px, a clean middle.
plate = harden(crop(PLATE))
plate = hstretch(plate, 44, 44, 16)
save(plate, 'plate.png')

# The small plate for section heads: the big plate at half size, each output pixel
# the most common of its 2x2 source (no new colours), then rebuilt clean.
p = plate
h2, w2 = p.shape[0] // 2, p.shape[1] // 2
small = np.zeros((h2, w2, 4), np.uint8)
for y in range(h2):
    for x in range(w2):
        block = p[2 * y:2 * y + 2, 2 * x:2 * x + 2].reshape(-1, 4)
        opaque = [tuple(c) for c in block if c[3]]
        if len(opaque) >= 2:
            # the darkest of the opaque pixels keeps the outline and bevel lines
            small[y, x] = min(opaque, key=lambda c: int(c[0]) + int(c[1]) + int(c[2]))
small = hstretch(small, 22, 22, 28)
save(small, 'plate_s.png')

# The inset panel: gold corner studs in 12 px; a darker well inside.
panel = harden(crop(PANEL))
panel = nine(panel, 12, 12, 12, 12, 16, 16)
save(fill_inside(panel, (10, 8, 16, 255)), 'panel.png')

# The button: gold rim in 10-12 px; its grey face recoloured to the plate's indigo
# by luminance, so it belongs to the same family.
btn = harden(crop(BTN))
plate_mid = crop(PLATE)[29, 131][:3].astype(int)
face = btn[..., :3].astype(int)
r, g, b = face[..., 0], face[..., 1], face[..., 2]
grey = (np.abs(r - g) < 18) & (np.abs(g - b) < 22) & (btn[..., 3] > 0)
lum = (0.3 * r + 0.59 * g + 0.11 * b) / 64.0
tint = np.clip(plate_mid[None, None, :] * lum[..., None] * 1.05, 0, 255).astype(np.uint8)
btn[grey, :3] = tint[grey]
btn = nine(btn, 12, 10, 12, 10, 12, 18)
save(btn, 'button.png')
