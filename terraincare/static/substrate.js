// @ts-check
// THE SUBSTRATE LAYER — what the ground is made of.
//
// Every other layer in this tool is derived from elevation. This one cannot be:
// no amount of terrain analysis tells you whether a surface is crushed rock or
// peat. So it arrives from outside — imported as a raster, or specified by the
// designer with the brush.
//
// ⚠️ WHY THE BRUSH EXISTS AT ALL, and why it is not a poor substitute for real
// data. The two national sources were queried directly at the exact 64 m design
// patch this tool loads (see SOIL-AND-SUBSTRATE-NOTES.txt for the verbatim
// responses and the working URLs):
//
//   NGU Løsmasser, 1:50 000   losmassetype 100, "thin cover of organic material
//                             over BEDROCK, frequent outcrops"
//   NIBIO AR5, 1:5 000        argrunnf 44 "Jorddekt", captured 24.06.1998,
//                             in a single polygon of 60 000 m²
//
// Ørndalen is a hard-rock quarry that took ~750 000 m³ of municipal waste and
// closed in September 1997. NGU is describing the pre-quarry landform — it is
// not coarse for this site, it is wrong about it. AR5 is ten times finer and
// still returns ONE VALUE across the whole 4 096 m² design patch, and it has a
// "constructed" class it did not use.
//
// So this is the project's two-scale finding one layer down: the substrate
// variation that generates habitat is below the resolution of national soil
// data, and on a constructed site the substrate is a SPECIFICATION, not a
// survey — exactly as the micro-relief is.
//
// ⚠️ NAMING. `species.js` already has a field called `substrate` and it means
// SLOPE IN DEGREES. This layer is keyed `soil` everywhere it is surfaced, and
// `soil` is reserved as the name of the future sixth species axis. Do not
// conflate them.

/** No substrate information for this cell. Also the nodata code. */
export const UNKNOWN = 255;

/**
 * @typedef {Object} SubstrateClass
 * @property {string} id
 * @property {string} name      what appears in the legend
 * @property {string} note      the sentence shown in the sidebar
 * @property {string} drainage  free | moderate | poor — the property that will
 *                              matter most when this is coupled to the species
 *                              model, recorded now so the coupling is not a
 *                              second set of assumptions invented later
 */

/**
 * THE VOCABULARY.
 *
 * Deliberately a DESIGN vocabulary rather than a pedological one. A soil
 * scientist's classification (WRB, texture triangle, horizon sequence)
 * describes soil that formed in place over time. This site's ground was placed
 * by a truck. What matters ecologically here — and what a landscape architect
 * can actually specify — is drainage, water retention and rooting depth, so the
 * classes are cut along those lines.
 *
 * ⚠️ Order is code order, and codes go into exported rasters.
 * APPEND; NEVER INSERT. Same rule as the species list.
 * @type {SubstrateClass[]}
 */
export const SUBSTRATE = [
  {
    id: "bedrock",
    name: "bedrock",
    note: "Rock at or near the surface. No rooting depth to speak of.",
    drainage: "free",
  },
  {
    id: "rockfill",
    name: "coarse rock fill",
    note: "Blasted or blocky material. Huge voids, no water held, no fines.",
    drainage: "free",
  },
  {
    id: "gravel",
    name: "gravel",
    note: "Sharply drained coarse mineral ground — the quarry floor condition.",
    drainage: "free",
  },
  {
    id: "sand",
    name: "sandy mineral",
    note: "Mixed sand and fines. Drains well but holds a little water.",
    drainage: "moderate",
  },
  {
    id: "fines",
    name: "fine mineral",
    note: "Silty or clayey mineral soil. Retentive, and compacts badly.",
    drainage: "poor",
  },
  {
    id: "organic",
    name: "organic / peat",
    note: "Peat or deep organic layers. Holds water; acidic; slow to form.",
    drainage: "poor",
  },
  {
    id: "topsoil",
    name: "topsoil / growing medium",
    note: "Imported or constructed growing medium. A specification, not a soil.",
    drainage: "moderate",
  },
];

/** id -> class code, so nothing hard-codes an index. */
export const CODE = Object.fromEntries(SUBSTRATE.map((s, i) => [s.id, i]));

/** Is this a real substrate class rather than UNKNOWN or a stray value? */
export function isClass(v) {
  return Number.isInteger(v) && v >= 0 && v < SUBSTRATE.length;
}

/* ------------------------------------------------------------ crosswalks */

/**
 * NIBIO AR5 `grunnforhold` -> this vocabulary.
 *
 * Code list from the FKB-AR5 product sheet; code 44 was additionally verified
 * verbatim by a live GetFeatureInfo query at this site.
 *
 * ⚠️ 46 "konstruert" MAPS TO UNKNOWN ON PURPOSE. Constructed ground tells you
 * the material was placed; it says nothing whatever about what it is. Guessing
 * "coarse fill" would be inventing information, and this is precisely the site
 * where that guess would be made most often and matter most.
 * @type {Record<number, number>}
 */
export const AR5_GRUNNFORHOLD = {
  41: CODE.rockfill,  // block field
  42: CODE.bedrock,   // exposed bedrock
  43: CODE.bedrock,   // bedrock with thin soil — rock governs at rooting depth
  44: CODE.fines,     // soil-covered ("Jorddekt")
  45: CODE.organic,   // organic soil layers
  46: UNKNOWN,        // constructed — made ground, composition unstated
};

/**
 * NGU `losmassetype` -> this vocabulary.
 *
 * ⚠️⚠️ PROVISIONAL. Only code 100 has been verified against a live query. The
 * rest is generic Quaternary-geology reasoning, NOT read off the NGU product
 * sheet, and it must be checked before any published use. Codes absent from
 * this table fall to UNKNOWN by design rather than being guessed at import time.
 * @type {Record<number, number>}
 */
export const NGU_LOSMASSETYPE = {
  11: CODE.fines,     // till, continuous — poorly sorted diamicton with fines
  12: CODE.fines,     // till, discontinuous
  20: CODE.gravel,    // glaciofluvial — sand and gravel
  30: CODE.sand,      // fluvial
  41: CODE.fines,     // marine/fjord deposits — clay and silt
  50: CODE.rockfill,  // weathering material
  60: CODE.rockfill,  // slide/colluvial material
  70: CODE.organic,   // peat and bog
  90: UNKNOWN,        // anthropogenic fill — made ground, composition unstated
  100: CODE.bedrock,  // thin organic cover over bedrock (VERIFIED at this site)
  130: CODE.bedrock,  // bare rock
};

/**
 * Build a value mapper for `resampleToDem` from a crosswalk table.
 * Anything not in the table becomes UNKNOWN — never a guess.
 * @param {Record<number, number>} table
 */
export function crosswalk(table) {
  return (v) => {
    if (!Number.isFinite(v)) return UNKNOWN;
    const mapped = table[Math.round(v)];
    return mapped === undefined ? UNKNOWN : mapped;
  };
}

/** The default mapper: the raster already holds this tool's own class codes. */
export function identityMap(v) {
  if (!Number.isFinite(v)) return UNKNOWN;
  const k = Math.round(v);
  return isClass(k) ? k : UNKNOWN;
}

/* ------------------------------------------------------------- resampling */

/**
 * @typedef {Object} ResampleResult
 * @property {Uint8Array} grid     one class code per DEM cell
 * @property {number} overlap      fraction of DEM cells that fell inside the source
 * @property {number} cellRatio    source cell size / DEM cell size
 * @property {number[]} classes    class codes actually present, ascending
 */

/**
 * Put a source raster onto the DEM's grid by NEAREST NEIGHBOUR.
 *
 * Nearest neighbour is not a compromise here, it is the only correct choice:
 * interpolating between class codes 2 and 4 would invent class 3.
 *
 * ⚠️ NO CRS IS INVOLVED, BECAUSE THERE IS NONE TO HAVE. `geotiff.js` never
 * parses the GeoKeyDirectory, so neither raster knows its own projection and a
 * mismatch is undetectable except numerically. This function therefore reports
 * `overlap` and `cellRatio` and expects the caller to refuse implausible
 * imports loudly rather than silently producing a map that looks fine and is
 * in the wrong place.
 *
 * @param {{z: Float32Array, nrows: number, ncols: number, cell: number,
 *          originX: number, originY: number}} src
 * @param {{nrows: number, ncols: number, cell: number,
 *          originX: number, originY: number}} dem
 * @param {(v: number) => number} [mapValue] source value -> class code
 * @returns {ResampleResult}
 */
export function resampleToDem(src, dem, mapValue = identityMap) {
  const grid = new Uint8Array(dem.nrows * dem.ncols).fill(UNKNOWN);
  // Both grids state their origin at the SOUTH-west corner while row 0 is the
  // NORTH edge — the house convention from dem.js. Convert through world
  // coordinates rather than by index arithmetic so the two cannot drift.
  const demNorth = dem.originY + dem.nrows * dem.cell;
  const srcNorth = src.originY + src.nrows * src.cell;
  let inside = 0;
  const seen = new Set();

  for (let r = 0; r < dem.nrows; r++) {
    const y = demNorth - (r + 0.5) * dem.cell;
    const sr = Math.floor((srcNorth - y) / src.cell);
    if (sr < 0 || sr >= src.nrows) continue;
    for (let c = 0; c < dem.ncols; c++) {
      const x = dem.originX + (c + 0.5) * dem.cell;
      const sc = Math.floor((x - src.originX) / src.cell);
      if (sc < 0 || sc >= src.ncols) continue;
      inside++;
      const code = mapValue(src.z[sr * src.ncols + sc]);
      grid[r * dem.ncols + c] = code;
      if (code !== UNKNOWN) seen.add(code);
    }
  }

  return {
    grid,
    overlap: grid.length > 0 ? inside / grid.length : 0,
    cellRatio: src.cell / dem.cell,
    classes: [...seen].sort((a, b) => a - b),
  };
}

/* ---------------------------------------------------------------- painting */

/**
 * Assign a substrate class over a disc, in place.
 *
 * ⚠️ HARD-EDGED, NOT FEATHERED. The earthwork brush uses a cosine falloff
 * because elevation is continuous. Classes are not: there is no half-gravel.
 * Every cell whose centre is inside the disc takes the class outright.
 *
 * ⚠️ TAKES NO LEDGER, AND MUST NEVER TAKE ONE. Specifying a growing medium is
 * not earthmoving. If this ever moved the cut/fill readout it would corrupt the
 * tool's closing claim — that habitat differentiation was achieved at ~zero net
 * material imported.
 *
 * @param {Uint8Array} grid        modified in place, one code per DEM cell
 * @param {{nrows: number, ncols: number, cell: number,
 *          originX: number, originY: number}} dem
 * @param {number} code            substrate class, or UNKNOWN to clear
 * @param {number} worldX
 * @param {number} worldY
 * @param {number} radius          ground units
 * @returns {{r0: number, c0: number, r1: number, c1: number, changed: number}}
 *   dirty rect, inclusive; `changed` counts cells that actually differ
 */
export function paintSubstrate(grid, dem, code, worldX, worldY, radius) {
  const { nrows, ncols, cell, originX, originY } = dem;
  const northY = originY + nrows * cell;

  const cMin = Math.max(0, Math.floor((worldX - radius - originX) / cell));
  const cMax = Math.min(ncols - 1, Math.ceil((worldX + radius - originX) / cell));
  const rMin = Math.max(0, Math.floor((northY - (worldY + radius)) / cell));
  const rMax = Math.min(nrows - 1, Math.ceil((northY - (worldY - radius)) / cell));

  let changed = 0;
  const r2 = radius * radius;
  for (let r = rMin; r <= rMax; r++) {
    const y = northY - (r + 0.5) * cell;
    const dy = y - worldY;
    for (let c = cMin; c <= cMax; c++) {
      const x = originX + (c + 0.5) * cell;
      const dx = x - worldX;
      if (dx * dx + dy * dy > r2) continue;
      const i = r * ncols + c;
      if (grid[i] === code) continue;
      grid[i] = code;
      changed++;
    }
  }
  return { r0: rMin, c0: cMin, r1: rMax, c1: cMax, changed };
}

/**
 * Count cells per class, for the legend and the readouts.
 * @param {Uint8Array} grid
 * @returns {{counts: Int32Array, unknown: number, known: number}}
 */
export function substrateCounts(grid) {
  const counts = new Int32Array(SUBSTRATE.length);
  let unknown = 0;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (isClass(v)) counts[v]++;
    else unknown++;
  }
  return { counts, unknown, known: grid.length - unknown };
}
