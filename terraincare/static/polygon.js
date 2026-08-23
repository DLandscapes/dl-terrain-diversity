// @ts-check
/**
 * POLYGON REGIONS — trace an area in plan, then act on every cell inside it.
 *
 * This is the engine under Plan mode. It has no UI and no three.js in it, so it
 * runs headless and is tested in the kernel suite rather than the render suite.
 *
 * ⚠️ POLYGON LEVELLING IS NOT VOLUME-NEUTRAL, AND THE BRUSH LEVEL TOOL IS.
 * That difference is the whole point of having both, and it must not be
 * smoothed over. `brush.js` levels with dz = (target − z)·w where the target is
 * derived from the surface itself, so the weighted sum cancels and cut equals
 * fill — measured 836.2 m³ each way, net −0.05 m³. Setting a polygon to a
 * CHOSEN datum instead imports or exports material, and the ledger will report
 * a net figure. That is correct: a platform at 78.0 m either needs fill brought
 * in or spoil taken away, and a design tool that hid this would be lying about
 * the thing landscape earthworks are actually costed on.
 */

/**
 * Which cells of a DEM fall inside a polygon, by the even-odd rule.
 *
 * ⚠️ EVEN-ODD, NOT NON-ZERO WINDING — which is what makes holes work without
 * the caller having to declare them. A ring drawn inside another simply
 * subtracts, whichever direction it was traced in. That matters because the
 * shapefile writer normalises winding on export and a user tracing on screen
 * has no idea which way round they went.
 *
 * ⚠️ CELL CENTRES DECIDE MEMBERSHIP. A cell is in or out, never partly in:
 * the ledger integrates whole cells, so a fractional-coverage test would report
 * volumes the surface does not actually have. The edge is therefore accurate to
 * half a cell, which at 0.25 m is 0.125 m and well below the 0.077–0.232 m
 * limit of detection this site's LiDAR already carries.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {number[][][]} rings  [outer, ...holes], each [[x, y], …] in map units
 * @returns {{mask: Uint8Array, count: number, r0: number, r1: number, c0: number, c1: number}}
 */
export function rasterise(dem, rings) {
  const { nrows, ncols, cell, originX, originY } = dem;
  const mask = new Uint8Array(nrows * ncols);
  const northY = originY + nrows * cell;
  let count = 0, r0 = nrows, r1 = -1, c0 = ncols, c1 = -1;

  // Bound the scan to the polygon's own extent — a 4 m² region on a 256² grid
  // should not cost a full-grid sweep.
  let ymin = Infinity, ymax = -Infinity;
  for (const r of rings) for (const [, y] of r) {
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  if (!Number.isFinite(ymin)) return { mask, count, r0: 0, r1: -1, c0: 0, c1: -1 };
  const rowLo = Math.max(0, Math.floor((northY - ymax) / cell));
  const rowHi = Math.min(nrows - 1, Math.ceil((northY - ymin) / cell));

  const xs = [];
  for (let row = rowLo; row <= rowHi; row++) {
    const y = northY - (row + 0.5) * cell;   // cell-centre latitude of this row
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
        // ⚠️ HALF-OPEN TEST: (y1 <= y) !== (y2 <= y). Using two closed
        // comparisons counts a vertex lying exactly on the scanline twice, and
        // the fill leaks out of the polygon along that row — a defect that
        // appears only for particular coordinates and looks like a random
        // stripe of levelled ground.
        if ((y1 <= y) !== (y2 <= y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const cLo = Math.max(0, Math.ceil((xs[k] - originX) / cell - 0.5));
      const cHi = Math.min(ncols - 1, Math.floor((xs[k + 1] - originX) / cell - 0.5));
      for (let col = cLo; col <= cHi; col++) {
        const i = row * ncols + col;
        if (mask[i]) continue;
        mask[i] = 1; count++;
        if (row < r0) r0 = row; if (row > r1) r1 = row;
        if (col < c0) c0 = col; if (col > c1) c1 = col;
      }
    }
  }
  return { mask, count, r0, r1, c0, c1 };
}

/** Elevation range under a mask, which is what bounds the level slider. */
export function maskZRange(dem, mask) {
  let lo = Infinity, hi = -Infinity, n = 0, sum = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const z = dem.z[i];
    if (!Number.isFinite(z)) continue;
    if (z < lo) lo = z; if (z > hi) hi = z;
    sum += z; n++;
  }
  return n ? { lo, hi, mean: sum / n, count: n } : { lo: 0, hi: 0, mean: 0, count: 0 };
}

/**
 * Set every cell inside the mask to `target`, recording the earthwork.
 *
 * ⚠️ HARD-EDGED, NO FALLOFF — unlike every brush in this tool. A design
 * platform has a boundary; a graded batter between the platform and the ground
 * around it is a SEPARATE design decision and should be drawn as one, not
 * smuggled in as a soft brush edge. Verified in the kernel suite by asserting
 * that no cell outside the mask moves.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {Uint8Array} mask
 * @param {number} target  metres, in the DEM's own vertical datum
 * @param {{dryRun?: boolean, ledger?: import("./brush.js").Ledger}} [opts]
 *   `dryRun` prices without moving. plan.js's `levelCost` is the older, separate
 *   transcription of this loop and stays where it is; this flag exists so
 *   `levelWithBatter` can be priced whole, through ONE path, batter included.
 */
export function levelTo(dem, mask, target, opts = {}) {
  let cut = 0, fill = 0, moved = 0;
  const a = dem.cell * dem.cell;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const z = dem.z[i];
    if (!Number.isFinite(z)) continue;      // a hole in the DEM stays a hole
    const dz = target - z;
    if (dz === 0) continue;
    if (dz > 0) fill += dz * a; else cut += -dz * a;
    if (!opts.dryRun) dem.z[i] = target;
    moved++;
  }
  // ⚠️ Ledger has NO add() — it exposes `cut` and `fill` as accumulating
  // fields, and `net`/`banked` are derived getters. Accumulate, never assign:
  // a polygon edit is one more earthwork on the same site, not a replacement
  // for everything moved before it.
  if (opts.ledger && !opts.dryRun) { opts.ledger.cut += cut; opts.ledger.fill += fill; }
  return { cut, fill, net: fill - cut, cells: moved };
}

/* ------------------------------------------------------------------ batter */

/**
 * Exact Euclidean distance, in CELLS, from every cell to the nearest cell of
 * the mask. Cells inside the mask are 0.
 *
 * Felzenszwalb & Huttenlocher's lower-envelope transform: two 1-D passes, exact
 * Euclidean, O(n). The obvious alternatives are both wrong here — a chamfer
 * approximation quantises the batter's slope into visible facets radiating from
 * the corners, and brute force against the boundary cells is O(cells x boundary)
 * and quadratic in the thing that grows when someone traces a detailed ring.
 *
 * @param {Uint8Array} mask
 * @param {number} nrows @param {number} ncols
 * @returns {Float64Array} distance in cells
 */
export function distanceToMask(mask, nrows, ncols) {
  const INF = 1e20;
  const g = new Float64Array(nrows * ncols);
  for (let i = 0; i < g.length; i++) g[i] = mask[i] ? 0 : INF;

  const n = Math.max(nrows, ncols);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);

  /** 1-D squared-distance transform of `f[0..len)`, result into `d`. */
  const pass = (len) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
  };

  // columns, then rows — the transform is separable, which is why it is O(n)
  for (let c = 0; c < ncols; c++) {
    for (let r = 0; r < nrows; r++) f[r] = g[r * ncols + c];
    pass(nrows);
    for (let r = 0; r < nrows; r++) g[r * ncols + c] = d[r];
  }
  for (let r = 0; r < nrows; r++) {
    const row = r * ncols;
    for (let c = 0; c < ncols; c++) f[c] = g[row + c];
    pass(ncols);
    for (let c = 0; c < ncols; c++) g[row + c] = Math.sqrt(d[c]);
  }
  return g;
}

/**
 * Grade a batter outward from a levelled platform, at the angle of repose, and
 * let it DAYLIGHT — stop where it meets existing ground.
 *
 * ⚠️ THE WIDTH IS NOT A PARAMETER. It is a result. The batter is a plane rising
 * (or falling) from the platform edge at the material's own angle, and it ends
 * exactly where that plane crosses the existing surface. Where the ground is
 * close to platform level the batter is centimetres wide; where it is two metres
 * out it runs two or three metres. That is why a batter follows the terrain and
 * a soft-brush falloff with a chosen radius cannot: the radius would be the same
 * all the way round a platform cut into a slope, which is the one shape real
 * ground never has.
 *
 * ⚠️ ONE FORMULA COVERS CUT AND FILL, INCLUDING BOTH ON THE SAME PLATFORM. A
 * platform on sloping ground cuts into the hill on one side and fills out into
 * the air on the other, and the pair of bounds below handles that without
 * knowing which side it is on:
 *
 *     hi = target + d·tanθ   ground above this is cut down to it
 *     lo = target − d·tanθ   ground below this is filled up to it
 *     otherwise the batter has already daylighted — leave the cell alone
 *
 * ⚠️ A VERTICAL ANGLE IS A LEGITIMATE ANSWER, NOT AN ERROR. Bedrock stands
 * vertical, so θ = 90° gives hi = +∞ and lo = −∞, nothing outside the mask
 * moves, and the result is exactly the hard edge `levelTo` produces on its own.
 * The old behaviour is the θ = 90° case of the new one.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {Uint8Array} mask     the platform, already levelled
 * @param {number} target       platform elevation, metres
 * ⚠️ CUT AND FILL DO NOT STAND AT THE SAME ANGLE, and a road through sloping
 * ground is the case that makes it obvious: a cutting on the uphill side, an
 * embankment on the downhill side, and they are graded differently.
 *
 *   FILL is limited by the angle of repose of the material you PLACE. Loose
 *   granular fill will not hold steeper than roughly its repose angle, whatever
 *   the drawing says — the slope simply ravels until it reaches it.
 *   CUT is limited by the stability of the ground you EXPOSE, which is a
 *   different material with different behaviour. Rock stands near vertical;
 *   moraine and till stand far steeper than loose fill.
 *
 * Grading both at one angle produces either an embankment too steep to stand or
 * a rock cutting absurdly wide, and on a platform that does both it produces
 * both errors at once, symmetrically, which looks deliberate.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {Uint8Array} mask
 * @param {number} target
 * @param {{angleDeg?: number, cutAngleDeg?: number, fillAngleDeg?: number,
 *          dryRun?: boolean, ledger?: import("./brush.js").Ledger}} [opts]
 *   `angleDeg` sets both. `cutAngleDeg` / `fillAngleDeg` override individually.
 *
 * ⚠️ `dryRun` PRICES THE BATTER WITHOUT MOVING IT, and it exists so the figure
 * under the slider comes from THIS function rather than from a second copy of
 * this arithmetic. plan.js keeps `levelCost` as a separate transcription of
 * `levelTo` and warns that the two must agree exactly; that is a bearable risk
 * for six lines and an unacceptable one here. Same code, assignment skipped.
 *
 * ⚠️ AND IT IS SAFE TO PRICE BEFORE THE PLATFORM IS LEVELLED, which is the only
 * reason a preview is possible at all: this function never reads a cell inside
 * the mask — `dist` comes from the mask's shape and the bounds from `target` —
 * so its answer does not depend on `levelTo` having run yet. Pinned in Group Y,
 * because a later edit that reached into the platform would break the preview
 * silently and only for platforms whose ground happened to differ.
 *
 * ⚠️ THE DEFAULTS ARE WORKING FIGURES, NOT A STANDARD. 34° fill is the repose
 * angle of loose granular material; 45° cut is a common figure for cohesive
 * soil. Real numbers for a Norwegian road come from Statens vegvesen håndbok
 * N200 and depend on the material and the height of the face — which is exactly
 * the sort of thing this tool should read from the substrate map rather than
 * assume. Until it does, these are stated here rather than buried.
 */
export function batterTo(dem, mask, target, opts = {}) {
  const cutDeg = opts.cutAngleDeg ?? opts.angleDeg ?? 45;
  const fillDeg = opts.fillAngleDeg ?? opts.angleDeg ?? 34;
  const a = dem.cell * dem.cell;
  let cut = 0, fill = 0, moved = 0, maxRun = 0;

  // tan(90°) is not Infinity in floating point — it is 1.633e16 — so the
  // vertical case is tested on the angle, not on its tangent. Both faces can be
  // vertical independently: a rock cutting with an earth embankment below it is
  // an ordinary road section, not an edge case.
  const vertCut = cutDeg >= 89.5, vertFill = fillDeg >= 89.5;
  // ⚠️ The empty rect is r0 > r1 ON PURPOSE, so a caller that unions it with the
  // platform's rect gets the platform's rect back rather than row 0 dragged in.
  const EMPTY = { cut: 0, fill: 0, net: 0, cells: 0, maxRunM: 0,
    r0: dem.nrows, c0: dem.ncols, r1: -1, c1: -1 };
  if (vertCut && vertFill) return EMPTY;
  const tanCut = vertCut ? Infinity : Math.tan((cutDeg * Math.PI) / 180);
  const tanFill = vertFill ? Infinity : Math.tan((fillDeg * Math.PI) / 180);

  // ⚠️ THE BATTER'S DIRTY RECT IS NOT THE MASK'S — that is the whole point of
  // the feature, and it is the one thing a caller cannot infer from the region.
  // A repaint bounded by the region extent would compute the batter into the
  // DEM and then leave it undrawn and unanalysed, which looks like the batter
  // simply not working rather than like a stale rectangle.
  let r0 = dem.nrows, c0 = dem.ncols, r1 = -1, c1 = -1;

  const dist = distanceToMask(mask, dem.nrows, dem.ncols);
  for (let i = 0; i < dist.length; i++) {
    if (mask[i]) continue;                    // the platform itself is levelTo's
    const z = dem.z[i];
    if (!Number.isFinite(z)) continue;        // a hole in the DEM stays a hole
    // ⚠️ HALF A CELL OFF, AND IT MATTERS. distanceToMask measures to the nearest
    // mask cell's CENTRE, but the platform edge runs along that cell's boundary,
    // half a cell further out. Without the correction the nearest outside cell
    // sits a full cell from the platform and the batter starts one step up —
    // a 0.125 m lip all the way round at 0.25 m cells, which is precisely the
    // kind of edge artefact this whole feature exists to remove.
    const d = Math.max(0, (dist[i] - 0.5)) * dem.cell;
    // The cut face governs ground ABOVE the platform, the fill face ground
    // BELOW it. On a platform cut into a slope both apply, on opposite sides.
    const hi = target + d * tanCut;
    const lo = target - d * tanFill;
    let nz = z;
    if (z > hi) nz = hi;
    else if (z < lo) nz = lo;
    else continue;                            // daylighted
    const dz = nz - z;
    if (dz > 0) fill += dz * a; else cut += -dz * a;
    if (!opts.dryRun) dem.z[i] = nz;
    moved++;
    if (d > maxRun) maxRun = d;
    const r = (i / dem.ncols) | 0, c = i % dem.ncols;
    if (r < r0) r0 = r; if (r > r1) r1 = r;
    if (c < c0) c0 = c; if (c > c1) c1 = c;
  }

  if (opts.ledger && !opts.dryRun) { opts.ledger.cut += cut; opts.ledger.fill += fill; }
  return { cut, fill, net: fill - cut, cells: moved, maxRunM: maxRun, r0, c0, r1, c1 };
}

/**
 * Level a region and grade its batter in one operation, reporting the two
 * separately.
 *
 * ⚠️ THE SPLIT IS THE POINT. A platform and its batter are priced differently
 * and dug differently, and a single combined figure hides how much of the
 * earthwork is the edge condition rather than the platform.
 *
 * ⚠️ AND THE SHARE IS SET BY THE GROUND'S GRADIENT, NOT BY THE PLATFORM'S SIZE.
 * An earlier version of this note said a batter is "routinely the larger of the
 * two on a small platform", which is the wrong variable. The run is Δz ÷ tanθ,
 * so the batter is priced by the relief it has to reconcile while the platform
 * is priced by its area — and on level ground the share therefore FALLS as the
 * platform grows. Measured in Group Y, one 8 m platform at 34° both times:
 * 9.5 % of all material moved on the real Ørndalen patch, 69 % on a 40 % slope.
 * On Ørndalen the share drops from 22.6 % at a 2 m platform to 4.8 % at 32 m.
 * The site is levelled enough that even its edge conditions cost almost nothing,
 * which is one more reading of the collapse the whole tool is about.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {Uint8Array} mask
 * @param {number} target
 * @param {{angleDeg?: number, cutAngleDeg?: number, fillAngleDeg?: number,
 *          dryRun?: boolean, ledger?: import("./brush.js").Ledger}} [opts]
 * @param {{r0:number,c0:number,r1:number,c1:number}} [maskRect]
 *   the platform's own extent, from `rasterise`. Passed in rather than
 *   recomputed because the caller already has it; without it the returned rect
 *   covers only the batter, and a platform levelled on flat ground has no batter
 *   at all — so the repaint would then be empty and the platform would not draw.
 */
export function levelWithBatter(dem, mask, target, opts = {}, maskRect = null) {
  const platform = levelTo(dem, mask, target, opts);
  const batter = batterTo(dem, mask, target, opts);
  const rect = {
    r0: Math.min(batter.r0, maskRect ? maskRect.r0 : dem.nrows),
    c0: Math.min(batter.c0, maskRect ? maskRect.c0 : dem.ncols),
    r1: Math.max(batter.r1, maskRect ? maskRect.r1 : -1),
    c1: Math.max(batter.c1, maskRect ? maskRect.c1 : -1),
  };
  return {
    platform, batter, ...rect,
    cut: platform.cut + batter.cut,
    fill: platform.fill + batter.fill,
    net: platform.net + batter.net,
    cells: platform.cells + batter.cells,
  };
}
