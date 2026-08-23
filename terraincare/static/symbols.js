// @ts-check
// PROPORTIONAL SYMBOLS — an analysis layer read as size instead of as colour.
//
// Every analysis layer in this tool is drawn as a colour ramp, and a ramp is
// good at one thing and bad at another: it shows a FIELD — where the high ground
// is, where the wet ground is — and it is very hard to read a VALUE off. Nobody
// looks at a shade of blue and says "that is 0.6". A circle whose diameter is
// the value is the opposite trade: it loses the smooth field and it can be
// measured against a legend, one symbol at a time.
//
// ⚠️ SIZE IS THE DATUM HERE, AND COLOUR STAYS OUT OF IT. The house rule is that
// colour in this interface means data; if these circles were also ramped they
// would encode the same number twice and invite the reader to look for a second
// variable that does not exist. They are drawn in one ink.
//
// ⚠️ NOT ONE PER CELL. The design patch is 256 × 256, so a symbol per cell is
// 65 536 circles — illegible on screen, enormous in an SVG, and each one smaller
// than the line it is drawn with. The grid is SAMPLED at a stride, and the
// symbol then stands for the cell it was sampled at rather than for the block
// around it, which is the honest reading and the one a legend can state.
//
// ⚠️ A CELL WITH NO ANSWER GETS NO CIRCLE. NaN is not zero — TWI on level
// ground, aspect on a flat cell, catchment before the first worker pass — and a
// zero-radius dot in those places would read as "measured, and very low"
// exactly where the truth is "not measured at all". Same rule the rule masks
// keep, for the same reason.

/**
 * Where symbols go, and how big each one is.
 *
 * @param {{nrows:number, ncols:number, cell:number, z:Float32Array}} dem
 * @param {Float32Array|Int32Array} grid one value per cell, NaN = no answer
 * @param {{lo?:number, hi?:number, stride?:number, minFraction?:number,
 *          threshold?:number, maxFraction?:number}} [opts]
 *   `lo`/`hi` the value domain mapped onto 0..1 — pass the ramp's own stretched
 *   domain so the symbols and the colours agree about what "high" means.
 *   `stride` cells between samples. `threshold` skips any NORMALISED value below
 *   it. `minFraction` is the smallest circle actually drawn, as a fraction of
 *   the full size, so a real but small value is still visible rather than
 *   vanishing into a dot. `maxFraction` scales the largest circle against the
 *   sample spacing — 1 means neighbouring full-size circles just touch.
 * @returns {{x:number, y:number, z:number, r:number, v:number}[]}
 *   local coordinates, as every overlay in this project uses.
 */
export function symbolField(dem, grid, opts = {}) {
  const out = [];
  if (!grid || grid.length !== dem.nrows * dem.ncols) return out;
  const stride = Math.max(1, Math.round(opts.stride ?? 1));
  const threshold = opts.threshold ?? 0;
  const minF = opts.minFraction ?? 0.08;
  const maxF = opts.maxFraction ?? 1;

  let lo = opts.lo, hi = opts.hi;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  const span = /** @type {number} */ (hi) - /** @type {number} */ (lo);
  const { nrows, ncols, cell, z } = dem;
  const northY = nrows * cell;
  // The full-size circle spans the sample spacing, so at stride 1 it is exactly
  // the cell — which is the rule as it was asked for, generalised.
  const full = (stride * cell * maxF) / 2;

  // ⚠️ SAMPLED FROM THE CENTRE OUTWARD, so the pattern does not shift when the
  // stride changes. Anchoring at row 0 makes every change of stride slide the
  // whole field, which reads as the data moving.
  const r0 = Math.floor(((nrows - 1) % stride) / 2);
  const c0 = Math.floor(((ncols - 1) % stride) / 2);

  for (let r = r0; r < nrows; r += stride) {
    for (let c = c0; c < ncols; c += stride) {
      const i = r * ncols + c;
      const v = grid[i];
      if (!Number.isFinite(v)) continue;          // no answer, no circle
      const zc = z[i];
      if (!Number.isFinite(zc)) continue;         // no ground to stand on
      const n = span > 0 ? (v - /** @type {number} */ (lo)) / span : 0;
      const t = n < 0 ? 0 : n > 1 ? 1 : n;
      if (t < threshold) continue;
      // Below the threshold nothing is drawn; above it the smallest circle is
      // minF of full, so the scale does not start from invisible.
      const rad = full * (minF + (1 - minF) * t);
      out.push({
        x: c * cell,
        y: northY - r * cell,
        z: zc,
        r: rad,
        v,
      });
    }
  }
  return out;
}

/**
 * A stride that yields roughly `target` symbols across the wider side.
 *
 * ⚠️ CHOSEN FROM THE GRID, NOT FIXED. The tool loads a 256² design patch and a
 * 256² context tile covering sixteen times the ground; a stride that reads well
 * on one is wrong on the other, and the number a reader can actually take in is
 * the number of SYMBOLS, not the number of cells between them.
 * @param {{nrows:number, ncols:number}} dem @param {number} [target]
 */
export function strideFor(dem, target = 40) {
  const n = Math.max(dem.nrows, dem.ncols);
  return Math.max(1, Math.round(n / Math.max(4, target)));
}

/**
 * The legend's reference circles: the values a reader measures against.
 *
 * ⚠️ ROUND VALUES, NOT ROUND RADII. A legend of equally-spaced circles is easy
 * to draw and useless to read off, because the numbers beside them are then
 * arbitrary. These are nice values from the 1-2-5 series inside the domain, and
 * their radii follow — which is the way round that lets someone hold the legend
 * against the map.
 * @param {number} lo @param {number} hi
 * @param {{stride?:number, cell?:number, minFraction?:number, maxFraction?:number,
 *          count?:number}} [opts]
 */
export function symbolLegend(lo, hi, opts = {}) {
  const span = hi - lo;
  if (!(span > 0)) return [];
  const stride = Math.max(1, Math.round(opts.stride ?? 1));
  const cell = opts.cell ?? 1;
  const minF = opts.minFraction ?? 0.08;
  const maxF = opts.maxFraction ?? 1;
  const full = (stride * cell * maxF) / 2;
  const want = Math.max(2, opts.count ?? 3);

  const raw = span / (want - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n <= 1.5 ? 1 : n <= 3.5 ? 2 : n <= 7.5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) {
    const t = (v - lo) / span;
    out.push({ v: +v.toFixed(10), r: full * (minF + (1 - minF) * t) });
  }
  return out;
}
