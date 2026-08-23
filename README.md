# DL-TerrainDiversity

**A Terrain Design Information Model (TDIM) for landscape architecture.**
A browser-based terrain design instrument in which a designer shapes ground with
a hand and the ground answers: hydrology recomputes within a few milliseconds of
the gesture, radiation, shelter and landform on settling, and a modelled species
assemblage over the top — all in the same frame as the gesture that caused them.

A model of terrain is a DTM. **The design is the distinction.** The drawings —
grading plan, sections, cut/fill isopach, slope classes, drainage plan, GIS
rasters — are *derived from* the model, not drawn over it.

> **It is a terrain analysis instrument. Not a prediction.**
> Where it names species it reports which ones the stated tolerances would suit,
> not which will establish. The vegetation model is a set of assumptions, not a
> measurement.

---

## Run it

No installation, no build step, no bundler, no network.

```bash
python terraincare/launcher.py
```

Then open <http://localhost:8994>. That is the whole setup. The launcher is a
static file server with cache headers and a `/data/` mount; any static server
will do, which is why this can also simply be hosted.

It opens on a **synthetic flat plane**, not on survey data — see
[Data](#data-and-what-is-deliberately-not-here).

## Test it

```bash
node terraincare/static/_selftest.mjs     # 547 checks, headless
```

The render suite is browser-only because it asserts on pixels and on the
geometry the GPU actually receives:

```
http://localhost:8994/selftest-render.html   # 162 checks, needs a GPU
```

Both suites are part of the source, not a CI afterthought. The kernel suite runs
identically in Node and in the browser, over the same modules the app loads.

---

## What it computes

For a loaded DEM the analysis worker returns fifteen layers:

| | | |
|---|---|---|
| elevation | slope | aspect |
| ruggedness (TRI) | wetness (TWI) | catchment |
| hollows (depressions) | watersheds | landform (geomorphons) |
| sky view factor | openness | solar radiation |
| shelter (wind) | species assemblage | cut and fill |

plus hillshade as the form view, and a substrate layer once one is specified.

Analysis runs in a Web Worker with latest-wins coalescing; the main thread does
local 3×3 operations over the dirty rectangle on the gesture's own frame. Ramps
are percentile-stretched 2–98 % **per dataset**, because TRI and TWI are
scale-dependent and no fixed domain serves two sites.

> ⚠️ **If you are making a before/after comparison, hold the domain.** Stretching
> each state to itself is right on screen and wrong in a figure: identical values
> then render as different colours. `analysis/ramps.js` exports `colourise` and
> `percentileDomain` so a caller can take the domain once and reuse it.

**Flow accumulation is MFD, not D8** — except watersheds (a partition), rainfall
routing (a parcel settles in one place) and drawn drainage channels (a line needs
one direction), each of which says so on its face.

## What leaves it

- **GeoTIFF** — float32 *values*, not colours; every layer, georeferenced
- **OBJ** — the surface, and a watertight solid for printing
- **Shapefile / GeoJSON** — regions with their attributes
- **SVG / PDF** — grading plan, chainage sections, isopach, slope classes
- **ZIP** — the lot, with a key and a provenance record

Every export carries its cell size, its CRS, its limits of detection and the
provenance of each layer, because an image that travels without its author has to
be readable a year later by someone who was not there.

---

## Data, and what is deliberately not here

Shipped: `data/teaching/` — two **synthetic** tiles where every cell is exactly
75.000 m. They contain no measurement and carry no Kartverket attribution
because Kartverket had no part in them. They exist so the tool opens without
fetching anything, and so a workshop starts in the *collapsed* state and has to
earn its way out by moving material deliberately.

Their georeference is real (EPSG:25833, the Ørndalen origins) because the biotic
model is calibrated for Troms — species envelopes, solar geometry at 69.7 °N,
the prevailing Tromsø south-wester. Move the tiles elsewhere and the biotic layer
stops meaning anything.

Also shipped: `data/orndalen/` — the real **Ørndalen** terrain, 0.25 m and 4 m,
**© Kartverket (hoydedata.no), NLOD / CC BY 4.0**. Included because that licence
permits redistribution with attribution, and because without it this repository
could not run its own test suite or reproduce a single published figure. About
1.1 MB buys both.

> ⚠️ **Crediting Kartverket is a licence condition, not a courtesy.** Anything
> derived from these tiles must carry it. The instrument does this automatically
> wherever terrain is shown.

**Not shipped:**

- **Orthophotography.** Licensed education-and-research only; never
  redistributable. `static/ortho.js` is here because it is the *reader*, not the
  image.
- **Site photographs.** Held back pending a GDPR review.

---

## The site the work is tested on

**Ørndalen**, northern Tromsøya (EPSG:25833, NN2000) — a hard-rock quarry worked
out by 1997, then an unengineered municipal landfill, with a live 2025–2036
municipal proposal to reopen it for roughly 750,000 m³ of clean masses. The
decision is current, which makes it a case rather than an example.

The claim the instrument was built to test: **the relief that differentiates
habitat falls below the resolution of national terrain and soil data, and
therefore has to be designed and specified rather than surveyed.** At the
national 4 m grid the engineered-to-natural ruggedness contrast is only 1.6×;
national Quaternary geology at 1:50,000 describes ground that was excavated and
replaced decades ago, and AR5 at 1:5,000 returns a single polygon across a
4,096 m² design patch.

> ⚠️ **Caveats that must travel with any figure produced here.** One site, one
> classification, one tile. The *direction* of these results is robust; the third
> decimal is not. Do not quote them to three decimals.

---

## Lineage

The Terrain Design Information Model was defined by the author at the University
of Innsbruck and published on 23 April 2018:
<https://digital-landscapes.com/2018/04/23/digital-terrain-design-information-model/>

## Citing

See [`CITATION.cff`](CITATION.cff), which GitHub renders as a
"Cite this repository" button.

---

## Disclaimer

**This is a terrain analysis instrument. It is not a prediction, and it is not a
substitute for survey, ground investigation or engineering design.**

- **The vegetation model is a set of assumptions, not a measurement.** Where the
  tool names species it reports which ones the stated tolerances would *suit* —
  not which will establish, compete or persist. Real establishment depends on
  seed source, management, grazing, succession and weather, none of which are
  modelled here.
- **Do not build from these numbers.** Cut and fill volumes, levels, batters and
  slope classes are for design exploration. Anything going to construction,
  tender or a regulatory submission needs an independent check by a qualified
  engineer or surveyor against a current survey.
- **The results inherit their data's errors.** The tool computes faithfully on
  the surface it is given; it does not detect or correct error in that surface.
  Airborne LiDAR carries its own vertical uncertainty, and on this site
  single-epoch noise is roughly the same magnitude as the micro-relief being
  studied. That is a finding, not a bug — but it means a difference smaller than
  the noise is not a difference.
- **One site, one classification, one tile.** The published results come from a
  single 64 m patch on one former quarry-and-landfill in arctic Norway. The
  direction of those results is robust. The third decimal is not, and none of it
  should be generalised to other ground without re-measuring.
- **The biotic layer is geolocated.** Species envelopes, solar geometry at
  69.7 °N and the prevailing wind are calibrated for Troms. Load terrain from
  somewhere else and the abiotic readings still hold, but the vegetation
  assemblage stops meaning anything.

No warranty is given. See sections 7 and 8 of the [`LICENSE`](LICENSE) for the
formal statement: the software is provided "as is", without warranties or
conditions of any kind, and the contributors are not liable for damages arising
from its use.

## Credits

Built on open source, with thanks to the people who maintain it:

- **[three.js](https://threejs.org/)** — the WebGL scene, camera and offline
  render path. Vendored, not fetched, so the tool runs with no network and no
  build step.
- **Python** and its standard library — the launcher and the capture server use
  nothing else.
- **[Pillow](https://python-pillow.org/)** — image handling in the development
  tools.
- **[resvg](https://github.com/linebender/resvg)** (`@resvg/resvg-js`) —
  rasterises exported SVG figures. A development dependency; not needed to run
  the instrument.
- **Source Sans 3** (Adobe) and **Quattrocento Sans** (Pablo Impallari, Rodrigo
  Fuenzalida, Brenda Gallo) — both under the SIL Open Font License.
- **[SAGA GIS](https://saga-gis.sourceforge.io/)** and
  **[QGIS](https://qgis.org/)** — not dependencies, but the definitions this
  tool's indices follow, so that a value computed here means the same thing as a
  value computed there.

Full licence details, and the paths where each licence text lives, are in
[`NOTICE`](NOTICE).

Terrain data © **Kartverket** (hoydedata.no), NLOD / CC BY 4.0. Quaternary
geology © **NGU**. Area resource map AR5 © **NIBIO**.

**Developed by Digital Landscapes with AI assistance. The Terrain Design
Information Model, the design decisions and all verification are Digital
Landscapes' own.**

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE). Third-party components redistributed here
(three.js, Source Sans 3, Quattrocento Sans) are listed with their licences in
[`NOTICE`](NOTICE); each licence text sits beside the files it covers.

DL-TerrainDiversity is developed and owned by **Digital Landscapes**
(Marc-Eduard Ihle) and is applied at UiT The Arctic University of Norway in
landscape architecture teaching.

---

*Terrain data © Kartverket (hoydedata.no), NLOD / CC BY 4.0. Quaternary geology
© NGU. Area resource map AR5 © NIBIO. Indices computed with SAGA/QGIS
definitions.*
