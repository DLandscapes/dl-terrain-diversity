// @ts-check
/**
 * WATERSHEDS — which basin each cell drains to.
 *
 * ⚠️ THIS USES D8, AND THE REST OF THE PROJECT USES MFD. That is deliberate and
 * it is not a regression to a worse algorithm.
 *
 * `mfd.js` splits flow across up to eight downslope neighbours with Freeman
 * weights, which is the better physical model for hillslope accumulation and is
 * why every other hydrological layer here uses it. But a watershed is a
 * PARTITION: every cell belongs to exactly one basin. Under MFD a cell sends
 * water to several neighbours at once, so "the basin this cell drains to" is not
 * a well-defined question. Delineation therefore needs a single receiver per
 * cell, which is what D8 gives. Two flow models, two purposes — accumulation
 * stays MFD, and nothing here feeds back into it.
 *
 * ⚠️ DEPRESSIONS ARE NOT FILLED, AND THAT IS THE PROJECT'S STANDING CONVENTION.
 * The consequence has to be faced rather than engineered away: the real 0.25 m
 * fill patch holds 1131 local minima in 4096 m², so a naive "every pit is a
 * basin" map is 1131 basins and reads as noise. Cells are therefore labelled by
 * their pit, and basins below `minCells` are reported as MICRO — a real class
 * meaning "drains to a hollow too small to be a catchment", not a failure.
 *
 * The useful side effect: basin count is another quantity that COLLAPSES when
 * ground is levelled. A differentiated surface has many basins; a planarised one
 * has a single sheet draining off an edge. That is the same collapse geodiversity,
 * landform diversity, TWI-defined fraction and Shannon H′ all show, measured a
 * fifth independent way.
 */

/** Cell drains off the edge of the tile. */
export const OUTLET = -1;
/** Cell has no elevation. */
export const NO_DATA = -2;
/**
 * Cell drains to a hollow too small to count as a catchment.
 * ⚠️ A REAL CLASS, NOT A FAILURE — on the 0.25 m patch most of the surface is
 * this, because the ground genuinely is a field of centimetre-deep hollows.
 */
export const MICRO = -4;

const DROW = [-1, -1, -1, 0, 0, 1, 1, 1];
const DCOL = [-1, 0, 1, -1, 1, -1, 0, 1];
const DIST = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

/**
 * Colour a basin map.
 *
 * ⚠️ THIS CANNOT USE `colouriseClasses`, and the reason is a real difference in
 * the data rather than an inconvenience. Every other categorical layer here has
 * a FIXED, NAMED class list — ten geomorphons, seven species, eight substrates —
 * so `ramps.js` can hold one authored colour per class and the legend can name
 * them. A basin id is NOMINAL and unbounded: this patch has 917 of them, they
 * have no names, and there is no meaningful colour for "basin 412".
 *
 * So the hues are generated on a golden-angle walk, which guarantees that
 * consecutively-numbered basins land far apart on the wheel and adjacent ones
 * are therefore distinguishable. ⚠️ THE LEGEND MUST SAY THE COLOURS ARE
 * ARBITRARY. Basins are ranked by area, so id carries an order, and a reader who
 * assumes the hue sequence means anything would be reading a rank into it. The
 * three special classes below are the only ones that carry meaning.
 * @param {Int32Array} basin
 */
export function colouriseBasins(basin) {
  const out = new Uint8ClampedArray(basin.length * 4);
  const GOLDEN = 137.50776405003785;
  for (let i = 0; i < basin.length; i++) {
    const v = basin[i];
    const o = i * 4;
    let r, g, b;
    if (v === NO_DATA) { r = g = b = 214; }
    else if (v === OUTLET) { r = 244; g = 242; b = 236; }   // leaves the tile
    else if (v === MICRO) { r = 198; g = 196; b = 190; }    // hollow, not a catchment
    else {
      // HSL -> RGB inline; s and l fixed so no basin can shout over another.
      const h = ((v * GOLDEN) % 360) / 360, s = 0.42, l = 0.62;
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p2 = 2 * l - q;
      const hue = (t) => {
        t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
        if (t < 1 / 6) return p2 + (q - p2) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p2 + (q - p2) * (2 / 3 - t) * 6;
        return p2;
      };
      r = hue(h + 1 / 3) * 255; g = hue(h) * 255; b = hue(h - 1 / 3) * 255;
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  }
  return out;
}

/**
 * @param {import("../dem.js").DEM} dem
 * @param {{minCells?: number}} [opts]
 */
export function watersheds(dem, opts = {}) {
  const { z, nrows, ncols, cell } = dem;
  const n = nrows * ncols;
  // A basin smaller than this is a hollow, not a catchment. Default is 1 m²
  // expressed in cells, so it means the same thing at 0.25 m and at 4 m rather
  // than meaning 16× more ground on the coarse tile.
  const minCells = opts.minCells ?? Math.max(4, Math.round(1 / (cell * cell)));

  // ── 1. steepest-descent receiver, D8 ──────────────────────────────────────
  // ⚠️ COMPARE BY GRADIENT, NOT BY DROP. Taking the largest dz alone biases
  // every flow path toward the diagonals, which are 1.41× further away, and puts
  // a systematic 45° grain into the basin boundaries.
  const recv = new Int32Array(n).fill(OUTLET);
  for (let i = 0; i < n; i++) {
    const zi = z[i];
    if (!Number.isFinite(zi)) { recv[i] = NO_DATA; continue; }
    const r = (i / ncols) | 0, c = i - r * ncols;
    let best = -Infinity, bestJ = OUTLET;
    for (let m = 0; m < 8; m++) {
      const rr = r + DROW[m], cc = c + DCOL[m];
      // Off the edge is an outlet, exactly as mfd.js treats its boundary.
      if (rr < 0 || rr >= nrows || cc < 0 || cc >= ncols) { bestJ = OUTLET; best = Infinity; break; }
      const j = rr * ncols + cc;
      const zj = z[j];
      if (!Number.isFinite(zj)) continue;
      const slope = (zi - zj) / (DIST[m] * cell);
      if (slope > best) { best = slope; bestJ = j; }
    }
    // No lower neighbour: this cell is a pit, and a pit is a basin seed.
    recv[i] = best > 0 ? bestJ : (best === Infinity ? OUTLET : i);
  }

  // ── 2. follow receivers to a root, with path compression ──────────────────
  // Iterative, not recursive: a 256² tile can have chains thousands of cells
  // long and a recursive walk blows the stack on real data.
  const root = new Int32Array(n).fill(-3);
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (root[s] !== -3) continue;
    let top = 0, i = s;
    for (;;) {
      if (recv[i] === NO_DATA) { root[i] = NO_DATA; break; }
      if (recv[i] === OUTLET) { root[i] = OUTLET; break; }
      if (recv[i] === i) { root[i] = i; break; }      // pit: its own root
      if (root[i] !== -3) break;                       // already resolved
      stack[top++] = i;
      i = recv[i];
    }
    const r = root[i];
    while (top > 0) root[stack[--top]] = r;
  }

  // ── 3. number the basins, largest first ───────────────────────────────────
  /** @type {Map<number, number>} */
  const size = new Map();
  for (let i = 0; i < n; i++) {
    const r = root[i];
    if (r >= 0) size.set(r, (size.get(r) ?? 0) + 1);
  }
  // Sorted by area so label 0 is the largest basin — stable, and it makes the
  // legend read as a ranking rather than as an arbitrary scatter of ids.
  const ranked = [...size.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  /** @type {Map<number, number>} */
  const label = new Map();
  let major = 0, micro = 0, microCells = 0;
  for (const [r, count] of ranked) {
    if (count >= minCells) label.set(r, major++);
    else { label.set(r, -4); micro++; microCells += count; }
  }

  const basin = new Int32Array(n);
  const areas = new Float64Array(major);
  let outletCells = 0, nodata = 0;
  for (let i = 0; i < n; i++) {
    const r = root[i];
    if (r === NO_DATA) { basin[i] = NO_DATA; nodata++; continue; }
    if (r === OUTLET) { basin[i] = OUTLET; outletCells++; continue; }
    const L = label.get(r);
    basin[i] = L === -4 ? MICRO : L;
    if (L !== -4) areas[L] += cell * cell;
  }

  return {
    /** basin id per cell; OUTLET, MICRO or NO_DATA for the special cases */
    basin,
    /** D8 receiver per cell, kept so a flow path can be traced for the UI */
    receiver: recv,
    /** number of basins at or above minCells */
    count: major,
    /** m² per basin, index = basin id, descending */
    areas,
    micro, microCells, minCells,
    outletFraction: outletCells / n,
    nodataFraction: nodata / n,
    /**
     * Area of the largest basin as a share of the classified surface.
     * ⚠️ ZERO WHEN THERE ARE NO BASINS, not one. A planarised surface has no
     * cell with a lower neighbour anywhere, so every cell is its own one-cell
     * pit and nothing survives `minCells`. Reporting dominance as 1.0 there
     * would read as "one basin covers everything", which is the opposite of
     * what happened — there is no drainage structure at all.
     */
    dominance: major ? areas[0] / (areas.reduce((a, b) => a + b, 0) || 1) : 0,
  };
}
