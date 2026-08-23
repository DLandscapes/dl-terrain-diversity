// @ts-check
// THE INSTRUMENT'S OWN GLOSSARY — one entry per reading, shown as a hover
// popover on the HUD cards, the index rail, the analysis layers and the
// Measured rows (2026-08-11, "educational but also scientific").
//
// ⚠️ ONE TABLE FOR EVERY SURFACE. The same key answers the analysis thumbnail,
// the Measured row and the HUD card, so the tool cannot explain one reading
// two ways. Bodies are two sentences at most: a definition and what it is FOR.
// The source line names the method actually computed — the same definitions as
// SAGA GIS / QGIS, per the Method panel — not merely related literature.
//
// ⚠️ SPECIES AND HABITAT ENTRIES REPEAT THE HOUSE CLAIM. Suitability is an
// assumption over stated tolerance envelopes; nothing biotic here is measured
// or predicted, and every biotic entry says so rather than citing borrowed
// authority for it.

/** @type {Record<string, {t: string, b: string, s?: string}>} */
export const INFO = {
  // ── what the tool is ─────────────────────────────────────────────────────
  // ⚠️ THIS WAS A WHOLE MENU SECTION (2026-08-12, Marc: it "does not deserve"
  // one). It is four sentences that are read once and never again, and it was
  // costing a permanent header, a badge and a fold in a column that had already
  // been cut twice for length. As an entry here it reaches the same reader from
  // the wordmark, and it joins the one table that already answers every other
  // "what is this" in the tool — so the tool's own description cannot drift
  // from the vocabulary it explains everything else with.
  // ⚠️ THE CATEGORY LINE COMES FIRST, AND IT IS A MODEL *FOR* DESIGNING GROUND,
  // NOT A MODEL *OF* IT — a model of terrain is a DTM, which every GIS already
  // has. The D is the whole distinction, which is why "TIM" was rejected
  // (2026-08-13): it collapses into DTM, and collides with Terrain Inventory
  // Mapping in this very field. The honesty line that follows is unchanged and
  // must stay: this instrument does not predict.
  method: {
    t: "Terrain Diversity — what this is",
    b: "A Terrain Design Information Model (TDIM): the ground held as a model "
      + "you design with, from which the drawings — grading plan, sections, "
      + "isopach, GIS rasters — are derived rather than drawn. "
      + "A terrain analysis instrument, not a predictive model. Indices are "
      + "computed live with the same definitions as SAGA GIS and QGIS: Horn 3×3 "
      + "slope, Freeman–Quinn multiple-flow-direction accumulation, "
      + "TWI = ln(a/tanβ), Riley-style ruggedness. Closed depressions are "
      + "inventoried, never filled. The biotic layer is a stated design "
      + "assumption over published envelopes, not a claim about what will grow.",
    s: "Digital Landscapes · TDIM after Ihle, Case Study Festvåg 2018 · "
      + "terrain © Kartverket (hoydedata.no), NLOD / CC BY 4.0",
  },

  // ⚠️ THE FULL DISCLAIMER, REACHED FROM THE READOUT (2026-08-23, Marc, for the
  // public release). "A terrain analysis instrument. Not a prediction." was the
  // whole of it, and that line is true but it is a slogan — it does not tell a
  // reader that the cut/fill figure they are looking at must not go to a
  // contractor unchecked. This entry is anchored at the FOOT OF THE READOUT
  // rather than on the wordmark on purpose: the wordmark is read once when the
  // tool is new, and the disclaimer needs to be an arm's length from the
  // numbers it qualifies. Same wording as the repository's README, so the tool
  // and its release cannot say two different things.
  disclaimer: {
    t: "What these numbers are, and are not",
    b: "Design exploration, not construction information. Volumes, levels and "
      + "batters must be checked independently by a qualified engineer or "
      + "surveyor against a current survey before they go to construction, "
      + "tender or a regulatory submission. The instrument computes faithfully "
      + "on the surface it is given and does not detect error in that surface: "
      + "where single-epoch lidar noise is the same magnitude as the relief "
      + "being studied, a difference smaller than the noise is not a "
      + "difference. Anything biotic is an assumption over stated tolerance "
      + "envelopes — which species the conditions would suit, never which will "
      + "establish. No warranty; see LICENSE sections 7 and 8.",
    s: "Full disclaimer in the repository README · Apache-2.0",
  },

  // ── analysis layers ──────────────────────────────────────────────────────
  // ⚠️ THE DATUM IS THE SOURCE FILE'S, NOT A NAMED ONE. This said "the vertical
  // datum (NN2000)" and sourced itself to "Kartverket lidar DEM · EPSG:25833",
  // which is true of the tiles shipped with the tool and false of every raster
  // anyone else loads — and this popover is shown over whatever is on screen.
  elevation: {
    t: "Elevation",
    b: "Height above the source raster's own vertical datum, the measured "
      + "quantity every other layer is derived from. Stretched to this site's "
      + "own range — an elevation ramp has no universal domain.",
    s: "the loaded raster; its CRS is reported in the readout",
  },
  slope: {
    t: "Slope",
    b: "Steepest gradient of the surface at each cell, from a 3×3 neighbourhood. "
      + "The first control on drainage, stability and what can grow or be built.",
    s: "Horn (1981), Proc. IEEE 69(1) — the SAGA/QGIS standard",
  },
  aspect: {
    t: "Aspect",
    b: "Compass bearing of the steepest descent — which way the ground faces. "
      + "Flat cells have no aspect (NaN), never north: flat is not north-facing.",
    s: "Horn (1981), Proc. IEEE 69(1)",
  },
  twi: {
    t: "Topographic Wetness Index",
    b: "ln(a/tanβ): upslope area over local slope, a ranking of where water "
      + "would accumulate. Undefined on level ground — a levelled surface has "
      + "no answer, and that degeneracy is the finding, not a gap.",
    s: "Beven & Kirkby (1979), Hydrol. Sci. Bull. 24(1)",
  },
  catchment: {
    t: "Catchment area",
    b: "Upslope contributing area per cell, spread over multiple downhill "
      + "neighbours rather than forced into one. Shown on a log scale, because "
      + "its distribution spans orders of magnitude.",
    s: "Freeman (1991), Comput. Geosci. 17(3) — MFD accumulation",
  },
  cutfill: {
    t: "Cut / fill",
    b: "Signed elevation change against the surface as loaded: warm where "
      + "material was added, cool where removed, exact paper tone where "
      + "untouched. The drawing of the design itself.",
    s: "This session's edits vs. the loaded DEM — measured, not modelled",
  },
  depression: {
    t: "Closed depressions",
    b: "Hollows with no outlet, inventoried by depth and never filled away — "
      + "standard hydrological preprocessing removes them; here a designed "
      + "hollow is the point.",
    s: "Depression storage by flood-fill inventory; cf. Lindsay (2016), "
      + "Hydrol. Process. 30(6) on why filling is a choice",
  },
  tri: {
    t: "Ruggedness (TRI)",
    b: "Root-mean-square elevation difference to the eight neighbours — "
      + "micro-relief at cell scale. The texture levelling erases first.",
    s: "Riley, DeGloria & Elliot (1999), Intermountain J. Sci. 5 — RMS variant",
  },
  svf: {
    t: "Sky view factor",
    b: "Fraction of the sky hemisphere visible from each cell, traced along "
      + "horizon lines. Doubles as the surface's ambient occlusion, so what "
      + "shades the model is a measurement.",
    s: "Zakšek, Oštir & Kokalj (2011), Remote Sensing 3(2)",
  },
  openness: {
    t: "Openness",
    b: "Mean zenith angle of the horizon in all directions — how enclosed a "
      + "point sits, independent of absolute height.",
    s: "Yokoyama, Shirasawa & Pike (2002), PE&RS 68(3)",
  },
  solar: {
    t: "Solar radiation",
    b: "Clear-sky potential insolation summed over the chosen period at "
      + "69.7°N. Ratios between slopes are meaningful; the absolute total is "
      + "an upper bound, not a forecast.",
    s: "Standard solar geometry over the DEM's horizons; period stated on the control",
  },
  wind: {
    t: "Wind exposure · SW",
    b: "Horizon-based shelter toward the prevailing south-west wind: what the "
      + "ground itself blocks. A geometric proxy — no air is simulated.",
    s: "cf. Winstral & Marks (2002), Hydrol. Process. 16(18) — fetch-based Sx family",
  },
  geomorphon: {
    t: "Landforms",
    b: "Each cell classified into one of ten landform types (ridge, hollow, "
      + "slope…) from the pattern of higher and lower horizons around it. "
      + "Categories, not a gradient — no ordering is implied.",
    s: "Jasiewicz & Stepinski (2013), Geomorphology 182",
  },
  watershed: {
    t: "Watersheds",
    b: "The surface partitioned into basins that drain to a common low point. "
      + "Basin colours are arbitrary — they separate neighbours, they name "
      + "nothing.",
    s: "D8 partition — a parcel of water settles in exactly one basin",
  },
  species: {
    t: "Species assemblage",
    b: "Which of seven stated tolerance envelopes the local conditions suit "
      + "best. An assumption to argue with, not a prediction: nothing is "
      + "fitted to occurrence data and no uncertainty is carried.",
    s: "Habitat-suitability instrument; envelopes on screen in the Species table",
  },
  soil: {
    t: "Substrate",
    b: "Imported or painted class codes — the one layer terrain analysis did "
      + "not produce. It decides infiltration and feeds the species axes.",
    s: "User input · NIBIO AR5 / NGU løsmasse codings supported",
  },
  hillshade: {
    t: "Hillshade",
    b: "The form alone, lit — not an analysis layer. Clicking it shows the "
      + "plain white model: shape with nothing interpreting it.",
    s: "Lambertian shading of the DEM",
  },

  // ── HUD cards ────────────────────────────────────────────────────────────
  terrainform: {
    t: "Terrain form",
    b: "Three fingerprints of the ground's shape in one card: hypsometry "
      + "(area by elevation band), the slope histogram with its mean, and the "
      + "slope-weighted aspect rose. A levelled site spikes the first, piles "
      + "the second against zero and blanks the third.",
    s: "Strahler (1952), GSA Bulletin 63 · Horn (1981), Proc. IEEE 69(1)",
  },
  hypsometry: {
    t: "Hypsometry",
    b: "Area by elevation band — how much ground stands at each height. A "
      + "levelled site collapses to a single spike; a differentiated one "
      + "spreads.",
    s: "cf. Strahler (1952), GSA Bulletin 63 — hypsometric analysis",
  },
  slopedist: {
    t: "Slope distribution",
    b: "Histogram of slope over the whole patch, with the mean. The shape "
      + "says more than the mean: levelling piles everything against zero.",
    s: "Slope per Horn (1981)",
  },
  aspectrose: {
    t: "Aspect rose · slope-weighted",
    b: "Where the ground faces, weighted by how steeply — flat ground has no "
      + "facing and contributes nothing. Symmetry here is a symptom of "
      + "levelling.",
    s: "Aspect per Horn (1981), weighted by tanβ",
  },
  landformcard: {
    t: "Landform · hydrology",
    b: "Share of the patch in each geomorphon class (ten possible; the count "
      + "present is the LI index), with the drainage structure that follows "
      + "from it: landform diversity, how many basins the surface drains "
      + "into, the largest catchment, and the share of cells where wetness is "
      + "defined at all. One collapse, seen twice.",
    s: "Jasiewicz & Stepinski (2013), Geomorphology 182 · TWI per Beven & "
      + "Kirkby (1979)",
  },
  habitatcard: {
    t: "Habitat assemblage",
    b: "The biotic reading in one window: assemblage shares, Shannon H′ "
      + "against the seven-class ceiling ln(7)≈1.95, habitats present, and "
      + "the invasive's share. All of it follows from the terrain axes — an "
      + "assumed response, not an observation.",
    s: "H′: Shannon (1948), Bell Syst. Tech. J. 27 · envelopes: this tool",
  },
  balance: {
    t: "Earthwork balance",
    b: "Cut against fill about a hard zero, from the ledger every gesture "
      + "bills. Volume-neutral design keeps the needle centred.",
    s: "Ledger integration over the whole surface — the only volume source",
  },
  watercard: {
    t: "Rainfall event",
    b: "A stated depth of rain settled on the surface: held, soaked, or shed. "
      + "Fill-and-spill geometry, the same category of claim as a catchment "
      + "area — nothing flows through time.",
    s: "cf. Tromp-van Meerveld & McDonnell (2006), WRR 42 — fill-and-spill",
  },
  sectionscard: {
    t: "Sections",
    b: "Measured profiles along the cut lines: existing ground dashed, "
      + "proposed solid. Areas on a section are m², not volumes — the ledger "
      + "is the only place a volume comes from.",
    s: "Half-cell sampling against the live surface and the loaded baseline",
  },

  // ── index rail ───────────────────────────────────────────────────────────
  "idx-EI": {
    t: "EI · Elevation index",
    b: "This surface's relief against the surveyed patch's own 5.31 m. A full "
      + "bar means the design carries as much height difference as the quarry "
      + "did.",
    s: "Relief from the DEM's range",
  },
  "idx-SI": {
    t: "SI · Slope index",
    b: "Mean slope against 30° — a steep bank, and about the limit of the "
      + "buildable. Levelling drives it toward zero.",
    s: "Slope per Horn (1981)",
  },
  "idx-RI": {
    t: "RI · Ruggedness index",
    b: "Mean TRI against the surveyed patch's 0.036 m. Micro-relief: the "
      + "first thing grading erases and the hardest to draw back by hand.",
    s: "Riley et al. (1999), RMS variant",
  },
  "idx-GI": {
    t: "GI · Geodiversity index",
    b: "Shannon evenness over roughness classes, already bounded 0–1: how "
      + "evenly the surface offers different physical conditions.",
    s: "Evenness after Shannon (1948) over TRI classes",
  },
  "idx-HI": {
    t: "HI · Hydrology index",
    b: "Share of cells where wetness is even defined — TWI needs a slope to "
      + "rank by, and a levelled surface has none. Low HI is the collapse "
      + "itself.",
    s: "TWI per Beven & Kirkby (1979)",
  },
  "idx-LI": {
    t: "LI · Landform index",
    b: "Geomorphon classes present out of ten. One class — 'flat' — is the "
      + "levelled state; the surveyed patch carries most of the vocabulary.",
    s: "Jasiewicz & Stepinski (2013)",
  },

  // ── measured rows (those not already covered by a layer key) ─────────────
  relief: {
    t: "Relief",
    b: "Highest minus lowest elevation on the patch — the coarsest measure of "
      + "differentiation, and the first casualty of levelling.",
    s: "DEM range",
  },
  geodiversity: {
    t: "Geodiversity",
    b: "Evenness of physical conditions across the site, from roughness "
      + "classes. High when many different grounds coexist.",
    s: "Shannon evenness over TRI classes",
  },
  storage: {
    t: "Water storage",
    b: "Total volume the surface can hold in its closed hollows before any "
      + "water leaves. The levelled patch holds exactly nothing.",
    s: "Depression inventory — never filled away",
  },
  basins: {
    t: "Watersheds",
    b: "How many separate basins the surface drains into, and the largest. "
      + "Levelling concentrates many diffuse outfalls into one.",
    s: "D8 basin partition",
  },
  shannon: {
    t: "Shannon H′",
    b: "Diversity of the assumed assemblage, against the ceiling ln(7)≈1.95 "
      + "this seven-class list can reach. A reading of the terrain's range of "
      + "conditions, through the envelopes.",
    s: "Shannon (1948), Bell Syst. Tech. J. 27",
  },
  richness: {
    t: "Habitats present",
    b: "How many of the seven envelopes find any suitable ground at all. The "
      + "flat plane supports one — the invasive.",
    s: "Habitat-suitability instrument — an assumption, stated in the Species table",
  },
  invasive: {
    t: "Invasive cover",
    b: "Share of vegetated cells the invasive (Lupinus nootkatensis, "
      + "Fremmedartslista: severe impact) suits best. It takes open, "
      + "well-drained, undifferentiated ground — levelled ground.",
    s: "Artsdatabanken Fremmedartslista 2023 · envelopes: this tool",
  },
};
