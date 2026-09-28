// @ts-check
// THE SIX GROUNDS, BUILT FROM ONE SURFACE — browser-safe.
//
// ⚠️⚠️ THIS FILE EXISTS SO THERE IS ONE IMPLEMENTATION, NOT TWO. The grounds are
// verified in Node against the matrix sheet's published figures, and then drawn
// in the browser by the film. If the film rebuilt them with its own copy of the
// recipe, the verification would be checking a surface nobody renders and the
// render would be showing a surface nobody checked — and every figure would
// still look completely reasonable. tools/morph-states.mjs supplies the file
// loading and the CLI; the arithmetic is only here.
//
// Node reaches this through tools/morph-states.mjs. Nothing here may import
// node:*.

import { compareAt, EXPERIMENT } from "./compare.js";
import { benchTo } from "./bench.js";
import { computeGradient } from "./analysis/horn.js";
import { geomorphons, LANDFORMS } from "./analysis/geomorphons.js";
import { landformPatches, benchByPatch } from "./patches.js";
import { proceduralField, applyPattern } from "./pattern.js";

export const SHEET_TREAD = 4;

/** ⚠️ FOUND BY SWEEP against the sheet's stated consequences for case 5 — 136 m3
 *  moved and 287 hollows left. The sheet never states the interval. */
export const C5_INTERVAL = 0.95;

/** ⚠️ FOUND BY SWEEP against case 6's four published figures — 194 hollows,
 *  145 m3, geodiversity 0.6996, peak outfall 16.65. Seed 1 at amplitude 0.21 is
 *  the only combination in the swept range that hits all four; seed 2 and seed 3
 *  reproduce the volume but miss the hollows and the outfall badly. */
export const C6 = { pattern: "pitmound", module: 8, seed: 1, amplitude: 0.21 };

/**
 * ⚠️ CHOSEN ON HOLLOWS AND GEODIVERSITY, NEVER ON PEAK OUTFALL. Outfall is a
 * maximum over outlets and swings 40-73 m3 across neighbouring sigmas as
 * smoothing reorganises which outlet is largest; a radius picked by it is picked
 * out of scatter. At 6 m the landform relief survives (16.93 m of 20.19) while
 * the micro-relief that holds water is gone: 235 closed depressions become 4.
 */
export const SMOOTH_SIGMA_M = 6.0;

/**
 * Separable Gaussian blur of a surface, reflecting at the edges.
 *
 * ⚠️ REFLECT, NOT ZERO-PAD. A zero-padded blur drags the border down toward
 * nothing, inventing a cliff around the whole tile — which in a morph reads
 * exactly like a design gesture rather than an artefact.
 *
 * ⚠️ HOLES STAY HOLES: a non-finite cell is left alone and excluded from its
 * neighbours' mean, so a survey gap is never filled in by smoothing.
 *
 * @param {import("./dem.js").DEM} dem modified in place
 * @param {number} sigmaM metres on the ground
 */
export function smoothInPlace(dem, sigmaM) {
  const { z, nrows, ncols, cell } = dem;
  const sigma = sigmaM / cell;
  const rad = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * rad + 1);
  let ks = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + rad] = v; ks += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const refl = (i, n) => (i < 0 ? -i - 1 : i >= n ? 2 * n - i - 1 : i);
  const tmp = new Float32Array(z.length);
  for (let r = 0; r < nrows; r++) for (let c = 0; c < ncols; c++) {
    const i = r * ncols + c;
    if (!Number.isFinite(z[i])) { tmp[i] = z[i]; continue; }
    let s = 0, w = 0;
    for (let t = -rad; t <= rad; t++) {
      const zv = z[r * ncols + refl(c + t, ncols)];
      if (!Number.isFinite(zv)) continue;
      s += zv * k[t + rad]; w += k[t + rad];
    }
    tmp[i] = w > 0 ? s / w : z[i];
  }
  for (let c = 0; c < ncols; c++) for (let r = 0; r < nrows; r++) {
    const i = r * ncols + c;
    if (!Number.isFinite(tmp[i])) { z[i] = tmp[i]; continue; }
    let s = 0, w = 0;
    for (let t = -rad; t <= rad; t++) {
      const zv = tmp[refl(r + t, nrows) * ncols + c];
      if (!Number.isFinite(zv)) continue;
      s += zv * k[t + rad]; w += k[t + rad];
    }
    z[i] = w > 0 ? s / w : tmp[i];
  }
}

/**
 * The design patch levelled to its own mean — the abstract's own gesture.
 *
 * ⚠️ THIS IS NOT CASE 2. Case 2 levelled a DRAWN sub-region and reports a net
 * +1,518 m3, which needs a batter the sheet never states; it cannot be rebuilt
 * and so cannot be morphed. This levels the WHOLE patch to the mean of its own
 * finite cells, which is exactly what the abstract describes — "Levelling the
 * design patch is volume-neutral by construction, the cut balancing the fill" —
 * and it is reproducible from one number that the surface itself supplies.
 *
 * ⚠️ VOLUME-NEUTRALITY IS A CONSEQUENCE HERE, NOT A TARGET. Levelling to the
 * mean makes cut equal fill by definition, so the film may state it as a
 * property of the gesture rather than as a measured coincidence. It is still
 * measured, because a float32 surface rounds.
 *
 * @param {import("./dem.js").DEM} base
 */
export function levelledFrom(base) {
  const d = base.clone();
  let sum = 0, n = 0;
  for (const v of base.z) if (Number.isFinite(v)) { sum += v; n++; }
  const mean = n ? sum / n : 0;
  const area = base.cell * base.cell;
  let cut = 0, fill = 0;
  for (let i = 0; i < d.z.length; i++) {
    if (!Number.isFinite(d.z[i])) continue;    // a hole stays a hole
    const before = d.z[i];
    d.z[i] = mean;
    const moved = d.z[i] - before;             // bill what was STORED
    if (moved < 0) cut += -moved * area; else fill += moved * area;
  }
  return { dem: d, mean, cut, fill, net: fill - cut };
}

/** The pit-and-mound stamp, on a copy. */
export function stamp(base, o = C6) {
  const d = base.clone();
  const field = proceduralField(o.pattern, d.nrows, d.ncols, d.cell,
    { module: o.module, seed: o.seed });
  const r = applyPattern(d, field, { amplitude: o.amplitude });
  return { dem: d, cut: r.cut, fill: r.fill, cells: r.cells };
}

/**
 * All six grounds, in the order the film visits them.
 * @param {import("./dem.js").DEM} base the surveyed surface
 */
export function buildStatesFrom(base) {
  const out = [];
  out.push({ id: "c1-surveyed", label: "As surveyed",
    note: "no gesture", dem: base });

  // ⚠️ ONE compareAt CALL GIVES BOTH 3 AND 4, and it has to: case 3's interval is
  // SEARCHED to match case 4's volume, so building them apart would decouple the
  // matched pair the entire comparison rests on.
  const r = compareAt(base, SHEET_TREAD);
  if (!r) throw new Error("compareAt returned nothing at tread " + SHEET_TREAD);

  const d3 = base.clone();
  benchTo(d3, new Uint8Array(base.nrows * base.ncols).fill(1), {
    interval: r.uniformInterval, tread: EXPERIMENT.treadShare, bias: EXPERIMENT.bias,
  });
  out.push({ id: "c3-uniform", label: "Terraced, uniform",
    note: "one interval over the whole surface", dem: d3, volume: r.volume });

  // ⚠️ `only` EXCLUDES 255. Number.isFinite(255) is true, so without the
  // restriction the holes in a survey get partitioned and benched as though
  // "unknown" were a landform.
  const gm = geomorphons(base);
  const grad = computeGradient(base);
  const { labels, patches } = landformPatches(base, gm.codes, {
    slopeDeg: grad.slopeDeg, aspectDeg: grad.aspectDeg,
    only: LANDFORMS.map((_, code) => code),
  });
  const d4 = base.clone();
  const r4 = benchByPatch(d4, labels, patches, {
    targetTread: SHEET_TREAD, tread: EXPERIMENT.treadShare, bias: EXPERIMENT.bias,
    minCells: EXPERIMENT.minCells,
    minInterval: EXPERIMENT.minInterval, maxInterval: EXPERIMENT.maxInterval,
  });
  out.push({ id: "c4-landform", label: "Terraced by landform",
    note: "an interval per landform unit — the same volume", dem: d4,
    volume: (r4.cut || 0) + (r4.fill || 0) });

  const mask = new Uint8Array(base.nrows * base.ncols);
  for (let i = 0; i < mask.length; i++) if (grad.slopeDeg[i] >= 36) mask[i] = 1;
  const d5 = base.clone();
  const r5 = benchTo(d5, mask, {
    interval: C5_INTERVAL, tread: EXPERIMENT.treadShare, bias: EXPERIMENT.bias,
  });
  out.push({ id: "c5-attribute", label: "Steep ground only",
    note: "slope ≥ 36°, terraced there and nowhere else", dem: d5,
    volume: (r5.cut || 0) + (r5.fill || 0) });

  const s6 = stamp(base, C6);
  out.push({ id: "c6-pattern", label: "Pit and mound",
    note: "a pattern stamped across the ground, 8 m wavelength", dem: s6.dem,
    volume: s6.cut + s6.fill });

  const d7 = base.clone();
  smoothInPlace(d7, SMOOTH_SIGMA_M);
  out.push({ id: "smoothed", label: "Smoothed",
    note: "the relief that held water, removed", dem: d7 });

  return out;
}
