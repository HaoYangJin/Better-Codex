from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
BUILD.mkdir(exist_ok=True)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


size = 1024
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
background = Image.new("RGBA", (size, size), (18, 19, 22, 255))
pixels = background.load()
for y in range(size):
    for x in range(size):
        glow = max(0.0, 1.0 - (((x - 790) ** 2 + (y - 160) ** 2) ** 0.5) / 760)
        r, g, b, a = pixels[x, y]
        pixels[x, y] = (
            int(r + 42 * glow),
            int(g + 54 * glow),
            int(b + 104 * glow),
            a,
        )
background.putalpha(rounded_mask(size, 220))
image.alpha_composite(background)

draw = ImageDraw.Draw(image)
draw.rounded_rectangle((116, 116, 908, 908), radius=190, outline=(255, 255, 255, 30), width=8)
bars = [
    (238, 590, 330, 766, (242, 242, 242, 255)),
    (386, 456, 478, 766, (181, 198, 255, 255)),
    (534, 516, 626, 766, (242, 242, 242, 255)),
    (682, 334, 774, 766, (118, 215, 178, 255)),
]
for left, top, right, bottom, color in bars:
    draw.rounded_rectangle((left, top, right, bottom), radius=38, fill=color)
draw.ellipse((704, 222, 764, 282), fill=(242, 242, 242, 255))

icon = image.resize((512, 512), Image.Resampling.LANCZOS)
icon.save(BUILD / "icon.png", "PNG")
icon.save(
    BUILD / "icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
