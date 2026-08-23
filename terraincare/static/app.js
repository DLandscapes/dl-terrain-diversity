// @ts-check
// UI wiring only. Everything visual lives in view.js / surface.js, the analysis
// in analysis/ and worker.js; this file connects the sidebar to them and owns
// nothing else — the same split the sibling DL-3DGS app uses.
//
// window.dl is exposed for the console and for browser-driven verification.

import * as THREE from "three";
import { loadGeoTIFF, loadGeoTIFFFromURL } from "./geotiff.js";
import { DEM } from "./dem.js";
import { Surface } from "./surface.js";
import { VoxelField } from "./voxels.js";
// ⚠️ The SCENE's vegetation is stems.js; plants.js keeps the growth-form
// drawings, which are still what the species plate and the printed legend are
// made of. Two different jobs: one is the instrument, the other is the key.
import { StemField, MAX_CELL_M } from "./stems.js";
import { Dive, nestCells, CONTEXT_TILE } from "./dive.js";
import { View } from "./view.js";
import { RealtimeClock } from "./clock.js";
import { Ledger } from "./brush.js";
import { Stroke } from "./stroke.js";
import { localStats } from "./local.js";
import { AnalysisClient } from "./analysis-client.js";
import { RAMPS, CATEGORICAL, variantsFor, sample, colouriseClasses } from "./analysis/ramps.js";
import { SPECIES, SHANNON_MAX } from "./analysis/species.js";
import * as Substrate from "./substrate.js";
import { hillshade } from "./analysis/hillshade.js";
import { directionalWeights, PREVAILING_WIND_DEG, DEFAULT_DIRECTIONS } from "./analysis/horizon.js";
// ⚠️ `rasterise` was missing from this import while activeMask() called it —
// a ReferenceError that fired only when a rule evaluated WITH a drawn region
// selected, i.e. precisely the rule-narrows-the-region intersection the whole
// grammar advertises. It shipped in Phase 8C and sat dormant until 2026-08-13,
// because every measured run had exercised the rule and the region separately.
import { levelWithBatter, batterTo, rasterise } from "./polygon.js";
import {
  fieldFromRGBA, resampleField, applyPattern, patternCost,
  PATTERNS, PATTERN_BY_ID, PATTERN_MEASURED, proceduralField,
} from "./pattern.js";
import { niceInterval, contourSegments } from "./contours.js";
import { History, captureRect, applyEdit } from "./history.js";
import { sampleSection, sectionAreas, sectionName, sectionSVG } from "./section.js";
import { SectionOverlay } from "./section-view.js";
import { DimensionFrame } from "./dimensions.js";
import { readOrthoTIFF, drapeOnto } from "./ortho.js";
import { readPhoto } from "./photos.js";
import { RULE_LAYERS, maskFromRule, maskRect, describeRules } from "./rules.js";
import { SelectionOverlay } from "./selection-view.js";
import { demoTileHeights, DEMO_PATCHES } from "./demotile.js";
/** The one tile name that is built rather than fetched. */
const GENERATED_TILE = "generated/sixteen-deformations";
import { SelectionStack, composeStack, describeStack, surfaceStamp, stale,
  nextOp, OP_BY_KEY, featherWeights } from "./selection.js";
import { benchTo, BENCH_BIAS } from "./bench.js";
import { compareAt, compareSchemes, measureSurface, matchUniformInterval,
  EXPERIMENT } from "./compare.js";
import { landformPatches } from "./patches.js";
import { geomorphons, LANDFORMS } from "./analysis/geomorphons.js";
import { PatchOverlay } from "./patch-view.js";
import { applyGuide, PROFILES, ALONG } from "./guide.js";
import { PhotoOverlay, nearestPin } from "./photo-view.js";
import {
  drawHUD, hypsometry, aspectRose, histogram, drawWaterBodies, fmtVolume,
  THEMES, HUD_REGIONS,
} from "./hud.js";
import { PondPins } from "./pond-view.js";
import { SectionFace } from "./section-face.js";
import { symbolField, strideFor, symbolLegend } from "./symbols.js";
import { gradingSVG } from "./export/grading.js";
import { isopachSVG, slopeClassSVG, drainageSVG, chainageSectionsSVG }
  from "./export/derivatives.js";
import { SymbolField } from "./symbol-view.js";
import { GlyphField } from "./glyph-view.js";
import {
  buildGlyphs, describeChain, GLYPH_OPS, GLYPH_EXTRA_LAYERS, DEFAULT_CHAIN,
} from "./glyphs.js";
import { INFO } from "./info.js";
import { computeGradient } from "./analysis/horn.js";
import { pondWater, absorbedDepth, INFILTRATION } from "./analysis/ponding.js";
import { WaterField } from "./water.js";
import {
  PlanSet, PLAN_FIELDS, pickVertex, pickRegion, ringIsValid, pointInRings,
  regionArea, regionExtent, levelCost, toFeatures, groundPerPixel,
} from "./plan.js";
import { PlanOverlay } from "./plan-view.js";
import { readShapefile, prjEpsg, overlapsTerrain } from "./export/shapefile-read.js";
import { writeVoxelSolidOBJ, blockClasses, manifoldReport } from "./export/solid.js";
import { writeGeoTIFF } from "./export/geotiff-write.js";
import { writeOBJ, writeVoxelOBJ } from "./export/obj.js";
import { composeFigure } from "./export/figure.js";
import { makeZip } from "./export/zip.js";
import { writeShapefile, writeGeoJSON } from "./export/shapefile.js";

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const clock = new RealtimeClock();
const view = new View(
  /** @type {HTMLCanvasElement} */ ($("canvas")),
  $("overlay"),
  clock,
);

const state = {
  /** @type {DEM|null} */ dem: null,
  /** @type {Surface|null} */ surface: null,
  /** @type {StemField|null} */ plants: null,
  /**
   * "mono" | "species". Survives a tile change: a new terrain is a new site,
   * not a new opinion about how the drawing should be coloured.
   */
  plantPalette: "mono",
  /** whether the assemblage is drawn as objects in the scene */
  showPlants: false,
  /** @type {AnalysisClient|null} */ analysis: null,
  ledger: new Ledger(),
  /** @type {Stroke|null} */ stroke: null,
  tool: "scoop",
  /** "mesh" | "voxel" */
  representation: "mesh",
  /** DEM cells per voxel block; null = auto-size on load */
  /** @type {number|null} */ blockCells: null,
  /** which analysis layer is painted on the terrain, or "relief" */
  /**
   * ⚠️ THE TOOL OPENS ON A LAYER, NOT ON PLAIN RELIEF, and the reason is what
   * the first ten seconds have to say. Relief shows a shape; a layer shows that
   * the shape is being MEASURED, and that the measurement moves when you draw —
   * which is the entire argument. Opening on shaded relief made the instrument
   * look like a viewer until you found the dropdown.
   *
   * ⚠️ CUT/FILL, AND THE REASONING CHANGED WHEN THE DEFAULT TILE DID. The
   * argument for elevation was that cut/fill opens as one flat neutral field
   * and says nothing until the first stroke. That held while the tool opened on
   * the surveyed Ørndalen patch, where elevation showed real topography.
   *
   * It does not hold on the flat teaching plane. There, elevation is ALSO a
   * single uniform tone — one value everywhere is exactly what the tile is — so
   * it carries no more information than cut/fill does, and cut/fill has the
   * decisive advantage: it is the layer the whole workshop is about, and it
   * answers the very first gesture. Untouched ground sits at exactly the paper
   * colour (the ramp's centre is bit-identical to --sheet), a fill turns it
   * warm and a cut turns it blue, immediately and legibly.
   *
   * So the tool opens on a blank site that stains where you touch it, which is
   * the honest picture of both the site and the instrument.
   */
  // ⚠️ IT OPENS ON WETNESS, NOT CUT/FILL (Marc, 2026-08-19). Cut/fill is the
  // right opening layer for a tile you are about to EDIT — it answers "what have
  // I done" — but on load nothing has been done, so it painted a uniform neutral
  // field and said nothing. TWI answers "what is this ground already like",
  // which is the question the opening tile exists to raise, and it makes the
  // sixteen deformations legible as sixteen different hydrologies at a glance.
  shading: "twi",
  /** last RGBA panel buffers from the worker, reused for 3D shading + legends */
  /** @type {Record<string, Uint8ClampedArray>} */ panels: {},
  /** the percentile-stretched [lo,hi] the worker actually used, per layer */
  /** @type {Record<string, number[]>} */ domains: {},
  /**
   * How the user has adjusted the DISPLAY of each layer: percentile cuts from
   * the legend's triangle handles, and palette variant.
   *
   * Percentiles rather than raw values, deliberately. A raw-value override
   * would go stale the moment the terrain is edited — scoop a channel and a
   * hand-set TWI ceiling suddenly clips half the map — whereas a percentile
   * cut re-derives against whatever the surface has become, which is what
   * "stretch" means in a GIS and what the handles look like they promise.
   */
  /** @type {Record<string, number[]>} */ stretch: {},
  /** @type {Record<string, string>} */ variant: {},
  /** pristine copy, for reset and for the datum */
  /** @type {Float32Array|null} */ baseZ: null,
  datum: 0,
  metrics: null,
  /** class counts for the landform key */
  /** @type {any} */ landform: null,
  /** class counts for the species key, plus the bare-cell count */
  /** @type {any} */ assemblage: null,
  /**
   * The substrate map: one class code per DEM cell, or null.
   *
   * Owned HERE rather than in the worker, because the substrate brush edits it
   * and a paint stroke must show on the same frame as the hand. The worker gets
   * a copy on load and on stroke end, purely so exports find it.
   * @type {Uint8Array|null}
   */
  substrate: null,
  /**
   * The 4 m context tile drawn behind the design patch, or null until asked
   * for. A BACKDROP — never adopted as `state.dem`. See setContext().
   * @type {import("./dive.js").Dive|null}
   */
  dive: null,
  /**
   * PATTERN STAMPING. A field of relief specified rather than brushed — see
   * pattern.js. `src` holds the raw source at its own size (an image's pixels,
   * never resampled in place) so that changing the amplitude or the bias
   * re-derives from the original rather than compounding a previous mapping.
   */
  pattern: {
    /**
     * "image" | "generated"
     *
     * ⚠️ OPENS ON THE LIBRARY, NOT ON AN EMPTY IMAGE SLOT. Starting on "image"
     * with nothing loaded meant the panel showed a blank frame and a drop
     * target, so the twelve patterns — the part of this tool with the strongest
     * measured result behind it — were behind a click nobody knew to make.
     */
    source: "generated",
    /** @type {Float32Array|null} raw 0..1 source values, image sources only */
    src: null,
    /** source dimensions, image sources only */
    sw: 0, sh: 0,
    /** what was loaded, for the note */
    name: "",
    /**
     * Which library pattern the generated source draws — see pattern.js.
     *
     * ⚠️ DENDRITIC RATHER THAN THE BEST PERFORMER. The lozenge matrix measures
     * highest of the twelve (H′ 1.724 against dendritic's 0.886) and defaulting
     * to it would hand a student the answer before they had asked the question.
     * Dendritic is middling, and its note calls it "the closest of these to
     * unworked ground" — which is the right thing to open on: it looks like
     * terrain, so the first move reads as shaping rather than as stamping, and
     * the comparison that follows is theirs to make.
     */
    id: "dendritic",
    /** generated source: ground length of one repeat */
    wavelength: 8,
    /** generated source: reproducibility is the whole reason this is here */
    seed: 1,
    /** the two handles, as an input-levels pair over the source's 0..1 range */
    lo: 0, hi: 1,
    invert: false,
  },
  /**
   * Contour lines on the surface. Off by default — the lattice already carries
   * scale, and a second family of line work has to be asked for.
   */
  /**
   * ⚠️ ON AT STARTUP. Contours were off because the lattice already shows where
   * every sample is, and two sets of lines over one surface crowd each other.
   * That reasoning was about tidiness; what it cost was the reading. A shaded
   * heightfield with a triangle lattice on it looks like a 3D model, and this
   * is a topographic instrument — contours are what say so, immediately, before
   * anything has been clicked. They also make the first Level gesture legible:
   * the lines collapse to nothing, which is the argument in one frame.
   */
  contours: { on: true, interval: 0.5 },
  /**
   * RAINFALL. A fill-and-spill settling of one event over the current surface —
   * see analysis/ponding.js for what this is and, more importantly, what it is
   * not. Off by default: it is an event laid over the ground, not a property of
   * it, so it has to be asked for.
   */
  water: {
    on: false,
    /** metres of rain over the whole patch */
    rain: 0.002,
    /** draw the standing water as blocks, or keep only the numbers */
    blocks: true,
    /** @type {import("./water.js").WaterField|null} */ field: null,
    /** @type {any} last ponding result, for the readouts and the export */
    result: null,
  },
  /** class counts for the substrate key */
  /** @type {any} */ soilCounts: null,
  /** the class the substrate brush paints */
  soilClass: 2,
  /** where the current substrate came from, for the sidebar note */
  soilSource: "",
  /**
   * PLAN MODE. A latching state, not a tool: it locks the camera to a drawing
   * surface and swaps the whole palette, so it cannot be a fourth brush.
   */
  /**
   * The saved selections, composed top to bottom — see selection.js.
   *
   * ⚠️ SEPARATE FROM `plan.set`, AND DELIBERATELY SO. A region is a DESIGN
   * OBJECT: it carries a levelling datum, it exports as a shapefile record, and
   * the level slider acts on it. A selection layer is an ANSWER TO A QUESTION —
   * where the modifiers may act. The two overlap constantly (a drawn region is
   * usually also the place you want to work) but they are not the same thing,
   * and collapsing them would either give every selection a datum it has no use
   * for or take the datum away from the platforms that need it. A region joins
   * the stack by being ADDED to it, which freezes its cells.
   * @type {SelectionStack}
   */
  selection: new SelectionStack(),

  plan: {
    /** whether the mode is on */
    on: false,
    /**
     * Plan mode with the camera handed back: still plan mode — regions,
     * selection and the level slider all live — but orbiting, in perspective,
     * with the draw tools refused. Middle-click toggles it. See
     * setPlanCameraFree() for why tracing and levelling have different needs.
     */
    camFree: false,
    /** "draw" | "hole" | "edit" */
    tool: "draw",
    /** @type {PlanSet} */ set: new PlanSet(),
    /** @type {import("./plan.js").Region|null} */ selected: null,
    /** vertices of the ring being traced, world units */
    /** @type {number[][]} */ draft: [],
    /** @type {PlanOverlay|null} */ overlay: null,
    /**
     * Mask and elevation range for the selected region — what the slider is
     * bounded by, and what levelTo() is handed. Cached because rasterising is
     * a scan over the region's whole extent and the slider asks for it on
     * every input event; invalidated by planInvalidate() whenever the rings or
     * the ground beneath them change.
     * @type {any}
     */
    extent: null,
    /** the camera to restore when the mode is switched off */
    /** @type {any} */ camReturn: null,
    /** live drag of a single vertex, or null */
    /** @type {any} */ drag: null,
    /**
     * The edge condition. `on: false` is exactly the 90° case — the same code
     * path, not a bypass — so switching it off reproduces the hard edge levelTo
     * produced on its own before the batter was wired up.
     *
     * ⚠️ Defaults are WORKING FIGURES, not a standard: 34° is the repose angle
     * of loose granular fill, 45° a common figure for a cutting in cohesive
     * soil. Real numbers for a Norwegian scheme come from Statens vegvesen
     * håndbok N200 and depend on the material and the height of the face —
     * which is the sort of thing this tool should eventually read off the
     * substrate map rather than assume.
     */
    batter: { on: true, cutDeg: 45, fillDeg: 34 },
  },
  /**
   * SECTIONS. Like regions, these are design objects that OUTLIVE plan mode —
   * only cutting one needs the locked view, and a section is most worth looking
   * at from an angle where you can see the ground it cuts through.
   */
  sections: {
    /** @type {{id:number, name:string, a:number[], b:number[]}[]} */ list: [],
    /** the first click of a section being cut, or null */
    /** @type {number[]|null} */ pending: null,
    /** @type {import("./section-view.js").SectionOverlay|null} */ overlay: null,
    nextId: 1,
    /** profiles folded flat about their traces, for reading in plan */
    folded: false,
  },

  /**
   * ⚠️ THE ORTHOPHOTO DRAPE — LICENCE-RESTRICTED, LOCAL, AND NEVER EXPORTED.
   * Held HERE and deliberately not in state.panels: every export path walks
   * LIVE_PANELS/HEAVY_PANELS and reads state.panels, so a drape that is not
   * in that table cannot reach a figure, a layer GeoTIFF or the bundle. See
   * the header of ortho.js for the full argument — it is a licence condition,
   * not a preference, and this is where it is enforced.
   */
  ortho: {
    /** @type {Uint8ClampedArray|null} resampled onto the DEM grid */ rgba: null,
    on: false,
    name: "",
    covered: 0,
  },

  /**
   * Site photographs, placed by their own geotags. OBSERVATIONS, and the only
   * layer here that is one — see the header of photos.js. Never exported: the
   * pictures are the user's, may carry personal data, and the tool has no
   * business writing them into a bundle.
   */
  photos: {
    /** @type {{name:string,x:number,y:number,alt:number|null,bearing:number|null,when:string|null,url:string}[]} */
    list: [],
    on: false,
    /** name of the photograph currently open — its pin draws black */
    /** @type {string|null} */ selected: null,
    /** @type {import("./photo-view.js").PhotoOverlay|null} */ overlay: null,
  },
};

/**
 * Panels refreshed on every worker pass.
 *
 * `species` is live even though three of its five axes come from the settle-only
 * layers, because the readout moving WHILE THE HAND MOVES is the whole point of
 * the tool. It uses the last settled solar, wind and landform and fresh TWI and
 * slope — see the note in worker.js for why that is sound.
 */
const LIVE_PANELS = ["elevation", "slope", "aspect", "twi", "catchment", "cutfill", "depression", "tri", "species", "soil"];
/** Panels that only arrive when a gesture settles (horizon tracing is costly). */
/**
 * The palette every layer starts on.
 *
 * ⚠️ "contrast", NOT "committed". The committed ramps are the ones whose sign
 * conventions ramps.js exists to protect, and they stay the reference — but on
 * a 256 px panel read at arm's length, and on a projected exhibition capture
 * read at three metres, the higher-separation variant is simply legible where
 * the committed one is merely correct. Cycling still returns here, and every
 * variant is derived FROM the committed ramp, so no convention is inverted by
 * changing which one is shown first.
 */
const DEFAULT_VARIANT = "contrast";

const HEAVY_PANELS = ["svf", "openness", "solar", "wind", "geomorphon", "watershed"];
/**
 * Hillshade is drawn on the main thread from the DEM alone — it needs no
 * analysis, only the surface — so it is neither live nor heavy. Clicking it
 * selects "none", the plain-white 3D view: the raster and the 3D state it
 * chooses are the same idea, form with nothing interpreting it.
 */
const FORM_PANEL = "hillshade";

/**
 * The name each layer carries OUTSIDE the analysis grid — figure titles, the
 * bundle README, export statuses. A table rather than a read of the grid's own
 * captions, because the captions carry display qualifiers that are not part of
 * the layer's name: "Solar · Apr–Sep" is the caption for whatever period the
 * solar layer is currently showing, and a figure exported under that title at
 * a different period would carry a false claim in its filename line.
 */
const LAYER_TITLES = {
  elevation: "Elevation", slope: "Slope", aspect: "Aspect",
  twi: "TWI · wetness", catchment: "Catchment area", cutfill: "Cut / fill",
  depression: "Closed depressions", tri: "Ruggedness",
  svf: "Sky view factor", openness: "Openness", solar: "Solar radiation",
  wind: "Wind exposure · SW", geomorphon: "Landforms", watershed: "Watersheds",
  species: "Species assemblage", soil: "Substrate",
};

const panelCtx = {};
for (const k of [...LIVE_PANELS, ...HEAVY_PANELS, FORM_PANEL]) {
  const cv = /** @type {HTMLCanvasElement} */ ($(`p-${k}`).querySelector("canvas"));
  panelCtx[k] = cv.getContext("2d");
}

/** Units and end labels per layer, for the hover legend. */
const LEGEND = {
  // ⚠️ A LAYER MISSING FROM HERE GETS NO LEGEND BAR — and therefore no stretch
  // handles either, because addStretchHandles looks for the bar this builds.
  // Elevation was absent, so its ramp had no handles at all while every other
  // continuous layer had two. See also DEFAULT_CUTS and the worker's DEFAULTS.
  elevation: { unit: " m", lo: "low", hi: "high", dp: 2 },
  slope: { unit: "°", lo: "flat", hi: "steep", dp: 1 },
  aspect: { unit: "", lo: "N", hi: "N", dp: 0, circular: true },
  twi: { unit: "", lo: "dry", hi: "wet", dp: 1 },
  // Domain is log10(m²); the legend converts back so the reader sees areas.
  catchment: { unit: " m²", lo: "ridge", hi: "channel", dp: 0, log10: true },
  cutfill: { unit: " m", lo: "cut", hi: "fill", dp: 2 },
  depression: { unit: " m", lo: "none", hi: "deep", dp: 2 },
  tri: { unit: " m", lo: "smooth", hi: "rough", dp: 3 },
  svf: { unit: "", lo: "enclosed", hi: "open sky", dp: 2 },
  openness: { unit: "°", lo: "sheltered", hi: "exposed", dp: 0 },
  solar: { unit: " kWh/m²", lo: "shaded", hi: "sunlit", dp: 0 },
  wind: { unit: "", lo: "sheltered", hi: "exposed", dp: 2 },
  // Landforms are named classes, not a range — the legend is a key, not a bar.
  geomorphon: { categorical: true },
  species: { categorical: true },
  soil: { categorical: true },
};

/**
 * Where a categorical layer's class counts come from. Both of these describe
 * THIS surface, so the key lists the classes actually on the ground rather than
 * the classifier's whole vocabulary.
 */
const CLASS_COUNTS = {
  geomorphon: () => state.landform,
  species: () => state.assemblage,
  soil: () => state.soilCounts,
};

/**
 * A categorical layer's key entries — swatch, name, share — commonest first.
 * Shared by the panel legends and the exported figures so the two cannot
 * describe the same raster differently.
 */
function classItems(k) {
  const cat = CATEGORICAL[k];
  const src = CLASS_COUNTS[k] ? CLASS_COUNTS[k]() : null;
  const counts = src ? src.counts : null;
  const items = cat.labels.map((label, i) => ({
    label, colour: cat.colours[i], n: counts ? counts[i] : 0,
    // The invasive is named as one everywhere it appears. species.js is the
    // single source for which class that is.
    flag: k === "species" && SPECIES[i] && SPECIES[i].invasive ? "invasive" : "",
  }));
  // Codes that are not species but still mean something — "bare" is an
  // ecological answer and must not be dropped from the key.
  for (const e of cat.extraKeys || []) {
    items.push({
      label: e.label, colour: e.colour, flag: "",
      n: src && Number.isFinite(src[e.label]) ? src[e.label] : 0,
    });
  }
  const total = items.reduce((a, b) => a + b.n, 0);
  return {
    total,
    items: items.filter((x) => !counts || x.n > 0).sort((a, b) => b.n - a.n),
  };
}

// Build the legend shells once. Each is filled from the ramp itself and from the
// domain the worker actually stretched to, so a legend can never describe a
// different mapping than the pixels above it.
const LEGEND_HTML = `<div class="bar"></div><div class="ends"><span></span><span></span></div>`;
for (const k of [...LIVE_PANELS, ...HEAVY_PANELS]) {
  const el = document.createElement("div");
  el.className = "legend";
  el.innerHTML = LEGEND_HTML;
  $(`p-${k}`).appendChild(el);
}
$("shade-legend").innerHTML = LEGEND_HTML;

/** The permanent legend under the analysis grid, for the layer being read. */
function refreshShadingLegend() {
  const k = state.shading;
  const on = k !== "relief" && k !== "none" && !!LEGEND[k]
    && (LEGEND[k].categorical || !!RAMPS[k]);
  $("shade-legend-row").hidden = !on;
  if (on) fillLegend($("shade-legend"), k);
}

function refreshLegend(k) {
  fillLegend($(`p-${k}`).querySelector(".legend"), k);
}

/** The percentile cuts a layer uses by default, mirroring worker.js. */
const DEFAULT_CUTS = {
  // ⚠️ MUST MATCH THE WORKER'S OWN DEFAULTS, which are passed as the second and
  // third arguments to cuts() in worker.js. A layer missing from this table gets
  // NO HANDLES AT ALL — addStretchHandles returns immediately — which is right
  // for aspect, a bearing with nothing to stretch, and was simply an oversight
  // for elevation when that layer was added.
  elevation: [0.01, 0.99],
  slope: [0.02, 0.98], twi: [0.02, 0.98], catchment: [0.02, 0.995],
  cutfill: [0.01, 0.99], tri: [0.02, 0.90], depression: [0, 0.995],
  svf: [0.02, 0.98], openness: [0.02, 0.98], solar: [0.02, 0.98],
  wind: [0.02, 0.98],
};

/**
 * Every legend's `place()`, so the handles can be re-drawn when the worker
 * reports new domains — a layer that had one value everywhere may now have a
 * range, and vice versa.
 * @type {(() => void)[]}
 */
const stretchPlacers = [];
function refreshStretchHandles() { for (const f of stretchPlacers) f(); }

/**
 * Two draggable triangles under a legend bar, one per end of the stretch, plus
 * a caret that cycles the palette.
 *
 * The handles carry PERCENTILES, not values: dragging the left one to 10% says
 * "start the ramp at the 10th percentile of this layer", which is what a GIS
 * means by a stretch and what survives the terrain being edited underneath it.
 * They are bounded to their own half so they can never cross, which would
 * invert the ramp — the one thing the palette variants are carefully built to
 * make unreachable, so the handles must not reintroduce it.
 */
function addStretchHandles(el, k) {
  if (!DEFAULT_CUTS[k]) return;           // aspect is a bearing: nothing to stretch
  const bar = /** @type {HTMLElement} */ (el.querySelector(".bar"));
  if (!bar || el.querySelector(".handles")) return;

  const wrap = document.createElement("div");
  wrap.className = "handles";
  const lo = document.createElement("i");
  const hi = document.createElement("i");
  lo.className = "h lo"; hi.className = "h hi";
  wrap.append(lo, hi);
  bar.insertAdjacentElement("afterend", wrap);

  // ⚠️ The palette control gets a ROW OF ITS OWN, below the value labels.
  // It was first placed at the right end of the handle row, where its box
  // (256–265 px) sat directly on top of the upper handle's (254–262) and
  // swallowed every pointer event aimed at it — so the left triangle dragged
  // and the right one appeared dead. Absolute-positioning a control into a
  // track that another control already occupies is the whole bug; nothing
  // else shares this row.
  //
  // It also carries a WORD. As a bare "▾" nobody found it, which is the other
  // half of the same report.
  const palRow = document.createElement("div");
  palRow.className = "palrow";
  const pal = document.createElement("button");
  pal.className = "pal";
  pal.title = "click to cycle the palette for this layer";
  palRow.appendChild(pal);
  const ends = el.querySelector(".ends");
  if (ends) ends.insertAdjacentElement("afterend", palRow);
  else wrap.insertAdjacentElement("afterend", palRow);

  const place = () => {
    const [a, b] = state.stretch[k] || DEFAULT_CUTS[k];
    lo.style.left = `${a * 100}%`;
    hi.style.left = `${b * 100}%`;
    const v = state.variant[k] || DEFAULT_VARIANT;
    pal.textContent = `palette · ${v} ▾`;
    wrap.classList.toggle("adjusted",
      !!state.stretch[k] || (!!state.variant[k] && state.variant[k] !== DEFAULT_VARIANT));

    // ⚠️ A LAYER WITH ONE VALUE EVERYWHERE CANNOT BE STRETCHED, and the handles
    // have to say so rather than simply not working. On the flat teaching plane
    // — which is what the tool now opens on — cut/fill, slope and ruggedness are
    // all identically zero until the first gesture, so the first thing anyone
    // tries is dragging a control that is behaving correctly and looks broken.
    //
    // The signal is already here: percentileDomain returns undefined for a
    // constant grid, so the worker sends no domain for that layer.
    const dom = state.domains[k];
    const inert = !dom || !(dom[1] > dom[0]);
    wrap.classList.toggle("inert", inert);
    wrap.title = inert
      ? "This layer holds one value everywhere, so there is no range to stretch. "
        + "Move some earth and the handles come live."
      : "drag to set the percentile each end of the ramp starts at";
  };
  place();
  stretchPlacers.push(place);

  const drag = (handle, which) => {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();   // the panel behind this toggles shading on click
      // Same guard as view.js:363. A pointer id that never belonged to a real
      // pointer makes setPointerCapture throw, and an uncaught throw here would
      // abort before the move listener is attached — so the handle would appear
      // dead to anything but a physical mouse, including any harness.
      try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const rect = bar.getBoundingClientRect();
      const move = (ev) => {
        const f = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
        const cur = state.stretch[k] || DEFAULT_CUTS[k].slice();
        const next = cur.slice();
        // Keep a visible gap: coincident cuts give a zero-width domain, which
        // percentileDomain rejects and which would read as the layer vanishing.
        if (which === 0) next[0] = Math.min(f, next[1] - 0.02);
        else next[1] = Math.max(f, next[0] + 0.02);
        state.stretch[k] = next;
        place();
        pushView();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        const [a, b] = state.stretch[k];
        status(`${layerTitle(k)} stretched to ${(a * 100).toFixed(0)}–${(b * 100).toFixed(0)}%`);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  };
  drag(lo, 0);
  drag(hi, 1);

  pal.addEventListener("pointerdown", (e) => e.stopPropagation());
  pal.addEventListener("click", (e) => {
    e.stopPropagation();
    // Only the variants this ramp can safely take — a diverging ramp is not
    // offered "mono", because one hue would make its two ends the same.
    const opts = variantsFor(k);
    const cur = state.variant[k] || DEFAULT_VARIANT;
    const next = opts[(Math.max(0, opts.indexOf(cur)) + 1) % opts.length];
    state.variant[k] = next;
    place();
    pushView();
    status(`${layerTitle(k)} palette: ${next}`);
  });

  // Double-click either handle to go back to the layer's own defaults.
  for (const h of [lo, hi]) {
    h.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      delete state.stretch[k];
      delete state.variant[k];
      place();
      pushView();
      status(`${layerTitle(k)} reset to its computed stretch`);
    });
  }
}

/** Send the current display settings to the worker for a re-colour. */
function pushView() {
  state.analysis?.setView({ stretch: state.stretch, variant: state.variant });
}

/** Fill any legend element for a layer. Shared by the panel hovers and the
 *  permanent one under the analysis grid, so they cannot diverge. */
function fillLegend(el, k) {
  const meta = LEGEND[k];
  if (!meta || !el) return;

  // A categorical layer gets a KEY — a swatch and a name per class — because a
  // gradient bar between "ridge" and "hollow" would imply an ordering that
  // does not exist. Only the classes actually present are listed, so the key
  // describes this surface rather than the classifier's vocabulary.
  if (meta.categorical) {
    const { items, total } = classItems(k);
    el.innerHTML = `<div class="keys">${items.map(({ label, colour, n, flag }) => {
      const [r, g, b] = colour;
      const pct = total ? ` ${((100 * n) / total).toFixed(0)}%` : "";
      const mark = flag ? `<u>${flag}</u>` : "";
      return `<span class="key"><i style="background:rgb(${r},${g},${b})"></i>${label}${mark}<b>${pct}</b></span>`;
    }).join("")}</div>`;
    return;
  }

  // Restore the bar shell: the shared legend element is reused across layers,
  // and a categorical key will have replaced its contents.
  if (!el.querySelector(".bar")) el.innerHTML = LEGEND_HTML;

  const dom = state.domains[k] || RAMPS[k].domain;
  const [lo, hi] = dom;

  // Sample the ramp itself for the gradient, so the swatch is the ramp.
  const stops = [];
  for (let i = 0; i <= 12; i++) {
    const v = lo + ((hi - lo) * i) / 12;
    const [r, g, b] = sample(k, v, /** @type {any} */ (dom), state.variant[k]);
    stops.push(`rgb(${r},${g},${b}) ${(i / 12 * 100).toFixed(0)}%`);
  }
  /** @type {HTMLElement} */ (el.querySelector(".bar"))
    .style.background = `linear-gradient(90deg, ${stops.join(",")})`;

  addStretchHandles(el, k);

  const ends = el.querySelectorAll(".ends span");
  // A log-scaled layer is stretched in log space but must be READ in its own
  // units — a legend saying "2.4" where the data means 251 m² is worse than no
  // legend at all.
  const fmt = (v) => {
    const raw = meta.log10 ? Math.pow(10, v) : v;
    const dp = meta.log10 && raw < 10 ? 2 : meta.dp;
    return `${raw.toFixed(dp)}${meta.unit}`;
  };
  ends[0].innerHTML = meta.circular ? `<b>N</b> 0°` : `<b>${meta.lo}</b> ${fmt(lo)}`;
  ends[1].innerHTML = meta.circular ? `360° <b>N</b>` : `${fmt(hi)} <b>${meta.hi}</b>`;
}

let statusTimer = 0;
/** @param {string} text @param {number} [ms] */
function status(text, ms = 2200) {
  const el = $("status");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(statusTimer);
  if (ms > 0) statusTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function fail(err) {
  console.error(err);
  status(`Error: ${err.message || err}`, 0);
}

/* ------------------------------------------------------------------ loading */

/** @param {string} name file under /data/orndalen/ */
/**
 * The bundled tile sets: which context belongs to which design patch.
 *
 * ⚠️ THE CONTEXT MUST FOLLOW THE PATCH. The two are drawn in one world and the
 * apron stitches them together, so pairing the flat teaching plane with the
 * real 4 m tile would try to blend a 75 m plane into 151 m of Tromsøya — the
 * apron would do exactly as told and produce a cliff, and it would look like
 * the transition was broken rather than like two unrelated surfaces having been
 * asked to meet.
 */
const TILE_SETS = {
  "orndalen/orndalen_fill_025m.tif": "orndalen/orndalen_2024_4m.tif",
  "teaching/flat75_025m.tif": "teaching/flat75_4m.tif",
  // ⚠️ THE POI PAIR, ADDED WITH THE TILES AND NOT BEFORE (2026-08-11). Without
  // this entry contextTileFor() fell through to CONTEXT_TILE — the fill-floor
  // context, cut for a centre 460 m away — so asking for context around the
  // POI patch drew a correct tile in the correct place and it appeared BESIDE
  // the site rather than around it. Nothing was broken; the pairing was simply
  // missing, which is the failure mode this table exists to have.
  "orndalen/orndalen_poi_025m.tif": "orndalen/orndalen_poi_4m.tif",
};

/** The context tile for whatever patch is loaded, or the Ørndalen default. */
function contextTileFor(name) {
  return TILE_SETS[name] || CONTEXT_TILE;
}

/** @param {string} name folder-qualified, e.g. "teaching/flat75_025m.tif" */
async function loadTile(name) {
  status(`loading ${name.replace(/^.*\//, "")}…`, 0);
  // ⚠️ THE OPENING TILE IS GENERATED, NOT FETCHED (2026-08-19), and it borrows a
  // real header rather than inventing one. `demotile.js` supplies heights; the
  // georeference, cell size and datum come from the teaching tile, which already
  // carries Ørndalen's own — so the Troms species envelopes and the 69.7° N sun
  // stay valid and there is still exactly ONE place the site's coordinates live.
  // No new binary, and the tile is reproducible from source.
  if (name === GENERATED_TILE) {
    const raw = await loadGeoTIFFFromURL("/data/teaching/flat75_025m.tif");
    const dem = DEM.fromRaw(raw);
    const built = demoTileHeights(dem.nrows, dem.ncols, dem.cell);
    dem.z.set(built.z);
    // ⚠️⚠️ THE NAME MUST BE REWRITTEN, AND FORGETTING IT WAS A PROVENANCE BUG.
    // `loadGeoTIFFFromURL` stamps `name: url`, and `adoptDEM`'s second argument
    // only reaches the status line — so the generated tile inherited the
    // teaching tile's path and every export CREDITED A FILE THAT DID NOT
    // PRODUCE IT. Caught on a grading plan whose header read
    // "/data/teaching/flat75_025m.tif" above spot levels the flat plane cannot
    // have. `site: state.dem.name` is stamped by the grading plan, all four
    // derivative sheets, the figure exporter and the GeoTIFF README.
    // ⚠️ AND IT MUST NOT CONTAIN "ORNDALEN". The Kartverket credit is
    // conditional on /orndalen/i against this very string — the licence
    // condition is that Kartverket is credited where Kartverket data is shown
    // and NOWHERE ELSE. This surface borrows Ørndalen's georeference so the
    // species envelopes and the sun stay valid, but every height in it is
    // generated. Kartverket had no part in it and must not be credited for it.
    dem.name = "generated/sixteen-deformations";
    state.tileName = name;
    return adoptDEM(dem, "sixteen deformations");
  }
  const raw = await loadGeoTIFFFromURL(`/data/${name}`);
  state.tileName = name;
  return adoptDEM(DEM.fromRaw(raw), name.replace(/^.*\//, ""));
}

/**
 * Load a GeoTIFF the user dropped or picked. Same path as the bundled tiles —
 * the reader already handles arbitrary size, cell size and origin, and rejects
 * non-square pixels rather than silently averaging them.
 * @param {File} file
 */
async function loadFile(file) {
  status(`reading ${file.name}…`, 0);
  const buf = await file.arrayBuffer();
  const raw = loadGeoTIFF(buf, { name: file.name });
  if (raw.warnings.length) console.warn(file.name, raw.warnings);
  await adoptDEM(DEM.fromRaw(raw), file.name);
  if (raw.warnings.length) status(raw.warnings[0], 6000);
}

/**
 * Adopt a dropped GeoTIFF as the CONTEXT tile — the coarse backdrop the site
 * sits inside — rather than as the site itself.
 *
 * ⚠️ A CONTEXT IS NOT A SITE, and the difference is not the file. Nothing about
 * a GeoTIFF says which it is: both are single-band float32 DEMs and either can
 * be any cell size. It is decided by which target it was dropped on, and it has
 * to be, because guessing from cell size would be wrong the first time someone
 * works at a scale this project has not met.
 *
 * ⚠️ THE SITE IS NEVER RE-ADOPTED HERE. `adoptDEM` resets the ledger, the
 * regions, the substrate and every panel, because a new site is a new design.
 * A new backdrop is none of those things — the design under way is untouched by
 * changing what is drawn behind it, and clearing it would be a surprising and
 * unrecoverable thing to do to someone who dropped the wrong file.
 * @param {File} file
 */
async function loadContextFile(file) {
  if (!state.dem) { status("load a site first — a context has nothing to place without one", 5000); return; }
  status(`reading ${file.name} as context…`, 0);
  const buf = await file.arrayBuffer();
  const raw = loadGeoTIFF(buf, { name: file.name });
  if (raw.warnings.length) console.warn(file.name, raw.warnings);
  const dem = DEM.fromRaw(raw);

  if (state.dive) state.dive.dispose();
  state.dive = new Dive(view, dem, { verticalExaggeration: currentExaggeration() });
  // markNest both draws the footprint and cuts the opening — and refuses both
  // if the site is not on this tile's grid, which is the answer that matters
  // here: an arbitrary dropped tile usually is not.
  const nest = state.dive.markNest(state.dem);
  state.dive.setVisible(true);
  /** @type {HTMLButtonElement} */ ($("t-context")).classList.add("on");
  describeNest(nest);
  status(nest.aligned && nest.contained
    ? `${file.name} adopted as context · the site is ${nest.cols}×${nest.rows} of its cells`
    : `${file.name} adopted as context · the site does NOT nest in it — see the note`, 6000);
  if (raw.warnings.length) status(raw.warnings[0], 6000);
}

/** @param {DEM} dem @param {string} name */
async function adoptDEM(dem, name) {
  state.dem = dem;
  state.baseZ = dem.z.slice();
  state.ledger.reset();
  // The panel buffers and stretch domains belong to the PREVIOUS terrain.
  // Left in place, buildRepresentation() below would paint the old tile's
  // analysis onto the new surface until the first worker pass — and for a
  // dropped GeoTIFF of a different size, reading a 256² buffer over a larger
  // grid runs off its end and shades the terrain with NaN colours.
  state.panels = {};
  state.domains = {};
  state.metrics = null;
  // Class counts belong to the previous terrain too — the same trap as the
  // panel buffers above. Left in place, the landform and species keys would
  // describe the old tile until the first pass on the new one lands.
  state.landform = null;
  state.assemblage = null;
  // ⚠️ The substrate map was resampled onto the PREVIOUS grid. It cannot be
  // carried across: a different tile means different cells, and at the other
  // scale a different extent entirely. Discarded rather than reinterpreted.
  state.substrate = null;
  state.soilCounts = null;
  state.soilSource = "";
  // ⚠️ The regions were drawn on the PREVIOUS terrain. Their coordinates are
  // map units, so on another tile of the same site they would still land
  // somewhere plausible — and that is exactly the trap: a platform levelled to
  // 78.0 m on the 0.25 m patch is not the same design on the 4 m tile, where
  // one cell is 16 m² and the whole ring might cover four of them. Discarded
  // with the substrate map, for the same reason.
  state.plan.set = new PlanSet();
  state.plan.selected = null;
  state.plan.draft = [];
  state.plan.extent = null;
  // ⚠️ AND THE SELECTION STACK GOES WITH THEM. Its layers are frozen masks
  // indexed over the OLD grid — on a tile of a different size they would be
  // skipped by composeStack as not fitting, but on a tile of the SAME size and
  // a different extent they would fit perfectly and mean somewhere else
  // entirely, which is the worse failure because nothing would say so.
  state.selection.clear();
  state.plan.drag = null;
  if (state.plan.overlay) {
    view.scene.remove(state.plan.overlay.group);
    state.plan.overlay.dispose();
  }
  state.plan.overlay = new PlanOverlay(dem, {
    verticalExaggeration: 1, // set from the slider once it has been read below
    pixelRatio: view.renderer.getPixelRatio(),
  });
  state.plan.overlay.setVisible(state.plan.on);
  view.scene.add(state.plan.overlay.group);
  // ⚠️ The nest outline describes where the PREVIOUS patch sat. A new tile is a
  // new footprint, so redraw it — and let markNest refuse if the new tile is
  // not on the 4 m grid, rather than leaving the old rectangle looking valid.
  //
  // ⚠️ AND A CONTEXT THE NEW SITE DOES NOT SIT INSIDE STANDS DOWN. A custom
  // site dropped somewhere else entirely used to leave the old backdrop
  // standing at its own coordinates — two grounds drawn as one scene,
  // colliding wherever the camera put them. The context is a claim about
  // WHERE THE SITE SITS; when the measurement says it no longer holds, the
  // backdrop switches itself off and the note says why. Dropping a matching
  // context re-enables it — the drop target is always live.
  if (state.dive) {
    const nest = state.dive.markNest(dem);
    if (state.dive.visible) {
      if (nest.contained) {
        setContext(true).catch(() => {});
      } else {
        setContext(false).catch(() => {});
        $("context-note").textContent =
          `Context hidden — this site lies outside it. Drop a matching context to place the site in one.`;
        status("context hidden: the new site lies outside the loaded context tile", 5000);
      }
    }
  }

  // Datum for planarizing = mean elevation, which keeps levelling volume-neutral.
  let sum = 0, n = 0;
  for (const v of dem.z) if (Number.isFinite(v)) { sum += v; n++; }
  state.datum = n ? sum / n : 0;

  // A terrain patch is far wider than it is deep — 5.3 m of relief across 64 m
  // on the Ørndalen patch, a ratio of 0.08 — so at 1:1 it renders as a plate no
  // matter how it is lit. Pick a default exaggeration that brings the relief to
  // a legible fraction of the width. Exaggeration is a CLAIM, not a free
  // display choice, so the factor is always on screen (Morphos §5.7's rule for
  // teaching-mode instruments).
  const [zlo, zhi] = dem.zRange();
  const ratio = (zhi - zlo) / (dem.ncols * dem.cell);
  // ⚠️ PINNED AT 1.0 SINCE 2026-08-19, when the control was removed from the
  // interface at Marc's request. The suggestion below is kept because it is the
  // reasoning, not dead weight: a terrain patch is far wider than it is deep, so
  // a legibility factor is a real want and this is the calculation for it. What
  // it may not do is apply itself while nothing on screen declares it — the
  // comment above states the rule, and an undeclared 4.5x on the opening tile
  // would break it. Restore by returning `legible` instead of 1.
  const legible = ratio > 0 ? Math.min(8, Math.max(1, Math.round((0.22 / ratio) * 2) / 2)) : 1;
  void legible;
  const suggested = 1;
  const exSlider = /** @type {HTMLInputElement} */ ($("ex"));
  exSlider.value = String(suggested);
  $("ex-val").textContent = `${suggested.toFixed(1)}×`;

  buildRepresentation({ reframe: true });

  // The scatter belongs to the previous terrain: its candidates are bound to
  // that grid's cells, so it cannot be carried across a tile change.
  if (state.plants) {
    view.scene.remove(state.plants.group);
    state.plants.dispose();
  }
  // A tile too coarse for the scatter gets no field at all — see syncPlantNote.
  if (dem.cell > MAX_CELL_M) state.showPlants = false;
  state.plants = new StemField(dem, { verticalExaggeration: currentExaggeration() });
  // ⚠️ RE-APPLY THE PALETTE. A new tile builds a new field, which starts mono —
  // so without this, loading a site silently reverted the drawing to one ink
  // while the checkbox went on claiming otherwise.
  state.plants.setPalette(state.plantPalette);
  state.plants.setVisible(state.showPlants);
  view.scene.add(state.plants.group);
  syncPlantNote();

  if (state.analysis) state.analysis.dispose();
  // A new tile is new data: the previous tile's stretch was expressed in
  // percentiles so it would survive edits, but it should not survive a change
  // of subject.
  state.stretch = {};
  state.variant = {};

  state.analysis = new AnalysisClient(dem, onAnalysis, (msg) => {
    // Surface it loudly: a dead worker means the hydrology panels are frozen,
    // which is easy to mistake for "the terrain has no water in it".
    status(`Analysis unavailable — ${msg}`, 0);
    $("status-foot").textContent = "worker failed";
  });
  state.analysis.onRecolour = onRecolour;

  const [lo, hi] = dem.zRange();
  // (The scene card this used to fill moved into the readout's title card —
  // hudMetrics states the same facts, in one place.)
  // The drop targets STAY once a site is loaded. They used to collapse to a
  // plain card, which was right when there was one of them and nothing further
  // to drop; now the context target is most wanted precisely after a site is in.
  paintHillshade();
  updateLedger();
  // ⚠️ A NEW TILE VOIDS THE STACK. Every entry is a rectangle of elevations
  // indexed against the grid it was cut from; replaying one onto a different
  // tile — or the same tile at a different cell size — would splice a block of
  // some other terrain into this one and it would look like ground.
  history.clear();
  pendingEdit = null;
  syncHistoryButtons();
  // Sections are lines in the previous tile's world coordinates; on a new tile
  // they would sample somewhere else entirely, or off the grid.
  if (state.sections.overlay) {
    view.scene.remove(state.sections.overlay.group);
    state.sections.overlay.dispose();
    state.sections.overlay = null;
  }
  state.sections.list = [];
  state.sections.pending = null;
  state.sections.nextId = 1;
  refreshSections();
  // The dimension frame dresses THIS extent as a sheet; a new tile is a new
  // sheet. Always visible (2026-08-11): the sheet reading is the tool's
  // default identity now, not a costume for plan mode.
  if (state.dims) {
    view.scene.remove(state.dims.group);
    state.dims.dispose();
  }
  state.dims = new DimensionFrame(dem, { verticalExaggeration: currentExaggeration() });
  view.scene.add(state.dims.group);
  state.dims.setVisible(true);

  // ⚠️ THE DRAPE WAS RESAMPLED ONTO THE PREVIOUS GRID. Its buffer is indexed
  // against that tile's cells, so on a new one it would paint the old
  // photograph over different ground — the same trap the panel buffers and
  // the substrate map carry a note about. Dropped, not reinterpreted; the
  // file is still on the user's disk if they want it here too.
  state.ortho.rgba = null;
  state.ortho.on = false;
  state.ortho.name = "";
  $("ortho-note").textContent = "";
  setOrtho(false);
  // Photographs are world-placed, so they SURVIVE a tile change — unlike
  // everything above, a geotag means the same thing on any grid. The overlay
  // is rebuilt against the new tile, which re-tests which of them land on it.
  if (state.photos.overlay) {
    view.scene.remove(state.photos.overlay.group);
    state.photos.overlay.dispose();
    state.photos.overlay = null;
  }
  refreshPhotos();
  refreshSubstrate();   // clears the panel and the key for the new tile
  refreshPlan();        // empties the region list and re-hangs the overlay
  refreshSelection();   // …and the stack, cleared with them a few lines above
  // The guide is a line drawn ON a landform. Its world coordinates would place
  // it correctly on an overlapping tile and it would still be the wrong design,
  // because the section was judged against ground that is no longer there —
  // same reasoning the regions follow.
  guide.pts = [];
  refreshGuide();
  // The rule's cached grids, its highlight and its slider bounds all belong
  // to the previous tile — and so does the outline, whose geometry is indexed
  // against that grid.
  dropRuleGrids();
  ruleShown = null;
  shownSource = null;   // the outline's intent belonged to the previous tile
  if (selOverlay) {
    view.scene.remove(selOverlay.group);
    selOverlay.dispose();
    selOverlay = null;
  }
  // The patchwork's labels index the previous grid, and its patches were
  // measured on ground that is no longer loaded.
  if (patchOverlay) {
    view.scene.remove(patchOverlay.group);
    patchOverlay.dispose();
    patchOverlay = null;
  }
  $("t-patches").classList.remove("on");
  // The pond pins are placed in the previous tile's world and sized to its span.
  if (pondPins) {
    view.scene.remove(pondPins.group);
    pondPins.dispose();
    pondPins = null;
  }
  // The symbols are sized from the previous tile's cell and stand on its
  // elevations; the stride is re-chosen from the new grid so the field stays
  // legible on a tile covering sixteen times the ground.
  if (symField) {
    view.scene.remove(symField.group);
    symField.dispose();
    symField = null;
  }
  // The glyphs stand on the previous tile's cells and are sized to its spacing,
  // exactly as the symbols are. The CHAIN survives — it is a recipe, not a
  // reading, and it is the one thing here worth carrying to a new site.
  if (glyphField) {
    view.scene.remove(glyphField.group);
    glyphField.dispose();
    glyphField = null;
  }
  /** @type {HTMLInputElement} */ ($("sym-stride")).value = String(strideFor(dem));
  $("sym-stride").dispatchEvent(new Event("input"));
  // …and the cut face, which is a profile of ground that is no longer loaded.
  // The sections themselves are cleared just below, so the view has nothing
  // left to look along either.
  clearSectionView();
  if (sectionFace) {
    view.scene.remove(sectionFace.group);
    sectionFace.dispose();
    sectionFace = null;
  }
  $("rule-show").classList.remove("on");
  syncRuleUI();
  syncBenchLabels();

  // A contour interval belongs to the terrain, not to the session: 0.5 m reads
  // well on 5.3 m of quarry relief and would draw 2,000 lines on the 1 km
  // context tile. Pick from the tile's own range, and move the slider to match
  // so the control never disagrees with what is on screen.
  const suggestedInterval = niceInterval(hi - lo);
  let best = 0;
  for (let i = 1; i < CONTOUR_INTERVALS.length; i++) {
    if (Math.abs(Math.log(CONTOUR_INTERVALS[i] / suggestedInterval))
      < Math.abs(Math.log(CONTOUR_INTERVALS[best] / suggestedInterval))) best = i;
  }
  state.contours.interval = CONTOUR_INTERVALS[best];
  /** @type {HTMLInputElement} */ ($("contour")).value = String(best);
  $("contour-val").textContent = `${state.contours.interval} m`;
  syncContours();

  // The water field is bound to the previous grid — its instance matrices are
  // that tile's cells. A new tile gets a new field, like the plant scatter.
  if (state.water.field) {
    view.scene.remove(state.water.field.group);
    state.water.field.dispose();
    state.water.field = null;
  }
  refreshWater();
  // The pattern's extent and preview are both stated in cells of THIS grid.
  refreshPattern();
  status(`${name} loaded`);
}

/* ----------------------------------------------------------------- analysis */

/**
 * Build (or rebuild) the 3D representation. Surface and VoxelField deliberately
 * expose the same shape — mesh, updateRect, setAO, setExaggeration,
 * boundingBox, dispose — so everything downstream is indifferent to which is in
 * use, and switching keeps the current terrain, ledger and analysis untouched.
 */
function buildRepresentation(opts = {}) {
  if (!state.dem) return;
  // Toggling representation must not move the camera; loading a new tile must
  // reframe, because the previous surface belongs to different terrain.
  const keepCam = !opts.reframe && state.surface ? view.getCameraState() : null;
  const ao = !opts.reframe && state.surface ? state.surface.ao : null;

  if (state.surface) {
    view.scene.remove(state.surface.mesh);
    state.surface.dispose();
  }
  const repOpts = { verticalExaggeration: currentExaggeration() };
  const rep = state.representation === "voxel"
    ? new VoxelField(state.dem, { ...repOpts, blockCells: state.blockCells ?? undefined })
    : new Surface(state.dem, repOpts);

  // Carry the occlusion AND the painted analysis layer across the rebuild, and
  // apply both with a single refresh rather than one per setter — switching
  // representation should not silently drop the shading you had selected.
  rep.ao = ao;
  rep.flat = state.shading === "none";
  rep.layer = (state.shading === "relief" || rep.flat)
    ? null : state.panels[state.shading] || null;
  rep.updateAll();

  state.surface = rep;
  view.scene.add(rep.mesh);
  view.pickTarget = rep.mesh;
  // The representation was just rebuilt from scratch, so anything hanging off
  // it went with the old one. Contours are re-derived rather than carried
  // across: they are geometry, not state.
  syncContours();
  if (state.representation === "voxel") syncBlockLabel();
  if (keepCam) view.setCameraState(keepCam, 0);
  else view.frame(rep.boundingBox());
}

/**
 * Repaint the hillshade tile. Runs on the main thread and only when the DEM's
 * shape changes — at load and when a gesture settles — because it is a picture
 * of the surface rather than an analysis of it, and nothing downstream reads it.
 */
function paintHillshade() {
  if (!state.dem) return;
  const ctx = panelCtx[FORM_PANEL];
  if (!ctx) return;
  const { ncols, nrows } = state.dem;
  const g = hillshade(state.dem);
  const rgba = new Uint8ClampedArray(g.length * 4);
  for (let i = 0; i < g.length; i++) {
    const o = i * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = g[i];
    rgba[o + 3] = 255;
  }
  if (ctx.canvas.width !== ncols || ctx.canvas.height !== nrows) {
    ctx.canvas.width = ncols; ctx.canvas.height = nrows;
  }
  ctx.putImageData(new ImageData(rgba, ncols, nrows), 0, 0);
}

/** @param {Record<string, Uint8ClampedArray>} panels */
function paintPanels(panels) {
  if (!state.dem) return;
  for (const k of Object.keys(panels)) {
    const ctx = panelCtx[k];
    if (!ctx) continue;
    // The panel canvases are a fixed 256², but a dropped GeoTIFF can be any
    // size, so resize the canvas to the grid rather than stretching the data.
    const cv = ctx.canvas;
    if (cv.width !== state.dem.ncols || cv.height !== state.dem.nrows) {
      cv.width = state.dem.ncols;
      cv.height = state.dem.nrows;
    }
    ctx.putImageData(new ImageData(panels[k], state.dem.ncols, state.dem.nrows), 0, 0);
  }
}

function onAnalysis(m) {
  state.metrics = m.metrics;
  if (m.assemblage) {
    state.assemblage = m.assemblage;
    // Re-seat the scatter on the new assemblage. Candidates keep their cells,
    // so plants appear and disappear where the conditions changed and stay put
    // everywhere else — see the header of plants.js for why that matters.
    if (state.plants && m.assemblage.codes) state.plants.setCodes(m.assemblage.codes);
  }
  if (m.panels) {
    paintPanels(m.panels);
    Object.assign(state.panels, m.panels);
  }
  if (m.domains) { Object.assign(state.domains, m.domains); refreshStretchHandles(); }

  if (m.heavy) {
    paintPanels(m.heavy.panels);
    Object.assign(state.panels, m.heavy.panels);
    if (m.heavy.domains) { Object.assign(state.domains, m.heavy.domains); refreshStretchHandles(); }
    if (m.heavy.landform) state.landform = m.heavy.landform;
    if (m.heavy.basins) {
      const b = m.heavy.basins;
      state.basins = b;
      // ⚠️ NO SWATCH LEGEND FOR THIS LAYER. Basin colours are arbitrary — they
      // exist to separate neighbours, not to name anything — so the readout is
      // a count, and the key would be 917 meaningless squares.
      $("m-basins").textContent = b.count
        ? `${b.count} · largest ${b.largest < 10000
            ? `${b.largest.toFixed(0)} m²` : `${(b.largest / 10000).toFixed(2)} ha`}`
        : "none — no drainage structure";
    }
    // Sky-view factor doubles as ambient occlusion on the 3D surface — this is
    // what gives the terrain its plasticity rather than looking like a lit sheet.
    if (state.surface) state.surface.setAO(m.heavy.svfGrid);
    // The plants get the SAME occlusion the ground does, so vegetation in a
    // hollow sits darker than vegetation on an open rise — which is most of
    // what stops the scatter looking pasted onto the surface.
    if (state.plants) state.plants.setAO(m.heavy.svfGrid);
    const s = m.heavy.sun;
    $("solar-note").textContent =
      `Clear-sky potential, ${s.positions} sun positions` +
      (s.dayStep ? ` at ${s.dayStep}-day steps` : "") + ` · ` +
      `max altitude ${s.maxAltDeg.toFixed(1)}° at 69.7°N · relative, not a forecast`;
    for (const k of HEAVY_PANELS) $(`p-${k}`).classList.remove("settling");
    // Settle is also when the terrain has stopped moving, so it is when a
    // fresh picture of the form is worth the main-thread pass.
    paintHillshade();
  } else {
    // Mark the settle-only layers as stale while a drag is in progress.
    for (const k of HEAVY_PANELS) $(`p-${k}`).classList.add("settling");
  }

  // ⚠️ "SETTLING" IS A STATE OF THE GESTURE, NOT OF THE HARDWARE.
  //
  // This used to key off client.degraded alone, which is a property of the
  // machine and stays true for the whole session — so on a slower machine nine
  // of the sixteen panels sat dimmed and labelled "·settling" permanently,
  // including straight after a settle when they were completely current.
  //
  // The obvious repair — mark them whenever a result arrives without panels —
  // is also wrong, and worse in a demo: in degraded mode passes alternate
  // between carrying panels and not, so the whole column would blink at the
  // pass rate. A flicker reads as a fault; a steady dim reads as information.
  //
  // So it follows the same rule HEAVY_PANELS already follow above: set while the
  // hand is moving AND updates are genuinely being skipped, cleared by the
  // settle. Transient, honest, and it always ends.
  if (m.heavy) {
    for (const k of LIVE_PANELS) $(`p-${k}`).classList.remove("settling");
  } else {
    const skipping = !!state.analysis?.degraded;
    for (const k of LIVE_PANELS) $(`p-${k}`).classList.toggle("settling", skipping);
  }

  applyShading();
  // ⚠️ THE RULE'S CACHED GRIDS BELONG TO THE PREVIOUS PASS. Dropped on every
  // result, so a rule always reads the surface that is on screen — a rule
  // evaluated against stale grids would select somewhere the ground no longer
  // is, and act there, silently.
  dropRuleGrids();
  // ⚠️ …AND THE BLOCKS SIZED BY ONE OF THOSE LAYERS FOLLOW IT. A voxel field
  // scaled by wetness that kept its sizes through an edit would be a picture of
  // ground that has since been cut — the same staleness the line above exists
  // to prevent, one channel over. Cheap: it no-ops unless the size-by control
  // is actually set.
  if (state.representation === "voxel" && $("vox-size").value) refreshVoxelScale();
  // ⚠️ …AND THE GLYPH FIELD, WHICH IS BUILT ENTIRELY FROM THOSE GRIDS. It is
  // not a coat of paint on the terrain — it IS the reading — so a field left
  // standing after an edit would be a picture of ground that no longer exists.
  // This is also the moment the finding shows: level the ground and the
  // aspect-led chain loses its answer, so the field thins out as it is cut.
  if (glyphsOn) refreshGlyphs();
  for (const k of [...LIVE_PANELS, ...HEAVY_PANELS]) refreshLegend(k);
  refreshShadingLegend();
  renderMetrics(m.metrics);
  // The overlay is a picture of the settled measurements, so it repaints when
  // they arrive and at no other time.
  scheduleInstrument();
  $("status-foot").textContent = `worker ${m.ms.toFixed(0)} ms`;
}

/**
 * A pure re-colour came back: same numbers, new mapping. Everything that shows
 * a colour has to move together — the panels, the terrain, and the legends —
 * or the legend would describe a stretch the pixels no longer use.
 */
function onRecolour(m) {
  if (!state.dem) return;
  paintPanels(m.panels);
  Object.assign(state.panels, m.panels);
  Object.assign(state.domains, m.domains);
  refreshStretchHandles();
  applyShadingForce();
  for (const k of [...LIVE_PANELS, ...HEAVY_PANELS]) refreshLegend(k);
  refreshShadingLegend();
}

/** Paint the selected analysis layer onto the 3D terrain, or plain relief. */
function applyShading() {
  const rep = state.surface;
  if (!rep) return;
  const key = state.shading;
  const flat = key === "none";
  // ⚠️ THE DRAPE WINS WHILE IT IS ON, and it is the only thing that jumps this
  // queue. A photograph is not a reading — it shows what WAS there, not what
  // the design does — so it replaces the analysis colour rather than mixing
  // with it, and switching it off restores whatever layer was selected
  // underneath, untouched. See ortho.js.
  const base = (state.ortho.on && state.ortho.rgba) ? state.ortho.rgba
    : (key === "relief" || flat) ? null : state.panels[key] || null;
  // The selection is mixed in last, over whatever is underneath — see
  // withSelection. It never becomes the layer, so switching it off restores
  // exactly what was there.
  const buf = withSelection(base);
  if (rep.flat !== flat) { rep.flat = flat; rep.layer = buf; rep.updateAll(); return; }
  // Only rebuild colours if the buffer actually changed — this runs on every
  // worker result, and re-shading 65k vertices for nothing during a drag would
  // undo the whole point of the dirty-rect path.
  if (rep.layer === buf) return;
  rep.setLayer(buf);
}

/**
 * Repaint the terrain even though the buffer object may be the same shape as
 * before. applyShading() short-circuits when the buffer is unchanged, which is
 * right during a drag and wrong after a re-colour: the pixels are new even
 * when the layer is not.
 */
function applyShadingForce() {
  const rep = state.surface;
  if (!rep) return;
  if (state.ortho.on && state.ortho.rgba) {
    rep.setLayer(withSelection(state.ortho.rgba)); return;
  }
  const key = state.shading;
  if (key === "relief" || key === "none") {
    // ⚠️ A SELECTION MUST STILL SHOW WITH NO LAYER ON. Returning early here —
    // which the layer-only version did — meant "show selection" did nothing
    // whenever the terrain was on plain relief, which is precisely the state
    // someone is in when they first draw a rule.
    if (ruleShown) rep.setLayer(withSelection(null));
    return;
  }
  const buf = state.panels[key];
  if (buf) rep.setLayer(withSelection(buf));
}

/* ------------------------------------------------------- orthophoto drape */

/**
 * Adopt a dropped orthophoto. Local only — see ortho.js for why that is
 * structural rather than a promise.
 * @param {File} file
 */
async function loadOrthoFile(file) {
  if (!state.dem) { status("load a site first — an ortho has nothing to drape on", 5000); return; }
  status(`reading ${file.name}…`, 0);
  const img = readOrthoTIFF(await file.arrayBuffer());
  const draped = drapeOnto(img, state.dem);
  if (!draped) {
    // ⚠️ THE HONEST ANSWER FOR A PHOTOGRAPH OF SOMEWHERE ELSE. Silently
    // draping nothing would look like a broken reader; the tool says the two
    // extents do not meet, and gives both, because that is the diagnosis.
    const ix = img.originX.toFixed(0), iy = img.originY.toFixed(0);
    $("ortho-note").textContent =
      `${file.name} does not overlap this site. Image at E ${ix} N ${iy}, `
      + `${(img.width * img.cell).toFixed(0)} × ${(img.height * img.cell).toFixed(0)} m; `
      + `site at E ${state.dem.originX.toFixed(0)} N ${state.dem.originY.toFixed(0)}. `
      + `Load the DEM cut for the same centre.`;
    status("the ortho does not overlap this site — see the note", 6000);
    return;
  }
  state.ortho.rgba = draped.rgba;
  state.ortho.covered = draped.covered;
  state.ortho.name = file.name;
  setOrtho(true);
  $("ortho-note").textContent =
    `${file.name} · ${img.width}×${img.height} at ${img.cell} m · `
    + `covers ${(draped.covered * 100).toFixed(0)}% of the site. `
    + `Held in memory for this session only: the drape is never written to any `
    + `export, and closing the tab discards it.`;
  status(`ortho draped · ${(draped.covered * 100).toFixed(0)}% coverage · display only, never exported`, 6000);
}

/** @param {boolean} on */
function setOrtho(on) {
  state.ortho.on = !!on && !!state.ortho.rgba;
  $("t-ortho").classList.toggle("on", state.ortho.on);
  /** @type {HTMLButtonElement} */ ($("t-ortho")).disabled = !state.ortho.rgba;
  applyShading();
  applyShadingForce();
}

/* -------------------------------------------------- site visit photographs */

/**
 * Adopt dropped site photographs, placed by their own EXIF geotags.
 * @param {FileList|File[]} files
 */
async function loadPhotos(files) {
  if (!state.dem) { status("load a site first", 4000); return; }
  const list = [...files].filter((f) => /\.jpe?g$/i.test(f.name));
  if (!list.length) { status("drop JPEGs — a geotag is what places them", 5000); return; }
  status(`reading ${list.length} photograph${list.length > 1 ? "s" : ""}…`, 0);
  let read = 0, untagged = 0;
  for (const f of list) {
    const p = await readPhoto(f).catch(() => null);
    if (!p) { untagged++; continue; }
    state.photos.list.push(p);
    read++;
  }
  // ⚠️ DROPPING IS THE REQUEST TO SEE THEM. The layer used to default off, so
  // a drop read the files, placed the marks and showed nothing until a toggle
  // was found — which reads as the feature being broken, and was reported as
  // exactly that. Switched on here, once, on the first set that arrives.
  if (read) state.photos.on = true;
  refreshPhotos();

  const placed = state.photos.overlay?.marks.length ?? 0;
  const offsite = read - placed;
  const bits = [`${placed} placed`];
  if (offsite > 0) bits.push(`${offsite} outside this tile`);
  if (untagged > 0) bits.push(`${untagged} without a geotag`);

  // ⚠️ "OUTSIDE THIS TILE" IS USELESS WITHOUT A DIRECTION AND A DISTANCE. A
  // 64 m patch is smaller than most site walks, so this is the ORDINARY case,
  // not an error — and the honest, actionable answer is where the pictures
  // actually are relative to the ground on screen.
  let where = "";
  if (offsite > 0 && state.dem) {
    const off = state.photos.list.slice(-read).filter((p) => {
      const lx = p.x - state.dem.originX, ly = p.y - state.dem.originY;
      return lx < 0 || ly < 0 || lx > state.dem.ncols * state.dem.cell
        || ly > state.dem.nrows * state.dem.cell;
    });
    if (off.length) {
      const cx = off.reduce((a, p) => a + p.x, 0) / off.length;
      const cy = off.reduce((a, p) => a + p.y, 0) / off.length;
      const tx = state.dem.originX + (state.dem.ncols * state.dem.cell) / 2;
      const ty = state.dem.originY + (state.dem.nrows * state.dem.cell) / 2;
      const dx = cx - tx, dy = cy - ty;
      const dist = Math.hypot(dx, dy);
      const dirs = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];
      const dir = dirs[(Math.round((Math.atan2(dy, dx) * 4) / Math.PI) + 8) % 8];
      where = ` They sit about ${dist < 1000 ? `${dist.toFixed(0)} m` : `${(dist / 1000).toFixed(2)} km`} `
        + `${dir} of this tile's centre — load a tile that covers them, `
        + `such as a 1 km context cut for the same walk.`;
    }
  }

  $("photos-note").textContent =
    `${bits.join(" · ")}.${where} Positions are the camera's own GPS — metres, not `
    + `centimetres — and the marks sit on the terrain, not at the recorded `
    + `altitude, which on this set was unreliable. Observations, not model `
    + `output: they say what was seen, on one date, at one point. Never exported.`;
  status(placed
    ? `${bits.join(" · ")} — photo points shown`
    : `no photograph lands on this tile.${where}`, 7000);
}

/** Everything on screen that describes the photographs. One entry point. */
function refreshPhotos() {
  const any = state.photos.list.length > 0;
  $("photos-tools").hidden = !any;
  if (!state.dem) return;
  if (!state.photos.overlay) {
    state.photos.overlay = new PhotoOverlay(state.dem,
      { verticalExaggeration: currentExaggeration() });
    view.scene.add(state.photos.overlay.group);
  }
  const ov = state.photos.overlay;
  ov.setExaggeration(currentExaggeration());
  // 1 km beyond the tile edge: a site walk is bigger than a design patch, and
  // the marks beyond the surveyed ground are drawn as open rings to say so.
  ov.setPhotos(state.photos.list,
    { radius: PHOTO_RADIUS_M, selected: state.photos.selected });
  ov.setVisible(state.photos.on && any);
  $("t-photos").classList.toggle("on", state.photos.on);
  /** @type {HTMLButtonElement} */ ($("t-photos")).disabled = !any;

  const ul = /** @type {HTMLElement} */ ($("photo-list"));
  ul.innerHTML = "";
  for (const p of state.photos.list) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "grow";
    label.textContent = p.name;
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = p.bearing !== null ? `${p.bearing.toFixed(0)}°` : "—";
    li.append(label, val);
    // Clicking a row shows the photograph itself: the mark says where, and
    // the picture is the observation the mark stands for. The row goes black
    // with its pin, so the list and the model answer "which one?" alike.
    li.classList.toggle("on", state.photos.selected === p.name);
    li.style.cursor = "pointer";
    li.addEventListener("click", () => showPhoto(p));
    ul.appendChild(li);
  }
}

/** @param {{name:string,url:string,when:string|null,bearing:number|null,alt:number|null}} p */
function showPhoto(p) {
  const box = $("photo-view");
  box.hidden = false;
  box.innerHTML =
    `<img src="${p.url}" alt="${p.name}">`
    + `<div class="meta"><b>${p.name}</b>${p.when ? ` · ${p.when}` : ""}`
    + `${p.bearing !== null ? ` · bearing ${p.bearing.toFixed(0)}°` : ""}</div>`;
  // ⚠️ OPENING A PICTURE SELECTS ITS PIN. The window says WHICH photograph;
  // without this it did not say WHERE, and finding it among identical marks
  // was a hunt. Dismissing the window deselects, so a black pin always means
  // "this is the one on screen".
  state.photos.selected = p.name;
  refreshPhotos();
  box.onclick = () => {
    box.hidden = true;
    state.photos.selected = null;
    refreshPhotos();
  };
}

function clearPhotos() {
  for (const p of state.photos.list) URL.revokeObjectURL(p.url);
  state.photos.list = [];
  state.photos.selected = null;
  $("photo-view").hidden = true;
  refreshPhotos();
  status("photographs cleared");
}

function renderMetrics(mx) {
  if (!mx || !state.dem) return;
  const [lo, hi] = state.dem.zRange();
  $("m-relief").textContent = `${(hi - lo).toFixed(2)} m`;
  $("m-slope").textContent = `${mx.slopeMeanDeg.toFixed(2)}°`;
  $("m-tri").textContent = `${mx.triMean.toFixed(4)} m`;
  $("m-geo").textContent = mx.geodiversity.toFixed(3);
  if (Number.isFinite(mx.landformDiversity)) {
    $("m-landform").textContent =
      `${mx.landformDiversity.toFixed(3)} · ${mx.landformClasses}/10`;
  }
  if (Number.isFinite(mx.catchmentMax)) {
    $("m-catchment").textContent = `${mx.catchmentMax.toFixed(0)} m²`;
  }
  $("m-storage").textContent = `${mx.storageVolume.toFixed(2)} m³`;
  $("m-depr").textContent = String(mx.depressionCount);
  $("m-twi").textContent = `${(100 * mx.twiValidFraction).toFixed(1)}%`;

  // The biotic readouts. H' is shown against its own ceiling because an
  // unscaled diversity index means nothing on its own — 1.72 is only legible
  // next to the 1.95 this seven-species list can reach.
  if (Number.isFinite(mx.shannon)) {
    $("m-shannon").textContent =
      `${mx.shannon.toFixed(3)} / ${(mx.shannonMax ?? SHANNON_MAX).toFixed(2)}`;
    $("m-richness").textContent =
      `${mx.richness} / ${mx.speciesTotal ?? SPECIES.length}`;
    $("m-invasive").textContent = `${(100 * mx.invasiveFraction).toFixed(1)}%`;
  }
  renderTraitTable();
}

/**
 * The trait table, with each species' current share of the ground.
 *
 * ⚠️ THIS IS ON SCREEN ON PURPOSE. Every other layer in this tool is a
 * measurement that an independent script can check; the envelopes behind this
 * one are assumptions, and the only honest way to show an assumption is to let
 * the reader see it and disagree. It doubles as the citable list for the
 * exhibition, which is why the binomials are here rather than the common names
 * alone.
 */
function renderTraitTable() {
  const el = $("trait-table");
  const counts = state.assemblage ? state.assemblage.counts : null;
  const total = counts
    ? counts.reduce((a, b) => a + b, 0) + (state.assemblage.bare || 0) : 0;
  const cat = CATEGORICAL.species;
  el.innerHTML = SPECIES.map((s, i) => {
    const [r, g, b] = cat.colours[i];
    const n = counts ? counts[i] : 0;
    const pct = total ? `${((100 * n) / total).toFixed(1)}%` : "—";
    return `<div class="trait${n > 0 ? " on" : ""}">`
      + `<i style="background:rgb(${r},${g},${b})"></i>`
      + `<span class="sp"><em>${s.name}</em>`
      + (s.invasive ? `<span class="flag">invasive</span>` : "")
      + `<small>${s.note}</small></span>`
      + `<b>${pct}</b></div>`;
  }).join("");
}
renderTraitTable();

/* ---------------------------------------------------------------- substrate */

/**
 * How the codes in an imported raster should be read. The tool cannot tell a
 * NIBIO grunnforhold code from its own class code by looking — a 4 is a 4 — so
 * the user says which, and the crosswalk used is named on screen rather than
 * being applied invisibly.
 */
const SOIL_CODINGS = {
  own: { label: "this tool's classes", map: Substrate.identityMap },
  ar5: { label: "NIBIO AR5 grunnforhold", map: Substrate.crosswalk(Substrate.AR5_GRUNNFORHOLD) },
  ngu: { label: "NGU løsmassetype", map: Substrate.crosswalk(Substrate.NGU_LOSMASSETYPE) },
};

/** Recolour the substrate panel and refresh everything that reads it. */
function refreshSubstrate() {
  if (!state.dem) return;
  const g = state.substrate;
  state.soilCounts = g ? Substrate.substrateCounts(g) : null;
  if (g) {
    // The same function the worker uses for every other class raster, so the
    // one colour convention in ramps.js governs this layer too.
    const rgba = colouriseClasses("soil", g);
    state.panels.soil = rgba;
    paintPanels({ soil: rgba });
  } else {
    delete state.panels.soil;
    const ctx = panelCtx.soil;
    if (ctx) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (state.shading === "soil") setShading("relief");
  }
  refreshLegend("soil");
  refreshShadingLegend();
  applyShadingForce();
  syncSoilUI();
  // Substrate is the only thing besides the ground itself that changes where
  // water ends up — it is what decides how much soaks away. This is what makes
  // "leave it as crushed rock or specify a growing medium" a hydrological
  // decision on screen rather than only a botanical one.
  if (state.water.on) refreshWater();
}

/** Adopt a substrate grid, hand a copy to the worker, and record its source. */
function adoptSubstrate(grid, source) {
  state.substrate = grid;
  state.soilSource = source;
  refreshSubstrate();
  // The worker needs it only so the export path finds it beside every computed
  // layer — see analysis-client.setSubstrate.
  state.analysis?.setSubstrate(grid);
}

/**
 * Load a substrate raster the user dropped or picked.
 *
 * ⚠️ ALIGNMENT IS CHECKED NUMERICALLY, BECAUSE THERE IS NOTHING ELSE TO CHECK.
 * geotiff.js never parses the CRS, so a raster in the wrong projection is
 * indistinguishable from a correct one except by where it lands. The overlap is
 * therefore measured and reported, and an import that barely touches the DEM is
 * refused rather than drawn in the wrong place looking plausible.
 * @param {File} file
 */
async function loadSubstrateFile(file) {
  if (!state.dem) return;
  status(`reading ${file.name}…`, 0);
  const buf = await file.arrayBuffer();
  // classes: true — do NOT let the elevation sentinel sweep rewrite class codes.
  const raw = loadGeoTIFF(buf, { name: file.name, classes: true });
  if (raw.warnings.length) console.warn(file.name, raw.warnings);

  const coding = SOIL_CODINGS[/** @type {HTMLSelectElement} */ ($("soil-coding")).value]
    || SOIL_CODINGS.own;
  const res = Substrate.resampleToDem(raw, state.dem, coding.map);

  if (res.overlap < 0.02) {
    status(`${file.name} does not overlap this tile (${(100 * res.overlap).toFixed(1)}%) — ` +
      `wrong area, or a different projection. Not loaded.`, 0);
    return;
  }
  adoptSubstrate(res.grid, `${file.name} · ${coding.label}`);

  const bits = [`${(100 * res.overlap).toFixed(0)}% overlap`,
    `source cell ${(res.cellRatio * state.dem.cell).toFixed(2)} m`,
    `${res.classes.length} class${res.classes.length === 1 ? "" : "es"}`];
  if (res.overlap < 0.9) bits.push("⚠ partial coverage");
  if (res.cellRatio > 8) bits.push("⚠ much coarser than this tile");
  status(`substrate loaded · ${bits.join(" · ")}`, 8000);
}

/** Paint the current substrate class over a disc. Never touches the ledger. */
function applySoilPaint(p) {
  if (!state.dem) return;
  if (!state.substrate) {
    // The first stroke on a site with no imported map starts an empty one, so
    // the brush works without requiring a file the site may not have.
    state.substrate = new Uint8Array(state.dem.nrows * state.dem.ncols)
      .fill(Substrate.UNKNOWN);
    state.soilSource = "painted";
  }
  const radius = parseFloat(/** @type {HTMLInputElement} */ ($("radius")).value);
  const r = Substrate.paintSubstrate(
    state.substrate, state.dem, state.soilClass, p.x, p.y, radius);
  if (r.changed > 0) refreshSubstrate();
  // A substrate stroke has no Stroke object to keep a union rect on, so it is
  // accumulated here — undo needs the extent of the whole gesture, not of the
  // last dab.
  if (r.changed > 0) {
    soilRect = soilRect ? {
      r0: Math.min(soilRect.r0, r.r0), c0: Math.min(soilRect.c0, r.c0),
      r1: Math.max(soilRect.r1, r.r1), c1: Math.max(soilRect.c1, r.c1),
    } : { r0: r.r0, c0: r.c0, r1: r.r1, c1: r.c1 };
  }
}

/** Union of a substrate gesture's dabs, or null between gestures. */
/** @type {{r0:number,c0:number,r1:number,c1:number}|null} */
let soilRect = null;

/** The class palette and the provenance line. */
function syncSoilUI() {
  const wrap = $("soil-classes");
  if (!wrap) return;
  const counts = state.soilCounts;
  const total = counts
    ? counts.counts.reduce((a, b) => a + b, 0) + counts.unknown : 0;
  const cat = CATEGORICAL.soil;
  const swatch = (i, name, rgb, note) => {
    const n = counts && i < Substrate.SUBSTRATE.length ? counts.counts[i] : 0;
    const pct = total && n ? ` ${((100 * n) / total).toFixed(0)}%` : "";
    return `<button class="swatch${i === state.soilClass ? " on" : ""}" data-soil="${i}" `
      + `title="${note}"><i style="background:rgb(${rgb.join(",")})"></i>`
      + `${name}<b>${pct}</b></button>`;
  };
  wrap.innerHTML =
    Substrate.SUBSTRATE.map((s, i) => swatch(i, s.name, cat.colours[i], s.note)).join("")
    + swatch(Substrate.UNKNOWN, "unknown", [214, 210, 202],
      "erase substrate information from these cells");

  for (const b of wrap.querySelectorAll("button.swatch")) {
    b.addEventListener("click", () => {
      state.soilClass = parseInt(/** @type {HTMLElement} */ (b).dataset.soil, 10);
      syncSoilUI();
      status(`substrate brush: ${state.soilClass === Substrate.UNKNOWN
        ? "unknown" : Substrate.SUBSTRATE[state.soilClass].name}`);
    });
  }

  $("soil-note").textContent = state.substrate
    ? `${state.soilSource} · ${total ? (100 * counts.known / total).toFixed(0) : 0}% classified`
    : "No substrate map. Drop a GeoTIFF, or pick a class and paint one — on a "
      + "constructed site the substrate is a specification, not a survey.";
}

function updateLedger() {
  const l = state.ledger;
  $("l-net").textContent = l.netLabel(1);
  $("l-cut").textContent = l.cut.toFixed(1);
  $("l-fill").textContent = l.fill.toFixed(1);
}

/* ------------------------------------------------------------------ history */

const history = new History();

/**
 * A gesture in flight: the whole surface as it stood before it began.
 *
 * ⚠️ A FULL COPY WHILE THE HAND IS MOVING, TRIMMED WHEN IT LIFTS. A brush stroke
 * does not know its own extent until it ends, so there is nothing smaller to
 * copy at the start — but keeping the whole 262 kB surface per gesture would
 * spend the entire memory budget recording a few thousand changed cells. The
 * copy is taken once, held for the duration of the gesture, and thrown away
 * against the union rect at the end.
 * @type {{z: Float32Array, soil: Uint8Array|null, cut: number, fill: number}|null}
 */
let pendingEdit = null;

/** Take the before-picture. Cheap enough to call on every pointerdown. */
function beginEdit(withSoil = false) {
  if (!state.dem) return;
  pendingEdit = {
    z: state.dem.z.slice(),
    soil: withSoil && state.substrate ? state.substrate.slice() : null,
    cut: state.ledger.cut,
    fill: state.ledger.fill,
  };
}

/**
 * Record the gesture that just finished, over the rect it actually touched.
 * @param {string} label @param {{r0:number,c0:number,r1:number,c1:number}|null} rect
 */
function commitEdit(label, rect) {
  const p = pendingEdit;
  pendingEdit = null;
  if (!p || !rect || !state.dem) return;
  if (rect.r1 < rect.r0 || rect.c1 < rect.c0) return;
  history.push(captureRect({
    z: p.z, ncols: state.dem.ncols, rect, label,
    cut: p.cut, fill: p.fill, soil: p.soil,
  }));
  syncHistoryButtons();
  // ⚠️ THE GROUND JUST MOVED, so any layer read off it may now be stale.
  // ⚠️ AND IT IS HOOKED HERE, ONCE PER GESTURE, NOT PER FRAME. commitEdit fires
  // at the end of a stroke rather than inside it, which is what makes an O(n)
  // fingerprint over 65 536 heights affordable at all — the same reasoning
  // selectRegion() records for rebuilding the pattern field.
  refreshSelectionStale();
}

/** Throw away a before-picture without recording it — a gesture that moved nothing. */
function abandonEdit() { pendingEdit = null; }

function syncHistoryButtons() {
  /** @type {HTMLButtonElement} */ ($("undo")).disabled = !history.canUndo;
  /** @type {HTMLButtonElement} */ ($("redo")).disabled = !history.canRedo;
  $("undo").title = history.canUndo
    ? `undo ${history.past[history.past.length - 1].label} · Ctrl+Z`
    : "nothing to undo";
  $("redo").title = history.canRedo
    ? `redo ${history.future[history.future.length - 1].label} · Ctrl+Shift+Z`
    : "nothing to redo";
}

/**
 * Put the surface, the ledger and the substrate back, then refresh everything
 * that reads them.
 *
 * ⚠️ THE REFRESH LIST IS THE SAME ONE EVERY OTHER EDIT PATH USES, and it has to
 * be: an undo that restored the elevations but left the hydrology, the water,
 * the contours or the region masks describing the previous surface would be a
 * tool disagreeing with itself, which is worse than one that cannot undo.
 * @param {"undo"|"redo"} dir
 */
function stepHistory(dir) {
  if (!state.dem || !state.surface || !state.analysis) return;
  const apply = (edit) => applyEdit({
    dem: state.dem, edit, substrate: state.substrate, ledger: state.ledger,
  });
  const done = dir === "undo" ? history.undo(apply) : history.redo(apply);
  if (!done) { status(dir === "undo" ? "nothing to undo" : "nothing to redo", 1200); return; }

  const rect = { r0: done.r0, c0: done.c0, r1: done.r1, c1: done.c1 };
  state.surface.updateRect(rect.r0, rect.c0, rect.r1, rect.c1);
  refreshSurfaceOverlays(true);
  if (state.water.on) refreshWater();
  updateLedger();
  if (done.soil) refreshSubstrate();
  state.analysis.invalidate(rect);
  state.analysis.settle();
  // The ground under every ring may have moved, so the elevation range the
  // level slider is bounded by is stale — same reason applyPlanLevel does this.
  planInvalidate();
  refreshPlan();
  refreshPattern();
  syncHistoryButtons();
  status(`${dir === "undo" ? "undone" : "redone"}: ${done.label}`, 2200);
}

$("undo").addEventListener("click", () => stepHistory("undo"));
$("redo").addEventListener("click", () => stepHistory("redo"));

/* -------------------------------------------------------------------- brush */

function currentExaggeration() {
  return parseFloat(/** @type {HTMLInputElement} */ ($("ex")).value);
}
function brushCfg() {
  const cfg = {
    tool: state.tool,
    radius: parseFloat(/** @type {HTMLInputElement} */ ($("radius")).value),
    strength: parseFloat(/** @type {HTMLInputElement} */ ($("strength")).value),
  };
  // Level has two modes and the difference decides whether the video's
  // levelling beat works at all — see brush.js and planning/02 §4b.
  if (state.tool === "level" && /** @type {HTMLInputElement} */ ($("datum")).checked) {
    cfg.target = state.datum;
    cfg.strength = 1.0; // planarize fully; strength would only slow it down
  }
  // ⚠️ THE BRUSH OBEYS THE SELECTION (Marc, 2026-08-19). It was the ONE modifier
  // that did not: benching, stamping and levelling all took `activeMask`, while
  // a stroke wrote wherever the pointer went. Selecting steep ground and then
  // painting it did exactly nothing to honour the selection, which reads as the
  // selection being broken rather than the brush ignoring it.
  const w = selectionWeights();
  if (w) {
    cfg.weights = w;
    // ⚠️ ARMED BUT EMPTY IS SAID OUT LOUD. An all-zero field means the stroke
    // will move nothing, and silence there reads as a broken brush rather than
    // as an empty selection — the same lesson as the rule panel's empty hint.
    if (!w.some((v) => v > 0)) {
      status("the selection is empty — the brush moves nothing; "
        + "widen the rule or switch it off", 4000);
    }
  }
  return cfg;
}

/** Surface point under a pointer event, in DEM world coordinates. */
function pickWorld(e) {
  const hit = view.pick(e.clientX, e.clientY);
  if (!hit) return null;
  // The mesh is drawn with vertical exaggeration; X/Y are unscaled, so they can
  // be used directly. Only Z is stretched, and the brush does not use Z.
  return { x: hit.x, y: hit.y };
}

let painting = false;
let lastPaintT = 0;

/** How far beyond the tile edge photo marks are still drawn, in metres. */
const PHOTO_RADIUS_M = 1000;

/**
 * Which photo pin, if any, is under a screen point.
 *
 * ⚠️ PROJECTED, NOT RAYCAST. The marks lie flat ON the terrain with depth
 * testing off, so a ray would have to fight the surface for the hit and would
 * miss a pin the user can plainly see. Projecting the mark's own world point
 * and measuring in pixels tests exactly what is on screen — the same approach
 * the readout's hit regions use.
 * @param {PointerEvent|MouseEvent} e
 */
function photoAt(e) {
  const ov = state.photos.overlay;
  if (!state.photos.on || !ov || !ov.marks.length || !state.dem) return null;
  const rect = view.canvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  view.camera.updateMatrixWorld();
  const ex = currentExaggeration();
  const v = new THREE.Vector3();
  // ⚠️ THE HIT TEST ITSELF LIVES IN photo-view.js, with the pin's own geometry
  // and its measured history — the app supplies only the projection. It was
  // inline here, which is why the two-ends version went untested through the
  // whole of Phase 8C while being exactly the kind of screen-space rule this
  // project has already been bitten by twice.
  return nearestPin(ov.marks, px, py, (wx, wy, wz) => {
    v.set(wx, wy, wz * ex).project(view.camera);
    if (v.z > 1) return null;    // behind the camera
    return [((v.x + 1) / 2) * rect.width, ((1 - v.y) / 2) * rect.height];
  });
}

view.onPointerDown = (e) => {
  // ⚠️ A PIN CLAIMS THE CLICK BEFORE ANY TOOL SEES IT (2026-08-11), which is
  // why this returns true: without it, clicking a photograph would also lay
  // down a scoop or a plan vertex, and one gesture would mean two things. It
  // is tested FIRST, above plan mode, because a pin is visible in every mode
  // and the user is aiming at a thing they can see rather than at the ground.
  if (e.button === 0 && !e.altKey && !e.shiftKey) {
    const hit = photoAt(e);
    if (hit) { showPhoto(hit); return true; }
  }
  // ⚠️ SHIFT + LEFT BELONGS TO THE STRENGTH GESTURE, so the brush must not
  // claim it. This handler returns true to take a drag away from the camera;
  // returning false here lets it fall through to view.js, which reads the same
  // combination as "drag the strength". Without this the brush would paint and
  // the strength would never move — the gesture would look broken while both
  // halves were individually correct.
  if (e.button === 0 && e.shiftKey && view.onBrushStrength) return false;
  // ⚠️ PLAN MODE TAKES THE GESTURE BEFORE THE BRUSH DOES, and never falls
  // through to it. The two palettes are mutually exclusive by construction:
  // a click that placed a vertex AND scooped a hollow would be two design
  // decisions from one gesture.
  if (state.plan.on) return planPointerDown(e);
  // Only the plain LEFT button paints. Middle orbits, right pans, and alt or
  // shift hand the drag to the camera as well — checking for "not left" rather
  // than listing the camera buttons is what stops a new button silently
  // inheriting the brush, which is how middle-click ended up painting.
  if (e.button !== 0 || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return false;
  if (!state.dem || !state.surface) return false;
  const p = pickWorld(e);
  if (!p) return false;

  /** @type {HTMLCanvasElement} */ (view.canvas).setPointerCapture(e.pointerId);
  painting = true;
  lastPaintT = clock.t;
  // The before-picture, taken before the first dab lands. A substrate stroke
  // needs the class codes too; an earthwork stroke does not touch them.
  beginEdit(state.tool === "soil");
  soilRect = null;
  // ⚠️ The substrate tool does NOT create a Stroke and does NOT get a Ledger.
  // It assigns class codes; it moves no material. Routing it through the
  // earthwork path would put a growing-medium specification into the cut/fill
  // readout and corrupt the tool's closing claim.
  if (state.tool === "soil") { applySoilPaint(p); return true; }
  state.stroke = new Stroke(state.dem, state.ledger, brushCfg());
  applyStroke(p, 0);
  return true; // claim the gesture
};

view.onPointerMove = (e) => {
  if (state.plan.on) { planPointerMove(e); return; }
  if (!painting) return;
  const p = pickWorld(e);
  if (!p) return;
  if (state.tool === "soil") { applySoilPaint(p); return; }
  const dt = clock.t - lastPaintT;
  lastPaintT = clock.t;
  applyStroke(p, dt);
};

view.onPointerUp = (e) => {
  if (state.plan.on) { planPointerUp(e); return; }
  if (!painting) return;
  painting = false;
  if (state.tool === "soil") {
    // Nothing to settle — no elevation changed, so no analysis is stale. The
    // worker only needs the new grid so a later export carries it.
    state.analysis?.setSubstrate(state.substrate);
    commitEdit("substrate paint", soilRect);
    soilRect = null;
    const c = state.soilCounts;
    status(c ? `substrate painted · ${(100 * c.known / (c.known + c.unknown)).toFixed(0)}% classified`
      : "substrate painted");
    return;
  }
  // The stroke's union rect is what was actually touched — recorded before the
  // stroke object is dropped, or there would be nothing left to trim against.
  commitEdit(`${state.tool} stroke`, state.stroke ? state.stroke.rect : null);
  state.stroke = null;
  // Settle: force one complete pass so the readouts are exact rather than
  // coalesced. The demo timeline depends on this.
  refreshSurfaceOverlays(true);   // never leave the throttled version on screen
  // ⚠️ ON STROKE END, NOT PER FRAME. Re-settling an event costs a priority
  // flood, and water standing in a hollow the hand is still in the middle of
  // filling in would be worse than no water at all — so it is recomputed once,
  // when the gesture is finished and the ground means something again.
  if (state.water.on) refreshWater();
  state.analysis?.settle();
  status("settling…", 900);
};

/**
 * Rebuild the contour geometry, at most this often while a gesture is running.
 *
 * ⚠️ CONTOURS CANNOT RIDE THE DIRTY RECT, which is what every other live update
 * in this tool does. The lattice shares the surface's own position buffer and
 * deforms for free; the analysis panels take a rect and recompute a window. A
 * contour line is its own geometry with its own vertex count, and moving one
 * cell can add or remove segments anywhere along a level — so it is a whole
 * rebuild or nothing.
 *
 * ⚠️ THE THROTTLE IS SET FROM A MEASUREMENT, NOT FROM CAUTION. A whole rebuild
 * of the design patch at a 0.5 m interval measures 1.2 ms in Node (self-test
 * group F) — an order of magnitude cheaper than the estimate this was first
 * written against, because testing each triangle only against the levels its own
 * range contains turns the cost into a function of the line work rather than of
 * cells × levels. So 20 Hz is comfortable rather than a compromise: the lines
 * follow the hand continuously and still leave the ~1.3 ms per-frame stroke
 * budget intact. Raise it only against a fresh measurement in the BROWSER, where
 * the rebuild also uploads a new vertex buffer, which Node does not.
 *
 * The stroke end always forces a refresh, so what is left on screen when the
 * hand stops is never the throttled approximation.
 */
let lastOverlayBuild = 0;
function refreshSurfaceOverlays(force = false) {
  const now = performance.now();
  if (!force && now - lastOverlayBuild < 50) return;
  lastOverlayBuild = now;
  // ⚠️ CONTOURS AND SECTIONS ARE REFRESHED TOGETHER, from one place, on purpose.
  // They are the two pieces of geometry in this app that are DERIVED from the
  // surface but cannot ride the dirty rect — both are their own vertex buffers
  // whose length changes with the ground. Refreshing them from separate call
  // sites would mean six places to keep in step, and the failure when one was
  // missed is a section or a contour describing a surface that no longer exists,
  // which looks exactly like a correct drawing.
  const s = /** @type {any} */ (state.surface);
  if (s && s.refreshContours && state.contours.on) s.refreshContours();
  if (state.sections.list.length) refreshSections();
  // ⚠️ AND THE APRON, which is the third thing derived from this surface and
  // unable to ride the dirty rect. It is stitched to the patch's BOUNDARY
  // heights, so editing the edge of the tile tears the seam and opens a hole in
  // the one place the feature exists to have none — and it does it silently,
  // because the apron is still a perfectly good description of where the
  // boundary used to be.
  state.dive?.apron?.refresh();
  // ⚠️ AND THE SELECTION OUTLINE — the FOURTH, and it was missing (2026-08-12).
  // It is draped on the surface, so every modifier that moves ground leaves it
  // describing heights that no longer exist. Measured: benching the POI patch
  // with the selection shown moved the mean slope 19.571° → 17.891° and left the
  // outline geometry byte-identical, standing up to 0.768 m off the ground it
  // was drawn on. It read as "the selection breaks after you use it once",
  // which is exactly the failure this function's docstring predicts — a correct
  // drawing of a surface that has since gone. The mask is NOT re-evaluated; see
  // SelectionOverlay.refresh().
  selOverlay?.refresh();
  // ⚠️ AND THE PATCHWORK — same class as the selection outline: draped on the
  // surface, unable to ride the dirty rect. The PARTITION is not re-evaluated,
  // for the same reason the mask is not — a landform map recomputed unasked
  // would redraw the patchwork behind the designer's back; only the drape
  // follows the ground. See PatchOverlay.refresh().
  patchOverlay?.refresh();
  // ⚠️ AND THE CUT FACE — the FIFTH. Same class as the four above: derived from
  // the surface, its own vertex buffer, unable to ride the dirty rect. Left
  // alone it draws the ground as it was before the edit, sitting in the middle
  // of the terrain that has since moved.
  if (sectionView) refreshSectionFace();
  // ⚠️ AND THE SYMBOLS — the SEVENTH. They stand on the terrain's own
  // elevations AND read a layer computed from it, so an edit invalidates both
  // their height and their size. Cheap: the grids are re-fetched once per
  // settle, and rebuilding a few thousand discs is one buffer.
  if (symbolsOn) refreshSymbols();
  // ⚠️ AND THE CORNER DROPPERS — the SIXTH. They hang from the terrain's four
  // corner elevations, so an edit that reaches a corner leaves them ending in
  // mid-air above the ground they are supposed to touch. Only the droppers are
  // rebuilt; the dimension figures measure the plan extent, which no edit
  // changes. See DimensionFrame.refresh().
  state.dims?.refresh();
}

function applyStroke(p, dt) {
  const s = state.stroke;
  if (!s || !state.surface || !state.analysis) return;
  const rect = s.to(p.x, p.y, dt);
  if (!rect) return;

  // Same frame as the gesture: geometry and the local operators.
  state.surface.updateRect(rect.r0, rect.c0, rect.r1, rect.c1);
  refreshSurfaceOverlays();
  const ls = localStats(state.dem, rect);
  if (Number.isFinite(ls.slopeMeanDeg)) {
    // Live, local readout while dragging; the worker overwrites it with the
    // whole-grid figure a frame later. Marked so the difference is not a lie.
    $("m-slope").textContent = `${ls.slopeMeanDeg.toFixed(2)}° ·loc`;
    $("m-tri").textContent = `${ls.triMean.toFixed(4)} m ·loc`;
  }
  updateLedger();

  // Non-local hydrology goes to the worker, coalesced.
  state.analysis.invalidate(rect);
}

/* --------------------------------------------------------------- plan mode */

/**
 * PLAN MODE. A latching state: the camera locks to top orthographic, the orbit
 * is disabled, and the brush palette is replaced by the polygon one.
 *
 * ⚠️ THE CAMERA LOCK IS PART OF THE TOOL, NOT A CONVENIENCE. A ring is traced
 * by raycasting the pointer onto the surface, so in any tilted view the spacing
 * between two clicks depends on the angle the ray met the ground at — a vertex
 * placed on a north-facing bank lands metres from where it looked like it
 * landed. Level ground hides this completely, which is what makes it dangerous.
 * Locked to plan, the ray is vertical everywhere and screen distance is ground
 * distance, so the drawing means what it looks like it means.
 */

/**
 * Grab radius in GROUND units for a given number of screen pixels.
 *
 * Derived from the orthographic frustum rather than fixed in metres, so the
 * handle you are reaching for is the same size on screen at every zoom. Plan
 * mode is always orthographic (view.setOrthographic refuses otherwise), so the
 * ortho camera is always the live one here. The zero-layout trap the fallback
 * arguments guard against is written up on groundPerPixel().
 * @param {number} [px]
 */
function planTolerance(px = 10) {
  const o = view.orthoCamera;
  return groundPerPixel(o.right - o.left, view.canvas.clientWidth,
    view.canvas.width, view.renderer.getPixelRatio()) * px;
}

/** Everything on screen that describes the regions. One entry point. */
function refreshPlan() {
  const p = state.plan;
  // ⚠️ REGIONS OUTLIVE THE MODE. A traced region is a design object, not a
  // drawing-mode artefact: it stays on screen and stays selectable once plan
  // mode is off, so a platform's depth can be judged in perspective — which is
  // the projection it is actually legible in — and re-levelled from the same
  // slider, without re-entering a mode whose only real job is tracing.
  const any = p.set.regions.length > 0;
  // Two containers since the Selection panel took the list (2026-08-13): the
  // region LIST lives with the selection tools, the LEVEL slider with the
  // modifiers. Same visibility rule for both — regions outlive the mode.
  $("plan-tools").hidden = !(p.on || any);
  $("plan-select").hidden = !(p.on || any);
  $("plan-empty").hidden = any;
  p.overlay?.setVisible(p.on || any);

  if (p.overlay) {
    p.overlay.setExaggeration(currentExaggeration());
    p.overlay.setRegions(p.set.regions, p.selected ? p.selected.id : null);
    p.overlay.setDraft(p.draft, null);
  }
  renderPlanList();
  refreshPlanLevel();
}

/**
 * Throw away the cached mask for the selection.
 *
 * Called whenever the RINGS move or the GROUND under them moves. Both matter:
 * the mask changes when a vertex is dragged, and the elevation range the slider
 * is bounded by changes when the terrain is levelled or reset beneath a ring
 * that has not moved at all.
 */
function planInvalidate() {
  state.plan.extent = null;
}

function renderPlanList() {
  const p = state.plan;
  const ul = $("plan-list");
  ul.innerHTML = "";
  for (const region of p.set.regions) {
    const li = document.createElement("li");
    li.classList.toggle("on", region === p.selected);
    const holes = region.rings.length - 1;
    // textContent rather than innerHTML: the name is the one string in this row
    // that is not generated here, and a region is one rename away from being
    // user-supplied text.
    const label = document.createElement("span");
    label.className = "grow";
    label.textContent = region.name + (holes ? ` · ${holes} hole${holes > 1 ? "s" : ""}` : "");
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = `${region.level_m.toFixed(2)} m`;
    li.append(label, val);
    li.addEventListener("click", () => selectRegion(region));
    li.classList.toggle("hidden-region", !!region.hidden);

    // ⚠️ HIDING DESELECTS, AND THAT IS A SAFETY PROPERTY RATHER THAN TIDINESS.
    // The level slider acts on the selection, and levelling moves hundreds of
    // cubic metres in one click. A region that is selected but not drawn is a
    // platform you can cut without seeing where — the ledger would move, the
    // terrain would change, and nothing on screen would say where it happened.
    const eye = document.createElement("button");
    eye.textContent = region.hidden ? "show" : "hide";
    eye.title = region.hidden
      ? "draw this region again"
      : "stop drawing this region — it stays in the set and still exports";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      region.hidden = !region.hidden;
      if (region.hidden && state.plan.selected === region) selectRegion(null);
      else refreshPlan();
      status(`${region.name} ${region.hidden ? "hidden" : "shown"}`, 1600);
    });
    li.appendChild(eye);

    if (holes) {
      const h = document.createElement("button");
      h.textContent = "−hole";
      h.title = "remove the last hole from this region";
      h.addEventListener("click", (e) => {
        e.stopPropagation();
        region.rings.pop();
        planInvalidate();
        refreshPlan();
        status(`hole removed from ${region.name}`);
      });
      li.appendChild(h);
    }

    // ⚠️ THIS IS HOW GEOMETRY ENTERS THE STACK, and it is the only way in for a
    // drawn or imported polygon. A region is not automatically a selection
    // layer: it is a design object with a datum, and most of them are platforms
    // rather than questions. Adding one FREEZES its cells here and now, which
    // for geometry is free — rasterise() reads rings and the georeference, never
    // z, so the layer cannot go stale however much the ground is cut.
    const plus = document.createElement("button");
    plus.textContent = "+ sel";
    plus.title = "add this region to the selection stack as a layer";
    plus.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!state.dem) return;
      const r = rasterise(state.dem, region.rings);
      if (!r.count) { status(`${region.name} covers no cells`, 3000); return; }
      saveSelection(r.mask, {
        name: region.name,
        source: region.imported ? "from file" : "drawn",
        live: false,
        sentence: `the polygon "${region.name}"`,
        recipe: { regionId: region.id },
      });
      refreshStackHighlight();
    });
    li.appendChild(plus);

    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "delete this region";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteRegion(region);
    });
    li.appendChild(x);
    ul.appendChild(li);
  }
  $("plan-empty").hidden = p.set.length > 0;
}

/** @param {import("./plan.js").Region|null} region */
function selectRegion(region) {
  state.plan.selected = region;
  planInvalidate();
  refreshPlan();
  // The stamp follows the selection, so its extent, thumbnail and cost line all
  // just changed. Hooked HERE rather than in refreshPlan(): that runs on every
  // vertex drag, and rebuilding a whole-grid pattern field per pointer move
  // would put a 65 536-cell generation inside a drag loop.
  refreshPattern();
  if (region) status(`${region.name} selected`);
}

/** @param {import("./plan.js").Region} region */
function deleteRegion(region) {
  state.plan.set.remove(region.id);
  if (state.plan.selected === region) state.plan.selected = null;
  planInvalidate();
  refreshPlan();
  refreshPattern();   // the stamp falls back to the whole patch
  // ⚠️ Deleting a region does NOT undo the earth it moved. The ledger records
  // what was done to the ground, and the ground is still levelled; removing the
  // polygon that specified it would silently un-account for a real earthwork.
  status(`${region.name} deleted — the levelling it did stands in the ledger`);
}

/** Mask and z-range for the selection, rasterised at most once per change. */
function planExtent() {
  const p = state.plan;
  if (!p.selected || !state.dem) return null;
  if (!p.extent) p.extent = regionExtent(state.dem, p.selected);
  return p.extent;
}

/**
 * The level slider, its metre scale, and the sentence under them.
 *
 * ⚠️ THE SLIDER IS BOUNDED BY maskZRange, NOT BY THE TILE'S RANGE. Every
 * position on it is therefore an elevation that exists somewhere inside the
 * ring — you cannot ask for a datum the region has never reached, which is what
 * stops a stray drag proposing a 5 m embankment on a 0.4 m site.
 */
function refreshPlanLevel() {
  const p = state.plan;
  const wrap = $("plan-level");
  const ext = planExtent();
  if (!p.selected || !ext || !ext.count) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const slider = /** @type {HTMLInputElement} */ ($("plan-z"));

  // A region already levelled flat has lo === hi, and a range input with
  // min === max cannot be moved at all. Opened out by half a metre either way
  // so it can be levelled a SECOND time — and the scale says so, rather than
  // quietly presenting the padding as if it were measured ground.
  const flat = ext.hi - ext.lo < 1e-6;
  const lo = flat ? ext.lo - 0.5 : ext.lo;
  const hi = flat ? ext.hi + 0.5 : ext.hi;
  slider.min = String(lo);
  slider.max = String(hi);
  slider.step = String(Math.max(0.001, (hi - lo) / 1000));
  const target = Math.min(hi, Math.max(lo, p.selected.level_m));
  slider.value = String(target);
  p.selected.level_m = target;

  // The metre scale. Five ticks, ends emphasised, maximum at the top.
  const scale = $("plan-scale");
  scale.innerHTML = "";
  const TICKS = 5;
  for (let i = 0; i < TICKS; i++) {
    const f = i / (TICKS - 1);            // 0 at the bottom
    const z = lo + f * (hi - lo);
    const b = document.createElement("b");
    b.style.top = `${(1 - f) * 100}%`;
    b.className = i === 0 || i === TICKS - 1 ? "end" : "";
    b.textContent = z.toFixed(2);
    scale.appendChild(b);
  }

  $("plan-z-val").textContent = `${target.toFixed(3)} m`;
  $("plan-z-mean").textContent = `${ext.mean.toFixed(3)} m`;
  $("plan-cells").textContent = `${ext.count.toLocaleString("en")}`;
  $("plan-area").textContent = `${regionArea(p.selected).toFixed(1)} m²`;
  $("plan-apply").textContent = `Level to ${target.toFixed(2)} m`;
  refreshPlanPreview();
}

/**
 * What the current datum would cost, in words, before anything moves.
 *
 * ⚠️ THIS SENTENCE IS THE POINT OF PLAN MODE. Levelling to a CHOSEN datum
 * imports or exports material and levelling to the region's own mean does not,
 * and the difference is not a rounding artefact — measured on a 32 × 32 m
 * platform at 78.0 m it is +346.8 m³, about seventeen lorry loads, against
 * −2.4e−11 m³ for the mean. A design tool that showed one number for both would
 * be hiding the thing earthworks are actually costed on.
 */
/**
 * The batter options the CURRENT UI describes, for both pricing and committing.
 *
 * ⚠️ ONE SOURCE, DELIBERATELY. The figure under the slider and the figure that
 * lands in the ledger have to be the same operation, and the surest way to keep
 * them so is for both to read their angles from here. Switching the batter off
 * returns 90°/90° rather than a flag the callers have to test: a vertical face
 * is a legitimate answer and the kernel already returns "nothing moved" for it,
 * so there is no no-batter branch anywhere for the two paths to disagree about.
 */
function batterOpts() {
  const b = state.plan.batter;
  return b.on
    ? { cutAngleDeg: b.cutDeg, fillAngleDeg: b.fillDeg }
    : { cutAngleDeg: 90, fillAngleDeg: 90 };
}

function refreshPlanPreview() {
  const p = state.plan;
  const ext = planExtent();
  const el = $("plan-preview");
  if (!p.selected || !ext || !ext.count || !state.dem) { el.textContent = ""; return; }
  const target = p.selected.level_m;
  const cost = levelCost(state.dem, ext.mask, target);
  const mean = levelCost(state.dem, ext.mask, ext.mean);
  const sign = cost.net > 0 ? "imported onto site" : cost.net < 0 ? "taken off site" : "moved";

  // ⚠️ PRICED THROUGH THE SAME FUNCTION THAT WILL DO THE WORK, dry. batterTo
  // never reads a cell inside the mask, so it costs the batter correctly even
  // though the platform has not been levelled yet — pinned in Group Y, because
  // an edit that reached into the platform would break this silently.
  const bat = batterTo(state.dem, ext.mask, target,
    { ...batterOpts(), dryRun: true });

  let edge;
  if (bat.cells === 0) {
    edge = state.plan.batter.on
      ? ` The batter grades to nothing here: at these angles the platform ` +
        `already daylights inside its own boundary, so the edge costs nothing.`
      : ` Its edge is left vertical, so nothing outside the ring moves — which ` +
        `is a decision about the boundary, not the absence of one.`;
  } else {
    const share = 100 * (bat.cut + bat.fill) / (cost.cut + cost.fill + bat.cut + bat.fill);
    edge =
      ` Grading its edge to meet existing ground adds <b>${bat.cut.toFixed(1)} m³</b> ` +
      `cut and <b>${bat.fill.toFixed(1)} m³</b> fill over <b>${bat.cells.toLocaleString("en")}</b> ` +
      `cells outside the ring, running up to <b>${bat.maxRunM.toFixed(1)} m</b> wide — ` +
      `<b>${share.toFixed(0)}%</b> of all the material this move touches. ` +
      `The width is not a setting: it is Δz ÷ tanθ, so it follows the ground.`;
  }

  el.innerHTML =
    `Levelling <b>${ext.count.toLocaleString("en")}</b> cells to ` +
    `<b>${target.toFixed(3)} m</b> would cut <b>${cost.cut.toFixed(1)} m³</b> and fill ` +
    `<b>${cost.fill.toFixed(1)} m³</b> — net <b>${cost.net >= 0 ? "+" : "−"}` +
    `${Math.abs(cost.net).toFixed(1)} m³</b> ${sign}.` + edge + ` ` +
    `Levelling to the region's own mean (<b>${ext.mean.toFixed(3)} m</b>) moves ` +
    `<b>${mean.cut.toFixed(1)} m³</b> each way and is volume-neutral — the ` +
    `PLATFORM is, at least; a batter carries its own net and is not covered by ` +
    `that claim. A chosen datum is not either, and that is not a defect in the ` +
    `arithmetic — it is what a platform costs.`;
}

/**
 * Commit the levelling.
 * @param {number} target
 * @param {string} how  for the status line
 */
function applyPlanLevel(target, how) {
  const p = state.plan;
  const ext = planExtent();
  if (!p.selected || !ext || !ext.count || !state.dem || !state.surface) return;

  beginEdit();
  // ⚠️ levelWithBatter ACCUMULATES into the Ledger — Ledger has no add(), it has
  // `cut` and `fill` fields and derived `net`/`banked` getters. One more
  // earthwork on the same site, never a replacement for what was moved before
  // it. The batter is charged to the same account as the platform: a graded
  // edge is earthwork, and billing only the platform would understate every
  // cut this tool makes on sloping ground.
  const res = levelWithBatter(state.dem, ext.mask, target,
    { ...batterOpts(), ledger: state.ledger }, ext);
  p.selected.level_m = target;

  // ⚠️ EVERY RECT BELOW IS THE OPERATION'S, NOT THE REGION'S. A batter grades
  // ground OUTSIDE the ring — that is the entire feature — so `ext` is the
  // wrong rectangle for all four of these now. Undo bounded by the region would
  // restore the platform and leave the batter standing; a repaint bounded by it
  // would compute the batter into the DEM and then never draw or analyse it.
  // Both read as the batter not working rather than as a stale rectangle, which
  // is why levelWithBatter reports the union and nothing here recomputes it.
  // ⚠️ It cannot be recovered afterwards either: run against the graded ground,
  // batterTo daylights immediately and reports a rect close to empty.
  commitEdit(`${p.selected.name} levelled`, res);

  state.surface.updateRect(res.r0, res.c0, res.r1, res.c1);
  refreshSurfaceOverlays(true);
  if (state.water.on) refreshWater();
  updateLedger();
  state.analysis?.invalidate(res);
  state.analysis?.settle();

  // The ground under the ring has changed, so the range the slider is bounded
  // by has too — it is now a single elevation.
  planInvalidate();
  refreshPlan();
  const edge = res.batter.cells
    ? ` · batter ${(res.batter.cut + res.batter.fill).toFixed(1)} m³ over ` +
      `${res.batter.cells.toLocaleString("en")} cells, to ${res.batter.maxRunM.toFixed(1)} m`
    : "";
  status(`${p.selected.name} levelled to ${target.toFixed(3)} m ${how} · ` +
    `net ${res.net >= 0 ? "+" : "−"}${Math.abs(res.net).toFixed(1)} m³${edge}`, 4000);
}

/* ------------------------------------------------------- plan mode: drawing */

/** Set to true between a claimed pointerdown and its pointerup. */
let planGesture = false;

/** @param {PointerEvent} e */
function planPointerDown(e) {
  // Anything but a plain left click belongs to the camera — which, locked, can
  // still pan and zoom. Same "not left" test as the brush, for the same reason.
  if (e.button !== 0 || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return false;
  if (!state.dem || !state.surface) return false;
  const hit = pickWorld(e);
  if (!hit) return false;

  // try/catch as view.js does for its own capture: a synthetic pointer has no
  // id the browser will accept, and a throw here would abandon the gesture
  // half-claimed — the app would look frozen in whichever tool was last used.
  try { /** @type {HTMLCanvasElement} */ (view.canvas).setPointerCapture(e.pointerId); }
  catch { /* synthetic pointer */ }
  planGesture = true;
  state.plan.drag = { x0: e.clientX, y0: e.clientY, moved: 0, vertex: null, at: hit };

  // In Select mode a press on a vertex begins dragging it. Grabbing is decided
  // on the DOWN and the move is applied live, so the vertex follows the hand
  // rather than jumping when it is let go.
  if (state.plan.tool === "edit") {
    const v = pickVertex(state.plan.set.regions, hit.x, hit.y, planTolerance());
    if (v) {
      state.plan.drag.vertex = v;
      if (v.region !== state.plan.selected) selectRegion(v.region);
    }
  }
  return true;
}

/** @param {PointerEvent} e */
function planPointerMove(e) {
  const p = state.plan;
  const hit = pickWorld(e);

  if (planGesture && p.drag) {
    p.drag.moved += Math.abs(e.clientX - p.drag.x0) + Math.abs(e.clientY - p.drag.y0);
    p.drag.x0 = e.clientX; p.drag.y0 = e.clientY;
    if (p.drag.vertex && hit) {
      const { region, ring, index } = p.drag.vertex;
      region.rings[ring][index] = [hit.x, hit.y];
      // The mask belongs to the ring's old shape; every drag frame invalidates
      // it. Rasterising per frame would be the obvious alternative and it is
      // the expensive one — the readouts are refreshed on pointer-up instead.
      planInvalidate();
      p.overlay?.setRegions(p.set.regions, region.id);
    }
    return;
  }

  // Not dragging: the rubber band from the last placed vertex to the cursor.
  if (p.draft.length && hit) p.overlay?.setDraft(p.draft, [hit.x, hit.y]);
}

/** @param {PointerEvent} e */
function planPointerUp(e) {
  // ⚠️ Guarded because this runs TWICE per gesture: once from pointerup and
  // once from lostpointercapture when the capture we took is released. The
  // brush path carries the same guard on its own `painting` flag.
  if (!planGesture) return;
  planGesture = false;
  const p = state.plan;
  const drag = p.drag;
  p.drag = null;
  if (!drag) return;

  if (drag.vertex) {
    // A vertex was grabbed. Whether it moved or not, the readouts describe a
    // ring that may now be a different shape.
    refreshPlan();
    return;
  }
  // A press that travelled is a pan the camera already handled, not a click.
  if (drag.moved >= 5) return;

  const hit = pickWorld(e) ?? drag.at;
  if (!hit) return;
  if (p.tool === "edit") { selectRegion(pickRegion(p.set.regions, hit.x, hit.y)); return; }
  if (p.tool === "section") { sectionPlacepoint(hit.x, hit.y); return; }
  if (p.tool === "guide") { guidePlaceVertex(hit.x, hit.y); return; }
  planPlaceVertex(hit.x, hit.y);
}

/**
 * Place a vertex, or close the ring if the click landed on the first one.
 * @param {number} x @param {number} y
 */
function planPlaceVertex(x, y) {
  const p = state.plan;
  const tol = planTolerance();
  if (p.draft.length >= 3) {
    const [fx, fy] = p.draft[0];
    if (Math.hypot(fx - x, fy - y) <= tol) { planCloseRing(); return; }
  }
  p.draft.push([x, y]);
  p.overlay?.setDraft(p.draft, null);
  status(p.draft.length < 3
    ? `${p.draft.length} vertex placed — three make a ring`
    : `${p.draft.length} vertices — click the first to close, or double-click`, 1400);
}

/**
 * Close the traced ring into a region, or into a hole in the selected one.
 *
 * @param {{dropLast?: boolean}} [opts] dropLast: a double-click has already
 *   placed a vertex on top of the previous one, so drop it before closing.
 */
function planCloseRing(opts = {}) {
  const p = state.plan;
  let ring = p.draft;
  if (opts.dropLast && ring.length >= 2) {
    const [ax, ay] = ring[ring.length - 1], [bx, by] = ring[ring.length - 2];
    if (Math.hypot(ax - bx, ay - by) <= planTolerance()) ring = ring.slice(0, -1);
  }
  if (!ringIsValid(ring)) {
    status("a ring needs three vertices that enclose some ground", 3000);
    return false;
  }

  if (p.tool === "hole") {
    if (!p.selected) { status("select a region first — a hole belongs to one", 3000); return false; }
    // The hole must be IN the region it is cut from. Even-odd would happily
    // rasterise a ring drawn elsewhere, and it would simply add that ground to
    // the platform — a hole that makes the region bigger.
    if (!pointInRings(p.selected.rings, ring[0][0], ring[0][1])) {
      status(`that ring is not inside ${p.selected.name}`, 3000);
      return false;
    }
    p.set.addHole(p.selected, ring);
    p.draft = [];
    planInvalidate();
    refreshPlan();
    status(`hole cut in ${p.selected.name} — the even-odd rule takes it out of the mask`);
    return true;
  }

  const region = p.set.add(ring);
  p.draft = [];
  p.selected = region;
  planInvalidate();
  // Open the slider at the region's OWN MEAN, which is the one datum that costs
  // nothing. A design starts from the ground it is on and departs from it
  // deliberately, rather than opening on an arbitrary height.
  const ext = planExtent();
  region.level_m = ext && ext.count ? ext.mean : 0;
  refreshPlan();
  status(ext && ext.count
    ? `${region.name} · ${ext.count.toLocaleString("en")} cells, mean ${ext.mean.toFixed(2)} m`
    : `${region.name} — too small to cover a cell centre`, 3000);
  return true;
}

// Double-click closes the ring. Claimed from the view so the camera does not
// recentre on the same gesture — see View.onDoubleClick.
view.onDoubleClick = () => {
  if (!state.plan.on || state.plan.tool === "edit") return false;
  if (state.plan.draft.length < 3) return false;
  planCloseRing({ dropLast: true });
  return true;
};

/* --------------------------------------------------------- plan mode: latch */

/** @param {boolean} on */
function setPlanMode(on) {
  const p = state.plan;
  if (p.on === on) return;
  p.on = on;
  p.draft = [];
  p.drag = null;
  planGesture = false;

  $("t-plan").classList.toggle("on", on);
  // ⚠️ BOTH PALETTES STAY ON THE MENU (2026-08-11). They used to swap with
  // the mode; now the mode follows the tool — a drawing tool locks the plan
  // camera, a brush releases it — so hiding either palette would hide the
  // very buttons that change mode. The `on` highlight says which hand is
  // armed; the regions panel still follows whether regions EXIST — see
  // refreshPlan().
  // No brush in plan mode, so hand shift+right-drag back to the camera.
  view.onBrushResize = on ? null : brushResize;
  // Same rule for the strength: plan mode has no brush to tune, and view.js
  // falls back to panning when the callback is null.
  view.onBrushStrength = on ? null : brushStrength;

  // The gizmo and the projection button are DISABLED rather than left to do
  // nothing when pressed — the same rule the coarse-tile layer buttons follow.
  // The gizmo stays live throughout — see syncPlanCamera for why.
  if (on) {
    p.camReturn = { state: view.getCameraState(), orthographic: view.orthographic };
    p.camFree = false;
    view.setOrbitLocked(true);
    // ⚠️ ENTERING PLAN MODE STARTS ON THE WHOLE SHEET. The lock alone keeps
    // the pan and zoom you happened to have, so the plan opened on whatever
    // corner the last orbit left — a drawing that begins half off its own
    // paper. Centring is an ENTRY move, not a property of the lock: pan and
    // zoom stay free inside the mode, and the middle-click return from a free
    // orbit deliberately does NOT recentre, because there the whole point is
    // to come back to the spot being judged.
    if (state.surface) view.planFrame(sheetBox());
    status("plan mode — top, orthographic, no orbit. Click to place vertices. " +
      "Middle-click to orbit while keeping the level slider.", 5000);
  } else {
    p.camFree = false;
    view.setOrbitLocked(false);
    if (p.camReturn) {
      view.setOrthographic(p.camReturn.orthographic);
      view.setCameraState(p.camReturn.state, 0.45);
      p.camReturn = null;
    }
    status("plan mode off — the regions stay, and so does the earth they moved");
  }
  syncProjButton();
  syncPlanCamera();
  refreshPlan();
}

/**
 * The patch plus its dimension frame — what "zoom to extent" means on a
 * sheet. The frame's outermost figures sit ≈0.11 of the span beyond each
 * edge (see dimensions.js); 0.13 buys them a margin of air.
 */
/**
 * Z — frame what is selected, or the whole site if nothing is.
 *
 * ⚠️ ONE PATH FOR BOTH KINDS OF SELECTION. A drawn region and a rule are
 * different objects in this tool — one is rings, the other a per-cell mask —
 * but they answer the same question, "which ground am I working on", so they
 * must frame identically. Rasterising the region turns it into the mask the
 * rule already is, and one loop then measures both. Anything else would give
 * a region and a rule covering the same ground two different framings.
 *
 * ⚠️ THE BOX IS BUILT IN SCENE SPACE, exaggeration included. The camera works
 * in the space the surface is DRAWN in, and the ground under a selection is
 * stretched by the same factor as everything else; measuring true elevations
 * here would frame a shape the viewport is not showing — tight at 1× and
 * badly cropped at 8×.
 *
 * ⚠️ AND IT KEEPS THE VIEWPOINT (see view.frameBox). Zooming to a selection is
 * a change of distance, not a change of angle.
 */
function zoomToSelection() {
  if (!state.dem || !state.surface) return;
  const dem = state.dem;
  const ex = currentExaggeration();

  // ⚠️ IT HAS TO ASK WHAT IS ACTUALLY SELECTED, NOT WHAT IS DRAWN ON SCREEN
  // (Marc, 2026-08-19: "sometimes when i use Z it rather zooms away than to the
  // object"). This predates the selection stack and only ever knew two sources:
  // a drawn region, or `ruleShown` — the on-terrain OUTLINE. So with a saved
  // stack in force, or a rule armed whose outline simply was not being shown,
  // there was no mask, and Z fell through to "the whole site" — which from a
  // close view is a zoom OUT. It was framing the site correctly and reading as
  // broken. The stack is consulted first now; `ruleShown` is the last resort it
  // always should have been.
  let mask = null, what = "";
  if (state.plan.selected) {
    mask = rasterise(dem, state.plan.selected.rings).mask;
    what = `region ${state.plan.selected.name}`;
  } else {
    const a = activeMask({});
    if (a && a.mask && a.count !== 0) {
      mask = a.mask;
      what = state.selection.activeCount > 0 ? "the selection stack" : "the selection";
    } else if (ruleShown) {
      mask = ruleShown;
      what = "the selection";
    }
  }

  let box = null;
  if (mask) {
    const { nrows, ncols, cell, originX, originY, z } = dem;
    const northY = nrows * cell;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let n = 0;
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        const i = r * ncols + c;
        if (!mask[i]) continue;
        const zz = z[i];
        if (!Number.isFinite(zz)) continue;      // no ground, nothing to frame
        const wx = originX + (c + 0.5) * cell;
        const wy = originY + northY - (r + 0.5) * cell;
        if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
        if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
        const sz = zz * ex;
        if (sz < z0) z0 = sz; if (sz > z1) z1 = sz;
        n++;
      }
    }
    // A selection of nothing is not a framing instruction; fall through to the
    // whole site rather than aiming the camera at an empty box.
    if (n > 0) {
      // A margin so the thing framed is not edge to edge, and a floor under it
      // so a one-cell selection does not ask for an infinitely close camera.
      const m = Math.max(cell * 4, Math.max(x1 - x0, y1 - y0) * 0.18);
      box = new THREE.Box3(
        new THREE.Vector3(x0 - m, y0 - m, z0 - cell),
        new THREE.Vector3(x1 + m, y1 + m, z1 + cell));
    }
  }

  if (!box) { box = sheetBox(); what = "the whole site"; }
  view.frameBox(box);
  status(`framed ${what}`, 2000);
}

function sheetBox() {
  const box = state.surface.boundingBox().clone();
  const s = new THREE.Vector3();
  box.getSize(s);
  const m = Math.max(s.x, s.y) * 0.13;
  box.min.x -= m; box.min.y -= m;
  box.max.x += m; box.max.y += m;
  return box;
}

/**
 * Plan mode has TWO camera states, and the difference is what the orbit lock is
 * actually for.
 *
 * ⚠️ THE LOCK PROTECTS TRACING, NOT EDITING. A ring traced across a perspective
 * view is a ring in a trapezoid — the vertex you clicked is not the point on the
 * ground you meant — so while a ring is being drawn the camera must stay top and
 * orthographic. But once the ring is closed, that reason is spent: choosing how
 * deep to cut is a judgement about a solid, and a solid is far easier to judge
 * from an oblique view than from directly above, where a 200 mm platform and a
 * 2 m one look identical.
 *
 * So middle-click hands the camera back WITHOUT leaving plan mode. The regions
 * stay, the selection stays, and the level slider stays live. What it refuses is
 * the draw tool: you cannot trace in perspective, which is the one thing the
 * lock existed to prevent.
 *
 * @param {boolean} free
 */
function setPlanCameraFree(free) {
  const p = state.plan;
  if (!p.on || p.camFree === free) return;

  // ⚠️ Refused mid-ring. A half-drawn ring belongs to the projection it was
  // started in; releasing the camera now would foreshorten the vertices still
  // to come and there would be no record that it happened.
  if (free && p.draft.length) {
    status("finish or cancel the ring first — a ring cannot span two projections", 3500);
    return;
  }

  p.camFree = free;
  if (free) {
    view.setOrbitLocked(false);
    view.setOrthographic(false);
    // ⚠️ TILT ON THE WAY OUT. Releasing the lock alone leaves the camera where
    // plan mode put it — straight down — and a top-down PERSPECTIVE view is the
    // worst of both: it converges, and it still shows no height. The whole point
    // of handing the camera back is to see the depth of the cut, so ease to a
    // working oblique and keep the yaw and target the user was already on.
    const c = view.getCameraState();
    view.setCameraState({ ...c, pitch: 0.55 }, 0.5);
    // Fall back to the select tool: draw is unavailable while the camera is
    // free, and a disabled tool left selected is a dead pointer.
    if (p.tool === "draw" || p.tool === "hole") p.tool = "edit";
    status("camera free — orbit and judge the level in perspective. " +
      "Middle-click again to return to plan and draw.", 5000);
  } else {
    view.setOrbitLocked(true);   // snaps back to top orthographic
    status("back to plan — top, orthographic. Draw is available again.", 3500);
  }
  syncProjButton();
  syncPlanCamera();
  refreshPlan();
}

/** Reflect the plan camera state in the controls that depend on it. */
function syncPlanCamera() {
  const p = state.plan;
  const free = !!(p.on && p.camFree);
  for (const b of document.querySelectorAll("button.ptool")) {
    const tool = /** @type {HTMLElement} */ (b).dataset.ptool || "draw";
    const blocked = free && (tool === "draw" || tool === "hole");
    /** @type {HTMLButtonElement} */ (b).disabled = blocked;
    b.classList.toggle("on", p.on && p.tool === tool);
  }
  // ⚠️ NOT DISABLED ANY MORE (2026-08-11). These used to go dead in plan mode
  // — correct while a Plan-mode button existed to press again, and a trap now
  // that the mode follows the tool: pressing one RELEASES the plan and serves
  // the request. See leavePlanForCamera().
  for (const b of document.querySelectorAll("#gizmo .grid button")) {
    /** @type {HTMLButtonElement} */ (b).disabled = false;
  }
  /** @type {HTMLButtonElement} */ ($("proj")).disabled = false;
}

/* -------------------------------------------------------- plan mode: export */

/**
 * The regions as a zipped shapefile bundle plus the GeoJSON.
 *
 * ⚠️ ALL FIVE FILES SHARE ONE BASENAME. A shapefile is not a file, it is a set
 * of files that find each other by name: rename the .shp alone and the
 * attributes and the projection are gone. Zipping them is not packaging
 * convenience, it is what keeps the set a set.
 */
/**
 * Bring polygons in from GIS as plan regions.
 *
 * ⚠️ ONE SHAPEFILE FEATURE BECOMES ONE REGION, RINGS AND ALL. A multi-part
 * polygon in a shapefile is an outer ring and its holes in a single record, and
 * that is exactly what a Region is — so the parts go into one region's `rings`
 * rather than becoming several regions. Split into separate features they would
 * be overlapping platforms and the hole would level as ground, which is a
 * plausible-looking result and the wrong one.
 *
 * ⚠️ NOTHING IS REPROJECTED. See shapefile-read.js. A file in another CRS is
 * imported as it stands and the status line says the polygons do not sit on the
 * terrain — because a boundary silently moved is worse than one visibly absent.
 * @param {FileList|File[]} files
 */
async function importPlanShapefile(files) {
  if (!state.dem) return;
  const list = [...files];
  const shp = list.find((f) => /\.shp$/i.test(f.name));
  if (!shp) {
    status("select the .shp file — a zipped shapefile has to be unzipped first", 6000);
    return;
  }
  const prj = list.find((f) => /\.prj$/i.test(f.name));
  let parsed;
  try {
    parsed = readShapefile(await shp.arrayBuffer());
  } catch (e) {
    status(`${shp.name}: ${e instanceof Error ? e.message : "unreadable"}`, 7000);
    return;
  }
  if (!parsed.rings.length) {
    status(`${shp.name} carries no polygons — ${parsed.skipped} record(s) skipped. `
      + "Point and line layers cannot be a plan.", 7000);
    return;
  }

  // ⚠️ REFUSE RINGS THE RASTERISER CANNOT USE rather than adding a region with
  // no cells: the level slider takes its bounds from the elevation range under
  // the ring, and an empty mask has no range to take.
  let added = 0, dropped = 0;
  for (const rings of parsed.rings) {
    const usable = rings.filter((r) => ringIsValid(r));
    if (!usable.length) { dropped++; continue; }
    const region = state.plan.set.add(usable[0], { name: `Imported ${added + 1}` });
    for (let i = 1; i < usable.length; i++) state.plan.set.addHole(region, usable[i]);
    // Display only, like `hidden` — it is not in PLAN_FIELDS and so never
    // reaches a shapefile, because "somebody imported this an hour ago" is a
    // fact about this session and not an attribute of the ground. It exists so
    // the selection stack can name a layer's source honestly.
    region.imported = true;
    added++;
  }

  const hit = overlapsTerrain(parsed.rings, state.dem);
  const epsg = prj ? prjEpsg(await prj.text()) : null;
  planInvalidate();
  if (added) selectRegion(state.plan.set.regions[state.plan.set.regions.length - 1]);
  refreshPlan();
  state.plan.overlay?.setRegions(state.plan.set.regions, state.plan.selected?.id ?? null);

  const bits = [`${added} region${added === 1 ? "" : "s"} imported from ${shp.name}`];
  if (dropped) bits.push(`${dropped} refused — fewer than three distinct vertices`);
  if (parsed.skipped) bits.push(`${parsed.skipped} non-polygon record(s) skipped`);
  if (hit.fraction < 0.5) {
    bits.push(`⚠️ only ${(100 * hit.fraction).toFixed(0)}% of their vertices land on this `
      + `terrain — ${epsg && epsg !== 25833 ? `the .prj says EPSG:${epsg}, the terrain is 25833`
        : "check the coordinate system"}. Nothing was reprojected.`);
  } else if (epsg && epsg !== 25833) {
    bits.push(`⚠️ the .prj says EPSG:${epsg}; nothing was reprojected`);
  }
  status(bits.join(" · "), 9000);
}

function exportPlan() {
  const regions = state.plan.set.regions;
  if (!regions.length) { status("no regions to export", 3000); return; }
  const features = toFeatures(regions);
  const { shp, shx, dbf, prj } = writeShapefile(features, { fields: PLAN_FIELDS });
  const geojson = writeGeoJSON(features);
  const stem = exportStem("regions");
  const enc = new TextEncoder();
  const zip = makeZip([
    { name: `${stem}.shp`, data: shp },
    { name: `${stem}.shx`, data: shx },
    { name: `${stem}.dbf`, data: dbf },
    { name: `${stem}.prj`, data: enc.encode(prj) },
    { name: `${stem}.geojson`, data: enc.encode(geojson) },
    { name: "README.txt", data: enc.encode(planReadme(regions)) },
  ]);
  download(new Blob([zip], { type: "application/zip" }), `${stem}.zip`);
  status(`${regions.length} region${regions.length > 1 ? "s" : ""} exported`);
}

/** @param {import("./plan.js").Region[]} regions */
function planReadme(regions) {
  const L = [];
  L.push("DL-TerrainDiversity — PLAN REGIONS");
  L.push("=".repeat(60));
  L.push("");
  L.push(`Terrain: ${state.dem?.name ?? "—"}`);
  L.push(`Regions: ${regions.length}`);
  L.push(`Written: ${new Date().toISOString().slice(0, 19).replace("T", " ")}`);
  L.push("");
  L.push("FILES");
  L.push("-".repeat(60));
  L.push("  .shp .shx .dbf .prj   one shapefile. All four are needed; the .prj");
  L.push("                        is EPSG:25833 and without it a reader guesses.");
  L.push("  .geojson              the same rings, for anything that prefers it.");
  L.push("");
  L.push("ATTRIBUTES");
  L.push("-".repeat(60));
  L.push("  id        stable within one session, never reused after a delete");
  L.push("  name      as shown in the sidebar");
  L.push("  level_m   THE DATUM THE REGION WAS TOLD TO REACH, in the DEM's own");
  L.push("            vertical datum. This is design intent, not a measurement:");
  L.push("            whether the ground got there is a question for the");
  L.push("            exported GeoTIFF, not for this table.");
  L.push("");
  L.push("WINDING");
  L.push("-".repeat(60));
  L.push("  The shapefile's outer rings are CLOCKWISE and its inner rings are");
  L.push("  not; the GeoJSON's outer rings are COUNTER-CLOCKWISE. That is the");
  L.push("  two formats disagreeing, not the two files disagreeing — they");
  L.push("  describe the same ground.");
  L.push("");
  L.push("REGIONS");
  L.push("-".repeat(60));
  for (const r of regions) {
    L.push(`  ${String(r.id).padStart(3)}  ${r.name}`);
    L.push(`       level ${r.level_m.toFixed(3)} m · ${regionArea(r).toFixed(1)} m²` +
      ` · ${r.rings.length - 1} hole(s)`);
  }
  L.push("");
  L.push("Terrain data © Kartverket (hoydedata.no), NLOD / CC BY 4.0.");
  L.push("DL-TerrainDiversity · Digital Landscapes · www.digital-landscapes.com");
  return L.join("\r\n") + "\r\n";
}

/* ------------------------------------------------------------------- wiring */

for (const b of document.querySelectorAll("button.tool")) {
  b.addEventListener("click", () => {
    // ⚠️ A BRUSH IN THE HAND LEAVES THE PLAN (2026-08-11). The mode follows
    // the tool now, not the other way round: picking a drawing tool locks the
    // plan camera, picking a brush releases it. There is no mode switch to
    // find first — that switch is what "plan mode felt hidden" was.
    if (state.plan.on) setPlanMode(false);
    state.tool = /** @type {HTMLElement} */ (b).dataset.tool || "scoop";
    for (const o of document.querySelectorAll("button.tool")) o.classList.toggle("on", o === b);
    $("datum").parentElement.hidden = state.tool !== "level";
    status(`${state.tool}`);
  });
}
$("t-scoop").classList.add("on");
$("datum").parentElement.hidden = true;

$("radius").addEventListener("input", () => {
  $("radius-val").textContent = `${parseFloat(/** @type {HTMLInputElement} */ ($("radius")).value).toFixed(1)} m`;
});

/**
 * Shift + right-drag sizes the brush, drag right to grow.
 *
 * The view hands over a delta already converted to GROUND UNITS, so the brush
 * edge follows the cursor at any zoom. Everything else — the slider's own
 * bounds, its step, and the label — is reused rather than reimplemented: the
 * gesture drives the same control the panel does, so the two can never disagree
 * about the radius, and dispatching "input" means the readout updates through
 * the handler that already exists.
 *
 * ⚠️ Assigned only while a brush exists. view.js falls back to panning when
 * this is null, so plan mode keeps shift+right-drag as a pan rather than
 * silently swallowing the gesture into a resize with nothing to resize.
 */
/**
 * Shift + LEFT drag: the brush strength.
 *
 * ⚠️ THE SLIDER IS THE SOURCE OF TRUTH, not a mirror of it — the gesture moves
 * the control and lets its own `input` handler do the rest, exactly as
 * brushResize does. Writing `state` directly would leave the slider showing one
 * depth while the brush cut another, which is the class of drift this project
 * keeps a single-source rule for.
 * @param {number} delta metres, from the drag
 */
function brushStrength(delta) {
  const el = /** @type {HTMLInputElement} */ ($("strength"));
  const min = parseFloat(el.min), max = parseFloat(el.max), step = parseFloat(el.step);
  const was = parseFloat(el.value);
  const next = Math.min(max, Math.max(min, Math.round((was + delta) / step) * step));
  if (next === was) return;
  el.value = String(next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  status(`brush strength ${next.toFixed(2)} m`, 900);
}

function brushResize(deltaGroundUnits) {
  const el = /** @type {HTMLInputElement} */ ($("radius"));
  const min = parseFloat(el.min), max = parseFloat(el.max), step = parseFloat(el.step);
  const was = parseFloat(el.value);
  const next = Math.min(max, Math.max(min, Math.round((was + deltaGroundUnits) / step) * step));
  if (next === was) return;
  el.value = String(next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  status(`brush radius ${next.toFixed(2)} m`, 900);
}
view.onBrushResize = brushResize;
view.onBrushStrength = brushStrength;
$("strength").addEventListener("input", () => {
  $("strength-val").textContent = `${parseFloat(/** @type {HTMLInputElement} */ ($("strength")).value).toFixed(2)} m`;
});

$("ex").addEventListener("input", () => {
  const v = currentExaggeration();
  $("ex-val").textContent = `${v.toFixed(1)}×`;
  if (!state.surface) return;
  state.surface.setExaggeration(v);
  // The scatter is stretched with the ground, so the relationship between what
  // stands on the terrain and the terrain itself survives the exaggeration.
  if (state.plants) state.plants.setExaggeration(v);
  // …and so do the regions: a design plate that stayed at true height while the
  // ground under it stretched would read as a cut that is not there.
  state.plan.overlay?.setExaggeration(v);
  // …and the water, or a pond would sit at true depth on stretched ground and
  // read as a puddle floating inside the terrain.
  state.water.field?.setExaggeration(v);
  // …and the section profiles, which are drawn on the terrain they cut.
  state.sections.overlay?.setExaggeration(v);
  // …and the dimension frame, whose sheet plane sits at the patch's low z.
  state.dims?.setExaggeration(v);
  // …and the photo pins, which must keep ONE height rather than growing into
  // masts — they rebuild themselves, see PhotoOverlay.setExaggeration.
  state.photos.overlay?.setExaggeration(v);
  // …and the selection outline, which is drawn ON the surface it describes.
  selOverlay?.setExaggeration(v);
  // …and the patchwork, ground-hugging lines that scale with the terrain.
  patchOverlay?.setExaggeration(v);
  // …and the pond pins, whose stems divide by it so a pin keeps one height.
  pondPins?.setExaggeration(v);
  // ⚠️ The symbols must be REBUILT, not merely re-scaled: their lift is divided
  // by the exaggeration so the discs stay a hair above the ground at every
  // setting, and that division is baked into the vertex buffer.
  if (symbolsOn) refreshSymbols();
});

/**
 * Draw the assemblage as objects in the scene.
 *
 * Off by default: the raster is the honest artefact and the scatter is the
 * legible one, and a tool that opens with a field of plants invites being read
 * as a prediction of what will grow. You turn it on.
 */
function setPlants(on) {
  if (on && plantsUnavailable()) { syncPlantNote(); return; }
  state.showPlants = on;
  $("t-plants").classList.toggle("on", on);
  if (state.plants) {
    state.plants.setVisible(on);
    // It may never have been populated — the assemblage arrives with the first
    // worker result, which normally precedes any click, but not always.
    if (on && state.assemblage && state.assemblage.codes) {
      state.plants.setCodes(state.assemblage.codes);
    }
  }
  syncPlantNote();
  status(on ? "vegetation shown — markers, not individuals" : "vegetation hidden");
}

/**
 * Say plainly what the scatter is, and when it is too small to see.
 *
 * ⚠️ The plants are drawn at TRUE SIZE, so on the 4 m context tile a 0.34 m
 * tussock is sub-pixel and the layer looks empty. That is not a defect to be
 * scaled away — it is this project's central finding standing in the viewport:
 * the scale at which terrain generates habitat is below the scale at which
 * national terrain data describes it. The note says so rather than letting it
 * read as a broken layer.
 */
function syncPlantNote() {
  const p = state.plants;
  const el = $("plants-note");
  const btn = /** @type {HTMLButtonElement} */ ($("t-plants"));
  const coarse = plantsUnavailable();

  // ⚠️ THE LAYER TURNS ITSELF OFF ABOVE THE DESIGN SCALE, and says why. On the
  // 4 m tile the tallest plant is 0.09% of the span — about one pixel — and the
  // candidate cap puts markers 35 m apart, so the scatter is both invisible and
  // too sparse to mean anything. That is this project's central finding, not a
  // rendering shortfall, so the tool states it rather than drawing 60 000
  // instances nobody can see.
  btn.disabled = coarse;
  btn.classList.toggle("off", coarse);
  if (coarse) {
    el.textContent = `Vegetation is a design-scale layer. At ${state.dem.cell} m a `
      + `plant is under a pixel and markers would stand 35 m apart — the relief `
      + `that generates habitat is below what this tile can describe. Switch to `
      + `the design patch to use it.`;
    return;
  }
  if (!p || !state.showPlants) { el.textContent = ""; return; }
  // ⚠️ SAYS WHAT THE DRAWING IS, AND WHAT IT IS NOT. The stems are the standing
  // structure the assemblage implies — stature and cover, in true metres — and
  // not a measured biomass. The model knows which species suits a cell and how
  // well; it knows nothing about kilograms, and a readout that said "biomass"
  // without qualification would be the same overclaim as calling the species
  // layer a prediction.
  const st = Array.from(p.drawn);
  el.textContent = `${p.total.toLocaleString()} stems — `
    + `${st[0].toLocaleString()} ground, ${st[1].toLocaleString()} herb, `
    + `${st[2].toLocaleString()} tall herb, ${st[3].toLocaleString()} shrub. `
    + `Height is the stature the assemblage supports, in true metres; stem count `
    + `is cover. Structure implied by the model, not a measured biomass. Stems are `
    + `fixed to their cells, so one can appear or vanish but never move.`
    + (state.plantPalette === "species"
      ? ` Coloured by species, in the species panel's own palette — so the stems `
        + `and the map of them say the same thing. The printed poster is black `
        + `and white; this is a screen reading.`
      : ``);
}

/** True when the current tile is too coarse for the scatter to say anything. */
function plantsUnavailable() {
  return !!state.dem && state.dem.cell > MAX_CELL_M;
}

$("t-plants").addEventListener("click", () => setPlants(!state.showPlants));

/* ------------------------------------------------- the two-scale context */

/**
 * Show the 4 m national tile the design patch sits inside.
 *
 * ⚠️ THE CONTEXT TILE IS A BACKDROP AND NOTHING ELSE. It is not adopted as
 * `state.dem`, carries no analysis, and cannot be edited — swapping the active
 * DEM would throw away the ledger and every settled grid. What it provides is
 * the one thing a single tile cannot: the SCALE RELATION. The patch is 16×16
 * context cells, 1/256 of the tile's area, and seeing that is finding 1.
 *
 * Loaded lazily, because most sessions never ask for it and it is a second
 * 256² GeoTIFF fetch.
 */
async function setContext(on) {
  const btn = /** @type {HTMLButtonElement} */ ($("t-context"));
  const note = $("context-note");
  if (!on) {
    state.dive?.setVisible(false);
    btn.classList.remove("on");
    note.textContent = "";
    return;
  }
  if (!state.dem) return;
  btn.classList.add("on");
  if (!state.dive) {
    note.textContent = "loading the 4 m tile…";
    try {
      const raw = await loadGeoTIFFFromURL(`/data/${contextTileFor(state.tileName)}`);
      const ctx = DEM.fromRaw(raw);
      state.dive = new Dive(view, ctx, { verticalExaggeration: currentExaggeration() });
      state.dive.markNest(state.dem);
    } catch (e) {
      note.textContent = "could not load the context tile";
      btn.classList.remove("on");
      return;
    }
  }
  state.dive.setVisible(true);
  describeNest(nestCells(state.dive.dem, state.dem));
}

/**
 * State the relation between the two tiles, as MEASURED rather than remembered.
 *
 * ⚠️ NOTHING HERE MAY SAY "4 m" OR "national". It did, and that was safe only
 * while the context was the one tile compiled into the app. A dropped context
 * can be any cell size from anywhere, and a sentence that names Kartverket's
 * resolution over someone else's tile is a caption that lies quietly.
 * @param {ReturnType<typeof nestCells>} n
 */
function describeNest(n) {
  const note = $("context-note");
  const ctx = state.dive?.dem;
  if (!ctx || !state.dem) { note.textContent = ""; return; }
  const cs = `${ctx.cell} m`;
  note.textContent = n.aligned && n.contained
    ? `This site is ${n.cols}×${n.rows} cells of the ${cs} tile — `
      + `1/${Math.round((ctx.ncols * ctx.nrows) / (n.cols * n.rows))} `
      + `of its area, at ${n.ratio}× the resolution.`
    : n.contained
      ? `Off the ${cs} grid by ${n.alignmentError.toFixed(3)} of a cell — `
        + `outline not drawn, and the context is left whole rather than cut, `
        + `because an opening half a cell out looks entirely deliberate.`
      : `This site lies outside the ${cs} context tile.`;
}

$("t-context").addEventListener("click", () => {
  setContext(!(state.dive && state.dive.visible)).catch(fail);
});

/** The solid-export chooser only means anything for blocks; it says why. */
function syncSolidNote() {
  const voxel = state.representation === "voxel";
  $("ex-solid-field").hidden = !voxel;
  if (!voxel) return;
  const mode = /** @type {HTMLSelectElement} */ ($("ex-solid")).value;
  const el = $("ex-solid-note");
  if (mode === "boxes") {
    el.innerHTML = "Every block as its own closed box, overlapping where they "
      + "meet — what a viewer wants and what a <b>slicer cannot use</b>: the "
      + "shared faces are walls buried inside the model.";
    return;
  }
  if (mode === "solid") {
    el.innerHTML = "The <b>boundary of the union</b> of the blocks: interior "
      + "faces never written, vertices welded, a floor at the base plate. One "
      + "closed shell, sliceable without repair. No boolean is involved — the "
      + "blocks are axis-aligned columns on a grid, so the union is exact.";
    return;
  }
  const g = state.dem && state.surface && state.representation === "voxel"
    ? solidGroups(/** @type {any} */ (state.surface).blockCells) : null;
  el.innerHTML = g
    ? `One closed solid per class of <b>${g.layerLabel}</b>, each an island of `
      + `blocks welded into its own shell. Solids that meet share their seam "
      + "vertices exactly, so the set lays back together.`
    : "⚠️ The layer on show has no classes to group by. Species, landform, "
      + "watershed and substrate do; slope, wetness and the rest are gradients, "
      + "and cutting them into solids would mean inventing boundaries the "
      + "ground does not have. Falls back to one solid.";
}

$("ex-solid").addEventListener("change", syncSolidNote);

$("plants-colour").addEventListener("change", (e) => {
  const on = /** @type {HTMLInputElement} */ (e.target).checked;
  state.plantPalette = on ? "species" : "mono";
  state.plants?.setPalette(state.plantPalette);
  syncPlantNote();
  status(on
    ? "stems coloured by species — the species panel's own palette"
    : "stems in one ink", 2200);
});

function syncBlockLabel() {
  const rep = state.surface;
  if (!rep || state.representation !== "voxel") return;
  // Report the level count too: it is what actually governs how the terracing
  // reads, and it stops tracking block width once the clamp engages.
  $("block-val").textContent =
    `${rep.blockWidth.toFixed(2)} m · ${rep.levels} levels${rep.isCubic ? "" : " · clamped"}`;
}

/**
 * The two View sub-panels follow the representation, so choosing one SHOWS its
 * settings (Marc, 2026-08-17).
 *
 * ⚠️ THEY ARE TABS, NOT TWO INDEPENDENT FOLDS. Only one representation is ever
 * live, so only one of these folds can contain anything actionable — leaving
 * both open put the block size and the contour interval in one column with
 * nothing saying which of them the ground was currently being drawn by, and
 * leaving both closed meant choosing Voxels visibly changed nothing in the
 * panel that owns voxels. Opening the chosen one and closing the other makes
 * the pair read as what they are.
 *
 * ⚠️ IT DOES NOT FIGHT A DELIBERATE FOLD. This runs on the representation
 * CHANGING, not on every refresh, so a designer who folds the open one away to
 * save room keeps it folded until they switch representation again.
 * @param {string} rep
 */
function syncViewSubs(rep) {
  const surface = /** @type {HTMLDetailsElement} */ ($("sec-view-surface"));
  const voxels = /** @type {HTMLDetailsElement} */ ($("sec-view-voxels"));
  if (surface) surface.open = rep !== "voxel";
  if (voxels) voxels.open = rep === "voxel";
}

for (const b of document.querySelectorAll("button.rep")) {
  b.addEventListener("click", () => {
    const rep = /** @type {HTMLElement} */ (b).dataset.rep || "mesh";
    if (rep === state.representation) return;
    state.representation = rep;
    for (const o of document.querySelectorAll("button.rep")) o.classList.toggle("on", o === b);
    buildRepresentation();
    $("block-field").hidden = rep !== "voxel";
    syncViewSubs(rep);
    // The size-by control belongs to the voxel field, and a fresh field carries
    // no scale until it is told — buildRepresentation makes a new one.
    refreshVoxelScale();
    if (rep === "voxel" && state.surface) {
      /** @type {HTMLInputElement} */ ($("block")).value = String(state.surface.blockCells);
      syncBlockLabel();
      status(`voxels — ${state.surface.blockWidth.toFixed(2)} m blocks`);
    } else {
      status("smooth surface");
    }
    // Switching between blocks and the smooth surface changes what the water is
    // standing on, in both directions — see the block slider's handler.
    if (state.water.on) refreshWater();
    syncSolidNote();
  });
}

/**
 * Single entry point for choosing the shading layer. The analysis grid is the
 * ONLY selector now — the dropdown that listed the same sixteen names again is
 * gone, and with it the one control that could disagree with the grid's
 * highlight (it did: the markup's default option was "elevation" against a
 * boot state of "cutfill", and nothing reconciled them until the first click).
 */
function setShading(key) {
  state.shading = key;
  for (const k of [...LIVE_PANELS, ...HEAVY_PANELS]) {
    $(`p-${k}`).classList.toggle("active", k === key);
  }
  // The hillshade tile is the picture of "none": highlight it when the 3D view
  // is showing plain white, so the grid always shows what you are looking at.
  $(`p-${FORM_PANEL}`).classList.toggle("active", key === "none");
  applyShading();
  refreshShadingLegend();
  status(key === "relief" ? "relief shading"
    : key === "none" ? "no shading — plain white" : `shading: ${key}`);
}

/** Day-of-year → "1 Apr", for the solar period label. */
function dayLabel(doy) {
  const d = new Date(Date.UTC(2026, 0, 1));
  d.setUTCDate(doy);
  return `${d.getUTCDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]}`;
}

$("solar-period").addEventListener("change", (e) => {
  const period = /** @type {HTMLSelectElement} */ (e.target).value.split(",").map(Number);
  $("solar-val").textContent = period[0] === period[1]
    ? dayLabel(period[0])
    : `${dayLabel(period[0])} – ${dayLabel(period[1])}`;
  // The layer's own stretch belongs to the OLD period's value range; a
  // midwinter total is a different quantity from a growing-season one.
  delete state.stretch.solar;
  $("p-solar").classList.add("settling");
  state.analysis?.setSolarPeriod(period);
  status(`solar: ${$("solar-val").textContent} — recomputing…`, 0);
});

/**
 * ⚠️ THE MAP IS THE SWITCH; THE KEY IS NOT (2026-08-11). The legend is a CHILD
 * of the panel, so every click inside it bubbled to the panel's toggle —
 * dragging a stretch handle therefore also switched the layer off, dropping
 * the terrain to plain relief at exactly the moment you were trying to judge
 * the stretch you were dragging. Reported as the shading "disappearing" while
 * adjusting the triangles, and that is precisely what happened.
 *
 * ⚠️ AND stopPropagation ON pointerdown DID NOT COVER IT, which is why the
 * handles looked guarded and were not: `click` is a separate event synthesised
 * after pointerup, so stopping the pointer sequence leaves the click to bubble
 * untouched. Filtering by origin here catches the handles, the palette caret
 * and anything added to a legend later, in one place.
 * @param {string} id @param {() => void} pick
 */
function panelToggle(id, pick) {
  $(id).addEventListener("click", (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest(".legend")) return;
    pick();
  });
}

// Click a panel to paint that layer on the terrain; click it again to go back
// to plain relief. The map you are looking at becomes the control for it.
for (const k of [...LIVE_PANELS, ...HEAVY_PANELS]) {
  panelToggle(`p-${k}`, () => setShading(state.shading === k ? "relief" : k));
}
// Clicking hillshade selects "none" — plain white, form with nothing
// interpreting it. Clicking it again returns to relief, matching every other
// tile's toggle-off behaviour.
panelToggle(`p-${FORM_PANEL}`, () => setShading(state.shading === "none" ? "relief" : "none"));

/* ------------------------------------------- browsing the layers, live */

/**
 * The layers in the order the grid SHOWS them.
 *
 * ⚠️ READ FROM THE GRID, NOT FROM `LIVE_PANELS` + `HEAVY_PANELS`. Those two
 * arrays are about WHEN a layer is computed — live on the gesture, or only on a
 * settle — and concatenating them gives an order the reader has never seen:
 * the markup interleaves the heavy ones among the live ones. Browsing has to
 * step in the order the eye already knows, so the grid is the source, and
 * reordering the markup reorders the browse with no second edit.
 */
function layerOrder() {
  return [...document.querySelectorAll("#panels .raster")]
    .map((el) => el.id.replace(/^p-/, ""));
}

/**
 * The next layer in that order, wrapping. Pure, so it can be checked.
 *
 * ⚠️ `relief` IS NOT IN THE GRID and that is deliberate — it is the state you
 * get by switching a layer OFF, not a layer you can choose. Browsing from it
 * therefore has no current position, and enters at whichever end you are
 * travelling towards rather than jumping to the middle.
 * @param {string[]} order @param {string} current @param {number} dir −1 or +1
 */
function stepLayer(order, current, dir) {
  if (!order.length) return null;
  // The hillshade TILE is the picture of "none"; the state and the tile are
  // spelled differently and this is the one place that has to know it.
  const cur = current === "none" ? FORM_PANEL : current;
  const i = order.indexOf(cur);
  if (i < 0) return dir > 0 ? order[0] : order[order.length - 1];
  return order[(i + dir + order.length) % order.length];
}

/** Step the shading, and say what landed. */
function browseLayer(dir) {
  const order = layerOrder();
  const next = stepLayer(order, state.shading, dir);
  if (!next) return;
  setShading(next === FORM_PANEL ? "none" : next);
}

/**
 * ⚠️ ACCUMULATED AND CLAMPED, NOT ONE STEP PER EVENT (Marc, 2026-08-20). Two
 * devices, two opposite failures, and the first version had both:
 *
 *   - a TRACKPAD sends a continuous stream of small deltas, so stepping once
 *     per event flies through all seventeen layers before the fingers have
 *     moved a centimetre. Hence the accumulator.
 *   - a NOTCHED WHEEL sends one event of 100–120 deltaY, so a threshold tuned
 *     to the trackpad turns ONE physical click into three layers. Measured:
 *     a single deltaY-120 event stepped elevation → slope → aspect → twi.
 *
 * So the threshold is a real notch, AND one event may contribute at most one
 * notch — a single click of the wheel can never move more than one layer,
 * whatever the device reports.
 *
 * ⚠️ AND deltaMode IS NOT ALWAYS PIXELS. Firefox and some Windows drivers
 * report LINES (1) or PAGES (2), where a notch is `3` rather than `120`; left
 * unnormalised the gesture would need thirty clicks to move one layer.
 */
let wheelAcc = 0;
const WHEEL_NOTCH = 100;
/** deltaY in pixels, whatever unit the device reported it in. */
function wheelPixels(e) {
  // ⚠️ 40, NOT 33. A line-mode notch is 3 lines; at 33 that is 99 against a
  // threshold of 100 and the gesture did nothing at all. 40 makes three lines
  // 120 — the same as one pixel-mode notch, which is what it is.
  if (e.deltaMode === 1) return e.deltaY * 40;      // lines
  if (e.deltaMode === 2) return e.deltaY * 400;     // pages
  return e.deltaY;
}

// ⚠️ CLAIMED THROUGH view.onWheel, so the camera does not also zoom. The hook
// is checked before the dolly and after preventDefault, so the browser's own
// Ctrl+wheel page zoom stays suppressed over the canvas exactly as before.
view.onWheel = (e) => {
  if (!e.ctrlKey) { wheelAcc = 0; return false; }
  const dy = wheelPixels(e);
  wheelAcc += Math.max(-WHEEL_NOTCH, Math.min(WHEEL_NOTCH, dy));
  while (Math.abs(wheelAcc) >= WHEEL_NOTCH) {
    const dir = wheelAcc > 0 ? 1 : -1;
    browseLayer(dir);
    wheelAcc -= WHEEL_NOTCH * dir;
  }
  return true;                      // handled: no zoom
};

$("block").addEventListener("input", () => {
  if (state.representation !== "voxel") return;
  state.blockCells = parseInt(/** @type {HTMLInputElement} */ ($("block")).value, 10);
  buildRepresentation(); // a different block count is a different mesh
  refreshVoxelScale();   // …and a new field, which does not carry the old scale
  syncBlockLabel();
  // ⚠️ AND THE WATER, WHICH buildRepresentation DOES NOT TOUCH. The ponds are a
  // separate field standing on the terrain, so a block size that changed the
  // ground underneath them without rebuilding them left the water at the old
  // resolution — the very mismatch the block-aware path exists to remove.
  if (state.water.on) refreshWater();
  syncSolidNote();   // the grouped note quotes the block size
});

/* ------------------------------------------- a layer read as SIZE, on blocks */

/**
 * The layer the voxel field is sized by, or "" for solid ground.
 *
 * ⚠️ CONTINUOUS LAYERS ONLY, and the dropdown is where that is enforced.
 * `RULE_LAYERS` carries the categorical ones too — landform class, substrate —
 * and scaling a block by a class CODE would put a hollow above a shoulder
 * because 6 is more than 4, ordering categories that have no order. It is the
 * same mistake the attribute rule refuses by matching membership rather than a
 * range, and the same reason the legend draws a key instead of a ramp.
 */
function refreshVoxSizeOptions() {
  const sel = /** @type {HTMLSelectElement} */ ($("vox-size"));
  if (sel.options.length > 1) return;
  for (const [k, m] of Object.entries(RULE_LAYERS)) {
    if (m.categorical) continue;
    sel.add(new Option(m.label, k));
  }
}

/**
 * Size the blocks by an analysis layer.
 *
 * ⚠️ THE RAMP'S OWN STRETCHED DOMAIN, exactly as `refreshSymbols` uses — the
 * worker percentile-stretches 2–98 % per layer because TRI and TWI are
 * scale-dependent and no fixed domain serves both scales. Normalising here
 * against the raw min and max instead would size a block differently from the
 * colour painted on it, and one of the two would be wrong about the same
 * ground.
 */
async function refreshVoxelScale() {
  const isVox = state.representation === "voxel";
  const rep = /** @type {any} */ (state.surface);
  $("vox-size-field").hidden = !isVox;
  $("vox-min-field").hidden = !isVox || !$("vox-size").value;
  const note = $("vox-size-note");
  if (!isVox || !rep || !rep.setScaleField) { note.hidden = true; return; }
  refreshVoxSizeOptions();

  const key = /** @type {HTMLSelectElement} */ ($("vox-size")).value;
  const minF = parseInt(/** @type {HTMLInputElement} */ ($("vox-min")).value, 10) / 100;
  $("vox-min-val").textContent = `${Math.round(minF * 100)}%`;
  if (!key) {
    rep.setScaleField(null);
    note.hidden = true;
    return;
  }
  const grids = await ensureRuleGrids();
  const grid = grids[key];
  const meta = RULE_LAYERS[key];
  if (!grid) {
    rep.setScaleField(null);
    note.hidden = false;
    note.textContent = `${meta?.label || key} has not been computed yet — `
      + `move some earth or wait for the analysis to settle.`;
    return;
  }
  const dom = (state.domains && state.domains[key]) || RAMPS[key]?.domain || null;
  let lo = dom ? dom[0] : NaN, hi = dom ? dom[1] : NaN;
  if (!(hi > lo)) {
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  const span = hi - lo;
  const norm = new Float32Array(grid.length);
  let defined = 0;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (!Number.isFinite(v)) { norm[i] = NaN; continue; }
    const t = span > 0 ? (v - lo) / span : 0.5;
    norm[i] = t < 0 ? 0 : t > 1 ? 1 : t;
    defined++;
  }
  rep.setScaleField(norm, { minFraction: minF });

  // ⚠️ THE NOTE NAMES BOTH CHANNELS. A block can carry one layer as tone and
  // another as bulk at once, which is the whole reason for having size as well
  // as colour — and it is precisely the state in which a reader attributes the
  // wrong number to the wrong thing unless the panel says which is which.
  const dp = meta?.dp ?? 2, unit = meta?.unit ?? "";
  const tone = state.shading === "none" ? null
    : (RULE_LAYERS[state.shading]?.label || state.shading);
  const pct = grid.length ? (100 * defined / grid.length) : 0;
  note.hidden = false;
  // Both names come from RULE_LAYERS, an internal table — no user text reaches
  // this markup, which is why it may be innerHTML at all.
  note.innerHTML = `Block size is <b>${meta?.label || key}</b>, `
    + `${(+lo).toFixed(dp)}${unit} to ${(+hi).toFixed(dp)}${unit} across `
    + `${Math.round(minF * 100)}–100% of a full block`
    + (tone ? `, and block colour is <b>${tone}</b> — two layers, two channels.`
      : `. Colour is off, so size is the only reading.`)
    + (pct < 99.5
      ? ` ⚠️ ${(100 - pct).toFixed(1)}% of cells have no answer for this layer `
        + `and carry no block at all — an absence, not a low value.`
      : "");
  if (rep.cubeCount !== undefined) syncBlockLabel();
}

$("vox-size").addEventListener("change", () => {
  refreshVoxelScale();
  const k = /** @type {HTMLSelectElement} */ ($("vox-size")).value;
  status(k ? `blocks sized by ${RULE_LAYERS[k]?.label || k}`
    : "blocks back to solid ground", 3000);
});
$("vox-min").addEventListener("input", () => refreshVoxelScale());

$("undo-all").addEventListener("click", () => {
  if (!state.dem || !state.baseZ || !state.surface || !state.analysis) return;
  // ⚠️ A RESET IS ITSELF UNDOABLE, and it is the single most valuable thing on
  // the stack: hitting it by accident used to cost the entire session, with no
  // way back at all. Recorded over the whole grid, because that is genuinely
  // what it changes.
  beginEdit();
  commitEdit("terrain reset",
    { r0: 0, c0: 0, r1: state.dem.nrows - 1, c1: state.dem.ncols - 1 });
  state.dem.z.set(state.baseZ);
  state.ledger.reset();
  state.surface.updateAll();
  refreshSurfaceOverlays(true);
  if (state.water.on) refreshWater();
  state.analysis.reset();
  updateLedger();
  // The rings survive a terrain reset — they are a drawing, and the ground they
  // were drawn on has simply gone back to how it was. Their masks have not: the
  // elevation range under every one of them just changed.
  planInvalidate();
  refreshPlan();
  status("terrain reset");
});

/* --------------------------------------------------------- plan mode wiring */

$("t-plan").addEventListener("click", () => setPlanMode(!state.plan.on));

/** @param {boolean} hidden */
function setAllRegionsHidden(hidden) {
  const rs = state.plan.set.regions;
  if (!rs.length) { status("no regions"); return; }
  for (const r of rs) r.hidden = hidden;
  // Same rule as the per-region control: nothing stays selected that is not on
  // screen, because the level slider would still act on it.
  if (hidden && state.plan.selected) selectRegion(null);
  else refreshPlan();
  status(hidden
    ? `${rs.length} region${rs.length > 1 ? "s" : ""} hidden — still in the set, still exported`
    : `${rs.length} region${rs.length > 1 ? "s" : ""} shown`, 2400);
}
$("plan-hide-all").addEventListener("click", () => setAllRegionsHidden(true));
$("plan-show-all").addEventListener("click", () => setAllRegionsHidden(false));

// Middle-click hands the camera back and takes it again, without leaving plan
// mode. Outside plan mode it is left alone — middle-DRAG still orbits there,
// and a click that did something different depending on mode would be worse
// than one that does nothing.
view.onMiddleClick = () => {
  if (!state.plan.on) return;
  setPlanCameraFree(!state.plan.camFree);
};

for (const b of document.querySelectorAll("button.ptool")) {
  b.addEventListener("click", () => {
    const tool = /** @type {HTMLElement} */ (b).dataset.ptool || "draw";
    // ⚠️ THE TOOL ENTERS THE MODE (2026-08-11). Draw, Hole, Select and Cut
    // section are always on the menu now; picking one locks the plan camera
    // itself — tracing is still falsified by perspective, so the lock is not
    // optional, it is simply no longer a separate thing to find.
    if (!state.plan.on) setPlanMode(true);
    state.plan.tool = tool;
    for (const o of document.querySelectorAll("button.ptool")) o.classList.toggle("on", o === b);
    // Switching tool abandons a half-traced ring rather than leaving it hanging
    // for the next mode to inherit: a ring begun as a region and finished as a
    // hole is neither.
    if (state.plan.draft.length) {
      state.plan.draft = [];
      state.plan.overlay?.setDraft([], null);
    }
    // …and a half-cut section, for the same reason: a first point left armed
    // would pair with whatever was clicked next, in whatever tool.
    state.sections.pending = null;
    // ⚠️ A TOOL WHOSE CONTROLS ARE FOLDED OUT OF SIGHT LOOKS LIKE A TOOL THAT
    // DOES NOTHING (2026-08-12, Marc: "not sure how the guide works"). Picking
    // Guide arms the tool, locks the plan camera and prints a status line — and
    // its whole panel sits collapsed further down the same column, because every
    // sub-section defaults closed since the menu-length fix. The same rising-edge
    // rule the sidebar already applies to Shape applies here: the mode starting
    // is what opens the section, and closing it afterwards is respected.
    if (tool === "guide") {
      $("sec-shape").open = true;
      // ⚠️ OPEN IT, DO NOT SCROLL TO IT. The first version called
      // scrollIntoView, which moved the sidebar 565 px in one jump and carried
      // Site and Section off the top of the column — the menu appeared to
      // reshuffle itself, which is worse than a control being one scroll away.
      // Opening the section is the whole of the affordance; where the user
      // looks is theirs.
      const g = $("sec-guide");
      if (g) /** @type {HTMLDetailsElement} */ (g).open = true;
    }
    status(tool === "draw" ? "draw a region"
      : tool === "hole" ? "draw a hole inside the selected region"
      : tool === "section" ? "click two points to cut a section"
      : tool === "guide" ? "click two or more points along the ground to trace a centreline"
      : "select a region, or drag its vertices");
  });
}

$("plan-z").addEventListener("input", () => {
  const p = state.plan;
  if (!p.selected) return;
  p.selected.level_m = parseFloat(/** @type {HTMLInputElement} */ ($("plan-z")).value);
  $("plan-z-val").textContent = `${p.selected.level_m.toFixed(3)} m`;
  $("plan-apply").textContent = `Level to ${p.selected.level_m.toFixed(2)} m`;
  // The plate moves with the slider, so the gap between it and the draped
  // outline shows the earthwork before it is committed. Only the plate is
  // rebuilt here; the mask has not changed, so it is not invalidated.
  p.overlay?.setRegions(p.set.regions, p.selected.id);
  refreshPlanPreview();
  renderPlanList();
});

/* The edge condition. Nothing here moves ground — it changes what the next
   Level would do, so each control only re-prices the preview. */
$("plan-batter-on").addEventListener("change", (e) => {
  state.plan.batter.on = /** @type {HTMLInputElement} */ (e.target).checked;
  $("plan-batter-angles").classList.toggle("off", !state.plan.batter.on);
  refreshPlanPreview();
});

for (const [id, key, val] of [
  ["plan-cut-deg", "cutDeg", "plan-cut-val"],
  ["plan-fill-deg", "fillDeg", "plan-fill-val"],
]) {
  $(id).addEventListener("input", (e) => {
    const deg = Number(/** @type {HTMLInputElement} */ (e.target).value);
    state.plan.batter[key] = deg;
    // 90° is not "steep", it is a different material — bedrock, or a wall —
    // and the readout says so rather than leaving the user to notice that the
    // batter has silently stopped appearing at the end of the slider.
    $(val).textContent = deg >= 90 ? "vertical" : `${deg}°`;
    refreshPlanPreview();
  });
}

$("plan-apply").addEventListener("click", () => {
  if (!state.plan.selected) return;
  applyPlanLevel(state.plan.selected.level_m, "to a chosen datum");
});

$("plan-mean").addEventListener("click", () => {
  const ext = planExtent();
  if (!ext || !ext.count) return;
  applyPlanLevel(ext.mean, "to its own mean");
});

$("plan-export").addEventListener("click", () => { try { exportPlan(); } catch (e) { fail(e); } });

$("plan-import").addEventListener("click", () => $("plan-shp").click());
$("plan-shp").addEventListener("change", (e) => {
  const input = /** @type {HTMLInputElement} */ (e.target);
  if (input.files && input.files.length) importPlanShapefile(input.files).catch(fail);
  input.value = "";   // so the same file can be picked twice
});

$("tile").addEventListener("change", (e) => {
  const name = /** @type {HTMLSelectElement} */ (e.target).value;
  loadTile(name).catch(fail);
});

/* --------------------------------------------------------------- file drop */

/**
 * Two targets — site and context — over one window-wide fallback.
 *
 * ⚠️ THE FALLBACK STILL MEANS "SITE", and that is the point of keeping it. The
 * old behaviour was that a GeoTIFF dropped anywhere became the terrain, and the
 * site is what someone dropping a file almost always means. Making the whole
 * window ambiguous in order to introduce a second target would tax every
 * ordinary drop to serve the rare one; the context is asked for explicitly, on
 * its own square, and nowhere else.
 */
const isTiff = (f) => /\.tiff?$/i.test(f.name);

/** @param {File} f @param {"site"|"context"} as */
function acceptDrop(f, as) {
  if (!isTiff(f)) { status(`${f.name} is not a GeoTIFF`, 4000); return; }
  (as === "context" ? loadContextFile(f) : loadFile(f)).catch(fail);
}

for (const [id, input, as] of /** @type {const} */ ([
  ["dz-site", "file", "site"],
  ["dz-context", "file-context", "context"],
])) {
  const zone = $(id);
  const picker = /** @type {HTMLInputElement} */ ($(input));
  zone.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    const f = picker.files && picker.files[0];
    if (f) acceptDrop(f, as);
    picker.value = "";
  });
  // Only the square under the pointer highlights, so the choice being made is
  // the one the interface is showing.
  for (const ev of ["dragenter", "dragover"]) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add("dragover");
    });
  }
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("dragover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) acceptDrop(f, as);
  });
}

// The window-wide fallback: still the site, as it always was.
// ⚠️ AND IT HAS TO OPEN THE FOLD IT HIGHLIGHTS (2026-08-16). The terrain drop
// target moved inside a sub-panel that ships collapsed, so lighting it up while
// it was hidden meant a drag over the window produced no visible answer at all
// — the drop still worked, which is worse, because nothing on screen said where
// the file was about to go.
for (const ev of ["dragenter", "dragover"]) {
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    const sub = /** @type {HTMLDetailsElement} */ ($("sec-terrain"));
    if (sub && !sub.open) sub.open = true;
    $("dz-site").classList.add("dragover");
  });
}
for (const ev of ["dragleave", "drop"]) {
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "dragleave" && e.relatedTarget) return; // still inside the window
    for (const id of ["dz-site", "dz-context"]) $(id).classList.remove("dragover");
  });
}
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) acceptDrop(f, "site");
});

/* --------------------------------------------------- substrate file input */

/**
 * A drop target that does one thing with what lands on it.
 *
 * ⚠️ SEPARATE TARGETS, DELIBERATELY. The window-wide handler accepts any .tif
 * and treats it as elevation — it cannot tell a DEM from a soil map from an
 * orthophoto by looking, and a filename filter certainly cannot. A zone per
 * meaning is the honest way for the user to say which this is. Every handler
 * stops propagation so the window handler does not also try the file as
 * terrain.
 * @param {string} zoneId @param {string} inputId
 * @param {(files: FileList|File[]) => void} take
 * @param {RegExp} accept
 */
function dropTarget(zoneId, inputId, take, accept) {
  const zone = $(zoneId);
  const input = /** @type {HTMLInputElement} */ ($(inputId));
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    if (input.files && input.files.length) take(input.files);
    input.value = "";
  });
  for (const ev of ["dragenter", "dragover"]) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation(); zone.classList.add("dragover");
    });
  }
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove("dragover");
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const ok = [...files].filter((f) => accept.test(f.name));
    if (!ok.length) { status(`nothing here matches ${accept}`, 4000); return; }
    take(ok);
  });
}

dropTarget("ortho-dropzone", "ortho-file",
  (files) => { loadOrthoFile(files[0]).catch(fail); }, /\.tiff?$/i);
dropTarget("photo-dropzone", "photo-files",
  (files) => { loadPhotos(files).catch(fail); }, /\.jpe?g$/i);

$("t-ortho").addEventListener("click", () => {
  setOrtho(!state.ortho.on);
  status(state.ortho.on
    ? "orthophoto draped — display only, never exported"
    : "orthophoto hidden", 3000);
});
$("t-photos").addEventListener("click", () => {
  state.photos.on = !state.photos.on;
  refreshPhotos();
  status(state.photos.on ? "photo points shown — observations, not model output"
    : "photo points hidden", 3000);
});
$("photos-clear").addEventListener("click", () => clearPhotos());

/* ---------------------------------------------- rule masks and benching */

/**
 * The class names come from RULE_LAYERS itself — one table for the chips, the
 * mask and the sentence. See the note there, including why `soil` has none.
 * @param {string} layer
 */
const ruleClassNames = (layer) => RULE_LAYERS[layer]?.classes || null;

/** Which classes are ticked, per categorical layer. */
/** @type {Record<string, Set<number>>} */
const ruleClassPick = {};
for (const [k, m] of Object.entries(RULE_LAYERS)) {
  if (m.categorical && m.classes) ruleClassPick[k] = new Set();
}

/** The rule the UI currently describes, or [] when the rule is off. */
function currentRules() {
  if (!$("t-rule").classList.contains("on")) return [];
  const layer = /** @type {HTMLSelectElement} */ ($("rule-layer")).value;
  const meta = RULE_LAYERS[layer];
  if (!meta) return [];
  if (meta.categorical) {
    const picked = ruleClassPick[layer];
    // ⚠️ NOTHING TICKED SELECTS NOTHING, not everything. `maskFromRule` already
    // keeps this rule for an unevaluable layer — a rule that could not be
    // evaluated must never WIDEN the operation it was meant to narrow — and an
    // empty class list is the same statement made by the user rather than by
    // the data. An empty `classes` array makes every cell fail the membership
    // test, which is exactly right.
    if (!picked) return [];
    return [{ layer, classes: [...picked] }];
  }
  const [lo, hi] = ruleBounds(layer);
  const min = parseFloat(/** @type {HTMLInputElement} */ ($("rule-min")).value);
  const max = parseFloat(/** @type {HTMLInputElement} */ ($("rule-max")).value);
  return [{ layer, min: lo + (hi - lo) * (min / 100), max: lo + (hi - lo) * (max / 100) }];
}

/**
 * Rebuild the class chips for whichever categorical layer is chosen.
 *
 * ⚠️ THE CODE IS THE INDEX, and that is a contract with `geomorphons.js`, whose
 * LANDFORMS array is documented as being "in the order their codes run". The
 * chip's data-code is its position in that array, so a class inserted there
 * without renumbering would silently select the wrong ground.
 */
function refreshRuleClasses(layer) {
  const wrap = $("rule-class-list");
  const names = ruleClassNames(layer);
  if (!names) { wrap.innerHTML = ""; wrap.dataset.built = ""; return; }
  if (wrap.dataset.built !== layer) {
    wrap.innerHTML = "";
    names.forEach((name, code) => {
      const b = document.createElement("button");
      b.dataset.code = String(code);
      b.textContent = name;
      b.title = `landform class ${code} — ${name}`;
      wrap.appendChild(b);
    });
    wrap.dataset.built = layer;
  }
  const picked = ruleClassPick[layer];
  for (const b of wrap.querySelectorAll("button")) {
    b.classList.toggle("on",
      !!picked && picked.has(Number(/** @type {HTMLElement} */ (b).dataset.code)));
  }
}

$("rule-class-list").addEventListener("click", (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest("button");
  if (!b || b.dataset.code === undefined) return;
  const layer = /** @type {HTMLSelectElement} */ ($("rule-layer")).value;
  const picked = ruleClassPick[layer];
  if (!picked) return;
  const code = Number(b.dataset.code);
  if (picked.has(code)) picked.delete(code); else picked.add(code);
  syncRuleUI();
});
for (const [id, all] of [["rule-class-all", true], ["rule-class-none", false]]) {
  $(id).addEventListener("click", () => {
    const layer = /** @type {HTMLSelectElement} */ ($("rule-layer")).value;
    const names = ruleClassNames(layer), picked = ruleClassPick[layer];
    if (!names || !picked) return;
    picked.clear();
    if (all) names.forEach((_, code) => picked.add(code));
    syncRuleUI();
  });
}

/**
 * The slider range for a layer.
 *
 * ⚠️ THE LAYER'S OWN MEASURED RANGE WHERE ONE EXISTS, not a guessed constant:
 * the worker already reports a percentile domain per layer, and a slope slider
 * running 0–90° on ground that never exceeds 25° would spend most of its
 * travel on values no cell has. Falls back to the ramp's declared domain.
 */
function ruleBounds(layer) {
  const d = state.domains[layer];
  if (d && d[1] > d[0]) return d;
  const r = RAMPS[layer];
  return r && r.domain ? r.domain : [0, 1];
}

/**
 * The layer grids a rule reads, cached.
 *
 * ⚠️ FETCHED, NOT FREE, AND THEREFORE CACHED. `AnalysisClient.grids()` copies
 * about 2.4 MB across the worker boundary and is asynchronous; calling it per
 * slider tick would make a rule feel like a stall. It is fetched once per
 * settle, and dropped whenever the analysis moves so a rule can never select
 * against a surface that has since changed — which is the one failure a rule
 * must not have, because it would silently act somewhere else.
 * @type {Record<string, Float32Array>|null}
 */
let ruleGrids = null;
/** the one outstanding grids() request, shared by every caller — see below */
let ruleGridsInFlight = null;
function dropRuleGrids() { ruleGrids = null; }

/**
 * The selection, shown ON the terrain.
 *
 * ⚠️ COMPOSITED OVER THE LAYER, NOT INSTEAD OF IT. A selection is an answer to
 * "where", and the reason you are asking is almost always the layer underneath
 * — "steep AND north-facing" is unreadable if turning the selection on hides
 * the aspect it was written against. So the tint is mixed into a COPY of
 * whatever buffer the surface would otherwise wear, and the original is left
 * untouched for the moment the highlight is switched off.
 *
 * ⚠️ AND IT MARKS THE UNSELECTED, not the selected. Tinting the selection
 * paints over the very cells being judged; greying everything else leaves them
 * showing their own colour, which is what a designer needs to see. Same
 * reasoning as the hidden-region rows in the plan list.
 * @type {Uint8Array|null}
 */
let ruleShown = null;
/**
 * Which panel's subject the outline is currently drawing: "rule" | "stack".
 * Null whenever nothing is outlined. Kept beside `ruleShown` because the two
 * are one state — a mask with no source, or a source with no mask, is a bug.
 * @type {"rule"|"stack"|null}
 */
let shownSource = null;

/**
 * ⚠️ THE OUTLINE IS THE SIGNAL; THE FADE IS THE SUPPORT (2026-08-11). The
 * first version tinted alone and was reported as hard to see and hard to
 * trust — a wash over 40% of a tile reads as a lighting change, not as a
 * boundary, and it never answers "where does it stop". The outline answers
 * exactly that and is unambiguous at any zoom; the fade stays because on a
 * large selection it is what tells you which side of the line you are on.
 * @type {import("./selection-view.js").SelectionOverlay|null}
 */
let selOverlay = null;

/**
 * How much the selected ground is darkened. 0.62 is dark enough to find by
 * scanning and light enough that a ramp still reads inside it.
 */
const SEL_DARKEN = 0.62;

/** @param {Uint8Array|null} mask */
function setRuleHighlight(mask) {
  ruleShown = mask;
  // ⚠️ A NULL MASK DOES NOT CLEAR `shownSource` (Marc, 2026-08-19). It used to,
  // which meant a live rule dragged THROUGH a zero-cell position lost its
  // outline for good — the follow in syncRuleUI keyed on the source, the source
  // was gone, and widening the range back brought nothing. The source now
  // records INTENT — "the outline is wanted" — and is cleared only by the
  // button that showed it, or by a tile load. An empty mask hides the outline;
  // the intent stands, so it returns the moment the selection is non-empty.
  // ⚠️ ONLY THE BUTTON WHOSE SUBJECT IS DRAWN LIGHTS UP. They lit together while
  // both drew the same thing; now that each shows its own panel's subject, a lit
  // "show selection" under By attribute has to mean the RULE is on screen.
  $("rule-show").classList.toggle("on", !!mask && shownSource === "rule");
  $("sel-show").classList.toggle("on", !!mask && shownSource === "stack");
  if (state.dem) {
    if (!selOverlay) {
      selOverlay = new SelectionOverlay(state.dem,
        { verticalExaggeration: currentExaggeration() });
      view.scene.add(selOverlay.group);
    }
    selOverlay.setExaggeration(currentExaggeration());
    selOverlay.setMask(mask);
    selOverlay.setVisible(!!mask);
  }
  applyShading();
  applyShadingForce();
}

/**
 * Mix the selection into a layer buffer. Returns a NEW buffer; the caller's
 * is never modified, because it belongs to the worker's last pass and is
 * reused on every repaint.
 * @param {Uint8ClampedArray|null} buf
 */
function withSelection(buf) {
  if (!ruleShown || !state.dem) return buf;
  const n = state.dem.nrows * state.dem.ncols;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const inSel = !!ruleShown[i];
    if (buf) {
      out[o] = buf[o]; out[o + 1] = buf[o + 1]; out[o + 2] = buf[o + 2]; out[o + 3] = buf[o + 3];
    } else {
      out[o] = 232; out[o + 1] = 229; out[o + 2] = 222; out[o + 3] = 255;
    }
    // ⚠️ THE SELECTION IS DARKENED IN PLACE; THE REST IS LEFT ALONE (Marc,
    // 2026-08-20). This reverses the 2026-08-11 decision to mark the UNSELECTED
    // instead, and the reason that decision was taken still stands — "tinting
    // the selection paints over the very cells being judged". A MULTIPLY is not
    // a tint: it scales each channel by the same factor, so hue and the
    // relative order of values inside the selection survive, and the cells
    // being judged still show their own colour. What the old version cost was
    // the REST of the tile: pushing 60 % of the ground toward paper meant the
    // layer could no longer be read anywhere outside the selection, which is
    // where the comparison lives.
    //
    // ⚠️ A MULTIPLY, NOT A SUBTRACTION. Taking a fixed amount off each channel
    // would crush the dark end of a ramp to black and flatten exactly the
    // distinctions the darkest cells are carrying; scaling preserves the ratios
    // all the way down.
    if (inSel) {
      out[o] *= SEL_DARKEN;
      out[o + 1] *= SEL_DARKEN;
      out[o + 2] *= SEL_DARKEN;
    }
  }
  return out;
}

/**
 * The analysis grids a rule reads, fetched once per settle.
 *
 * ⚠️⚠️ A FAILED FETCH IS NEVER CACHED (2026-08-12, Marc: the rule reported
 * "selects 0 cells · slope not computed yet" and stayed that way). This used to
 * be `catch { ruleGrids = {}; }` — and `{}` is truthy, so the guard at the top
 * returned that empty object for ever after. Every layer then read as missing,
 * the rule selected nothing, and the panel said the layer had not been computed
 * about a layer that had been computed for minutes. Nothing recovered it except
 * an analysis result calling dropRuleGrids(), which needs another EDIT — so a
 * user who was only moving the sliders saw a permanently dead rule and,
 * reasonably, called it a hang.
 *
 * ⚠️ AND THE IN-FLIGHT REQUEST IS SHARED. syncRuleUI runs on every `input` event
 * from the two range sliders, so a single drag fires this several times a second
 * while the first request is still out. Caching the PROMISE means one question
 * reaches the worker and every caller gets the same answer; without it they
 * raced, and before the fix in analysis-client.js they also cancelled each other.
 */
async function ensureRuleGrids() {
  if (ruleGrids) return ruleGrids;
  if (!state.analysis) return {};
  if (!ruleGridsInFlight) {
    ruleGridsInFlight = state.analysis.grids()
      .then((g) => { ruleGrids = g; return g; })
      // Left uncached, so the next evaluation asks again rather than inheriting
      // the failure.
      .catch(() => ({}))
      .finally(() => { ruleGridsInFlight = null; });
  }
  return ruleGridsInFlight;
}

/**
 * The surface's fingerprint, for telling a frozen selection whether the ground
 * has moved under it. See selection.js — O(n) over the heights, and cheap
 * enough to ask on every panel refresh at this site's 65 536 cells.
 */
function currentStamp() {
  return state.dem ? surfaceStamp(state.dem.z) : 0;
}

/**
 * Is anything narrowing the modifiers — the stack, or the live rule?
 *
 * ⚠️ THE MODIFIERS USED TO GATE ON `t-rule` ALONE, which is why this exists.
 * Every consumer asked "is the rule toggle on?" as a proxy for "is there a
 * selection?"; with a saved stack the two came apart, and a stack of three
 * layers would have been composed, drawn, counted — and then ignored by the
 * brush, because a toggle in a fold three panels away was off.
 */
function selectionArmed() {
  return state.selection.activeCount > 0 || $("t-rule").classList.contains("on");
}

/**
 * Where the modifiers may act.
 *
 * ⚠️ THE STACK WINS WHEN IT HAS A ROW, and the panel says so in words. The two
 * mechanisms are not merged — quietly intersecting a saved stack with whatever
 * the attribute sliders happen to be showing would make the selection depend on
 * a control the designer has not looked at since they saved it, which is the
 * staleness freezing exists to prevent. The live region-and-rule path stays as
 * the quick way to answer a question you are not saving.
 *
 * Pure — the caller supplies the grids, so this stays synchronous and
 * testable and the fetch stays in one place.
 * @param {Record<string, Float32Array>} grids
 */
function activeMask(grids) {
  if (!state.dem) return null;
  if (state.selection.activeCount > 0) {
    const n = state.dem.nrows * state.dem.ncols;
    const c = composeStack(state.selection.layers, n);
    return { mask: c.mask, count: c.count, rules: [], missing: [], stack: c };
  }
  return liveRuleMask(grids);
}

/**
 * The live region-and-rule selection, ignoring the stack entirely.
 *
 * ⚠️ THE "BY ATTRIBUTE" PANEL DESCRIBES ITS OWN CONTROL, not the tool's current
 * selection. Pointing its sentence at `activeMask` made the sliders report the
 * saved stack's count — so moving a slider changed nothing on screen and the
 * panel looked broken, when in fact the stack was simply in force. A panel that
 * describes something other than the control beside it is unreadable.
 * @param {Record<string, Float32Array>} grids
 */
function liveRuleMask(grids) {
  if (!state.dem) return null;
  const region = state.plan.selected
    ? rasterise(state.dem, state.plan.selected.rings).mask : null;
  const rules = currentRules();
  if (!rules.length) return region ? { mask: region, count: -1, rules, missing: [] } : null;
  const r = maskFromRule(state.dem, grids || {}, rules, region);
  return { ...r, rules };
}

/**
 * The per-cell weight the modifiers act through, or null for "the whole tile".
 *
 * ⚠️ CACHED ON THE MASK IDENTITY, because the exact distance transform is an
 * O(n) pass and `brushCfg()` is called at the start of every stroke. The cache
 * is dropped whenever the stack or the rule changes, which is the only thing
 * that can change the answer.
 */
let weightCache = null;
function dropSelectionWeights() { weightCache = null; }

function selectionWeights() {
  if (!state.dem) return null;
  if (!selectionArmed()) return null;
  // ⚠️ THE CACHED GRIDS, NOT EMPTY ONES (Marc, 2026-08-19). This runs at stroke
  // start and is synchronous, so it cannot fetch — but passing {} made every
  // live-rule layer read as "missing", which zeroed the count and, through the
  // null below, freed the brush from the very rule that was armed. The cache is
  // warm whenever the panel has evaluated the rule; if it is not, warm it for
  // the next stroke and act on nothing rather than on everything.
  if (!ruleGrids && state.selection.activeCount === 0) void ensureRuleGrids();
  const a = activeMask(ruleGrids || {});
  // count -1 means "a region with no rule", whose mask is still the region.
  if (!a || !a.mask) return null;
  // ⚠️ AN ARMED, EMPTY SELECTION BLOCKS THE MODIFIER — IT NEVER WIDENS IT.
  // Returning null at count 0 made "selects 0 cells" mean "act on the whole
  // tile", the exact degeneracy maskFromRule's header forbids a rule to have.
  // An all-zero weight field is the honest answer: the brush acts exactly
  // where the selection says, which is nowhere.
  const feather = selectionFeather();
  if (weightCache && weightCache.mask === a.mask && weightCache.feather === feather) {
    return weightCache.w;
  }
  const w = featherWeights(a.mask, state.dem.nrows, state.dem.ncols,
    state.dem.cell, feather);
  weightCache = { mask: a.mask, feather, w };
  return w;
}

/** The feather distance in metres, from the Selection panel. */
function selectionFeather() {
  const el = /** @type {HTMLInputElement} */ ($("sel-feather"));
  return el ? parseFloat(el.value) || 0 : 0;
}

/* ------------------------------------------------------- the selection stack */

/**
 * Freeze a mask as a new layer on top of the stack.
 * @param {Uint8Array} mask
 * @param {{name:string, source:string, live?:boolean, sentence?:string,
 *          recipe?:any}} opts
 */
function saveSelection(mask, opts) {
  const L = state.selection.add(mask, {
    ...opts,
    stamp: opts.live ? currentStamp() : 0,
  });
  refreshSelection();
  status(`"${L.name}" saved — ${L.count.toLocaleString("en")} cells`, 4000);
  return L;
}

/**
 * The cheap half of `refreshSelection` — just which rows have gone stale.
 *
 * ⚠️ SEPARATE FROM THE FULL REFRESH BECAUSE OF WHAT THE FULL ONE COSTS. An edit
 * cannot change the stack's arithmetic — the masks are frozen, that is the whole
 * point — so recomposing them and re-running the bench preview after every
 * stroke would be work whose answer cannot have changed. Only staleness moves.
 */
function refreshSelectionStale() {
  if (!state.selection.length) return;
  const stamp = currentStamp();
  if (!state.selection.layers.some((L) => stale(L, stamp))) {
    // Nothing stale and nothing marked: the common case, and it must not
    // repaint the list on every stroke.
    if (!$("sel-stack").querySelector("li.stale")) return;
  }
  renderSelectionStack();
  const n = state.selection.layers.filter((L) => stale(L, stamp)).length;
  $("sel-reeval").hidden = n === 0;
  $("sel-reeval").textContent = n === 1
    ? "re-evaluate 1 stale layer" : `re-evaluate ${n} stale layers`;
}

/** Everything on screen that describes the stack. One entry point. */
function refreshSelection() {
  dropSelectionWeights();   // the stack changed, so the weight field is stale
  const st = state.selection;
  const wrap = $("sel-stack-wrap");
  wrap.hidden = st.length === 0;
  renderSelectionStack();

  const n = state.dem ? state.dem.nrows * state.dem.ncols : 0;
  const c = n ? composeStack(st.layers, n) : null;
  $("sel-count").textContent = c
    ? `${c.count.toLocaleString("en")} cells · ${n ? (100 * c.count / n).toFixed(1) : "0"}%`
    : "—";

  const note = $("sel-note");
  if (!c || !st.activeCount) {
    note.textContent = st.length
      ? "Every row is off, so the stack selects nothing and the modifiers act "
        + "on the whole region again."
      : "";
  } else {
    // ⚠️ SAID IN WORDS RATHER THAN FIXED SILENTLY. The stack starts empty, so
    // every row above the first union is inert — subtracting from nothing and
    // intersecting with nothing both leave nothing. The module refuses to
    // promote a leading "but not" to a union, because that would make the stack
    // change meaning whenever a row above it was switched off, so the panel has
    // to explain the inert rows instead.
    // ⚠️ AND "INERT" IS NOT "EMPTY". The first wording here said a stack led by
    // "but not" selects nothing — and it shipped for ten minutes next to a
    // reading of 24,131 cells, because the union BELOW the leading row still
    // adds. A note that contradicts the number beside it is worse than no note.
    const lead = !c.seeded
      ? "⚠️ The stack starts empty, so the rows above the first + have nothing "
        + "to act on and do nothing here. Make the top row a union (+), or move "
        + "one above them. "
      : "";
    note.textContent = lead + `${describeStack(st.layers)}.`
      + (c.skipped.length ? ` ⚠️ ${c.skipped.join(", ")} skipped — not this grid.` : "");
  }

  const stamp = currentStamp();
  const staleCount = st.layers.filter((L) => stale(L, stamp)).length;
  $("sel-reeval").hidden = staleCount === 0;
  $("sel-reeval").textContent = staleCount === 1
    ? "re-evaluate 1 stale layer" : `re-evaluate ${staleCount} stale layers`;

  // The badge on the rail: "armed or running, and you could forget it".
  refreshBenchPreview();
}

function renderSelectionStack() {
  const st = state.selection;
  const ul = $("sel-stack");
  ul.innerHTML = "";
  const stamp = currentStamp();

  st.layers.forEach((L, i) => {
    const li = document.createElement("li");
    li.classList.toggle("off", !L.enabled);

    const dot = document.createElement("button");
    dot.className = "seldot";
    dot.textContent = L.enabled ? "●" : "○";
    dot.title = L.enabled ? "switch this row off" : "switch this row on";
    dot.addEventListener("click", () => {
      L.enabled = !L.enabled;
      refreshSelection();
      refreshStackHighlight();
    });

    const op = document.createElement("button");
    const meta = OP_BY_KEY[L.op] ?? OP_BY_KEY.add;
    op.className = "selop";
    op.textContent = meta.glyph;
    op.title = `${meta.label} — "${meta.verb}". Click to cycle.`;
    // ⚠️ THE FIRST ROW'S OPERATOR IS STILL EDITABLE. It is tempting to lock it
    // to "+" since anything else selects nothing, but the row below it may be
    // about to move up, and a control that refuses the intermediate state makes
    // reordering a stack impossible without deleting rows.
    op.addEventListener("click", () => {
      L.op = nextOp(L.op);
      refreshSelection();
      refreshStackHighlight();
    });

    const body = document.createElement("div");
    body.className = "grow";
    // textContent throughout: the name is one rename away from user text, and
    // the same rule the region list already keeps.
    const name = document.createElement("div");
    name.className = "selname";
    name.textContent = L.name;
    name.title = L.sentence || L.name;
    const sub = document.createElement("div");
    sub.className = "selsrc";
    sub.textContent = `${L.source} · ${L.count.toLocaleString("en")} cells`;
    body.append(name, sub);

    if (stale(L, stamp)) {
      li.classList.add("stale");
      const re = document.createElement("button");
      re.className = "link relink";
      re.textContent = "ground moved — re-evaluate";
      re.title = "this layer was read off the surface before it was edited";
      re.addEventListener("click", (e) => { e.stopPropagation(); reEvaluate(L.id); });
      sub.textContent += " · ";
      sub.appendChild(re);
    }

    const up = document.createElement("button");
    up.textContent = "↑";
    up.title = "move up — order is meaning here, not tidiness";
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      state.selection.move(L.id, -1); refreshSelection(); refreshStackHighlight();
    });

    const down = document.createElement("button");
    down.textContent = "↓";
    down.title = "move down — order is meaning here, not tidiness";
    down.disabled = i === st.layers.length - 1;
    down.addEventListener("click", () => {
      state.selection.move(L.id, 1); refreshSelection(); refreshStackHighlight();
    });

    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "remove this layer from the stack";
    x.addEventListener("click", () => {
      state.selection.remove(L.id);
      refreshSelection();
      refreshStackHighlight();
      status(`"${L.name}" removed from the stack`, 2500);
    });

    li.append(dot, op, body, up, down, x);
    ul.appendChild(li);
  });
}

/**
 * Re-read one stale layer against the surface as it now stands.
 *
 * ⚠️ ONLY AN ATTRIBUTE LAYER CAN BE RE-EVALUATED, because only an attribute
 * layer has a recipe that reads the ground. A drawn region's cells are geometry
 * and never went stale in the first place — see selection.js.
 * @param {number} id
 */
async function reEvaluate(id) {
  const L = state.selection.byId(id);
  if (!L || !state.dem) return;
  if (!L.live || !L.recipe) { status(`"${L.name}" has nothing to re-read`, 3000); return; }
  const r = maskFromRule(state.dem, await ensureRuleGrids(), L.recipe, null);
  if (r.missing.length) {
    status(`${r.missing.join(", ")} not computed yet — "${L.name}" left as it was`, 4000);
    return;
  }
  const before = L.count;
  state.selection.refreeze(id, r.mask, currentStamp());
  refreshSelection();
  refreshStackHighlight();
  status(`"${L.name}" re-evaluated — ${before.toLocaleString("en")} → `
    + `${L.count.toLocaleString("en")} cells`, 5000);
}

/**
 * Keep the on-terrain outline showing the composed stack while it is shown.
 *
 * ⚠️ A HIGHLIGHT THAT IS SHOWING MUST FOLLOW THE STACK, or it becomes a picture
 * of a selection that has since been edited — the same staleness trap the rule
 * sliders already carry a note about.
 */
async function refreshStackHighlight() {
  // Keyed on the source, not the mask, for the same reason as the rule follow:
  // a stack whose rows were all switched off must get its outline back when a
  // row is switched on again, not stay dark because the mask was once empty.
  if (!state.dem || shownSource !== "stack") return;
  const a = activeMask({});
  setRuleHighlight(a && a.count > 0 ? a.mask : null);
}

/**
 * `activeMask` with whatever grids it actually needs, and no others.
 *
 * ⚠️ THE GRIDS ARE FETCHED ONLY ON THE PATH THAT READS THEM. A composed stack
 * is already frozen, so asking the worker for eleven analysis layers before
 * composing it would put a round trip in front of every bench preview to
 * produce grids nothing then looks at.
 */
async function maskNow() {
  const needsGrids = state.selection.activeCount === 0
    && $("t-rule").classList.contains("on");
  return activeMask(needsGrids ? await ensureRuleGrids() : {});
}

async function syncRuleUI() {
  const sel = /** @type {HTMLSelectElement} */ ($("rule-layer"));
  if (!sel.options.length) {
    for (const [k, m] of Object.entries(RULE_LAYERS)) {
      // ⚠️ A CATEGORICAL LAYER IS OFFERED ONLY IF ITS CLASSES ARE NAMED in
      // RULE_LAYERS. `maskFromRule` has always matched class membership;
      // the dropdown was the only thing excluding these, with the note "ranges
      // only, for now". This is that "for now" ending.
      if (m.categorical && !m.classes) continue;
      sel.add(new Option(m.label, k));
    }
    sel.value = "slope";
  }
  const layer = sel.value, meta = RULE_LAYERS[layer];

  // Two ways of narrowing, one shown at a time: a range for a measured
  // quantity, membership for a set of named classes.
  const categorical = !!meta.categorical;
  $("rule-range").hidden = categorical;
  $("rule-classes").hidden = !categorical;
  refreshRuleClasses(layer);

  const [lo, hi] = ruleBounds(layer);
  const at = (id) => lo + (hi - lo)
    * (parseFloat(/** @type {HTMLInputElement} */ ($(id)).value) / 100);
  const dp = meta.dp ?? 2;
  if (!categorical) {
    $("rule-min-val").textContent = `${at("rule-min").toFixed(dp)}${meta.unit}`;
    $("rule-max-val").textContent = `${at("rule-max").toFixed(dp)}${meta.unit}`;
  }

  dropSelectionWeights();   // the live rule changed, so the weight field is stale
  const on = $("t-rule").classList.contains("on");
  const a = liveRuleMask(on ? await ensureRuleGrids() : {});
  const total = state.dem ? state.dem.nrows * state.dem.ncols : 0;
  // A saved stack takes precedence over this panel, and the panel has to say so
  // — otherwise "Rule on" looks broken while the modifiers dutifully obey
  // something the designer saved ten minutes ago.
  const overridden = state.selection.activeCount > 0
    ? " ⚠️ A saved stack is in force above, so it — not this rule — is what the "
      + "modifiers act inside. Save this as a layer to combine the two."
    : "";
  // ⚠️ A RULE IS SILENTLY NARROWED BY THE SELECTED REGION, AND THE SENTENCE HAS
  // TO SAY SO. `liveRuleMask` intersects with `state.plan.selected`, so a rule
  // that would select a third of the tile can report 0 cells purely because the
  // region it is confined to lies outside the range — and the reader, looking at
  // a range they just set by hand, concludes the viewport is broken. Reported by
  // Marc exactly that way.
  const within = state.plan.selected
    ? ` Inside "${state.plan.selected.name}" only — the region selected above.`
    : "";
  const emptyHint = on && a && a.count === 0
    ? (state.plan.selected
        ? " Nothing in that region falls in this range; try widening it, or"
          + " deselect the region to search the whole tile."
        : " Nothing on this tile falls in that range.")
    : "";
  $("rule-note").textContent = (!on
    ? "No selection — modifiers act on the whole region. A rule builds one "
      + "from the surface as it stands."
    : a && a.count >= 0
      ? `${describeRules(a.rules)} — selects ${a.count.toLocaleString("en")} cells`
        + `${total ? ` (${(100 * a.count / total).toFixed(1)}% of the tile)` : ""}.`
        + within + emptyHint
        + (a.missing?.length ? ` ⚠️ ${a.missing.join(", ")} not computed yet.` : "")
      : "No layer computed yet — move some earth or wait for the analysis to settle.")
    + overridden;

  // Saving is offered only when there is something to save. A greyed button
  // that never explains itself is worse than one that appears when it can act.
  $("rule-save").disabled = !(on && a && a.count > 0);

  // A highlight that is showing must FOLLOW the sliders, or it becomes a
  // picture of a rule that has since been edited — the same staleness trap
  // the cached grids carry a note about.
  // ⚠️ …AND IT FOLLOWS WHATEVER IS ACTUALLY IN FORCE. With a stack armed, the
  // outline on the terrain has to keep showing the stack while these sliders
  // move, or dragging one would repaint the ground with a rule that is not what
  // any modifier is about to use.
  // ⚠️ AND IT FOLLOWS ONLY WHAT IT IS SHOWING. While the STACK is outlined these
  // sliders must not repaint the ground — that is a different question, asked in
  // a different panel, and hijacking the outline mid-drag is the behaviour that
  // made this panel look broken.
  // ⚠️ KEYED ON THE SOURCE, NOT ON `ruleShown`. Keying on the mask meant one
  // pass through a zero-cell range ended the follow permanently — the empty
  // mask nulled `ruleShown`, and no later drag could re-enter this branch.
  if (shownSource === "rule") {
    setRuleHighlight(on && a && a.count > 0 ? a.mask : null);
  }
}

$("rule-layer").addEventListener("change", syncRuleUI);
for (const id of ["rule-min", "rule-max"]) $(id).addEventListener("input", syncRuleUI);
$("t-rule").addEventListener("click", () => {
  $("t-rule").classList.toggle("on");
  syncRuleUI();
  status($("t-rule").classList.contains("on")
    ? "rule on — modifiers act only where it selects" : "rule off", 3000);
});
/**
 * Show, or stop showing, an outline on the terrain — from ONE of two sources.
 *
 * ⚠️ ONE OVERLAY, TWO SOURCES, AND THE BUTTON YOU PRESSED DECIDES. Both buttons
 * drove `maskNow()` for one session, which meant "show selection" INSIDE the By
 * attribute panel drew the saved stack instead of the rule the user was editing
 * — so dragging the range sliders changed nothing on screen and the panel read
 * as broken. Reported by Marc exactly that way. Each panel now shows its own
 * subject; only one is drawn at a time, so the danger that argued for unifying
 * them — two outlines on one piece of ground, each answering a different
 * question — never arises.
 */
async function showSelectionFrom(source) {
  if (shownSource === source) {
    shownSource = null;
    setRuleHighlight(null);
    status(`${source === "stack" ? "stack" : "rule"} outline hidden`, 2000);
    return;
  }
  const a = source === "stack"
    ? activeMask({})
    : liveRuleMask(await ensureRuleGrids());
  if (!a || a.count <= 0) {
    // ⚠️ NAME WHICH ONE IS EMPTY. "nothing is selected" beside a panel showing a
    // rule the user has just written is the message that sent Marc looking for
    // a broken viewport: the rule really did select nothing, and the sentence
    // has to say so about the RULE rather than about the tool.
    status(source === "stack"
      ? "the stack selects nothing to show"
      : "this rule selects nothing — check the range, and the region it is inside",
      4500);
    return;
  }
  shownSource = source;
  setRuleHighlight(a.mask);
  // ⚠️ SAY WHEN THE MESH WAS DROPPED. Past the budget the interior lattice is
  // suppressed, and a selection that showed its cells at 3 000 and stops at
  // 5 000 looks broken unless the sentence accounts for it.
  const meshNote = selOverlay?.meshSuppressed
    ? " · cell mesh hidden above 4,000 cells — it fills to solid ink"
    : selOverlay?.meshCount
      ? ` · ${selOverlay.meshCount.toLocaleString("en")} cell edges`
      : "";
  status(`${source === "stack" ? "stack" : "rule"}: `
    + `${a.count.toLocaleString("en")} cells · `
    + `${(selOverlay?.count ?? 0).toLocaleString("en")} boundary edges outlined`
    + meshNote, 5000);
}
$("rule-show").addEventListener("click", () => showSelectionFrom("rule"));
$("sel-show").addEventListener("click", () => showSelectionFrom("stack"));

/**
 * Freeze the live attribute rule as a layer.
 *
 * ⚠️ THE RULE'S OWN SENTENCE BECOMES THE LAYER'S NAME. "Slope 20.2–48.0°" is
 * what the designer just read in the panel above; naming it "Selection 3" and
 * hiding the sentence in a tooltip would make a stack of four rows unreadable
 * the next morning. The rules array travels with it as the recipe, which is
 * what re-evaluate re-reads.
 */
$("rule-save").addEventListener("click", async () => {
  const a = liveRuleMask(await ensureRuleGrids());
  if (!a || a.count <= 0) { status("the rule selects nothing to save", 3000); return; }
  const sentence = describeRules(a.rules);
  saveSelection(a.mask, {
    name: sentence,
    source: "by attribute",
    live: true,
    sentence,
    recipe: a.rules,
  });
  // ⚠️ AND THE LIVE RULE IS SWITCHED OFF ON SAVE. Leaving it on would leave two
  // selections armed at once, of which only the stack acts — the panel would
  // then have to explain itself every time instead of the state simply being
  // unambiguous. The saved layer is the rule, kept.
  if ($("t-rule").classList.contains("on")) $("t-rule").classList.remove("on");
  syncRuleUI();
  refreshStackHighlight();
});

$("sel-feather").addEventListener("input", () => {
  dropSelectionWeights();
  const m = selectionFeather();
  $("sel-feather-val").textContent = `${m.toFixed(1)} m`;
  refreshBenchPreview();
});

$("sel-clear").addEventListener("click", () => {
  const n = state.selection.length;
  if (!n) return;
  state.selection.clear();
  refreshSelection();
  refreshStackHighlight();
  // ⚠️ Clearing the stack does NOT undo the earth any of its layers helped move,
  // for the same reason deleting a region does not — the ledger records what was
  // done to the ground, and the ground is still cut.
  status(`stack cleared — ${n} layer${n > 1 ? "s" : ""} removed; `
    + "the earth they helped move stands in the ledger", 5000);
});

$("sel-reeval").addEventListener("click", async () => {
  const stamp = currentStamp();
  const ids = state.selection.layers.filter((L) => stale(L, stamp)).map((L) => L.id);
  for (const id of ids) await reEvaluate(id);
  if (ids.length > 1) status(`${ids.length} layers re-evaluated`, 4000);
});

/* ----------------------------------------------------- proportional symbols */

/* ------------------------------- the terrain of attributes (glyph chain) */

/**
 * A line per sampled cell, built by an ordered chain of attributes.
 * @type {GlyphField|null}
 */
let glyphField = null;
let glyphsOn = false;
/** @type {{key:string, op:string, gain:number, invert:boolean}[]} */
let glyphChain = DEFAULT_CHAIN.map((r) => ({ ...r }));

/**
 * Every layer a glyph row may be driven by.
 *
 * ⚠️ `RULE_LAYERS` MINUS THE CATEGORICAL ONES, PLUS ASPECT. The categorical
 * ones are excluded for the reason they are excluded everywhere else — turning
 * a glyph by a landform CODE would order categories that have no order. Aspect
 * is added because it is the one attribute here that IS a direction, and it is
 * deliberately absent from RULE_LAYERS: a bearing is circular, so 350°–10° is
 * an ordinary range across north that the rule panel's min/max pair cannot
 * express. See the header of glyphs.js.
 */
function glyphLayers() {
  /** @type {Record<string, {label:string, unit?:string, dp?:number}>} */
  const out = { ...GLYPH_EXTRA_LAYERS };
  for (const [k, m] of Object.entries(RULE_LAYERS)) {
    if (!m.categorical) out[k] = m;
  }
  return out;
}

/** Draw the chain as rows. Rebuilt whole — it is at most a handful of rows. */
function renderGlyphChain(inert = []) {
  const wrap = $("glyph-chain");
  wrap.innerHTML = "";
  const layers = glyphLayers();
  glyphChain.forEach((row, i) => {
    const el = document.createElement("div");
    el.className = "gly-row";
    // ⚠️ A ROW IS INERT WHEN IT HAS NOTHING TO ACT ON, and the mark is on the
    // row rather than only in the note — a chain of four has to say WHICH step
    // is doing nothing for the warning to be actionable.
    if (row.op === "bend" && !glyphChain.slice(0, i).some((r) => r.op === "extend")) {
      el.classList.add("inert");
      el.title = "this bend comes before anything has been drawn, so it has "
        + "no line to act on — move an extend above it";
    }
    if (inert.includes(`${row.key} is not computed`)) el.classList.add("inert");

    const n = document.createElement("span");
    n.className = "gly-n";
    n.textContent = String(i + 1);

    const opSel = document.createElement("select");
    for (const o of GLYPH_OPS) opSel.add(new Option(o.label, o.key));
    opSel.value = row.op;
    opSel.addEventListener("change", () => { row.op = opSel.value; refreshGlyphs(); });

    const laySel = document.createElement("select");
    for (const [k, m] of Object.entries(layers)) laySel.add(new Option(m.label, k));
    laySel.value = row.key;
    laySel.addEventListener("change", () => { row.key = laySel.value; refreshGlyphs(); });

    const gain = document.createElement("input");
    gain.type = "range"; gain.min = "0"; gain.max = "200"; gain.step = "5";
    gain.value = String(Math.round(row.gain * 100));
    gain.title = "how strongly this step acts";
    gain.addEventListener("input", () => {
      row.gain = parseInt(gain.value, 10) / 100; refreshGlyphs();
    });

    const inv = document.createElement("button");
    inv.textContent = "↕";
    inv.title = "invert — act on the low end of the range instead of the high";
    inv.classList.toggle("on", !!row.invert);
    inv.addEventListener("click", () => { row.invert = !row.invert; refreshGlyphs(); });

    const up = document.createElement("button");
    up.textContent = "↑";
    up.title = "move this step earlier — order is meaning";
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      glyphChain.splice(i - 1, 0, glyphChain.splice(i, 1)[0]);
      refreshGlyphs();
    });

    const del = document.createElement("button");
    del.textContent = "×";
    del.title = "remove this step";
    del.addEventListener("click", () => { glyphChain.splice(i, 1); refreshGlyphs(); });

    el.append(n, opSel, laySel, gain, inv, up, del);
    wrap.appendChild(el);
  });
}

/**
 * Rebuild the glyph field against the chain and the surface as they stand.
 *
 * ⚠️ THE SAME STRETCHED DOMAIN AS THE RAMPS AND THE SYMBOLS, for the third
 * time and the same reason: a field normalised against the raw min and max
 * would disagree with every other reading of the same layer.
 */
async function refreshGlyphs() {
  $("t-glyphs").classList.toggle("on", glyphsOn);
  $("t-glyph-solo").classList.toggle("on", glyphSolo);
  const note = $("glyph-note");
  $("glyph-stride-val").textContent =
    `${$("glyph-stride").value} cell${$("glyph-stride").value === "1" ? "" : "s"}`;
  $("glyph-len-val").textContent = `${$("glyph-len").value}%`;
  if (!state.dem) return;
  if (!glyphsOn) {
    glyphField?.setVisible(false);
    renderGlyphChain();
    note.textContent = "A line stands on every sampled cell and each step below "
      + "lets one attribute act on it — turn it, lean it, grow it, bend it. "
      + "What you end up looking at is not terrain with data on it: it is the "
      + "data, standing where the terrain was.";
    return;
  }

  const grids = await ensureRuleGrids();
  const layers = glyphLayers();
  /** @type {Record<string, {grid:any, lo:number, hi:number, kind?:string}>} */
  const fields = {};
  for (const row of glyphChain) {
    const g = grids[row.key];
    if (!g || fields[row.key]) continue;
    const dom = (state.domains && state.domains[row.key])
      || RAMPS[row.key]?.domain || null;
    let lo = dom ? dom[0] : NaN, hi = dom ? dom[1] : NaN;
    if (!(hi > lo)) {
      lo = Infinity; hi = -Infinity;
      for (let i = 0; i < g.length; i++) {
        const v = g[i];
        if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    }
    fields[row.key] = { grid: g, lo, hi };
  }

  const stride = parseInt(/** @type {HTMLInputElement} */ ($("glyph-stride")).value, 10);
  const lenF = parseInt(/** @type {HTMLInputElement} */ ($("glyph-len")).value, 10) / 100;
  const built = buildGlyphs(state.dem, fields, glyphChain,
    { stride, lengthFraction: lenF });

  if (!glyphField) {
    glyphField = new GlyphField(state.dem, { verticalExaggeration: currentExaggeration() });
    view.scene.add(glyphField.group);
  }
  glyphField.setExaggeration(currentExaggeration());
  glyphField.setGlyphs(built.glyphs);
  glyphField.setVisible(true);
  renderGlyphChain(built.inert);

  // ⚠️ THE SENTENCE, THE COUNT, AND WHAT WAS DROPPED — in that order. A field
  // of leaning lines is unreadable without the chain that built it, and the
  // dropped count is not a footnote: an aspect-led chain drops every flat cell,
  // so a levelled surface makes the field VANISH. That is the tool's own
  // finding, and it has to read as an absence rather than as a failure.
  const missing = built.missing.length
    ? ` ⚠️ ${built.missing.map((k) => layers[k]?.label || k).join(", ")} `
      + `not computed yet — those steps did nothing.` : "";
  const gone = built.sampled - built.drawn;
  const dropped = gone > 0
    ? ` ${gone.toLocaleString("en")} of ${built.sampled.toLocaleString("en")} `
      + `sampled cells carry no glyph at all — a step in the chain has no answer `
      + `there, which is an absence, not a low value.` : "";
  const inert = built.inert.length ? ` ⚠️ ${built.inert.join("; ")}.` : "";
  note.textContent = `${describeChain(glyphChain, layers)}. `
    + `${built.drawn.toLocaleString("en")} glyphs, `
    + `${glyphField.segments.toLocaleString("en")} segments.`
    + dropped + inert + missing;
}

/**
 * Hide the ground, leaving the attribute field standing alone.
 *
 * ⚠️ THIS IS WHY THE GLYPHS ARE AN OVERLAY AND NOT A THIRD REPRESENTATION. A
 * representation would have to answer to the exporters, the water, the section
 * face and the printable solid, none of which can mean anything for a field of
 * lines. Hiding the terrain mesh gives the same picture and promises nothing
 * the rest of the tool would then have to honour.
 */
let glyphSolo = false;
function applyGlyphSolo() {
  const rep = /** @type {any} */ (state.surface);
  if (rep && rep.mesh) rep.mesh.visible = !(glyphSolo && glyphsOn);
  $("t-glyph-solo").classList.toggle("on", glyphSolo);
}

$("t-glyphs").addEventListener("click", () => {
  glyphsOn = !glyphsOn;
  refreshGlyphs();
  applyGlyphSolo();
  status(glyphsOn ? "glyph field on — the chain below builds it"
    : "glyph field off", 3000);
});
$("t-glyph-solo").addEventListener("click", () => {
  glyphSolo = !glyphSolo;
  applyGlyphSolo();
  status(glyphSolo ? "ground hidden — the attributes stand alone"
    : "ground shown", 3000);
});
$("glyph-add").addEventListener("click", () => {
  glyphChain.push({ key: "twi", op: "extend", gain: 1, invert: false });
  refreshGlyphs();
});
$("glyph-reset").addEventListener("click", () => {
  glyphChain = DEFAULT_CHAIN.map((r) => ({ ...r }));
  refreshGlyphs();
});
for (const id of ["glyph-stride", "glyph-len"]) {
  $(id).addEventListener("input", () => refreshGlyphs());
}

/**
 * An analysis layer read as SIZE rather than as colour.
 * @type {SymbolField|null}
 */
let symField = null;
let symbolsOn = false;

function symbolOpts() {
  const num = (id) => parseFloat(/** @type {HTMLInputElement} */ ($(id)).value);
  return {
    layer: /** @type {HTMLSelectElement} */ ($("sym-layer")).value,
    stride: Math.round(num("sym-stride")),
    threshold: num("sym-threshold") / 100,
    minFraction: num("sym-min") / 100,
  };
}

/**
 * Rebuild the symbol field against the layer and the surface as they stand.
 *
 * ⚠️ THE DOMAIN IS THE RAMP'S OWN, so the circles and the colours agree about
 * what "high" means. The worker percentile-stretches every layer (2–98 %) and
 * publishes the result in `state.domains`; a symbol field that normalised
 * against the raw min and max instead would size every circle differently from
 * the shading beside it, and one of the two would be wrong about the same cell.
 */
async function refreshSymbols() {
  $("t-symbols").classList.toggle("on", symbolsOn);
  $("symbol-tools").hidden = !symbolsOn;
  if (!state.dem) return;
  if (!symbolsOn) { symField?.setVisible(false); drawSymbolLegend(null); return; }

  const o = symbolOpts();
  const grids = await ensureRuleGrids();
  const grid = grids[o.layer];
  if (!grid) {
    symField?.setVisible(false);
    drawSymbolLegend(null);
    $("sym-note").textContent = `${o.layer} has not been computed yet — `
      + `move some earth or wait for the analysis to settle.`;
    return;
  }
  const dom = (state.domains && state.domains[o.layer]) || null;
  const lo = dom ? dom[0] : undefined, hi = dom ? dom[1] : undefined;

  const syms = symbolField(state.dem, grid,
    { lo, hi, stride: o.stride, threshold: o.threshold, minFraction: o.minFraction });
  if (!symField) {
    symField = new SymbolField(state.dem, { verticalExaggeration: currentExaggeration() });
    view.scene.add(symField.group);
  }
  symField.setExaggeration(currentExaggeration());
  symField.setSymbols(syms);
  symField.setVisible(true);

  // The domain actually used, for the legend and the sentence.
  let dlo = lo, dhi = hi;
  if (!Number.isFinite(dlo) || !Number.isFinite(dhi)) {
    dlo = Infinity; dhi = -Infinity;
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      if (Number.isFinite(v)) { if (v < dlo) dlo = v; if (v > dhi) dhi = v; }
    }
  }
  drawSymbolLegend({ lo: dlo, hi: dhi, ...o });
  const meta = RULE_LAYERS[o.layer];
  $("sym-note").textContent =
    `${syms.length.toLocaleString("en")} symbols, one per ${o.stride}× ${o.stride} `
    + `cells (${(o.stride * state.dem.cell).toFixed(2)} m apart). `
    + `A full-size circle is ${(o.stride * state.dem.cell).toFixed(2)} m across and `
    + `stands for ${(+dhi).toFixed(meta?.dp ?? 2)}${meta?.unit ?? ""}. `
    + `Cells with no answer carry no circle.`;
}

/**
 * The legend: the reference circles a reader measures the map against.
 *
 * ⚠️ DRAWN AT THE MAP'S OWN PROPORTIONS, not at a convenient size. The whole
 * point of a proportional symbol is that its diameter IS the value, so a legend
 * whose circles were scaled to fit a box would be a legend for a different map.
 * The panel is narrow, so the legend states the scale it is drawn at instead of
 * quietly changing it.
 */
function drawSymbolLegend(cfg) {
  const cv = /** @type {HTMLCanvasElement} */ ($("sym-legend"));
  if (!cv) return;
  const g = cv.getContext("2d");
  if (!g) return;
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#fdfcf9"; g.fillRect(0, 0, W, H);
  if (!cfg || !state.dem) return;

  const refs = symbolLegend(cfg.lo, cfg.hi, {
    stride: cfg.stride, cell: state.dem.cell,
    minFraction: cfg.minFraction, count: 3,
  });
  if (!refs.length) return;
  // World metres → legend pixels, from the largest circle that must fit.
  const biggest = refs[refs.length - 1].r;
  const pad = 16, maxR = Math.min(H * 0.32, (W - pad * 2) / (refs.length * 2.6));
  const k = biggest > 0 ? maxR / biggest : 1;
  const meta = RULE_LAYERS[cfg.layer];
  const dp = meta?.dp ?? 2;
  const cy = H * 0.46;
  let x = pad + maxR;
  g.font = `500 15px "Source Sans 3", "Segoe UI", system-ui, sans-serif`;
  g.textAlign = "center";
  for (const ref of refs) {
    const r = Math.max(1, ref.r * k);
    g.beginPath(); g.arc(x, cy, r, 0, Math.PI * 2);
    g.fillStyle = "rgba(38,36,31,0.42)"; g.fill();
    g.strokeStyle = "rgba(38,36,31,0.75)"; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = "#26241f";
    g.fillText(`${(+ref.v).toFixed(dp)}${meta?.unit ?? ""}`, x, H - 14);
    x += maxR * 2.6;
  }
  g.textAlign = "left";
  g.fillStyle = "#7a766d";
  g.font = `500 13px "Source Sans 3", "Segoe UI", system-ui, sans-serif`;
  g.fillText(`${meta?.label ?? cfg.layer}`, pad, 20);
}

for (const [k, m] of Object.entries(RULE_LAYERS)) {
  if (m.categorical) continue;   // a class code has no magnitude to size
  /** @type {HTMLSelectElement} */ ($("sym-layer")).add(new Option(m.label, k));
}
$("t-symbols").addEventListener("click", () => {
  symbolsOn = !symbolsOn;
  refreshSymbols();
  status(symbolsOn ? "symbols on — one circle per sampled cell, sized by value"
    : "symbols off", 2500);
});
for (const id of ["sym-stride", "sym-threshold", "sym-min"]) {
  $(id).addEventListener("input", () => {
    const o = symbolOpts();
    const n = o.stride;
    const suffix = n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
    $("sym-stride-val").textContent = `${n}${suffix}`;
    $("sym-thr-val").textContent = `${(o.threshold * 100).toFixed(0)}%`;
    $("sym-min-val").textContent = `${(o.minFraction * 100).toFixed(0)}%`;
    refreshSymbols();
  });
}
$("sym-layer").addEventListener("change", refreshSymbols);

/* ------------------------------------------------------------ guide curves */

/**
 * The centreline being designed.
 *
 * ⚠️ ONE CURVE AT A TIME, DELIBERATELY, for this first build. A set of named
 * guides is the obvious next step and it brings a list, selection, renaming,
 * export and undo semantics with it — all of which the regions already have and
 * none of which is the thing being tested here, which is whether sweeping a
 * section along a line is the missing primitive the design document claims.
 * Ship the primitive, then promote it to an object.
 */
const guide = { pts: [] };

/** The section and longitudinal options the CURRENT UI describes.
 *
 * ⚠️ ONE SOURCE, as `batterOpts()` is for plan levelling: the figure in the
 * preview and the figure that lands in the ledger have to be the same
 * operation, and the surest way is for both to read it from here. */
function guideOpts() {
  const num = (id) => parseFloat(/** @type {HTMLInputElement} */ ($(id)).value);
  return {
    profile: /** @type {HTMLSelectElement} */ ($("guide-profile")).value,
    width: num("guide-width"),
    depth: num("guide-depth"),
    sideDeg: num("guide-side"),
    along: /** @type {HTMLSelectElement} */ ($("guide-along")).value,
    // The slider is in per cent because that is how a drainage gradient is
    // quoted; the kernel takes metres per metre.
    gradient: num("guide-grad") / 100,
    ...batterOpts(),
  };
}

/** @param {number} x @param {number} y */
function guidePlaceVertex(x, y) {
  guide.pts.push([x, y]);
  refreshGuide();
  status(guide.pts.length < 2
    ? "1 point placed — a second makes a line"
    : `${guide.pts.length} points · ${guide.pts.length > 1 ? "the section sweeps along it" : ""}`,
  1600);
}

/** Everything on screen that describes the guide. One entry point. */
function refreshGuide() {
  const has = guide.pts.length > 0;
  $("guide-tools").hidden = !has;
  // ⚠️ THE STEPS STAY UP. They used to be hidden the moment the first point
  // landed — so the only instructions for the least obvious tool in the app
  // vanished exactly when they started being needed, and what replaced them was
  // six sliders and no sentence. There is no "finish the line" action to
  // discover: the curve is whatever has been clicked so far, and step 2 now
  // says so.
  // The gradient slider only means anything under a graded line.
  const along = /** @type {HTMLSelectElement} */ ($("guide-along")).value;
  $("guide-grad-field").hidden = along !== "grade";
  $("guide-profile-note").textContent = PROFILES[
    /** @type {HTMLSelectElement} */ ($("guide-profile")).value]?.note ?? "";
  $("guide-along-note").textContent = ALONG[along]?.note ?? "";

  const o = guideOpts();
  $("guide-w-val").textContent = `${o.width.toFixed(1)} m`;
  $("guide-d-val").textContent = `${o.depth.toFixed(2)} m`;
  $("guide-s-val").textContent = `${o.sideDeg.toFixed(0)}°`;
  $("guide-g-val").textContent = `${(o.gradient * 100).toFixed(1)}%`;

  const half = state.dem && guide.pts.length
    ? PROFILES[o.profile].halfWidth(o) : 0;
  state.plan.overlay?.setGuide(guide.pts, null, half);
  refreshGuidePreview();
}

/**
 * What the guide would cost, before anything moves.
 *
 * ⚠️ PRICED THROUGH THE SAME FUNCTION THAT WILL BUILD IT, dry — so the sentence
 * under the button cannot drift from the earthwork, which is the rule every
 * modifier in this tool now follows.
 */
function refreshGuidePreview() {
  const el = $("guide-preview");
  if (!state.dem || guide.pts.length < 2) {
    el.innerHTML = guide.pts.length === 1
      ? "One point is a place, not a line. Click again to give it a direction."
      : "";
    return;
  }
  const o = guideOpts();
  const r = applyGuide(state.dem, guide.pts, { ...o, dryRun: true });
  const m3 = (v) => `${v.toFixed(v < 10 ? 2 : 1)} m³`;
  const sign = r.net > 0 ? "imported onto site" : r.net < 0 ? "taken off site" : "moved";

  // ⚠️ THE LINE'S OWN BEHAVIOUR IS REPORTED, not just the volume. A graded line
  // on rolling ground MUST leave the surface — that is what a gradient means —
  // and how far it departs is the real consequence of the decision.
  let along = "";
  if (o.along === "grade") {
    along = ` Falling at <b>${(r.line.gradient * 100).toFixed(2)}%</b> over `
      + `<b>${r.length.toFixed(1)} m</b>, a total fall of `
      + `<b>${r.line.fall.toFixed(2)} m</b>. The line runs up to `
      + `<b>${r.line.maxAboveGround.toFixed(2)} m</b> above the existing ground `
      + `and <b>${r.line.maxBelowGround.toFixed(2)} m</b> below it — which is the `
      + `cut and fill a stated gradient actually costs on this landform.`;
  } else if (o.along === "level") {
    along = ` Held level at <b>${r.line.startZ.toFixed(2)} m</b>, so it stands up `
      + `to <b>${Math.max(r.line.maxAboveGround, r.line.maxBelowGround).toFixed(2)} m</b> `
      + `clear of the ground somewhere along its length. Water spreads along it `
      + `rather than running.`;
  } else {
    along = ` Riding the existing ground, so the structure keeps its shape and `
      + `the landform keeps its own fall.`;
  }

  const edge = r.batter.cells
    ? ` Grading its edges to meet existing ground adds `
      + `<b>${m3(r.batter.cut + r.batter.fill)}</b> over `
      + `<b>${r.batter.cells.toLocaleString("en")}</b> cells, running out to `
      + `<b>${r.maxRunM.toFixed(1)} m</b>.`
    : ` Its edges daylight inside the corridor, so there is no batter to pay for.`;

  // ⚠️ THE MOST IMPORTANT SENTENCE HERE. An embankment falls at its repose
  // angle; where the ground falls faster the two never meet, and the fill runs
  // to the boundary of the tile. The figures stay true and the design is
  // undrawable, so this is stated first and plainly rather than left inside a
  // volume the designer would have to reverse-engineer.
  const stuck = r.undaylit > 0
    ? ` ⚠️ <b>The edge never meets the ground</b> on `
      + `<b>${r.undaylit.toLocaleString("en")}</b> cells: here the landform `
      + `falls away faster than ${(o.fillAngleDeg ?? 34).toFixed(0)}°, `
      + `so an embankment at its repose angle cannot daylight and the fill runs `
      + `to the edge of the tile. Most of the volume above is that. Steepen the `
      + `fill face, cut the section deeper, or hold the line on gentler ground.`
    : "";

  const warn = r.stationJump > 0.05
    ? ` ⚠️ A bend carries a step of <b>${r.stationJump.toFixed(2)} m</b> in the `
      + `design level where two segments meet — ease the bend or reduce the `
      + `gradient.`
    : "";

  el.innerHTML =
    `A <b>${PROFILES[o.profile].label.split(" — ")[0].toLowerCase()}</b> `
    + `<b>${(2 * r.halfWidth).toFixed(2)} m</b> wide overall, swept `
    + `<b>${r.length.toFixed(1)} m</b>.${along}`
    + ` The section moves <b>${m3(r.section.cut)}</b> cut and `
    + `<b>${m3(r.section.fill)}</b> fill over `
    + `<b>${r.section.cells.toLocaleString("en")}</b> cells.${edge}`
    + ` Net <b>${r.net >= 0 ? "+" : "−"}${Math.abs(r.net).toFixed(1)} m³</b> ${sign}.`
    + stuck + warn;
}

function applyGuideNow() {
  if (!state.dem || !state.surface || guide.pts.length < 2) {
    status("trace a centreline first — two points make a line", 3000);
    return;
  }
  const o = guideOpts();
  beginEdit(false);
  const res = applyGuide(state.dem, guide.pts, { ...o, ledger: state.ledger });
  if (!res.cells) {
    status("the guide moves nothing here — it already matches the ground", 3000);
    return;
  }
  // ⚠️ THE RECT IS THE OPERATION'S, NOT THE CORRIDOR'S. A batter grades ground
  // outside the section, exactly as it does for a platform, so undo, repaint and
  // analysis all take the union rect applyGuide returns. Bounded by the corridor
  // the batter would be left standing after an undo and undrawn after a commit,
  // and both read as "the guide doesn't work".
  commitEdit(`${PROFILES[o.profile].label.split(" — ")[0].toLowerCase()} cut along a guide`, res);
  state.surface.updateRect(res.r0, res.c0, res.r1, res.c1);
  state.analysis?.invalidate(res);
  refreshSurfaceOverlays(true);
  if (state.water.on) refreshWater();
  updateLedger();
  state.analysis?.settle();
  planInvalidate();
  refreshGuide();
  status(`guide cut · section ${res.section.cells.toLocaleString("en")} cells, `
    + `batter ${res.batter.cells.toLocaleString("en")} · net `
    + `${res.net >= 0 ? "+" : "−"}${Math.abs(res.net).toFixed(1)} m³`, 4500);
}

// Populate the two vocabularies FROM THE KERNEL, so the interface cannot offer
// a section or a longitudinal mode that guide.js does not implement.
for (const [k, v] of Object.entries(PROFILES)) {
  /** @type {HTMLSelectElement} */ ($("guide-profile")).add(new Option(v.label, k));
}
for (const [k, v] of Object.entries(ALONG)) {
  /** @type {HTMLSelectElement} */ ($("guide-along")).add(new Option(v.label, k));
}
for (const id of ["guide-width", "guide-depth", "guide-side", "guide-grad"]) {
  $(id).addEventListener("input", refreshGuide);
}
for (const id of ["guide-profile", "guide-along"]) {
  $(id).addEventListener("change", refreshGuide);
}
$("guide-apply").addEventListener("click", applyGuideNow);
$("guide-clear").addEventListener("click", () => {
  // ⚠️ Clearing the LINE does not undo the earth it moved — the same rule
  // deleting a region follows. The ledger records what was done to the ground,
  // and the ground is still cut.
  guide.pts = [];
  refreshGuide();
  status("guide cleared — the earth it moved stands in the ledger", 3000);
});

function syncBenchLabels() {
  $("bench-int-val").textContent =
    `${parseFloat(/** @type {HTMLInputElement} */ ($("bench-interval")).value).toFixed(1)} m`;
  $("bench-tread-val").textContent =
    `${(parseFloat(/** @type {HTMLInputElement} */ ($("bench-tread")).value) * 100).toFixed(0)}%`;
  refreshBenchPreview();
}
for (const id of ["bench-interval", "bench-tread"]) {
  $(id).addEventListener("input", syncBenchLabels);
}
$("bench-bias").addEventListener("change", () => refreshBenchPreview());

/** Price the benches through the SAME function that will cut them. */
function benchOpts() {
  return {
    interval: parseFloat(/** @type {HTMLInputElement} */ ($("bench-interval")).value),
    tread: parseFloat(/** @type {HTMLInputElement} */ ($("bench-tread")).value),
    bias: /** @type {HTMLSelectElement} */ ($("bench-bias")).value,
  };
}

async function refreshBenchPreview() {
  const el = $("bench-preview");
  if (!state.dem) { el.textContent = ""; return; }
  const a = await maskNow();
  const mask = a ? a.mask : new Uint8Array(state.dem.nrows * state.dem.ncols).fill(1);
  const o = benchOpts();
  const p = benchTo(state.dem, mask, { ...o, dryRun: true });
  if (!p.cells) { el.textContent = "Nothing selected to bench."; return; }
  el.innerHTML =
    `Benching <b>${p.cells.toLocaleString("en")}</b> cells at <b>${o.interval.toFixed(1)} m</b> `
    + `intervals would cut <b>${p.cut.toFixed(1)} m³</b> and fill <b>${p.fill.toFixed(1)} m³</b>, `
    + `net <b>${p.net >= 0 ? "+" : "−"}${Math.abs(p.net).toFixed(1)} m³</b>. `
    + (Number.isFinite(p.treadMean)
      ? `Treads come out about <b>${p.treadMean.toFixed(1)} m</b> wide on this ground — `
        + `the interval divided by the slope, not a width you set.`
      : `This ground is too level for benches to have a meaningful tread.`);
}

$("bench-apply").addEventListener("click", async () => {
  if (!state.dem || !state.surface) return;
  const a = await maskNow();
  const mask = a ? a.mask : new Uint8Array(state.dem.nrows * state.dem.ncols).fill(1);
  // ⚠️ THE DIRTY RECT IS THE MASK'S, not the tile's — the same lesson the
  // batter taught: bound it too widely and every repaint costs the whole grid;
  // too narrowly and undo strands what it did not cover.
  const rect = a && a.count >= 0 ? maskRect(state.dem, mask)
    : { r0: 0, r1: state.dem.nrows - 1, c0: 0, c1: state.dem.ncols - 1 };
  if (rect.r1 < rect.r0) { status("nothing selected to bench", 3000); return; }
  beginEdit(false);
  const res = benchTo(state.dem, mask, { ...benchOpts(), ledger: state.ledger });
  commitEdit(`benched at ${benchOpts().interval.toFixed(1)} m`, rect);
  state.surface.updateRect(rect.r0, rect.c0, rect.r1, rect.c1);
  state.analysis?.invalidate(rect);
  refreshSurfaceOverlays(true);
  updateLedger();
  dropRuleGrids();       // the ground moved; a cached rule would be stale
  status(`benched ${res.cells.toLocaleString("en")} cells · `
    + `cut ${res.cut.toFixed(1)} m³ · fill ${res.fill.toFixed(1)} m³`, 5000);
});

/* ---------------------------------------------- the experiment, as a button */

/**
 * Run Phase 8E's uniform-vs-landform-patch measurement on the surface as it
 * stands, one target tread at a time, and grow the table between rows.
 *
 * ⚠️ THE ROWS ARE RUN WITH A PAINT BETWEEN THEM — each is a second-ish of
 * geomorphon passes and floods, and running all five synchronously reads as
 * the tool hanging. The yield is a setTimeout, NOT requestAnimationFrame: with
 * the pane hidden rAF never fires (the trap Phase 8D recorded), and a check
 * driving this button headless would wait forever on a frame that never comes.
 *
 * ⚠️ NOTHING HERE EDITS THE SURFACE — compare.js runs on clones — so there is
 * no beginEdit, no dirty rect, no undo entry, and the analysis is not
 * invalidated. The experiment is a reading, not an operation.
 */
$("bench-compare").addEventListener("click", async () => {
  if (!state.dem) return;
  const btn = /** @type {HTMLButtonElement} */ ($("bench-compare"));
  const out = $("bench-compare-out");
  const paint = () => new Promise((r) => setTimeout(r, 0));
  btn.disabled = true;
  out.hidden = false;
  const fmt = {
    // ⚠️ TWO DECIMALS, NOT THREE. Phase 8E measured the uniform geodiversity
    // twice at the same tread as 0.6306 and 0.6157 — the third decimal is
    // where the volume-matching search's convergence noise lives, and quoting
    // it would print noise as measurement.
    g: (v) => v.toFixed(2), h: (v) => v.toFixed(2),
    n: (v) => v.toLocaleString("en"), m3: (v) => v < 10 ? v.toFixed(1) : v.toFixed(0),
  };
  try {
    out.innerHTML = `<div class="base">Reading the untouched surface…</div>`;
    await paint();
    const base = measureSurface(state.dem);
    const baseLine = `Untouched, this ground reads geodiversity <b>${fmt.g(base.geodiversity)}</b> · `
      + `landform H′ <b>${fmt.h(base.landformH)}</b> · <b>${fmt.n(base.hollows)}</b> hollows · `
      + `peak outfall <b>${fmt.m3(base.peakOutfall)} m³</b>.`;
    const head = `<table><thead><tr><th>tread</th><th>volume</th>`
      + `<th>geodiv.</th><th>H′</th><th>hollows</th><th>outfall</th></tr></thead><tbody>`;
    const rows = [];
    const cells = [];
    const render = (note) => {
      out.innerHTML = `<div class="base">${baseLine}</div>`
        + head + cells.join("") + `</tbody></table>`
        + (note ? `<div class="base">${note}</div>` : "");
    };
    for (const t of EXPERIMENT.treads) {
      render(`Measuring the ${t} m tread…`);
      await paint();
      const row = compareAt(state.dem, t);
      if (!row) continue;
      rows.push(row);
      // Uniform first, patch second and bold — the design document's own
      // typography. The tilde marks a row whose volume match fell outside the
      // stated tolerance rather than silently printing it as matched.
      const pair = (a, b, f) => `${f(a)} → <b>${f(b)}</b>`;
      cells.push(`<tr title="uniform Δ ${row.uniformInterval.toFixed(2)} m · `
        + `${row.patchCount.toLocaleString("en")} patches, ${row.patchesBenched} on their own system">`
        + `<td>${t} m${row.matched ? "" : " ~"}</td><td>${fmt.m3(row.volume)} m³</td>`
        + `<td>${pair(row.uniform.geodiversity, row.patch.geodiversity, fmt.g)}</td>`
        + `<td>${pair(row.uniform.landformH, row.patch.landformH, fmt.h)}</td>`
        + `<td>${pair(row.uniform.hollows, row.patch.hollows, fmt.n)}</td>`
        + `<td>${pair(row.uniform.peakOutfall, row.patch.peakOutfall, fmt.m3)}</td></tr>`);
      render();
      await paint();
    }
    if (!rows.length) {
      // The boot tile takes this path: level ground benches to itself, both
      // schemes move nothing, and a comparison of two zeros is not a result.
      out.innerHTML = `<div class="base">This ground is level — both schemes `
        + `leave it untouched, and there is nothing to compare. Shape it `
        + `first, or load surveyed ground.</div>`;
    } else {
      render(`Each row: uniform → <b>by patch</b>, at the same volume `
        + `(uniform Δ found by search; ~ marks a match outside ±${(EXPERIMENT.matchTol * 100).toFixed(0)}%). `
        + `Tread share ${(EXPERIMENT.treadShare * 100).toFixed(0)}%, balanced, `
        + `rain event ${(EXPERIMENT.rainM * 1000).toFixed(0)} mm, patches under `
        + `${EXPERIMENT.minCells} cells take the default system. `
        + `The direction is the result; the decimals move with the matched interval.`);
    }
  } finally {
    btn.disabled = false;
  }
});

/* --------------------------------------------- the landform patchwork, drawn */

/**
 * The partition the experiment benches, made visible: seams between workable
 * patches, and each patch's terrace line as a tick. See patch-view.js for
 * what is drawn and what is deliberately not.
 * @type {import("./patch-view.js").PatchOverlay|null}
 */
let patchOverlay = null;

$("t-patches").addEventListener("click", () => {
  if (!state.dem) return;
  const btn = $("t-patches");
  const on = !btn.classList.contains("on");
  btn.classList.toggle("on", on);
  if (!on) {
    patchOverlay?.setVisible(false);
    status("patchwork hidden", 1500);
    return;
  }
  // ⚠️ COMPUTED AT THE PRESS, from the surface as it stands — the same
  // contract as a rule. While it stays on, edits re-drape the lines but never
  // re-partition; pressing the button again is how you ask for the current
  // ground's patchwork, and it stays a click.
  const gm = geomorphons(state.dem);
  const grad = computeGradient(state.dem);
  const only = LANDFORMS.map((_, code) => code);
  const { labels, patches } = landformPatches(state.dem, gm.codes,
    { slopeDeg: grad.slopeDeg, aspectDeg: grad.aspectDeg, only });
  if (!patchOverlay) {
    patchOverlay = new PatchOverlay(state.dem,
      { verticalExaggeration: currentExaggeration() });
    view.scene.add(patchOverlay.group);
  }
  patchOverlay.setExaggeration(currentExaggeration());
  patchOverlay.setPartition(labels, patches);
  patchOverlay.setVisible(true);
  const workable = patches.filter((p) => p.cells >= patchOverlay.minCells).length;
  status(`${patches.length.toLocaleString("en")} patches, `
    + `${workable.toLocaleString("en")} workable (≥ ${patchOverlay.minCells} cells) · `
    + `${patchOverlay.count.toLocaleString("en")} seam edges · `
    + `${patchOverlay.tickCount.toLocaleString("en")} terrace lines`, 6000);
});

{
  const zone = $("soil-dropzone");
  const input = /** @type {HTMLInputElement} */ ($("soil-file"));

  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    if (f) loadSubstrateFile(f).catch(fail);
    input.value = "";
  });

  for (const ev of ["dragenter", "dragover"]) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add("dragover");
    });
  }
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("dragover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.tiff?$/i.test(f.name)) {
      status(`${f.name} is not a GeoTIFF`, 4000);
      return;
    }
    loadSubstrateFile(f).catch(fail);
  });

  $("soil-clear").addEventListener("click", () => {
    if (!state.substrate) { status("no substrate map loaded"); return; }
    adoptSubstrate(null, "");
    status("substrate cleared");
  });
}

/* --------------------------------------------------------- pattern stamping */

/**
 * Amplitude from the slider, LOGARITHMICALLY.
 *
 * The control has to reach a 10 mm construction tolerance and a 2 m designed
 * landform on one track. Linear, the entire tolerance band — the range where
 * this tool's own published finding lives — would occupy the first two steps of
 * a hundred, and the number that matters most would be the one hardest to set.
 */
function patternAmplitude() {
  const v = parseFloat(/** @type {HTMLInputElement} */ ($("pat-amp")).value) / 100;
  return 0.005 * Math.pow(400, v);
}

/**
 * Where the stamp lands: a selected region if there is one, the whole tile
 * otherwise.
 *
 * ⚠️ THE REGION'S MASK, NOT ITS BOUNDING BOX. A traced ring is rarely
 * rectangular, and stamping its extent would put pattern outside the polygon
 * the user drew — on ground they did not select — while the ledger reported it
 * as part of the same operation.
 */
function patternExtent() {
  if (!state.dem) return null;
  const { nrows, ncols } = state.dem;
  const ext = state.plan.selected ? planExtent() : null;
  if (ext && ext.count) {
    return {
      mask: ext.mask, r0: ext.r0, c0: ext.c0, r1: ext.r1, c1: ext.c1,
      cells: ext.count, label: state.plan.selected.name,
    };
  }
  return {
    mask: null, r0: 0, c0: 0, r1: nrows - 1, c1: ncols - 1,
    cells: nrows * ncols, label: "the whole patch",
  };
}

/**
 * The pattern as a 0..1 field on the DEM's own grid, or null if there is
 * nothing to stamp.
 *
 * Rebuilt from the source every time rather than cached: the generated field is
 * a pure function of (grid, wavelength, seed) and an image resample is a few
 * milliseconds, so caching would buy nothing and would be one more thing that
 * can go stale when the region selection changes under it.
 */
function patternField(extent) {
  if (!state.dem || !extent) return null;
  const { nrows, ncols, cell } = state.dem;
  if (state.pattern.source === "generated") {
    return proceduralField(state.pattern.id, nrows, ncols, cell, {
      module: state.pattern.wavelength,
      seed: state.pattern.seed,
      mask: extent.mask,
    });
  }
  if (!state.pattern.src) return null;
  return resampleField(state.pattern.src, state.pattern.sw, state.pattern.sh,
    nrows, ncols, { r0: extent.r0, c0: extent.c0, r1: extent.r1, c1: extent.c1 });
}

/**
 * The thumbnail, the handle positions and the cost line.
 *
 * ⚠️ THE THUMBNAIL IS DRAWN THROUGH `analysis/ramps.js`, on the cut/fill ramp,
 * at the amplitude and bias actually set. So it is not a picture of the file —
 * it is a preview of the earthwork in the same colours the Cut/fill panel will
 * show once the stamp is committed, and it cannot drift from them, because
 * there is one ramp and one sign convention behind both.
 */
function refreshPattern() {
  const p = state.pattern;
  const lo = /** @type {HTMLElement} */ ($("pat-levels").querySelector(".h.lo"));
  const hi = /** @type {HTMLElement} */ ($("pat-levels").querySelector(".h.hi"));
  lo.style.left = `${p.lo * 100}%`;
  hi.style.left = `${p.hi * 100}%`;
  $("pat-lo-val").textContent = `${(p.lo * 100).toFixed(0)}%`;
  $("pat-hi-val").textContent = `${(p.hi * 100).toFixed(0)}%`;
  const amp = patternAmplitude();
  $("pat-amp-val").textContent = `±${amp.toFixed(3)} m`;
  $("pat-wave-val").textContent = `${p.wavelength.toFixed(1)} m`;

  const cv = /** @type {HTMLCanvasElement} */ ($("pat-thumb"));
  const ctx = cv.getContext("2d");
  const extent = patternExtent();
  const field = patternField(extent);
  const apply = /** @type {HTMLButtonElement} */ ($("pat-apply"));

  if (!ctx) return;
  if (!field || !extent || !state.dem) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    $("pat-thumb-note").textContent = "no pattern";
    $("pat-preview").textContent = "";
    apply.disabled = true;
    return;
  }
  apply.disabled = false;

  const { nrows, ncols } = state.dem;
  const img = ctx.createImageData(cv.width, cv.height);
  const dom = /** @type {[number, number]} */ ([-amp, amp]);
  for (let y = 0; y < cv.height; y++) {
    const r = Math.min(nrows - 1, Math.floor((y / cv.height) * nrows));
    for (let x = 0; x < cv.width; x++) {
      const c = Math.min(ncols - 1, Math.floor((x / cv.width) * ncols));
      const i = r * ncols + c;
      const q = (y * cv.width + x) * 4;
      // Ground outside the stamp is left blank rather than drawn neutral, so
      // the thumbnail shows the SHAPE of the area being worked as well as the
      // pattern going onto it.
      if (extent.mask && !extent.mask[i]) { img.data[q + 3] = 0; continue; }
      const span = p.hi - p.lo;
      const t = span > 0 ? Math.min(1, Math.max(0, (field[i] - p.lo) / span)) : 0.5;
      const s = ((t - 0.5) * 2) * (p.invert ? -1 : 1);
      const [rr, gg, bb] = sample("cutfill", s * amp, dom, state.variant.cutfill);
      img.data[q] = rr; img.data[q + 1] = gg; img.data[q + 2] = bb; img.data[q + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const def = PATTERN_BY_ID[p.id];
  $("pat-thumb-note").textContent = p.source === "generated"
    ? `${def ? def.name : p.id} · ${p.wavelength.toFixed(1)} m`
      + (def && def.seeded ? ` · seed ${p.seed}` : "")
    : p.name || "image";

  const cost = patternCost(state.dem, field, {
    amplitude: amp, lo: p.lo, hi: p.hi, invert: p.invert, mask: extent.mask,
  });
  const sign = cost.net > 0 ? "imported onto site" : cost.net < 0 ? "taken off site" : "moved";
  $("pat-preview").innerHTML =
    `Stamping <b>${extent.cells.toLocaleString("en")}</b> cells of ${extent.label} at ` +
    `<b>±${amp.toFixed(3)} m</b>` +
    (p.source === "generated" ? ` on a <b>${p.wavelength.toFixed(1)} m</b> wavelength` : "") +
    ` would cut <b>${cost.cut.toFixed(1)} m³</b> and fill <b>${cost.fill.toFixed(1)} m³</b> — ` +
    `net <b>${cost.net >= 0 ? "+" : "−"}${Math.abs(cost.net).toFixed(1)} m³</b> ${sign}.`;
}

/**
 * Draw one library pattern into a canvas, through the SAME cut/fill ramp the
 * stamp preview and the Cut/fill panel use.
 *
 * ⚠️ THE PICKER SHOWS EARTHWORK, NOT TEXTURE, and that is the whole reason it is
 * a grid of pictures rather than a list of names. Rendered in the ramp, a
 * lozenge reads immediately as alternating cut and fill; rendered in grey it
 * would read as a tile pattern, and the white end would vanish into a panel that
 * is deliberately white.
 *
 * Drawn on a fixed 64 m square at 1 m cells regardless of the loaded tile, so
 * every swatch is the same ground area and the modules are comparable by eye.
 * @param {HTMLCanvasElement} cv @param {string} id @param {number} module @param {number} seed
 */
function renderPatternSwatch(cv, id, module, seed) {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const N = 64;
  const f = proceduralField(id, N, N, 1, { module, seed });
  const img = ctx.createImageData(cv.width, cv.height);
  const dom = /** @type {[number, number]} */ ([-1, 1]);
  for (let y = 0; y < cv.height; y++) {
    const r = Math.min(N - 1, Math.floor((y / cv.height) * N));
    for (let x = 0; x < cv.width; x++) {
      const c = Math.min(N - 1, Math.floor((x / cv.width) * N));
      const [rr, gg, bb] = sample("cutfill", (f[r * N + c] - 0.5) * 2, dom,
        state.variant.cutfill);
      const q = (y * cv.width + x) * 4;
      img.data[q] = rr; img.data[q + 1] = gg; img.data[q + 2] = bb; img.data[q + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Build the picker grid once, then keep it in step with the current choice. */
function renderPatternLibrary() {
  const host = $("pat-library");
  if (!host.childElementCount) {
    for (const p of PATTERNS) {
      const fig = document.createElement("figure");
      fig.dataset.pid = p.id;
      const cv = document.createElement("canvas");
      cv.width = 64; cv.height = 64;
      const cap = document.createElement("figcaption");
      cap.textContent = p.name;
      fig.append(cv, cap);
      fig.title = p.note;
      fig.addEventListener("click", () => {
        state.pattern.id = p.id;
        host.hidden = true;
        syncPatternLibrary();
        refreshPattern();
        status(`pattern: ${p.name}`, 1600);
      });
      host.appendChild(fig);
    }
  }
  for (const fig of host.children) {
    const id = /** @type {HTMLElement} */ (fig).dataset.pid;
    renderPatternSwatch(/** @type {HTMLCanvasElement} */ (fig.querySelector("canvas")),
      id, state.pattern.wavelength, state.pattern.seed);
    fig.classList.toggle("on", id === state.pattern.id);
  }
}

/** The picker button, the note, and whether a seed control makes sense. */
function syncPatternLibrary() {
  const def = PATTERN_BY_ID[state.pattern.id] || PATTERNS[0];
  $("pat-pick").textContent = `${def.name} ▾`;
  // The note, then what this pattern actually did under stated conditions. The
  // measurement is the reason the library exists, so it belongs next to the
  // choice rather than in a document nobody has open.
  const m = PATTERN_MEASURED[def.id];
  $("pat-pattern-note").innerHTML = def.note + (m
    ? `<br><b>Measured</b> on this patch at ±0.21 m, 8 m module: Shannon `
      + `<b>${m.H.toFixed(3)}</b>, <b>${m.classes} of 7</b> classes, invasive `
      + `<b>${m.invasive.toFixed(1)}%</b>, moving ${m.cut} m³ cut / ${m.fill} m³ fill `
      + `— against 1.721, 7 of 7 and 33.2% as surveyed, and 836 m³ each way to level it.`
    // ⚠️ SILENCE WOULD READ AS "NO EFFECT". A pattern with no measured row used
    // to print nothing at all beside its note, which next to eleven patterns
    // that DO print figures reads as a pattern that was measured and found to do
    // nothing. It has to say which it is.
    : "<br><b>Not yet measured.</b> Added 2026-08-19 and not yet through the "
      + "protocol the figures above come from — identical amplitude, module and "
      + "volume on the real patch. Its place in the range is the designer's "
      + "expectation until it has been.");
  // A reseed button on a deterministic pattern would be a control that does
  // nothing — the honest thing is for it not to be there.
  $("pat-seed-row").hidden = !def.seeded;
  renderPatternLibrary();
}

/** Read an image file into a 0..1 field at its own pixel size. */
async function loadPatternFile(file) {
  const bmp = await createImageBitmap(file);
  // Cap the source: a 6000 px photograph carries no information a 0.25 m grid
  // can hold, and decoding it into a Float32Array costs 144 MB to throw away.
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2D context for the pattern");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const data = ctx.getImageData(0, 0, w, h).data;
  state.pattern.src = fieldFromRGBA(data, w, h);
  state.pattern.sw = w;
  state.pattern.sh = h;
  state.pattern.name = `${file.name} · ${w}×${h}`;
  setPatternSource("image");
  refreshPattern();
  status(`pattern ${file.name} loaded`);
}

/** @param {"image"|"generated"} src */
function setPatternSource(src) {
  state.pattern.source = src;
  for (const b of document.querySelectorAll("button.psrc")) {
    b.classList.toggle("on", /** @type {HTMLElement} */ (b).dataset.psrc === src);
  }
  $("pat-src-image").hidden = src !== "image";
  $("pat-src-generated").hidden = src !== "generated";
  if (src === "generated") syncPatternLibrary();
  refreshPattern();
}

/** Commit the stamp. */
async function applyPatternStamp() {
  if (!state.dem || !state.surface || !state.analysis) return;
  const extent = patternExtent();
  const field = patternField(extent);
  if (!field || !extent) { status("no pattern to stamp"); return; }
  const p = state.pattern;
  const amp = patternAmplitude();

  // ⚠️ THE RULE NARROWS EVERY MODIFIER, NOT JUST THE BENCHES (2026-08-11).
  // A selection is only worth having if it feeds whatever comes next — "the
  // steep north-facing ground" is a place, and the designer decides what to do
  // there afterwards. The stamp's own extent mask is intersected with the
  // rule, never replaced by it, so a region still bounds the stamp as before.
  // ⚠️ extent.mask IS NULL WHEN NO REGION IS SELECTED — that is how the stamp
  // says "the whole tile", not an empty selection. Intersecting into it
  // without checking threw on the commonest case there is: a stamp with no
  // region drawn.
  let mask = extent.mask;
  if (selectionArmed()) {
    const a = await maskNow();
    if (a && a.count === 0) { status("the selection is empty — nothing to stamp", 4000); return; }
    if (a && a.mask) {
      if (!mask) mask = a.mask;
      else {
        const m = new Uint8Array(mask.length);
        for (let i = 0; i < m.length; i++) m[i] = mask[i] && a.mask[i] ? 1 : 0;
        mask = m;
      }
    }
  }

  beginEdit();
  // ⚠️ applyPattern ACCUMULATES into the Ledger, like every other earthwork in
  // this tool. Ledger has no add(); it has cut and fill fields and derived
  // net/banked getters. A stamp is one more operation on the same site.
  const res = applyPattern(state.dem, field, {
    amplitude: amp, lo: p.lo, hi: p.hi, invert: p.invert,
    mask, ledger: state.ledger,
  });
  if (!res.cells) {
    abandonEdit();
    status("the pattern moved nothing — check the amplitude");
    return;
  }
  const def = PATTERN_BY_ID[p.id];
  commitEdit(p.source === "generated" && def ? `${def.name} stamp` : "pattern stamp", res.rect);

  state.surface.updateRect(res.rect.r0, res.rect.c0, res.rect.r1, res.rect.c1);
  refreshSurfaceOverlays(true);
  if (state.water.on) refreshWater();
  updateLedger();
  state.analysis.invalidate(res.rect);
  state.analysis.settle();
  // The ground under every ring has moved, so the elevation ranges the level
  // slider is bounded by are stale — same reason applyPlanLevel invalidates.
  planInvalidate();
  refreshPlan();
  refreshPattern();
  status(`pattern stamped over ${res.cells.toLocaleString("en")} cells · ` +
    `net ${res.net >= 0 ? "+" : "−"}${Math.abs(res.net).toFixed(1)} m³`, 4000);
}

{
  const zone = $("pat-dropzone");
  const input = /** @type {HTMLInputElement} */ ($("pat-file"));

  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    if (f) loadPatternFile(f).catch(fail);
    input.value = "";
  });
  for (const ev of ["dragenter", "dragover"]) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      zone.classList.add("dragover");
    });
  }
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  // Stops propagation for the same reason the substrate zone does: the
  // window-wide handler would otherwise try to read the drop as a DEM.
  zone.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove("dragover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { status(`${f.name} is not an image`, 4000); return; }
    loadPatternFile(f).catch(fail);
  });

  for (const b of document.querySelectorAll("button.psrc")) {
    b.addEventListener("click", () => setPatternSource(
      /** @type {any} */ (/** @type {HTMLElement} */ (b).dataset.psrc || "image")));
  }

  $("pat-amp").addEventListener("input", refreshPattern);
  $("pat-wave").addEventListener("input", () => {
    state.pattern.wavelength = parseFloat(/** @type {HTMLInputElement} */ ($("pat-wave")).value);
    // The swatches are drawn at the live module, so the picker shows what each
    // pattern would do at the size actually set rather than at some house scale.
    renderPatternLibrary();
    refreshPattern();
  });
  $("pat-reseed").addEventListener("click", () => {
    state.pattern.seed = (state.pattern.seed % 9999) + 1;
    renderPatternLibrary();
    refreshPattern();
    status(`seed ${state.pattern.seed}`, 1200);
  });
  /**
   * Open or close the twelve-pattern library.
   *
   * ⚠️ THE PREVIEW OPENS IT TOO, and that is the affordance that was missing.
   * The thumbnail is the biggest thing in the panel and it shows exactly one of
   * twelve options, so it reads as the control for choosing between them — but
   * the only way in was a text button above it, and the library is the part of
   * this tool with the strongest measured result behind it (Shannon 0.163 to
   * 1.724 at identical amplitude, module and volume). A picker nobody opens is
   * an argument nobody sees.
   */
  const togglePatternLibrary = () => {
    const lib = $("pat-library");
    lib.hidden = !lib.hidden;
    if (!lib.hidden) {
      // Picking from the library only means anything for a generated source, so
      // opening it from an image thumbnail switches over rather than showing
      // twelve choices that would not take effect.
      if (state.pattern.source !== "generated") setPatternSource("generated");
      renderPatternLibrary();
      lib.scrollIntoView({ block: "nearest" });
    }
  };
  $("pat-pick").addEventListener("click", togglePatternLibrary);
  $("pat-thumb-wrap").addEventListener("click", togglePatternLibrary);
  $("pat-invert").addEventListener("change", () => {
    state.pattern.invert = /** @type {HTMLInputElement} */ ($("pat-invert")).checked;
    refreshPattern();
  });
  $("pat-apply").addEventListener("click", applyPatternStamp);

  // The two handles. Deliberately NOT routed through addStretchHandles(): that
  // function is bound to a layer key, DEFAULT_CUTS and the worker's re-colour
  // path, none of which apply here. It shares the markup and the CSS so the
  // control reads as the same control, which is the part that matters.
  const bar = /** @type {HTMLElement} */ ($("pat-levels").querySelector(".bar"));
  const drag = (handle, which) => {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // Same guard as view.js:363 and addStretchHandles: a pointer id that never
      // belonged to a real pointer makes setPointerCapture throw, and an uncaught
      // throw would abort before the move listener is attached — leaving the
      // handle dead to anything but a physical mouse, including any harness.
      try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const rect = bar.getBoundingClientRect();
      const move = (ev) => {
        const f = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
        // Keep a visible gap: a zero-width window makes every grey level either
        // full cut or full fill, which reads as the pattern turning into a
        // two-tone stencil for no apparent reason.
        if (which === 0) state.pattern.lo = Math.min(f, state.pattern.hi - 0.02);
        else state.pattern.hi = Math.max(f, state.pattern.lo + 0.02);
        refreshPattern();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  };
  drag($("pat-levels").querySelector(".h.lo"), 0);
  drag($("pat-levels").querySelector(".h.hi"), 1);
  for (const h of $("pat-levels").querySelectorAll(".h")) {
    h.addEventListener("dblclick", () => {
      state.pattern.lo = 0; state.pattern.hi = 1;
      refreshPattern();
    });
  }
}

/* -------------------------------------------------------------------- water */

/**
 * Rainfall depth from the slider, LOGARITHMICALLY, 0.1–100 mm.
 *
 * The band that decides anything on this patch is below 2 mm — that is where
 * hollows are still partly full and the surface is still choosing what to keep.
 * Above about 5 mm every hollow on the design patch is brim-full and the answer
 * stops changing shape, it only changes magnitude. A linear track would spend
 * ninety of its hundred steps in the part that says the same thing.
 */
function rainfallDepth() {
  const v = parseFloat(/** @type {HTMLInputElement} */ ($("rain")).value) / 100;
  return 0.0001 * Math.pow(1000, v);   // 0.1 mm .. 100 mm, in metres
}

/**
 * Settle one rainfall event on the surface as it stands, and report it.
 *
 * ⚠️ THIS RUNS ON THE MAIN THREAD, DELIBERATELY, AND ONLY ON DEMAND. The
 * priority flood it rides on is the expensive part and the worker already
 * computes one for the depression panel — but the worker's copy belongs to a
 * pass that may be several gestures old, and water standing in hollows that
 * have since been filled in would be worse than no water at all. It is
 * recomputed here from the live DEM whenever the ground or the rainfall
 * changes, and the measured cost is what justifies it (self-test group T).
 */
function refreshWater() {
  const w = state.water;
  $("t-water").classList.toggle("on", w.on);
  $("water-tools").hidden = !w.on;
  if (!state.dem) return;

  if (!w.on) {
    w.result = null;
    w.field?.setPonding(null);
    w.field?.setVisible(false);
    // The diagram and the pins describe an event that is no longer being
    // routed. Left standing they are a picture of the last one, which reads as
    // current.
    drawWaterChart([]);
    refreshPondPins([]);
    return;
  }

  const res = pondWater(state.dem, w.rain, { substrate: state.substrate });
  w.result = res;

  if (!w.field) {
    w.field = new WaterField(state.dem, { verticalExaggeration: currentExaggeration() });
    view.scene.add(w.field.group);
  }
  w.field.setExaggeration(currentExaggeration());
  // ⚠️ THE WATER FOLLOWS THE TERRAIN'S OWN BLOCK SIZE. Drawn per DEM cell while
  // the ground stands in blocks, the two are different drawings of the same
  // place at different resolutions, and the water sinks into every rising step
  // and overhangs every falling one. The terrain's base plate and cube height go
  // across as well, because voxels.js QUANTISES a block's top rather than
  // drawing it at the block's mean — water put at the mean is inside the block.
  const vox = state.representation === "voxel"
    ? /** @type {any} */ (state.surface) : null;
  w.field.setBlocks(vox
    ? { cells: vox.blockCells, baseZ: vox.baseZ, quantum: vox.voxelHeight }
    : null);
  w.field.setPonding(w.blocks ? res : null);
  w.field.setVisible(w.blocks);

  const mm = (v) => `${(v * 1000).toFixed(1)} mm`;
  const m3 = (v) => `${v.toFixed(v < 10 ? 2 : 1)} m³`;
  $("rain-val").textContent = mm(w.rain);
  $("w-delivered").textContent = m3(res.delivered);
  $("w-retained").textContent = m3(res.retained);
  $("w-runoff").textContent = m3(res.runoff);
  $("w-infiltrated").textContent = m3(res.infiltrated);
  $("w-frac").textContent = `${(res.retainedFraction * 100).toFixed(1)}%`;
  $("w-area").textContent = res.pondedArea > 0
    ? `${res.pondedArea.toFixed(1)} m² · ${(100 * res.pondedArea / (state.dem.ncols * state.dem.nrows * state.dem.cell * state.dem.cell)).toFixed(1)}%`
    : "none";
  $("w-max").textContent = res.maxDepth > 0 ? mm(res.maxDepth) : "—";
  $("w-full").textContent = `${res.fullPonds.toLocaleString("en")} of ${res.ponds.toLocaleString("en")}`;
  $("w-capacity").textContent = m3(res.capacity);
  // ⚠️ WHERE IT LEAVES, not only how much. A runoff total answers half the
  // question; the half a municipality is actually held to is which point of the
  // boundary delivers it, because that is where a pipe, a swale or a consent
  // has to exist. It also shows what the total hides: levelling does not merely
  // lose the water, it concentrates it into fewer and bigger outfalls.
  const of = res.outfalls || [];
  $("w-outfalls").textContent = of.length
    ? `${of.length} · largest ${m3(of[0].volume)}`
    : "none";

  // ⚠️ THE DISTRIBUTION, WHICH THE TOTALS ABOVE CANNOT SHOW. Twenty bodies of a
  // third of a cubic metre and one of six and a half are the same "held on the
  // surface" figure and completely different ground. The median is quoted
  // alongside the largest for the same reason a mean would not do: these
  // distributions are strongly skewed, and a mean sits above almost every body
  // in the set.
  const bodies = res.waterbodies || [];
  $("w-bodies").textContent = bodies.length
    ? bodies.length.toLocaleString("en")
    : "none";
  $("w-largest").textContent = bodies.length ? fmtVolume(bodies[0].volume) : "—";
  $("w-median").textContent = bodies.length
    ? fmtVolume(bodies[Math.floor(bodies.length / 2)].volume)
    : "—";
  drawWaterChart(bodies);
  refreshPondPins(bodies);

  // ⚠️ THE NUMBER THE WHOLE LAYER EXISTS TO PRODUCE. Below this depth the
  // ground takes the event into its own relief; above it, the ground sheds.
  // On a levelled surface it is zero — which states five separate collapses as
  // one figure, in millimetres, in the units a drainage specification is
  // already written in.
  const areaM2 = state.dem.ncols * state.dem.nrows * state.dem.cell * state.dem.cell;
  const absorb = absorbedDepth(res.capacity, areaM2);
  $("w-absorb").textContent = absorb > 0 ? mm(absorb) : "0.0 mm";
  $("water-note").innerHTML = absorb > 0
    ? `This surface absorbs the first <b>${mm(absorb)}</b> of any event into its `
      + `own relief. Beyond that it sheds. At <b>${mm(w.rain)}</b> it keeps `
      + `<b>${m3(res.retained)}</b> in <b>${res.ponds.toLocaleString("en")}</b> `
      + `hollows and passes <b>${m3(res.runoff)}</b> across its edge.`
    : `This surface absorbs <b>nothing</b>. There is no closed hollow left on it, `
      + `so every one of the <b>${m3(res.delivered)}</b> delivered leaves across `
      + `the edge. Flattening did not produce neutral ground — it produced a roof.`;
}

/**
 * The water-body diagram, drawn on the sidebar canvas.
 *
 * ⚠️ DEVICE PIXELS, NOT CSS PIXELS. The canvas carries a fixed backing store and
 * is laid out by CSS at whatever width the panel is; drawing in CSS units on a
 * 2× display renders at half resolution and the axis text goes to mush. The
 * backing store is the authority here and the drawing is done in its units.
 * @param {any[]} bodies
 */
function drawWaterChart(bodies) {
  const cv = /** @type {HTMLCanvasElement} */ ($("w-chart"));
  if (!cv) return;
  const g = cv.getContext("2d");
  if (!g) return;
  drawWaterBodies(g, bodies, {
    w: cv.width, h: cv.height, mode: waterPlotMode, theme: THEMES.paper,
  });
  // ⚠️ THE OMISSION IS STATED. The chart draws every body; the PINS draw the
  // largest few, and a reader who has just counted 300 bars needs to know why
  // the model carries four labels.
  const note = $("w-chart-note");
  if (!note) return;
  if (!bodies.length) {
    note.textContent = "";
    return;
  }
  const full = bodies.filter((b) => b.full).length;
  note.textContent = waterPlotMode === "rank"
    ? `${bodies.length.toLocaleString("en")} bodies, largest first — `
      + `${full.toLocaleString("en")} filled to the spill point (solid), the rest `
      + `still with capacity in hand. Log scale: the largest here is `
      + `${(bodies[0].volume / Math.max(bodies[bodies.length - 1].volume, 1e-9)).toFixed(0)}× the smallest.`
    : `Area against volume, log–log. The dashed diagonals are constant mean `
      + `depth — 10 mm, 100 mm and 1 m — so a body's height above them is how `
      + `deep it stands, not how big it is.`;
}

/** Which of the two diagrams is showing. */
let waterPlotMode = "rank";

/**
 * The volume labels on the model.
 *
 * ⚠️ THE LARGEST TWELVE, NOT ALL OF THEM. A 20 mm event on the design patch
 * settles into hundreds of hollows of a few litres each; a label on every one is
 * a wall of text over the terrain that hides the four bodies the design is
 * actually about. The count left unlabelled is reported rather than dropped.
 * @type {import("./pond-view.js").PondPins|null}
 */
let pondPins = null;
let pondPinsOn = false;
const POND_PIN_MAX = 12;

/** @param {any[]} bodies */
function refreshPondPins(bodies) {
  $("t-wpins")?.classList.toggle("on", pondPinsOn);
  if (!state.dem) return;
  if (!pondPins) {
    pondPins = new PondPins(state.dem, { verticalExaggeration: currentExaggeration() });
    view.scene.add(pondPins.group);
  }
  pondPins.setExaggeration(currentExaggeration());
  pondPins.setBodies(pondPinsOn ? bodies : null, { max: POND_PIN_MAX });
  pondPins.setVisible(pondPinsOn && !!bodies.length);
}

for (const b of document.querySelectorAll("button.wplot")) {
  b.addEventListener("click", () => {
    waterPlotMode = /** @type {HTMLElement} */ (b).dataset.wplot || "rank";
    for (const o of document.querySelectorAll("button.wplot")) {
      o.classList.toggle("on", o === b);
    }
    drawWaterChart(state.water.result?.waterbodies || []);
  });
}

$("t-wpins").addEventListener("click", () => {
  pondPinsOn = !pondPinsOn;
  const bodies = state.water.result?.waterbodies || [];
  refreshPondPins(bodies);
  status(pondPinsOn
    ? (pondPins && pondPins.omitted
      ? `labelling the largest ${pondPins.count} of ${bodies.length} water bodies`
      : `${bodies.length} water bodies labelled`)
    : "volume pins off", 3000);
});

$("t-water").addEventListener("click", () => {
  state.water.on = !state.water.on;
  refreshWater();
  status(state.water.on ? "rainfall on" : "rainfall off", 1200);
});

$("rain").addEventListener("input", () => {
  state.water.rain = rainfallDepth();
  refreshWater();
});

for (const b of document.querySelectorAll("button.wshow")) {
  b.addEventListener("click", () => {
    state.water.blocks = /** @type {HTMLElement} */ (b).dataset.wshow === "blocks";
    for (const o of document.querySelectorAll("button.wshow")) {
      o.classList.toggle("on", o === b);
    }
    refreshWater();
  });
}

/* -------------------------------------------------------- instrument mode */

// ⚠️ PAPER IS THE DEFAULT. The cyan console was built for the exhibition
// screen recording and it is still there for that, but it is a costume: it
// darkens the stage, recolours the contours and frames the viewport as a
// machine. As the everyday readout it made the tool look like a different
// application every time the button was pressed.
const hudState = { on: false, raf: 0 };

/**
 * Gather everything the overlay draws — all of it READ from state the app has
 * already computed, never recomputed here.
 *
 * ⚠️ The one exception is the gradient, and it is a deliberate one: slope and
 * aspect live in the worker, and `AnalysisClient.grids()` fetches 2.4 MB across
 * the thread boundary. Recomputing Horn on the main thread costs about fifteen
 * milliseconds and runs only on settle, only while the mode is on. It uses the
 * SAME function the worker does, so the two cannot disagree about a slope.
 */
function hudMetrics() {
  if (!state.dem) return {};
  const mx = state.metrics || {};
  const g = state.dem.z.length <= 512 * 512 ? computeGradient(state.dem) : null;
  const hyps = hypsometry(state.dem.z);
  const rose = g ? aspectRose(g.aspectDeg, g.slopeDeg) : null;
  let slopeMax = 0;
  if (g) for (const v of g.slopeDeg) if (Number.isFinite(v) && v > slopeMax) slopeMax = v;
  const slopeHist = g ? histogram(g.slopeDeg, 0, Math.max(slopeMax, 1)) : null;
  const land = classItems("geomorphon");
  const spec = classItems("species");
  // Up to three: the reference console carries one profile strip, but a design
  // with sections cut usually has a pair to compare, and showing only A–A read
  // as the others not existing. Three is what fits the band between the two
  // columns without shrinking any profile below legibility.
  const secs = state.sections.list.length ? sectionProfiles().slice(0, 3) : [];
  const w = state.water.on && state.water.result ? state.water.result : null;

  // ⚠️ ABIOTIC ONLY (2026-08-11). Shannon and the invasive share used to sit
  // here; Marc moved everything biotic into the habitat card — see drawHUD —
  // so this strip reads terrain morphology, water and CHANGE, the quantities
  // a gesture moves directly. The biotic response has one window of its own.
  const readout = [
    { k: "RELIEF", v: `${(hyps.hi - hyps.lo).toFixed(2)} m`, info: "relief" },
    { k: "SLOPE MEAN", v: `${(mx.slopeMeanDeg ?? 0).toFixed(2)}°`, info: "slope" },
    { k: "RUGGEDNESS", v: `${(mx.triMean ?? 0).toFixed(4)} m`, info: "tri" },
    { k: "GEODIVERSITY", v: (mx.geodiversity ?? 0).toFixed(3), info: "geodiversity" },
    { k: "STORAGE", v: `${(mx.storageVolume ?? 0).toFixed(2)} m³`, info: "storage" },
    { k: "HOLLOWS", v: `${mx.depressionCount ?? 0}`, info: "depression" },
    { k: "CUT · FILL", v: `${state.ledger.cut.toFixed(1)} · ${state.ledger.fill.toFixed(1)} m³`,
      info: "cutfill" },
    { k: "NET EARTH", v: state.ledger.netLabel(1), info: "balance" },
  ];

  // ⚠️ EVERY INDEX IS A REAL QUANTITY AGAINST A STATED BOUND. The reference
  // consoles are full of bars that mean nothing; here a full bar means the bound
  // was reached, and the bound is named in the comment beside it. Anything else
  // would make the true readings and the decoration indistinguishable, which is
  // the one thing an instrument may not do.
  const rel = (hyps.hi - hyps.lo);
  const indices = [
    // against this patch's own surveyed relief, 5.31 m
    { code: "EI", name: "ELEVATION", frac: rel / 5.31, value: `${rel.toFixed(2)} m` },
    // 30° is a steep bank; beyond it nothing is buildable
    { code: "SI", name: "SLOPE", frac: (mx.slopeMeanDeg ?? 0) / 30,
      value: `${(mx.slopeMeanDeg ?? 0).toFixed(2)}°` },
    // ruggedness against the surveyed 0.036 m
    { code: "RI", name: "RUGGEDNESS", frac: (mx.triMean ?? 0) / 0.0362,
      value: `${(mx.triMean ?? 0).toFixed(4)}` },
    // geodiversity is already bounded 0..1
    { code: "GI", name: "GEODIVERSITY", frac: mx.geodiversity ?? 0,
      value: (mx.geodiversity ?? 0).toFixed(3) },
    // fraction of the surface where wetness has an answer at all
    { code: "HI", name: "HYDROLOGY", frac: mx.twiValidFraction ?? 0,
      value: `${(100 * (mx.twiValidFraction ?? 0)).toFixed(0)}%` },
    { code: "LI", name: "LANDFORM", frac: (mx.landformClasses ?? 0) / 10,
      value: `${mx.landformClasses ?? 0}/10` },
    // BI and XI moved into the habitat card with the rest of the biotic
    // reading (2026-08-11) — the rail is abiotic terrain, six indices.
  ];

  return {
    // ⚠️ THE BASENAME, NOT THE PATH. `dem.name` is whatever it was loaded from,
    // which for the mounted tiles is "/data/orndalen/orndalen_fill_025m.tif" —
    // long enough to run straight out of its own panel and across the index
    // rail, which is exactly what it did.
    site: ((state.dem.name || "ørndalen").split(/[\\/]/).pop() || "")
      .replace(/\.tiff?$/i, "").replace(/[_-]+/g, " ").toUpperCase().slice(0, 22),
    grid: `${state.dem.ncols}×${state.dem.nrows} · ${state.dem.cell} m CELL · `
      + `${(state.dem.ncols * state.dem.cell).toFixed(0)} × ${(state.dem.nrows * state.dem.cell).toFixed(0)} m`,
    // The scene card's facts, folded into the title card (2026-08-11):
    zline: (() => {
      const [zlo, zhi] = state.dem.zRange();
      return `Z ${zlo.toFixed(2)}–${zhi.toFixed(2)} m · `
        + `E ${state.dem.originX.toFixed(0)} N ${state.dem.originY.toFixed(0)}`;
    })(),
    // ⚠️ THE CREDIT IS CONDITIONAL, and that is the standing rule read
    // precisely: Kartverket is credited wherever Kartverket data is shown —
    // and NOWHERE ELSE. The teaching tiles are synthetic (their SOURCE.txt
    // says Kartverket had no part in them) and a dropped DEM is the user's;
    // crediting either would misattribute.
    crs: `EPSG:25833 · NN2000${/orndalen/i.test(state.dem.name || "")
      ? " · © KARTVERKET NLOD" : ""}`,
    indices,
    hyps, rose, slopeHist, slopeMax,
    slopeMean: mx.slopeMeanDeg,
    shannon: mx.shannon,
    shannonMax: mx.shannonMax ?? SHANNON_MAX,
    richness: mx.richness,
    speciesTotal: mx.speciesTotal ?? SPECIES.length,
    invasiveFraction: mx.invasiveFraction,
    landformCount: mx.landformClasses,
    // ⚠️ THE LAST FOUR MEASURED VALUES THAT LIVED ONLY IN THE MENU. With
    // these the readout carries all thirteen, which is what lets the menu's
    // Measured list stop being a second copy — see the note on its <details>.
    landformDiversity: mx.landformDiversity,
    basinCount: state.basins ? state.basins.count : null,
    basinLargest: state.basins ? state.basins.largest : null,
    twiValid: mx.twiValidFraction,
    landformItems: land.items,
    speciesItems: spec.items,
    cut: state.ledger.cut, fill: state.ledger.fill,
    netLabel: state.ledger.netLabel(1),
    water: w ? { ...w, rain: state.water.rain } : null,
    profiles: secs.map((s) => ({ name: s.name, profile: s.profile })),
    readout,
  };
}

/** Repaint the overlay. Backing store at the device ratio, like the renderer. */
function drawInstrument() {
  const cv = /** @type {HTMLCanvasElement} */ ($("hud"));
  if (!hudState.on || !state.dem) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth || 1, h = cv.clientHeight || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  // The floating menu stands where the left column would draw; drawHUD
  // yields that column unless the menu is folded to its chip — and the top
  // band and bottom strip CONTRACT to start clear of it, but only while it is
  // docked near the left edge. Dragged elsewhere it is the user's own
  // arrangement, and a reserve that chased it would eat the whole band.
  const sb = $("sidebar");
  const docked = !sb.classList.contains("min") && sb.offsetLeft < 420;
  // ⚠️ AND THE READOUT WINDOW ON THE RIGHT, by the same rule and for the same
  // reason: both ends of the band and the strip are held off something real
  // rather than centred and hoped for. Only while it is docked near the right
  // edge — dragged elsewhere it is the user's own arrangement.
  const ro = $("readout");
  const roDocked = ro && !ro.classList.contains("min")
    && ro.offsetLeft > window.innerWidth * 0.5;
  drawHUD(g, { w, h, theme: THEMES.paper, m: hudMetrics(),
    left: docked ? sb.offsetLeft + sb.offsetWidth + 12 : null,
    right: roDocked ? ro.offsetLeft - 12 : null });
}

/**
 * ⚠️ REDRAWN ON SETTLE AND ON RESIZE, NOT EVERY FRAME. Nothing on the overlay
 * changes between settles — every figure is a settled measurement — so an
 * animation loop would spend a full-grid Horn pass per frame to draw the same
 * pixels. It is scheduled through rAF once so a burst of calls coalesces.
 */
function scheduleInstrument() {
  if (!hudState.on || hudState.raf) return;
  hudState.raf = requestAnimationFrame(() => { hudState.raf = 0; drawInstrument(); });
}

function setInstrument(on) {
  hudState.on = !!on;
  const cv = $("hud");
  cv.hidden = !hudState.on;
  $("t-hud").classList.toggle("on", hudState.on);
  // ⚠️ THE READOUT FOLLOWS THE MENU (2026-08-11): one master toggle, the
  // chip. There is no Instrument button anywhere any more — menu open means
  // menu plus every readout card; folded means a clean stage holding only
  // the chip and the gizmo. setInstrument is therefore only ever called by
  // the fold binding below (and test hooks), and the auto browser-fullscreen
  // went with the dedicated button: a toggle used constantly must not fight
  // the browser for the screen. F11 still exists.

  // ⚠️ ONE THEME — PAPER — AND THAT IS A DECISION (2026-08-10), not a gap. The
  // cyan and mono consoles were a second and third look for the same
  // instrument; the Mono button cycled between the two of THEM, so paper — the
  // state the mode opens in — was unreachable once you left it, which read as
  // a bug because it was one. The deliverable is a screen recording and the
  // tool, the poster and the video are committed to one language, so the
  // consoles went rather than the button being taught a three-way cycle. The
  // stage stays white and the readout stays part of the interface — the app's
  // own tokens, no dark field. See THEMES in hud.js.

  // ⚠️ THE CENTRE OF THE REFERENCE CONSOLE IS A CONTOUR MAP, and this tool
  // already draws one — so instrument mode lights the contours rather than
  // inventing a second kind of line to look technical with. On paper that
  // lighting is WEIGHT, not colour: the line work keeps the drawing's own ink,
  // because a readout in the interface's language may emphasise but not
  // recolour the real lines about the real ground.
  const s = /** @type {any} */ (state.surface);
  if (s && s.contours) {
    /** @type {any} */ (s.contours.material).opacity = hudState.on ? 0.8 : 0.55;
  }
  if (hudState.on && !state.contours.on) {
    state.contours.on = true;
    syncContours();
  }
  if (hudState.on) drawInstrument();
}
window.addEventListener("resize", () => scheduleInstrument());
// The floating menu folding, MOVING or changing height all change what the
// readout must yield space to — sidebar.js announces every layout change as
// one event so it need not know the HUD exists. The same event carries the
// MASTER TOGGLE: the readout is on exactly while the menu is unfolded.
// ⚠️ THE OVERLAY NO LONGER FOLLOWS THE MENU (2026-08-13). It used to be slaved
// to it — "the readout is on exactly while the menu is unfolded" — which was
// right when the menu and the overlay were the whole interface. Now the
// readings live in the readout WINDOW, and the overlay is a second, optional
// way of showing the same figures: the band and strip over the ground, for a
// recording. Slaved to the menu it was simply always on, drawing a duplicate
// of the window beside it. It has its own toggle now (View → Instrument) and
// starts OFF; this listener only keeps its geometry current.
document.addEventListener("dl-menu-layout", () => scheduleInstrument());

// ⚠️ THE INSTRUMENT BUTTON HAD NO HANDLER AT ALL. It has sat in View since
// Phase 8C, when the readout was slaved to the menu and the comment above
// recorded "there is no Instrument button anywhere any more" — but the element
// stayed, `setInstrument` kept writing its `on` class, and nothing listened to
// it. So it looked like a toggle, highlighted like a toggle, and did nothing.
// Now that the overlay is optional again it is the control that turns it on
// and off, which is what Marc asked for.
$("t-hud").addEventListener("click", () => {
  setInstrument(!hudState.on);
  status(hudState.on
    ? "instrument overlay on — the band and strip over the ground, for a recording"
    : "instrument overlay off — the readings are in the readout window", 3000);
});

/* ------------------------------------------------------ glossary popover */

// ⚠️ ONE POPOVER, TWO SURFACES, ONE TABLE. The same INFO entry answers the
// menu's HTML (data-info attributes, delegated below) and the readout's
// canvas cards (HUD_REGIONS hit-testing) — so the tool cannot explain one
// reading two different ways. The popover itself is pointer-inert: an
// explanation that swallowed a click would cost more than it teaches.
const infoPop = document.createElement("div");
infoPop.id = "info-pop";
infoPop.hidden = true;
document.body.appendChild(infoPop);

function showInfo(key, x, y) {
  const e = INFO[key];
  if (!e) { hideInfo(); return; }
  infoPop.innerHTML = `<b>${e.t}</b>${e.b}${e.s ? `<i>${e.s}</i>` : ""}`;
  infoPop.hidden = false;
  const pw = infoPop.offsetWidth, ph = infoPop.offsetHeight;
  infoPop.style.left = `${Math.max(8, Math.min(x + 14, window.innerWidth - pw - 8))}px`;
  infoPop.style.top = `${Math.max(8, Math.min(y + 14, window.innerHeight - ph - 8))}px`;
}
function hideInfo() { infoPop.hidden = true; }

// The readout's cards: the HUD canvas is pointer-inert by design, so the
// viewport's own pointer is tested against the regions the last draw recorded.
// A photo pin is tested first and wins — it is a nearer, more specific thing
// than the card behind it, and it answers with the picture itself.
$("viewport").addEventListener("pointermove", (e) => {
  if (e.buttons) { hideInfo(); hidePhotoTip(); return; }
  const pin = photoAt(e);
  if (pin) { hideInfo(); showPhotoTip(pin, e.clientX, e.clientY); return; }
  hidePhotoTip();
  if (!hudState.on) { hideInfo(); return; }
  let hit = null;
  for (const r of HUD_REGIONS) {
    if (e.clientX >= r.x && e.clientX <= r.x + r.w
      && e.clientY >= r.y && e.clientY <= r.y + r.h) hit = r.key;
  }
  if (hit) showInfo(hit, e.clientX, e.clientY); else hideInfo();
});
$("viewport").addEventListener("pointerleave", () => hidePhotoTip());

/**
 * The mini preview that follows the pointer over a pin. Pointer-inert, like
 * the glossary popover: a thumbnail that swallowed the click would block the
 * full view it exists to advertise.
 */
const photoTip = document.createElement("div");
photoTip.id = "photo-tip";
photoTip.hidden = true;
document.body.appendChild(photoTip);
let tipFor = "";
function showPhotoTip(m, x, y) {
  if (tipFor !== m.name) {
    tipFor = m.name;
    photoTip.innerHTML = `<img src="${m.url}" alt=""><span>${m.name}`
      + `${m.inside ? "" : " · beyond the tile"}</span>`;
  }
  photoTip.hidden = false;
  const w = photoTip.offsetWidth, h = photoTip.offsetHeight;
  photoTip.style.left = `${Math.max(8, Math.min(x + 16, window.innerWidth - w - 8))}px`;
  photoTip.style.top = `${Math.max(8, Math.min(y + 16, window.innerHeight - h - 8))}px`;
}
function hidePhotoTip() { photoTip.hidden = true; tipFor = ""; }
$("viewport").addEventListener("pointerleave", () => hideInfo());

// The menu: any element carrying data-info explains itself on hover.
$("sidebar").addEventListener("pointerover", (e) => {
  const el = /** @type {HTMLElement} */ (e.target).closest("[data-info]");
  if (!el) { hideInfo(); return; }
  const r = el.getBoundingClientRect();
  showInfo(/** @type {HTMLElement} */ (el).dataset.info || "", r.right + 4, r.top);
});
$("sidebar").addEventListener("pointerleave", () => hideInfo());

// ⚠️⚠️ THE READOUT NEEDS ITS OWN LISTENER, AND HAS BEEN MISSING ONE (found
// 2026-08-23). The loop below sets data-info on every Measured row, and the
// comment above it says every Measured row explains itself — but #readout is a
// SIBLING of #sidebar, not a descendant, so the delegated handler never saw
// them and not one of those rows has ever opened a popover. The attributes were
// set and silently inert. Same handler, second root.
// ⚠️ ANCHORED FROM THE LEFT EDGE, unlike the sidebar's. The readout sits on the
// RIGHT of the window, so opening at `r.right + 4` would clamp against the
// window edge and land the popover on top of the very numbers it is explaining.
// The popover is max-width 300, so this opens it inboard instead.
$("readout").addEventListener("pointerover", (e) => {
  const el = /** @type {HTMLElement} */ (e.target).closest("[data-info]");
  if (!el) { hideInfo(); return; }
  const r = el.getBoundingClientRect();
  showInfo(/** @type {HTMLElement} */ (el).dataset.info || "", r.left - 314, r.top);
});
$("readout").addEventListener("pointerleave", () => hideInfo());

// What explains itself: every analysis layer's thumbnail, and every Measured
// row. Keys are the INFO table's — one vocabulary across the whole tool.
for (const k of [...LIVE_PANELS, ...HEAVY_PANELS, FORM_PANEL]) {
  /** @type {HTMLElement} */ ($(`p-${k}`)).dataset.info = k;
}
for (const [id, key] of [
  ["m-relief", "relief"], ["m-slope", "slope"], ["m-tri", "tri"],
  ["m-geo", "geodiversity"], ["m-landform", "geomorphon"], ["m-basins", "basins"],
  ["m-catchment", "catchment"], ["m-storage", "storage"], ["m-depr", "depression"],
  ["m-twi", "twi"], ["m-shannon", "shannon"], ["m-richness", "richness"],
  ["m-invasive", "invasive"],
]) {
  const row = $(id)?.parentElement;
  if (row) row.dataset.info = key;
}

/* ---------------------------------------------------------------- sections */

/**
 * Sample every section against the live surface and the pristine baseline.
 *
 * ⚠️ RE-SAMPLED, NEVER CACHED. A section is a reading of the ground, and the
 * ground moves under it constantly — a cached profile would be a drawing of a
 * surface that no longer exists, which is the one thing a measured drawing must
 * never be. Sampling all of them costs a few hundred microseconds.
 */
function sectionProfiles() {
  if (!state.dem) return [];
  return state.sections.list.map((s) => {
    const profile = sampleSection(state.dem, s.a, s.b, { baseline: state.baseZ });
    return { ...s, profile, areas: sectionAreas(profile) };
  });
}

/**
 * Profiles parallel to a section and BEHIND it, for the receding elevation on
 * the exported sheet.
 *
 * ⚠️ THIS IS THE VECTOR ANSWER TO "SHOW THE TERRAIN BEHIND THE LINE WORK". The
 * obvious version is a shaded raster of the landform behind the cut, and it
 * would be wrong here for one specific reason: the A1 poster pipeline is
 * SVG → PDF, and embedding a raster in the sheet forfeits the property the whole
 * pipeline exists for. A set of profiles sampled further and further back, drawn
 * lighter and thinner with distance, gives the same depth reading and stays
 * geometry — it is also how a hand-drawn landscape section has always done it.
 *
 * ⚠️ SPACING GROWS WITH THE SQUARE of the index, not linearly. Evenly spaced
 * profiles read as a fence: the eye takes equal spacing as a grid rather than as
 * distance. Widening them is the same cue perspective gives and costs nothing.
 *
 * @param {{a:number[], b:number[]}} sec
 * @param {number} [count]
 */
function behindProfiles(sec, count = 5) {
  if (!state.dem) return [];
  const [ax, ay] = sec.a, [bx, by] = sec.b;
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return [];
  // The left normal of A→B — the same side setSectionView looks from, so the
  // sheet and the screen agree about which half of the world is "behind".
  const nx = -dy / len, ny = dx / len;
  const span = Math.max(state.dem.nrows, state.dem.ncols) * state.dem.cell;
  const out = [];
  for (let i = 1; i <= count; i++) {
    const d = span * 0.015 * i * i;
    out.push(sampleSection(state.dem,
      [ax + nx * d, ay + ny * d], [bx + nx * d, by + ny * d]));
  }
  return out;
}

/**
 * The strip of ground either side of a section, as contours in the section's
 * own coordinates — the key plan every section drawing carries.
 *
 * ⚠️ SAMPLED ON THE SECTION'S OWN AXES, NOT CROPPED FROM THE TILE. A section
 * runs at whatever bearing it was drawn at, so a rectangle cut out of the
 * north-up grid would arrive on the sheet rotated, and would not line up with
 * the profile above it — which is the entire point of drawing it. Instead the
 * ground is re-sampled along lines PARALLEL to the section, which lands the band
 * already square to the page: station along, offset across.
 *
 * ⚠️ THE ROWS ARE sampleSection CALLS, deliberately. It is the same sampler the
 * profile itself uses — half-cell stepping, facet interpolation, NaN preserved —
 * so the top line of the plan and the section above it are the same measurement
 * of the same ground, and cannot disagree.
 *
 * @param {{a:number[], b:number[]}} sec
 * @param {number} [half] metres either side of the line
 */
function sectionPlanBand(sec, half = 10) {
  if (!state.dem) return null;
  const [ax, ay] = sec.a, [bx, by] = sec.b;
  const dx = bx - ax, dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;
  const nx = -dy / length, ny = dx / length;   // left normal, as everywhere else

  const step = state.dem.cell;
  const nt = Math.max(2, Math.floor((2 * half) / step) + 1);
  /** @type {Float32Array|null} */
  let now = null, was = null;
  let ns = 0, ds = 0;
  for (let r = 0; r < nt; r++) {
    const t = half - r * step;                 // row 0 is the +offset edge
    const prof = sampleSection(state.dem,
      [ax + nx * t, ay + ny * t], [bx + nx * t, by + ny * t],
      { step, baseline: state.baseZ });
    if (!now) {
      ns = prof.s.length;
      ds = ns > 1 ? length / (ns - 1) : step;
      now = new Float32Array(nt * ns);
      was = new Float32Array(nt * ns);
    }
    for (let c = 0; c < ns; c++) {
      now[r * ns + c] = prof.now[c];
      was[r * ns + c] = prof.was[c];
    }
  }
  if (!now || ns < 2) return null;

  let zlo = Infinity, zhi = -Infinity;
  for (const v of now) if (Number.isFinite(v)) { if (v < zlo) zlo = v; if (v > zhi) zhi = v; }
  if (!Number.isFinite(zlo)) return null;
  // ⚠️ THE PLAN USES THE INTERVAL THAT IS ON SCREEN, when there is one. A key
  // plan drawn at a different interval from the model beside it makes the reader
  // count lines twice; falling back to a nice interval only when contours are
  // switched off keeps the sheet self-sufficient either way.
  const interval = state.contours.interval || niceInterval(zhi - zlo, 14);
  const northY = nt * ds;

  /**
   * contourSegments works on any regular grid; it reports positions in the
   * grid's own LOCAL frame, with column c at (c+0.5)·cell and row r measured
   * down from a north edge at nrows·cell. Converted here into the section's
   * coordinates — station along, offset across — with the levels kept so the
   * sheet can label them.
   */
  const trace = (grid) => {
    const seg = contourSegments(grid, nt, ns, ds, interval, { limit: 600 });
    const out = new Float32Array(seg.segments * 4);
    const lvl = new Float32Array(seg.segments);
    for (let i = 0; i < seg.segments; i++) {
      for (const [k, o] of [[0, 0], [1, 2]]) {
        const p = i * 6 + k * 3;
        // ⚠️ THE HALF-CELL COMES BACK OFF. sampleSection puts station i at i·ds
        // while contourSegments puts column c at (c+0.5)·ds, so every line would
        // sit half a cell along the section — a consistent shift that reads as
        // the plan being very slightly out of register with the profile above it.
        out[i * 4 + o] = seg.positions[p] - 0.5 * ds;
        // Distance down from the +half edge, then flipped to offset from the
        // LINE, positive toward the +normal side.
        out[i * 4 + o + 1] = half - ((northY - seg.positions[p + 1]) - 0.5 * ds);
      }
      // Both ends of a segment sit on the same level; z carries it.
      lvl[i] = seg.positions[i * 6 + 2];
    }
    return { segments: out, levels: lvl };
  };

  const cur = trace(now);
  // ⚠️ THE EXISTING GROUND IS TRACED ONLY IF IT DIFFERS. On unedited terrain the
  // two sets are identical, and drawing a dashed line under every solid one
  // doubles the ink to say nothing — the reader would take it as a design that
  // changed nothing rather than as a drawing of ground nobody has touched.
  let moved = false;
  for (let i = 0; i < now.length; i++) {
    if (Number.isFinite(now[i]) && Number.isFinite(was[i])
      && Math.abs(now[i] - was[i]) > 1e-6) { moved = true; break; }
  }
  const old = moved ? trace(was) : null;

  return {
    half, length, interval, zlo, zhi,
    segments: cur.segments, levels: cur.levels,
    wasSegments: old ? old.segments : null,
  };
}

/** Everything on screen that describes the sections. One entry point. */
function refreshSections() {
  const any = state.sections.list.length > 0;
  $("section-tools").hidden = !any;
  // The gizmo carries one button per section, so it is rebuilt here — the one
  // place that already knows the list changed. A section view whose section has
  // since been deleted is left rather than pointed at nothing.
  if (sectionView && !state.sections.list.some((s) => s.id === sectionView.id)) {
    clearSectionView();
  }
  refreshSectionViewButtons();
  if (!state.dem) return;

  if (!state.sections.overlay) {
    state.sections.overlay = new SectionOverlay(state.dem,
      { verticalExaggeration: currentExaggeration() });
    view.scene.add(state.sections.overlay.group);
  }
  const cut = sectionProfiles();
  const ov = state.sections.overlay;
  ov.setExaggeration(currentExaggeration());
  ov.setSections(cut, { folded: state.sections.folded });
  $("t-fold-sections").classList.toggle("on", state.sections.folded);
  // ⚠️ Sections outlive plan mode, exactly as regions do. Only CUTTING one needs
  // the locked view; looking at what it reveals is better done from an angle.
  ov.setVisible(any);

  const ul = /** @type {HTMLElement} */ ($("section-list"));
  ul.innerHTML = "";
  for (const s of cut) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${s.name}–${s.name}`;
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = `${s.profile.length.toFixed(1)} m`;
    li.append(label, val);
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "remove this section";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      state.sections.list = state.sections.list.filter((o) => o.id !== s.id);
      renameSections();
      refreshSections();
      status(`section ${s.name}–${s.name} removed`);
    });
    li.appendChild(x);
    ul.appendChild(li);
  }

  const total = cut.reduce((acc, s) => ({
    cut: acc.cut + s.areas.cut, fill: acc.fill + s.areas.fill,
  }), { cut: 0, fill: 0 });
  $("section-read").innerHTML = cut.length
    ? cut.map((s) => `<b>${s.name}–${s.name}</b> ${s.profile.length.toFixed(1)} m · `
      + `cut <b>${s.areas.cut.toFixed(1)} m²</b> · fill <b>${s.areas.fill.toFixed(1)} m²</b> · `
      + `deepest cut ${s.areas.maxCut.toFixed(2)} m, highest fill ${s.areas.maxFill.toFixed(2)} m`)
      .join("<br>")
      + (cut.length > 1 ? `<br><b>All sections</b> cut ${total.cut.toFixed(1)} m², `
        + `fill ${total.fill.toFixed(1)} m²` : "")
    : "";
}

/** Sections are lettered by position, so removing B renames the rest. */
function renameSections() {
  state.sections.list.forEach((s, i) => { s.name = sectionName(i); });
}

/** @param {number} x @param {number} y */
function sectionPlacepoint(x, y) {
  const p = state.sections;
  if (!p.pending) {
    p.pending = [x, y];
    status("section: click the far end");
    return;
  }
  const a = p.pending;
  p.pending = null;
  if (Math.hypot(x - a[0], y - a[1]) < (state.dem ? state.dem.cell * 2 : 1)) {
    status("section too short — click two points apart");
    return;
  }
  p.list.push({ id: p.nextId++, name: "", a, b: [x, y] });
  renameSections();
  refreshSections();
  const s = p.list[p.list.length - 1];
  status(`section ${s.name}–${s.name} cut`, 2600);
}

$("t-fold-sections").addEventListener("click", () => {
  state.sections.folded = !state.sections.folded;
  refreshSections();
  status(state.sections.folded
    ? "sections folded flat — heights read as offsets left of each cut, from its lowest point"
    : "sections standing — profiles drawn in place on the ground they cut", 3600);
});

$("section-clear").addEventListener("click", () => {
  if (!state.sections.list.length) { status("no sections"); return; }
  state.sections.list = [];
  state.sections.pending = null;
  refreshSections();
  status("sections cleared");
});

$("section-export").addEventListener("click", () => {
  const cut = sectionProfiles();
  if (!cut.length) { status("no sections to export"); return; }
  const svg = sectionSVG(cut, {
    exaggeration: currentExaggeration(),
    site: state.dem ? state.dem.name : "",
    crs: "EPSG:25833",
    behind: cut.map((s) => behindProfiles(s)),
    plan: cut.map((s) => sectionPlanBand(s)),
  });
  download(new Blob([svg], { type: "image/svg+xml" }), exportStem("sections") + ".svg");
  status(`${cut.length} section${cut.length > 1 ? "s" : ""} exported`, 3000);
});

$("grading-export").addEventListener("click", () => {
  if (!state.dem) { status("load a site first", 3000); return; }
  const svg = gradingSVG(state.dem, {
    // ⚠️ THE PRISTINE BASELINE, NOT THE LAST UNDO STATE. `baseZ` is the ground
    // as the tile arrived, so the sheet shows the whole design against what was
    // surveyed — which is what a grading plan is for. Stepping back through
    // history would draw the last gesture and call it the design.
    baseline: state.baseZ,
    interval: state.contours.interval,
    site: state.dem.name,
    crs: "EPSG:25833",
    regions: state.plan.set.regions.map((r) => r.rings),
    guide: guide.pts.length > 1 ? guide.pts : null,
  });
  download(new Blob([svg], { type: "image/svg+xml" }), exportStem("grading-plan") + ".svg");
  status("grading plan exported · proposed over existing, cut and fill hatched", 4000);
});

/* The grading plan's siblings — see export/derivatives.js. Each reads the
   surface as it stands and changes nothing; each carries the same frame,
   north point and scale bar, so a set of them reads as one issue. */

$("isopach-export").addEventListener("click", () => {
  if (!state.dem) { status("load a site first", 3000); return; }
  const svg = isopachSVG(state.dem, {
    baseline: state.baseZ,   // the survey, not the last undo — as the grading plan
    site: state.dem.name, crs: "EPSG:25833",
  });
  download(new Blob([svg], { type: "image/svg+xml" }), exportStem("isopach") + ".svg");
  status("isopach exported · cut dashed, fill solid, limit of works heavy", 4000);
});

$("slope-class-export").addEventListener("click", () => {
  if (!state.dem) { status("load a site first", 3000); return; }
  const svg = slopeClassSVG(state.dem, { site: state.dem.name, crs: "EPSG:25833" });
  download(new Blob([svg], { type: "image/svg+xml" }), exportStem("slope-classes") + ".svg");
  status("slope classes exported · denser hatch is steeper, paper is to 1:20", 4000);
});

$("drainage-export").addEventListener("click", () => {
  if (!state.dem) { status("load a site first", 3000); return; }
  // The sheet's event follows the Rainfall panel when it is on, so the plan
  // agrees with the water standing in the viewport; otherwise the stated
  // default. Either way the subtitle prints the figure it used.
  const svg = drainageSVG(state.dem, {
    site: state.dem.name, crs: "EPSG:25833",
    rainM: state.water.on ? state.water.rain : undefined,
    substrate: state.substrate,
  });
  download(new Blob([svg], { type: "image/svg+xml" }), exportStem("drainage-plan") + ".svg");
  status("drainage plan exported · channels, divides, standing water, outfalls", 4000);
});

$("chainage-export").addEventListener("click", () => {
  if (!state.dem) { status("load a site first", 3000); return; }
  if (guide.pts.length < 2) {
    status("draw a guide curve first — the sections are cut along it", 4000);
    return;
  }
  const svg = chainageSectionsSVG(state.dem, guide.pts, {
    baseline: state.baseZ,
    site: state.dem.name, crs: "EPSG:25833",
  });
  download(new Blob([svg], { type: "image/svg+xml" }), exportStem("chainage-sections") + ".svg");
  status("chainage sections exported · looking along the chainage, areas per section", 4000);
});

/* ----------------------------------------------------------------- contours */

/**
 * The intervals the slider offers, from the 1-2-5 series.
 *
 * A discrete list rather than a continuous range, because a contour interval is
 * read off the drawing and multiplied in the head — 0.25 m is a number people
 * can count in and 0.31 m is not. Same series the scale bar uses, for the same
 * reason.
 */
const CONTOUR_INTERVALS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10];

/**
 * Push the contour state onto whatever representation is current.
 *
 * ⚠️ VOXELS HAVE NO CONTOURS, AND SHOULD NOT. A block field is an aggregated
 * reading of the surface at the block size; drawing a smooth 0.25 m contour
 * across it would describe relief the representation has explicitly discarded.
 * `VoxelField` simply does not carry the methods, so the optional calls below
 * do nothing — and the note says why rather than leaving the control looking
 * broken.
 */
function syncContours() {
  const s = /** @type {any} */ (state.surface);
  const voxels = state.representation === "voxel";
  $("t-contours").classList.toggle("on", state.contours.on);
  $("contour-field").hidden = !state.contours.on;
  $("contour-note").hidden = !state.contours.on;
  if (!s || !s.setContourInterval) {
    if (state.contours.on) {
      $("contour-note").textContent =
        "Contours are drawn on the Surface representation. A block field is an "
        + "aggregate, so a smooth line across it would describe relief the "
        + "blocks have deliberately discarded.";
    }
    return;
  }
  s.setContourInterval(state.contours.on ? state.contours.interval : 0);
  if (!state.contours.on) return;
  void voxels;
  const n = s.contourSegmentCount || 0;
  $("contour-note").textContent =
    `${state.contours.interval} m interval · ${n.toLocaleString("en")} segments. `
    + "Levels are exact multiples of the interval, so they stay put when the "
    + "ground is edited.";
}

$("t-contours").addEventListener("click", () => {
  state.contours.on = !state.contours.on;
  syncContours();
  status(state.contours.on
    ? `contours on · ${state.contours.interval} m` : "contours off", 1200);
});

$("contour").addEventListener("input", () => {
  const i = parseInt(/** @type {HTMLInputElement} */ ($("contour")).value, 10);
  state.contours.interval = CONTOUR_INTERVALS[
    Math.min(CONTOUR_INTERVALS.length - 1, Math.max(0, i))];
  $("contour-val").textContent = `${state.contours.interval} m`;
  syncContours();
});

/* ------------------------------------------------------------------ export */

/**
 * Base filename: the date first, then the tool, then the tile it came from.
 *
 * Date-first so a Downloads folder sorts chronologically, which is how anyone
 * actually looks for one of these; `dl-export` so it is obvious what produced
 * it once it has been mailed to somebody.
 *
 * ⚠️ THE TRAILING WORD IS NOT DECORATION — it is what stops three exports
 * overwriting each other. The tool writes several files that share an
 * extension: terrain and a layer are both .tif, and the OBJ bundle, the region
 * shapefile and the Everything archive are all .zip. Without the discriminator
 * a browser silently renames the second one "(1)" and the third "(2)", and the
 * one you wanted is whichever you downloaded first.
 * @param {string} suffix what this export IS — "terrain", "voxels", "bundle"…
 */
function exportStem(suffix) {
  const raw = (state.dem?.name || "").replace(/^.*[\\/]/, "").replace(/\.tiff?$/i, "").trim();
  const base = raw || "default";
  const day = new Date().toISOString().slice(0, 10);
  return `${day} dl-export_${base}_${suffix}`;
}

/** @param {Blob} blob @param {string} filename */
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; a tick is
  // enough and the object is small-lived either way.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** The exaggeration to bake into a mesh export — 1 unless explicitly asked. */
function exportExaggeration() {
  return /** @type {HTMLInputElement} */ ($("ex-apply")).checked
    ? currentExaggeration() : 1;
}

/**
 * Write the mesh for a representation.
 *
 * "voxel" reads the live VoxelField's own instance matrices where one is on
 * screen, and builds a throwaway field at the current block size otherwise —
 * either way the boxes are the ones the aggregation rule produces, never a
 * second implementation of it sitting in the export path.
 *
 * @param {"mesh"|"voxel"} rep
 * @param {{exaggeration: number, textureFile: string|null, layerLabel: string}} o
 */
/**
 * Per-block class ids for grouping, and their labels — or null when the shown
 * layer has no classes to group by.
 *
 * ⚠️ ONLY CATEGORICAL LAYERS CAN BE GROUPED, and refusing the rest is the
 * honest answer rather than a missing feature. Species, landform, watershed and
 * substrate are classes: a boundary between two of them is a real edge, and a
 * separate solid either side of it means something. Slope, wetness and the rest
 * are CONTINUOUS — they have no boundaries, only gradients — so cutting them
 * into solids would mean choosing bin edges here and then printing them as
 * though the ground had them. That is exactly the kind of invented precision
 * this tool refuses everywhere else.
 * @param {number} k blockCells
 */
function solidGroups(k) {
  const key = currentLayerKey();
  const cat = key ? CATEGORICAL[key] : null;
  if (!cat) return null;
  const src = { species: state.assemblage, geomorphon: state.landform }[key];
  const codes = src && src.codes;
  if (!codes) return null;
  const labels = (cat.labels || []).map((s, i) => `${i}_${s}`);
  return {
    groups: blockClasses(codes, state.dem, k, cat.labels ? cat.labels.length : 16),
    labels,
    layerLabel: layerTitle(key),
  };
}

function buildMesh(rep, o) {
  const dem = state.dem;
  if (rep !== "voxel") return writeOBJ(dem, { ...o, materialName: "terrain" });

  const live = state.representation === "voxel" ? state.surface : null;
  // A live field is built at the VIEWPORT's exaggeration, which is a display
  // claim rather than a property of the ground. Rebuild it at the export's own
  // factor so an unbaked export really is true elevations, then put it back.
  const viewEx = currentExaggeration();
  const field = live || new VoxelField(dem, {
    verticalExaggeration: o.exaggeration,
    blockCells: state.blockCells ?? undefined,
  });
  if (live && live.exaggeration !== o.exaggeration) live.setExaggeration(o.exaggeration);

  const mode = /** @type {HTMLSelectElement} */ ($("ex-solid")).value;
  let res;
  if (mode === "boxes") {
    res = writeVoxelOBJ(
      { array: field.mesh.instanceMatrix.array, count: field.cubeCount },
      dem, { ...o, materialName: "terrain", blockWidth: field.blockWidth });
  } else {
    // ⚠️ THE SOLID TAKES voxels.js's OWN baseZ AND CUBE HEIGHT rather than
    // deriving its own. Anything else and the exported shape is a different
    // staircase from the one on screen — quantised on a different ladder, and
    // plausible enough that nobody would notice until they measured a print.
    const g = mode === "grouped" ? solidGroups(field.blockCells) : null;
    res = writeVoxelSolidOBJ(dem, {
      blockCells: field.blockCells,
      baseZ: field.baseZ,
      quantum: field.voxelHeight,
      exaggeration: o.exaggeration,
      groups: g ? g.groups : null,
      groupLabels: g ? g.labels : undefined,
      layerLabel: g ? g.layerLabel : o.layerLabel,
    });
  }

  if (live && live.exaggeration !== viewEx) live.setExaggeration(viewEx);
  if (!live) field.dispose();
  return res;
}

/** Human labels for the layer currently selected for shading. */
function currentLayerKey() {
  const k = state.shading;
  return (k === "relief" || k === "none") ? null : k;
}

function layerTitle(k) {
  return LAYER_TITLES[k] || k;
}

/** Terrain as a georeferenced raster — the edited surface, back into GIS. */
function exportTerrainGeoTIFF() {
  const dem = state.dem;
  if (!dem) return;
  const bytes = writeGeoTIFF(dem.z, dem.nrows, dem.ncols, dem.cell, dem.originX, dem.originY);
  download(new Blob([bytes], { type: "image/tiff" }), `${exportStem("terrain")}.tif`);
  status(`GeoTIFF exported · ${dem.ncols}×${dem.nrows} @ ${dem.cell} m · EPSG:25833`);
}

/**
 * Terrain as a mesh, with the selected analysis layer as a texture. OBJ, MTL
 * and the texture go out as one archive because they are useless apart.
 */
function exportTerrainOBJ() {
  const dem = state.dem;
  if (!dem) return;
  const ex = exportExaggeration();
  const key = currentLayerKey();
  const buf = key ? state.panels[key] : null;

  const files = [];
  let textureFile = null;
  // The OBJ follows WHAT YOU ARE LOOKING AT. Switching to Voxels and exporting
  // gives boxes; switching back gives the smooth mesh. Two buttons would have
  // meant two ways to say something already said by the Terrain toggle.
  const rep = state.representation === "voxel" ? "voxel" : "mesh";
  const finish = () => {
    const built = buildMesh(rep, {
      exaggeration: ex,
      textureFile,
      layerLabel: key ? layerTitle(key) : "none",
    });
    const { obj, mtl, triangles } = built;
    const enc = new TextEncoder();
    files.unshift({ name: "terrain.obj", data: enc.encode(obj) });
    if (mtl) files.push({ name: "terrain.mtl", data: enc.encode(mtl) });
    download(new Blob([makeZip(files)], { type: "application/zip" }),
      `${exportStem(rep === "voxel" ? "voxels" : "mesh")}.zip`);
    // ⚠️ REPORT WHETHER IT WILL ACTUALLY SLICE, measured on what was just
    // written rather than promised by the mode that wrote it. "Watertight" is a
    // property of a file, and it is the one property of this export that cannot
    // be checked by looking at it.
    const solid = built.shells !== undefined;
    status(`${rep === "voxel" ? "Voxel" : "Surface"} OBJ exported · ` +
      `${triangles.toLocaleString()} triangles` +
      (solid
        ? ` · ${built.shells} ${built.closed ? "closed" : "⚠️ NOT CLOSED"} ` +
          `solid${built.shells === 1 ? "" : "s"}, ` +
          `${built.vertices.toLocaleString()} welded vertices` +
          (built.nonManifold
            ? ` · ⚠️ ${built.nonManifold.toLocaleString()} knife edges where ` +
              `blocks touch only at a corner — closed, but fragile to print`
            : "")
        : "") +
      (textureFile ? ` · textured with ${layerTitle(key)}` : "") +
      (ex === 1 ? " · true elevations" : ` · ${ex}× exaggerated`), 9000);
  };

  if (!buf) { finish(); return; }
  // PNG, not JPEG, for the texture: cell boundaries are hard edges and JPEG
  // would ring along every one of them, inventing colour that means a value.
  const cv = document.createElement("canvas");
  cv.width = dem.ncols; cv.height = dem.nrows;
  /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d"))
    .putImageData(new ImageData(buf, dem.ncols, dem.nrows), 0, 0);
  cv.toBlob((blob) => {
    if (!blob) { finish(); return; }
    blob.arrayBuffer().then((ab) => {
      textureFile = "terrain_layer.png";
      files.push({ name: textureFile, data: new Uint8Array(ab) });
      finish();
    });
  }, "image/png");
}

/** The selected layer's VALUES as a georeferenced raster. */
async function exportLayerGeoTIFF() {
  const dem = state.dem;
  const key = currentLayerKey();
  if (!dem || !state.analysis) return;
  if (!key) { status("Select an analysis layer first", 3000); return; }
  status("collecting grids…", 0);
  try {
    const grids = await state.analysis.grids();
    const grid = grids[key];
    if (!grid) { status(`${layerTitle(key)} has no grid to export`, 4000); return; }
    const bytes = writeGeoTIFF(grid, dem.nrows, dem.ncols, dem.cell, dem.originX, dem.originY);
    download(new Blob([bytes], { type: "image/tiff" }), `${exportStem(key)}.tif`);
    status(`${layerTitle(key)} exported as float32 GeoTIFF · values, not colours`);
  } catch (err) {
    fail(err);
  }
}

/**
 * The measured figures for the caption column. Read from the same state the
 * sidebar renders, so a figure can never quote a number the app is not showing.
 */
function figureMetrics() {
  const mx = state.metrics;
  if (!mx || !state.dem) return [];
  const [lo, hi] = state.dem.zRange();
  const out = [
    ["Relief", `${(hi - lo).toFixed(2)} m`],
    ["Slope mean", `${mx.slopeMeanDeg.toFixed(2)}°`],
    ["Ruggedness (TRI)", `${mx.triMean.toFixed(4)} m`],
    ["Geodiversity", mx.geodiversity.toFixed(3)],
    ["Water storage", `${mx.storageVolume.toFixed(2)} m³`],
    ["Hollows", String(mx.depressionCount)],
    ["TWI defined", `${(100 * mx.twiValidFraction).toFixed(1)}%`],
  ];
  if (Number.isFinite(mx.shannon)) {
    out.push(["Shannon H′", `${mx.shannon.toFixed(3)} / ${(mx.shannonMax ?? SHANNON_MAX).toFixed(2)}`]);
    out.push(["Habitats present", `${mx.richness} / ${mx.speciesTotal ?? SPECIES.length}`]);
    out.push(["Invasive cover", `${(100 * mx.invasiveFraction).toFixed(1)}%`]);
  }
  // The earthwork ledger only means something once something has been moved.
  if (state.ledger.cut > 0 || state.ledger.fill > 0) {
    out.push(["Net earth moved", state.ledger.netLabel(1)]);
  }
  return out;
}

/**
 * Compose the figure for any layer, without disturbing what is on screen.
 *
 * Split out of the single-layer export so the bundle can build all eleven
 * figures without switching the shading eleven times — which would
 * rebuild the 3D colours on each pass and, worse, leave the app on whatever
 * layer happened to be last.
 * @returns {HTMLCanvasElement|null}
 */
function buildFigure(key) {
  const dem = state.dem;
  if (!dem || !key) return null;
  const buf = state.panels[key];
  if (!buf) return null;

  const meta = LEGEND[key];
  const categorical = !!(meta && meta.categorical);
  // ⚠️ A THIRD KIND OF LAYER, AND IT HAD NO PLACE HERE — which is what broke
  // "Everything · ZIP" with "Cannot read properties of undefined (reading
  // 'domain')" partway through the bundle.
  //
  // Every layer was assumed to be either CONTINUOUS (a ramp with a domain, so
  // the figure draws a gradient swatch and two end labels) or CATEGORICAL (a
  // fixed named class list, so it draws a key). Watersheds are neither. A basin
  // id is NOMINAL AND UNBOUNDED — watershed.js walks the golden angle for hues
  // precisely because there is no class list to key against, and the layer
  // deliberately has no entry in RAMPS or in LEGEND for the same reason.
  //
  // `fillLegend` already coped, because it returns early when LEGEND has no
  // entry, so the hover legend simply never drew and nobody noticed. This path
  // had no such guard and reached straight through the missing ramp.
  //
  // ⚠️ Only the BUNDLE hit it. Exporting the watershed figure on its own goes
  // through the same function, so it was equally broken there — but the bundle
  // is the one that walks every layer in turn, so it is the one that always
  // finds the layer nobody exports by hand.
  const nominal = !categorical && !RAMPS[key];
  const dom = categorical || nominal
    ? [0, 1] : (state.domains[key] || RAMPS[key].domain);
  const stops = [];
  if (!categorical && !nominal) {
    for (let i = 0; i <= 24; i++) {
      const v = dom[0] + ((dom[1] - dom[0]) * i) / 24;
      // The figure's ramp swatch must use the same variant the pixels did, or
      // the legend describes a palette the image is not drawn in.
      const [r, g, b] = sample(key, v, /** @type {any} */ (dom), state.variant[key]);
      stops.push([r, g, b]);
    }
  }
  // Classes present on THIS surface, commonest first — the key describes the
  // ground in the picture, not the classifier's whole vocabulary.
  const keys = categorical ? (() => {
    const { items, total } = classItems(key);
    return items.map((x) => ({
      label: x.flag ? `${x.label} (${x.flag})` : x.label,
      colour: x.colour, n: x.n,
      pct: total ? `${((100 * x.n) / total).toFixed(1)}%` : "",
    }));
  })() : null;
  const fmt = (v) => {
    const raw = meta?.log10 ? Math.pow(10, v) : v;
    const dp = meta?.log10 && raw < 10 ? 2 : (meta?.dp ?? 2);
    return `${raw.toFixed(dp)}${meta?.unit ?? ""}`;
  };
  const [lo, hi] = dem.zRange();

  const cv = composeFigure({
    rgba: buf, ncols: dem.ncols, nrows: dem.nrows, cellSize: dem.cell,
    title: layerTitle(key),
    rampStops: stops,
    keys,
    // The rose is built from the SAME function the layer was computed with, so
    // the diagram beside the map cannot drift from the map.
    rose: key === "wind" ? (() => {
      const azDeg = [], az = [];
      for (let d = 0; d < DEFAULT_DIRECTIONS; d++) {
        const a = (2 * Math.PI * d) / DEFAULT_DIRECTIONS;
        az.push(a); azDeg.push((a * 180) / Math.PI);
      }
      return {
        azimuthsDeg: azDeg,
        weights: Array.from(directionalWeights(az, PREVAILING_WIND_DEG).weights),
        prevailingDeg: PREVAILING_WIND_DEG,
        source: "windfinder long-run observations, Tromsø",
      };
    })() : undefined,
    // ⚠️ A NOMINAL LAYER GETS NO END LABELS. "low 0.00" and "1.00 high" under a
    // basin map would invite exactly the reading watershed.js warns against —
    // that the hue sequence is a rank — when the ids are arbitrary and the
    // colours walk the golden angle purely to separate neighbours.
    loLabel: nominal ? "" : (meta?.circular ? "N 0°" : `${meta?.lo ?? "low"} ${fmt(dom[0])}`),
    hiLabel: nominal ? "" : (meta?.circular ? "360° N" : `${fmt(dom[1])} ${meta?.hi ?? "high"}`),
    note: key === "watershed"
      // ⚠️ THE COLOURS MUST BE DECLARED ARBITRARY, in the figure and not only in
      // the app. Basins are ranked by area, so a reader handed this raster
      // without the sentence would reasonably read the hue sequence as that
      // rank. The hues walk the golden angle so that neighbouring basins land
      // far apart; they carry no order at all.
      ? "Basin colours are ARBITRARY — hues walk the golden angle so adjacent "
        + "basins separate by eye, and carry no rank or value. D8 is used here "
        + "and nowhere else in this tool: a watershed is a partition, and "
        + "multiple-flow-direction has no answer to which basin a cell belongs "
        + "to. Depressions are inventoried, not filled, so basins below 1 m² are "
        + "reported as a real class rather than removed."
      : key === "soil"
      ? "Substrate is IMPORTED OR SPECIFIED, never computed — it is the one "
        + "layer here not derived from the terrain. Where it was drawn by hand it "
        + "is a design decision, not a survey; where it was imported, the source "
        + "and the crosswalk used are named in the bundle README."
      : key === "species"
      ? "Fuzzy habitat suitability over five axes — moisture (scale-corrected "
        + "TWI), energy, substrate, shelter, landform — combined so the worst "
        + "axis governs. Stated envelopes, NOT a fitted species distribution "
        + "model: no occurrence data, no validation, no uncertainty. Read it as "
        + "the range of conditions the surface offers, not as which plant will grow."
      : key === "geomorphon"
      ? `Ten landform classes from the local ternary pattern (Jasiewicz & Stepinski 2013), `
        + `${state.landform?.radiusM ?? 1.5} m lookup, ${state.landform?.flatnessDeg ?? 3}° flatness — `
        + `tuned so the threshold exceeds the 3 cm LiDAR noise floor within the search radius.`
      : key === "wind"
        ? "Horizon-based shelter proxy toward the prevailing south-west wind. "
          + "Not a flow model: no air is simulated."
      : key === "twi"
      ? "Undefined below tan(0.1°) — a levelled surface has no answer, and reads as the nodata tone."
      : key === "aspect"
        ? "Flat ground has no aspect and renders as the nodata tone, never as north."
        : "Stretched to the percentiles shown; the domain is the data's, not a nominal range.",
    siteLine: `Ørndalen, Tromsø · EPSG:25833 / NN2000 · ${dem.ncols}×${dem.nrows} cells `
      + `at ${dem.cell} m · elevation ${lo.toFixed(2)}–${hi.toFixed(2)} m · `
      + new Date().toISOString().slice(0, 10),
    metrics: figureMetrics(),
  });
  return cv;
}

/** The selected layer as a figure: raster, ramp, units, provenance. */
function exportLayerFigure() {
  const key = currentLayerKey();
  if (!state.dem) return;
  if (!key) { status("Select an analysis layer first", 3000); return; }
  const cv = buildFigure(key);
  if (!cv) { status(`${layerTitle(key)} has not been computed yet`, 4000); return; }
  cv.toBlob((blob) => {
    if (!blob) { status("figure export failed", 4000); return; }
    download(blob, `${exportStem(key)}.jpg`);
    status(`${layerTitle(key)} figure exported · ${cv.width}×${cv.height}`);
  }, "image/jpeg", 0.94);
}

/** @param {HTMLCanvasElement} cv @param {string} type @param {number} [q] */
const canvasBytes = (cv, type, q) => new Promise((resolve) => {
  cv.toBlob((b) => {
    if (!b) { resolve(null); return; }
    b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)));
  }, type, q);
});

/**
 * EVERYTHING, as one archive.
 *
 * The individual buttons above each answer one question; this answers "give me
 * the site". It is the export that matters for handing work to a student, a
 * collaborator or the municipality, because the thing that makes a bundle
 * useful is not the files but the README beside them — a folder of eleven
 * unexplained .tif files is an archive nobody opens twice.
 */
async function exportEverything() {
  const dem = state.dem;
  if (!dem || !state.analysis) return;
  const btn = /** @type {HTMLButtonElement} */ ($("ex-all"));
  btn.disabled = true;
  const t0 = performance.now();
  try {
    status("building bundle — collecting grids…", 0);
    const grids = await state.analysis.grids();
    const files = [];
    const stem = exportStem("bundle");

    // 1. The terrain itself, as a raster and as a mesh.
    files.push({
      name: "terrain/terrain.tif",
      data: writeGeoTIFF(dem.z, dem.nrows, dem.ncols, dem.cell, dem.originX, dem.originY),
    });

    const ex = exportExaggeration();
    const shadeKey = currentLayerKey();
    let textureFile = null;
    if (shadeKey && state.panels[shadeKey]) {
      const tcv = document.createElement("canvas");
      tcv.width = dem.ncols; tcv.height = dem.nrows;
      /** @type {CanvasRenderingContext2D} */ (tcv.getContext("2d"))
        .putImageData(new ImageData(state.panels[shadeKey], dem.ncols, dem.nrows), 0, 0);
      const png = await canvasBytes(tcv, "image/png");
      if (png) {
        textureFile = "terrain_layer.png";
        files.push({ name: `terrain/${textureFile}`, data: png });
      }
    }
    // BOTH representations. They are different readings of the same ground —
    // the smooth mesh interpolates between samples, the boxes state their own
    // resolution — and which one a recipient needs depends on what they are
    // doing with it, not on which one happened to be on screen at export time.
    const enc = new TextEncoder();
    const meshOpts = {
      exaggeration: ex, textureFile,
      layerLabel: shadeKey ? layerTitle(shadeKey) : "none",
    };
    const smooth = buildMesh("mesh", meshOpts);
    files.push({ name: "terrain/terrain.obj", data: enc.encode(smooth.obj) });
    if (smooth.mtl) files.push({ name: "terrain/terrain.mtl", data: enc.encode(smooth.mtl) });

    status("building bundle — voxel mesh…", 0);
    const voxel = buildMesh("voxel", meshOpts);
    files.push({ name: "terrain/terrain_voxels.obj", data: enc.encode(voxel.obj) });
    if (voxel.mtl) files.push({ name: "terrain/terrain_voxels.mtl", data: enc.encode(voxel.mtl) });
    const triangles = smooth.triangles;

    // 2. Every computed layer, twice: values for measuring, figure for reading.
    const layers = [...LIVE_PANELS, ...HEAVY_PANELS].filter((k) => state.panels[k]);
    let n = 0;
    for (const k of layers) {
      n++;
      status(`building bundle — ${layerTitle(k)} (${n}/${layers.length})…`, 0);
      if (grids[k]) {
        files.push({
          name: `analysis/${k}.tif`,
          data: writeGeoTIFF(grids[k], dem.nrows, dem.ncols, dem.cell, dem.originX, dem.originY),
        });
      }
      const cv = buildFigure(k);
      if (cv) {
        const jpg = await canvasBytes(cv, "image/jpeg", 0.94);
        if (jpg) files.push({ name: `figures/${k}.jpg`, data: jpg });
      }
      // Yield to the event loop so the status line actually repaints — a
      // ten-second freeze with a stale message reads as a hang.
      await new Promise((r) => setTimeout(r, 0));
    }

    // 3. The sections, one measured sheet each — the bundle claims to be
    // everything, and a design with sections cut was leaving without them.
    // Re-sampled here like every reading of the ground, never cached.
    const cuts = sectionProfiles();
    for (const s of cuts) {
      const svg = sectionSVG([s], {
        exaggeration: currentExaggeration(),
        site: dem.name, crs: "EPSG:25833",
        behind: [behindProfiles(s)],
        plan: [sectionPlanBand(s)],
      });
      files.push({ name: `sections/section-${s.name}-${s.name}.svg`, data: enc.encode(svg) });
    }

    files.push({ name: "README.txt", data: enc.encode(bundleReadme(layers, triangles, voxel.triangles, ex, textureFile)) });

    status("building bundle — compressing…", 0);
    const zip = makeZip(files);
    download(new Blob([zip], { type: "application/zip" }), `${stem}.zip`);
    const mb = (zip.length / 1048576).toFixed(1);
    status(`bundle exported · ${files.length} files · ${mb} MB · ` +
      `${((performance.now() - t0) / 1000).toFixed(1)} s`, 6000);
  } catch (err) {
    fail(err);
  } finally {
    btn.disabled = false;
  }
}

/** The file that makes the archive readable a year later. */
function bundleReadme(layers, triangles, voxelTris, ex, textureFile) {
  const dem = state.dem;
  const [lo, hi] = dem.zRange();
  const mx = state.metrics;
  const L = [];
  L.push("DL-TerrainDiversity — terrain and analysis export");
  L.push("=".repeat(60));
  L.push("");
  L.push(`Exported   ${new Date().toISOString().slice(0, 19).replace("T", " ")}`);
  L.push(`Source     ${dem.name}`);
  L.push(`Site       Ørndalen, northern Tromsøya, Tromsø, Norway`);
  L.push(`CRS        EPSG:25833 (ETRS89 / UTM 33N), vertical datum NN2000`);
  L.push(`Grid       ${dem.ncols} x ${dem.nrows} cells at ${dem.cell} m`);
  L.push(`Extent     E ${dem.originX} – ${dem.originX + dem.ncols * dem.cell}, ` +
         `N ${dem.originY} – ${dem.originY + dem.nrows * dem.cell}`);
  L.push(`Elevation  ${lo.toFixed(2)} – ${hi.toFixed(2)} m`);
  if (state.ledger.cut > 0 || state.ledger.fill > 0) {
    L.push(`Earthwork  cut ${state.ledger.cut.toFixed(1)} m3 · ` +
           `fill ${state.ledger.fill.toFixed(1)} m3 · net ${state.ledger.netLabel(1)}`);
    L.push("           (this surface has been EDITED in the tool — it is a design,");
    L.push("            not the surveyed ground. terrain/terrain.tif is the edited state.)");
  } else {
    L.push("Earthwork  none — this is the unedited surveyed surface");
  }
  L.push("");
  L.push("CONTENTS");
  L.push("-".repeat(60));
  L.push("terrain/terrain.tif    single-band float32 GeoTIFF, georeferenced.");
  L.push("                       NaN = nodata. Opens in QGIS, SAGA, GDAL.");
  L.push(`terrain/terrain.obj    mesh, ${triangles.toLocaleString()} triangles, Z-up.`);
  L.push("                       COORDINATES ARE LOCAL — add the origin given in");
  L.push("                       the file header to place it. Written local because");
  L.push("                       single-precision CAD viewports quantise UTM values.");
  L.push(ex === 1
    ? "                       Z is TRUE elevation (NN2000)."
    : `                       Z IS EXAGGERATED ${ex}x — divide by ${ex} for true elevation.`);
  if (textureFile) {
    L.push("terrain/terrain.mtl    material referencing the analysis texture below.");
  }
  L.push(`terrain/terrain_voxels.obj  the SAME ground as aggregated boxes,`);
  L.push(`                       ${voxelTris.toLocaleString()} triangles. Each box is a CLOSED`);
  L.push("                       solid and neighbours overlap where they meet, so a");
  L.push("                       boolean union merges them cleanly. Use this one for");
  L.push("                       physical model-making or anything that needs solids;");
  L.push("                       use terrain.obj for a surface.");
  if (textureFile) {
    L.push(`terrain/${textureFile}  the analysis layer as a UV texture, shared by both meshes.`);
  }
  L.push("analysis/*.tif         each layer's VALUES as float32 GeoTIFF — not the");
  L.push("                       colours. Measure these, not the pictures.");
  L.push("analysis/species.tif   CLASS CODES, not a continuous value. NaN = bare or");
  L.push("                       nodata. Load with a paletted/unique-values style:");
  for (let i = 0; i < SPECIES.length; i++) {
    L.push(`                         ${i} = ${SPECIES[i].name}` +
      (SPECIES[i].invasive ? "  [INVASIVE]" : ""));
  }
  if (state.substrate) {
    L.push("analysis/soil.tif      CLASS CODES. NaN = unknown / nodata.");
    L.push(`                       Source: ${state.soilSource}`);
    for (let i = 0; i < Substrate.SUBSTRATE.length; i++) {
      L.push(`                         ${i} = ${Substrate.SUBSTRATE[i].name}`);
    }
    L.push("                       NOT COMPUTED. Substrate is imported or drawn;");
    L.push("                       it is the only layer here that the terrain");
    L.push("                       analysis did not produce.");
  }
  L.push("figures/*.jpg          each layer as a figure with legend, units, scale");
  L.push("                       bar, north arrow and provenance.");
  if (state.sections.list.length) {
    L.push("sections/*.svg         one measured sheet per section line (A-A, B-B, ...),");
    L.push("                       vector at a stated scale. Existing ground dashed,");
    L.push("                       proposed solid; cut and fill hatched in opposite");
    L.push("                       directions. Areas are m2 ON THE SECTION — the");
    L.push("                       earthwork line above is the only volume here.");
  }
  L.push("");
  L.push("LAYERS INCLUDED");
  L.push("-".repeat(60));
  for (const k of layers) L.push(`  ${k.padEnd(12)} ${layerTitle(k)}`);
  L.push("");
  L.push("MEASURED");
  L.push("-".repeat(60));
  if (mx) {
    L.push(`  Relief              ${(hi - lo).toFixed(2)} m`);
    L.push(`  Slope mean          ${mx.slopeMeanDeg.toFixed(2)} deg (Horn 3x3)`);
    L.push(`  Ruggedness (TRI)    ${mx.triMean.toFixed(4)} m (RMS variant)`);
    L.push(`  Geodiversity        ${mx.geodiversity.toFixed(3)} (Shannon evenness over TRI classes)`);
    if (Number.isFinite(mx.landformDiversity)) {
      L.push(`  Landform diversity  ${mx.landformDiversity.toFixed(3)} across ${mx.landformClasses}/10 classes`);
    }
    L.push(`  Water storage       ${mx.storageVolume.toFixed(2)} m3 in ${mx.depressionCount} hollows`);
    L.push(`  TWI defined         ${(100 * mx.twiValidFraction).toFixed(1)}% of cells`);
    if (Number.isFinite(mx.shannon)) {
      L.push(`  Shannon H'          ${mx.shannon.toFixed(3)} of a possible ` +
        `${(mx.shannonMax ?? SHANNON_MAX).toFixed(3)} (natural log, ${mx.speciesTotal ?? SPECIES.length} classes)`);
      L.push(`  Habitats present    ${mx.richness} of ${mx.speciesTotal ?? SPECIES.length}`);
      L.push(`  Invasive cover      ${(100 * mx.invasiveFraction).toFixed(1)}% of vegetated cells`);
    }
  }
  L.push("");
  L.push("METHOD AND HONESTY");
  L.push("-".repeat(60));
  L.push("A TERRAIN ANALYSIS INSTRUMENT, not a predictive model. Indices use the same");
  L.push("definitions as SAGA GIS and QGIS: Horn 3x3 slope and aspect,");
  L.push("Freeman-Quinn multiple-flow-direction accumulation, TWI = ln(a/tan B),");
  L.push("RMS-variant ruggedness, geomorphons after Jasiewicz & Stepinski (2013).");
  L.push("");
  L.push("Conventions that matter when you read these files:");
  L.push("  · TWI is UNDEFINED (NaN) below tan(0.1 deg). A levelled surface has");
  L.push("    no answer, and that degeneracy is deliberate, not a gap in the data.");
  L.push("  · Aspect is NaN on flat ground, never 0. Flat is not north-facing.");
  L.push("  · Closed depressions are INVENTORIED, not filled. A designed hollow");
  L.push("    is the point, so no sink-filling has been applied.");
  L.push("  · Solar radiation is clear-sky POTENTIAL. Ratios between slopes are");
  L.push("    meaningful; the absolute total is an upper bound.");
  L.push("  · Wind exposure is a horizon-based shelter proxy toward the prevailing");
  L.push("    south-west wind, not a flow model. No air is simulated.");
  L.push("  · THE SPECIES LAYER IS NOT A PREDICTION. It is fuzzy habitat suitability");
  L.push("    over stated tolerance envelopes, combined so the worst axis governs.");
  L.push("    It is not fitted to occurrence data, not validated, and carries no");
  L.push("    uncertainty. Read it as the RANGE OF CONDITIONS the surface offers.");
  L.push("    Moisture uses TWI - ln(cell size), which removes the cell-size offset");
  L.push("    in TWI so one set of envelopes serves any resolution.");
  L.push("");
  L.push("LICENCE AND CREDIT");
  L.push("-".repeat(60));
  L.push("Terrain data © Kartverket (hoydedata.no), NLOD / CC BY 4.0.");
  L.push("Credit Kartverket in any publication using these files.");
  // ⚠️ SAID OUT LOUD IN THE BUNDLE, even though the bundle cannot contain the
  // imagery. A recipient who saw the ortho on screen during a demonstration
  // has to know why it is not in here, and that they may not go and fetch it.
  if (state.ortho.rgba) {
    L.push("");
    L.push("NOT INCLUDED: the orthophoto that was draped on screen. That imagery");
    L.push("is licensed for TEACHING AND RESEARCH USE ONLY and may not be");
    L.push("redistributed or published. It is never written into an export by");
    L.push("this tool. Obtain it from the rights holder if you need it.");
  }
  L.push("");
  L.push("DL-TerrainDiversity · Digital Landscapes · www.digital-landscapes.com");
  return L.join("\r\n") + "\r\n"; // CRLF: this is opened in Notepad as often as not
}

$("ex-tif").addEventListener("click", () => { try { exportTerrainGeoTIFF(); } catch (e) { fail(e); } });
$("ex-obj").addEventListener("click", () => { try { exportTerrainOBJ(); } catch (e) { fail(e); } });
$("ex-layer-tif").addEventListener("click", () => { exportLayerGeoTIFF(); });
$("ex-layer-jpg").addEventListener("click", () => { try { exportLayerFigure(); } catch (e) { fail(e); } });
$("ex-all").addEventListener("click", () => { exportEverything(); });

/* ------------------------------------------------------------- view gizmo */

function syncProjButton() {
  const b = $("proj");
  // ⚠️ THE LABEL IS THE ACTION, NOT THE STATE. Every other gizmo button names
  // where pressing it takes you — Top, Front, Right — but this one used to
  // name where you already WERE: it read "Orthographic" precisely while the
  // view was orthographic, so the way back to perspective was a button that
  // never said "Perspective". Reported as "cannot get back to perspective",
  // which is exactly what it looked like. The highlight went with the old
  // reading — an action button has nothing to glow about.
  b.textContent = view.orthographic ? "Perspective" : "Orthographic";
  b.title = view.orthographic
    ? "return to perspective projection"
    : "switch to orthographic projection — parallel lines stay parallel";
  b.classList.remove("on");
}

/**
 * ⚠️ ASKING FOR A CAMERA THE PLAN CANNOT GIVE MEANS "LET ME OUT OF THE PLAN"
 * (2026-08-11). The lock disables these controls, which was survivable while a
 * Plan-mode button existed to press again — but the mode now follows the tool,
 * so a user in a section cut had no visible way back to perspective and the
 * camera read as stuck. Both gizmo paths therefore RELEASE the mode and then
 * do what was asked, rather than sitting dead. Tracing is still protected: the
 * lock exists so a ring is never traced in perspective, and leaving the mode
 * to get perspective satisfies that exactly.
 */
function leavePlanForCamera() {
  if (!state.plan.on) return false;
  setPlanMode(false);
  return true;
}

/* ------------------------------------------------------ looking at a section */

/**
 * Which section is being looked along, and from which side.
 * @type {{id:number, flip:boolean}|null}
 */
let sectionView = null;

/**
 * Rebuild the section buttons in the gizmo from the sections that exist.
 *
 * ⚠️ BUILT FROM THE LIST, NOT WRITTEN IN THE MARKUP. A section is a design
 * object the user makes; its name is assigned when it is cut. The six axis
 * buttons above are a fixed table because there are exactly six axes.
 */
function refreshSectionViewButtons() {
  const wrap = $("gizmo-sections");
  if (!wrap) return;
  const list = state.sections.list;
  wrap.hidden = list.length === 0;
  const want = list.map((s) => String(s.id)).join(",");
  if (wrap.dataset.built !== want) {
    wrap.innerHTML = "";
    for (const s of list) {
      const b = document.createElement("button");
      b.dataset.section = String(s.id);
      b.textContent = `${s.name}–${s.name}`;
      b.title = `look along section ${s.name} — the near side is cut away`;
      wrap.appendChild(b);
    }
    wrap.dataset.built = want;
  }
  for (const b of wrap.querySelectorAll("button")) {
    b.classList.toggle("on",
      !!sectionView && String(sectionView.id) === /** @type {HTMLElement} */ (b).dataset.section);
  }
  // ⚠️ THE READOUT HANGS BELOW THE GIZMO, AND THE GIZMO JUST CHANGED HEIGHT
  // (Marc, 2026-08-19). The readout's resting top was a fixed 137px — true only
  // for a gizmo with no section row — so cutting a section slid the projection
  // button under the readout window. Measured here, the one place that changes
  // the gizmo's height; a dragged readout carries inline coordinates and is
  // unaffected. offsetHeight, not getBoundingClientRect — the gizmo is always
  // rendered, and the trap about closed <details> does not apply to it.
  const giz = $("gizmo");
  if (giz) {
    document.documentElement.style.setProperty(
      "--readout-top", `${giz.offsetTop + giz.offsetHeight + 12}px`);
  }
}

/**
 * The drawn cut face. A heightfield is an open shell, so clipping it produces a
 * hole rather than a face — see section-face.js.
 * @type {SectionFace|null}
 */
let sectionFace = null;

/** Leave the section view, restoring an unclipped scene. */
function clearSectionView(msg) {
  if (!sectionView) return false;
  sectionView = null;
  view.setSectionClip(null);
  sectionFace?.setVisible(false);
  suppressForSection(false);
  refreshSectionViewButtons();
  if (msg) status(msg, 2500);
  return true;
}

/**
 * Rebuild the cut face against the surface as it now stands.
 *
 * ⚠️ IT IS DERIVED FROM THE SURFACE AND CANNOT RIDE THE DIRTY RECT — the fifth
 * such thing in this app, after the contours, the sections, the apron and the
 * selection outline. Every one of them was, at some point, a correct drawing of
 * a surface that no longer existed.
 */
function refreshSectionFace() {
  if (!sectionView || !state.dem) { sectionFace?.setVisible(false); return; }
  const sec = state.sections.list.find((s) => s.id === sectionView.id);
  if (!sec) { sectionFace?.setVisible(false); return; }
  if (!sectionFace) {
    sectionFace = new SectionFace(state.dem,
      { verticalExaggeration: currentExaggeration() });
    view.scene.add(sectionFace.group);
  }
  const p = sampleSection(state.dem, sec.a, sec.b);
  let lo = Infinity;
  for (const z of p.now) if (Number.isFinite(z) && z < lo) lo = z;
  if (!Number.isFinite(lo)) { sectionFace.setVisible(false); return; }
  // The face runs down to just below the lowest ground on the line, which is
  // where the ground grid sits too — deep enough to read as solid, shallow
  // enough not to become a wall.
  const span = Math.max(state.dem.nrows, state.dem.ncols) * state.dem.cell;
  const n = view._clipPlane ? view._clipPlane.normal : { x: 0, y: 1 };
  sectionFace.setExaggeration(currentExaggeration());
  sectionFace.setSection(p, { baseZ: lo - span * 0.05, normal: [n.x, n.y] });
  sectionFace.setVisible(true);
}

/**
 * The overlays that mean nothing in a section, hidden while one is up.
 *
 * ⚠️ MOST OVERLAYS NEED NO HELP, and that is worth stating so nobody adds them
 * here later. The clip is GLOBAL, so every material is cut by it: contours,
 * plan rings and pins that stand beyond the cut go on drawing, which is exactly
 * right — they are the elevation the section reveals — and everything in front
 * of it disappears with the ground it belonged to.
 *
 * ⚠️ THE DIMENSION FRAME IS THE EXCEPTION, because it is not a description of
 * the ground at all: it is the SHEET. Four dimensioned edges and a corner tick
 * around the tile read as a plan's border, and seen edge-on in a section they
 * collapse into a horizontal line through the middle of the drawing with "64 m"
 * floating beside it — apparatus from one drawing laid over another.
 * @param {boolean} on true while a section view is up
 */
function suppressForSection(on) {
  state.dims?.setVisible(!on);
}

/**
 * Look along a section. Pressing the same one again flips the side that is
 * kept; pressing it a third time leaves — which is the same press-again-to-
 * return grammar the axis buttons already use.
 * @param {number} id
 */
function lookAlongSection(id) {
  const sec = state.sections.list.find((s) => s.id === id);
  if (!sec || !state.dem) return;
  leavePlanForCamera();

  const same = sectionView && sectionView.id === id;
  if (same && sectionView.flip) { clearSectionView(`left section ${sec.name}`); return; }
  const flip = !!(same && !sectionView.flip);

  // The profile gives the height to frame and where to aim: a section is worth
  // looking at centred on the ground it cuts, not on the tile's mid-height.
  const p = sampleSection(state.dem, sec.a, sec.b);
  let lo = Infinity, hi = -Infinity;
  for (const z of p.now) if (Number.isFinite(z)) { if (z < lo) lo = z; if (z > hi) hi = z; }
  if (!Number.isFinite(lo)) { status("that section crosses no measured ground", 3000); return; }
  const ex = currentExaggeration();
  // ⚠️ THE FRAME IS IN DRAWN UNITS, NOT GROUND UNITS. The scene stretches z by
  // the exaggeration, so a section framed on its true relief is cropped at 4×.
  const relief = Math.max((hi - lo) * ex, state.dem.cell * 4);
  const zMid = ((lo + hi) / 2) * ex;

  sectionView = { id, flip };
  view.setSectionView(sec.a, sec.b, {
    flip,
    target: [(sec.a[0] + sec.b[0]) / 2, (sec.a[1] + sec.b[1]) / 2, zMid],
    width: p.length,
    height: relief * 1.6,   // room above and below the ground, not a tight crop
  });
  syncProjButton();
  refreshSectionViewButtons();
  refreshSectionFace();
  suppressForSection(true);
  status(`looking along section ${sec.name} · the near side is cut away — `
    + `press ${sec.name}–${sec.name} again to view from the other side`, 5000);
}

for (const b of document.querySelectorAll("#gizmo .grid button")) {
  b.addEventListener("click", () => {
    const name = /** @type {HTMLElement} */ (b).dataset.view;
    if (!name) return;   // a section button; its own handler runs below
    // ⚠️ ASKING FOR AN AXIS VIEW LEAVES THE SECTION, for the same reason asking
    // for perspective leaves the plan: the clip belongs to the section view, and
    // a Top view still carrying a vertical cut through the model would look like
    // half the terrain had been deleted.
    clearSectionView();
    const left = name !== "top" && leavePlanForCamera();
    // Second press of the same button returns to the previous view.
    const returned = view.setAxisView(/** @type {any} */ (name));
    syncProjButton();
    status(left ? `${name} view — drawing tools released the plan`
      : returned ? "back to previous view"
      : `${name} view · orthographic — press again to return`);
  });
}

// Delegated, because the buttons are rebuilt whenever a section is cut or
// deleted — a listener bound to each would be lost on the next rebuild.
$("gizmo-sections").addEventListener("click", (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest("button");
  if (!b || !b.dataset.section) return;
  lookAlongSection(Number(b.dataset.section));
});

// ⚠️ ORBITING OUT OF A SECTION VIEW LEAVES IT — the same grammar that lets
// perspective release the plan. The clip belongs to the square-on view; kept
// through a free orbit it shows the open shell from inside (dark undersides,
// culled gaps, the cut face hanging in space), which was reported as a render
// defect. The view fires this on the first orbit movement while clipped; the
// whole section state has to go, not just the plane, or the gizmo button stays
// lit over an unclipped scene and the cut face floats in a view that no longer
// means anything.
view.onSectionOrbit = () => clearSectionView("orbited out of the section — "
  + "the cut face belongs to its square-on view");

$("proj").addEventListener("click", () => {
  // Perspective and a section clip are different questions; asking for the
  // projection leaves the section, as the axis buttons do.
  clearSectionView();
  // Perspective is the request the plan cannot serve; orthographic it can.
  const left = view.orthographic && leavePlanForCamera();
  view.setOrthographic(!view.orthographic);
  syncProjButton();
  status(left ? "perspective — the plan released; pick a drawing tool to return"
    : view.orthographic ? "orthographic projection" : "perspective projection");
});
syncProjButton();

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

  // ⚠️ UNDO IS THE ONE CHORD THIS APP CLAIMS, and it has to be tested BEFORE the
  // blanket modifier guard below — which exists so that Ctrl+R reloads and
  // Ctrl+1..9 switch tabs instead of driving the camera. Ctrl+Z is different in
  // kind: no browser action is being overridden on a canvas, and a design tool
  // that ignores it is a design tool people lose work in.
  //
  // Both redo spellings are bound because both are in the wild — Ctrl+Shift+Z on
  // macOS and most Linux, Ctrl+Y on Windows — and guessing wrong means the user
  // presses a key and nothing happens, which reads as the feature being broken
  // rather than as the wrong key.
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); stepHistory("undo"); return; }
    if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); stepHistory("redo"); return; }
  }

  // Modifier chords belong to the browser: Ctrl+R is a reload and Ctrl+1..9
  // switch tabs, and the camera silently reacting to them too reads as the
  // view having a mind of its own.
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // Escape folds the whole interface to the chip — unless plan mode is
  // tracing, whose own Escape (abandon the ring) must win: losing a
  // half-drawn ring to a window fold would cost real work.
  if (e.key === "Escape" && !state.plan.on
    && !$("sidebar").classList.contains("min")) {
    $("menu-min").click();
    return;
  }

  // Plan mode's own keys come first, and they take precedence over the camera
  // shortcuts: while a ring is being traced, Escape means "abandon this ring",
  // not anything to do with the view.
  if (state.plan.on) {
    if (e.key === "Escape") {
      if (state.plan.draft.length) {
        state.plan.draft = [];
        state.plan.overlay?.setDraft([], null);
        status("ring abandoned");
      } else {
        selectRegion(null);
      }
      return;
    }
    if (e.key === "Backspace" && state.plan.draft.length) {
      e.preventDefault(); // Backspace is "go back" on some setups
      state.plan.draft.pop();
      state.plan.overlay?.setDraft(state.plan.draft, null);
      status(`${state.plan.draft.length} vertices`, 1200);
      return;
    }
    if (e.key === "Enter" && state.plan.draft.length >= 3) { planCloseRing(); return; }
    if (e.key === "Delete" && state.plan.selected) { deleteRegion(state.plan.selected); return; }
  }

  // Blender-ish numpad shortcuts, without requiring an actual numpad.
  const axis = { "7": "top", "1": "front", "3": "right", "9": "bottom", "2": "back", "4": "left" }[e.key];
  if (axis) {
    // ⚠️ THE KEYBOARD MUST LEAVE THE SECTION EXACTLY AS THE BUTTONS DO. The
    // gizmo's axis buttons clearSectionView() because a Top view still carrying
    // a vertical cut looks like half the terrain was deleted — and the numpad
    // shortcuts are the same request through a different finger. These three
    // key paths kept the clip while their buttons released it, which is two
    // behaviours for one action.
    clearSectionView();
    const returned = view.setAxisView(/** @type {any} */ (axis));
    syncProjButton();
    status(returned ? "back to previous view" : `${axis} view · orthographic — press again to return`);
    return;
  }
  if (e.key === "5") {
    clearSectionView();   // as the projection button does
    view.setOrthographic(!view.orthographic);
    syncProjButton();
    status(view.orthographic ? "orthographic projection" : "perspective projection");
    return;
  }
  // ⚠️ THE BRUSH PALETTE, BY LETTER AND BY SIGN (Marc, 2026-08-13). C and F are
  // the earthwork the buttons now name; + and − are the same two operations as
  // the ledger states them, which is how a designer already thinks about them
  // — "plus material" and "minus material". Both spellings of each key are
  // bound because a keyboard offers several: "+" needs shift on most layouts
  // and arrives as "=" without it, and a numpad sends "Add"/"Subtract".
  // ⚠️ THESE PRESS THE BUTTON RATHER THAN SETTING state.tool. The button's own
  // handler arms the tool, moves the `on` highlight, releases the plan lock and
  // writes the status line; setting the state directly would do the first of
  // those four and silently skip the rest.
  {
    const TOOL_KEYS = {
      c: "t-scoop", f: "t-mound", s: "t-smooth", l: "t-level",
      "-": "t-scoop", "_": "t-scoop", subtract: "t-scoop",
      "+": "t-mound", "=": "t-mound", add: "t-mound",
    };
    const id = TOOL_KEYS[e.key.toLowerCase()];
    if (id) {
      const b = $(id);
      // Plan mode owns the gesture; arming a brush there would fight the tracer.
      if (b && !state.plan.on) { b.click(); return; }
    }
  }

  if (e.key === "z" || e.key === "Z") {
    // Ctrl+Z is undo and was handled above, before the modifier guard, so a
    // bare Z reaching here is unambiguous.
    zoomToSelection();
    return;
  }
  if (e.key === "t" || e.key === "T") {
    // ⚠️ T STEPS, SHIFT+T STEPS BACK, and both are the same walk Ctrl+wheel
    // takes — one order, two ways in. Marc asked for the key after the wheel,
    // so it would have been easy to give it its own list; a second order is a
    // second thing to keep in step with the grid.
    browseLayer(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === "r" || e.key === "R") {
    // R restores the home plan; a home view with a section clip still in force
    // would open on half a site.
    clearSectionView();
    view.resetCamera();
    status("view reset");
  }
});

view.onFrame = () => {
  $("fps").textContent = `${view.fps} fps`;
};

/* ---------------------------------------------------------------------- boot */

window.dl = {
  view, state, clock, THREE, loadTile, loadFile,
  // test hooks
  brushCfg, applyStroke, Stroke, buildFigure, setShading, setPlants, classItems,
  Substrate, adoptSubstrate, loadSubstrateFile, refreshSubstrate,
  paintSoilAt: (x, y) => applySoilPaint({ x, y }),
  writeGeoTIFF, writeOBJ, makeZip, composeFigure,
  exportTerrainGeoTIFF, exportTerrainOBJ, exportLayerGeoTIFF, exportLayerFigure,
  // The solid export, so a check can read the OBJ back and measure it rather
  // than trust the mode that wrote it.
  buildMesh, writeVoxelSolidOBJ, blockClasses, manifoldReport, solidGroups,
  paintAt: (x, y, dt = 0) => applyStroke({ x, y }, dt),
  beginStroke: (cfg) => { state.stroke = new Stroke(state.dem, state.ledger, cfg ?? brushCfg()); },
  // ⚠️ MUST INCLUDE THE FORCED OVERLAY REFRESH, or this hook is a DIFFERENT
  // code path from the one a hand takes. The real pointer-up calls
  // refreshSurfaceOverlays(true) precisely because the in-gesture calls are
  // throttled to 50 ms and the last few frames of a stroke are otherwise never
  // drawn — contours, sections and the apron all left describing ground that
  // has since moved. A check driving this hook saw a torn apron seam and the
  // app did not, which is the wrong way round for a test hook to be wrong.
  endStroke: () => {
    state.stroke = null;
    refreshSurfaceOverlays(true);
    state.analysis?.settle();
  },
  // Plan mode. The hooks are the same calls the pointer handlers make, so a
  // browser-driven check exercises the real path rather than a parallel one.
  setPlanMode, planPlaceVertex, planCloseRing, selectRegion, deleteRegion,
  applyPlanLevel, planExtent, exportPlan, refreshPlan,
  stepLayer, layerOrder, browseLayer,
  writeShapefile, writeGeoJSON, toFeatures, PLAN_FIELDS,
  plan: state.plan,
  // Pattern stamping and contours. Same calls the controls make, so a
  // browser-driven check exercises the real path rather than a parallel one.
  setPatternSource, refreshPattern, applyPatternStamp, patternExtent,
  patternField, patternAmplitude,
  PATTERNS, PATTERN_MEASURED, syncPatternLibrary, renderPatternLibrary,
  setPattern: (id) => { state.pattern.id = id; syncPatternLibrary(); refreshPattern(); },
  setContours: (on, interval) => {
    state.contours.on = !!on;
    if (interval) state.contours.interval = interval;
    syncContours();
  },
  syncContours, CONTOUR_INTERVALS,
  // Undo. The hooks are the same calls the keyboard and the buttons make.
  history, stepHistory, beginEdit, commitEdit,
  undo: () => stepHistory("undo"),
  redo: () => stepHistory("redo"),
  // Sections. sectionPlacepoint is the same call the plan pointer handler makes.
  setInstrument, drawInstrument, hudMetrics, hudState, THEMES,
  sectionPlacepoint, refreshSections, sectionProfiles,
  sampleSection, sectionAreas, sectionSVG, sectionName,
  setSectionsFolded: (on) => { state.sections.folded = !!on; refreshSections(); },
  cutSection: (a, b) => { sectionPlacepoint(a[0], a[1]); sectionPlacepoint(b[0], b[1]); },
  // Rainfall. pondWater is exposed as well as the UI path so a check can settle
  // an event on a surface it built itself, without going through the sidebar.
  refreshWater, pondWater, absorbedDepth, INFILTRATION, WaterField,
  // The experiment — exposed so a check (or the console) can run it on a
  // surface it built itself, without going through the sidebar.
  compareAt, compareSchemes, measureSurface, matchUniformInterval, EXPERIMENT,
  // The patchwork — the class for a check to build against its own DEM, and
  // the live overlay (a function, because the variable reassigns on tile
  // switches and a snapshot would go stale).
  landformPatches, geomorphons, LANDFORMS, PatchOverlay,
  patchOverlay: () => patchOverlay,
  setRainfall: (metres) => {
    state.water.on = true;
    state.water.rain = metres;
    refreshWater();
    return state.water.result;
  },
};

// ⚠️ DRIVE THE PATTERN PANEL FROM THE STATE, NOT FROM THE MARKUP. The buttons'
// `on` class and the two sub-panels' `hidden` attributes are written by hand in
// index.html and were the only thing deciding what the panel showed — so the
// state could say "generated" while the markup showed the image drop target,
// and nothing would notice. One call at boot makes the state authoritative.
setPatternSource(state.pattern.source);

// Same rule for the shading: the state opens on cut/fill, and the grid's
// highlight is written from it here rather than left for the first click to
// reconcile. (Under the old dropdown nothing did this, so the select showed
// "Elevation" over a cut/fill terrain until the first change.)
setShading(state.shading);

// ⚠️ THE TOOL OPENS ON SIXTEEN DEFORMATIONS (Marc, 2026-08-19), and the two
// tiles it used to open on were each wrong in an opposite direction. The FLAT
// PLANE said nothing about terrain at all — every reading in the readout was
// zero or undefined, so the instrument read as broken rather than as empty. A
// SURVEYED ØRNDALEN PATCH said too much about one place: it made the tool look
// like a study of a landfill rather than an instrument for ground.
// The generated tile is neither. It has something true to report in every field
// of the readout from the first frame, and it is the pattern library laid out
// as a GRADIENT — most geometric and least consequential at the top left, most
// differentiating at the bottom right — so the argument is on screen before
// anyone has clicked anything. Both old tiles are still in the dropdown.
//
// ⚠️ AND IT OPENS IN PLAN (2026-08-11): top view, orthographic, the patch
// centred by the measured fit — the sheet a designer starts on, and the view
// the first Level gesture is legible in. R returns here. The oblique working
// view is one orbit away, which is the right price for it.
loadTile(GENERATED_TILE).then(() => {
  view.setOrthographic(true);
  // The whole sheet, dimensions included — the frame's figures are part of
  // the drawing, and a fit that cropped them framed the patch, not the sheet.
  if (state.surface) view.planFrame(sheetBox(), { seconds: 0 });
  view.home = view.getCameraState();
  syncProjButton();
  // The readout follows the menu from the first frame: sidebar.js has
  // restored the fold by now (its module runs before this async load lands).
  // ⚠️ OFF AT BOOT. The readout window carries every figure the overlay does,
  // so starting it on would open the tool showing each number twice. It is
  // turned on deliberately, from View → Instrument, when the band-and-strip
  // frame is wanted — which in practice means a screen recording.
  setInstrument(false);
}).catch(fail);
