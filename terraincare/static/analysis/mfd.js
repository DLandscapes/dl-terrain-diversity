// @ts-check
// Multiple-flow-direction accumulation (Freeman 1991 / Quinn et al. 1991),
// default exponent 1.1 — Freeman's own recommendation.
//
// NOT D8. D8 sends all of a cell's water to one of eight neighbours, which
// produces artificial single-cell-wide flow lines on hillslopes and, through
// the drainage-area term in TWI, artificial gullies where none should be. For a
// tool whose entire argument is about where water collects, that is fatal.
// (planning/02 §6 — inherited convention from the sibling Morphos project.)
//
// Order of processing is high-to-low elevation, obtained with a COUNTING SORT
// on quantised elevation rather than a comparison sort. On the 0.25 m Ørndalen
// patch (5.31 m of relief, 1 mm quantum -> ~5300 buckets) this is O(n) and
// roughly an order of magnitude cheaper than Array.sort on 65k indices, which
// is the difference between the analysis staying live under a brush drag and
// having to settle on pointer-up.

import { DEM } from "../dem.js";

// 8 neighbours as flat typed arrays. Kept flat rather than as an array of
// triples because this is the hottest loop in the whole tool: array
// destructuring here costs ~500k allocations per pass on a 256x256 grid.
const N_DROW = new Int8Array([-1, -1, -1, 0, 0, 1, 1, 1]);
const N_DCOL = new Int8Array([-1, 0, 1, -1, 1, -1, 0, 1]);
const N_DIST = new Float64Array([Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2]);

/**
 * Indices sorted by descending elevation, via counting sort on quantised z.
 * NaN cells are excluded entirely.
 * @param {Float32Array} z
 * @param {number} quantum  elevation bucket width in ground units
 * @returns {Int32Array}
 */
export function orderByElevationDesc(z, quantum = 0.001) {
  let lo = Infinity, hi = -Infinity, valid = 0;
  for (let i = 0; i < z.length; i++) {
    const v = z[i];
    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; valid++; }
  }
  if (valid === 0) return new Int32Array(0);

  const nBuckets = Math.max(1, Math.ceil((hi - lo) / quantum) + 1);
  // Guard against a pathological quantum on huge relief blowing up memory.
  if (nBuckets > 1 << 24) {
    const order = new Int32Array(valid);
    let k = 0;
    for (let i = 0; i < z.length; i++) if (Number.isFinite(z[i])) order[k++] = i;
    const arr = Array.from(order);
    arr.sort((a, b) => z[b] - z[a]);
    return Int32Array.from(arr);
  }

  const counts = new Int32Array(nBuckets + 1);
  const bucketOf = (v) => Math.min(nBuckets - 1, Math.floor((v - lo) / quantum));
  for (let i = 0; i < z.length; i++) {
    if (Number.isFinite(z[i])) counts[bucketOf(z[i])]++;
  }
  // Prefix sums from the TOP bucket down, so output is descending elevation.
  const start = new Int32Array(nBuckets);
  let running = 0;
  for (let b = nBuckets - 1; b >= 0; b--) { start[b] = running; running += counts[b]; }

  const order = new Int32Array(valid);
  const cursor = start.slice();
  for (let i = 0; i < z.length; i++) {
    if (Number.isFinite(z[i])) order[cursor[bucketOf(z[i])]++] = i;
  }
  return order;
}

/**
 * @typedef {Object} FlowResult
 * @property {Float32Array} accumulation  number of upslope cells (incl. self), cell counts
 * @property {Float32Array} contributingArea  accumulation * cell^2, m^2
 * @property {Float32Array} specificCatchmentArea  contributingArea / cell, m
 * @property {Int32Array} receiverCount   how many downslope receivers each cell has
 */

/**
 * Freeman/Quinn multiple-flow-direction accumulation.
 * The grid boundary is an OUTLET for flow (water leaves the domain) — the
 * complementary choice, treating the boundary as a wall, applies only to the
 * depression-storage metric in indices.js. Both are deliberate and tested.
 *
 * @param {DEM} dem
 * @param {{exponent?: number, weights?: Float32Array, quantum?: number}} [opts]
 * @returns {FlowResult}
 */
export function flowAccumulation(dem, opts = {}) {
  const { z, nrows, ncols, cell } = dem;
  const p = opts.exponent ?? 1.1;
  const n = nrows * ncols;

  // Float64 internally: avoids a float32 round-trip on every one of the
  // ~500k accumulate-and-store operations, then narrowed once at the end.
  const acc = new Float64Array(n);
  const receiverCount = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(z[i])) acc[i] = opts.weights ? opts.weights[i] : 1;
  }

  const order = orderByElevationDesc(z, opts.quantum);

  // Freeman weight is (dz / (dist*cell))^p. Since only the RATIO of weights at
  // a cell matters (they are normalised by their sum), the constant
  // 1/(dist*cell)^p can be folded into a per-direction factor and the pow
  // applied to dz alone.
  const dirFactor = new Float64Array(8);
  for (let m = 0; m < 8; m++) dirFactor[m] = Math.pow(1 / (N_DIST[m] * cell), p);

  // Scratch buffers reused per cell to avoid per-cell allocation.
  const wIdx = new Int32Array(8);
  const wVal = new Float64Array(8);

  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const zi = z[i];
    const r = (i / ncols) | 0;
    const c = i - r * ncols;
    const interior = r > 0 && r < nrows - 1 && c > 0 && c < ncols - 1;

    let count = 0, total = 0;
    for (let m = 0; m < 8; m++) {
      let j;
      if (interior) {
        j = i + N_DROW[m] * ncols + N_DCOL[m];
      } else {
        const rr = r + N_DROW[m], cc = c + N_DCOL[m];
        if (rr < 0 || rr >= nrows || cc < 0 || cc >= ncols) continue; // boundary = outlet
        j = rr * ncols + cc;
      }
      const zj = z[j];
      const dz = zi - zj;
      if (!(dz > 0)) continue; // covers NaN and uphill/level in one test
      const w = Math.pow(dz, p) * dirFactor[m];
      if (!(w > 0)) continue;
      wIdx[count] = j;
      wVal[count] = w;
      total += w;
      count++;
    }
    receiverCount[i] = count;
    if (count === 0 || total <= 0) continue; // pit or outlet: flow stops here

    const share = acc[i] / total;
    if (count === 1) {
      acc[wIdx[0]] += acc[i]; // single receiver takes everything; skip the multiply
    } else {
      for (let m = 0; m < count; m++) acc[wIdx[m]] += share * wVal[m];
    }
  }

  const accumulation = new Float32Array(n);
  for (let i = 0; i < n; i++) accumulation[i] = acc[i];

  const cellArea = cell * cell;
  const contributingArea = new Float32Array(n);
  const specificCatchmentArea = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(z[i])) {
      contributingArea[i] = NaN; specificCatchmentArea[i] = NaN; accumulation[i] = NaN;
      continue;
    }
    contributingArea[i] = accumulation[i] * cellArea;
    specificCatchmentArea[i] = contributingArea[i] / cell;
  }

  return { accumulation, contributingArea, specificCatchmentArea, receiverCount };
}
