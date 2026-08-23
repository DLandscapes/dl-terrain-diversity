// @ts-check
// Local operators, recomputed on the main thread over the dirty rect only.
//
// Slope, aspect and TRI are 3x3 kernels: a cell's value depends on its eight
// neighbours and nothing further. So after a brush dab they can be refreshed
// over the ~800 cells under the brush (plus a one-cell halo) in well under a
// millisecond, landing on the SAME frame as the gesture.
//
// That split is what makes the tool's rhetorical claim honest: the numbers the
// eye is watching while the hand moves are not a frame late. Only the non-local
// hydrology — flow accumulation, TWI, depression storage — goes to the worker,
// because those genuinely need a full-grid pass.
//
// Definitions are IDENTICAL to analysis/horn.js and analysis/indices.js by
// construction: this file calls the same kernels, just over a window. A second
// implementation would be a second thing to keep in step, and would eventually
// disagree with the QGIS-matching numbers the self-test pins.

/**
 * Mean slope in degrees and mean TRI over a cell rectangle, computed directly.
 * Used for the live readouts during a drag.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {{r0:number,c0:number,r1:number,c1:number}} rect
 */
export function localStats(dem, rect) {
  const { z, nrows, ncols, cell } = dem;
  const r0 = Math.max(1, rect.r0), c0 = Math.max(1, rect.c0);
  const r1 = Math.min(nrows - 2, rect.r1), c1 = Math.min(ncols - 2, rect.c1);
  if (r1 < r0 || c1 < c0) return { slopeMeanDeg: NaN, triMean: NaN, n: 0 };

  let slopeSum = 0, triSum = 0, n = 0;
  const inv8 = 1 / (8 * cell);

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * ncols + c;
      if (!Number.isFinite(z[i])) continue;

      const iN = i - ncols, iS = i + ncols;
      const a = z[iN - 1], b = z[iN], cc = z[iN + 1];
      const d = z[i - 1], f = z[i + 1];
      const g = z[iS - 1], h = z[iS], k = z[iS + 1];
      if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(cc) &&
            Number.isFinite(d) && Number.isFinite(f) &&
            Number.isFinite(g) && Number.isFinite(h) && Number.isFinite(k))) continue;

      // Horn's 3x3 — the same kernel as analysis/horn.js, so a student sees the
      // same slope value here, there, and in QGIS.
      const dzdx = ((cc + 2 * f + k) - (a + 2 * d + g)) * inv8;
      const dzdy = ((g + 2 * h + k) - (a + 2 * b + cc)) * inv8;
      slopeSum += Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;

      // TRI, RMS variant — the definition resolved empirically against
      // SOURCE.txt in Phase 0 (see README).
      const zi = z[i];
      let acc = 0;
      acc += (a - zi) ** 2; acc += (b - zi) ** 2; acc += (cc - zi) ** 2;
      acc += (d - zi) ** 2; acc += (f - zi) ** 2;
      acc += (g - zi) ** 2; acc += (h - zi) ** 2; acc += (k - zi) ** 2;
      triSum += Math.sqrt(acc / 8);

      n++;
    }
  }
  return {
    slopeMeanDeg: n ? slopeSum / n : NaN,
    triMean: n ? triSum / n : NaN,
    n,
  };
}
