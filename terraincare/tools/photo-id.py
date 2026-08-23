"""Annotate site photographs with the plants identified in them.

    python tools/photo-id.py

For each photograph: ring the features the identification actually rests on,
number them, and set a panel beside the image carrying the species name, the
library drawing where one exists, the diagnostic features, and a CONFIDENCE.

⚠️ CONFIDENCE IS PART OF THE OUTPUT, NOT A FOOTNOTE. These are phone photographs
taken on a walk, not voucher specimens. Some of what is here is safe to the
species; some is honestly only a genus, and a couple of entries exist to record
that a plant is present and NOT identifiable from this material. Anything that
gets promoted into the species model or printed on the A1 has to survive at
"confident", and ideally be confirmed by someone who knows Troms flora.

⚠️ PHOTOGRAPHS CONTAINING IDENTIFIABLE PEOPLE ARE EXCLUDED BY NAME BELOW, on the
standing GDPR rule. They are not annotated and not written to the output folder,
whatever they might show botanically.
"""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "input" / "images" / "2026-06-06 Site visit Orndalen"
OUT = ROOT / "output" / "plant identification from pictures"
SHAPES = ROOT / "output" / "plant library orndalen" / "_shapes.json"
FONTS = ROOT / "terraincare" / "static" / "fonts"

# Photographs showing identifiable people. Excluded on the GDPR rule.
PEOPLE = {"IMG_9758", "IMG_9759", "IMG_9784", "IMG_9785", "IMG_9786", "IMG_9812"}

CONF = {
    "confident": "CONFIDENT",
    "probable": "PROBABLE",
    "genus": "GENUS ONLY",
    "unresolved": "NOT RESOLVABLE",
}

# marks are (x, y, radius) in fractions of the image's long/short edge.
PHOTOS = {
    "IMG_9773": [dict(id="lupinus", conf="confident",
                      why="Dense blue-violet racemes in a continuous band on road-edge gravel; "
                          "flowering early June; no other tall blue legume forms stands like this here.",
                      marks=[(0.66, 0.66, 0.055), (0.86, 0.67, 0.050)])],
    "IMG_9774": [dict(id="lupinus", conf="confident",
                      why="Same stand from the opposite side. Erect spikes above a low leaf mass, "
                          "colonising bare crushed rock rather than the vegetated slope behind.",
                      marks=[(0.70, 0.51, 0.070), (0.88, 0.51, 0.050)])],
    "IMG_9775": [dict(id="lupinus", conf="confident",
                      why="Stand front on the cut edge between gravel platform and birch scrub.",
                      marks=[(0.60, 0.50, 0.055), (0.76, 0.49, 0.040)])],
    "IMG_9766": [dict(id="lupinus", conf="confident",
                      why="JUVENILE leaves, not flowers: 7–9 narrow leaflets radiating from one "
                          "point like a wheel. Palmately compound this way is diagnostic, and it "
                          "shows the lupin RECRUITING into fresh quarry gravel.",
                      marks=[(0.242, 0.367, 0.055), (0.395, 0.529, 0.045)]),
                 dict(id=None, name="Fern — Dryopteris / Gymnocarpium", conf="genus",
                      why="Finely divided 2–3-pinnate fronds, bright yellow-green, arising direct "
                          "from stony ground. Frond outline and scales needed for species; not "
                          "resolvable here.",
                      marks=[(0.102, 0.415, 0.070), (0.501, 0.803, 0.065)]),
                 dict(id="betula", conf="confident",
                      why="Fallen stem with white-grey papery bark and dark lenticel bands.",
                      marks=[(0.365, 0.389, 0.055)])],
    "IMG_9764": [dict(id=None, name="Geranium sylvaticum", conf="probable",
                      why="Basal leaves palmately cut into 5–7 rounded, coarsely toothed lobes. "
                          "Aconitum is the confusion risk here and has narrower, more deeply "
                          "dissected segments. Flowers would settle it.",
                      marks=[(0.814, 0.337, 0.055), (0.344, 0.755, 0.060)]),
                 dict(id="salix", conf="genus",
                      why="Shrub with narrowly elliptic entire leaves and a strong midrib. "
                          "Salix to genus; S. glauca vs S. phylicifolia needs leaf underside.",
                      marks=[(0.389, 0.589, 0.060)]),
                 dict(id="chamerion", conf="probable",
                      why="Erect unbranched shoot with narrow lance-shaped leaves set spirally — "
                          "the pre-flowering state of rosebay willowherb.",
                      marks=[(0.466, 0.313, 0.045)])],
    "IMG_9765": [dict(id=None, name="Geranium sylvaticum", conf="probable",
                      why="Same lobed basal leaves recurring along the disturbed gravel edge.",
                      marks=[(0.60, 0.78, 0.070), (0.20, 0.72, 0.055)])],
    "IMG_9763": [dict(id="betula", conf="confident",
                      why="Multi-stemmed, white-grey bark, slender leaning trunks over a grass "
                          "field layer — mountain birch as it grows at this latitude.",
                      marks=[(0.45, 0.42, 0.075), (0.16, 0.33, 0.050)])],
    "IMG_9762": [dict(id="betula", conf="confident",
                      why="Mature trunk with fissured grey-brown base and papery bark above.",
                      marks=[(0.13, 0.45, 0.080)])],
    "IMG_9814": [dict(id=None, name="Grass — not identifiable", conf="unresolved",
                      why="A single tussock rooted in crushed asphalt. Recorded because pioneer "
                          "colonisation of made ground is the site's whole argument, but nothing "
                          "here supports even a genus.",
                      marks=[(0.72, 0.62, 0.075)])],
}


def font(name, px):
    p = FONTS / name
    return ImageFont.truetype(str(p), px) if p.exists() else ImageFont.load_default()


def draw_plant(d, shape, box):
    """Draw a library form's elevation into box=(x,y,w,h), standing on its base."""
    x, y, w, h = box
    s = min(w, h) * 0.92
    cx, base = x + w / 2, y + h * 0.94
    fill = (shape["fill"],) * 3 + (255,)
    ink = (shape["ink"],) * 3 + (255,)
    for tri in shape["tris"]:
        d.polygon([(cx + px * s, base + py * s) for px, py in tri],
                  fill=fill, outline=ink, width=2)


def wrap(d, text, fnt, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textbbox((0, 0), t, font=fnt)[2] <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    shapes = json.loads(SHAPES.read_text(encoding="utf8"))
    written = []

    for stem, entries in PHOTOS.items():
        if stem in PEOPLE:
            continue
        src = SRC / f"{stem}.JPG"
        if not src.exists():
            print("missing", stem)
            continue

        # ⚠️ exif_transpose FIRST. Seven of these were shot in portrait and are
        # stored rotated with an orientation tag; without this every mark on
        # them lands 90 degrees away from its feature.
        im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
        im.thumbnail((1900, 1900))
        W, H = im.size
        PANEL = 620
        canvas = Image.new("RGB", (W + PANEL, H), (255, 255, 255))
        canvas.paste(im, (0, 0))
        d = ImageDraw.Draw(canvas, "RGBA")

        f_num = font("QuattrocentoSans-Bold.ttf", 34)
        f_sci = font("QuattrocentoSans-Bold.ttf", 30)
        f_body = font("QuattrocentoSans-Regular.ttf", 21)
        f_cap = font("QuattrocentoSans-Bold.ttf", 17)
        f_ttl = font("QuattrocentoSans-Bold.ttf", 25)

        n = 0
        for e in entries:
            n += 1
            for (mx, my, mr) in e["marks"]:
                cx, cy, r = mx * W, my * H, mr * min(W, H)
                d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 236, 120, 255), width=5)
                d.ellipse([cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3], outline=(20, 20, 20, 190), width=2)
                lx, ly = cx + r * 0.72, cy - r * 0.72
                d.ellipse([lx - 21, ly - 21, lx + 21, ly + 21], fill=(20, 20, 20, 225))
                d.text((lx - 9, ly - 18), str(n), font=f_num, fill=(255, 236, 120, 255))

        # ── panel ────────────────────────────────────────────────────────────
        d.rectangle([W, 0, W + PANEL, H], fill=(255, 255, 255, 255))
        d.line([(W, 0), (W, H)], fill=(26, 26, 26, 255), width=3)
        y = 26
        d.text((W + 26, y), "PLANT IDENTIFICATION", font=f_cap, fill=(120, 120, 120))
        y += 26
        d.text((W + 26, y), f"{stem} · Ørndalen 2026-06-06", font=f_ttl, fill=(26, 26, 26))
        y += 40
        d.line([(W + 26, y), (W + PANEL - 26, y)], fill=(26, 26, 26), width=2)
        y += 22

        n = 0
        for e in entries:
            n += 1
            sid = e.get("id")
            shape = shapes.get(sid) if sid else None
            name = shape["name"] if shape else e["name"]

            d.ellipse([W + 26, y + 2, W + 26 + 34, y + 36], fill=(20, 20, 20))
            d.text((W + 26 + 11, y + 4), str(n), font=f_num, fill=(255, 236, 120))
            d.text((W + 74, y + 4), name, font=f_sci, fill=(26, 26, 26))
            y += 44

            tag = CONF[e["conf"]]
            col = {"CONFIDENT": (40, 110, 60), "PROBABLE": (150, 110, 30),
                   "GENUS ONLY": (150, 110, 30), "NOT RESOLVABLE": (150, 60, 60)}[tag]
            extra = "  ·  INVASIVE (Fremmedartslista)" if (shape and shape["invasive"]) else ""
            d.text((W + 74, y), tag + extra, font=f_cap, fill=col)
            y += 26

            if shape:
                draw_plant(d, shape, (W + 26, y, 150, 150))
                d.text((W + 30, y + 152), f"library form · {shape['form']}", font=f_cap, fill=(120, 120, 120))
                tx, tw = W + 190, PANEL - 216
            else:
                d.rectangle([W + 26, y, W + 176, y + 150], outline=(190, 190, 190), width=2)
                for i, ln in enumerate(["NOT IN", "LIBRARY"]):
                    d.text((W + 46, y + 58 + i * 22), ln, font=f_cap, fill=(150, 60, 60))
                tx, tw = W + 190, PANEL - 216

            ty = y
            for ln in wrap(d, e["why"], f_body, tw):
                d.text((tx, ty), ln, font=f_body, fill=(60, 60, 60))
                ty += 26
            y = max(y + 178, ty + 14)
            d.line([(W + 26, y), (W + PANEL - 26, y)], fill=(214, 214, 214), width=1)
            y += 20

        d.text((W + 26, H - 62), "Identified from photographs only. Not a field survey.",
               font=f_cap, fill=(120, 120, 120))
        d.text((W + 26, H - 38), "Terrain data © Kartverket (hoydedata.no), NLOD / CC BY 4.0",
               font=f_cap, fill=(150, 150, 150))

        dest = OUT / f"{stem}-identified.jpg"
        canvas.save(dest, quality=92)
        written.append((dest.name, [e.get("name") or shapes[e["id"]]["name"] for e in entries]))

    for name, sp in written:
        print(f"{name:34s} {', '.join(sp)}")
    print(f"\n{len(written)} annotated, {len(PEOPLE)} excluded for GDPR (people visible)")


if __name__ == "__main__":
    main()
