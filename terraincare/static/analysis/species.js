// @ts-check
// THE BIOTIC LAYER — a habitat-suitability instrument, not a species prediction.
//
// This is the end of the care loop the whole tool exists to close:
//
//     GESTURE  ->  TERRAIN  ->  ABIOTIC  ->  BIOTIC
//
// Everything upstream of here is measurement: Horn's slope is Horn's slope, and
// SOURCE.txt can check it. Nothing downstream of here is. A species envelope is
// an ASSUMPTION about what a plant tolerates, written down so it can be argued
// with — which is exactly why the trait table is on screen and in every export
// rather than buried in this file.
//
// ⚠️ THE ONE THING THAT WOULD SINK THIS IN DISCUSSION is presenting the output
// as a prediction. It is not a species distribution model: it is not fitted, not
// validated against occurrence data, and carries no uncertainty. It answers a
// design question — "if I dig here, does the range of conditions on this site
// get wider or narrower?" — and the honest claim is about the RANGE, not about
// any individual plant. planning/02 §5.7 (Morphos' teaching-mode vocabulary)
// governs the wording everywhere this layer is shown.
//
// METHOD. Fuzzy habitat suitability, the standard HSI shape: each species has a
// trapezoidal tolerance curve per environmental axis, and the memberships are
// combined by GEOMETRIC MEAN so that a zero on any one axis zeroes the species.
// That is Liebig's law of the minimum, and it is what makes the levelled plane
// collapse crisply rather than fading: a surface with no drainage answer and no
// slope has genuinely excluded most of this list, not merely disfavoured it.
//
// ⚠️ SCALE. THE MOISTURE AXIS IS THE SCALE-CORRECTED TWI, NOT RAW TWI, and this
// is load-bearing. TWI = ln(a / tan B) where a is specific catchment area in
// metres, so a scales with cell size and TWI carries a +ln(cell) offset that has
// nothing to do with the ground. Measured on the two real Ørndalen tiles:
//
//                          raw TWI mean     TWI - ln(cell)
//     0.25 m design patch       2.758            4.144
//     4 m context tile          5.478            4.092
//
// The raw means differ by 2.72 — which is ln(16) = 2.77, the cell-size ratio,
// almost exactly — and the correction removes it to within 0.05. So ONE set of
// fixed moisture envelopes serves both scales, and a dropped GeoTIFF of unknown
// cell size lands in the same frame. Without this, every envelope here would
// have been silently calibrated to the design patch and would have named the
// context tile a bog.
//
// The energy axis is likewise a RATIO to the surface's own mean insolation
// rather than kWh/m², because the absolute total depends on the solar period
// the user has selected, and a species envelope must not move when someone
// changes the date range. Measured range is 0.41-1.32 on the patch and
// 0.22-1.32 on the context tile — stable across scale, unlike the absolute.
//
// FIXED, not percentile-stretched. The display ramps stretch to each dataset
// (see ramps.js); these envelopes must NOT, for the same reason the geodiversity
// TRI bins are fixed: a measure that rescales itself to the surface would report
// the same diversity for a rich surface and a nearly flat one, which is the
// precise claim this tool is built to test.

import { LANDFORMS } from "./geomorphons.js";

/** Grid value marking a cell where no species on the list is viable. */
export const BARE = 254;
/** Grid value for nodata. */
export const NO_DATA = 255;

/**
 * @typedef {[number, number, number, number]} Trapezoid
 * Tolerance curve [zeroLo, optLo, optHi, zeroHi]: membership rises from 0 at
 * zeroLo to 1 at optLo, holds 1 to optHi, falls to 0 at zeroHi. Either tail may
 * be squashed (a == b) to express "no lower limit" / "no upper limit".
 */

/**
 * @typedef {Object} Species
 * @property {string} id
 * @property {string} name          the binomial, as it would be cited
 * @property {string} common
 * @property {string} form          growth form, which is what the scatter draws
 * @property {boolean} [invasive]   listed on Norway's Fremmedartslista
 * @property {Trapezoid} moisture   scale-corrected TWI, ln-units
 * @property {Trapezoid} energy     insolation as a ratio to the surface mean
 * @property {Trapezoid} substrate  slope, degrees
 * @property {Trapezoid} shelter    wind exposure, 0 sheltered to 1 exposed
 * @property {string[]} landform    preferred geomorphon classes
 * @property {number} peak          suitability at its own optimum, 0-1
 * @property {number} undrained     membership where the surface is too flat for
 *                                  moisture to have an answer (TWI is NaN)
 * @property {string} note          the sentence shown in the trait table
 */

/**
 * THE TRAIT TABLE. Six species genuinely common on disturbed, coarse, low-
 * nutrient ground in Troms, plus one invasive — all of them things a student
 * could be asked to find on the site.
 *
 * ⚠️ `peak` IS THE GENERALIST PENALTY, and it is the parameter that decides the
 * video's central beat, so it is stated rather than tuned out of sight. A
 * specialist reaches 1.0 but only inside a narrow envelope; a generalist scores
 * lower everywhere but is excluded almost nowhere. That trade-off is real
 * ecology, and it is what makes a differentiated surface favour specialists and
 * a homogeneous one hand the ground to whatever tolerates everything.
 *
 * Order is the order the classes are coded, and the codes go into the exported
 * raster, so INSERTING A SPECIES IN THE MIDDLE RENUMBERS EVERY EXPORTED FILE.
 * Append instead.
 */
/** @type {Species[]} */
export const SPECIES = [
  {
    id: "sphagnum",
    name: "Sphagnum spp.",
    common: "peat moss",
    form: "mat",
    // The wettest niche there is: needs standing moisture, shade and stillness.
    // Excluded outright where the surface has no drainage answer — a levelled
    // plane sheds water as a uniform sheet and never holds it anywhere.
    moisture: [4.4, 5.4, 11.5, 13.5],
    energy: [0.20, 0.45, 1.00, 1.16],
    substrate: [0, 0, 6, 13],
    shelter: [0, 0, 0.86, 0.97],
    landform: ["hollow", "valley", "pit", "footslope", "flat"],
    // bedrock, coarse fill, gravel, sandy, fine, organic, topsoil
    soil: [0.00, 0.00, 0.05, 0.15, 0.40, 1.00, 0.35],
    peak: 1.0,
    undrained: 0.0,
    note: "Wet hollows that hold water. Needs a depression to exist at all.",
  },
  {
    id: "deschampsia",
    name: "Deschampsia cespitosa",
    common: "tufted hair-grass",
    form: "tussock",
    // The broad moist-meadow grass: the commonest thing on damp disturbed
    // ground in Troms, and the species that fills in between the specialists.
    moisture: [4.0, 4.8, 7.0, 9.4],
    energy: [0.55, 0.78, 1.16, 1.32],
    substrate: [0, 0, 13, 26],
    shelter: [0, 0, 0.94, 1.0],
    landform: ["flat", "hollow", "footslope", "valley", "slope", "shoulder"],
    // bedrock, coarse fill, gravel, sandy, fine, organic, topsoil
    soil: [0.00, 0.10, 0.40, 0.85, 1.00, 0.65, 0.95],
    peak: 0.94,
    undrained: 0.18,
    note: "Damp mineral ground. Tolerant, but wants moisture to collect somewhere.",
  },
  {
    id: "trifolium",
    name: "Trifolium repens",
    common: "white clover",
    form: "sward",
    // THE SOWN SWARD — the species actually put down on Norwegian reclamation
    // and roadside ground. A SPECIALIST of the moderate middle: gentle, fine,
    // evenly moist, mid-light. Drier than Deschampsia, moister than Rumex.
    //
    // ⚠️ IT IS NOT THE GENERALIST ANY MORE, and that is a consequence of the
    // lupine decision rather than a tuning choice. Clover was first written as
    // the low-peak tolerate-anything baseline — the thing that covers a graded
    // surface. But lupine now holds that role, and lupine's envelope strictly
    // contained clover's on every axis with a higher peak, which made clover
    // mathematically unable to win a single cell: measured 0.0% on both real
    // tiles. A species that can never appear does not belong in a legend. Given
    // a niche of its own it becomes a real class again.
    //
    // ⚠️ `undrained` IS 0.25, AND THAT NUMBER DECIDES THE VIDEO'S CENTRAL BEAT.
    // With clover equally at home on an undrained plane it scored within 2% of
    // lupine there, leaving the collapse resting on the third decimal place of
    // an envelope. It is also simply wrong: a levelled, compacted surface with
    // no drainage answer is poor clover ground, which is exactly why sown swards
    // on graded sites thin out and are invaded. At 0.25 the flat plane goes to
    // lupine by a decisive margin, for a stated reason rather than a tuned one.
    moisture: [2.6, 3.4, 5.2, 6.6],
    energy: [0.72, 0.88, 1.18, 1.32],
    substrate: [0, 0, 7, 15],
    shelter: [0, 0, 0.88, 0.97],
    landform: ["flat", "slope", "shoulder", "footslope", "spur", "hollow"],
    // bedrock, coarse fill, gravel, sandy, fine, organic, topsoil
    soil: [0.00, 0.00, 0.20, 0.65, 0.90, 0.30, 1.00],
    peak: 0.95,
    undrained: 0.25,
    note: "Sown reclamation sward on even, gentle, moderately moist ground — "
      + "and it thins out where levelling leaves no drainage.",
  },
  {
    id: "rumex",
    name: "Rumex acetosella",
    common: "sheep's sorrel",
    form: "herb",
    // The dry warm flank of a mound: acid, coarse, sharply drained, full sun.
    // Amphibolite-gneiss quarry waste is its exact substrate.
    moisture: [0, 0, 3.3, 4.3],
    energy: [0.92, 1.04, 1.40, 1.55],
    substrate: [0, 2, 23, 36],
    shelter: [0.45, 0.68, 1.0, 1.0],
    landform: ["spur", "shoulder", "ridge", "peak", "slope", "flat"],
    // bedrock, coarse fill, gravel, sandy, fine, organic, topsoil
    soil: [0.05, 0.60, 1.00, 0.85, 0.30, 0.10, 0.20],
    peak: 1.0,
    undrained: 0.10,
    note: "Dry, sun-facing, sharply drained acid gravel. The warm side of a mound.",
  },
  {
    id: "salix",
    name: "Salix glauca",
    common: "grey willow",
    form: "shrub",
    // The lee-slope shrub. Shelter is the axis that decides it: willow scrub
    // occupies the wind shadow, which is why the wind-exposure layer is an
    // ecological variable here and not a rendering aid.
    moisture: [3.3, 4.1, 7.2, 9.8],
    energy: [0.52, 0.72, 1.12, 1.28],
    substrate: [0, 3, 21, 34],
    shelter: [0, 0, 0.87, 0.95],
    landform: ["footslope", "hollow", "valley", "slope", "flat"],
    // bedrock, coarse fill, gravel, sandy, fine, organic, topsoil
    soil: [0.00, 0.20, 0.50, 0.90, 1.00, 0.45, 0.90],
    peak: 1.0,
    undrained: 0.08,
    note: "Sheltered lee slopes with moisture. Needs a wind shadow to occupy.",
  },
  {
    id: "cladonia",
    name: "Cladonia spp.",
    common: "reindeer lichen",
    form: "crust",
    // Exposed coarse stone: dry, open, undisturbed, and slow. The counterpart
    // to Sphagnum at the other end of the moisture axis.
    moisture: [0, 0, 2.7, 3.7],
    energy: [0.40, 0.62, 1.28, 1.48],
    substrate: [0, 0, 32, 46],
    shelter: [0.60, 0.82, 1.0, 1.0],
    landform: ["ridge", "peak", "shoulder", "spur", "slope", "flat"],
    // bedrock, coarse fill, gravel, sandy, fine, organic, topsoil
    soil: [1.00, 0.90, 0.55, 0.15, 0.05, 0.05, 0.02],
    peak: 1.0,
    undrained: 0.22,
    note: "Dry exposed stone. Slow-growing, so it marks ground left alone.",
  },
  {
    id: "lupinus",
    name: "Lupinus nootkatensis",
    common: "Nootka lupine",
    form: "tall-forb",
    invasive: true,
    // ⚠️ THE INVASIVE, AND WHY IT IS MODELLED RATHER THAN MENTIONED.
    //
    // A lupine stand is in the site photographs (IMG_9780, 2026-06-06). It is
    // rated severe-impact on Norway's Fremmedartslista, and it is a genuine
    // coloniser of exactly this kind of ground. The temptation is to let the
    // scatter treat it as vegetation returning — which would be the one
    // dishonest frame available to this tool, because lupine works by fixing
    // nitrogen and overtopping the low sward until nothing else is left.
    //
    // So it is here as its own class, marked invasive in every legend, and it
    // is DELIBERATELY the species that wins a levelled surface. The argument
    // that homogenising terrain costs diversity is not weakened by that — it is
    // completed by it: homogenisation arrives biotically as well as
    // topographically, and the flattened plane does not become bare ground, it
    // becomes a monoculture with a name.
    //
    // Broad on every axis, but genuinely excluded from waterlogged ground
    // (it wants free drainage) and from deep shade (it is a full-sun species).
    // Its peak sits above clover's and below every specialist's, which is the
    // whole mechanism: it cannot beat a species that is at home, and it takes
    // everything that is nobody's home.
    moisture: [1.2, 2.2, 6.0, 7.8],
    energy: [0.80, 0.95, 1.40, 1.55],
    substrate: [0, 0, 26, 39],
    shelter: [0.20, 0.42, 1.0, 1.0],
    landform: ["flat", "slope", "shoulder", "spur", "footslope", "ridge", "hollow"],
    // bedrock, coarse fill, gravel, sandy, fine, organic, topsoil
    soil: [0.02, 0.60, 1.00, 0.95, 0.55, 0.15, 0.45],
    peak: 0.86,
    undrained: 1.0,
    note: "INVASIVE (Fremmedartslista, severe impact). Takes open, well-drained, "
      + "undifferentiated ground and holds it as a monoculture.",
  },
];

/** id -> class code, so callers never hard-code an index. */
export const CODE = Object.fromEntries(SPECIES.map((s, i) => [s.id, i]));

/**
 * How much a cell counts for a species whose preferred landform list does not
 * include it. NOT zero: the geomorphon radius is a chosen parameter (1.5 m
 * here), so landform is weaker evidence than a measured slope or wetness, and
 * letting it veto outright would make the assemblage jump whenever that radius
 * is retuned. A preference, not a filter.
 */
export const LANDFORM_MISMATCH = 0.28;

/**
 * Trapezoidal membership.
 * @param {Trapezoid} t @param {number} v @returns {number} 0..1
 */
export function membership(t, v) {
  if (!Number.isFinite(v)) return NaN;
  const [a, b, c, d] = t;
  if (v <= a && b > a) return 0;
  if (v >= d && d > c) return 0;
  if (v >= b && v <= c) return 1;
  if (v < b) return b > a ? (v - a) / (b - a) : 1;
  return d > c ? (d - v) / (d - c) : 1;
}

/**
 * Scale-corrected TWI — the moisture axis. See the header: this is what lets
 * one set of envelopes serve a 0.25 m patch and a 4 m tile.
 * @param {Float32Array} twiGrid @param {number} cell metres
 * @returns {Float32Array} NaN preserved where TWI had no answer
 */
export function correctedTWI(twiGrid, cell) {
  const out = new Float32Array(twiGrid.length);
  const k = Math.log(cell);
  for (let i = 0; i < twiGrid.length; i++) out[i] = twiGrid[i] - k;
  return out;
}

/**
 * Insolation as a ratio to the surface's own mean — the energy axis. Period-
 * independent, so changing the solar date range restyles the light without
 * moving any species envelope.
 * @param {Float32Array} solarGrid
 * @returns {Float32Array|null} null if the grid is absent or has no mean
 */
export function energyRatio(solarGrid) {
  if (!solarGrid) return null;
  let sum = 0, n = 0;
  for (const v of solarGrid) if (Number.isFinite(v)) { sum += v; n++; }
  if (!n || sum <= 0) return null;
  const mean = sum / n;
  const out = new Float32Array(solarGrid.length);
  for (let i = 0; i < solarGrid.length; i++) out[i] = solarGrid[i] / mean;
  return out;
}

/** Landform preference as a bitmask per species, built once. */
const LANDFORM_MASK = SPECIES.map((s) => {
  let m = 0;
  for (const name of s.landform) {
    const i = LANDFORMS.indexOf(name);
    if (i < 0) throw new Error(`${s.id}: unknown landform "${name}"`);
    m |= 1 << i;
  }
  return m;
});

/**
 * @typedef {Object} Assemblage
 * @property {Uint8Array} codes        winning species per cell; BARE / NO_DATA
 * @property {Float32Array} suitability the winner's score, 0-1
 * @property {Int32Array} counts       cells per species
 * @property {number} bare             cells where nothing on the list is viable
 * @property {number} classified       cells with a species
 * @property {number} shannon          H' over the realised assemblage, nats
 * @property {number} richness         species actually present
 * @property {number} invasiveFraction share of classified cells held by an invasive
 */

/**
 * Assign each cell the species best suited to it, and measure the result.
 *
 * ⚠️ AXES THAT ARE ABSENT DO NOT VOTE. energy, shelter and landform come from
 * the settle-only layers (solar, wind, geomorphons), so during a drag they are
 * either missing or one gesture stale. A missing axis contributes membership 1
 * — "no information", never a veto — because the alternative is a species
 * silently vanishing for want of a layer that has not been computed yet.
 *
 * This is safe for the argument because the two axes that carry the collapse
 * are the LIVE ones: planarizing takes TWI to NaN and slope to zero on the same
 * frame as the gesture, which excludes every species that needs a drainage
 * answer or a gradient. The settled pass then confirms it with the other three.
 * The same staleness convention already governs ambient occlusion in app.js.
 *
 * @param {{
 *   twi: Float32Array, slope: Float32Array, cell: number,
 *   solar?: Float32Array|null, wind?: Float32Array|null,
 *   landform?: Uint8Array|null, elevation?: Float32Array|null,
 * }} g
 * @returns {Assemblage}
 */
export function assemble(g) {
  const n = g.twi.length;
  const codes = new Uint8Array(n);
  const suitability = new Float32Array(n);
  const counts = new Int32Array(SPECIES.length);
  const moisture = correctedTWI(g.twi, g.cell);
  const energy = g.solar ? energyRatio(g.solar) : null;
  const wind = g.wind || null;
  const landform = g.landform || null;
  const z = g.elevation || null;
  let bare = 0, classified = 0;

  const nSp = SPECIES.length;

  // ⚠️ THE GEOMETRIC MEAN IS TAKEN OVER THE AXES ACTUALLY AVAILABLE, not always
  // over five. Multiplying a missing axis in as 1.0 and still taking the fifth
  // root is NOT neutral: it pulls every score toward the species' peak, which
  // hands the cell to whichever specialist has the highest peak. Measured, that
  // mistake made the live map (two axes) read 0.1% lupine where the settled map
  // (five axes) read 29% — the assemblage visibly rearranging itself every time
  // a gesture ended. Dividing by the number of terms present keeps the two
  // readings comparable.
  // ⚠️ SOIL IS THE SIXTH AXIS, AND IT IS PRESENT ONLY WHEN A SUBSTRATE MAP IS.
  //
  // Substrate was display-only until now, deliberately, because coupling it
  // re-baselines every published figure. This design keeps both: with NO
  // substrate map k stays at 5 and every number in the phase summaries and the
  // extended abstract is reproduced EXACTLY, because nothing in the arithmetic
  // changes. Load or paint a substrate and the axis switches on for that
  // session only.
  //
  // ⚠️ UNKNOWN (255) RESOLVES TO 1.0 FOR EVERY SPECIES, not to a penalty and not
  // to "axis absent". A penalty would mean painting "unknown" kills vegetation,
  // which inverts what the class means — it says the material was placed and
  // nothing about what it is. Per-cell absence would be more correct still, but
  // it would make k vary per cell and destroy the PKK optimisation below, which
  // is what keeps this loop at 12 ms instead of 70.
  //
  // ⚠️ A NEUTRAL 1.0 IS NOT RANKING-NEUTRAL, and I had this wrong at first.
  // Giving every species the same factor scales their membership products
  // equally — but adding the axis also raises k, and `rank = peak^k * P`
  // reweights peak against P as k changes. Measured on the real patch, an
  // all-UNKNOWN substrate map moves the assemblage from 30% trifolium / 27%
  // rumex to 28% / 30%. Small, but real. It is the same effect already
  // documented above for a live 2-axis pass against a settled 5-axis one, so a
  // pass WITH a substrate map is comparable to other passes with one, and not
  // to passes without. It does also lift absolute suitability, so fewer cells
  // fall to BARE.
  const soil = g.soil || null;
  const k = 2 + (energy ? 1 : 0) + (wind ? 1 : 0) + (landform ? 1 : 0) + (soil ? 1 : 0);
  const invK = 1 / k;

  // Flat typed arrays, not seven objects walked five times per cell: the inner
  // loop runs nSp x n times and property lookups dominated it.
  const MO = new Float64Array(nSp * 4), EN = new Float64Array(nSp * 4);
  const SU = new Float64Array(nSp * 4), SH = new Float64Array(nSp * 4);
  // ⚠️ EIGHT SLOTS PER SPECIES, NOT SEVEN. Substrate is CATEGORICAL, so this is
  // a lookup per class rather than a trapezoid: slots 0–6 are the substrate
  // vocabulary and slot 7 is UNKNOWN, held at 1.0 for every species so it
  // cannot re-rank them. Any code above 6 that is not 255 also lands in slot 7,
  // which is the safe direction — an unrecognised class must not silently
  // borrow the suitability of bedrock, which is what indexing straight into a
  // seven-slot table would do.
  const SO = new Float64Array(nSp * 8);
  const PK = new Float64Array(nSp), UD = new Float64Array(nSp);
  // peak^k, so the winner can be found WITHOUT a root. score = peak * P^(1/k),
  // and raising by k is monotonic, so argmax(peak^k * P) == argmax(score). k is
  // fixed for the whole grid, so this costs nSp pow calls per pass instead of
  // nSp * n — measured 70 ms -> 12 ms on the real patch.
  const PKK = new Float64Array(nSp);
  for (let s = 0; s < nSp; s++) {
    MO.set(SPECIES[s].moisture, s * 4);
    EN.set(SPECIES[s].energy, s * 4);
    SU.set(SPECIES[s].substrate, s * 4);
    SH.set(SPECIES[s].shelter, s * 4);
    SO.set(SPECIES[s].soil, s * 8);
    SO[s * 8 + 7] = 1;   // UNKNOWN — see the note above
    PK[s] = SPECIES[s].peak;
    UD[s] = SPECIES[s].undrained;
    PKK[s] = Math.pow(SPECIES[s].peak, k);
  }

  /** Inlined trapezoid: same maths as membership(), without the array read. */
  const mem = (T, o, v) => {
    const a = T[o], b = T[o + 1], c = T[o + 2], d = T[o + 3];
    if (v >= b && v <= c) return 1;
    if (v < b) return v <= a && b > a ? 0 : (b > a ? (v - a) / (b - a) : 1);
    return v >= d && d > c ? 0 : (d > c ? (d - v) / (d - c) : 1);
  };

  for (let i = 0; i < n; i++) {
    // Nodata is the DEM's own gap, not an ecological statement.
    if (z && !Number.isFinite(z[i])) { codes[i] = NO_DATA; continue; }
    const sv = g.slope[i];
    if (!Number.isFinite(sv)) { codes[i] = NO_DATA; continue; }
    const mv = moisture[i];
    const undrained = !(mv === mv); // NaN: the surface is too flat to answer
    const ev = energy ? energy[i] : 0;
    const wv = wind ? wind[i] : 0;
    const lf = landform ? landform[i] : 255;
    const lfBit = lf < 32 ? 1 << lf : 0;
    // Substrate class for this cell, folded to slot 7 for UNKNOWN and for
    // anything outside the vocabulary.
    const sc = soil ? (soil[i] <= 6 ? soil[i] : 7) : 7;

    let best = -1, bestRank = 0, bestP = 0;
    for (let s = 0; s < nSp; s++) {
      const o = s * 4;
      // Moisture. Where the surface is too flat for the question to have an
      // answer, each species says what it does with that — and for most of this
      // list the answer is "nothing".
      const m1 = undrained ? UD[s] : mem(MO, o, mv);
      if (m1 <= 0) continue;
      const m3 = mem(SU, o, sv);
      if (m3 <= 0) continue;
      let p = m1 * m3;
      if (energy) { const m = mem(EN, o, ev); if (m <= 0) continue; p *= m; }
      if (wind) { const m = mem(SH, o, wv); if (m <= 0) continue; p *= m; }
      if (landform) p *= (lfBit && (LANDFORM_MASK[s] & lfBit)) ? 1 : LANDFORM_MISMATCH;
      // Soil. This is the axis that makes painting bedrock mean something: on
      // rock only the lichen keeps a high membership, and because the axes
      // combine as a geometric mean rather than an average, one near-zero here
      // is decisive no matter how good the moisture and shelter are. Which is
      // the honest answer — a wet hollow cut in bedrock is a wet hollow cut in
      // bedrock until someone specifies growing medium into it.
      if (soil) { const m = SO[s * 8 + sc]; if (m <= 0) continue; p *= m; }
      // Geometric mean — Liebig's law of the minimum. A species is only as
      // suited as its worst axis allows, so a single exclusion is decisive
      // rather than being averaged away by the comfortable ones.
      const rank = PKK[s] * p;
      if (rank > bestRank) { bestRank = rank; bestP = p; best = s; }
    }

    if (best < 0) { codes[i] = BARE; bare++; continue; }
    codes[i] = best;
    suitability[i] = PK[best] * Math.pow(bestP, invK);
    counts[best]++;
    classified++;
  }

  // Shannon H' over the REALISED assemblage — the species actually holding
  // ground, not the ones the table lists. Deliberately the same mathematics as
  // geodiversityFromTRI so the two readouts are legible side by side, but
  // reported in nats rather than as evenness, because the storyboard's claim is
  // about the count of habitats as much as their balance.
  //
  // A single species at full cover gives H' = 0 EXACTLY. Both planning
  // documents promised 0.11 there; that number was a guess and the exact zero
  // is the stronger and more honest reading, matching the three collapses the
  // abiotic layers already report (geodiversity 0.000, landform diversity
  // 0.000, TWI 0.0% defined).
  let shannon = 0, richness = 0, invasive = 0;
  for (let s = 0; s < nSp; s++) {
    if (counts[s] === 0) continue;
    richness++;
    if (SPECIES[s].invasive) invasive += counts[s];
    const p = counts[s] / classified;
    shannon -= p * Math.log(p);
  }
  if (richness <= 1) shannon = 0;

  return {
    codes, suitability, counts, bare, classified,
    shannon, richness,
    invasiveFraction: classified ? invasive / classified : 0,
  };
}

/**
 * The maximum H' this list can reach — every species holding an equal share.
 * Shown beside the live figure so the number has a ceiling a reader can judge
 * it against, rather than being an unscaled quantity that means nothing alone.
 */
export const SHANNON_MAX = Math.log(SPECIES.length);
