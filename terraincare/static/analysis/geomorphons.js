// @ts-check
// Geomorphons — landform classification by local ternary pattern.
//
// Jasiewicz & Stepinski (2013), Geomorphology 182, 147-156; and the method
// paper Stepinski & Jasiewicz (2011), Geomorphometry.org. Each cell is
// described by looking along eight compass directions and asking, for each,
// whether the ground out there is HIGHER, LOWER, or level within a threshold.
// The resulting 8-tuple of {+, 0, −} is the "geomorphon", and counting the
// pluses and minuses lands the cell in one of ten named landforms.
//
// WHY THIS BELONGS IN THIS TOOL. Everything else here reports a continuous
// index — a slope in degrees, a wetness value, a ruggedness. Geomorphons
// report a NAME: this is a hollow, that is a ridge, this is a footslope. That
// is the vocabulary a landscape architect already designs in, and it is the
// layer that most directly answers the reviewer's "how": you scoop, and a
// patch of slope becomes a patch of hollow, on screen, in words.
//
// ⚠️ SIGN CONVENTION, RESOLVED EMPIRICALLY. The sources disagree as written.
// The 2011 paper's text says a tuple {+,-,...} means {higher, lower, ...},
// which makes a PEAK all minus (everything around it is lower) — and the
// ArcGIS documentation states exactly that, peak = eight −1s, pit = eight +1s.
// But Table I of that same paper prints PK as eight pluses and PT as eight
// minuses, the other way round. Rather than pick a side by reading harder,
// this module fixes the convention the way the TRI formula ambiguity was
// fixed (README, "Formula ambiguities resolved empirically"): + means the
// ground out there is HIGHER, and the self-test builds a synthetic cone, pit,
// ridge, valley and plane and asserts each is named correctly. A classifier
// that calls a cone a pit fails loudly rather than shipping a plausible map.

/** The ten landform classes, in the order their codes run. */
export const LANDFORMS = [
  "flat", "peak", "ridge", "shoulder", "spur",
  "slope", "hollow", "footslope", "valley", "pit",
];

export const FLAT = 0, PEAK = 1, RIDGE = 2, SHOULDER = 3, SPUR = 4;
export const SLOPE = 5, HOLLOW = 6, FOOTSLOPE = 7, VALLEY = 8, PIT = 9;

/**
 * The lookup table, indexed [number of "+"][number of "−"].
 *
 * Only the lower-left triangle is reachable: the two counts cannot exceed
 * eight between them. Read it as the paper's Figure 4 — pluses increasing
 * downward means progressively more ground above you (hollow, valley, pit),
 * minuses increasing rightward means progressively more ground below you
 * (spur, ridge, peak), and the diagonal between them is slope.
 * @type {number[][]}
 */
const LUT = [
  //  −0        −1         −2         −3         −4      −5      −6     −7    −8
  [FLAT,     FLAT,      FLAT,      SHOULDER,  SHOULDER, SHOULDER, RIDGE, RIDGE, PEAK],
  [FLAT,     FLAT,      SHOULDER,  SHOULDER,  SHOULDER, RIDGE,    RIDGE, PEAK],
  [FLAT,     SPUR,      SLOPE,     SHOULDER,  SHOULDER, RIDGE,    RIDGE],
  [FOOTSLOPE, SPUR,     SLOPE,     SLOPE,     SPUR,     SHOULDER],
  [FOOTSLOPE, FOOTSLOPE, HOLLOW,   SLOPE,     SPUR],
  [VALLEY,   FOOTSLOPE, HOLLOW,    HOLLOW],
  [VALLEY,   VALLEY,    HOLLOW],
  [VALLEY,   VALLEY],
  [PIT],
];

/**
 * Classify one geomorphon from its plus/minus counts.
 * @param {number} nPlus  directions where the ground is HIGHER
 * @param {number} nMinus directions where the ground is LOWER
 */
export function classify(nPlus, nMinus) {
  const row = LUT[nPlus];
  if (!row) return FLAT;
  const v = row[nMinus];
  return v === undefined ? FLAT : v;
}

/**
 * Landform class per cell.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {{
 *   radiusM?: number,      lookup distance, ground units
 *   flatnessDeg?: number,  angles below this count as level
 * }} [opts]
 * @returns {{codes: Uint8Array, counts: Int32Array, radiusM: number, flatnessDeg: number}}
 */
export function geomorphons(dem, opts = {}) {
  const { z, nrows, ncols, cell } = dem;
  const radiusM = opts.radiusM ?? 3.0;
  const flatnessDeg = opts.flatnessDeg ?? 1.0;
  const flatTan = Math.tan((flatnessDeg * Math.PI) / 180);
  const maxSteps = Math.max(1, Math.round(radiusM / cell));

  // Eight principal directions, as row/column steps. Row index increases
  // SOUTHWARD, so north is -row — the same convention as horizon.js.
  const DR = [-1, -1, 0, 1, 1, 1, 0, -1];
  const DC = [0, 1, 1, 1, 0, -1, -1, -1];

  const n = nrows * ncols;
  const codes = new Uint8Array(n);
  const counts = new Int32Array(LANDFORMS.length);

  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const i = r * ncols + c;
      const z0 = z[i];
      if (!Number.isFinite(z0)) { codes[i] = 255; continue; }

      let nPlus = 0, nMinus = 0;
      for (let d = 0; d < 8; d++) {
        // Line of sight, not the immediate neighbour: the extreme angles
        // anywhere along the ray are what make the classification
        // scale-flexible, and are the whole reason this is not just a 3x3
        // operator. Diagonal steps are longer, hence the true distance.
        const stepLen = cell * Math.hypot(DR[d], DC[d]);
        let maxTan = 0, minTan = 0;
        for (let s = 1; s <= maxSteps; s++) {
          const rr = r + DR[d] * s, cc = c + DC[d] * s;
          if (rr < 0 || rr >= nrows || cc < 0 || cc >= ncols) break;
          const zz = z[rr * ncols + cc];
          if (zz !== zz) continue;
          const t = (zz - z0) / (s * stepLen);
          if (t > maxTan) maxTan = t;
          if (t < minTan) minTan = t;
        }
        // maxTan is how far the ground RISES along this ray (>= 0), minTan how
        // far it FALLS (<= 0). Their sum says which wins. A ray that rises more
        // than it falls means higher ground out there: "+".
        const net = maxTan + minTan;
        if (net > flatTan) nPlus++;
        else if (net < -flatTan) nMinus++;
      }

      const code = classify(nPlus, nMinus);
      codes[i] = code;
      counts[code]++;
    }
  }

  return { codes, counts, radiusM, flatnessDeg };
}
