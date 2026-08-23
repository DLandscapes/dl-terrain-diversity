// @ts-check
// Potential incoming solar radiation, with terrain shadowing.
//
// WHY THIS MATTERS HERE, AND WHY IT MATTERS MORE AT 69.7°N THAN ANYWHERE ELSE.
// The abstract's claim is that terrain variation creates "differentiated
// microclimates, soil moisture regimes, and energy balances". Slope and aspect
// are the shape of that claim; insolation is the claim itself, in physical
// units. And Ørndalen sits at 69.70° N, where the sun never climbs above about
// 43° even at midsummer and spends the shoulder seasons within a few degrees of
// the horizon. At those altitudes a 30 cm mound casts a shadow metres long, and
// a south-facing flank receives several times the energy of a north-facing one
// a metre away. This is exactly the mechanism behind the photographed contrast
// between the warm dry poppy-covered gravel hill and the moist mossy hollow.
//
// WHAT THIS IS AND IS NOT. This is POTENTIAL clear-sky radiation, the same
// quantity SAGA GIS reports under "Potential Incoming Solar Radiation": the
// energy arriving at the surface given geometry and a simple atmosphere, with
// no clouds, no shading by vegetation, and no albedo or thermal response. At
// Tromsø the real sky is cloudy a great deal of the time, so treat these as
// RELATIVE — the ratio between two slopes is meaningful, the absolute total is
// an upper bound. Labelled that way in the UI. Never call it "the sun a plant
// will receive".
//
// Method: sum beam + a simple isotropic diffuse term over sun positions
// through the chosen period, testing each position against the terrain horizon
// (analysis/horizon.js) so real shadows are cast.

import { horizonToward } from "./horizon.js";

/** Solar constant, W/m². */
const S0 = 1361;
/** Clear-sky bulk atmospheric transmittance at zenith. */
const TAU = 0.75;
/** Fraction of clear-sky radiation treated as isotropic diffuse. */
const DIFFUSE_FRACTION = 0.25;

/**
 * Solar declination for a day of year, Cooper's equation. Radians.
 * @param {number} doy 1..365
 */
export function declination(doy) {
  return 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39);
}

/**
 * Sun altitude and azimuth for a latitude, day and solar hour.
 * @param {number} latRad
 * @param {number} decl radians
 * @param {number} hourAngle radians (0 = solar noon, negative = morning)
 * @returns {{alt:number, az:number}} radians; az is 0 = N, clockwise
 */
export function sunPosition(latRad, decl, hourAngle) {
  const sinAlt = Math.sin(latRad) * Math.sin(decl) +
    Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  // Azimuth measured from north, clockwise.
  const cosAz = (Math.sin(decl) - Math.sin(alt) * Math.sin(latRad)) /
    (Math.cos(alt) * Math.cos(latRad) || 1e-9);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (hourAngle > 0) az = 2 * Math.PI - az; // afternoon: west of north
  return { alt, az };
}

/**
 * Potential incoming solar radiation over a period, kWh/m².
 *
 * @param {import("../dem.js").DEM} dem
 * @param {{slope: Float32Array, aspectDeg: Float32Array}} gradient
 * @param {{angles: Float32Array[], azimuths: Float32Array, directions: number}} horizon
 * @param {{
 *   latitudeDeg?: number,
 *   dayStart?: number, dayEnd?: number, dayStep?: number,
 *   hourStep?: number,
 *   shadows?: boolean,
 * }} [opts]
 * @returns {{grid: Float32Array, sunPositions: number, meanAltDeg: number, maxAltDeg: number}}
 */
export function solarRadiation(dem, gradient, horizon, opts = {}) {
  // Ørndalen. The latitude is the whole point, so it is a real default.
  const latRad = ((opts.latitudeDeg ?? 69.70084) * Math.PI) / 180;
  const dayStart = opts.dayStart ?? 91;    // 1 April
  const dayEnd = opts.dayEnd ?? 273;       // 30 September — the growing season
  const dayStep = opts.dayStep ?? 14;
  const hourStepH = opts.hourStep ?? 1;
  const shadows = opts.shadows !== false;

  const n = dem.z.length;
  const out = new Float32Array(n);
  const { slope, aspectDeg } = gradient;

  // ---- Pre-compute the sun track ----------------------------------------
  // Everything that depends only on the sun's position is hoisted out of the
  // per-cell loop: air mass, beam irradiance, the diffuse term, the azimuth's
  // sine and cosine, and the two horizon directions that bracket it. The naive
  // version recomputed all of this 65 536 times per sun position and took 1.2 s;
  // hoisting it is the difference between a noticeable freeze on pointer-up and
  // an imperceptible one.
  const nDir = horizon.directions;
  const dirStep = (2 * Math.PI) / nDir;

  const tAlt = [], tSinAlt = [], tCosAlt = [], tBeam = [], tDiffuse = [];
  const tCosAz = [], tSinAz = [], tH0 = [], tH1 = [], tF = [];
  for (let doy = dayStart; doy <= dayEnd; doy += dayStep) {
    const decl = declination(doy);
    for (let h = -12; h <= 12; h += hourStepH) {
      const ha = (h * Math.PI) / 12;
      const p = sunPosition(latRad, decl, ha);
      if (p.alt <= 0) continue; // below the horizon: no beam at all

      const sinAlt = Math.sin(p.alt);
      const airMass = 1 / Math.max(sinAlt, 0.05);
      const beamNormal = S0 * Math.pow(TAU, airMass);

      tAlt.push(p.alt);
      tSinAlt.push(sinAlt);
      tCosAlt.push(Math.cos(p.alt));
      tBeam.push(beamNormal * hourStepH);
      // Diffuse: isotropic sky. Horizontal-surface value; the sky-view
      // weighting that makes a hollow dimmer is applied per cell below.
      tDiffuse.push(beamNormal * sinAlt * DIFFUSE_FRACTION * hourStepH);
      tCosAz.push(Math.cos(p.az));
      tSinAz.push(Math.sin(p.az));

      // Which two sampled horizon directions bracket this azimuth.
      const a = ((p.az % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const d0 = Math.floor(a / dirStep) % nDir;
      tH0.push(horizon.angles[d0]);
      tH1.push(horizon.angles[(d0 + 1) % nDir]);
      tF.push((a - d0 * dirStep) / dirStep);
    }
  }
  const steps = tAlt.length;
  const dayWeight = dayStep; // each sampled day stands for dayStep real days

  let altSum = 0, altMax = 0;
  for (let k = 0; k < steps; k++) { altSum += tAlt[k]; if (tAlt[k] > altMax) altMax = tAlt[k]; }

  // ---- Per-cell integration ---------------------------------------------
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(dem.z[i])) { out[i] = NaN; continue; }
    const beta = Number.isFinite(slope[i]) ? slope[i] : 0;
    // Flat ground has no aspect (NaN, by house convention). For insolation that
    // is not a missing value — a horizontal surface simply has no preferred
    // direction — and with sinB = 0 the azimuth term drops out entirely.
    const aspRad = Number.isFinite(aspectDeg[i]) ? (aspectDeg[i] * Math.PI) / 180 : 0;
    const cosB = Math.cos(beta), sinB = Math.sin(beta);
    const cosAsp = Math.cos(aspRad), sinAsp = Math.sin(aspRad);

    let wh = 0; // watt-hours per m² over the period
    for (let k = 0; k < steps; k++) {
      // Beam, if the sun clears the local horizon in its own azimuth.
      let lit = true;
      if (shadows) {
        const h0 = tH0[k][i];
        const g = h0 + (tH1[k][i] - h0) * tF[k];
        if (g === g && tAlt[k] <= g) lit = false; // g === g rejects NaN
      }
      if (lit) {
        // cos(az − aspect) expanded, so no trig runs in the inner loop
        const cosDelta = tCosAz[k] * cosAsp + tSinAz[k] * sinAsp;
        const cosInc = cosB * tSinAlt[k] + sinB * tCosAlt[k] * cosDelta;
        if (cosInc > 0) wh += tBeam[k] * cosInc;
      }
      wh += tDiffuse[k];
    }
    out[i] = (wh * dayWeight) / 1000; // kWh/m² over the period
  }

  return {
    grid: out,
    sunPositions: steps,
    meanAltDeg: steps ? (altSum / steps) * 180 / Math.PI : 0,
    maxAltDeg: (altMax * 180) / Math.PI,
  };
}
