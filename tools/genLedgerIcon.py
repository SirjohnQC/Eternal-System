"""Draw the LEDGER rail icon (public/assets/pixel/icons/ledger.png), 24x24, in the
Chronicle icon's palette: a framed tablet with three rising bars and a trend line.

    python3 tools/genLedgerIcon.py
"""
from PIL import Image

INK = (42, 28, 72, 255)        # dark fill
EDGE = (123, 94, 167, 255)     # frame
HI = (170, 136, 221, 255)      # frame highlight
ORANGE = (255, 153, 68, 255)
GOLD = (200, 169, 110, 255)
CREAM = (255, 221, 153, 255)

im = Image.new('RGBA', (24, 24), (0, 0, 0, 0))
px = im.load()

def rect(x0, y0, x1, y1, c):
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            px[x, y] = c

# Tablet: frame, then the dark face.
rect(2, 3, 21, 21, EDGE)
rect(3, 4, 20, 20, INK)
for x in range(3, 21):
    px[x, 3] = HI                # top highlight
for y in range(4, 21):
    px[2, y] = HI                # left highlight
# Baseline.
rect(5, 18, 18, 18, EDGE)
# Three rising bars.
rect(6, 14, 7, 17, GOLD)
rect(10, 11, 11, 17, GOLD)
rect(14, 8, 15, 17, ORANGE)
# Trend line over the bars, ending in a bright point.
for x, y in [(5, 12), (6, 11), (7, 11), (8, 10), (9, 9), (10, 9), (11, 8), (12, 7), (13, 6), (14, 6), (15, 5), (16, 5)]:
    px[x, y] = HI
px[17, 5] = CREAM
px[17, 4] = CREAM

im.save('public/assets/pixel/icons/ledger.png')
im.resize((192, 192), Image.NEAREST).save('.cache/ledger_big.png')
print('wrote public/assets/pixel/icons/ledger.png')
