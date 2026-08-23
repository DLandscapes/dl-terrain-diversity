// @ts-check
// Horn's (1981) 3x3 gradient kernel — the one ArcGIS, GDAL and QGIS use, so a
// student sees the same slope/aspect number in this tool as in QGIS
// (planning/02 §6). Curvature uses the Zevenbergen & Thorne (1987) form, the
// same one behind ArcGIS's and GDAL's Curvature tools.
//
// Sign convention (derived and hand-verified, see planning check-in notes):
//   gx = dz/dx_world (east-positive), gy = dz/dy_world (north-positive)
//   aspect = compass bearing of steepest DESCENT, 0=N clockwise
//          = atan2(-gx, -gy), NaN on perfectly flat ground — "flat" and
//            "faces due north" must never look alike downstream (a bogus
//            north-facing cold-slope habitat on a horizontal surface is
//            exactly the bug this guards against).
//   profile curvature > 0 = convex (ridge/mound), < 0 = concave (hollow)
//   plan curvature    > 0 = divergent (ridge nose), < 0 = convergent (draw)
//
// Edge cells are padded by replication (Morphos convention) so border cells
// still get defined gradients instead of one-sided differences.

import { DEM } from "../dem.js";

/**
 * @typedef {Object} Gradient
 * @property {Float32Array} gx        dz/dx_world (east-positive)
 * @property {Float32Array} gy        dz/dy_world (north-positive)
 * @property {Float32Array} slope     radians
 * @property {Float32Array} slopeDeg  degrees
 * @property {Float32Array} aspectDeg degrees, 0=N clockwise, NaN where flat
 * @property {Float32Array} ux        downslope unit vector, east component (0 where flat)
 * @property {Float32Array} uy        downslope unit vector, north component (0 where flat)
 */

/**
 * @param {DEM} dem
 * @returns {Gradient}
 */
export function computeGradient(dem) {
  const { z, nrows, ncols, cell } = dem;
  const n = nrows * ncols;
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  const slope = new Float32Array(n);
  const slopeDeg = new Float32Array(n);
  const aspectDeg = new Float32Array(n);
  const ux = new Float32Array(n);
  const uy = new Float32Array(n);

  const inv8cell = 1 / (8 * cell);
  const RAD2DEG = 180 / Math.PI;

  for (let r = 0; r < nrows; r++) {
    const rN = r > 0 ? r - 1 : 0;
    const rS = r < nrows - 1 ? r + 1 : nrows - 1;
    const rowN = rN * ncols, rowC = r * ncols, rowS = rS * ncols;

    for (let c = 0; c < ncols; c++) {
      const i = rowC + c;
      const cW = c > 0 ? c - 1 : 0;
      const cE = c < ncols - 1 ? c + 1 : ncols - 1;

      const z1 = z[rowN + cW], z2 = z[rowN + c], z3 = z[rowN + cE];
      const z4 = z[rowC + cW], z6 = z[rowC + cE];
      const z7 = z[rowS + cW], z8 = z[rowS + c], z9 = z[rowS + cE];

      // Scalar finiteness tests: no per-cell array allocation in this loop.
      if (!(z1 === z1 && z2 === z2 && z3 === z3 && z4 === z4 &&
            z6 === z6 && z7 === z7 && z8 === z8 && z9 === z9) ||
          z1 === Infinity || z1 === -Infinity) {
        gx[i] = NaN; gy[i] = NaN; slope[i] = NaN; slopeDeg[i] = NaN;
        aspectDeg[i] = NaN; ux[i] = 0; uy[i] = 0;
        continue;
      }

      // Horn (1981): dz/dcol (east), dz/d(south-row).
      const gxv = ((z3 + 2 * z6 + z9) - (z1 + 2 * z4 + z7)) * inv8cell;   // east-positive
      const gyv = -(((z7 + 2 * z8 + z9) - (z1 + 2 * z2 + z3)) * inv8cell); // north-positive
      gx[i] = gxv; gy[i] = gyv;

      const mag = Math.sqrt(gxv * gxv + gyv * gyv);
      const sl = Math.atan(mag);
      slope[i] = sl;
      slopeDeg[i] = sl * RAD2DEG;

      if (mag < 1e-12) {
        aspectDeg[i] = NaN;
        ux[i] = 0; uy[i] = 0;
      } else {
        let bearing = Math.atan2(-gxv, -gyv) * RAD2DEG;
        if (bearing < 0) bearing += 360;
        aspectDeg[i] = bearing;
        const invMag = 1 / mag;
        ux[i] = -gxv * invMag;
        uy[i] = -gyv * invMag;
      }
    }
  }

  return { gx, gy, slope, slopeDeg, aspectDeg, ux, uy };
}

/**
 * @typedef {Object} Curvature
 * @property {Float32Array} profile  >0 convex/ridge, <0 concave/hollow
 * @property {Float32Array} plan     >0 divergent, <0 convergent
 */

/**
 * Zevenbergen & Thorne (1987) curvature, ESRI's exact formulation.
 * @param {DEM} dem
 * @returns {Curvature}
 */
export function computeCurvature(dem) {
  const { z, nrows, ncols, cell } = dem;
  const L = cell;
  const L2 = L * L;
  const n = nrows * ncols;
  const profile = new Float32Array(n);
  const plan = new Float32Array(n);

  for (let r = 0; r < nrows; r++) {
    const rN = r > 0 ? r - 1 : 0;
    const rS = r < nrows - 1 ? r + 1 : nrows - 1;
    const rowN = rN * ncols, rowC = r * ncols, rowS = rS * ncols;

    for (let c = 0; c < ncols; c++) {
      const i = rowC + c;
      const cW = c > 0 ? c - 1 : 0;
      const cE = c < ncols - 1 ? c + 1 : ncols - 1;

      const z1 = z[rowN + cW], z2 = z[rowN + c], z3 = z[rowN + cE];
      const z4 = z[rowC + cW], z5 = z[i], z6 = z[rowC + cE];
      const z7 = z[rowS + cW], z8 = z[rowS + c], z9 = z[rowS + cE];

      if (!(z1 === z1 && z2 === z2 && z3 === z3 && z4 === z4 && z5 === z5 &&
            z6 === z6 && z7 === z7 && z8 === z8 && z9 === z9)) {
        profile[i] = NaN; plan[i] = NaN;
        continue;
      }

      const D = ((z4 + z6) / 2 - z5) / L2;
      const E = ((z2 + z8) / 2 - z5) / L2;
      const F = (-z1 + z3 + z7 - z9) / (4 * L2);
      const G = (z6 - z4) / (2 * L); // dz/dx_world (east-positive)
      const H = (z2 - z8) / (2 * L); // dz/dy_world (north-positive)

      const denom = G * G + H * H;
      if (denom < 1e-12) {
        // Flat / critical point: undefined by the formula, 0 by convention.
        profile[i] = 0;
        plan[i] = 0;
      } else {
        profile[i] = -2 * (D * G * G + E * H * H + F * G * H) / denom;
        plan[i] = 2 * (D * H * H + E * G * G - F * G * H) / denom;
      }
    }
  }

  return { profile, plan };
}
