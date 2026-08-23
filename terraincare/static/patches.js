// @ts-check
// LANDFORM PATCHES — the hillside broken into the units it is actually farmed,
// terraced and read in.
//
// Step B of DESIGN-landform-terracing.md. A rule mask answers "where is it
// hollow"; that is ONE mask over the whole tile. A patch is ONE hollow — a
// connected run of the same landform — and the difference is the whole of the
// Douro reading: terraces follow contours, contours diverge on a convex nose
// and converge in a concave one, so a terrace that must stay workable has to
// change direction where the landform changes. The seams between patches are
// where that happens.
//
// ⚠️ THE MEAN ASPECT OF A PATCH IS ITS TERRACE BEARING, and the spread of aspect
// within it is how far the bearing has to swing across it — which is what says
// whether it should be split again. Both are computed here; neither is a
// separate idea from the landform classification.
//
// ⚠️ ASPECT IS CIRCULAR AND MUST BE AVERAGED AS A DIRECTION. Averaging 350° and
// 10° arithmetically gives 180° — the exact opposite of the answer. The mean is
// taken as a vector sum, and its LENGTH is the concentration: 1 means every cell
// faces the same way, 0 means the patch has no bearing at all. That length is a
// better test for "should this be split" than any variance in degrees.
//
// ⚠️ AND ASPECT IS WEIGHTED BY SLOPE, because aspect on flat ground is
// meaningless — this project's own convention makes it NaN rather than north,
// which is exactly the distinction an unweighted mean would destroy. Same rule
// `aspectRose` keeps in hud.js.

import { benchTo } from "./bench.js";

/**
 * Connected components of a mask.
 *
 * ⚠️ EIGHT-CONNECTED, NOT FOUR. A spur running diagonally across the grid is one
 * landform, and four-connectivity would cut it into a staircase of separate
 * patches at every diagonal step — which would then be reported as a dozen
 * bearings where the ground has one. The cost is that two patches touching only
 * at a corner merge; on a classified surface that is the right trade, because
 * they are the same landform there.
 *
 * ⚠️ ITERATIVE, NOT RECURSIVE. A patch can be tens of thousands of cells; a
 * depth-first walk over one blows the stack, and it does it on the biggest and
 * most interesting patch rather than on a small one.
 *
 * @param {{nrows:number, ncols:number}} dem
 * @param {Uint8Array} mask
 * @returns {{labels: Int32Array, count: number}} labels are 1-based, 0 = outside
 */
export function connectedComponents(dem, mask) {
  const { nrows, ncols } = dem;
  const labels = new Int32Array(nrows * ncols);
  const stack = new Int32Array(nrows * ncols);
  let count = 0;
  for (let s = 0; s < labels.length; s++) {
    if (!mask[s] || labels[s]) continue;
    const id = ++count;
    let top = 0;
    stack[top++] = s;
    labels[s] = id;
    while (top > 0) {
      const i = stack[--top];
      const r = (i / ncols) | 0, c = i - r * ncols;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= nrows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const cc = c + dc;
          if (cc < 0 || cc >= ncols) continue;
          const j = rr * ncols + cc;
          if (!mask[j] || labels[j]) continue;
          labels[j] = id;
          stack[top++] = j;
        }
      }
    }
  }
  return { labels, count };
}

/**
 * Break a landform classification into patches, one per connected run of a
 * class, and measure each.
 *
 * ⚠️ SMALL PATCHES ARE REPORTED, NOT DROPPED. A geomorphon map is speckled —
 * three cells of "hollow" inside a slope is a real classification and not a
 * terrace unit — so every patch is returned with its size and the caller
 * decides. Dropping them here would quietly change the partition the caller
 * thinks it is measuring, and the count of specks is itself a reading of how
 * noisy the classification is on this ground.
 *
 * @param {{nrows:number, ncols:number, cell:number, z:Float32Array}} dem
 * @param {Float32Array|Int32Array} classes one class code per cell
 * @param {{slopeDeg?: Float32Array, aspectDeg?: Float32Array,
 *          only?: number[]}} [opts]
 *   `only` restricts the partition to these class codes.
 * @returns {{labels: Int32Array, patches: any[]}}
 */
export function landformPatches(dem, classes, opts = {}) {
  const { nrows, ncols, cell, z } = dem;
  const n = nrows * ncols;
  const only = opts.only && opts.only.length ? new Set(opts.only) : null;

  // One pass per class present, so a patch is same-class AND connected.
  const labels = new Int32Array(n);
  const patches = [];
  const present = new Set();
  for (let i = 0; i < n; i++) {
    const v = classes[i];
    if (!Number.isFinite(v)) continue;
    const k = Math.round(v);
    if (only && !only.has(k)) continue;
    present.add(k);
  }

  const sub = new Uint8Array(n);
  for (const k of [...present].sort((a, b) => a - b)) {
    sub.fill(0);
    for (let i = 0; i < n; i++) {
      const v = classes[i];
      if (Number.isFinite(v) && Math.round(v) === k) sub[i] = 1;
    }
    const { labels: lab, count } = connectedComponents(dem, sub);
    // Accumulators for this class's patches.
    const acc = Array.from({ length: count + 1 }, () => ({
      cells: 0, sx: 0, sy: 0, zlo: Infinity, zhi: -Infinity,
      slopeSum: 0, slopeN: 0, ax: 0, ay: 0, aw: 0,
      r0: nrows, r1: -1, c0: ncols, c1: -1,
    }));
    for (let i = 0; i < n; i++) {
      const id = lab[i];
      if (!id) continue;
      const a = acc[id];
      const r = (i / ncols) | 0, c = i - r * ncols;
      a.cells++;
      a.sx += c; a.sy += r;
      if (r < a.r0) a.r0 = r; if (r > a.r1) a.r1 = r;
      if (c < a.c0) a.c0 = c; if (c > a.c1) a.c1 = c;
      const zz = z[i];
      if (Number.isFinite(zz)) { if (zz < a.zlo) a.zlo = zz; if (zz > a.zhi) a.zhi = zz; }
      const sl = opts.slopeDeg ? opts.slopeDeg[i] : NaN;
      if (Number.isFinite(sl)) { a.slopeSum += sl; a.slopeN++; }
      const asp = opts.aspectDeg ? opts.aspectDeg[i] : NaN;
      // ⚠️ Weighted by slope, and a NaN aspect contributes nothing at all — on
      // level ground the direction does not exist, and this project's own
      // convention says so rather than calling it north.
      if (Number.isFinite(asp) && Number.isFinite(sl) && sl > 0) {
        const th = (asp * Math.PI) / 180;
        a.ax += Math.sin(th) * sl; a.ay += Math.cos(th) * sl; a.aw += sl;
      }
    }
    for (let id = 1; id <= count; id++) {
      const a = acc[id];
      if (!a.cells) continue;
      const mag = Math.hypot(a.ax, a.ay);
      const bearing = a.aw > 0 && mag > 0
        ? ((Math.atan2(a.ax, a.ay) * 180) / Math.PI + 360) % 360 : NaN;
      patches.push({
        id: patches.length + 1,
        klass: k,
        cells: a.cells,
        area: a.cells * cell * cell,
        // The centroid, in local coordinates.
        x: (a.sx / a.cells) * cell,
        y: (nrows - a.sy / a.cells) * cell,
        zlo: Number.isFinite(a.zlo) ? a.zlo : NaN,
        zhi: Number.isFinite(a.zhi) ? a.zhi : NaN,
        meanSlopeDeg: a.slopeN ? a.slopeSum / a.slopeN : NaN,
        /** the terrace bearing: the slope-weighted circular mean of aspect */
        bearingDeg: bearing,
        /**
         * ⚠️ CONCENTRATION, NOT VARIANCE. 1 means every cell in the patch faces
         * the same way and one bearing serves it; 0 means the patch wraps a nose
         * and has no single direction, which is the signal to split it. A
         * variance in degrees cannot say this, because degrees wrap.
         */
        bearingConcentration: a.aw > 0 ? mag / a.aw : 0,
        r0: a.r0, r1: a.r1, c0: a.c0, c1: a.c1,
      });
      // Renumber into the shared label grid.
      const newId = patches.length;
      for (let i = 0; i < n; i++) if (lab[i] === id) labels[i] = newId;
    }
  }
  patches.sort((a, b) => b.cells - a.cells);
  // The sort reorders the array but the label grid still points at the old
  // numbering, so the ids are rewritten to match rather than left to disagree.
  const remap = new Int32Array(patches.length + 1);
  patches.forEach((p, i) => { remap[p.id] = i + 1; });
  for (let i = 0; i < n; i++) if (labels[i]) labels[i] = remap[labels[i]];
  patches.forEach((p, i) => { p.id = i + 1; });
  return { labels, patches };
}

/**
 * Bench each landform patch on its own terms.
 *
 * ⚠️ THIS IS THE WHOLE EXPERIMENT, AND WHAT VARIES IS THE POINT. A uniform bench
 * system quantises elevation globally: `round(z/Δ)·Δ`, one Δ and one datum over
 * the entire site, so every cell at the same height gets the same target
 * whatever landform it is on. Per patch, two things change and neither is a
 * decoration:
 *
 *   ⚠️ **Δ FOLLOWS THE PATCH'S OWN SLOPE**, because tread width is Δ ÷ tanβ and a
 *   terrace has to be WIDE ENOUGH TO WORK. Holding the tread constant is how
 *   contour terracing is actually set out, and it means a steep nose gets
 *   closely-spaced benches while a gentle hollow gets widely-spaced ones — the
 *   opposite of what one global Δ produces, which is unworkably narrow treads on
 *   the steep ground and pointlessly wide ones on the flat.
 *
 *   ⚠️ **THE DATUM IS THE PATCH'S OWN FLOOR**, so neighbouring patches do NOT
 *   line up. That is not a defect to be smoothed away: it is the seam, and the
 *   seam is where the terrace direction changes. A global datum would run one
 *   continuous set of levels across a nose and a hollow alike, which is exactly
 *   the erasure the whole comparison is testing.
 *
 * ⚠️ PATCHES TOO SMALL TO SET OUT GET THE DEFAULT SYSTEM rather than being
 * skipped — otherwise the two schemes would not cover the same ground and the
 * comparison would be between different amounts of site, not different ways of
 * treating it.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {Int32Array} labels @param {any[]} patches
 * @param {{tread?: number, targetTread?: number, bias?: string,
 *          minCells?: number, fallbackInterval?: number, minInterval?: number,
 *          maxInterval?: number, dryRun?: boolean,
 *          ledger?: import("./brush.js").Ledger}} [opts]
 */
export function benchByPatch(dem, labels, patches, opts = {}) {
  const n = dem.nrows * dem.ncols;
  const targetTread = opts.targetTread ?? 4;
  const minCells = opts.minCells ?? 64;
  const fallback = opts.fallbackInterval ?? 1;
  const lo = opts.minInterval ?? 0.25, hi = opts.maxInterval ?? 6;
  let cut = 0, fill = 0, cells = 0, benched = 0, defaulted = 0;
  const mask = new Uint8Array(n);

  for (const p of patches) {
    mask.fill(0);
    let any = 0;
    for (let i = 0; i < n; i++) if (labels[i] === p.id) { mask[i] = 1; any++; }
    if (!any) continue;
    let interval = fallback, datum = 0;
    if (any >= minCells && Number.isFinite(p.meanSlopeDeg) && p.meanSlopeDeg > 0.5) {
      // Δ = tread × tanβ, clamped: a 60° nose would otherwise ask for benches
      // 7 m apart vertically and a 1° flat for 7 cm.
      const tan = Math.tan((p.meanSlopeDeg * Math.PI) / 180);
      interval = Math.min(hi, Math.max(lo, targetTread * tan));
      datum = Number.isFinite(p.zlo) ? p.zlo : 0;
      benched++;
    } else defaulted++;
    const r = benchTo(dem, mask, {
      interval, datum, tread: opts.tread, bias: opts.bias,
      dryRun: opts.dryRun, ledger: opts.ledger,
    });
    cut += r.cut; fill += r.fill; cells += r.cells;
  }
  return {
    cut, fill, net: fill - cut, cells,
    patchesBenched: benched, patchesDefaulted: defaulted,
  };
}
