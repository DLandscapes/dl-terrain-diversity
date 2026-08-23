// @ts-check
// Terrain indices: TWI, TRI, and the depression inventory.
//
// Two conventions here are load-bearing for the argument this tool makes, and
// both are deliberate (planning/02 §6):
//
//   TWI is NaN below tan(0.1 deg), not a clamped large number. On a levelled
//   surface the question "where does moisture collect?" genuinely stops having
//   an answer, and the readout must say "no answer" rather than show a bright
//   spot. The degeneracy IS the argument.
//
//   Depressions are INVENTORIED, not filled. Every standard hydrology workflow
//   fills sinks on sight; in a designed landscape a closed depression is
//   frequently the whole point. Filling them would erase the design.

import { DEM } from "../dem.js";
import { flowAccumulation } from "./mfd.js";
import { computeGradient, computeCurvature } from "./horn.js";

/** Below this gradient, TWI is undefined rather than clamped. */
export const TAN_BETA_MIN = Math.tan(0.1 * Math.PI / 180); // ~0.001745

/**
 * Topographic Wetness Index: ln(a / tan B), where a is specific catchment area.
 * @param {Float32Array} specificCatchmentArea  m
 * @param {Float32Array} slope  radians
 * @returns {Float32Array} NaN where the surface is too flat to have an answer
 */
export function twi(specificCatchmentArea, slope) {
  const out = new Float32Array(specificCatchmentArea.length);
  for (let i = 0; i < out.length; i++) {
    const a = specificCatchmentArea[i];
    const s = slope[i];
    if (!Number.isFinite(a) || !Number.isFinite(s) || a <= 0) { out[i] = NaN; continue; }
    const tanB = Math.tan(s);
    out[i] = tanB < TAN_BETA_MIN ? NaN : Math.log(a / tanB);
  }
  return out;
}

/**
 * Terrain Ruggedness Index, RMS variant: sqrt(mean of squared elevation
 * differences to the valid neighbours).
 *
 * FORMULA NOTE (resolved empirically 2026-07-30): data/orndalen/SOURCE.txt
 * records TRI mean 0.036 m for the 0.25 m fill patch. Measured here:
 *   RMS sqrt(sum/k)      -> 0.0362   <-- matches, this is what ships
 *   Riley sqrt(sum)      -> 0.1023
 *   Wilson mean-abs      -> 0.0288
 * Neighbours wrap at the grid edge, matching the script that produced
 * SOURCE.txt; the wrap affects only the 1-cell border.
 *
 * @param {DEM} dem
 * @returns {Float32Array}
 */
export function tri(dem) {
  const { z, nrows, ncols } = dem;
  const out = new Float32Array(nrows * ncols);

  // Interior cells take a modulo-free path. The wrapping version costs ~16
  // integer modulo ops per cell, which measured 4x slower in the browser than
  // in Node; the border is 1 cell wide, so hoisting it out is nearly free.
  for (let r = 1; r < nrows - 1; r++) {
    const rowN = (r - 1) * ncols, rowC = r * ncols, rowS = (r + 1) * ncols;
    for (let c = 1; c < ncols - 1; c++) {
      const i = rowC + c;
      const z0 = z[i];
      if (z0 !== z0) { out[i] = NaN; continue; }
      const w = c - 1, e = c + 1;
      let sq = 0, k = 0;
      let zn = z[rowN + w]; if (zn === zn) { const d = zn - z0; sq += d * d; k++; }
      zn = z[rowN + c];     if (zn === zn) { const d = zn - z0; sq += d * d; k++; }
      zn = z[rowN + e];     if (zn === zn) { const d = zn - z0; sq += d * d; k++; }
      zn = z[rowC + w];     if (zn === zn) { const d = zn - z0; sq += d * d; k++; }
      zn = z[rowC + e];     if (zn === zn) { const d = zn - z0; sq += d * d; k++; }
      zn = z[rowS + w];     if (zn === zn) { const d = zn - z0; sq += d * d; k++; }
      zn = z[rowS + c];     if (zn === zn) { const d = zn - z0; sq += d * d; k++; }
      zn = z[rowS + e];     if (zn === zn) { const d = zn - z0; sq += d * d; k++; }
      out[i] = k === 0 ? NaN : Math.sqrt(sq / k);
    }
  }

  // Border ring, with the wrap that matches the script which produced
  // SOURCE.txt's recorded TRI mean.
  const edge = (r, c) => {
    const i = r * ncols + c;
    const z0 = z[i];
    if (z0 !== z0) { out[i] = NaN; return; }
    let sq = 0, k = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = (r + dr + nrows) % nrows;
        const cc = (c + dc + ncols) % ncols;
        const zn = z[rr * ncols + cc];
        if (zn !== zn) continue;
        const d = zn - z0;
        sq += d * d; k++;
      }
    }
    out[i] = k === 0 ? NaN : Math.sqrt(sq / k);
  };
  for (let c = 0; c < ncols; c++) { edge(0, c); edge(nrows - 1, c); }
  for (let r = 1; r < nrows - 1; r++) { edge(r, 0); edge(r, ncols - 1); }

  return out;
}

/**
 * @typedef {Object} Depression
 * @property {number} label      1-based label matching the label raster
 * @property {number} cellCount
 * @property {number} spillZ     elevation at which it overflows
 * @property {number} minZ       lowest cell in the depression
 * @property {number} volume     m^3 of storage below spillZ
 * @property {number} maxDepth   m
 * @property {boolean} touchesBoundary  true if it drains off the grid edge
 */

/**
 * @typedef {Object} DepressionResult
 * @property {Depression[]} depressions   sorted by volume, descending
 * @property {Int32Array} labels          0 = not in a depression
 * @property {Float32Array} filled        the depression-filled surface
 * @property {Float32Array} depth         filled - z, 0 outside depressions
 * @property {Int32Array} spillParent     the cell this one drains THROUGH, -1 at an outlet
 * @property {number} totalVolume         m^3
 */

/**
 * Inventory closed depressions using a priority-flood (Planchon & Darboux /
 * Barnes et al.), then report each one's storage volume WITHOUT modifying the
 * input surface.
 *
 * BOUNDARY CONVENTION: the grid edge is treated as a WALL for storage, so a
 * hollow scooped near the patch edge still reports the water it would hold,
 * rather than reading 0.0 m^3 and looking broken on camera. Depressions that
 * touch the boundary are flagged `touchesBoundary` so the caller can say so.
 * This is the complement of mfd.js, where the boundary is an outlet for flow.
 *
 * @param {DEM} dem
 * @returns {DepressionResult}
 */
export function findDepressions(dem) {
  const { z, nrows, ncols, cell } = dem;
  const n = nrows * ncols;
  const filled = new Float32Array(n);
  const depth = new Float32Array(n);
  const labels = new Int32Array(n);
  /**
   * The cell each cell drains THROUGH, or -1 at an outlet.
   *
   * ⚠️ THIS IS A BY-PRODUCT OF THE FLOOD, NOT A SECOND COMPUTATION, and that is
   * exactly why it is worth keeping. The priority flood assigns `filled[j]` from
   * whichever cell `i` it was reached from, and by construction
   * `filled[i] <= filled[j]` — so following the parent chain always runs
   * downhill on the filled surface and always terminates at the boundary.
   *
   * That makes it a drainage network that is DEFINED ON FLATS, which ordinary
   * steepest-descent is not: inside a depression the filled surface is level, so
   * D8 has no answer, while the parent chain points at the outlet the flood
   * itself came in through. Deriving the same thing afterwards would mean
   * re-solving flats with a second convention that could disagree with this one.
   */
  const spillParent = new Int32Array(n).fill(-1);

  // Priority flood from the boundary inwards. Bucket queue keyed on quantised
  // elevation, same counting-sort trick as mfd.js, so this stays O(n).
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = z[i];
    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  if (!Number.isFinite(lo)) {
    filled.fill(NaN); depth.fill(NaN);
    return { depressions: [], labels, filled, depth, spillParent, totalVolume: 0 };
  }

  const quantum = 0.001;
  const nBuckets = Math.max(1, Math.ceil((hi - lo) / quantum) + 2);
  const bucketOf = (v) => Math.min(nBuckets - 1, Math.max(0, Math.floor((v - lo) / quantum)));

  // Bucket queue as a flat intrusive linked list rather than an array of
  // arrays: at 1 mm quantisation this grid needs ~5300 buckets, and allocating
  // that many JS arrays per call produced enough garbage to measurably inflate
  // neighbouring stages' timings. head[b] = first cell index, or -1.
  const head = new Int32Array(nBuckets).fill(-1);
  const nextIn = new Int32Array(n).fill(-1);
  const push = (b, i) => { nextIn[i] = head[b]; head[b] = i; };

  const CLOSED = 1, OPEN = 2;
  const state = new Uint8Array(n);

  // Seed: the boundary ring is a wall held at its own elevation. Water inside
  // can only escape by rising to a boundary cell's level.
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      if (r !== 0 && r !== nrows - 1 && c !== 0 && c !== ncols - 1) continue;
      const i = r * ncols + c;
      if (!Number.isFinite(z[i])) { state[i] = CLOSED; filled[i] = NaN; continue; }
      filled[i] = z[i];
      state[i] = OPEN;
      push(bucketOf(z[i]), i);
    }
  }
  // NaN cells act as boundary too (nodata is an escape route, not a wall).
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(z[i]) && state[i] === 0) {
      state[i] = CLOSED; filled[i] = NaN;
      const r = (i / ncols) | 0, c = i - r * ncols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= nrows || cc < 0 || cc >= ncols) continue;
          const j = rr * ncols + cc;
          if (state[j] !== 0 || !Number.isFinite(z[j])) continue;
          filled[j] = z[j];
          state[j] = OPEN;
          push(bucketOf(z[j]), j);
        }
      }
    }
  }

  let b = 0;
  while (b < nBuckets) {
    if (head[b] === -1) { b++; continue; }
    const i = head[b];
    head[b] = nextIn[i];
    if (state[i] === CLOSED) continue;
    state[i] = CLOSED;
    const zi = filled[i];
    const r = (i / ncols) | 0, c = i - r * ncols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= nrows || cc < 0 || cc >= ncols) continue;
        const j = rr * ncols + cc;
        if (state[j] !== 0) continue;
        if (!Number.isFinite(z[j])) continue;
        // Raise j to at least the level of the cell it drains through.
        filled[j] = Math.max(z[j], zi);
        spillParent[j] = i;
        state[j] = OPEN;
        const bj = bucketOf(filled[j]);
        push(bj, j);
        if (bj < b) b = bj; // a lower bucket became non-empty
      }
    }
  }

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(z[i])) { depth[i] = NaN; continue; }
    depth[i] = Math.max(0, filled[i] - z[i]);
  }

  // Label connected components of depth > 0 and measure each.
  const cellArea = cell * cell;
  /** @type {Depression[]} */
  const found = [];
  let label = 0;
  const stack = /** @type {number[]} */ ([]);
  const EPS = 1e-7;

  for (let seed = 0; seed < n; seed++) {
    if (labels[seed] !== 0 || !(depth[seed] > EPS)) continue;
    label++;
    let cellCount = 0, volume = 0, maxDepth = 0;
    let minZ = Infinity, spillZ = -Infinity, touchesBoundary = false;
    stack.length = 0;
    stack.push(seed);
    labels[seed] = label;
    while (stack.length) {
      const i = stack.pop();
      cellCount++;
      volume += depth[i] * cellArea;
      if (depth[i] > maxDepth) maxDepth = depth[i];
      if (z[i] < minZ) minZ = z[i];
      if (filled[i] > spillZ) spillZ = filled[i];
      const r = (i / ncols) | 0, c = i - r * ncols;
      if (r === 0 || r === nrows - 1 || c === 0 || c === ncols - 1) touchesBoundary = true;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= nrows || cc < 0 || cc >= ncols) continue;
          const j = rr * ncols + cc;
          if (labels[j] !== 0 || !(depth[j] > EPS)) continue;
          labels[j] = label;
          stack.push(j);
        }
      }
    }
    found.push({ label, cellCount, spillZ, minZ, volume, maxDepth, touchesBoundary });
  }

  found.sort((a, b2) => b2.volume - a.volume);
  const totalVolume = found.reduce((s, d) => s + d.volume, 0);
  return { depressions: found, labels, filled, depth, spillParent, totalVolume };
}

// Fixed TRI bin edges (metres) for the geodiversity measure. FIXED, not
// derived per frame, so the number is comparable from one gesture to the next —
// a metric that rescales itself as you sculpt tells you nothing.
// Bin 0 is "smooth" (below the ~3 cm single-epoch LiDAR noise floor at
// Ørndalen); the rest are roughly log-spaced from there to 4 m.
const TRI_BINS = [0.03, 0.06, 0.12, 0.25, 0.5, 1.0, 2.0, 4.0];

/**
 * Morphological geodiversity as Shannon EVENNESS over fixed TRI classes,
 * bounded [0,1]: 0 when every cell falls in one roughness class (a levelled
 * plane), rising as the surface carries a genuine variety of roughness scales.
 *
 * Deliberately the same mathematics as the species Shannon H' used later, so
 * the two readouts are legible side by side. This is a stated proxy, not a
 * published geodiversity index — see the Teaching-mode framing in planning/02.
 *
 * @param {Float32Array} triGrid
 * @returns {number}
 */
export function geodiversityFromTRI(triGrid) {
  const counts = new Float64Array(TRI_BINS.length + 1);
  let n = 0;
  for (let i = 0; i < triGrid.length; i++) {
    const v = triGrid[i];
    if (!Number.isFinite(v)) continue;
    let b = 0;
    while (b < TRI_BINS.length && v >= TRI_BINS[b]) b++;
    counts[b]++;
    n++;
  }
  if (n === 0) return 0;
  let h = 0, occupied = 0;
  for (let b = 0; b < counts.length; b++) {
    if (counts[b] === 0) continue;
    occupied++;
    const p = counts[b] / n;
    h -= p * Math.log(p);
  }
  if (occupied <= 1) return 0;
  return h / Math.log(counts.length);
}

/**
 * @typedef {Object} AnalysisResult
 * @property {import("./horn.js").Gradient} gradient
 * @property {import("./horn.js").Curvature | null} curvature  null unless requested
 * @property {import("./mfd.js").FlowResult} flow
 * @property {Float32Array} twi
 * @property {Float32Array} tri
 * @property {DepressionResult} depressions
 * @property {{slopeMeanDeg:number, triMean:number, storageVolume:number,
 *             geodiversity:number, twiValidFraction:number}} metrics
 */

/**
 * Run the abiotic chain. This is the function the Web Worker calls once per
 * pass. Measured cost on the 256x256 Ørndalen patch (Node 24, forced GC
 * between runs): ~22 ms total, of which flow accumulation is ~10 ms.
 *
 * Curvature is OFF by default: none of the four live raster panels (slope,
 * aspect, TWI, TRI) needs it, so it is ~1 ms of work per pass that nothing
 * consumes. Turn it on for the species-envelope work in a later phase.
 *
 * @param {DEM} dem
 * @param {{curvature?: boolean}} [opts]
 * @returns {AnalysisResult}
 */
export function analyse(dem, opts = {}) {
  const gradient = computeGradient(dem);
  const curvature = opts.curvature ? computeCurvature(dem) : null;
  const flow = flowAccumulation(dem);
  const twiGrid = twi(flow.specificCatchmentArea, gradient.slope);
  const triGrid = tri(dem);
  const depressions = findDepressions(dem);

  let slopeSum = 0, slopeN = 0;
  for (const v of gradient.slopeDeg) if (Number.isFinite(v)) { slopeSum += v; slopeN++; }
  let triSum = 0, triN = 0;
  for (const v of triGrid) if (Number.isFinite(v)) { triSum += v; triN++; }
  let twiValid = 0, twiTotal = 0;
  for (const v of twiGrid) { twiTotal++; if (Number.isFinite(v)) twiValid++; }

  const triMean = triN > 0 ? triSum / triN : NaN;
  const geodiversity = geodiversityFromTRI(triGrid);

  return {
    gradient, curvature, flow,
    twi: twiGrid, tri: triGrid, depressions,
    metrics: {
      slopeMeanDeg: slopeN > 0 ? slopeSum / slopeN : NaN,
      triMean,
      storageVolume: depressions.totalVolume,
      geodiversity,
      twiValidFraction: twiTotal > 0 ? twiValid / twiTotal : 0,
    },
  };
}
