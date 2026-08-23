// @ts-check
// Hillshade, ported from DL-TerrainSlicer (app/png.py:24-40)
// (azimuth 315, altitude 45). That implementation uses np.gradient (2-point
// central difference), and this port keeps it deliberately: hillshade is for
// looking at, not for measuring, and matching the sibling app's output exactly
// makes the two tools' previews comparable by eye.
//
// For anything measured — slope, aspect, curvature — use analysis/horn.js
// instead, which reproduces SOURCE.txt's recorded values exactly.

import { DEM } from "../dem.js";

/**
 * Grayscale hillshade in [0,255]. NaN cells render white (255), matching
 * png.py's `img[~np.isfinite(e)] = 255`.
 * @param {DEM} dem
 * @param {{azimuthDeg?: number, altitudeDeg?: number}} [opts]
 * @returns {Uint8ClampedArray} length nrows*ncols
 */
export function hillshade(dem, opts = {}) {
  const { z, nrows, ncols, cell } = dem;
  const az = (opts.azimuthDeg ?? 315) * Math.PI / 180;
  const alt = (opts.altitudeDeg ?? 45) * Math.PI / 180;

  // png.py fills nodata with the mean of finite values before differencing.
  let sum = 0, count = 0;
  for (let i = 0; i < z.length; i++) if (Number.isFinite(z[i])) { sum += z[i]; count++; }
  const mean = count > 0 ? sum / count : 0;
  const filled = new Float64Array(z.length);
  for (let i = 0; i < z.length; i++) filled[i] = Number.isFinite(z[i]) ? z[i] : mean;

  const out = new Uint8ClampedArray(nrows * ncols);
  const sinAlt = Math.sin(alt), cosAlt = Math.cos(alt);

  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const i = r * ncols + c;
      if (!Number.isFinite(z[i])) { out[i] = 255; continue; }

      // np.gradient semantics: central difference inside, one-sided at edges.
      let gyRow, gx;
      if (nrows === 1) gyRow = 0;
      else if (r === 0) gyRow = (filled[(r + 1) * ncols + c] - filled[i]) / cell;
      else if (r === nrows - 1) gyRow = (filled[i] - filled[(r - 1) * ncols + c]) / cell;
      else gyRow = (filled[(r + 1) * ncols + c] - filled[(r - 1) * ncols + c]) / (2 * cell);

      if (ncols === 1) gx = 0;
      else if (c === 0) gx = (filled[i + 1] - filled[i]) / cell;
      else if (c === ncols - 1) gx = (filled[i] - filled[i - 1]) / cell;
      else gx = (filled[i + 1] - filled[i - 1]) / (2 * cell);

      // png.py: gy, gx = np.gradient(...); aspect = arctan2(-gx, gy)
      // where gy is the row-direction derivative. Kept verbatim.
      const slope = Math.atan(Math.hypot(gx, gyRow));
      const aspect = Math.atan2(-gx, gyRow);
      const shade = sinAlt * Math.cos(slope) + cosAlt * Math.sin(slope) * Math.cos(az - aspect);
      out[i] = (shade * 0.5 + 0.5) * 255;
    }
  }
  return out;
}
