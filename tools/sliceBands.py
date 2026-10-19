"""Slice a sprite sheet whose sprites touch diagonally: split into row bands at
empty rows, then into sprites at empty columns within each band. Frames get
tag 'age<row>' (row index, top = 0) unless --ages gives one per frame.

  python3 tools/sliceBands.py sheet.png out.png out.json name [--ages 0,0,1,1,...]
"""
import sys, json, numpy as np
from PIL import Image
src, out_png, out_json, name = sys.argv[1:5]
ages = None
if '--ages' in sys.argv: ages = [int(a) for a in sys.argv[sys.argv.index('--ages') + 1].split(',')]
im = np.array(Image.open(src).convert('RGBA')); a = im[..., 3] > 127

def runs(mask):
    out, i = [], 0
    while i < len(mask):
        if mask[i]:
            s = i
            while i < len(mask) and mask[i]: i += 1
            out.append((s, i))
        i += 1
    return out

boxes = []
for r, (r0, r1) in enumerate(runs(a.any(1))):
    band = a[r0:r1]
    for (c0, c1) in runs(band.any(0)):
        m = band[:, c0:c1]
        if m.sum() < 60: continue
        ys = np.nonzero(m.any(1))[0]
        boxes.append((r, r0 + int(ys.min()), c0, r0 + int(ys.max()) + 1, c1))
H = max(b[3] - b[1] for b in boxes); W = sum(b[4] - b[2] + 2 for b in boxes)
atlas = np.zeros((H, W, 4), np.uint8); frames = []; x = 0
for k, (r, y0, x0, y1, x1) in enumerate(boxes):
    c = im[y0:y1, x0:x1].copy(); c[..., 3] = np.where(c[..., 3] > 127, 255, 0); h, w = c.shape[:2]
    atlas[H - h:H, x:x + w] = c
    frames.append({'i': k, 'x': x, 'y': H - h, 'w': w, 'h': h, 'tag': 'age%d' % (ages[k] if ages else r)}); x += w + 2
Image.fromarray(atlas).save(out_png, optimize=True)
json.dump({'name': name, 'frames': frames}, open(out_json, 'w'), indent=1)
print(name, len(frames), [f['tag'] for f in frames])
