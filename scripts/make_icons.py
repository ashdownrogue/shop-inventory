from PIL import Image, ImageDraw

STEEL_BG = (20, 24, 27)
PLATE = (30, 37, 42)
CAUTION = (237, 181, 32)
SAFETY = (53, 160, 78)
WARNING = (224, 115, 28)
STEEL6 = (57, 69, 77)
CHALK = (233, 231, 226)


def make(size, maskable=False):
    img = Image.new("RGBA", (size, size), STEEL_BG)
    d = ImageDraw.Draw(img)
    m = int(size * (0.20 if maskable else 0.09))   # safe zone for maskable
    box = (m, m, size - m, size - m)
    d.rectangle(box, fill=PLATE)

    inner = size - 2 * m
    # placard edge bar, the app's signature device
    bar_w = max(3, int(inner * 0.11))
    d.rectangle((m, m, m + bar_w, size - m), fill=CAUTION)

    # check mark
    cx0 = m + bar_w + inner * 0.16
    cy0 = m + inner * 0.54
    lw = max(3, int(inner * 0.115))
    d.line([(cx0, cy0), (cx0 + inner * 0.20, cy0 + inner * 0.20)], fill=CHALK, width=lw)
    d.line([(cx0 + inner * 0.20, cy0 + inner * 0.20),
            (cx0 + inner * 0.62, cy0 - inner * 0.30)], fill=CHALK, width=lw)

    # segmented gauge strip along the bottom
    gy = size - m - max(3, int(inner * 0.13))
    gh = max(2, int(inner * 0.075))
    gx = m + bar_w
    gw = size - m - gx
    for frac, col in ((0.55, SAFETY), (0.22, WARNING), (0.23, STEEL6)):
        w = int(gw * frac)
        d.rectangle((gx, gy, gx + w, gy + gh), fill=col)
        gx += w
    return img


for s in (192, 512):
    make(s).save(f"icons/icon-{s}.png")
make(512, maskable=True).save("icons/icon-maskable-512.png")
make(180).save("icons/apple-touch-icon.png")
print("icons written")
