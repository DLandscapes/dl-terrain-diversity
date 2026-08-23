// @ts-check
// Horizon angles, and the two things that fall out of them: sky-view factor and
// shadowing for solar radiation.
//
// For every cell and every compass direction, march outwards and record the
// highest elevation angle anything reaches. That single map answers three
// questions the project actually cares about:
//
//   1. How much sky can this spot see?  -> sky-view factor. This is the
//      standard basis for the ambient-occlusion look in relief visualisation,
//      and it is why a scooped hollow reads as a hollow rather than as a
//      slightly darker patch of flat ground.
//   2. Is this spot in shadow when the sun is at (azimuth, altitude)?
//      -> the sun is visible iff its altitude exceeds the horizon in its
//      azimuth. This is what makes solar radiation honest at 69.7°N, where the
//      sun spends most of the year very low and shadows run for tens of metres.
//   3. Is this spot enclosed or exposed? -> positive openness, a SAGA staple
//      and a direct proxy for shelter, which is an ecological variable.
//
// SVF formulation follows the relief-visualisation convention (Zakšek, Oštir &
// Kokalj 2011): SVF = (1/n) Σ (1 − sin γ_i), with γ_i the horizon elevation
// angle in direction i. 1 = open sky, 0 = fully enclosed.
//
// COST. This is the expensive layer in the tool — O(cells × directions × steps)
// — so it is computed only when a gesture SETTLES, never during a drag. The
// search radius is bounded because for micro-topography the horizon is set by
// what is within a few tens of metres, not by the far edge of the tile.

/** @typedef {import("../dem.js").DEM} DEM */

export const DEFAULT_DIRECTIONS = 16;
/** Search radius in metres. Beyond this the horizon barely moves for micro-relief. */
export const DEFAULT_RADIUS_M = 25;

/**
 * Horizon elevation angle (radians) per direction per cell.
 *
 * @param {DEM} dem
 * @param {{directions?: number, radiusM?: number}} [opts]
 * @returns {{angles: Float32Array[], azimuths: Float32Array, directions: number}}
 *   angles[d][i] = horizon angle in radians for direction d at cell i.
 *   azimuths[d] = compass bearing of direction d in radians (0 = N, clockwise).
 */
export function horizonMap(dem, opts = {}) {
  const nDir = opts.directions ?? DEFAULT_DIRECTIONS;
  const radiusM = opts.radiusM ?? DEFAULT_RADIUS_M;
  const withNadir = opts.nadir === true;
  const { z, nrows, ncols, cell } = dem;
  const maxSteps = Math.max(1, Math.round(radiusM / cell));

  const angles = [];
  const nadirs = withNadir ? [] : null;
  const azimuths = new Float32Array(nDir);

  for (let d = 0; d < nDir; d++) {
    const az = (2 * Math.PI * d) / nDir; // 0 = north, clockwise
    azimuths[d] = az;

    // Step in grid space. Row index increases SOUTHWARD, so north is -row.
    const dCol = Math.sin(az);
    const dRow = -Math.cos(az);

    const out = new Float32Array(nrows * ncols);
    const down = withNadir ? new Float32Array(nrows * ncols) : null;
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        const i = r * ncols + c;
        const z0 = z[i];
        if (!Number.isFinite(z0)) {
          out[i] = NaN;
          if (down) down[i] = NaN;
          continue;
        }

        let maxTan = 0; // horizon never dips below the local horizontal
        let minTan = 0; // and the depression angle never rises above it
        // Progressive step spacing: every cell for the first few, then widening.
        // The horizon is set overwhelmingly by nearby ground — distant terrain
        // subtends a small angle and we only keep the maximum — so sampling the
        // far field at full density is wasted work. This is the standard
        // approach in sky-view-factor implementations, and it cuts ~100 samples
        // per ray to ~40 with no visible change in the result.
        for (let s = 1; s <= maxSteps; s += Math.max(1, Math.floor(s * 0.12))) {
          const rr = (r + dRow * s + 0.5) | 0;
          const cc = (c + dCol * s + 0.5) | 0;
          if (rr < 0 || rr >= nrows || cc < 0 || cc >= ncols) break;
          const zz = z[rr * ncols + cc];
          if (zz !== zz) continue; // NaN
          const t = (zz - z0) / (s * cell);
          if (t > maxTan) maxTan = t;
          if (down && t < minTan) minTan = t;
        }
        out[i] = Math.atan(maxTan);
        if (down) down[i] = Math.atan(minTan); // <= 0: how far the ground falls
      }
    }
    angles.push(out);
    if (nadirs) nadirs.push(down);
  }
  return { angles, nadirs, azimuths, directions: nDir };
}

/**
 * Sky-view factor from a horizon map. 1 = fully open sky, 0 = fully enclosed.
 * @param {{angles: Float32Array[], directions: number}} hz
 * @returns {Float32Array}
 */
export function skyViewFactor(hz) {
  const n = hz.angles[0].length;
  const out = new Float32Array(n);
  const nDir = hz.directions;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let ok = true;
    for (let d = 0; d < nDir; d++) {
      const g = hz.angles[d][i];
      if (!Number.isFinite(g)) { ok = false; break; }
      acc += 1 - Math.sin(g);
    }
    out[i] = ok ? acc / nDir : NaN;
  }
  return out;
}

/**
 * Positive topographic openness: the mean angle from zenith to the horizon.
 * Large = exposed/convex, small = enclosed/concave. Reported in degrees, which
 * is how SAGA presents it.
 * @param {{angles: Float32Array[], directions: number}} hz
 * @returns {Float32Array}
 */
export function positiveOpenness(hz) {
  const n = hz.angles[0].length;
  const out = new Float32Array(n);
  const nDir = hz.directions;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let ok = true;
    for (let d = 0; d < nDir; d++) {
      const g = hz.angles[d][i];
      if (!Number.isFinite(g)) { ok = false; break; }
      acc += Math.PI / 2 - g; // zenith angle to the horizon
      }
    out[i] = ok ? (acc / nDir) * 180 / Math.PI : NaN;
  }
  return out;
}

/**
 * Prevailing wind direction at Ørndalen, degrees clockwise from north.
 *
 * 225° = south-west, the prevailing direction reported for Tromsø by
 * windfinder's long-run observation statistics (Sept 2011 onward). It is a
 * sourced figure rather than an assumption, and it is a single number where a
 * full wind rose would be better — met.no's own directional normals for
 * station SN90450 are not published in a form this build could read, so this
 * stays a stated approximation, exposed here so it can be replaced in one edit
 * when the real rose is to hand.
 */
export const PREVAILING_WIND_DEG = 225;

/**
 * Wind exposure: how open a cell is to the prevailing wind, 0 (fully
 * sheltered) to 1 (fully exposed).
 *
 * WHY IT IS AN ECOLOGICAL VARIABLE HERE, not a comfort metric. At 69.7°N
 * exposure governs where snow settles and where it scours, how fast a surface
 * dries, and whether anything can hold on at all — the difference between a
 * lee hollow that keeps an insulating snowpack all winter and a scoured rise
 * that freezes bare. It is the fourth abiotic axis the biotic layer will read,
 * alongside moisture (TWI), energy (solar) and substrate (slope).
 *
 * METHOD, and its honest limits. This is a horizon-based SHELTER PROXY, not
 * SAGA's Wind Exposition Index and not a flow model: no air is simulated,
 * nothing accelerates over a crest, and there is no wake behind an obstacle.
 * Each direction contributes (1 − sin γ), the same openness term sky-view
 * factor uses, weighted by how squarely it faces the wind — cos of the angular
 * difference, clipped at zero so the lee half of the compass contributes
 * nothing. A cell with high ground upwind is sheltered; a cell with open
 * ground upwind is exposed.
 *
 * @param {{angles: Float32Array[], azimuths: Float32Array, directions: number}} hz
 * @param {{windDeg?: number}} [opts]
 * @returns {Float32Array}
 */
/**
 * The directional weighting windExposure() applies: cos of the angular
 * difference from the wind, clipped at zero so the lee half of the compass
 * contributes nothing.
 *
 * Exported so the figure export can DRAW the weighting rather than re-deriving
 * it. A rose printed beside a map has to be the rose the map was computed
 * with; two implementations of the same curve is exactly how a legend ends up
 * describing something the pixels do not do.
 *
 * @param {Float32Array|number[]} azimuths  radians, 0 = N clockwise
 * @param {number} [windDeg]
 * @returns {{weights: Float64Array, sum: number}}
 */
export function directionalWeights(azimuths, windDeg = PREVAILING_WIND_DEG) {
  const windRad = (windDeg * Math.PI) / 180;
  const w = new Float64Array(azimuths.length);
  let sum = 0;
  for (let d = 0; d < azimuths.length; d++) {
    // The wind ARRIVES from windRad, so the sheltering ground is the ground in
    // that direction — no 180° flip. Getting this backwards would report lee
    // slopes as the exposed ones, which looks entirely plausible on a map.
    const v = Math.cos(azimuths[d] - windRad);
    w[d] = v > 0 ? v : 0;
    sum += w[d];
  }
  return { weights: w, sum };
}

export function windExposure(hz, opts = {}) {
  const n = hz.angles[0].length;
  const out = new Float32Array(n);
  const nDir = hz.directions;

  const { weights: w, sum: wSum } =
    directionalWeights(hz.azimuths, opts.windDeg ?? PREVAILING_WIND_DEG);
  if (wSum <= 0) { out.fill(NaN); return out; }

  for (let i = 0; i < n; i++) {
    let acc = 0, ok = true;
    for (let d = 0; d < nDir; d++) {
      if (w[d] === 0) continue;
      const g = hz.angles[d][i];
      if (!Number.isFinite(g)) { ok = false; break; }
      acc += w[d] * (1 - Math.sin(g));
    }
    out[i] = ok ? acc / wSum : NaN;
  }
  return out;
}

/**
 * Is the sun visible from each cell at a given position?
 * Interpolates the horizon between the two bracketing sampled directions.
 * @param {{angles: Float32Array[], azimuths: Float32Array, directions: number}} hz
 * @param {number} sunAz    radians, 0 = N clockwise
 * @param {number} i        cell index
 * @returns {number} horizon angle in radians toward the sun
 */
export function horizonToward(hz, sunAz, i) {
  const nDir = hz.directions;
  const step = (2 * Math.PI) / nDir;
  let a = ((sunAz % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const d0 = Math.floor(a / step) % nDir;
  const d1 = (d0 + 1) % nDir;
  const f = (a - d0 * step) / step;
  const g0 = hz.angles[d0][i], g1 = hz.angles[d1][i];
  if (!Number.isFinite(g0) || !Number.isFinite(g1)) return NaN;
  return g0 + (g1 - g0) * f;
}
