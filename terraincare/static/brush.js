// @ts-check
// The three design gestures, and the earthwork ledger that makes the tool's
// closing claim measurable: habitat differentiation at ~zero net earth moved.
//
// SIGN CONVENTION (asserted in the self-test, not trusted):
//   scoop  removes material -> Δz < 0 -> cut   -> ledger.cut increases, banked grows
//   mound  adds material    -> Δz > 0 -> fill  -> ledger.fill increases, banked shrinks
//   net = fill - cut, so a scoop followed by an equal mound reads ~0.
//
// Volumes are integrated over exactly the cells that changed, so the ledger
// cannot drift from the surface it describes.

import { DEM } from "./dem.js";

/** The 8 neighbours, and which of them are diagonal. Used by the smooth brush. */
const N_DR = new Int8Array([-1, -1, -1, 0, 0, 1, 1, 1]);
const N_DC = new Int8Array([-1, 0, 1, -1, 1, -1, 0, 1]);
const N_DIAG = [true, false, true, false, false, true, false, true];

export class Ledger {
  constructor() { this.reset(); }
  reset() {
    /** m^3 of material removed (positive number) */
    this.cut = 0;
    /** m^3 of material placed (positive number) */
    this.fill = 0;
  }
  /** Material excavated and not yet re-placed. Negative means imported. */
  get banked() { return this.cut - this.fill; }
  /** Net change in the volume of the ground. >0 = material imported onto site. */
  get net() { return this.fill - this.cut; }
  /**
   * Formatted for display. The sign is part of the claim, so it is always
   * explicit — "0.0 m³" with no sign would hide an inversion.
   * @param {number} [dp]
   */
  netLabel(dp = 1) {
    const v = this.net;
    const mag = Math.abs(v).toFixed(dp);
    if (parseFloat(mag) === 0) return `±0.0 m³`;
    return `${v > 0 ? "+" : "−"}${mag} m³`;
  }
}

/**
 * Cosine-falloff brush weight, 1 at the centre and 0 at the rim.
 * @param {number} d distance from centre, ground units
 * @param {number} radius ground units
 */
function falloff(d, radius) {
  if (d >= radius) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * d / radius));
}

/**
 * @typedef {Object} StrokeResult
 * @property {number} cut    m^3 removed by this call
 * @property {number} fill   m^3 added by this call
 * @property {{r0:number, c0:number, r1:number, c1:number}} rect  dirty region, inclusive
 */

/**
 * Apply one brush dab in place.
 *
 * The `level` tool has two modes, and the difference matters:
 *
 *   opts.target omitted  — level toward the WEIGHTED LOCAL MEAN under the
 *     brush. A softening gesture. Volume-neutral, but it leaves a gently
 *     rolling surface: measured on the real Ørndalen patch, sweeping this over
 *     everything still leaves ~1.8° of mean slope, so TWI stays defined and
 *     broad shallow basins actually gain storage.
 *
 *   opts.target = <elevation> — planarize toward a DATUM, which is what
 *     levelling a site actually means in construction. This is the mode the
 *     video's levelling sequence needs: it produces a genuinely flat surface
 *     where TWI legitimately has no answer. Still exactly volume-neutral when
 *     the datum is the mean elevation of the area being levelled.
 *
 * Both are volume-neutral by construction at strength 1: dz = (target − z)·w,
 * and for the local mean Σw·(target − z) = 0 identically.
 *
 * The `smooth` tool is a discrete Laplacian: each cell moves toward the mean of
 * its NEIGHBOURS, not toward one value for the whole disc. That is the whole
 * difference from `level` without a target, and it is the reason both exist —
 * levelling to the local mean pulls the ground under the brush toward a single
 * elevation and erases the landform; smoothing removes high-frequency roughness
 * and LEAVES the landform. One flattens a hill, the other takes the gravel
 * texture off it.
 *
 * ⚠️ SMOOTH IS NOT VOLUME-NEUTRAL, AND THAT IS CORRECT. `level` to the local
 * mean cancels exactly, because the target is the weighted mean of the very
 * cells being weighted — Σw·(mean−z) = 0 identically. A Laplacian uses a
 * different mean per cell, so nothing cancels: smoothing a convex ridge removes
 * material, smoothing a concave hollow adds it. That is what happens on site,
 * and the ledger reports it rather than hiding it behind a correction that
 * would silently raise or lower the whole disc to force the books to balance.
 *
 * @param {DEM} dem            modified in place
 * @param {"level"|"scoop"|"mound"|"smooth"} tool
 * @param {number} worldX
 * @param {number} worldY
 * @param {number} radius      ground units
 * @param {number} strength    metres of displacement at full weight (level: 0..1 blend)
 * @param {Ledger} [ledger]
 * @param {{target?: number}} [opts]
 * @returns {StrokeResult}
 */
export function applyBrush(dem, tool, worldX, worldY, radius, strength, ledger, opts = {}) {
  const { z, nrows, ncols, cell, originX, originY } = dem;
  const northY = originY + nrows * cell;
  // ⚠️ WHERE THE BRUSH IS ALLOWED TO ACT, AND HOW STRONGLY. Null means the whole
  // grid, which is what every caller passed before selections could constrain a
  // stroke — so the brush behaves exactly as it always did when nothing is
  // selected. See selection.js `featherWeights`.
  const W = opts.weights && opts.weights.length === nrows * ncols
    ? opts.weights : null;

  // Cell window covering the brush disc.
  const cMin = Math.max(0, Math.floor((worldX - radius - originX) / cell));
  const cMax = Math.min(ncols - 1, Math.ceil((worldX + radius - originX) / cell));
  const rMin = Math.max(0, Math.floor((northY - (worldY + radius)) / cell));
  const rMax = Math.min(nrows - 1, Math.ceil((northY - (worldY - radius)) / cell));

  let cut = 0, fill = 0;
  const cellArea = cell * cell;

  // ⚠️ SMOOTH READS FROM A SNAPSHOT, AND MUST. Level, scoop and mound compute
  // each cell from its own value alone, so writing in place is safe. A Laplacian
  // reads its NEIGHBOURS, and if those neighbours have already been rewritten by
  // this same dab the result depends on the order the loop happens to visit
  // cells in — a diagonal bias that looks like a plausible drainage texture and
  // is entirely an artefact of the loop. The apron is one cell wide because the
  // neighbours of the outermost brush cell lie outside the brush window.
  let snap = null, sr0 = 0, sc0 = 0, sr1 = -1, sc1 = -1, sw = 0;
  if (tool === "smooth") {
    sr0 = Math.max(0, rMin - 1);
    sc0 = Math.max(0, cMin - 1);
    sr1 = Math.min(nrows - 1, rMax + 1);
    sc1 = Math.min(ncols - 1, cMax + 1);
    sw = sc1 - sc0 + 1;
    snap = new Float32Array(sw * (sr1 - sr0 + 1));
    for (let r = sr0; r <= sr1; r++) {
      for (let c = sc0; c <= sc1; c++) snap[(r - sr0) * sw + (c - sc0)] = z[r * ncols + c];
    }
  }

  // "level" needs a target height: either an explicit datum, or the weighted
  // mean of the surface under the brush (see the doc comment above).
  let target = 0;
  if (tool === "level" && opts.target !== undefined) {
    target = opts.target;
  } else if (tool === "level") {
    let wSum = 0, zSum = 0;
    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const zv = z[r * ncols + c];
        if (!Number.isFinite(zv)) continue;
        const x = originX + (c + 0.5) * cell;
        const y = northY - (r + 0.5) * cell;
        let w = falloff(Math.hypot(x - worldX, y - worldY), radius);
        if (W) w *= W[r * ncols + c];
        if (w <= 0) continue;
        wSum += w; zSum += w * zv;
      }
    }
    if (wSum <= 0) return { cut: 0, fill: 0, rect: { r0: rMin, c0: cMin, r1: rMax, c1: cMax } };
    target = zSum / wSum;
  }

  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      const i = r * ncols + c;
      const zv = z[i];
      if (!Number.isFinite(zv)) continue;
      const x = originX + (c + 0.5) * cell;
      const y = northY - (r + 0.5) * cell;
      let w = falloff(Math.hypot(x - worldX, y - worldY), radius);
      // ⚠️ THE SELECTION MULTIPLIES THE BRUSH, IT DOES NOT CLIP IT. A binary
      // test here would stop the dab dead at the boundary and leave a vertical
      // step the height of the dab; multiplying by a feathered weight lets the
      // stroke die away across a stated distance instead. W is 1 inside the
      // selection, so an unfeathered selection still behaves as a hard mask.
      if (W) w *= W[i];
      if (w <= 0) continue;

      let dz;
      if (tool === "level") dz = (target - zv) * w * strength;
      else if (tool === "scoop") dz = -strength * w;
      else if (tool === "smooth") {
        // Discrete Laplacian over the 8 neighbours, inverse-distance weighted so
        // the diagonals count 1/√2. Equal weights would make the operator
        // axis-aligned and smear ridges into plus-shapes at high strength.
        let sum = 0, wsum = 0;
        for (let m = 0; m < 8; m++) {
          const rr = r + N_DR[m], cc = c + N_DC[m];
          // ⚠️ BOTH bounds on BOTH axes. Testing only the low side and trusting
          // the flat index to stay in range is wrong: a column one past the
          // apron's right edge produces a valid index that reads the FIRST cell
          // of the next row, so the smooth would quietly average in a cell from
          // the wrong side of the grid.
          if (rr < sr0 || rr > sr1 || cc < sc0 || cc > sc1) continue;
          const zn = snap[(rr - sr0) * sw + (cc - sc0)];
          if (!Number.isFinite(zn)) continue;   // a hole is not a low neighbour
          const nw = N_DIAG[m] ? Math.SQRT1_2 : 1;
          sum += zn * nw; wsum += nw;
        }
        if (wsum <= 0) continue;                // isolated cell: nothing to average with
        dz = (sum / wsum - zv) * w * Math.min(1, strength);
      } else dz = strength * w; // mound

      if (dz === 0) continue;
      z[i] = zv + dz;
      // ⚠️ BILL THE LEDGER FOR WHAT WAS STORED, NOT FOR WHAT WAS INTENDED.
      // `z` is a Float32Array, so the write above rounds, and charging `dz`
      // lets the account drift from the ground it claims to describe — measured
      // at ~1e-4 m³ on a single smooth dab, which is negligible earth and a
      // straight contradiction of this file's own guarantee. Re-reading the
      // cell costs nothing and makes the promise true.
      const moved = z[i] - zv;
      if (moved < 0) cut += -moved * cellArea;
      else fill += moved * cellArea;
    }
  }

  if (ledger) { ledger.cut += cut; ledger.fill += fill; }
  return { cut, fill, rect: { r0: rMin, c0: cMin, r1: rMax, c1: cMax } };
}

/**
 * Difference surface, later minus earlier, for the cut/fill raster.
 * @param {Float32Array} before
 * @param {Float32Array} after
 * @returns {Float32Array} Δz, positive = fill
 */
export function deltaZ(before, after) {
  const out = new Float32Array(before.length);
  for (let i = 0; i < out.length; i++) {
    const a = after[i], b = before[i];
    out[i] = Number.isFinite(a) && Number.isFinite(b) ? a - b : NaN;
  }
  return out;
}
