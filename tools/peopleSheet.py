"""Turn a SpriteCook walk-cycle strip (N frames side by side, square cells)
into a people sheet for SpriteOverride.peopleFrames: every frame cropped to
the union of the opaque pixels over the whole loop (one shared box, so the
feet stay planted), stray specks under `min_area` dropped, hard alpha.

  python3 tools/peopleSheet.py strip.png <frames> public/assets/sprites/people-<form>.png
"""
import sys, json, numpy as np
from PIL import Image
from scipy import ndimage
src, n, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
im = np.array(Image.open(src).convert('RGBA'))
H, W = im.shape[:2]; cw = W // n
frames = [im[:, k * cw:(k + 1) * cw].copy() for k in range(n)]
for f in frames:
    a = f[..., 3] > 127
    lab, m = ndimage.label(a)
    if m > 1:
        sizes = ndimage.sum(a, lab, range(1, m + 1))
        keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= max(12, sizes.max() * 0.02)])
        a &= keep
    f[..., 3] = np.where(a, 255, 0)
u = np.zeros(frames[0].shape[:2], bool)
for f in frames: u |= f[..., 3] > 0
ys, xs = np.nonzero(u); y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
fw, fh = int(x1 - x0), int(y1 - y0)
sheet = np.zeros((fh, n * (fw + 2), 4), np.uint8); meta = []
for k, f in enumerate(frames):
    sheet[:, k * (fw + 2):k * (fw + 2) + fw] = f[y0:y1, x0:x1]
    meta.append({'i': k, 'x': k * (fw + 2), 'y': 0, 'w': fw, 'h': fh, 'tag': 'walk'})
Image.fromarray(sheet).save(out, optimize=True)
json.dump({'name': out.rsplit('/', 1)[-1][:-4], 'frames': meta}, open(out[:-4] + '.json', 'w'), indent=1)
print(out, n, 'frames', fw, 'x', fh)
