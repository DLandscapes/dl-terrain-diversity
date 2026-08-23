"""Render the 4x4 plant plate to plant-overview.png.

    python tools/plantlib-png.py

Reads `_plate.json`, which plantlib-svg.mjs writes as a POSITIONED display list
rather than as parameters. That is deliberate: the SVG and the PNG then draw the
same coordinates, so the two outputs cannot drift apart. All this script decides
is millimetres-to-pixels and how to draw text.

Text uses the fonts the app itself vendors, so the plate matches the tool and
the A1 poster rather than falling back to whatever PIL has lying around.

The background is transparent, matching the poster brief: the sheet is white on
paper, and white on paper is nothing at all.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output" / "plant library orndalen"
FONTS = ROOT / "terraincare" / "static" / "fonts"
DPI = 300
MM_PX = DPI / 25.4          # 11.811 px per mm
SS = 3                      # supersample, then downscale — PIL has no AA on lines


def font(name, mm):
    """A vendored face at a size given in millimetres of final output."""
    px = max(1, round(mm * MM_PX * SS))
    for candidate in (name, "QuattrocentoSans-Regular.ttf", "SourceSans3-VariableFont_wght.ttf"):
        path = FONTS / candidate
        if path.exists():
            return ImageFont.truetype(str(path), px)
    return ImageFont.load_default()


def centred(draw, xy, text, fnt, fill):
    x, y = xy
    left, top, right, bottom = draw.textbbox((0, 0), text, font=fnt)
    draw.text((x - (right - left) / 2 - left, y - top), text, font=fnt, fill=fill)


def main():
    data = json.loads((OUT / "_plate.json").read_text(encoding="utf8"))
    W = round(data["plateW"] * MM_PX) * SS
    H = round(data["plateH"] * MM_PX) * SS
    s = MM_PX * SS                      # mm -> supersampled px

    img = Image.new("RGBA", (W, H), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)

    ink = (26, 26, 26, 255)
    grey = (107, 107, 107, 255)
    hair = (180, 180, 180, 255)

    f_title = font("QuattrocentoSans-Bold.ttf", 7.0)
    f_cap = font("QuattrocentoSans-Regular.ttf", 3.0)
    f_sci = font("QuattrocentoSans-Bold.ttf", 3.4)
    f_hab = font("QuattrocentoSans-Regular.ttf", 2.4)
    f_dim = font("QuattrocentoSans-Regular.ttf", 2.3)
    f_band = font("QuattrocentoSans-Bold.ttf", 2.4)
    f_prop = font("QuattrocentoSans-Bold.ttf", 2.2)

    marg = data["marg"]
    d.text((marg * s, 8 * s), "Plant library · Ørndalen", font=f_title, fill=ink)
    cap = "ORDERED WET → XERIC · FACE OPACITY = MOISTURE · EACH CELL TO ITS OWN SCALE BAR"
    bb = d.textbbox((0, 0), cap, font=f_cap)
    d.text(((data["plateW"] - marg) * s - (bb[2] - bb[0]), 9.5 * s), cap, font=f_cap, fill=grey)
    d.line([(marg * s, (data["topbar"] - 4) * s),
            ((data["plateW"] - marg) * s, (data["topbar"] - 4) * s)], fill=ink, width=max(1, round(0.3 * s)))

    for c in data["cells"]:
        fill = (c["fill"],) * 3 + (255,)
        stroke = (c["stroke"],) * 3 + (255,)
        base = c["baseline"] * s

        d.text(((c["x0"] + 6) * s, (c["y0"] + 2.6) * s), c["band"],
               font=f_band, fill=(138, 138, 138, 255))
        if c.get("proposed"):
            bb = d.textbbox((0, 0), "PROPOSED", font=f_prop)
            d.text(((c["x0"] + c["cellW"] - 6) * s - (bb[2] - bb[0]), (c["y0"] + 2.8) * s),
                   "PROPOSED", font=f_prop, fill=(160, 138, 90, 255))

        d.line([((c["x0"] + 6) * s, base), ((c["x0"] + c["cellW"] - 6) * s, base)],
               fill=hair, width=max(1, round(0.18 * s)))

        # Painter's order is already baked into the list by the generator.
        for pts in c["tris"]:
            poly = [(x * s, y * s) for x, y in pts]
            d.polygon(poly, fill=fill, outline=stroke, width=max(1, round(0.20 * s)))

        half = c["bar"]["px"] / 2
        d.line([((c["cx"] - half) * s, base + 4 * s), ((c["cx"] + half) * s, base + 4 * s)],
               fill=ink, width=max(1, round(0.35 * s)))
        for end in (-half, half):
            d.line([((c["cx"] + end) * s, base + 3.2 * s), ((c["cx"] + end) * s, base + 4.8 * s)],
                   fill=ink, width=max(1, round(0.25 * s)))

        centred(d, (c["cx"] * s, base + 5.6 * s),
                f"{c['bar']['label']} · {c['dims']}", f_dim, grey)
        centred(d, (c["cx"] * s, (c["y0"] + c["cellH"] - 13.5) * s), c["name"], f_sci, ink)
        centred(d, (c["cx"] * s, (c["y0"] + c["cellH"] - 8.5) * s), c["habit"], f_hab, grey)

    img = img.resize((W // SS, H // SS), Image.LANCZOS)
    dest = OUT / "plant-overview.png"
    img.save(dest, "PNG", dpi=(DPI, DPI))
    alpha = img.getchannel("A")
    clear = sum(1 for p in alpha.getdata() if p == 0)
    total = img.width * img.height
    print(f"{dest.name}  {img.width}x{img.height}px @ {DPI}dpi  "
          f"({data['plateW']}x{data['plateH']} mm)")
    print(f"transparent: {100 * clear / total:.1f}% of pixels")


if __name__ == "__main__":
    sys.exit(main())
