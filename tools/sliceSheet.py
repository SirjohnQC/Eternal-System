import sys, json, numpy as np
from PIL import Image
from scipy import ndimage
src, out_png, out_json, name = sys.argv[1:5]
merge = int(sys.argv[5]) if len(sys.argv) > 5 else 4
im = np.array(Image.open(src).convert('RGBA'))
a = im[..., 3] > 127
lab, n = ndimage.label(ndimage.binary_dilation(a, iterations=merge))
boxes = []
for i, sl in enumerate(ndimage.find_objects(lab), 1):
    m = (lab[sl] == i) & a[sl]
    if m.sum() < 60: continue
    ys, xs = np.nonzero(m)
    y0, y1, x0, x1 = sl[0].start + ys.min(), sl[0].start + ys.max() + 1, sl[1].start + xs.min(), sl[1].start + xs.max() + 1
    boxes.append(tuple(int(v) for v in (y0, x0, y1, x1)))
# reading order: rows by centre y (bucketed), then x
boxes.sort(key=lambda b: (round(((b[0]+b[2])/2) / 40), b[1]))
# pack into a strip atlas, 2px gaps
W = sum(b[3]-b[1] for b in boxes) + 2*len(boxes); H = max(b[2]-b[0] for b in boxes)
atlas = np.zeros((H, W, 4), np.uint8); frames = []; x = 0
for k, (y0, x0, y1, x1) in enumerate(boxes):
    crop = im[y0:y1, x0:x1].copy(); crop[..., 3] = np.where(crop[..., 3] > 127, 255, 0)
    h, w = crop.shape[:2]
    atlas[H-h:H, x:x+w] = crop
    frames.append({'i': k, 'x': x, 'y': H-h, 'w': w, 'h': h}); x += w + 2
Image.fromarray(atlas).save(out_png, optimize=True)
json.dump({'name': name, 'frames': frames}, open(out_json, 'w'), indent=1)
print(name, len(frames), [(f['w'], f['h']) for f in frames])
