"""Regenerate the source art in assets/ that @capacitor/assets turns into every
iOS / Android icon and splash size.  Run: python3 scripts/mobile-make-source-art.py
(needs Pillow).  Brand: EstimateAce emerald #10b981 -> #059669, white "EA"."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets')
os.makedirs(OUT, exist_ok=True)
FONT = '/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf'
TOP, BOTTOM = (16, 185, 129), (5, 150, 105)


def font(size, weight=800):
    f = ImageFont.truetype(FONT, size)
    try:
        f.set_variation_by_axes([32, weight])  # opsz, wght
    except Exception:
        pass
    return f


def gradient(size):
    img = Image.new('RGB', (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
    return img


def draw_mark(img, cx, cy, scale):
    """White 'EA' with a check-style underline, centred at (cx, cy)."""
    d = ImageDraw.Draw(img)
    f = font(int(430 * scale))
    box = d.textbbox((0, 0), 'EA', font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text((cx - w / 2 - box[0], cy - h / 2 - box[1] - 40 * scale), 'EA', font=f, fill='white')
    # underline bar
    bw, bh = 470 * scale, 44 * scale
    top = cy + h / 2 + 10 * scale
    d.rounded_rectangle([cx - bw / 2, top, cx + bw / 2, top + bh], radius=bh / 2, fill='white')


# Full-bleed app icon (no transparency, no rounded corners: Apple / Google mask it).
icon = gradient(1024)
draw_mark(icon, 512, 512, 1.0)
icon.save(os.path.join(OUT, 'icon-only.png'))

# Android adaptive icon: background + transparent foreground (mark inside the safe 66%).
gradient(1024).save(os.path.join(OUT, 'icon-background.png'))
fg = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
draw_mark(fg, 512, 512, 0.62)
fg.save(os.path.join(OUT, 'icon-foreground.png'))

# Splash: rounded icon + wordmark on white (light) / slate (dark).
for name, bg, ink in (('splash.png', (255, 255, 255), (30, 41, 59)), ('splash-dark.png', (15, 23, 42), (255, 255, 255))):
    s = Image.new('RGB', (2732, 2732), bg)
    tile = gradient(640)
    draw_mark(tile, 320, 320, 0.625)
    mask = Image.new('L', (640, 640), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, 639, 639], radius=140, fill=255)
    s.paste(tile, (1046, 960), mask)
    d = ImageDraw.Draw(s)
    f = font(150, 750)
    text = 'EstimateAce'
    b = d.textbbox((0, 0), text, font=f)
    d.text((1366 - (b[2] - b[0]) / 2 - b[0], 1700), text, font=f, fill=ink)
    s.save(os.path.join(OUT, name))
print('wrote', sorted(os.listdir(OUT)))
