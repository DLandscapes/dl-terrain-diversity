// @ts-check
/**
 * VEGETATION AS VERTICAL LINE-WORK — the biomass a cell supports, drawn as
 * stems, not as pictures of plants.
 *
 * ⚠️ WHY THIS REPLACED THE GROWTH-FORM SILHOUETTES. The previous scatter drew
 * each species as a small solid body — cushion, tuft, stem-and-crown — and the
 * bodies were good drawings that answered the wrong question. Reading them, you
 * identified a shrub or a grass; you could not see how much standing material
 * the ground was carrying, or where it was concentrated, which is the quantity
 * the topographic decisions in this tool actually move. Seven silhouettes at
 * twelve thousand instances also read as a scatter of objects standing ON the
 * terrain rather than as a property OF it.
 *
 * The line-work asks the other question. A stem's HEIGHT is the stature the
 * assemblage supports there, and its COUNT is the cover — so a mat of moss is
 * many short strokes, a willow is one tall one, and the difference between a
 * hollow and a levelled plane is visible as a change in the weight of the
 * drawing rather than as a change of icon.
 *
 * ⚠️ IDENTITY DELIBERATELY LEFT OUT. Four strata, not seven species: which
 * species holds a cell is the species raster's job and the legend's, and it is
 * already asserted there (kernel group N). Encoding it here as well would mean
 * seven marks that must stay tellable apart at one pixel — the problem greyscale
 * tone already failed at, for the arithmetic reason recorded in plants.js. Left
 * out, the channel is free to carry structure, which is what the drawing is for.
 *
 * ⚠️ THIS IS NOT A BIOMASS MEASUREMENT AND MUST NEVER BE LABELLED AS ONE. The
 * model is a fuzzy habitat-suitability instrument; it knows which species is
 * best suited to a cell and how well, and nothing whatever about kilograms.
 * What is drawn is the STANDING STRUCTURE IMPLIED BY THE ASSEMBLAGE — the
 * stature and cover of the growth form that wins, scaled by how well it wins.
 * That is an honest reading of the model's own output. "Biomass" in the UI is
 * shorthand and the note beside the toggle says which.
 *
 * ⚠️ PLANTS STILL MAY NOT MOVE. `plants.js` established the rule: a candidate
 * is seeded once and bound permanently to a cell, so a plant may appear or
 * vanish but never slide. It is kept here, and it is what makes the density
 * difference between strata possible at all — see `_thin` below.
 *
 * ⚠️ PRISMS, NOT LINES, AND WEBGL LEAVES NO CHOICE. `LineBasicMaterial`'s
 * `linewidth` is ignored by every WebGL implementation — lines are always one
 * pixel — so line WEIGHT, which is how the strata are told apart at a glance,
 * cannot be drawn with real lines. A very thin vertical box reads as a line,
 * carries a real width in metres so it thickens as you zoom in like every other
 * measured thing in this tool, and has no alpha anywhere, which keeps it clear
 * of the whole class of cutout defects `plants.js` documents.
 */
import * as THREE from "three";
import { SPECIES } from "./analysis/species.js";
import { CATEGORICAL } from "./analysis/ramps.js";

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3(0, 0, 1);

/** How hard the sky-view factor darkens a stem. Matches plants.js and voxels.js. */
const AO_STRENGTH = 0.45;

/** One ink for the whole drawing, as the wireframe and the lattice use. */
export const STEM_INK = 0x1c1a16;

/**
 * ⚠️ COLOUR IS OPT-IN AND MONO IS THE DEFAULT, and that ordering is the whole
 * of the decision.
 *
 * The scatter went greyscale for a project-level reason rather than a taste
 * one, recorded in plants.js: the A1 exhibition poster prints black and white,
 * so the tool, the poster and the video share ONE drawing language instead of
 * three. That still holds, and it is why nothing here changes unless it is
 * asked for.
 *
 * ⚠️ BUT ONE OF THE REASONS FOR GREYSCALE NO LONGER APPLIES. plants.js chose it
 * partly because painting three-dimensional plant BODIES in the raster's data
 * colours put the scatter in an uncanny middle — "plant silhouettes in colours
 * no plant has". A stem is not a picture of a plant; it is a diagram mark, like
 * a contour or a hatch. A data palette sits honestly on a diagram mark, and the
 * objection does not transfer.
 *
 * ⚠️ SO THE COLOURS ARE THE RASTER'S OWN, NOT A NEW SET. `CATEGORICAL.species`
 * already carries the seven, chosen so the data is legible and the invasive is
 * unmistakable, and the legend and the species panel are already drawn in them.
 * Inventing a second species palette here would give the same seven classes two
 * appearances in one interface and make the scatter disagree with the map of
 * itself. Colour here means exactly what colour means everywhere else in this
 * tool: which class this is.
 */
export const PALETTES = ["mono", "species"];

/**
 * A few millimetres of clearance under every mark.
 *
 * ⚠️ NOT A SUBSTITUTE FOR SAMPLING THE RIGHT HEIGHT — `_groundZ` does that, and
 * a lift large enough to hide a sampling error would be large enough to see the
 * marks floating. This is only depth-buffer insurance: the ground tick lies flat
 * and a flat mark exactly coincident with a facet is a tie at every pixel, which
 * resolves differently at different angles and makes the plan view flicker as
 * the camera turns. Four millimetres on ground with 5.3 m of relief.
 */
const GROUND_LIFT = 0.004;

/**
 * Above this cell size the layer switches itself off — carried over from
 * plants.js unchanged, and for the reason recorded there: on the 4 m tile the
 * tallest stem is under a tenth of a percent of the span, so drawing it would
 * be drawing nothing while implying the scale works.
 */
export const MAX_CELL_M = 1.0;

/**
 * THE FOUR STRATA.
 *
 * `h` is the real height in metres, taken from the growth forms in plants.js so
 * the two drawings cannot drift apart. `w` is the stem's width — the line
 * weight, in true metres. `per` is stems per square metre at full cover.
 *
 * ⚠️ THE DENSITIES ARE THE ARGUMENT, not a look. A mat, a crust and a sward are
 * CONTINUOUS COVER — plants.js already had to record that sizing them as
 * countable individuals was wrong twice over — so they draw as many short
 * strokes. A willow is one plant with a crown. Setting every stratum to one
 * stem per plant would make a moss mat and a shrub equally sparse, and the
 * whole point is that they are not.
 *
 * ⚠️ `tick` IS WHAT THE LAYER LOOKS LIKE IN PLAN, and it is not decoration. A
 * vertical line seen from directly above is a point, and plan mode LOCKS the
 * camera to top orthographic — it refuses perspective outright. Without a mark
 * lying flat on the ground the entire layer would vanish in the one view the
 * tool forces. With it, the plan reading is a stem-density map: dense stipple
 * where cover is continuous, scattered dots where individuals stand. That is a
 * real drawing convention and it carries the same quantity the elevation does.
 */
/**
 * `vary` is the log-normal spread of individual size, as a multiplier: 0.5
 * gives roughly 0.6×–1.65×, 0.85 roughly 0.43×–2.3×.
 *
 * ⚠️ IT IS NOT ONE NUMBER FOR EVERY STRATUM, and using one is what made the
 * shrubs read as a row of identical posts. A moss mat genuinely is uniform —
 * that is what "continuous cover" means — while a stand of willow is a few
 * large individuals among many small, which is the log-normal shape plants.js
 * already found and the reason a flat spread looks stamped rather than grown.
 * The taller the stratum, the wider the spread, and the shrub layer is where it
 * has to be widest because it is the one you can count.
 *
 * `canopy` is the crown's radius as a fraction of the individual's own height,
 * so a big willow carries a big crown and a small one a small crown, with no
 * second random number: the variation is already in the height.
 */
export const STRATA = [
  //  height  width  stems/m²  tick   vary  crown dashes  canopy r/h
  { id: "ground", label: "ground layer — mats, crusts and swards",
    h: 0.06, w: 0.014, per: 14, tick: 0.105, vary: 0.30, crown: 0, canopy: 0 },
  { id: "herb", label: "herb layer — forbs and tussocks",
    h: 0.30, w: 0.020, per: 5, tick: 0.115, vary: 0.48, crown: 0, canopy: 0 },
  { id: "tall", label: "tall herb layer — the invasive's stature",
    h: 0.80, w: 0.028, per: 2, tick: 0.135, vary: 0.60, crown: 0, canopy: 0 },
  { id: "shrub", label: "shrub layer — woody, with a crown held clear",
    h: 0.95, w: 0.044, per: 0.7, tick: 0.170, vary: 0.85,
    branches: 9, foliage: 34, canopy: 0.46 },
];

/**
 * ⚠️ THE TICKS ARE SIZED AGAINST THE PIXEL, NOT AGAINST THE PLANT, and the
 * first pass got it wrong in exactly the way plants.js already warned about.
 * At 0.055 m a tick was under one pixel with the 64 m patch framed whole — a
 * 950 px viewport puts about 0.067 m in a pixel — so the plan reading the whole
 * ground-tick decision exists for measured 2.7% of the frame and was, in
 * practice, a faint grey wash. Enlarged, it registers.
 *
 * This is not a fudge for visibility: plants.js reached the same conclusion for
 * the same forms on ecological grounds, that a mat, a crust and a sward are
 * PATCHES rather than countable individuals, and that "sizing it as one makes
 * it both visible and more accurate". A ground tick wider than its stem is tall
 * is the honest shape of continuous cover.
 */

/**
 * Which stratum each modelled species belongs to, BY ITS GROWTH FORM.
 *
 * ⚠️ DERIVED FROM THE FORM, NEVER LISTED BY SPECIES ID. The seven species are
 * the model's business and this file has no opinion about them; if an eighth is
 * ever wired in, it lands in a stratum because of the shape it grows in, with
 * no edit here. A form this table does not know falls to the herb layer, which
 * is the middle of the range and the least wrong place to be wrong.
 */
const STRATUM_OF_FORM = {
  crust: 0, mat: 0, sward: 0, "prostrate-mat": 0, hummock: 0, rosette: 0,
  herb: 1, tussock: 1, "cotton-head": 1, whorl: 1, "dwarf-shrub": 1,
  "tall-forb": 2, wand: 2, umbel: 2,
  shrub: 3, tree: 3,
};

/** species code -> stratum index, built once from the model's own table. */
export const STRATUM_OF_SPECIES = SPECIES.map(
  (s) => STRATUM_OF_FORM[s.form] ?? 1);

/**
 * The seven species colours, 0–1, taken straight from the raster's own table.
 *
 * ⚠️ READ FROM `CATEGORICAL.species`, NEVER COPIED. A transcription here would
 * be a second opinion about what colour a lupine is, and the two would drift
 * the first time the raster's palette was tuned — leaving the 3D scatter and
 * the map of it disagreeing, in a tool whose whole argument is that the picture
 * and the reading are the same event.
 */
const SPECIES_RGB = CATEGORICAL.species.colours.map(
  ([r, g, b]) => [r / 255, g / 255, b / 255]);

/** Deterministic RNG — the scatter must be identical from run to run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One stratum's geometry: a vertical stem standing on z = 0, a flat tick lying
 * on the ground at its foot, and for the shrub a crown of short vertical dashes
 * held clear of the ground beside it.
 *
 * ⚠️ THE CROWN IS DETACHED ON PURPOSE. A willow's mass is carried in a canopy
 * over a short bole, and drawing it as extra stem height would say the mass is
 * at the stem. Dashes that start above the ground and do not touch it say the
 * opposite, in the same vocabulary, without adding a second kind of mark.
 *
 * ⚠️ EVERYTHING IS BUILT AROUND x = y = 0 AND FROM z = 0 UP. plants.js records
 * what happens otherwise: a body built around the origin rather than on top of
 * it sits half underground, silently, and nothing throws.
 * @param {typeof STRATA[number]} S
 */
export function stemGeometry(S) {
  const parts = [];
  const box = (w, d, h, x, y, z, rotZ = 0) => {
    const g = new THREE.BoxGeometry(w, d, h);
    if (rotZ) g.rotateZ(rotZ);
    g.translate(x, y, z + h / 2);
    parts.push(g);
  };
  /** A horizontal member — a branch — running out from the axis at angle `a`. */
  const bar = (len, thick, a, z, r0 = 0) => {
    const g = new THREE.BoxGeometry(len, thick, thick);
    g.translate(len / 2 + r0, 0, 0);        // grow outward from the stem
    g.rotateZ(a);
    g.translate(0, 0, z);
    parts.push(g);
  };
  /**
   * A ring lying FLAT in the XY plane — an annulus, with real width.
   *
   * ⚠️ THIS WAS AN OPEN-ENDED CYLINDER AND THAT IS WHY THE CIRCLES WERE
   * INVISIBLE FROM ABOVE. A cylinder wall is a surface with no thickness: stood
   * on end it draws a perfect circle in elevation and, seen from directly
   * overhead, presents its edge — zero pixels, at every zoom. It cost nothing
   * and drew nothing, in the one view plan mode locks the camera to. An annulus
   * has width in the plane it is read in, which is the whole point of it.
   */
  const flatRing = (rInner, rOuter, z, seg = 20) => {
    const g = new THREE.RingGeometry(rInner, rOuter, seg);
    g.translate(0, 0, z);                   // RingGeometry already lies in XY
    parts.push(g);
  };
  /**
   * ⚠️ HATCH DRAWN AS GEOMETRY, NOT AS A TEXTURE. This project's printed poster
   * already uses hatching where anything else would use colour, and a hatch that
   * is real line-work stays that at any zoom, prints, and keeps the layer free
   * of maps and alpha — the property that makes the whole class of cutout
   * defects unreachable. A texture would have re-imported all of it to draw
   * four lines.
   *
   * Bars run at 45° and are cut to the chord of the circle they sit in, so the
   * fill stops at the outline instead of overshooting it into a square.
   */
  const hatchedDisc = (r, t, z, bars = 4) => {
    flatRing(r * 0.82, r, z);
    const step = (2 * r) / (bars + 1);
    const a = Math.PI / 4;
    for (let i = 1; i <= bars; i++) {
      const d = -r + i * step;                       // offset from the centre
      const chord = 2 * Math.sqrt(Math.max(0, r * r - d * d));
      if (chord < r * 0.12) continue;
      box(chord, r * 0.10, t, -Math.sin(a) * d, Math.cos(a) * d, z, a);
    }
  };

  // The stem, full height from the ground.
  box(S.w, S.w, S.h, 0, 0, 0);

  // ⚠️ THE GROUND MARK IS A HATCHED CIRCLE, NOT A SQUARE. A square reads as a
  // pixel or a tile — something to do with the grid — and the grid is exactly
  // what this layer is not about. A hatched circle reads as an area of cover,
  // which is what it is, and it matches the poster's own fill language.
  hatchedDisc(S.tick / 2, S.w * 0.5, 0, 4);

  /**
   * THE CROWN, DRAWN AS A PLAN CONVENTION: branches radiating from the stem,
   * and a scatter of small circles for the foliage they carry.
   *
   * ⚠️ THE EXTENT IS IMPLIED BY THE SCATTER, NOT DRAWN AS AN OUTLINE. A single
   * ring at the canopy's spread states a boundary the model does not have — a
   * crown has no edge, it thins out — and it made every willow the same
   * cartographic symbol at a different scale. Where the circles stop is where
   * the canopy stops, and because they are scattered the reading is of density
   * falling off rather than of a line being crossed.
   *
   * ⚠️ AND THE BRANCHES SIT AT DIFFERENT HEIGHTS. Radiating them all at one
   * elevation makes a flat plate that is a star in plan and a single hard line
   * in every other view. Spread through the upper half of the stem they read as
   * a crown from an angle and still resolve to the star from directly above,
   * which is the view this drawing is for.
   */
  if (S.branches) {
    const rnd = mulberry32(0x5e3d + Math.round(S.h * 1000));
    const R = S.h * S.canopy;
    for (let i = 0; i < S.branches; i++) {
      const a = (i / S.branches) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
      const len = R * (0.62 + rnd() * 0.38);
      bar(len, S.w * 0.34, a, S.h * (0.54 + rnd() * 0.42), S.w * 0.4);
    }
    for (let i = 0; i < S.foliage; i++) {
      // Distributed by the square root of a uniform draw, so the circles are
      // spread evenly over the crown's AREA rather than crowding the middle,
      // which is what a linear radius does and what makes a scatter look like
      // a target.
      const a = rnd() * Math.PI * 2;
      const r = R * (0.16 + 0.84 * Math.sqrt(rnd()));
      const rad = S.h * (0.030 + rnd() * 0.028);
      flatRing(rad * 0.62, rad, S.h * (0.50 + rnd() * 0.48), 10);
      // The ring is built at the origin, so move it out to its place.
      const g = parts[parts.length - 1];
      g.translate(Math.cos(a) * r, Math.sin(a) * r, 0);
    }
  }
  return mergeParts(parts);
}

/**
 * Merge indexed geometries into one.
 *
 * Hand-written for the same reason plants.js writes its own: BufferGeometryUtils
 * lives in three's examples and this project vendors only the core module.
 * Boxes and open cylinders both arrive here indexed, with position and normal.
 * @param {THREE.BufferGeometry[]} parts
 */
function mergeParts(parts) {
  let nPos = 0, nIdx = 0;
  for (const g of parts) {
    nPos += g.attributes.position.count;
    nIdx += /** @type {THREE.BufferAttribute} */ (g.index).count;
  }
  const pos = new Float32Array(nPos * 3);
  const nor = new Float32Array(nPos * 3);
  const idx = new Uint16Array(nIdx);
  let vo = 0, io = 0;
  for (const g of parts) {
    const p = g.attributes.position.array, nrm = g.attributes.normal.array;
    pos.set(p, vo * 3);
    nor.set(nrm, vo * 3);
    const gi = /** @type {THREE.BufferAttribute} */ (g.index).array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export class StemField {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number, density?: number, seed?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.exaggeration = opts.verticalExaggeration ?? 1;
    this.seed = opts.seed ?? 20260807;
    /** @type {Float32Array|null} sky-view factor, for occlusion */
    this.ao = null;
    /** "mono" | "species" — see PALETTES. Mono is the committed default. */
    this.palette = "mono";
    /** @type {Uint8Array|null} */
    this._lastCodes = null;

    // Seeded at the DENSEST stratum's requirement; every other stratum draws a
    // stable subset of the same candidates. See `_thin`.
    const areaM2 = dem.ncols * dem.cell * dem.nrows * dem.cell;
    const want = Math.round(areaM2 * (opts.density ?? STRATA[0].per));
    this.count = Math.max(600, Math.min(60000, want));

    // The UTM origin lives here and nowhere else — everything below is local.
    // The rule that cost this project three phases; see plants.js.
    this.group = new THREE.Group();
    this.group.position.set(dem.originX, dem.originY, 0);
    this.group.renderOrder = 1;

    this._buildCandidates();
    this._buildMeshes();
    /** stems drawn per stratum at the last update, for the caller's readouts */
    this.drawn = new Int32Array(STRATA.length);
  }

  /**
   * Lay the candidates down once. Each is bound to a cell for the life of the
   * field, which is what makes a stem unable to move.
   */
  _buildCandidates() {
    const { nrows, ncols, cell } = this.dem;
    const rnd = mulberry32(this.seed);
    const n = this.count;
    this.cellOf = new Int32Array(n);
    this.localX = new Float32Array(n);
    this.localY = new Float32Array(n);
    this.rot = new Float32Array(n);
    /**
     * Raw size draw in [-1, 1]. The log-normal spread is applied at UPDATE time,
     * not here, because how much a stratum varies is a property of the stratum
     * and a candidate does not know which stratum it will be in — its cell can
     * change species on any gesture. Baking one spread in at build time is what
     * made every shrub the same height.
     */
    this.size01 = new Float32Array(n);
    /**
     * A second, independent stretch on height alone. Two individuals of the
     * same girth can be quite different heights, and varying only overall size
     * makes every stem a copy at a different zoom — plants.js found the same.
     */
    this.aspect = new Float32Array(n);
    /** Per-individual lightness multiplier, used only by the species palette. */
    this.tone = new Float32Array(n);
    /**
     * A stable 0..1 rank per candidate. A stratum draws only the candidates
     * below its own share, so thinning is a threshold rather than a re-roll —
     * which is exactly why a stem can vanish without any stem moving.
     */
    this.rank = new Float32Array(n);

    const northY = nrows * cell;
    for (let k = 0; k < n; k++) {
      const r = Math.min(nrows - 1, Math.floor(rnd() * nrows));
      const c = Math.min(ncols - 1, Math.floor(rnd() * ncols));
      this.cellOf[k] = r * ncols + c;
      this.localX[k] = (c + rnd()) * cell;
      this.localY[k] = northY - (r + rnd()) * cell;
      this.rot[k] = rnd() * Math.PI * 2;
      this.size01[k] = rnd() * 2 - 1;
      this.aspect[k] = 0.74 + rnd() * 0.62;
      this.rank[k] = rnd();
      // A stable per-individual lightness, so a stand of one species is not a
      // flat wash of one colour. Kept narrow: wide enough that no two plants
      // are the same, tight enough that the SPECIES is still what the colour
      // says. Fixed per candidate, like every other property here, so it cannot
      // shimmer between passes.
      this.tone[k] = 0.86 + rnd() * 0.28;
    }
  }

  /** The share of candidates a stratum draws — 1 for the densest. */
  _thin(s) { return Math.min(1, STRATA[s].per / STRATA[0].per); }

  /**
   * The height of the DRAWN SURFACE at a local point — not the height of the
   * cell the point falls in.
   *
   * ⚠️ THIS IS WHY MARKS WERE HALF-BURIED, and it is the lattice bug in its
   * third costume. A stem stands at a random point INSIDE its cell, but it was
   * given `z[cell]`, which is the height at that cell's CENTRE. Between centres
   * the rendered surface is a triangle rising or falling across the gap, so on
   * any slope the ground under the stem is somewhere else — up to half a cell's
   * fall away — and the flat ground tick, which has no thickness to spare, ends
   * up sunk on one side of the mark and floating on the other.
   *
   * ⚠️ AND IT MUST BE INTERPOLATED OVER THE TRIANGLE, NOT THE QUAD. surface.js
   * splits every quad `a,d,b` and `b,d,e` — diagonal from (r,c+1) to (r+1,c) —
   * and a bilinear read of the four corners agrees with that only along the
   * diagonal itself. This project has already paid for that distinction twice:
   * contours had to be marched over triangles, and a quad chord sits 0.25 m
   * below the facet on a 1 m cell.
   *
   * @param {number} lx @param {number} ly local metres
   * @param {number} fallback cell index to use where the grid has holes
   */
  _groundZ(lx, ly, fallback) {
    const { nrows, ncols, cell, z } = this.dem;
    const northY = nrows * cell;
    const fc = lx / cell - 0.5, fr = (northY - ly) / cell - 0.5;
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    if (r0 < 0 || c0 < 0 || r0 + 1 >= nrows || c0 + 1 >= ncols) return z[fallback];
    const u = fc - c0, v = fr - r0;
    const za = z[r0 * ncols + c0];
    const zb = z[r0 * ncols + c0 + 1];
    const zd = z[(r0 + 1) * ncols + c0];
    const ze = z[(r0 + 1) * ncols + c0 + 1];
    // A hole anywhere in the quad and there is no facet to stand on; the cell's
    // own value is the honest fallback rather than an interpolation through NaN.
    if (!Number.isFinite(za) || !Number.isFinite(zb)
      || !Number.isFinite(zd) || !Number.isFinite(ze)) return z[fallback];
    return u + v <= 1
      ? za + u * (zb - za) + v * (zd - za)
      : ze + (1 - u) * (zd - ze) + (1 - v) * (zb - ze);
  }

  /**
   * One instanced mesh per stratum. No second wireframe pass, unlike the growth
   * forms: a stem IS the line, and drawing the edges of a box that is fourteen
   * millimetres wide adds a second draw call to describe nothing.
   *
   * ⚠️ MeshBasicMaterial, NOT Lambert. These are drawn marks, not lit objects —
   * shading a 14 mm prism by its own normals gives three tones down one line
   * and makes the drawing look like plumbing. Flat ink keeps it line-work, and
   * the sky-view occlusion still arrives per instance, which is the one shading
   * that carries information.
   */
  _buildMeshes() {
    /** @type {THREE.InstancedMesh[]} */
    this.meshes = [];
    for (let s = 0; s < STRATA.length; s++) {
      const geo = stemGeometry(STRATA[s]);
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(STEM_INK),
        // Only the ground grid fades; everything else opts out. Omitting this
        // dissolved the whole scatter into the sky at distance — see plants.js.
        fog: false,
        // ⚠️ DoubleSide, unlike the terrain. surface.js is FrontSide because a
        // heightfield is a function graph with nothing underneath, and drawing
        // both faces made front and back compete for depth at grazing angles.
        // These are flat rings a few millimetres across: a single-sided annulus
        // disappears the moment the camera passes below its plane, which for a
        // canopy circle is most of an orbit. No depth competition to invite —
        // there is no second surface behind them.
        side: THREE.DoubleSide,
      });
      mat.vertexColors = false;
      const cap = Math.ceil(this.count * this._thin(s)) + 1;
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(cap * 3).fill(1), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;   // instances span the whole tile
      m.name = `stems:${STRATA[s].id}`;
      this.group.add(m);
      this.meshes.push(m);
    }
  }

  /**
   * Re-assign every candidate to the stratum of whichever species won its cell.
   * One pass over the candidates plus a partial upload, once per worker result.
   * @param {Uint8Array} codes the assemblage, one class per cell
   */
  update(codes) {
    if (!codes) return;
    this._lastCodes = codes;
    const { z } = this.dem;
    const ex = this.exaggeration;
    const svf = this.ao;
    const nSt = STRATA.length;
    const used = this.drawn;
    used.fill(0);
    const nSp = STRATUM_OF_SPECIES.length;
    const colour = this.palette === "species";

    for (let k = 0; k < this.count; k++) {
      const i = this.cellOf[k];
      const sp = codes[i];
      // 254 (bare) and 255 (nodata) are answers, not species: nothing is drawn.
      if (sp >= nSp) continue;
      const zv = z[i];
      if (!Number.isFinite(zv)) continue;
      const st = STRATUM_OF_SPECIES[sp];
      // Thinning: a sparse stratum draws only the low-ranked candidates. The
      // threshold is stable per candidate, so switching species makes stems
      // appear and disappear in place and never slide.
      if (this.rank[k] >= this._thin(st)) continue;

      // POSITION follows the exaggerated surface — a stem must stand on the
      // ground as drawn. HEIGHT does not: stretching stature by the terrain's
      // exaggeration made every plant spindly, and the height is a stated
      // quantity in metres, not a display choice.
      const lx = this.localX[k], ly = this.localY[k];
      _p.set(lx, ly, this._groundZ(lx, ly, i) * ex + GROUND_LIFT);
      _q.setFromAxisAngle(_axis, this.rot[k]);
      // ⚠️ SIZE SCALES ALL THREE AXES, height then stretched again on its own.
      // Scaling Z alone left every crown the same width however tall its stem
      // was, so the canopy circles in plan were identical discs — the one
      // reading that is supposed to say how much room an individual takes.
      const gg = Math.exp(this.size01[k] * STRATA[st].vary);
      _s.set(gg, gg, gg * this.aspect[k]);
      _m.compose(_p, _q, _s);
      const slot = used[st]++;
      const mesh = this.meshes[st];
      if (slot >= mesh.instanceMatrix.count) { used[st]--; continue; }
      mesh.setMatrixAt(slot, _m);

      // ⚠️ ONE ATTRIBUTE CARRIES BOTH SHADING AND IDENTITY, because three
      // multiplies material colour × instance colour and there is only one
      // instance colour. In mono the material holds the ink and this attribute
      // is the sky-view shade alone; in species mode the material is white and
      // this attribute is the species colour with the same shade multiplied in.
      // Keeping the occlusion in BOTH is the point — colour is not a licence to
      // stop drawing the hollow a plant is standing in.
      const a = svf
        ? 1 - AO_STRENGTH * (1 - Math.min(1, Math.max(0, svf[i])))
        : 1;
      if (colour) {
        const rgb = SPECIES_RGB[sp] || SPECIES_RGB[0];
        const t = a * this.tone[k];
        mesh.instanceColor.setXYZ(slot, rgb[0] * t, rgb[1] * t, rgb[2] * t);
      } else if (svf) {
        mesh.instanceColor.setXYZ(slot, a, a, a);
      } else {
        mesh.instanceColor.setXYZ(slot, 1, 1, 1);
      }
    }

    for (let s = 0; s < nSt; s++) {
      const mesh = this.meshes[s];
      mesh.count = used[s];
      if (used[s] > 0) {
        // Upload only the slots written; the buffers are sized for this
        // stratum's worst case and uploading all four in full every pass would
        // be megabytes a gesture.
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, used[s] * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (svf) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  /** Alias kept so the caller reads the same as it did for the old scatter. */
  setCodes(codes) { this.update(codes); }

  /**
   * Switch between the committed mono drawing and the species palette.
   *
   * ⚠️ THE MATERIAL COLOUR MUST FLIP WITH IT. three multiplies material colour
   * by instance colour, so leaving the material at the near-black ink and
   * writing species colours into the instances multiplies one by the other and
   * yields seven barely-distinguishable darks — which looks like the palette
   * not working rather than like two colours being multiplied. White material
   * lets the instance colour through unchanged.
   * @param {"mono"|"species"} mode
   */
  setPalette(mode) {
    const next = mode === "species" ? "species" : "mono";
    if (next === this.palette) return;
    this.palette = next;
    for (const m of this.meshes) {
      /** @type {THREE.MeshBasicMaterial} */ (m.material).color.set(
        next === "species" ? 0xffffff : STEM_INK);
    }
    if (this._lastCodes) this.update(this._lastCodes);
  }

  /**
   * The sky-view factor grid — the same one the terrain is shaded by, so ground
   * and vegetation are occluded by one measure. Arrives only on settle.
   * @param {Float32Array|null} svf
   */
  setAO(svf) {
    this.ao = svf || null;
    if (this._lastCodes) this.update(this._lastCodes);
  }

  /** @param {number} v */
  setExaggeration(v) {
    this.exaggeration = v;
    if (this._lastCodes) this.update(this._lastCodes);
  }

  setVisible(v) { this.group.visible = v; }

  /** Total stems standing, for the readout. */
  get total() {
    let t = 0;
    for (const v of this.drawn) t += v;
    return t;
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry.dispose();
      /** @type {THREE.Material} */ (m.material).dispose();
      m.dispose();
    }
    this.meshes.length = 0;
    this.group.clear();
  }
}
