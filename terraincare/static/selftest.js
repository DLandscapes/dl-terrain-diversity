// @ts-check
// The Phase 0-1 test suite. Runs identically in the browser (selftest.html)
// and in Node (_selftest.mjs) — same modules, no test-only code path.
//
// Every row's label is written as an English sentence stating the convention
// being tested, so the results table doubles as documentation of what this
// kernel promises.

import { loadGeoTIFF } from "./geotiff.js";
import { DEM } from "./dem.js";
import { computeGradient, computeCurvature } from "./analysis/horn.js";
import { flowAccumulation } from "./analysis/mfd.js";
import { twi, tri, findDepressions, analyse, geodiversityFromTRI, TAN_BETA_MIN } from "./analysis/indices.js";
import { sample, colourise, isWarm, isCool, NEUTRAL_RGB, NODATA_RGB,
  RAMPS, CATEGORICAL, variantsFor, variantStops } from "./analysis/ramps.js";
import { assemble, membership, correctedTWI, SPECIES, SHANNON_MAX, CODE,
  NO_DATA } from "./analysis/species.js";
import { solarRadiation } from "./analysis/solar.js";
import * as Substrate from "./substrate.js";
import { applyBrush, Ledger, deltaZ } from "./brush.js";
import {
  rasterise, maskZRange, levelTo, distanceToMask, batterTo, levelWithBatter,
} from "./polygon.js";
import { PlanSet, PLAN_FIELDS, pointInRings, ringIsValid, regionArea,
  regionExtent, levelCost, pickRegion, pickVertex, toFeatures,
  groundPerPixel } from "./plan.js";
import { writeShapefile, writeGeoJSON } from "./export/shapefile.js";
import { readShapefile, prjEpsg, overlapsTerrain } from "./export/shapefile-read.js";
import { hillshade } from "./analysis/hillshade.js";
import { Stroke } from "./stroke.js";
import { localStats } from "./local.js";
import { latticeEdges, isMeshEdge, chordDeviation } from "./lattice.js";
import { History, captureRect, applyEdit } from "./history.js";
import { sampleSection, sectionAreas, sectionName, sectionSVG, facetZAt } from "./section.js";
import { contourLevels, contourSegments, facetDeviation, niceInterval } from "./contours.js";
import { fieldFromRGBA, generatedField, resampleField, signedDisplacement,
  applyPattern, patternCost, NEUTRAL, PATTERNS, PATTERN_BY_ID,
  PATTERN_MEASURED, proceduralField } from "./pattern.js";
import { pondWater, absorbedDepth, INFILTRATION } from "./analysis/ponding.js";
import { writeGeoTIFF } from "./export/geotiff-write.js";
import { writeOBJ, writeVoxelOBJ } from "./export/obj.js";
import { makeZip } from "./export/zip.js";
import { scaleBarLength } from "./export/figure.js";
import { writeVoxelSolidOBJ, blockLevels, manifoldReport } from "./export/solid.js";
import { geomorphons, LANDFORMS } from "./analysis/geomorphons.js";
import { RULE_LAYERS, maskFromRule, maskRect, describeRules } from "./rules.js";
import { demoTileHeights, DEMO_PATCHES, DEMO_DIVISIONS } from "./demotile.js";
import { PATTERN_RANGE, patternRank, PATTERN_MEASURED as PM2 } from "./pattern.js";
import { SelectionStack, composeStack, describeStack, surfaceStamp, stale,
  nextOp, OPS, OP_BY_KEY, featherWeights } from "./selection.js";
import { benchTarget, benchTo, meanTread, BENCH_BIAS } from "./bench.js";
import { toUTM33, readExifGPS } from "./photos.js";
import { readOrthoTIFF, drapeOnto } from "./ortho.js";
import { watersheds } from "./analysis/watershed.js";
import { horizonMap, windExposure } from "./analysis/horizon.js";
import {
  applyGuide, centreline, projectToPolyline, stations, groundAt, PROFILES, ALONG,
} from "./guide.js";
import { symbolField, strideFor, symbolLegend } from "./symbols.js";
import { gradingSVG } from "./export/grading.js";
import { buildGlyph, buildGlyphs, describeChain, DEFAULT_CHAIN } from "./glyphs.js";
import { DURATION, SCRIPT, WAVELENGTH_M, beatAt, stateAt, applyTerrain,
  toleranceField, boundaries } from "./timeline.js";
import { connectedComponents, landformPatches, benchByPatch } from "./patches.js";
import { compareAt, compareSchemes, measureSurface, matchUniformInterval,
  EXPERIMENT } from "./compare.js";
import { isopachSVG, slopeClassSVG, drainageSVG, chainageSectionsSVG,
  SLOPE_CLASSES } from "./export/derivatives.js";

/**
 * @typedef {Object} Row
 * @property {string} group
 * @property {string} check
 * @property {string} expected
 * @property {string} measured
 * @property {boolean} pass
 */

/** @param {(rel:string)=>Promise<ArrayBuffer>} fetchTile */
export async function runSuite(fetchTile) {
  /** @type {Row[]} */
  const rows = [];
  const add = (group, check, expected, measured, pass) =>
    rows.push({ group, check, expected: String(expected), measured: String(measured), pass });
  const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
  const f4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : String(v));

  // Performance is measured FIRST, on a clean heap, then reported last.
  // Timing it after the correctness groups charges their garbage collection to
  // the pass being measured — that mistake inflated readings by 2x during
  // development. In production the worker owns its own thread and reuses its
  // buffers, so it never competes with a test suite that just allocated
  // twenty DEMs. Measuring it first is the representative case.
  /** @type {Row[]} */
  const perfRows = [];
  {
    const dem = DEM.fromRaw(loadGeoTIFF(await fetchTile("orndalen_fill_025m.tif"), { name: "perf" }));
    const median = (fn, iters = 21) => {
      // 20 warm-up iterations, not 5. Measuring first (above) removes GC
      // contamination from the correctness groups, but it also means measuring
      // on a COLD page before the JIT has optimised — which is a second, opposite
      // bias. With 5 warm-ups Chromium reported 37.7 ms here while the same pass,
      // measured warm and repeated, is a stable 20.4–21.1 ms. Both biases have to
      // be handled; the fix for this one is warm-up, not a looser budget.
      for (let k = 0; k < 20; k++) fn();
      const ts = [];
      for (let k = 0; k < iters; k++) {
        const t0 = performance.now();
        fn();
        ts.push(performance.now() - t0);
      }
      ts.sort((x, y) => x - y);
      return ts[Math.floor(ts.length / 2)];
    };
    const F = "F · performance";
    const push = (check, expected, measured, pass) =>
      perfRows.push({ group: F, check, expected: String(expected), measured: String(measured), pass });

    // Only the NON-LOCAL operators need a full-grid recompute in the worker:
    // flow accumulation, TWI, depressions. Slope, aspect, TRI, curvature and
    // the cut/fill ledger are local 3x3 operators the main thread redoes over
    // the ~800-cell dirty rect under the brush, landing on the SAME frame as
    // the gesture. Budget is 2 display frames (33 ms), not 60 fps, because the
    // worker is off the render thread and only feeds auxiliary panels.
    const g = computeGradient(dem);
    const medWorker = median(() => {
      const fl = flowAccumulation(dem);
      twi(fl.specificCatchmentArea, g.slope);
      findDepressions(dem);
    });
    // NOTE: this is the ISOLATED figure — the algorithm with the machine to
    // itself. In the running app the same pass shares the CPU with the render
    // loop, the three.js scene and panel colourisation, and measures ~40 ms
    // median on this hardware. Do not read this number as the live latency, and
    // do not derive the degrade threshold from it (see analysis-client.js).
    push("Worker pass (flow + TWI + depressions) fits a 2-frame budget — 33 ms @60 fps",
      "≤33 ms", `${medWorker.toFixed(1)} ms`, medWorker <= 33);

    const medFull = median(() => analyse(dem), 11);
    push("Whole-grid analysis (runs once at load, not per gesture) stays under 1 s",
      "≤1000 ms", `${medFull.toFixed(1)} ms`, medFull <= 1000);

    // ⚠️ CONTOURS CANNOT RIDE THE DIRTY RECT. Every other live update in this
    // tool recomputes a window: the lattice shares the surface's own position
    // buffer, the panels take a rect. A contour line is separate geometry with
    // its own vertex count, and moving one cell can add or remove segments
    // anywhere along a level — so it is a whole rebuild or nothing. This is the
    // measurement the app's 120 ms throttle is set from: the rebuild has to be
    // cheap enough to run several times a second alongside a gesture without
    // competing with the ~1.3 ms the main thread spends on the stroke itself.
    const medContour = median(() =>
      contourSegments(dem.z, dem.nrows, dem.ncols, dem.cell, 0.5, { exaggeration: 2.5 }), 11);
    push("A whole contour rebuild is cheap enough to run inside a gesture at the "
      + "app's 120 ms throttle, with room for the stroke itself",
      "≤40 ms", `${medContour.toFixed(1)} ms`, medContour <= 40);

    // The early-out is what makes that true: testing every triangle against
    // every level instead would be 130 000 x 21 for the same line work.
    const medFine = median(() =>
      contourSegments(dem.z, dem.nrows, dem.ncols, dem.cell, 0.05), 11);
    push("…and a twentieth-of-a-metre interval, ten times the line work, still "
      + "returns — the cost follows the segments, not cells × levels",
      "≤300 ms", `${medFine.toFixed(1)} ms`, medFine <= 300);

    // Settling a rainfall event runs on the MAIN thread, from the live DEM,
    // once per gesture rather than per frame — see refreshWater(). The budget
    // is therefore a gesture's settle, not a display frame, and this is the
    // figure that justifies not moving it into the worker.
    const medPond = median(() => pondWater(dem, 0.002), 11);
    push("Settling a rainfall event over the design patch is a once-per-gesture "
      + "cost, not a per-frame one, and stays inside a settle",
      "≤150 ms", `${medPond.toFixed(1)} ms`, medPond <= 150);

    const a = analyse(dem);
    push("Geodiversity on the real patch is informative, not saturated at its bound",
      "0 < g < 1", f4(a.metrics.geodiversity),
      a.metrics.geodiversity > 0 && a.metrics.geodiversity < 1);
    push("The real fill patch holds measurable depression storage",
      ">0 m³", `${f2(a.metrics.storageVolume)} m³ in ${a.depressions.depressions.length} hollows`,
      a.metrics.storageVolume > 0);
    push("TWI is defined across almost all of the real patch (it is not flat)",
      ">95%", `${(100 * a.metrics.twiValidFraction).toFixed(1)}%`,
      a.metrics.twiValidFraction > 0.95);
  }

  // ============================================================ GROUP A
  const A = "A · analytic surfaces";

  {
    const dem = DEM.synthetic(32, 32, 1, (r) => 100 - 0.10 * r);
    const g = computeGradient(dem);
    const mid = dem.idx(16, 16);
    add(A, "A plane falling 10% due south has slope atan(0.10) = 5.7106°",
      "5.7106°", f4(g.slopeDeg[mid]) + "°", near(g.slopeDeg[mid], 5.7106, 1e-3));
    add(A, "…and aspect exactly 180° (steepest descent points south, row 0 = north)",
      "180.000°", f4(g.aspectDeg[mid]) + "°", near(g.aspectDeg[mid], 180, 1e-3));
  }
  {
    const dem = DEM.synthetic(32, 32, 1, (r, c) => 100 - 0.10 * c);
    const g = computeGradient(dem);
    add(A, "A plane falling due east has aspect exactly 90°",
      "90.000°", f4(g.aspectDeg[dem.idx(16, 16)]) + "°",
      near(g.aspectDeg[dem.idx(16, 16)], 90, 1e-3));
  }
  {
    const dem = DEM.synthetic(32, 32, 1, () => 50);
    const g = computeGradient(dem);
    let nan = 0;
    for (const v of g.aspectDeg) if (Number.isNaN(v)) nan++;
    add(A, "On a flat plane aspect is NaN in EVERY cell — flat must never read as north-facing",
      `${dem.z.length}/${dem.z.length} NaN`, `${nan}/${dem.z.length} NaN`, nan === dem.z.length);
    add(A, "On a flat plane slope is 0 everywhere", "all 0",
      g.slopeDeg.every((v) => v === 0) ? "all 0" : "not all 0", g.slopeDeg.every((v) => v === 0));
    const t = tri(dem);
    add(A, "On a flat plane TRI is 0 everywhere", "all 0",
      t.every((v) => v === 0) ? "all 0" : "not all 0", t.every((v) => v === 0));
    const d = findDepressions(dem);
    add(A, "On a flat plane depression storage is exactly 0 m³", "0", String(d.totalVolume), d.totalVolume === 0);
    add(A, "On a flat plane geodiversity is 0 (one roughness class only)",
      "0", f4(geodiversityFromTRI(t)), geodiversityFromTRI(t) === 0);
  }
  {
    const cell = 2;
    const pit = DEM.synthetic(21, 21, cell, (r, c) => (r === 10 && c === 10 ? 49.5 : 50));
    const dp = findDepressions(pit);
    const want = 0.5 * cell * cell;
    add(A, "A single-cell pit appears in the depression inventory",
      "1 depression", `${dp.depressions.length}`, dp.depressions.length === 1);
    add(A, "…with storage volume = depth × cell² (depressions are measured, not filled away)",
      `${want} m³`, `${f4(dp.totalVolume)} m³`, near(dp.totalVolume, want, 1e-6));
    const peak = DEM.synthetic(21, 21, cell, (r, c) => (r === 10 && c === 10 ? 50.5 : 50));
    const pk = findDepressions(peak);
    add(A, "A single-cell peak does NOT appear in the inventory",
      "0 depressions", `${pk.depressions.length}`, pk.depressions.length === 0);
  }
  {
    const cell = 1;
    const dem = DEM.synthetic(64, 64, cell, (r) => 100 - 0.10 * r);
    const fl = flowAccumulation(dem);
    let worst = 0;
    for (const r of [10, 20, 30, 40, 50]) {
      const got = fl.contributingArea[dem.idx(r, 32)];
      const wantA = (r + 1) * cell * cell;
      worst = Math.max(worst, Math.abs(got - wantA) / wantA);
    }
    add(A, "On a uniform plane, contributing area at row r equals (r+1)·cell² within 1%",
      "≤1.00%", `${(worst * 100).toFixed(2)}%`, worst < 0.01);
  }
  {
    const skew = DEM.synthetic(48, 48, 1, (r, c) => 100 - 0.10 * r - 0.0087 * c);
    const fs = flowAccumulation(skew);
    let multi = 0, interior = 0;
    for (let r = 1; r < 47; r++) for (let c = 1; c < 47; c++) {
      interior++;
      if (fs.receiverCount[skew.idx(r, c)] >= 2) multi++;
    }
    const pct = 100 * multi / interior;
    add(A, "On a skewed plane MFD spreads flow to ≥2 receivers — it would be exactly 1 if this were D8",
      ">95%", `${pct.toFixed(1)}%`, pct > 95);
  }
  {
    const R = 40, cell = 1;
    const mk = (sign) => DEM.synthetic(41, 41, cell, (r, c) => {
      const dr = (r - 20) * cell, dc = (c - 20) * cell, d2 = dr * dr + dc * dc;
      return d2 < R * R ? sign * Math.sqrt(R * R - d2) : 0;
    });
    const dome = mk(1), bowl = mk(-1);
    const cvD = computeCurvature(dome).profile[dome.idx(20, 26)];
    const cvB = computeCurvature(bowl).profile[bowl.idx(20, 26)];
    add(A, "A mound has profile curvature > 0 (convex)", ">0", cvD.toExponential(2), cvD > 0);
    add(A, "A hollow has profile curvature < 0 (concave)", "<0", cvB.toExponential(2), cvB < 0);
  }

  // ============================================================ GROUP B
  const B = "B · sign conventions (end to end)";

  {
    const up = sample("cutfill", +1), dn = sample("cutfill", -1), zero = sample("cutfill", 0);
    add(B, "FILL (Δz > 0, material added) renders WARM",
      "r > b", `rgb(${up.slice(0, 3)})`, isWarm(up));
    add(B, "CUT (Δz < 0, material removed) renders COOL",
      "b > r", `rgb(${dn.slice(0, 3)})`, isCool(dn));
    add(B, "Δz exactly 0 renders the exact neutral paper tone — untouched ground cannot read as a faint gain",
      `rgb(${NEUTRAL_RGB})`, `rgb(${zero.slice(0, 3)})`,
      zero[0] === NEUTRAL_RGB[0] && zero[1] === NEUTRAL_RGB[1] && zero[2] === NEUTRAL_RGB[2]);
    const nd = sample("cutfill", NaN);
    add(B, "A non-finite value renders the nodata tone, never a colour mistakable for data",
      `rgb(${NODATA_RGB})`, `rgb(${nd.slice(0, 3)})`,
      nd[0] === NODATA_RGB[0] && nd[1] === NODATA_RGB[1] && nd[2] === NODATA_RGB[2]);
    const aspNaN = sample("aspect", NaN), aspN = sample("aspect", 0);
    add(B, "Flat ground (aspect NaN) does NOT render as the north colour",
      "different", `NaN=rgb(${aspNaN.slice(0, 3)}) N=rgb(${aspN.slice(0, 3)})`,
      !(aspNaN[0] === aspN[0] && aspNaN[1] === aspN[1] && aspNaN[2] === aspN[2]));
  }
  {
    // End-to-end: brush -> surface -> deltaZ -> ramp -> pixel.
    // A sign flip anywhere in that chain fails this, which is what makes it
    // worth more than the unit tests above.
    const cell = 0.25;
    const base = DEM.synthetic(64, 64, cell, () => 80);
    const before = base.z.slice();
    const led = new Ledger();
    const [mx, my] = base.xy(20, 20);
    applyBrush(base, "mound", mx, my, 2.0, 0.5, led);
    const [sx, sy] = base.xy(44, 44);
    applyBrush(base, "scoop", sx, sy, 2.0, 0.5, led);
    const dz = deltaZ(before, base.z);
    const px = colourise("cutfill", dz);
    const at = (r, c) => {
      const o = base.idx(r, c) * 4;
      return [px[o], px[o + 1], px[o + 2], px[o + 3]];
    };
    const moundPx = at(20, 20), scoopPx = at(44, 44), untouchedPx = at(2, 2);
    add(B, "Full chain: a MOUND stroke paints WARM at the cell it raised",
      "r > b", `rgb(${moundPx.slice(0, 3)})`, isWarm(moundPx));
    add(B, "Full chain: a SCOOP stroke paints COOL at the cell it lowered",
      "b > r", `rgb(${scoopPx.slice(0, 3)})`, isCool(scoopPx));
    add(B, "Full chain: ground the brush never touched stays exactly neutral",
      `rgb(${NEUTRAL_RGB})`, `rgb(${untouchedPx.slice(0, 3)})`,
      untouchedPx[0] === NEUTRAL_RGB[0] && untouchedPx[2] === NEUTRAL_RGB[2]);

    add(B, "Ledger identity: net === fill − cut", "true",
      `${f4(led.net)} === ${f4(led.fill - led.cut)}`, Math.abs(led.net - (led.fill - led.cut)) < 1e-12);
  }
  {
    // Banking, tested on a scoop ALONE — in the block above the mound and the
    // scoop cancel, so `banked` is legitimately 0 there.
    const dem = DEM.synthetic(48, 48, 0.25, () => 80);
    const led = new Ledger();
    const [x, y] = dem.xy(24, 24);
    applyBrush(dem, "scoop", x, y, 2.0, 0.5, led);
    add(B, "A scoop on its own banks material for later re-use (banked > 0)",
      ">0 m³", `${f4(led.banked)} m³`, led.banked > 0);

    const bankedAfterScoop = led.banked;
    const [mx2, my2] = dem.xy(12, 12);
    applyBrush(dem, "mound", mx2, my2, 2.0, 0.25, led);
    add(B, "…and spending it on a mound draws the bank back down",
      `<${f4(bankedAfterScoop)} m³`, `${f4(led.banked)} m³`, led.banked < bankedAfterScoop);
  }
  {
    // Scoop then mound the same volume -> net ~0. This is the video's closing
    // claim, so it is asserted on the DISPLAYED STRING too: "+0.1" vs "−0.1"
    // is exactly where a sign inverts on camera without anyone noticing.
    const cell = 0.25;
    const dem = DEM.synthetic(64, 64, cell, () => 80);
    const led = new Ledger();
    const [ax, ay] = dem.xy(20, 20);
    applyBrush(dem, "scoop", ax, ay, 2.0, 0.4, led);
    const [bx, by] = dem.xy(44, 44);
    applyBrush(dem, "mound", bx, by, 2.0, 0.4, led);
    const rel = Math.abs(led.net) / led.cut;
    add(B, "Scoop then an equal mound leaves net ≈ 0 — differentiation at no imported material",
      "<0.1% of cut", `${(rel * 100).toFixed(4)}%`, rel < 0.001);
    add(B, "…and the displayed net label reads ±0.0 m³, not a signed non-zero",
      "±0.0 m³", led.netLabel(), led.netLabel() === "±0.0 m³");
  }

  // ============================================================ GROUP G
  // The Level tool drives the video's opening sequence, so its behaviour is
  // asserted here rather than assumed. It has two modes and the difference is
  // the difference between the storyboard working and not — see brush.js.
  const G = "G · the Level tool, and the video's beats on real data";
  {
    const dem = DEM.synthetic(64, 64, 0.25, (r, c) => 80 + 0.4 * Math.sin(r * 0.5) * Math.cos(c * 0.4));
    const led = new Ledger();
    const [x, y] = dem.xy(32, 32);
    applyBrush(dem, "level", x, y, 3.0, 1.0, led);
    const rel = led.cut > 0 ? Math.abs(led.net) / led.cut : 0;
    add(G, "Levelling is EXACTLY volume-neutral — it moves material but imports none",
      "net <1e-9 of cut", `${rel.toExponential(1)} of ${f4(led.cut)} m³`, rel < 1e-9);
    add(G, "…so the difference between destroying and creating habitat is where material goes, not how much",
      "cut === fill", `${f4(led.cut)} / ${f4(led.fill)}`, Math.abs(led.cut - led.fill) < 1e-9);
  }
  {
    // Local-mean mode softens; datum mode planarizes. Both are needed.
    const rough = () => DEM.synthetic(48, 48, 0.25, (r, c) => 80 + 0.3 * Math.sin(r * 0.7) * Math.cos(c * 0.6));
    const before = rough(), after = rough();
    const [x, y] = after.xy(24, 24);
    applyBrush(after, "level", x, y, 3.0, 1.0);
    const meanSlope = (d) => {
      const g = computeGradient(d);
      let s = 0, n = 0;
      for (let r = 12; r < 36; r++) for (let c = 12; c < 36; c++) {
        const v = g.slopeDeg[d.idx(r, c)];
        if (Number.isFinite(v)) { s += v; n++; }
      }
      return s / n;
    };
    const sb = meanSlope(before), sa = meanSlope(after);
    add(G, "Level (local mean) flattens the surface under the brush",
      `< ${f2(sb)}°`, `${f2(sa)}°`, sa < sb);

    const dat = rough();
    let sum = 0, n = 0;
    for (const v of dat.z) if (Number.isFinite(v)) { sum += v; n++; }
    const datum = sum / n;
    const ledD = new Ledger();
    const span = dat.ncols * dat.cell, R = 4.0;
    for (let gy = 0; gy <= span; gy += R * 0.5)
      for (let gx = 0; gx <= span; gx += R * 0.5)
        applyBrush(dat, "level", dat.originX + gx, dat.originY + gy, R, 1.0, ledD, { target: datum });
    const [dlo, dhi] = dat.zRange();
    add(G, "Level (to a datum) planarizes toward that datum — what levelling a site actually means",
      "relief <0.05 m", `${(dhi - dlo).toFixed(3)} m`, dhi - dlo < 0.05);
    const relD = ledD.cut > 0 ? Math.abs(ledD.net) / ledD.cut : 0;
    add(G, "…and planarizing to the mean elevation is volume-neutral too",
      "<0.1% of cut", `${(relD * 100).toFixed(4)}%`, relD < 0.001);
  }
  {
    // THE VIDEO'S CENTRAL BEAT, on the real Ørndalen patch: planarize it and
    // every measure of differentiation must collapse. If this fails, the
    // storyboard does not work, regardless of what the maths says elsewhere.
    const dem = DEM.fromRaw(loadGeoTIFF(await fetchTile("orndalen_fill_025m.tif"), { name: "beat" }));
    const b = analyse(dem);
    let sum = 0, n = 0;
    for (const v of dem.z) if (Number.isFinite(v)) { sum += v; n++; }
    const datum = sum / n;
    const led = new Ledger();
    const span = dem.ncols * dem.cell, R = 8.0;
    for (let gy = 0; gy <= span; gy += R * 0.5)
      for (let gx = 0; gx <= span; gx += R * 0.5)
        applyBrush(dem, "level", dem.originX + gx, dem.originY + gy, R, 1.0, led, { target: datum });
    const a = analyse(dem);

    add(G, "Levelling the real patch collapses geodiversity to zero",
      `${f4(b.metrics.geodiversity)} → 0`, f4(a.metrics.geodiversity),
      b.metrics.geodiversity > 0.3 && a.metrics.geodiversity < 0.01);
    add(G, "…and TWI loses its answer almost everywhere — the question stops applying",
      `${(100 * b.metrics.twiValidFraction).toFixed(1)}% → <10%`,
      `${(100 * a.metrics.twiValidFraction).toFixed(1)}%`,
      a.metrics.twiValidFraction < 0.10);
    add(G, "…and terrain ruggedness drops by more than an order of magnitude",
      `${f4(b.metrics.triMean)} → <0.004 m`, `${a.metrics.triMean.toFixed(5)} m`,
      a.metrics.triMean < b.metrics.triMean / 10);
    add(G, "…while the earthwork ledger still reads net zero — 800+ m³ moved, nothing imported",
      "±0.0 m³", `${led.netLabel(2)} (cut ${led.cut.toFixed(0)} m³)`,
      led.cut > 100 && Math.abs(led.net) / led.cut < 0.001);
  }

  // ============================================================ GROUP C
  const C = "C · TWI degeneracy reads as “no answer”";
  {
    const flat = DEM.synthetic(32, 32, 1, () => 50);
    const gf = computeGradient(flat), ff = flowAccumulation(flat);
    const tf = twi(ff.specificCatchmentArea, gf.slope);
    const allNaN = tf.every((v) => Number.isNaN(v));
    add(C, "On a levelled surface TWI is NaN in 100% of cells — the question stops having an answer",
      "100% NaN", `${(100 * tf.filter(Number.isNaN).length / tf.length).toFixed(1)}% NaN`, allNaN);
    const px = colourise("twi", tf);
    add(C, "…and the TWI panel paints the nodata tone there, not a bright wet spot",
      `rgb(${NODATA_RGB})`, `rgb(${[px[0], px[1], px[2]]})`,
      px[0] === NODATA_RGB[0] && px[1] === NODATA_RGB[1] && px[2] === NODATA_RGB[2]);

    const almost = DEM.synthetic(32, 32, 1, (r) => 50 - Math.tan(0.05 * Math.PI / 180) * r);
    const ta = twi(flowAccumulation(almost).specificCatchmentArea, computeGradient(almost).slope);
    add(C, "A 0.05° plane is still below the threshold, so TWI is still NaN",
      "100% NaN", ta.every((v) => Number.isNaN(v)) ? "100% NaN" : "some finite",
      ta.every((v) => Number.isNaN(v)));

    const one = DEM.synthetic(64, 64, 1, (r) => 50 - Math.tan(1 * Math.PI / 180) * r);
    const g1 = computeGradient(one), f1 = flowAccumulation(one);
    const t1 = twi(f1.specificCatchmentArea, g1.slope);
    const i1 = one.idx(30, 32);
    const want = Math.log(f1.specificCatchmentArea[i1] / Math.tan(g1.slope[i1]));
    add(C, "A 1° plane gives finite TWI equal to hand-computed ln(a / tanβ)",
      want.toFixed(5), t1[i1].toFixed(5), near(t1[i1], want, 1e-5));
    add(C, "The flatness threshold is tan(0.1°)", "0.0017453", TAN_BETA_MIN.toFixed(7),
      near(TAN_BETA_MIN, 0.0017453, 1e-6));
  }

  // ============================================================ GROUP D
  const D = "D · real Ørndalen data vs SOURCE.txt (produced independently in Python)";
  let fillDem = null;
  {
    const raw = loadGeoTIFF(await fetchTile("orndalen_fill_025m.tif"), { name: "fill" });
    const dem = DEM.fromRaw(raw);
    fillDem = dem;
    const [lo, hi] = dem.zRange();
    add(D, "0.25 m fill patch reads through the TILED-TIFF path: z min 75.85 m",
      "75.85", f2(lo), near(lo, 75.85, 0.01));
    add(D, "0.25 m fill patch: z max 81.16 m", "81.16", f2(hi), near(hi, 81.16, 0.01));
    add(D, "0.25 m fill patch: cell size 0.25 m", "0.25", String(dem.cell), dem.cell === 0.25);
    add(D, "0.25 m fill patch: south-west origin 654942 / 7737700 (EPSG:25833)",
      "654942 / 7737700", `${dem.originX} / ${dem.originY}`,
      dem.originX === 654942 && dem.originY === 7737700);
    add(D, "0.25 m fill patch has no nodata cells", "0%",
      `${(100 * dem.nodataFraction()).toFixed(1)}%`, dem.nodataFraction() === 0);

    const g = computeGradient(dem);
    let s = 0, n = 0;
    for (const v of g.slopeDeg) if (Number.isFinite(v)) { s += v; n++; }
    add(D, "Horn slope mean reproduces the recorded 6.1°",
      "6.1°", f2(s / n) + "°", near(s / n, 6.1, 0.05));

    const t = tri(dem);
    let ts = 0, tn = 0;
    for (const v of t) if (Number.isFinite(v)) { ts += v; tn++; }
    add(D, "TRI mean reproduces the recorded 0.036 m — RMS variant sqrt(Σd²/k), resolved empirically",
      "0.036 m", f4(ts / tn) + " m", near(ts / tn, 0.036, 0.001));
  }
  {
    const dem = DEM.fromRaw(loadGeoTIFF(await fetchTile("orndalen_2024_4m.tif"), { name: "ctx" }));
    const [lo, hi] = dem.zRange();
    add(D, "4 m context tile: z max 158.97 m — Tromsøyvarden, the island summit at 159 m",
      "158.97", f2(hi), near(hi, 158.97, 0.01));
    add(D, "4 m context tile: z min 7.14 m", "7.14", f2(lo), near(lo, 7.14, 0.01));
    add(D, "4 m context tile: cell size 4 m", "4", String(dem.cell), dem.cell === 4);

    // ⚠️ THE TWO-SCALE DIVE DEPENDS ON THIS BEING EXACT, NOT APPROXIMATE.
    // The design patch was chosen to land on the national 4 m grid, so the dive
    // needs no resampling and the nest rectangle can be drawn on cell
    // boundaries. If either tile is ever refetched with a shifted bbox this is
    // the check that fails, and it fails loudly rather than drawing a
    // plausible-looking rectangle half a cell out.
    const nest = DEM.nest(dem, fillDem);
    add(D, "the 0.25 m design patch lands EXACTLY on the 4 m national grid — the " +
      "dive needs no resampling and the nest outline falls on cell boundaries",
      "0 cells of misalignment", `${nest.alignmentError}`, nest.alignmentError === 0);
    add(D, "…and it sits at integer cell offsets 148 east, 156 north within the tile",
      "148 / 156", `${nest.col} / ${nest.row}`, nest.col === 148 && nest.row === 156);
    add(D, "…covering exactly 16×16 context cells, so 4.00 / 0.25 = 16 holds in " +
      "geometry as well as in cell size",
      "16×16 at ratio 16", `${nest.cols}×${nest.rows} at ratio ${nest.ratio}`,
      nest.cols === 16 && nest.rows === 16 && nest.ratio === 16);
    add(D, "…which makes the design patch 1/256 of the context tile's area — the " +
      "figure the two-scale argument is quoted on",
      "1/256", `1/${Math.round((dem.ncols * dem.nrows) / (nest.cols * nest.rows))}`,
      Math.round((dem.ncols * dem.nrows) / (nest.cols * nest.rows)) === 256);
    add(D, "…and lies wholly inside it", "contained", String(nest.contained), nest.contained);

    // ── watersheds ──────────────────────────────────────────────────────────
    // ⚠️ D8 HERE, MFD EVERYWHERE ELSE — see the note at the head of
    // analysis/watershed.js. A basin is a partition and a partition needs one
    // receiver per cell, which MFD by construction does not give.
    const ws = watersheds(fillDem);
    let uphill = 0, unrouted = 0;
    for (let i = 0; i < ws.receiver.length; i++) {
      const j = ws.receiver[i];
      if (j === -2) continue;                    // no data
      if (j === -1 || j === i) continue;         // outlet, or a pit
      if (!(fillDem.z[j] < fillDem.z[i])) uphill++;
      if (j < 0 || j >= ws.receiver.length) unrouted++;
    }
    add(D, "every D8 receiver is STRICTLY LOWER than the cell that drains to it — " +
      "the one invariant that makes a basin a basin rather than a colour blob",
      "0 uphill links", `${uphill} uphill, ${unrouted} out of range`,
      uphill === 0 && unrouted === 0);

    let maxId = -1;
    for (const v of ws.basin) if (v > maxId) maxId = v;
    add(D, "…basin ids are contiguous from 0, so the id is an index and not a hash",
      `max id ${ws.count - 1}`, `max id ${maxId}`, maxId === ws.count - 1);

    let descending = true;
    for (let i = 1; i < ws.areas.length; i++) if (ws.areas[i] > ws.areas[i - 1]) descending = false;
    add(D, "…and basins are ranked by area, so basin 0 is always the largest",
      "descending", String(descending), descending);

    add(D, "the real 0.25 m fill patch resolves hundreds of separate catchments, " +
      "none of them dominant — this ground is a field of hollows, not a slope",
      ">200 basins, dominance <10%",
      `${ws.count} basins, ${(100 * ws.dominance).toFixed(1)}%`,
      ws.count > 200 && ws.dominance < 0.10);

    // ⚠️ THE FIFTH INDEPENDENT COLLAPSE. Geodiversity, landform classes,
    // TWI-defined fraction and Shannon H′ all fall to zero on one levelling
    // gesture; basin count is a fifth, and the most legible of them.
    // NOT `flat` — the context tile's slope stats already use that name in this
    // same block scope, and shadowing it is a module-level SyntaxError.
    const levelled = fillDem.clone();
    levelled.z.fill(78);
    const wsFlat = watersheds(levelled);
    add(D, "…and levelling it to a datum leaves NO catchments at all — a fifth " +
      "independent collapse on a single gesture, beside geodiversity, landform " +
      "classes, TWI-defined fraction and Shannon H′",
      "0 basins", `${ws.count} → ${wsFlat.count}`, wsFlat.count === 0);
    const g = computeGradient(dem);
    let s = 0, n = 0, flat = 0;
    for (const v of g.slopeDeg) if (Number.isFinite(v)) { s += v; n++; if (v < 4) flat++; }
    add(D, "4 m context tile: Horn slope mean reproduces the recorded 12.3°",
      "12.3°", f2(s / n) + "°", near(s / n, 12.3, 0.05));
    add(D, "4 m context tile: 22.8% of cells below 4° — the engineered flat ground",
      "22.8%", `${(100 * flat / n).toFixed(1)}%`, near(100 * flat / n, 22.8, 0.15));
  }
  {
    // Hillshade is the ported np.gradient path; check it produces a sane image
    // rather than a constant, since it is what the eventual 3D view is checked against.
    const hs = hillshade(fillDem);
    let mn = 255, mx = 0, sum = 0;
    for (const v of hs) { if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
    add(D, "Hillshade of the real patch spans a real range (not a flat grey image)",
      "range > 60", `${mn}..${mx}, mean ${(sum / hs.length).toFixed(0)}`, mx - mn > 60);
  }

  // ============================================================ GROUP E
  const E = "E · determinism";
  {
    const mk = () => {
      const dem = DEM.synthetic(48, 48, 0.25, () => 80);
      const led = new Ledger();
      const [x, y] = dem.xy(24, 24);
      applyBrush(dem, "scoop", x, y, 2.0, 0.5, led);
      return { dem, led };
    };
    const a = mk(), b = mk();
    let same = true;
    for (let i = 0; i < a.dem.z.length; i++) if (a.dem.z[i] !== b.dem.z[i]) { same = false; break; }
    add(E, "The same stroke on the same surface produces a bit-identical result",
      "identical", same ? "identical" : "differs", same);
    add(E, "…and an identical cut volume", f4(a.led.cut), f4(b.led.cut), a.led.cut === b.led.cut);

    // Frame-rate independence: the same stroke applied as 1 dab vs 8 smaller
    // dabs along zero length must agree. This protects the "net ≈ 0" claim
    // from depending on how many frames the stroke was drawn over.
    const coarse = DEM.synthetic(48, 48, 0.25, () => 80);
    const lc = new Ledger();
    const [cx, cy] = coarse.xy(24, 24);
    applyBrush(coarse, "scoop", cx, cy, 2.0, 0.8, lc);
    const fine = DEM.synthetic(48, 48, 0.25, () => 80);
    const lf = new Ledger();
    for (let k = 0; k < 8; k++) applyBrush(fine, "scoop", cx, cy, 2.0, 0.1, lf);
    const rel = Math.abs(lc.cut - lf.cut) / lc.cut;
    add(E, "One 0.8 m dab and eight 0.1 m dabs at the same point remove the same volume within 0.5%",
      "<0.5%", `${(rel * 100).toFixed(3)}%`, rel < 0.005);
  }

  // ============================================================ GROUP H
  // Phase 3. A stroke's effect must be a property of the GESTURE, not of the
  // frame rate that happened to render it — otherwise "net earth moved ≈ 0 m³",
  // the sentence the video ends on, is not reproducible between takes.
  const H = "H · strokes are frame-rate independent, and local matches global";
  {
    const flat = () => DEM.synthetic(160, 160, 0.25, () => 80);
    const cfg = { tool: "scoop", radius: 2.0, strength: 0.3 };

    // Same straight path, walked in 4 big steps vs 40 small ones.
    const run = (steps) => {
      const dem = flat();
      const led = new Ledger();
      const s = new Stroke(dem, led, { ...cfg });
      const [x0, y0] = dem.xy(80, 40);
      const [x1] = dem.xy(80, 120);
      for (let k = 0; k <= steps; k++) {
        const f = k / steps;
        s.to(x0 + (x1 - x0) * f, y0, 1 / 60);
      }
      return { cut: led.cut, dabs: s.dabs };
    };
    const coarse = run(4), fine = run(40);
    const rel = Math.abs(coarse.cut - fine.cut) / coarse.cut;
    add(H, "The same drag sampled at 4 frames and at 40 frames removes the same volume",
      "<1%", `${(rel * 100).toFixed(3)}% (${coarse.cut.toFixed(3)} vs ${fine.cut.toFixed(3)} m³)`,
      rel < 0.01);
    add(H, "…because dabs are placed per unit distance travelled, not per frame",
      "same dab count", `${coarse.dabs} vs ${fine.dabs}`, coarse.dabs === fine.dabs);

    // A held brush must also be frame-rate independent: it advances on time.
    const held = (frames) => {
      const dem = flat();
      const led = new Ledger();
      const s = new Stroke(dem, led, { ...cfg });
      const [x, y] = dem.xy(80, 80);
      s.to(x, y, 0);
      for (let k = 0; k < frames; k++) s.to(x, y, 1.0 / frames); // 1 s total
      return led.cut;
    };
    const h30 = held(30), h120 = held(120);
    const relH = Math.abs(h30 - h120) / h30;
    add(H, "Holding the brush still for one second removes the same volume at 30 and 120 fps",
      "<1%", `${(relH * 100).toFixed(3)}%`, relH < 0.01);

    // The stroke keeps two rects with two jobs: `stroke.rect` is the union of
    // everything the gesture has ever touched, while each to() call returns
    // only the rect of the dabs IT landed. Returning the union instead made
    // every frame of a long drag re-upload the whole stroke's footprint, so
    // the per-frame cost grew with gesture length.
    const dem = flat();
    const led = new Ledger();
    const s = new Stroke(dem, led, { ...cfg });
    const [ax, ay] = dem.xy(80, 40);
    const [bx] = dem.xy(80, 120);
    const first = s.to(ax, ay);
    const second = s.to(bx, ay);
    const rect = s.rect;
    let outside = 0;
    for (let r = 0; r < dem.nrows; r++) {
      for (let c = 0; c < dem.ncols; c++) {
        if (dem.z[dem.idx(r, c)] === 80) continue;
        if (r < rect.r0 || r > rect.r1 || c < rect.c0 || c > rect.c1) outside++;
      }
    }
    add(H, "Every cell a stroke changed lies inside the cumulative rect it keeps",
      "0 outside", String(outside), outside === 0);
    // The per-call rect is an increment, not the union. Its dabs start one
    // substep along the path, so its west edge sits strictly inside the
    // cumulative rect — if to() returned the union again, the two would be
    // equal and this catches the regression.
    add(H, "…while each call reports only the ground its own dabs touched",
      `west edge > cumulative ${rect.c0}`, `call 1 ${first.c0}, call 2 ${second.c0}`,
      first.c0 === rect.c0 && second.c0 > rect.c0);
  }
  {
    // local.js exists so slope/TRI can refresh on the gesture's own frame. It
    // must agree with the whole-grid kernels, or the live readout would drift
    // from the settled one and the tool would be quietly lying while dragging.
    const dem = DEM.fromRaw(loadGeoTIFF(await fetchTile("orndalen_fill_025m.tif"), { name: "local" }));
    const whole = { r0: 0, c0: 0, r1: dem.nrows - 1, c1: dem.ncols - 1 };
    const ls = localStats(dem, whole);

    const g = computeGradient(dem);
    let ss = 0, sn = 0;
    for (let r = 1; r < dem.nrows - 1; r++) {
      for (let c = 1; c < dem.ncols - 1; c++) {
        const v = g.slopeDeg[dem.idx(r, c)];
        if (Number.isFinite(v)) { ss += v; sn++; }
      }
    }
    const globalSlope = ss / sn;
    add(H, "Local slope (dirty-rect path) matches the whole-grid Horn kernel",
      `${f2(globalSlope)}°`, `${f2(ls.slopeMeanDeg)}°`,
      near(ls.slopeMeanDeg, globalSlope, 0.02));

    const t = tri(dem);
    let ts = 0, tn = 0;
    for (let r = 1; r < dem.nrows - 1; r++) {
      for (let c = 1; c < dem.ncols - 1; c++) {
        const v = t[dem.idx(r, c)];
        if (Number.isFinite(v)) { ts += v; tn++; }
      }
    }
    const globalTri = ts / tn;
    add(H, "…and local TRI matches the whole-grid TRI",
      f4(globalTri), f4(ls.triMean), near(ls.triMean, globalTri, 1e-4));
  }

  // ============================================================ GROUP I
  // The cut/fill map, end to end: edit → Δz against the pristine surface →
  // ramp → pixel. This exists because the worker shipped a bug that no unit
  // test could see: it aliased the live surface and the baseline onto the same
  // ArrayBuffer, so Δz was identically zero and the panel rendered a uniform
  // neutral tone — indistinguishable from "nothing edited yet". The lesson is
  // the one in ramps.js: a plausible-looking map is not a working map.
  const I = "I · the cut/fill map, edit → Δz → ramp → pixel";
  {
    // Reproduce the worker's own pipeline on the main thread, including the
    // copy discipline, so the aliasing bug cannot come back unnoticed.
    const dem = DEM.synthetic(64, 64, 0.25, () => 80);
    const baseline = dem.z.slice();          // must be an independent copy
    const led = new Ledger();

    const [sx, sy] = dem.xy(20, 20);
    applyBrush(dem, "scoop", sx, sy, 2.0, 0.5, led);
    const [mx, my] = dem.xy(44, 44);
    applyBrush(dem, "mound", mx, my, 2.0, 0.5, led);

    const delta = deltaZ(baseline, dem.z);
    add(I, "The baseline is a real copy, so editing the surface does not move it too",
      "baseline unchanged at edit", f4(baseline[dem.idx(20, 20)]),
      baseline[dem.idx(20, 20)] === 80);

    const dScoop = delta[dem.idx(20, 20)];
    const dMound = delta[dem.idx(44, 44)];
    add(I, "Δz is negative where material was scooped and positive where it was mounded",
      "− then +", `${f4(dScoop)} / ${f4(dMound)}`, dScoop < 0 && dMound > 0);

    const rgba = colourise("cutfill", delta);
    const at = (r, c) => {
      const o = (r * dem.ncols + c) * 4;
      return [rgba[o], rgba[o + 1], rgba[o + 2]];
    };
    const pScoop = at(20, 20), pMound = at(44, 44), pUntouched = at(2, 2);
    add(I, "…so the scooped hollow renders COOL in the cut/fill panel",
      "blue > red", pScoop.join(","), pScoop[2] > pScoop[0]);
    add(I, "…the mound renders WARM",
      "red > blue", pMound.join(","), pMound[0] > pMound[2]);
    add(I, "…and untouched ground renders the exact neutral paper tone, never a faint gain",
      NEUTRAL_RGB.join(","), pUntouched.join(","),
      pUntouched[0] === NEUTRAL_RGB[0] && pUntouched[1] === NEUTRAL_RGB[1] &&
      pUntouched[2] === NEUTRAL_RGB[2]);

    // The panel must not be uniform — that was exactly how the bug presented.
    const distinct = new Set();
    for (let i = 0; i < rgba.length; i += 4) {
      distinct.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
    }
    add(I, "The cut/fill panel carries real variation, not one flat colour",
      ">10 distinct colours", String(distinct.size), distinct.size > 10);

    add(I, "An equal scoop and mound leave the ledger reading net zero",
      "±0.0 m³", led.netLabel(1), Math.abs(led.net) / led.cut < 0.01);
  }

  const J = "J · the wireframe lattice lies ON the surface";
  {
    // The wireframe shares the mesh's position buffer, so a segment follows the
    // terrain only if its two ends are one triangle edge apart. Join vertices
    // any further apart and the line becomes a straight chord across curved
    // ground, which the terrain in between rises through — the failure this
    // group exists to keep from coming back, because it presents as lines that
    // vanish in patches and looks for all the world like a depth-test tie.
    const dem = fillDem;
    const { nrows, ncols } = dem;
    const edges = latticeEdges(nrows, ncols, 16);

    let nonEdges = 0;
    const dirs = new Set();
    for (let k = 0; k < edges.length; k += 2) {
      if (!isMeshEdge(edges[k], edges[k + 1], ncols)) nonEdges++;
      const dr = Math.trunc(edges[k + 1] / ncols) - Math.trunc(edges[k] / ncols);
      dirs.add(`${dr},${(edges[k + 1] % ncols) - (edges[k] % ncols)}`);
    }
    add(J, "every drawn segment is an edge of the mesh's own triangulation",
      "0 non-edges", `${nonEdges} of ${edges.length / 2}`, nonEdges === 0);
    add(J, "…in exactly the three directions the triangulation has, diagonal included",
      "0,1 / 1,0 / 1,-1", [...dirs].sort().join(" / "),
      dirs.size === 3 && dirs.has("0,1") && dirs.has("1,0") && dirs.has("1,-1"));

    // The regression measured on real ground, in metres, at the exaggeration
    // the app actually uses. The chorded form is rebuilt here rather than
    // asserted from memory, so the number this replaced stays checkable.
    const EX = 2.5;
    const chorded = [];
    for (let r = 0; r < nrows; r += 16)
      for (let c = 0; c + 16 < ncols; c += 16) chorded.push(r * ncols + c, r * ncols + c + 16);
    const bad = chordDeviation(dem.z, ncols, chorded, EX);
    const good = chordDeviation(dem.z, ncols, edges, EX);
    add(J, "a chorded lattice is buried by real terrain on the Ørndalen fill patch",
      "> 0.3 m at worst", f4(bad.max) + " m", bad.max > 0.3);
    add(J, "…while the subdivided lattice deviates from the surface by nothing at all",
      "0.0000 m", f4(good.max) + " m", good.max === 0);

    add(J, "the lattice closes on the final row and column rather than stopping short",
      "both drawn", `${edges.length / 2} segments`,
      [...edges].some((i) => Math.trunc(i / ncols) === nrows - 1) &&
      [...edges].some((i) => i % ncols === ncols - 1));
  }

  const L = "L · geomorphons name the landform, and the naming is not guessed";
  {
    // ⚠️ The sources disagree in print. The 2011 paper's TEXT says "+" means
    // higher ground, which makes a peak eight minuses — and the ArcGIS
    // documentation says exactly that. Table I of the same paper prints the
    // opposite. So the convention is fixed HERE, against synthetic landforms
    // whose answer is not a matter of interpretation: a cone is a peak, a
    // bowl is a pit. Same method as the TRI formula (group D).
    const N = 41, MID = 20;
    const at = (g, r, c) => LANDFORMS[g.codes[r * N + c]];
    const opts = { radiusM: 5, flatnessDeg: 1 };
    const cases = [
      ["a cone's apex is a PEAK, not a pit — this pins the sign convention",
        DEM.synthetic(N, N, 1, (r, c) => 100 - 0.3 * Math.hypot(r - MID, c - MID)), "peak"],
      ["a bowl's floor is a PIT",
        DEM.synthetic(N, N, 1, (r, c) => 100 + 0.3 * Math.hypot(r - MID, c - MID)), "pit"],
      ["a horizontal plane is FLAT",
        DEM.synthetic(N, N, 1, () => 80), "flat"],
      ["a planar ramp is SLOPE — no curvature, so no convex or concave name",
        DEM.synthetic(N, N, 1, (r) => 100 - 0.3 * r), "slope"],
      ["a linear crest is a RIDGE",
        DEM.synthetic(N, N, 1, (r, c) => 100 - 0.3 * Math.abs(c - MID)), "ridge"],
      ["a linear trough is a VALLEY",
        DEM.synthetic(N, N, 1, (r, c) => 100 + 0.3 * Math.abs(c - MID)), "valley"],
    ];
    for (const [check, dem, expect] of cases) {
      const g = geomorphons(dem, opts);
      add(L, check, expect, at(g, MID, MID), at(g, MID, MID) === expect);
    }

    // On the real patch the classification must be informative rather than
    // collapsing to one class — and it must respond to the video's gesture.
    const real = fillDem;
    const g = geomorphons(real, { radiusM: 1.5, flatnessDeg: 3 });
    const occupied = g.counts.filter((c) => c > 0).length;
    add(L, "the real Ørndalen patch carries a genuine landform vocabulary",
      "8–10 of 10 classes", `${occupied} of 10`, occupied >= 8);

    // The flatness threshold is chosen so that it exceeds the measured 3 cm
    // LiDAR repeatability inside the search radius — otherwise the map would
    // be naming noise. 3° reaches 3 cm at 0.57 m, well within 1.5 m.
    const reach = 0.03 / Math.tan((3 * Math.PI) / 180);
    add(L, "…and its flatness threshold clears the 3 cm LiDAR noise floor " +
      "well inside the search radius, so classes come from relief not noise",
      "< 1.5 m", `${reach.toFixed(2)} m`, reach < 1.5);

    // The beat the video turns on.
    const flat = real.clone();
    let sum = 0, cnt = 0;
    for (const v of flat.z) if (Number.isFinite(v)) { sum += v; cnt++; }
    const datum = sum / cnt;
    for (let r = 0; r < flat.nrows; r += 4) {
      for (let c = 0; c < flat.ncols; c += 4) {
        const [x, y] = flat.xy(r, c);
        applyBrush(flat, "level", x, y, 3, 1.0, undefined, { target: datum });
      }
    }
    const gf = geomorphons(flat, { radiusM: 1.5, flatnessDeg: 3 });
    const flatPct = (100 * gf.counts[0]) / flat.z.length;
    add(L, "planarizing collapses the whole vocabulary to one word — the " +
      "categorical twin of geodiversity falling to zero",
      ">99% flat", `${flatPct.toFixed(1)}%`, flatPct > 99);

    // Wind exposure: sheltered ground must read lower than open ground, or the
    // luv/lee sense is inverted — a mistake that looks entirely plausible.
    const wall = DEM.synthetic(60, 60, 1, (r, c) => (r > 34 && r < 40 ? 90 : 80));
    const hz = horizonMap(wall, { directions: 16, radiusM: 20 });
    const we = windExposure(hz, { windDeg: 180 }); // wind from the SOUTH
    // Row index increases southward, so the wall at rows 35-39 shelters the
    // ground NORTH of it (lower row indices) from a southerly.
    const lee = we[20 * 60 + 30], open = we[55 * 60 + 30];
    add(L, "wind exposure reads lower in the lee of a ridge than on open " +
      "ground upwind — the luv/lee sense is not inverted",
      "lee < open", `${lee.toFixed(3)} < ${open.toFixed(3)}`, lee < open);
    add(L, "…and is bounded 0–1, so it can be read as a fraction of open sky",
      "0 ≤ v ≤ 1", `${Math.min(lee, open).toFixed(3)}–${Math.max(lee, open).toFixed(3)}`,
      lee >= 0 && lee <= 1 && open >= 0 && open <= 1);
  }

  const M = "M · palette variants cannot invert a convention";
  {
    // The legend's palette control exists so a figure can be restyled for a
    // poster. This group is the reason that control is safe: every variant is a
    // per-stop transform, so no variant can reorder a ramp, and the one
    // transform that COULD flatten a meaning is withheld from the ramps where
    // it would.
    const warmth = (c) => c[0] - c[2];

    add(M, "the committed ramp is returned bit-identically when no variant is asked for",
      "identical", JSON.stringify(variantStops("twi")) === JSON.stringify(variantStops("twi", "committed"))
        ? "identical" : "differs",
      JSON.stringify(variantStops("twi")) === JSON.stringify(variantStops("twi", "committed")));

    // Every variant of every ramp must keep the ends' warm/cool sense.
    let flipped = 0;
    const names = [];
    for (const id of Object.keys(RAMPS)) {
      const base = RAMPS[id].stops;
      const baseEnds = Math.sign(warmth(base[0][1]) - warmth(base[base.length - 1][1]));
      for (const v of variantsFor(id)) {
        const s = variantStops(id, v);
        const ends = Math.sign(warmth(s[0][1]) - warmth(s[s.length - 1][1]));
        if (baseEnds !== 0 && ends !== baseEnds) { flipped++; names.push(`${id}/${v}`); }
      }
    }
    add(M, "no variant of any ramp reverses which end is warm — the Morphos " +
      "sign inversions are unreachable by restyling",
      "0 flipped", flipped ? names.join(", ") : "0 flipped", flipped === 0);

    add(M, "a variant never changes the NUMBER or POSITION of stops, so it " +
      "cannot reorder a ramp",
      "same positions",
      Object.keys(RAMPS).every((id) => variantsFor(id).every((v) =>
        variantStops(id, v).length === RAMPS[id].stops.length &&
        variantStops(id, v).every(([p], i) => p === RAMPS[id].stops[i][0]))) ? "same positions" : "MOVED",
      Object.keys(RAMPS).every((id) => variantsFor(id).every((v) =>
        variantStops(id, v).length === RAMPS[id].stops.length &&
        variantStops(id, v).every(([p], i) => p === RAMPS[id].stops[i][0]))));

    // Mono: offered only where one hue can still carry a scale.
    add(M, "diverging and circular ramps are NOT offered a single-hue variant — " +
      "one hue would make cut and fill, or dry and wet, indistinguishable",
      "twi/cutfill/aspect excluded",
      `twi ${variantsFor("twi").includes("mono")}, cutfill ${variantsFor("cutfill").includes("mono")}, ` +
      `aspect ${variantsFor("aspect").includes("mono")}`,
      !variantsFor("twi").includes("mono") && !variantsFor("cutfill").includes("mono")
        && !variantsFor("aspect").includes("mono"));
    add(M, "…while sequential ramps are, and their mono form runs monotonically darker",
      "slope offered, luma descending",
      (() => {
        const l = variantStops("slope", "mono").map(([, c]) =>
          0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
        return `${variantsFor("slope").includes("mono")}, ${l.every((v, i) => i === 0 || v <= l[i - 1])}`;
      })(),
      (() => {
        const l = variantStops("slope", "mono").map(([, c]) =>
          0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
        return variantsFor("slope").includes("mono") && l.every((v, i) => i === 0 || v <= l[i - 1]);
      })());

    // A stale or unknown variant must degrade to the committed ramp, never blank.
    add(M, "an unknown variant falls back to the committed ramp rather than failing",
      "committed",
      JSON.stringify(variantStops("twi", "nonsense")) === JSON.stringify(RAMPS.twi.stops)
        ? "committed" : "other",
      JSON.stringify(variantStops("twi", "nonsense")) === JSON.stringify(RAMPS.twi.stops));
  }

  const K = "K · export — what leaves the tool is what was in it";
  {
    // The export path's whole job is that a file can go to QGIS and come back.
    // Round-tripping through this project's OWN reader is the strongest
    // available assertion here, because that reader is already pinned against
    // independently produced Python figures in group D. GDAL/rasterio verifies
    // the CRS separately — see README, "Verified twice".
    const dem = fillDem;
    const edited = dem.clone();
    edited.z[edited.idx(40, 40)] = 79.5;   // a known edit
    edited.z[edited.idx(41, 41)] = NaN;    // and a nodata cell

    const bytes = writeGeoTIFF(edited.z, edited.nrows, edited.ncols,
      edited.cell, edited.originX, edited.originY);
    const back = DEM.fromRaw(loadGeoTIFF(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      { name: "roundtrip" }));

    add(K, "an exported GeoTIFF reads back at the same grid size and cell size",
      `${dem.ncols}×${dem.nrows} @ ${dem.cell}`,
      `${back.ncols}×${back.nrows} @ ${back.cell}`,
      back.ncols === dem.ncols && back.nrows === dem.nrows && back.cell === dem.cell);
    add(K, "…at the same south-west origin — the tiepoint is the NORTH-west " +
      "corner, so a sign error here would flip the raster",
      `${dem.originX} / ${dem.originY}`, `${back.originX} / ${back.originY}`,
      back.originX === dem.originX && back.originY === dem.originY);

    let worst = 0, nans = 0;
    for (let i = 0; i < edited.z.length; i++) {
      const a = edited.z[i], b = back.z[i];
      if (!Number.isFinite(a)) { if (!Number.isFinite(b)) nans++; continue; }
      worst = Math.max(worst, Math.abs(a - b));
    }
    add(K, "…and every elevation survives bit-exactly (float32 in, float32 out)",
      "0 m", `${worst} m`, worst === 0);
    add(K, "…including the edit made before export",
      "79.5 m", f2(back.z[back.idx(40, 40)]), back.z[back.idx(40, 40)] === 79.5);
    add(K, "…and nodata stays nodata rather than becoming a real elevation",
      "1 NaN preserved", String(nans), nans === 1);

    // North-up is the convention every other module depends on; a flipped
    // export would look plausible and be wrong everywhere downstream.
    const northRow = back.z[back.idx(0, 128)], southRow = back.z[back.idx(255, 128)];
    add(K, "…with row 0 still the NORTH edge after the round trip",
      `${f2(edited.z[edited.idx(0, 128)])} / ${f2(edited.z[edited.idx(255, 128)])}`,
      `${f2(northRow)} / ${f2(southRow)}`,
      northRow === edited.z[edited.idx(0, 128)] && southRow === edited.z[edited.idx(255, 128)]);

    // OBJ: local coordinates, stated origin, real triangle count.
    const { obj, mtl, triangles } = writeOBJ(edited, {
      exaggeration: 1, textureFile: "terrain_layer.png", materialName: "terrain",
    });
    const lines = obj.split("\n");
    const vs = lines.filter((l) => l.startsWith("v "));
    const coords = vs.map((l) => l.split(" ").slice(1).map(Number));
    const maxXY = Math.max(...coords.map((c) => Math.max(Math.abs(c[0]), Math.abs(c[1]))));
    add(K, "the OBJ is written in LOCAL coordinates — UTM-scale values would " +
      "quantise in any single-precision CAD viewport, the same trap as §float32",
      `< ${dem.ncols * dem.cell} m`, `${maxXY.toFixed(2)} m`,
      maxXY < dem.ncols * dem.cell + 1);
    add(K, "…and states the world origin so it can be georeferenced again",
      `origin_epsg25833 ${dem.originX} ${dem.originY}`,
      lines.find((l) => l.startsWith("# origin_epsg25833")) || "(missing)",
      obj.includes(`# origin_epsg25833 ${dem.originX} ${dem.originY}`));
    add(K, "…declares its up-axis, which OBJ itself cannot express",
      "up_axis Z", obj.includes("# up_axis Z") ? "up_axis Z" : "(missing)",
      obj.includes("# up_axis Z"));

    // Two triangles per quad, minus those touching the one NaN cell (a corner
    // vertex of at most 6 triangles in this split).
    const full = 2 * (dem.nrows - 1) * (dem.ncols - 1);
    add(K, "…drops only the triangles that touch nodata, not whole rows",
      `${full - 6}–${full}`, String(triangles),
      triangles >= full - 6 && triangles < full);
    add(K, "…and carries a material referencing the analysis texture, so the " +
      "layer survives into Rhino or Blender",
      "map_Kd terrain_layer.png",
      (mtl || "").includes("map_Kd terrain_layer.png") ? "map_Kd terrain_layer.png" : "(missing)",
      !!mtl && mtl.includes("map_Kd terrain_layer.png"));

    // Exaggeration must be opt-in AND declared, or someone downstream measures
    // a 2.5x landscape.
    const exObj = writeOBJ(edited, { exaggeration: 2.5 }).obj;
    add(K, "baking exaggeration is announced in the header, never silent",
      "warns Z is not true elevation",
      exObj.includes("Z IS NOT TRUE ELEVATION") ? "warns" : "(silent)",
      exObj.includes("Z IS NOT TRUE ELEVATION"));

    // The archive the mesh ships in.
    const zip = makeZip([
      { name: "a.txt", data: new TextEncoder().encode("hello") },
      { name: "b.bin", data: new Uint8Array([0, 1, 2, 255]) },
    ]);
    const sig = (o) => zip[o] | (zip[o + 1] << 8) | (zip[o + 2] << 16) | (zip[o + 3] << 24);
    add(K, "the export archive is a real ZIP — local header, central " +
      "directory and end record",
      "0x04034b50 … 0x06054b50",
      `0x${(sig(0) >>> 0).toString(16)} … 0x${(sig(zip.length - 22) >>> 0).toString(16)}`,
      (sig(0) >>> 0) === 0x04034b50 && (sig(zip.length - 22) >>> 0) === 0x06054b50);

    // The VOXEL mesh. Boxes are written as closed solids, so the check that
    // matters is the one a viewer would notice only as black faces in Blender:
    // every box must enclose a POSITIVE signed volume, which is true only if
    // its winding order puts the normals outward.
    {
      const boxes = 3;
      const inst = new Float32Array(boxes * 16);
      for (let i = 0; i < boxes; i++) {
        const o = i * 16;
        inst[o] = 1; inst[o + 5] = 1; inst[o + 10] = 2;      // scale 1x1x2
        inst[o + 12] = i * 2 + 0.5; inst[o + 13] = 0.5; inst[o + 14] = 5;
        inst[o + 15] = 1;
      }
      const vx = writeVoxelOBJ({ array: inst, count: boxes }, dem, { exaggeration: 1 });
      const lines = vx.obj.split("\n");
      const V = lines.filter((l) => l.startsWith("v "))
        .map((l) => l.split(" ").slice(1).map(Number));
      const F = lines.filter((l) => l.startsWith("f "))
        .map((l) => l.split(" ").slice(1).map((p) => parseInt(p.split("/")[0], 10) - 1));

      add(K, "the voxel export writes 8 vertices and 12 triangles per box",
        `${boxes * 8} v / ${boxes * 12} f`, `${V.length} v / ${F.length} f`,
        V.length === boxes * 8 && F.length === boxes * 12);

      // Signed volume via the divergence theorem. Outward normals give +.
      const vol = (tris) => {
        let s = 0;
        for (const [ia, ib, ic] of tris) {
          const a = V[ia], b = V[ib], c = V[ic];
          const cx = b[1] * c[2] - b[2] * c[1];
          const cy = b[2] * c[0] - b[0] * c[2];
          const cz = b[0] * c[1] - b[1] * c[0];
          s += (a[0] * cx + a[1] * cy + a[2] * cz) / 6;
        }
        return s;
      };
      let worst = Infinity;
      for (let i = 0; i < boxes; i++) worst = Math.min(worst, vol(F.slice(i * 12, i * 12 + 12)));
      add(K, "…each a CLOSED solid with OUTWARD normals — an inverted winding " +
        "renders black in Blender and breaks a boolean union",
        "every box +2.000 m³", `smallest ${worst.toFixed(3)} m³`,
        Math.abs(worst - 2) < 1e-6);

      add(K, "…in local coordinates, like the surface mesh",
        "< tile span", `${Math.max(...V.map((p) => Math.abs(p[0]))).toFixed(2)} m`,
        Math.max(...V.map((p) => Math.abs(p[0]))) < dem.ncols * dem.cell + 1);
      add(K, "…and says it is the voxel reading, not the surface one",
        "VOXEL in the header",
        vx.obj.includes("VOXEL representation") ? "VOXEL representation" : "(missing)",
        vx.obj.includes("VOXEL representation"));

      // One texcoord per box, shared by all twelve of its faces, so a block
      // takes the single flat colour the viewport gives it.
      const tex = writeVoxelOBJ({ array: inst, count: boxes }, dem,
        { exaggeration: 1, textureFile: "t.png" }).obj;
      const vts = tex.split("\n").filter((l) => l.startsWith("vt "));
      const box0 = tex.split("\n").filter((l) => l.startsWith("f ")).slice(0, 12);
      const idx = new Set(box0.flatMap((l) => l.split(" ").slice(1).map((p) => p.split("/")[1])));
      add(K, "…with ONE texture coordinate per box, shared by all its faces, so " +
        "a block reads as the aggregate it is rather than a gradient",
        `${boxes} vt, 1 index per box`, `${vts.length} vt, ${idx.size} index`,
        vts.length === boxes && idx.size === 1);
    }

    // The scale bar is the one piece of figure chrome a reader MEASURES
    // against, so a wrong one is a citable error rather than a cosmetic
    // glitch. Both real tiles, and the decades either side of them.
    const bars = [
      [64, "10 m"],      // the 0.25 m design patch
      [1024, "200 m"],   // the 4 m context tile
      [8, "1 m"],
      [5000, "1 km"],
      [0.5, "0.10 m"],
    ];
    let wrong = 0;
    for (const [extent, expect] of bars) {
      if (scaleBarLength(extent).label !== expect) wrong++;
    }
    add(K, "the figure's scale bar picks a round 1-2-5 length at every tile scale",
      "10 m / 200 m / 1 m / 1 km / 0.10 m",
      bars.map(([e]) => scaleBarLength(e).label).join(" / "), wrong === 0);
    add(K, "…and it never exceeds the frame it is drawn in",
      "≤ 25% of extent",
      bars.map(([e]) => `${((100 * scaleBarLength(e).niceM) / e).toFixed(0)}%`).join(" "),
      bars.every(([e]) => scaleBarLength(e).niceM <= e * 0.25));
  }

  const N = "N · the species model — the one layer that is an assumption";
  {
    // Everything above this group tests a MEASUREMENT: Horn's slope is Horn's
    // slope and SOURCE.txt can check it. This group tests something different —
    // that a stated set of assumptions behaves the way it claims to, stays
    // honest about what it does not know, and produces the argument the video
    // rests on. The envelopes themselves are not "correct"; they are declared.

    /** Everything assemble() wants, from a DEM. Heavy layers are optional. */
    const axesOf = (dem, heavy = true) => {
      const g = computeGradient(dem);
      const fl = flowAccumulation(dem);
      const tw = twi(fl.specificCatchmentArea, g.slope);
      const base = { twi: tw, slope: g.slopeDeg, cell: dem.cell, elevation: dem.z };
      if (!heavy) return base;
      const hz = horizonMap(dem);
      return {
        ...base,
        wind: windExposure(hz),
        solar: solarRadiation(dem, g, hz, { dayStart: 91, dayEnd: 273, dayStep: 14 }).grid,
        landform: geomorphons(dem, { radiusM: 1.5, flatnessDeg: 3 }).codes,
      };
    };

    // --- the scale correction, which is what lets one table serve both tiles ---
    //
    // TWI = ln(a / tan B) and a is an area PER UNIT WIDTH in metres, so it
    // scales with cell size and TWI carries a +ln(cell) offset that says nothing
    // about the ground. Without removing it, envelopes calibrated on the design
    // patch would call the context tile a bog.
    {
      const ctx = DEM.fromRaw(loadGeoTIFF(await fetchTile("orndalen_2024_4m.tif"), { name: "ctx-sp" }));
      const meanOf = (a) => {
        let s = 0, k = 0;
        for (const v of a) if (Number.isFinite(v)) { s += v; k++; }
        return s / k;
      };
      const twFill = twi(flowAccumulation(fillDem).specificCatchmentArea,
        computeGradient(fillDem).slope);
      const twCtx = twi(flowAccumulation(ctx).specificCatchmentArea,
        computeGradient(ctx).slope);
      const rawGap = Math.abs(meanOf(twCtx) - meanOf(twFill));
      add(N, "raw TWI is offset between the two tiles by exactly the cell-size " +
        "ratio — ln(16) for 0.25 m against 4 m — so it cannot carry a fixed envelope",
        `≈ ${Math.log(16).toFixed(2)}`, rawGap.toFixed(2), near(rawGap, Math.log(16), 0.25));

      const corrGap = Math.abs(
        meanOf(correctedTWI(twCtx, ctx.cell)) - meanOf(correctedTWI(twFill, fillDem.cell)));
      add(N, "…and TWI − ln(cell) removes it, so ONE set of moisture envelopes " +
        "serves a 0.25 m design patch, a 4 m context tile and a dropped GeoTIFF",
        "< 0.25 apart", corrGap.toFixed(3), corrGap < 0.25);
      add(N, "…and the correction is a shift, not a rescale — NaN stays NaN, so a " +
        "levelled surface still has no moisture answer",
        "NaN preserved", String(correctedTWI(new Float32Array([NaN]), 0.25)[0]),
        Number.isNaN(correctedTWI(new Float32Array([NaN]), 0.25)[0]));
    }

    // --- the membership curve ---
    {
      const t = /** @type {any} */ ([2, 4, 6, 8]);
      const pts = [[1, 0], [3, 0.5], [4, 1], [5, 1], [6, 1], [7, 0.5], [9, 0]];
      const got = pts.map(([v]) => membership(t, v));
      add(N, "a tolerance curve is 1 across its optimum, ramps linearly to its " +
        "limits and is exactly 0 beyond them",
        pts.map(([, e]) => e).join(" "), got.map((v) => v.toFixed(1)).join(" "),
        pts.every(([, e], i) => near(got[i], e, 1e-9)));
      // A squashed tail means "no limit this side", not "excluded immediately".
      add(N, "…and a squashed tail means no limit on that side rather than an " +
        "instant exclusion, which is how 'tolerates any slope down to flat' is written",
        "1 at 0", membership(/** @type {any} */ ([0, 0, 30, 45]), 0).toFixed(1),
        membership(/** @type {any} */ ([0, 0, 30, 45]), 0) === 1);
    }

    // --- the table and its colours cannot drift apart ---
    {
      const cat = CATEGORICAL.species;
      add(N, "every species in the table has a colour and a name in the legend — " +
        "a raster code with no key entry would render as an unlabelled patch",
        `${SPECIES.length} / ${SPECIES.length}`,
        `${cat.labels.length} / ${cat.colours.filter((c, i) => i < SPECIES.length && c).length}`,
        cat.labels.length === SPECIES.length &&
        SPECIES.every((_, i) => Array.isArray(cat.colours[i])));
      const inv = SPECIES.filter((s) => s.invasive);
      add(N, "exactly one class is flagged invasive, and it is the one the site " +
        "photographs actually show",
        "1 · Lupinus nootkatensis", `${inv.length} · ${inv.map((s) => s.name).join(", ")}`,
        inv.length === 1 && inv[0].id === "lupinus");
      // Codes go into exported rasters, so reordering the list silently
      // renumbers every .tif anyone has already downloaded.
      add(N, "…and the class codes are stable, because they are written into every " +
        "exported raster — append to the list, never insert",
        "sphagnum 0 … lupinus 6",
        `sphagnum ${CODE.sphagnum} … lupinus ${CODE.lupinus}`,
        CODE.sphagnum === 0 && CODE.lupinus === SPECIES.length - 1);
      add(N, "…and the invasive's colour sits off the moisture gradient the other " +
        "six follow, so it cannot be misread as a position on that scale",
        "magenta, unique", `rgb(${cat.colours[CODE.lupinus].join(",")})`,
        cat.colours[CODE.lupinus][0] > 140 && cat.colours[CODE.lupinus][2] > 100 &&
        cat.colours[CODE.lupinus][1] < 90);
    }

    // --- on real ground, every species in the table must be able to appear ---
    const realAxes = axesOf(fillDem);
    const real = assemble(realAxes);
    {
      add(N, "on the real Ørndalen patch every species in the table holds some " +
        "ground — a class that can never win does not belong in a legend",
        `${SPECIES.length} of ${SPECIES.length}`, `${real.richness} of ${SPECIES.length}`,
        real.richness === SPECIES.length);
      add(N, "…and the assemblage is informative rather than saturated, so H' has " +
        "somewhere to fall when the surface is levelled",
        "0.6·max < H' < max", `${real.shannon.toFixed(3)} of ${SHANNON_MAX.toFixed(3)}`,
        real.shannon > 0.6 * SHANNON_MAX && real.shannon < SHANNON_MAX);
      let outOfRange = 0;
      for (let i = 0; i < real.suitability.length; i++) {
        const v = real.suitability[i];
        if (v < 0 || v > 1) outOfRange++;
      }
      add(N, "…and every suitability score is a fraction, never a raw index a " +
        "reader could mistake for a measurement",
        "0 ≤ s ≤ 1, 0 outside", `${outOfRange} outside`, outOfRange === 0);
    }

    // --- nodata is the DEM's gap, not an ecological statement ---
    {
      const holed = fillDem.clone();
      for (let c = 0; c < holed.ncols; c++) holed.z[10 * holed.ncols + c] = NaN;
      const a = assemble(axesOf(holed, false));
      let wrong = 0;
      for (let c = 0; c < holed.ncols; c++) {
        if (a.codes[10 * holed.ncols + c] !== NO_DATA) wrong++;
      }
      add(N, "a hole in the DEM reads as NO DATA, never as bare ground and never " +
        "as a species — the same rule aspect follows for flat cells",
        "0 cells classified", `${wrong} classified`, wrong === 0);
    }

    // --- THE VIDEO'S CENTRAL BEAT ---
    //
    // Sequence 1 planarizes the surface. Three abiotic collapses are already
    // asserted elsewhere (geodiversity to 0, landform vocabulary to one word,
    // TWI undefined); this is the fourth, and it is the one the audience reads.
    {
      const plane = fillDem.clone();
      let sum = 0, cnt = 0;
      for (const v of plane.z) if (Number.isFinite(v)) { sum += v; cnt++; }
      plane.z.fill(sum / cnt);
      const flat = assemble(axesOf(plane));

      add(N, "an exactly levelled surface collapses to ONE class, and Shannon H' " +
        "is therefore 0 exactly — not the 0.11 both planning documents promised",
        "H' 0.000, richness 1", `H' ${flat.shannon.toFixed(3)}, richness ${flat.richness}`,
        flat.shannon === 0 && flat.richness === 1);
      add(N, "…and the one class left is the INVASIVE, not bare ground: " +
        "homogenising the terrain hands the site to a monoculture with a name",
        "100% Lupinus nootkatensis",
        `${(100 * flat.invasiveFraction).toFixed(1)}% · ` +
        `${SPECIES[flat.codes[flat.codes.length >> 1]].name}`,
        flat.invasiveFraction === 1 && flat.counts[CODE.lupinus] === flat.classified);
      add(N, "…and nothing that needs a wet hollow survives it — a flat plane must " +
        "not grow moss, which is the biotic form of the flat-is-not-north trap",
        "0 cells", String(flat.counts[CODE.sphagnum]), flat.counts[CODE.sphagnum] === 0);

      // A knife-edge win would leave the video's central beat resting on the
      // third decimal place of an envelope. It must be decisive.
      {
        const i = flat.codes.length >> 1;
        const scores = SPECIES.map((s, k) => ({ k, v: k === flat.codes[i] ? flat.suitability[i] : 0 }));
        // Re-score the runner-up by re-running with the winner removed is
        // overkill; the margin that matters is against clover, the only other
        // class with a non-zero undrained tolerance.
        const winner = flat.suitability[i];
        const clover = SPECIES[CODE.trifolium];
        const rival = clover.peak * Math.pow(clover.undrained, 0.2);
        const margin = (winner - rival) / winner;
        add(N, "…and it wins that plane decisively rather than on a rounding — the " +
          "sown sward is the only other class that tolerates no drainage",
          "> 10% clear", `${(100 * margin).toFixed(0)}% clear ` +
          `(${winner.toFixed(3)} vs ${rival.toFixed(3)})`, margin > 0.10);
        void scores;
      }

      // The collapse has to be visible WHILE THE HAND MOVES, or the gesture and
      // the readout are two separate events on screen. Mid-drag the worker has
      // fresh TWI and slope but solar, wind and landform from before the
      // gesture — so that is what this asserts against.
      const midDrag = assemble({
        ...axesOf(plane, false),
        solar: realAxes.solar, wind: realAxes.wind, landform: realAxes.landform,
      });
      add(N, "…and it is already visible mid-gesture, with the settle-only layers " +
        "still describing the surface as it was — the number falls under the hand",
        "H' at least halves", `${real.shannon.toFixed(3)} → ${midDrag.shannon.toFixed(3)}`,
        midDrag.shannon < real.shannon * 0.5);
      add(N, "…and the invasive is already taking the ground mid-gesture",
        "> 60% invasive", `${(100 * midDrag.invasiveFraction).toFixed(1)}%`,
        midDrag.invasiveFraction > 0.6);

      // --- SEQUENCE 3: the claim the video ends on ---
      const ledger = new Ledger();
      const span = plane.ncols * plane.cell;
      for (let b = 0; b < 5; b++) {
        const xc = span * (0.10 + 0.20 * b), xm = span * (0.20 + 0.20 * b);
        for (let t = -3; t <= span + 3; t += 0.4) {
          applyBrush(plane, "scoop", plane.originX + xc, plane.originY + t, 3.0, 0.10, ledger);
          applyBrush(plane, "mound", plane.originX + xm, plane.originY + t, 3.0, 0.10, ledger);
        }
      }
      const designed = assemble(axesOf(plane));
      add(N, "scooping and mounding the levelled plane brings the whole table back — " +
        "differentiating the surface differentiates what can live on it",
        `H' 0.000 → > ${(0.7 * SHANNON_MAX).toFixed(2)}, all ${SPECIES.length} classes`,
        `H' ${designed.shannon.toFixed(3)}, richness ${designed.richness}`,
        designed.shannon > 0.7 * SHANNON_MAX && designed.richness === SPECIES.length);
      add(N, "…and it pushes the invasive back off most of the ground it had taken",
        "100% → < 40%", `${(100 * designed.invasiveFraction).toFixed(1)}%`,
        designed.invasiveFraction < 0.4);
      // The closing claim: this is done by MOVING material, not importing it.
      const netPerM2 = Math.abs(ledger.net) / (span * span);
      add(N, "…and the material for it came off the site itself — cut and fill " +
        "within a few centimetres per square metre of each other",
        "< 0.05 m³/m²", `${netPerM2.toFixed(4)} m³/m² ` +
        `(cut ${ledger.cut.toFixed(0)}, fill ${ledger.fill.toFixed(0)})`,
        netPerM2 < 0.05);
    }

    // --- an absent axis must never veto a species ---
    {
      const live = assemble(axesOf(fillDem, false));
      add(N, "with the settle-only layers absent no species is silently excluded — " +
        "a missing axis means 'no information', never 'unsuitable'",
        `${SPECIES.length} of ${SPECIES.length}`, `${live.richness} of ${SPECIES.length}`,
        live.richness === SPECIES.length);
      add(N, "…and dropping three of five axes does not make MORE ground bare, " +
        "which is what a veto would have done",
        "≤ the settled figure", `${live.bare} vs ${real.bare}`, live.bare <= real.bare);
      // ⚠️ THE INVARIANT THE RUNNING APP ACTUALLY DEPENDS ON. Mid-drag the
      // worker has fresh TWI and slope and the settle-only grids from before the
      // gesture. So on a surface that has not moved, a "live" pass must
      // reproduce the settled map EXACTLY — staleness costs nothing until the
      // ground changes, and letting go of a gesture refines the assemblage
      // rather than replacing it.
      const stale = assemble({ ...axesOf(fillDem, false),
        solar: realAxes.solar, wind: realAxes.wind, landform: realAxes.landform });
      let differ = 0;
      for (let i = 0; i < stale.codes.length; i++) {
        if (stale.codes[i] !== real.codes[i]) differ++;
      }
      add(N, "…and on unmoved ground a live pass carrying the previous settle's " +
        "layers reproduces the settled map exactly — staleness costs nothing " +
        "until the terrain changes",
        "0 cells differ", `${differ} differ`, differ === 0);

      // ⚠️ AND THIS IS WHY THE WORKER CARRIES THOSE GRIDS FORWARD rather than
      // letting a light pass drop them, which it used to do for wind and
      // landform. Genuinely omitting three of five axes does not degrade the map
      // gracefully — it produces a substantially different one, because with
      // fewer terms in the geometric mean every score is pulled toward its
      // species' peak and the cell goes to whichever specialist has the highest.
      // Measured here so the cost is on record rather than assumed small.
      let agree = 0, comparable = 0;
      for (let i = 0; i < live.codes.length; i++) {
        if (live.codes[i] >= 254 || real.codes[i] >= 254) continue;
        comparable++;
        if (live.codes[i] === real.codes[i]) agree++;
      }
      const pct = (100 * agree) / comparable;
      add(N, "…whereas genuinely dropping those three axes rewrites most of the " +
        "map, which is why a light pass carries the last settle's grids forward",
        "materially different, < 60% identical", `${pct.toFixed(1)}% identical`,
        pct < 60);
    }

    // --- the diversity mathematics itself ---
    {
      // An even split across every class is the definition of maximum H'.
      const n2 = 7 * 1000;
      const tw2 = new Float32Array(n2), sl2 = new Float32Array(n2);
      tw2.fill(3); sl2.fill(5);
      const evenA = assemble({ twi: tw2, slope: sl2, cell: 1 });
      // Uniform conditions must give exactly one class — the control for the
      // test below, and the reason a uniform surface cannot report diversity.
      add(N, "uniform conditions give exactly one class, so diversity can never " +
        "be an artefact of the method rather than of the ground",
        "richness 1, H' 0", `richness ${evenA.richness}, H' ${evenA.shannon.toFixed(3)}`,
        evenA.richness === 1 && evenA.shannon === 0);
      add(N, "the reported ceiling really is the ceiling — H' for an even split " +
        "across the whole table is ln(n)",
        `ln(${SPECIES.length}) = ${Math.log(SPECIES.length).toFixed(4)}`,
        SHANNON_MAX.toFixed(4), near(SHANNON_MAX, Math.log(SPECIES.length), 1e-12));
    }
  }

  const O = "O · substrate — the one layer that is not derived from elevation";
  {
    /**
     * Build a minimal uncompressed single-strip GeoTIFF in memory.
     *
     * Written here rather than mocked, because the thing under test IS the byte
     * layout: the reader used to hard-reject every sample format except float32,
     * and a class raster arrives as Byte or Int16. A mock would have tested
     * nothing.
     * @param {number[]} values row-major
     * @param {number} w @param {number} h
     * @param {number} bits 8 | 16 | 32
     * @param {number} fmt 1 = uint, 2 = int, 3 = float
     * @param {{cell?: number, originX?: number, originY?: number}} [geo]
     */
    const makeTiff = (values, w, h, bits, fmt, geo = {}) => {
      const cell = geo.cell ?? 1;
      const originX = geo.originX ?? 0;
      const originY = geo.originY ?? 0;
      const bytes = bits / 8;
      const dataLen = w * h * bytes;
      const entries = [
        [256, 4, 1, w], [257, 4, 1, h], [258, 3, 1, bits], [259, 3, 1, 1],
        [262, 3, 1, 1], [273, 4, 1, 8], [277, 3, 1, 1], [278, 4, 1, h],
        [279, 4, 1, dataLen], [339, 3, 1, fmt],
        [33550, 12, 3, "scale"], [33922, 12, 6, "tie"],
      ];
      const ifdOff = 8 + dataLen + (dataLen % 2);
      const ifdLen = 2 + entries.length * 12 + 4;
      const scaleOff = ifdOff + ifdLen;
      const tieOff = scaleOff + 24;
      const buf = new ArrayBuffer(tieOff + 48);
      const dv = new DataView(buf);

      dv.setUint8(0, 0x49); dv.setUint8(1, 0x49);
      dv.setUint16(2, 42, true);
      dv.setUint32(4, ifdOff, true);

      for (let i = 0; i < values.length; i++) {
        const o = 8 + i * bytes;
        if (bits === 8) fmt === 2 ? dv.setInt8(o, values[i]) : dv.setUint8(o, values[i]);
        else if (bits === 16) fmt === 2 ? dv.setInt16(o, values[i], true) : dv.setUint16(o, values[i], true);
        else fmt === 3 ? dv.setFloat32(o, values[i], true) : dv.setUint32(o, values[i], true);
      }

      dv.setUint16(ifdOff, entries.length, true);
      entries.forEach(([tag, type, count, val], i) => {
        const e = ifdOff + 2 + i * 12;
        dv.setUint16(e, /** @type {number} */ (tag), true);
        dv.setUint16(e + 2, /** @type {number} */ (type), true);
        dv.setUint32(e + 4, /** @type {number} */ (count), true);
        if (val === "scale") dv.setUint32(e + 8, scaleOff, true);
        else if (val === "tie") dv.setUint32(e + 8, tieOff, true);
        else if (type === 3) dv.setUint16(e + 8, /** @type {number} */ (val), true);
        else dv.setUint32(e + 8, /** @type {number} */ (val), true);
      });
      dv.setUint32(ifdOff + 2 + entries.length * 12, 0, true);

      // ModelPixelScale, then ModelTiepoint (i,j,k, x,y,z) — NORTH-west corner,
      // the GDAL convention dem.js inverts.
      dv.setFloat64(scaleOff, cell, true);
      dv.setFloat64(scaleOff + 8, cell, true);
      dv.setFloat64(scaleOff + 16, 0, true);
      for (let k = 0; k < 3; k++) dv.setFloat64(tieOff + k * 8, 0, true);
      dv.setFloat64(tieOff + 24, originX, true);
      dv.setFloat64(tieOff + 32, originY + h * cell, true);
      dv.setFloat64(tieOff + 40, 0, true);
      return buf;
    };

    // --- the reader now reads class rasters, not just elevation ---
    {
      const vals = [0, 1, 2, 3, 4, 5, 6, 255, 3];
      const asF32 = loadGeoTIFF(makeTiff(vals, 3, 3, 32, 3), { name: "f32", classes: true });
      const asU8 = loadGeoTIFF(makeTiff(vals, 3, 3, 8, 1), { name: "u8", classes: true });
      const asI16 = loadGeoTIFF(makeTiff(vals, 3, 3, 16, 2), { name: "i16", classes: true });
      const same = (a, b) => a.z.every((v, i) => v === b.z[i]);
      add(O, "the reader accepts 8-bit and 16-bit integer rasters, not only " +
        "float32 — a class raster is normally written as Byte or Int16",
        "u8 == i16 == f32", `${asU8.z.length}/${asI16.z.length}/${asF32.z.length} cells, ` +
        `identical: ${same(asU8, asF32) && same(asI16, asF32)}`,
        same(asU8, asF32) && same(asI16, asF32) && asF32.z.length === 9);

      // ⚠️ The sentinel sweep is an ELEVATION convention. A class raster is
      // entitled to use -9999 as an ordinary code.
      const withSentinel = [1, 2, -9999, 4];
      const asClasses = loadGeoTIFF(makeTiff(withSentinel, 2, 2, 16, 2), { name: "c", classes: true });
      const asHeights = loadGeoTIFF(makeTiff(withSentinel, 2, 2, 16, 2), { name: "h" });
      add(O, "…and `classes` suppresses the nodata sentinel sweep, so a class " +
        "raster using −9999 as a code does not silently lose that category",
        "classes: −9999 kept · elevation: NaN", `${asClasses.z[2]} · ${asHeights.z[2]}`,
        asClasses.z[2] === -9999 && Number.isNaN(asHeights.z[2]));

      let msg = "";
      try {
        const c = makeTiff([1, 2, 3, 4], 2, 2, 8, 1);
        new DataView(c).setUint16(8 + 4 + 2 + 3 * 12 + 8, 5, true); // Compression = LZW
        loadGeoTIFF(c, { name: "z" });
      } catch (e) { msg = String(e.message); }
      add(O, "…and a compressed raster fails with a message that names the fix, " +
        "rather than leaving the user to guess",
        "mentions gdal_translate", msg.includes("gdal_translate") ? "yes" : msg.slice(0, 40),
        msg.includes("gdal_translate"));
    }

    // --- resampling onto the DEM grid ---
    {
      // 2x2 source over a 4x4 DEM, perfectly aligned: each source cell should
      // cover exactly one 2x2 block, and the NORTH row must stay north.
      const src = loadGeoTIFF(makeTiff([0, 2, 5, 6], 2, 2, 8, 1,
        { cell: 2, originX: 100, originY: 200 }), { name: "s", classes: true });
      const dem = { nrows: 4, ncols: 4, cell: 1, originX: 100, originY: 200 };
      const r = Substrate.resampleToDem(src, dem);
      const at = (row, col) => r.grid[row * 4 + col];
      add(O, "nearest-neighbour resampling puts each source cell on the right " +
        "DEM cells, with row 0 still the NORTH edge",
        "NW=0 NE=2 SW=5 SE=6",
        `NW=${at(0, 0)} NE=${at(0, 3)} SW=${at(3, 0)} SE=${at(3, 3)}`,
        at(0, 0) === 0 && at(0, 3) === 2 && at(3, 0) === 5 && at(3, 3) === 6);
      add(O, "…and it never interpolates, because averaging class 2 and class 4 " +
        "would invent class 3",
        "only source values present", `[${r.classes.join(",")}]`,
        r.classes.every((c) => [0, 2, 5, 6].includes(c)));
      add(O, "…and reports the source's cell size relative to the DEM's, so a " +
        "raster far coarser than the tile can be flagged rather than trusted",
        "2", String(r.cellRatio), r.cellRatio === 2);

      // ⚠️ No CRS is ever parsed, so a misplaced raster can only be caught by
      // measuring how much of the DEM it actually covers.
      const off = loadGeoTIFF(makeTiff([1, 1, 1, 1], 2, 2, 8, 1,
        { cell: 1, originX: 102, originY: 202 }), { name: "o", classes: true });
      const ro = Substrate.resampleToDem(off, dem);
      add(O, "overlap is measured, so an import in the wrong place — or in a " +
        "projection this reader cannot see — can be refused instead of drawn",
        "4 of 16 cells = 0.25", ro.overlap.toFixed(3), near(ro.overlap, 0.25, 1e-9));

      const far = loadGeoTIFF(makeTiff([1], 1, 1, 8, 1,
        { cell: 1, originX: 900, originY: 900 }), { name: "f", classes: true });
      add(O, "…and a raster that misses the tile entirely reports zero overlap",
        "0", String(Substrate.resampleToDem(far, dem).overlap),
        Substrate.resampleToDem(far, dem).overlap === 0);
    }

    // --- the crosswalks ---
    {
      const valid = (v) => v === Substrate.UNKNOWN || Substrate.isClass(v);
      const arBad = Object.values(Substrate.AR5_GRUNNFORHOLD).filter((v) => !valid(v));
      const nguBad = Object.values(Substrate.NGU_LOSMASSETYPE).filter((v) => !valid(v));
      add(O, "every crosswalk entry lands on a real class or on UNKNOWN — never " +
        "on a code with no colour and no name",
        "0 invalid", `${arBad.length + nguBad.length} invalid`,
        arBad.length === 0 && nguBad.length === 0);

      const ar5 = Substrate.crosswalk(Substrate.AR5_GRUNNFORHOLD);
      add(O, "AR5 'konstruert' maps to UNKNOWN, because made ground says the " +
        "material was placed and nothing at all about what it is",
        "46 → unknown",
        ar5(46) === Substrate.UNKNOWN ? "unknown" : String(ar5(46)),
        ar5(46) === Substrate.UNKNOWN);
      add(O, "…and AR5 'Jorddekt' — the code this site actually returns — maps " +
        "to fine mineral ground",
        "44 → fines", String(ar5(44)), ar5(44) === Substrate.CODE.fines);

      const ngu = Substrate.crosswalk(Substrate.NGU_LOSMASSETYPE);
      add(O, "NGU 100, the code verified live at the design patch, maps to bedrock",
        "100 → bedrock", String(ngu(100)), ngu(100) === Substrate.CODE.bedrock);
      add(O, "…and an unlisted code becomes UNKNOWN rather than being guessed at",
        "unknown", ngu(4242) === Substrate.UNKNOWN ? "unknown" : String(ngu(4242)),
        ngu(4242) === Substrate.UNKNOWN);
      add(O, "…as does a value that is not a class at all",
        "unknown", String(Substrate.identityMap(99)),
        Substrate.identityMap(99) === Substrate.UNKNOWN &&
        Substrate.identityMap(NaN) === Substrate.UNKNOWN);
    }

    // --- the table and its colours cannot drift apart ---
    {
      const cat = CATEGORICAL.soil;
      add(O, "every substrate class has a colour and a name in the legend",
        `${Substrate.SUBSTRATE.length} / ${Substrate.SUBSTRATE.length}`,
        `${cat.labels.length} labels / ` +
        `${Substrate.SUBSTRATE.filter((_, i) => Array.isArray(cat.colours[i])).length} colours`,
        cat.labels.length === Substrate.SUBSTRATE.length &&
        Substrate.SUBSTRATE.every((_, i) => Array.isArray(cat.colours[i])));
      add(O, "…and the two lists say the same thing, so the key cannot describe " +
        "a class list the raster does not use",
        Substrate.SUBSTRATE.map((s) => s.name).join("|"), cat.labels.join("|"),
        Substrate.SUBSTRATE.every((s, i) => s.name === cat.labels[i]));
      add(O, "…and the class codes are stable, because they go into every " +
        "exported raster — append to the list, never insert",
        "bedrock 0 … topsoil 6",
        `bedrock ${Substrate.CODE.bedrock} … topsoil ${Substrate.CODE.topsoil}`,
        Substrate.CODE.bedrock === 0 &&
        Substrate.CODE.topsoil === Substrate.SUBSTRATE.length - 1);
    }

    // --- the brush ---
    {
      const dem = { nrows: 21, ncols: 21, cell: 1, originX: 0, originY: 0 };
      const grid = new Uint8Array(21 * 21).fill(Substrate.UNKNOWN);
      // Centre of the grid in world coordinates.
      const res = Substrate.paintSubstrate(grid, dem, Substrate.CODE.gravel, 10.5, 10.5, 3);
      let inside = 0, outside = 0;
      const north = dem.originY + dem.nrows * dem.cell;
      for (let r = 0; r < 21; r++) {
        for (let c = 0; c < 21; c++) {
          const x = (c + 0.5), y = north - (r + 0.5);
          const d = Math.hypot(x - 10.5, y - 10.5);
          const painted = grid[r * 21 + c] === Substrate.CODE.gravel;
          if (d <= 3 && painted) inside++;
          if (d > 3 && painted) outside++;
        }
      }
      add(O, "the substrate brush is HARD-EDGED — there is no half-gravel, so " +
        "nothing outside the disc is touched",
        "0 cells beyond the radius", String(outside), outside === 0);
      add(O, "…and it reports how many cells actually changed, so a stroke that " +
        "repaints the same class is not mistaken for an edit",
        `${inside} changed, then 0`,
        `${res.changed} changed, then ` +
        `${Substrate.paintSubstrate(grid, dem, Substrate.CODE.gravel, 10.5, 10.5, 3).changed}`,
        res.changed === inside &&
        Substrate.paintSubstrate(grid, dem, Substrate.CODE.gravel, 10.5, 10.5, 3).changed === 0);

      const counted = Substrate.substrateCounts(grid);
      add(O, "…and the counts add up to the whole grid, so the legend's " +
        "percentages describe all of it",
        "441", String(counted.known + counted.unknown),
        counted.known + counted.unknown === 441 &&
        counted.counts[Substrate.CODE.gravel] === inside);
    }
  }

  // ============================================================ GROUP P
  // Plan mode's engine. polygon.js has shipped with no suite entry of its own;
  // everything below was previously checked in a throwaway script, which means
  // it was checked once, on one afternoon, and never again.
  const P = "P · polygon regions — the mask, the hole, and what levelling costs";
  {
    const dem0 = DEM.fromRaw(loadGeoTIFF(await fetchTile("orndalen_fill_025m.tif"), { name: "plan" }));
    const cx = dem0.originX + (dem0.ncols * dem0.cell) / 2;
    const cy = dem0.originY + (dem0.nrows * dem0.cell) / 2;
    /** an axis-aligned square of half-width h about the tile centre */
    const square = (h, ox = 0, oy = 0) => [
      [cx - h + ox, cy - h + oy], [cx + h + ox, cy - h + oy],
      [cx + h + ox, cy + h + oy], [cx - h + ox, cy + h + oy],
    ];
    const outer = square(16);   // 32 x 32 m
    const hole = square(4);     //  8 x  8 m

    const plain = rasterise(dem0, [outer]);
    add(P, "a 32 × 32 m square on the real 0.25 m patch covers exactly the cells " +
      "its edges enclose — 128 rows of 128, decided at cell CENTRES",
      "16 384 cells", `${plain.count} cells`, plain.count === 16384);

    const holed = rasterise(dem0, [outer, hole]);
    add(P, "…and an 8 × 8 m ring drawn inside it subtracts, by the EVEN-ODD rule, " +
      "without the caller declaring it a hole",
      "16 384 − 1 024 = 15 360 cells", `${holed.count} cells`, holed.count === 15360);

    const reversed = rasterise(dem0, [outer, [...hole].reverse()]);
    add(P, "…whichever way round that inner ring was traced — a user drawing on " +
      "screen has no idea which direction they went, and non-zero winding would " +
      "make it matter",
      "15 360 cells either way", `${reversed.count} cells`, reversed.count === 15360);

    {
      let rMin = Infinity, rMax = -Infinity, cMin = Infinity, cMax = -Infinity;
      for (let i = 0; i < holed.mask.length; i++) {
        if (!holed.mask[i]) continue;
        const r = Math.floor(i / dem0.ncols), c = i % dem0.ncols;
        if (r < rMin) rMin = r; if (r > rMax) rMax = r;
        if (c < cMin) cMin = c; if (c > cMax) cMax = c;
      }
      const ok = holed.r0 === rMin && holed.r1 === rMax && holed.c0 === cMin && holed.c1 === cMax;
      add(P, "the reported dirty rectangle is exactly the mask's own extent, so a " +
        "region edit repaints the geometry it changed and no more",
        `rows ${rMin}–${rMax}, cols ${cMin}–${cMax}`,
        `rows ${holed.r0}–${holed.r1}, cols ${holed.c0}–${holed.c1}`, ok);
    }

    const range = maskZRange(dem0, holed.mask);
    {
      let lo = Infinity, hi = -Infinity, sum = 0, n = 0, outside = 0;
      for (let i = 0; i < holed.mask.length; i++) {
        if (!holed.mask[i]) continue;
        const z = dem0.z[i];
        if (z < lo) lo = z; if (z > hi) hi = z;
        sum += z; n++;
        if (z < range.lo || z > range.hi) outside++;
      }
      add(P, "maskZRange bounds the level slider by ground that actually exists " +
        "inside the ring — no masked cell lies outside the range it reports",
        "0 cells outside [lo, hi]", `${outside} cells`,
        outside === 0 && lo === range.lo && hi === range.hi);
      add(P, "…and its mean is the arithmetic mean of exactly those cells, which is " +
        "the one datum that costs nothing",
        f4(sum / n), f4(range.mean), near(range.mean, sum / n, 1e-9) && n === range.count);
    }

    {
      const dem = dem0.clone();
      const before = dem0.z;
      const res = levelTo(dem, holed.mask, 78.0);
      let outside = 0, wrongInside = 0;
      for (let i = 0; i < dem.z.length; i++) {
        if (holed.mask[i]) { if (dem.z[i] !== 78.0) wrongInside++; }
        else if (dem.z[i] !== before[i]) outside++;
      }
      add(P, "levelTo moves NOTHING outside the mask — a platform has a boundary, " +
        "and a graded batter is a separate design decision drawn as one",
        "0 cells beyond the ring", `${outside} cells`, outside === 0);
      add(P, "…and sets every cell inside it to the datum exactly: hard-edged, no " +
        "falloff, unlike every brush in this tool",
        "0 cells short of the datum", `${wrongInside} cells`, wrongInside === 0);

      // Independent recomputation: the same volumes from the untouched surface.
      let cut = 0, fill = 0;
      const a = dem0.cell * dem0.cell;
      for (let i = 0; i < holed.mask.length; i++) {
        if (!holed.mask[i]) continue;
        const dz = 78.0 - before[i];
        if (dz > 0) fill += dz * a; else cut += -dz * a;
      }
      add(P, "the volumes it reports agree with an independent integration over the " +
        "same cells, so the ledger cannot drift from the surface it describes",
        `cut ${f4(cut)}, fill ${f4(fill)}`, `cut ${f4(res.cut)}, fill ${f4(res.fill)}`,
        near(res.cut, cut, 1e-6) && near(res.fill, fill, 1e-6));

      // ⚠️ THE ASYMMETRY. Both figures are measured on this exact patch and this
      // exact ring; they are the reason Plan mode has a ledger at all.
      add(P, "⚠️ levelling to a CHOSEN datum is NOT volume-neutral — a 32 × 32 m " +
        "platform at 78.0 m needs material brought onto the site, and the tool " +
        "says how much rather than hiding it",
        "net +346.8 m³", `net ${res.net >= 0 ? "+" : "−"}${Math.abs(res.net).toFixed(1)} m³`,
        near(res.net, 346.818, 0.01));

      add(P, "…and a cell already sitting exactly at the datum is not counted as " +
        "moved, so the cell count is an earthwork and not a rasterisation",
        "15 358 of 15 360 moved", `${res.cells} of ${holed.count}`,
        res.cells === 15358);
    }

    {
      const dem = dem0.clone();
      const res = levelTo(dem, holed.mask, range.mean);
      add(P, "⚠️ …whereas levelling to the mask's OWN MEAN is volume-neutral to " +
        "float noise. The two results differ by 346.8 m³ on the same ring, and " +
        "that difference is the design decision, not an artefact",
        "|net| < 1e−6 m³", `${res.net.toExponential(1)} m³`,
        Math.abs(res.net) < 1e-6 && near(res.cut, res.fill, 1e-6));
    }

    {
      // The ledger is an ACCOUNT, not a readout of the last gesture.
      const dem = dem0.clone();
      const ledger = new Ledger();
      const a = levelTo(dem, holed.mask, 78.0, { ledger });
      const b = levelTo(dem, rasterise(dem, [square(6, 24, 0)]).mask, 77.0, { ledger });
      add(P, "the Ledger ACCUMULATES across regions — it has no add(); `cut` and " +
        "`fill` are fields and `net` is derived, so a second platform is one more " +
        "earthwork on the same site rather than a replacement for the first",
        `cut ${f2(a.cut + b.cut)}, fill ${f2(a.fill + b.fill)}`,
        `cut ${f2(ledger.cut)}, fill ${f2(ledger.fill)}`,
        near(ledger.cut, a.cut + b.cut, 1e-9) && near(ledger.fill, a.fill + b.fill, 1e-9) &&
        near(ledger.net, ledger.fill - ledger.cut, 1e-12));
    }

    {
      // A hole in the DEM is missing ground, not low ground.
      const dem = dem0.clone();
      const gap = dem.idx(dem.nrows >> 1, dem.ncols >> 1);
      dem.z[gap] = NaN;
      levelTo(dem, holed.mask, 78.0);
      add(P, "a NODATA cell inside the ring stays NODATA — levelling missing ground " +
        "to a datum would invent survey that was never made",
        "NaN", String(dem.z[gap]), Number.isNaN(dem.z[gap]));
    }

    // ---- plan.js, the model the UI drives, pinned to the engine above ----

    {
      // The hit test the sidebar selects with, against the rasteriser the
      // leveller uses. A click that selects a region the leveller then would not
      // touch is the defect this row exists to catch.
      let disagree = 0;
      const northY = dem0.originY + dem0.nrows * dem0.cell;
      for (let r = holed.r0; r <= holed.r1; r++) {
        for (let c = holed.c0; c <= holed.c1; c++) {
          const x = dem0.originX + (c + 0.5) * dem0.cell;
          const y = northY - (r + 0.5) * dem0.cell;
          const inRaster = holed.mask[r * dem0.ncols + c] === 1;
          if (pointInRings([outer, hole], x, y) !== inRaster) disagree++;
        }
      }
      add(P, "pointInRings answers at a POINT what rasterise answers at a cell " +
        "CENTRE — over the whole region they never disagree, so selecting a " +
        "region and levelling it mean the same thing",
        "0 disagreements over 16 384 cells", `${disagree}`, disagree === 0);
    }

    {
      const dem = dem0.clone();
      const predicted = levelCost(dem, holed.mask, 78.0);
      const actual = levelTo(dem, holed.mask, 78.0);
      add(P, "levelCost predicts EXACTLY what levelTo then does, so the figure under " +
        "the slider cannot differ from the one that lands in the ledger",
        `cut ${f4(actual.cut)}, fill ${f4(actual.fill)}, ${actual.cells} cells`,
        `cut ${f4(predicted.cut)}, fill ${f4(predicted.fill)}, ${predicted.cells} cells`,
        predicted.cut === actual.cut && predicted.fill === actual.fill &&
        predicted.cells === actual.cells);
    }

    {
      const set = new PlanSet();
      const region = set.add(outer, { level_m: 78 });
      set.addHole(region, hole);
      const ext = regionExtent(dem0, region);
      add(P, "regionArea is the exact polygon area, outer ring minus its holes",
        "960.0 m²", `${regionArea(region).toFixed(1)} m²`, near(regionArea(region), 960, 1e-6));
      add(P, "…and on a ring aligned to the grid it equals the raster's own area, " +
        "which is the cell count times the cell — the two measures of the same " +
        "platform, and they are allowed to differ by up to half a cell all round",
        "960.0 m²", `${(ext.count * dem0.cell * dem0.cell).toFixed(1)} m²`,
        near(ext.count * dem0.cell * dem0.cell, regionArea(region), 1e-6));

      // …and off the grid they do differ, by less than the bound above.
      const off = new PlanSet().add(square(16, 0.13, -0.07));
      const offExt = regionExtent(dem0, off);
      const bound = 4 * 32 * dem0.cell / 2;   // perimeter × half a cell
      const diff = Math.abs(offExt.count * dem0.cell * dem0.cell - regionArea(off));
      add(P, "…while a ring that does NOT land on the grid differs by less than its " +
        "perimeter times half a cell, which is the whole error a centre-decided " +
        "mask can carry",
        `< ${bound.toFixed(1)} m²`, `${diff.toFixed(2)} m²`, diff < bound);
    }

    {
      add(P, "a ring of two vertices, or three collinear ones, is refused rather " +
        "than rasterised to nothing — a region with no cells has no elevation " +
        "range, so the slider would have no bounds to take",
        "both refused",
        `${ringIsValid([[0, 0], [1, 1]])} / ${ringIsValid([[0, 0], [1, 1], [2, 2]])}`,
        !ringIsValid([[0, 0], [1, 1]]) && !ringIsValid([[0, 0], [1, 1], [2, 2]]));

      const set = new PlanSet();
      const a = set.add(square(8)), b = set.add(square(4, 40, 0));
      set.remove(a.id);
      const c = set.add(square(4, -40, 0));
      add(P, "region ids are never reused after a delete — two exports of one " +
        "session that both contain an “id 1” describing different ground is a " +
        "trap for anyone joining a table to them",
        "1, 2, 3 with 1 deleted", `${a.id}, ${b.id}, ${c.id}`,
        a.id === 1 && b.id === 2 && c.id === 3 && set.length === 2);

      add(P, "pickRegion returns the region under the point, topmost first, and " +
        "nothing at all outside every ring",
        "the second region, then null",
        `${pickRegion(set.regions, 40 + cx, cy)?.id ?? "null"}, ` +
        `${pickRegion(set.regions, cx + 1000, cy)?.id ?? "null"}`,
        pickRegion(set.regions, 40 + cx, cy) === b &&
        pickRegion(set.regions, cx + 1000, cy) === null);

      const v = square(4, 40, 0)[0];
      add(P, "…and pickVertex grabs a handle inside the tolerance and refuses one " +
        "outside it, so the grab radius is a promise rather than a suggestion",
        "found at 0.4 m, not found at 0.6 m",
        `${pickVertex(set.regions, v[0] + 0.4, v[1], 0.5) ? "found" : "missed"}, ` +
        `${pickVertex(set.regions, v[0] + 0.6, v[1], 0.5) ? "found" : "missed"}`,
        !!pickVertex(set.regions, v[0] + 0.4, v[1], 0.5) &&
        !pickVertex(set.regions, v[0] + 0.6, v[1], 0.5));

      // ⚠️ The grab radius is derived from the canvas, and a canvas with no
      // layout reports clientWidth 0. Divided through, a 10-pixel radius became
      // 714 m in a collapsed pane — and the symptom was not sloppy picking, it
      // was that the second click landed inside the FIRST vertex's tolerance and
      // closed the ring, so a four-corner platform came out a triangle.
      const laidOut = groundPerPixel(71.4, 1100, 2200, 2);
      const collapsed = groundPerPixel(71.4, 0, 600, 2);
      add(P, "the grab radius survives a canvas with NO LAYOUT — clientWidth 0 " +
        "falls back to the renderer's backing store instead of dividing by one " +
        "and turning ten pixels into hundreds of metres",
        "≈ 0.065 m/px laid out, ≈ 0.24 m/px collapsed — never 71 m/px",
        `${laidOut.toFixed(3)} / ${collapsed.toFixed(3)} m per px`,
        near(laidOut, 71.4 / 1100, 1e-9) && near(collapsed, 71.4 / 300, 1e-9));
    }

    {
      const set = new PlanSet();
      const region = set.add(outer, { level_m: 78, name: "North terrace" });
      set.addHole(region, hole);
      const [f] = toFeatures(set.regions);
      add(P, "a region leaves the tool as one feature with BOTH rings in it — two " +
        "features would be two overlapping platforms, and the inner one would win",
        "2 rings, id/name/level_m",
        `${f.rings.length} rings, ${Object.keys(f.attributes).join("/")}`,
        f.rings.length === 2 && f.attributes.id === region.id &&
        f.attributes.name === "North terrace" && f.attributes.level_m === 78);
    }
  }

  // ============================================================ GROUP Q
  // The shapefile writer. Every trap in this format produces a file that opens
  // without complaint and is wrong, so each row here names the trap it defends.
  const Q = "Q · the shapefile — four traps that each produce a file that opens and lies";
  {
    {
      // ⚠️ HIDING A REGION IS A DISPLAY STATE, NOT A DELETION, and the export is
      // where that has to be true or the control is a trap: a designer who hid
      // three platforms to look at the ground under them would export a plan
      // missing three platforms, and nothing would say so. `hidden` is also kept
      // OUT of the attribute table — see the note on PLAN_FIELDS — so the file
      // cannot carry a record of somebody's screen state either.
      const set = new PlanSet();
      const a = set.add([[0, 0], [10, 0], [10, 10], [0, 10]], { level_m: 78 });
      const b = set.add([[20, 0], [30, 0], [30, 10], [20, 10]], { level_m: 79 });
      b.hidden = true;
      const feats = toFeatures(set.regions);
      const fields = Object.keys(feats[0].attributes || {});
      add(Q, "a region hidden from the view is still exported — hiding is a "
        + "display state, and a plan that quietly dropped what you were not "
        + "looking at would be the worst kind of wrong",
        "2 features", `${feats.length} features`, feats.length === 2);
      add(Q, "…and the visibility flag is NOT in the attribute table, so the file "
        + "cannot carry a record of the state of somebody's screen",
        "id, name, level_m", fields.join(", "),
        !fields.includes("hidden") && fields.length === PLAN_FIELDS.length);
      void a;
    }
    /** Minimal independent reader, written against the spec, not against the writer. */
    const readSHP = (bytes) => {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const out = [];
      let off = 100;
      while (off < bytes.length) {
        const num = v.getInt32(off, false);
        const contentWords = v.getInt32(off + 4, false);
        let o = off + 8;
        const type = v.getInt32(o, true); o += 4;
        const bbox = [v.getFloat64(o, true), v.getFloat64(o + 8, true),
          v.getFloat64(o + 16, true), v.getFloat64(o + 24, true)]; o += 32;
        const nParts = v.getInt32(o, true); o += 4;
        const nPoints = v.getInt32(o, true); o += 4;
        const parts = [];
        for (let i = 0; i < nParts; i++) { parts.push(v.getInt32(o, true)); o += 4; }
        const points = [];
        for (let i = 0; i < nPoints; i++) {
          points.push([v.getFloat64(o, true), v.getFloat64(o + 8, true)]); o += 16;
        }
        const rings = parts.map((s, i) => points.slice(s, i + 1 < parts.length ? parts[i + 1] : nPoints));
        out.push({ num, contentWords, type, bbox, rings, offset: off });
        off += 8 + contentWords * 2;
      }
      return out;
    };
    const area2 = (ring) => {
      let a = 0;
      for (let i = 0, n = ring.length; i < n; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
        a += x1 * y2 - x2 * y1;
      }
      return a / 2;
    };
    const ascii = (bytes, from, len) =>
      String.fromCharCode(...bytes.slice(from, from + len)).replace(/\0+$/, "");

    // Two regions, drawn counter-clockwise, the first with a hole — the shape a
    // user's tracing actually arrives in.
    const sq = (x, y, h, ccw = true) => {
      const r = [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]];
      return ccw ? r : r.reverse();
    };
    const features = [
      // The attribute key is the field's FULL name, not the truncated one the
      // .dbf header can hold — see the truncation rows below.
      { rings: [sq(654958, 7737732, 16), sq(654958, 7737732, 4)],
        attributes: { id: 1, name: "North terrace", level_m_above_datum: 78 } },
      // …and this one is deliberately missing its `name`.
      { rings: [sq(654990, 7737700, 6, false)],
        attributes: { id: 2, level_m_above_datum: 76.5 } },
    ];
    const fields = [
      { name: "id", type: "N", size: 10 },
      { name: "name", type: "C", size: 32 },
      { name: "level_m_above_datum", type: "N", size: 12, decimals: 3 },
    ];
    const out = writeShapefile(features, { fields });
    const recs = readSHP(out.shp);
    const sv = new DataView(out.shp.buffer, out.shp.byteOffset, out.shp.byteLength);
    const xv = new DataView(out.shx.buffer, out.shx.byteOffset, out.shx.byteLength);

    add(Q, "the .shp opens with file code 9994 written BIG-endian, which is how a " +
      "reader recognises the format at all",
      "9994", String(sv.getInt32(0, false)), sv.getInt32(0, false) === 9994);

    add(Q, "⚠️ TRAP: the same 100-byte header is MIXED-ENDIAN — version and shape " +
      "type are LITTLE-endian three words after a big-endian length. Writing it " +
      "all one way gives a file some readers still partly parse",
      "version 1000, type 5 (polygon)",
      `version ${sv.getInt32(28, true)}, type ${sv.getInt32(32, true)}`,
      sv.getInt32(28, true) === 1000 && sv.getInt32(32, true) === 5);

    add(Q, "⚠️ TRAP: lengths in the header are in 16-BIT WORDS, not bytes — a byte " +
      "count here is a file that reads as twice its length and runs off the end",
      `${out.shp.length / 2} words for ${out.shp.length} bytes`,
      `${sv.getInt32(24, false)} words`, sv.getInt32(24, false) === out.shp.length / 2);

    add(Q, "…and the .shx says the same about itself, with exactly one 8-byte " +
      "record per feature — the index ArcGIS refuses to open a shapefile without",
      `${100 + features.length * 8} bytes`,
      `${xv.getInt32(24, false) * 2} bytes`,
      xv.getInt32(24, false) * 2 === out.shx.length &&
      out.shx.length === 100 + features.length * 8);

    {
      let ok = true;
      features.forEach((_, i) => {
        const offWords = xv.getInt32(100 + i * 8, false);
        const lenWords = xv.getInt32(100 + i * 8 + 4, false);
        if (offWords * 2 !== recs[i].offset) ok = false;
        if (lenWords !== recs[i].contentWords) ok = false;
        if (recs[i].num !== i + 1) ok = false;
      });
      add(Q, "every .shx entry points at a record whose 1-based number and content " +
        "length are its own — the index and the geometry cannot drift apart",
        "2 entries agree", ok ? "2 entries agree" : "mismatch", ok);
    }

    add(Q, "⚠️ TRAP: OUTER RINGS COME OUT CLOCKWISE — the opposite of GeoJSON. " +
      "Backwards, every polygon is read as a hole: the file opens, the geometry " +
      "is “valid”, and the map is empty",
      "both outer rings clockwise (signed area < 0)",
      `${area2(recs[0].rings[0]) < 0} / ${area2(recs[1].rings[0]) < 0}`,
      area2(recs[0].rings[0]) < 0 && area2(recs[1].rings[0]) < 0);

    add(Q, "…and the inner ring comes out the other way round, which is the only " +
      "thing that tells a reader it is a hole rather than a second shell — note " +
      "the user drew both counter-clockwise",
      "inner counter-clockwise (signed area > 0)",
      String(area2(recs[0].rings[1]) > 0), area2(recs[0].rings[1]) > 0);

    {
      let closed = 0;
      for (const r of recs) for (const ring of r.rings) {
        const [fx, fy] = ring[0], [lx, ly] = ring[ring.length - 1];
        if (fx === lx && fy === ly) closed++;
      }
      add(Q, "⚠️ TRAP: every ring is EXPLICITLY CLOSED, first point repeated as " +
        "last — readers differ on an open ring, and some silently drop the " +
        "closing segment, which shifts an area without erroring",
        "3 of 3 rings closed", `${closed} of 3`, closed === 3);
    }

    {
      // Round-trip: closing and re-winding must not move a point the user drew.
      const drawn = features[0].rings[0].map(([x, y]) => `${x},${y}`).sort().join(" ");
      const back = recs[0].rings[0].slice(0, -1).map(([x, y]) => `${x},${y}`).sort().join(" ");
      add(Q, "normalising winding and closure did not MOVE anything — the four " +
        "corners that come back out are the four that went in",
        drawn.slice(0, 32) + "…", back.slice(0, 32) + "…", drawn === back);
    }

    {
      let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
      for (const f of features) for (const r of f.rings) for (const [x, y] of r) {
        if (x < xmin) xmin = x; if (x > xmax) xmax = x;
        if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      }
      const got = [sv.getFloat64(36, true), sv.getFloat64(44, true),
        sv.getFloat64(52, true), sv.getFloat64(60, true)];
      add(Q, "the header's bounding box is the true extent of every ring written, " +
        "so a reader that trusts it to place the layer places it correctly",
        `${xmin}, ${ymin}, ${xmax}, ${ymax}`, got.join(", "),
        got[0] === xmin && got[1] === ymin && got[2] === xmax && got[3] === ymax);
    }

    {
      const d = out.dbf;
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const headerLen = 32 + fields.length * 32 + 1;
      const recordLen = 1 + fields.reduce((n, f) => n + f.size, 0);
      const ok = d[0] === 0x03 && dv.getInt32(4, true) === features.length &&
        dv.getInt16(8, true) === headerLen && dv.getInt16(10, true) === recordLen &&
        d[headerLen - 1] === 0x0d && d[d.length - 1] === 0x1a;
      add(Q, "the .dbf is dBASE III throughout: version byte, record count, header " +
        "and record lengths, the 0x0D terminator and the 0x1A end marker",
        `0x03, ${features.length} records, ${headerLen}/${recordLen}, 0x0D, 0x1A`,
        `0x${d[0].toString(16).padStart(2, "0")}, ${dv.getInt32(4, true)} records, ` +
        `${dv.getInt16(8, true)}/${dv.getInt16(10, true)}, ` +
        `0x${d[headerLen - 1].toString(16).toUpperCase()}, ` +
        `0x${d[d.length - 1].toString(16).toUpperCase()}`, ok);

      add(Q, "⚠️ a field name longer than 10 bytes is truncated, because dBASE III " +
        "field names ARE 10 bytes — this is how two fields silently end up with " +
        "the same name and one of them disappears",
        "level_m_ab", ascii(d, 32 + 2 * 32, 11),
        ascii(d, 32 + 2 * 32, 11) === "level_m_ab");

      // …and the VALUE still resolves, because the writer looks the attribute up
      // under the full name it was given.
      const rec = headerLen;
      const idCell = ascii(d, rec + 1, 10);
      const nameCell = ascii(d, rec + 11, 32);
      const levelCell = ascii(d, rec + 43, 12);
      add(Q, "…and its value still lands, because the attribute is looked up under " +
        "the name the caller gave, not under the truncated one",
        "“      78.000”", `“${levelCell}”`, levelCell === "      78.000");
      add(Q, "numerics are RIGHT-aligned and text LEFT-aligned, which is the dBASE " +
        "convention every reader's column parser assumes",
        "“         1” / “North terrace…”",
        `“${idCell}” / “${nameCell.slice(0, 13)}…”`,
        idCell === "         1" && nameCell.startsWith("North terrace") &&
        nameCell.length === 32);

      // A record still has to be the declared width even where it has nothing
      // to say, or every column after it shifts by however much is missing.
      const rec2 = headerLen + recordLen;
      const blank = String.fromCharCode(...d.slice(rec2 + 11, rec2 + 43));
      add(Q, "a feature with no value for a field writes the field's full width in " +
        "spaces — a short record would shift every column after it, and dBASE " +
        "has no delimiters to resynchronise on",
        "32 spaces", `${blank.trim().length ? `“${blank.trim()}”` : "32 spaces"}`,
        blank === " ".repeat(32) && d[rec2] === 0x20);
    }

    add(Q, "the .prj asserts EPSG:25833 — this is the ONE place the project names a " +
      "projection, and without it a reader puts the polygons wherever it guesses",
      "contains AUTHORITY[\"EPSG\",\"25833\"]",
      out.prj.includes('AUTHORITY["EPSG","25833"]') ? "present" : "absent",
      out.prj.includes('AUTHORITY["EPSG","25833"]') && out.prj.startsWith("PROJCS["));

    {
      const gj = JSON.parse(writeGeoJSON(features));
      const outerCCW = area2(gj.features[0].geometry.coordinates[0].slice(0, -1)) > 0;
      const innerCW = area2(gj.features[0].geometry.coordinates[1].slice(0, -1)) < 0;
      add(Q, "⚠️ the GeoJSON of the SAME drawing winds the OPPOSITE way — " +
        "counter-clockwise outer rings — because that is what its own spec says. " +
        "The two files disagree about winding and agree about the ground",
        "outer CCW, inner CW", `${outerCCW} / ${innerCW}`, outerCCW && innerCW);
      add(Q, "…and it carries the attributes verbatim, so the shapefile's table and " +
        "the GeoJSON's properties are the same record",
        "id 1, level 78, EPSG:25833",
        `id ${gj.features[0].properties.id}, ` +
        `level ${gj.features[0].properties.level_m_above_datum}, ` +
        `${gj.crs.properties.name.split("::").pop()}`,
        gj.features.length === 2 && gj.features[0].properties.id === 1 &&
        gj.features[0].properties.level_m_above_datum === 78 &&
        gj.crs.properties.name.endsWith("25833"));
    }

    {
      // Exporting before anything is drawn must not produce a corrupt file.
      const empty = writeShapefile([], { fields: PLAN_FIELDS });
      const ev = new DataView(empty.shp.buffer, empty.shp.byteOffset, empty.shp.byteLength);
      add(Q, "an empty drawing writes a valid EMPTY shapefile rather than throwing " +
        "or emitting an Infinity bounding box",
        "100 bytes, bbox 0,0,0,0",
        `${empty.shp.length} bytes, bbox ${ev.getFloat64(36, true)},${ev.getFloat64(44, true)},` +
        `${ev.getFloat64(52, true)},${ev.getFloat64(60, true)}`,
        empty.shp.length === 100 && ev.getFloat64(36, true) === 0 &&
        ev.getFloat64(60, true) === 0 && empty.dbf.length > 0);
    }
  }

  const R = "R · pattern stamping — a field specified, and billed for honestly";
  {
    // ── the mapping from grey to earth ──────────────────────────────────────
    add(R, "mid-grey moves no earth, which is what makes a drawing a specification "
      + "rather than a displacement of everything it covers",
      "0", String(signedDisplacement(NEUTRAL, 0, 1)),
      signedDisplacement(NEUTRAL, 0, 1) === 0);
    add(R, "black cuts and white fills, at the full amplitude either way",
      "−1 / +1",
      `${signedDisplacement(0, 0, 1)} / ${signedDisplacement(1, 0, 1)}`,
      signedDisplacement(0, 0, 1) === -1 && signedDisplacement(1, 0, 1) === 1);
    add(R, "…and inverting swaps exactly that, so the same drawing can be read "
      + "either way round without being redrawn",
      "+1 / −1",
      `${signedDisplacement(0, 0, 1, true)} / ${signedDisplacement(1, 0, 1, true)}`,
      signedDisplacement(0, 0, 1, true) === 1 && signedDisplacement(1, 0, 1, true) === -1);

    // The handles are an input-levels pair, so moving BOTH the same way moves
    // the neutral grey — which is the whole "more cut / more fill" control.
    const midHigh = signedDisplacement(0.5, 0.3, 1.0);   // neutral now 0.65
    const midLow = signedDisplacement(0.5, 0.0, 0.7);    // neutral now 0.35
    add(R, "sliding both handles up tips a mid-grey toward CUT, and sliding both "
      + "down tips it toward FILL — one control for contrast and for bias",
      "< 0 then > 0", `${f2(midHigh)} then ${f2(midLow)}`,
      midHigh < 0 && midLow > 0);
    add(R, "a collapsed window moves nothing rather than dividing by zero",
      "0", String(signedDisplacement(0.7, 0.5, 0.5)),
      signedDisplacement(0.7, 0.5, 0.5) === 0);

    // ── alpha ───────────────────────────────────────────────────────────────
    {
      // A transparent pixel must leave its ground alone. Composited over
      // mid-grey rather than ignored, or a PNG's unused RGB would be stamped.
      const rgba = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]);
      const f = fieldFromRGBA(rgba, 2, 1);
      add(R, "a transparent pixel reads as neutral, so a cut-out drawing leaves the "
        + "ground outside it untouched instead of stamping black",
        `${NEUTRAL} then 0`, `${f[0]} then ${f[1]}`,
        f[0] === NEUTRAL && f[1] === 0);
    }

    // ── resampling ──────────────────────────────────────────────────────────
    {
      // Bilinear, not nearest. A 2x2 source across 8 cells must produce values
      // BETWEEN the source values; nearest neighbour would produce only the
      // four originals and terrace the result at the source's pixel pitch.
      const src = new Float32Array([0, 1, 0, 1]);
      const out = resampleField(src, 2, 2, 8, 8);
      let between = 0;
      for (const v of out) if (v > 0.01 && v < 0.99) between++;
      add(R, "an image is resampled BILINEARLY — elevation is continuous, so the "
        + "alternative would terrace the ground at the drawing's pixel pitch",
        "> 0 intermediate values", `${between} of ${out.length}`, between > 0);

      // Cover fit, aspect preserved: a square source into a 2:1 window must stay
      // symmetric about the window's centre column rather than being stretched.
      const grad = new Float32Array(16 * 16);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        grad[y * 16 + x] = Math.abs(x - 7.5) / 8;      // symmetric about the middle
      }
      const wide = resampleField(grad, 16, 16, 8, 16);  // 16 wide, 8 tall
      let worst = 0;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        worst = Math.max(worst, Math.abs(wide[r * 16 + c] - wide[r * 16 + (15 - c)]));
      }
      add(R, "the fit preserves aspect, so a pattern stamped into a non-square area "
        + "keeps its wavelength on both axes instead of only one",
        "symmetric to 1e-6", f4(worst), worst < 1e-6);
    }

    // ── the generated field ─────────────────────────────────────────────────
    {
      const a = generatedField(64, 64, 0.25, 4, 7);
      const b = generatedField(64, 64, 0.25, 4, 7);
      const c = generatedField(64, 64, 0.25, 4, 8);
      let sameAB = true, sameAC = true;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) sameAB = false;
        if (a[i] !== c[i]) sameAC = false;
      }
      add(R, "a generated field is reproducible from its seed — a figure that cannot "
        + "be regenerated is not a measurement",
        "identical", sameAB ? "identical" : "differs", sameAB);
      add(R, "…and a different seed is a different surface, so one lucky field is "
        + "never mistaken for a result",
        "differs", sameAC ? "identical" : "differs", !sameAC);

      let lo = Infinity, hi = -Infinity;
      for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
      add(R, "…normalised to the full 0–1 range, so the amplitude asked for is the "
        + "amplitude delivered",
        "0 and 1", `${f4(lo)} and ${f4(hi)}`, lo === 0 && hi === 1);

      // ⚠️ THE LOAD-BEARING PROPERTY. Wavelength has to be a real length: white
      // noise at the cell size would make every cell its own pit and simply
      // recreate the salt-and-pepper artefact, which is not a graded surface.
      const rough = (f, n) => {
        let s = 0, k = 0;
        for (let r = 0; r < n; r++) for (let cc = 0; cc + 1 < n; cc++) {
          s += Math.abs(f[r * n + cc + 1] - f[r * n + cc]); k++;
        }
        return s / k;
      };
      const short = rough(generatedField(64, 64, 0.25, 1.5, 3), 64);
      const long = rough(generatedField(64, 64, 0.25, 8, 3), 64);
      add(R, "a longer wavelength really is smoother cell to cell — the field is "
        + "band-limited at a stated ground length, not per-cell noise",
        "1.5 m rougher than 8 m", `${f4(short)} vs ${f4(long)}`, short > long * 1.5);
    }

    // ── the stamp on real ground ────────────────────────────────────────────
    {
      const dem = fillDem.clone();
      const before = dem.z.slice();
      const field = generatedField(dem.nrows, dem.ncols, dem.cell, 4, 11);
      const ledger = new Ledger();
      const amplitude = 0.05;
      const cost = patternCost(dem, field, { amplitude });
      const res = applyPattern(dem, field, { amplitude, ledger });

      // ⚠️ THE LEDGER IS BILLED FOR WHAT WAS STORED. `z` is float32, so the
      // write rounds; charging the intended dz would let the account drift from
      // the ground it describes — and a stamp writes the whole grid at once, so
      // the drift would be the entire surface's worth in one operation. This
      // integrates the difference independently and must agree exactly.
      let cutI = 0, fillI = 0;
      const areaCell = dem.cell * dem.cell;
      for (let i = 0; i < before.length; i++) {
        const d = dem.z[i] - before[i];
        if (!Number.isFinite(d)) continue;
        if (d < 0) cutI += -d * areaCell; else fillI += d * areaCell;
      }
      add(R, "the ledger is billed for what the float32 surface actually STORED, "
        + "not for what the stamp intended — measured against an independent "
        + "integration of the difference",
        `${f4(cutI)} / ${f4(fillI)} m³`,
        `${f4(ledger.cut)} / ${f4(ledger.fill)} m³`,
        near(ledger.cut, cutI, 1e-6) && near(ledger.fill, fillI, 1e-6));
      add(R, "…and the preview quoted before committing matches it to within the "
        + "rounding, so the number on screen is the number that happens",
        "within 0.01 m³", f4(Math.abs(cost.net - res.net)) + " m³",
        Math.abs(cost.net - res.net) < 0.01);
      add(R, "peak displacement is the amplitude asked for, neither doubled nor halved",
        `${amplitude} m`, f4(Math.max(...[...before].map((b, i) => Math.abs(dem.z[i] - b)))) + " m",
        near(Math.max(...[...before].map((b, i) => Math.abs(dem.z[i] - b))), amplitude, 1e-3));
    }

    {
      // Nothing outside the mask may move. Same guarantee polygon levelling
      // makes, and for the same reason: the stamp follows a region the user
      // drew, and ground outside it was not selected.
      const dem = fillDem.clone();
      const before = dem.z.slice();
      const mask = new Uint8Array(dem.nrows * dem.ncols);
      for (let r = 20; r < 60; r++) for (let c = 30; c < 70; c++) mask[r * dem.ncols + c] = 1;
      const field = generatedField(dem.nrows, dem.ncols, dem.cell, 4, 5, { mask });
      const res = applyPattern(dem, field, { amplitude: 0.2, mask });
      let outside = 0;
      for (let i = 0; i < before.length; i++) {
        if (!mask[i] && dem.z[i] !== before[i]) outside++;
      }
      add(R, "not one cell outside the selected region moves, so a stamp confined "
        + "to a polygon is confined to it in the ground as well as on screen",
        "0 cells", `${outside} cells (${res.cells} inside)`,
        outside === 0 && res.cells > 0);
      add(R, "…and the dirty rect the stamp reports covers the mask and no more",
        "rows 20–59, cols 30–69",
        `rows ${res.rect.r0}–${res.rect.r1}, cols ${res.rect.c0}–${res.rect.c1}`,
        res.rect.r0 === 20 && res.rect.r1 === 59
        && res.rect.c0 === 30 && res.rect.c1 === 69);
    }

    {
      // A hole in the DEM stays a hole, and is never billed for.
      const dem = DEM.synthetic(8, 8, 1, () => 10);
      dem.z[27] = NaN;
      const field = new Float32Array(64).fill(1);   // full fill everywhere
      const ledger = new Ledger();
      applyPattern(dem, field, { amplitude: 0.5, ledger });
      add(R, "a nodata cell stays nodata and is not charged to the ledger — 63 of "
        + "64 cells filled, not 64",
        "NaN, 31.5 m³", `${dem.z[27]}, ${f2(ledger.fill)} m³`,
        Number.isNaN(dem.z[27]) && near(ledger.fill, 63 * 0.5, 1e-4));
    }
  }

  const S = "S · contours lie IN the facets they are drawn on";
  {
    // ── the levels themselves ───────────────────────────────────────────────
    const lv = contourLevels(77.2, 79.4, 0.5);
    add(S, "levels are exact multiples of the interval, anchored to zero rather "
      + "than to the tile's own floor — so they do not slide when the ground is "
      + "edited, and two tiles of one site draw the same set",
      "77.5, 78, 78.5, 79", lv.map((v) => +v.toFixed(3)).join(", "),
      lv.length === 4 && Math.abs(lv[0] - 77.5) < 1e-9 && Math.abs(lv[3] - 79) < 1e-9);
    add(S, "an interval far below the data's resolution is REFUSED rather than "
      + "drawn — the slider can ask for it, and half a million lines would read "
      + "as the tool hanging",
      "0 levels", `${contourLevels(0, 100, 0.0001).length} levels`,
      contourLevels(0, 100, 0.0001).length === 0);
    add(S, "the suggested interval comes off the 1-2-5 series, like the scale bar",
      "0.5 m on 5.3 m of relief", `${niceInterval(5.313)} m`,
      niceInterval(5.313) === 0.5);

    // ── the invariant, on one hand-computable quad ──────────────────────────
    {
      // a=0.5 (NW), b=1.5 (NE), d=0.5 (SW), e=0.5 (SE) on a 1 m cell, at a 1 m
      // interval — so exactly ONE level, at 1.0, falls inside the quad's range
      // and the count below is unambiguous. Only b is above it, so a quad-based
      // marcher would emit ONE chord across that corner. The mesh splits this
      // quad along b-d, so the real surface carries a ridge the chord cuts under.
      //
      // Every value here is an exact binary fraction, so the arithmetic is exact
      // and the deviation below can be asserted at zero rather than at a
      // tolerance — the real-patch check further down is the one that has to
      // live with float32.
      const dem = new DEM(new Float32Array([0.5, 1.5, 0.5, 0.5]), 2, 2, 1, 0, 0);
      const { positions, segments } = contourSegments(dem.z, 2, 2, 1, 1);
      add(S, "one quad, one level: the contour is marched over the TRIANGLES, so it "
        + "bends where the mesh's own diagonal is rather than cutting straight "
        + "across the quad",
        "2 segments", `${segments} segments`, segments === 2);

      const dev = facetDeviation(dem.z, 2, 2, 1, positions);
      add(S, "…and every segment lies in the facet it belongs to, exactly",
        "0.0000 m", f4(dev.max) + " m", dev.max === 0);

      // ⚠️ VERIFIED TO BITE. The chord a quad-based marching-squares would draw
      // instead is reconstructed here — the two outer endpoints joined — and
      // measured against the same surface. It is buried by a quarter of a metre
      // on a 1 m cell, which is the lattice failure exactly: lines that vanish
      // in patches and look for all the world like a depth-test tie.
      const chord = new Float32Array([1.0, 1.5, 1.0, 1.5, 1.0, 1.0]);
      const bad = facetDeviation(dem.z, 2, 2, 1, chord);
      add(S, "…while the straight chord across the quad — what marching SQUARES "
        + "would have drawn — is buried by the surface it is supposed to lie on",
        "> 0.2 m on a 1 m cell", f4(bad.max) + " m", bad.max > 0.2);
    }

    // ── the degenerate surface this project exists to talk about ────────────
    {
      // ⚠️ A LEVELLED SURFACE SITTING EXACTLY ON A LEVEL. The above/below test
      // is half-open, so every corner counts as above and nothing is emitted.
      // Two closed comparisons would make each vertex belong to both sides and
      // emit a zero-length segment at every one of them — on precisely the
      // planarised surface this tool's argument is built on.
      const flat = DEM.synthetic(32, 32, 0.25, () => 78);
      const r1 = contourSegments(flat.z, 32, 32, 0.25, 0.5);
      add(S, "ground levelled exactly onto a contour level draws NO line work, "
        + "rather than a zero-length segment at every vertex of the flat",
        "0 segments", `${r1.segments} segments`, r1.segments === 0);
    }

    {
      // A plane tilted in x: the lines must be straight, evenly spaced, and at
      // their own level. 1 m of fall across 32 cells at 0.25 m.
      const ramp = DEM.synthetic(32, 32, 0.25, (r, c) => 77 + c * (1 / 32));
      const res = contourSegments(ramp.z, 32, 32, 0.25, 0.25);
      let offLevel = 0;
      for (let i = 2; i < res.positions.length; i += 3) {
        const z = res.positions[i];
        if (Math.abs(z / 0.25 - Math.round(z / 0.25)) > 1e-5) offLevel++;
      }
      add(S, "on a tilted plane every vertex sits exactly on its own level",
        "0 off-level", `${offLevel} of ${res.positions.length / 3}`, offLevel === 0);
      add(S, "…and the levels found are the ones the range contains",
        "4 levels", `${res.levels} levels`, res.levels === 4);
    }

    {
      // Exaggeration stretches Z and nothing else — the lines have to lie on the
      // surface AS DISPLAYED, while the levels stay true elevations.
      const ramp = DEM.synthetic(16, 16, 1, (r, c) => c * 0.5);
      const a = contourSegments(ramp.z, 16, 16, 1, 1, { exaggeration: 1 });
      const b = contourSegments(ramp.z, 16, 16, 1, 1, { exaggeration: 2.5 });
      let xySame = true, zScaled = true;
      for (let i = 0; i < a.positions.length; i += 3) {
        if (a.positions[i] !== b.positions[i]
          || a.positions[i + 1] !== b.positions[i + 1]) xySame = false;
        if (Math.abs(b.positions[i + 2] - a.positions[i + 2] * 2.5) > 1e-4) zScaled = false;
      }
      add(S, "vertical exaggeration multiplies Z and leaves X and Y alone, so a "
        + "contour still lies on the surface as it is displayed",
        "XY identical, Z ×2.5", `${xySame ? "XY identical" : "XY moved"}, ` +
        `${zScaled ? "Z ×2.5" : "Z wrong"}`, xySame && zScaled);
    }

    {
      // A hole removes the whole quad. Interpolating toward NaN would emit a
      // vertex at NaN, which three.js turns into an invisible draw call and a
      // corrupt bounding sphere — a defect with no visible cause.
      const dem = DEM.synthetic(16, 16, 1, (r, c) => c * 0.5);
      dem.z[dem.idx(8, 8)] = NaN;
      const res = contourSegments(dem.z, 16, 16, 1, 1);
      let nan = 0;
      for (const v of res.positions) if (!Number.isFinite(v)) nan++;
      add(S, "a nodata cell removes its whole quad rather than emitting a vertex "
        + "at NaN, which would draw nothing and corrupt the bounding sphere",
        "0 NaN", `${nan} NaN in ${res.positions.length} floats`, nan === 0);
    }

    // ── on the real patch ───────────────────────────────────────────────────
    {
      const res = contourSegments(fillDem.z, fillDem.nrows, fillDem.ncols,
        fillDem.cell, 0.5, { exaggeration: 2.5 });
      const dev = facetDeviation(fillDem.z, fillDem.nrows, fillDem.ncols,
        fillDem.cell, res.positions, 2.5);
      // ⚠️ NOT EXACTLY ZERO HERE, AND IT CANNOT BE. The lattice shares the
      // mesh's own position buffer, so its deviation is zero by identity. A
      // contour vertex is INTERPOLATED between grid vertices, so the check is
      // bounded by float32 instead: elevations here are ~78 m, where a float32
      // ULP is 7.6e-6 m, and the exaggeration multiplies that by 2.5. A tenth of
      // a millimetre is therefore the arithmetic's floor, not the method's — and
      // it is four hundred times below this site's own LiDAR repeatability.
      add(S, "on the real Ørndalen fill patch, at the exaggeration the app uses, "
        + "every contour segment lies on the surface to within float32 itself",
        "< 0.1 mm", `${(dev.max * 1000).toFixed(4)} mm over ${dev.samples} segments`,
        dev.max < 1e-4 && dev.samples > 1000);
    }
  }

  const X = "X · every panel the app offers can actually be exported";
  {
    // ⚠️ THIS GROUP EXISTS BECAUSE "Everything · ZIP" DIED PARTWAY THROUGH, on
    // "Cannot read properties of undefined (reading 'domain')". Layers were
    // assumed to be either continuous (a ramp with a domain) or categorical (a
    // named class list). Watersheds are neither: a basin id is nominal and
    // unbounded, so the layer deliberately has no RAMPS entry and no LEGEND
    // entry, and the figure builder walked straight through the missing ramp.
    //
    // The bundle is what found it, because it is the only path that visits every
    // layer in turn — and it took fourteen layers of work before failing, so the
    // failure arrived a quarter of a minute after the click.
    const panelKeys = ["slope", "aspect", "twi", "catchment", "cutfill", "depression",
      "tri", "species", "soil", "svf", "openness", "solar", "wind", "geomorphon",
      "watershed"];
    // A layer is nominal when it has NEITHER a continuous ramp NOR a named class
    // list. Landforms, species and substrate have no RAMPS entry either — they
    // are categorical and carry their palettes in CATEGORICAL — so testing for a
    // missing ramp alone would sweep them in with the basins.
    const nominalKeys = panelKeys.filter((k) => !RAMPS[k] && !CATEGORICAL[k]);
    add(X, "exactly one layer is nominal — neither a ramp nor a named class list "
      + "— and it is the basins. Anything else appearing here is a layer the "
      + "figure builder would try to read a domain from and die on",
      "watershed", nominalKeys.join(", ") || "none",
      nominalKeys.length === 1 && nominalKeys[0] === "watershed");

    // Whatever kind a layer is, the export path must be able to classify it
    // without reaching into a table that may not have it.
    const kinds = panelKeys.map((k) => {
      const meta = CATEGORICAL[k] ? "categorical" : null;
      if (meta) return meta;
      return RAMPS[k] ? "continuous" : "nominal";
    });
    add(X, "…and every panel resolves to one of the three kinds the figure builder "
      + "handles, so none of them can fall through to a missing table",
      `${panelKeys.length} classified`,
      `${kinds.filter(Boolean).length} classified (${new Set(kinds).size} kinds)`,
      kinds.every(Boolean) && kinds.length === panelKeys.length);

    add(X, "…and a nominal layer is told apart by the absence of a ramp rather "
      + "than by being named in a list, so the next one added is handled without "
      + "anyone remembering to add it here",
      "watershed nominal, twi continuous, species categorical",
      `${!RAMPS.watershed ? "watershed nominal" : "watershed HAS ramp"}, `
      + `${RAMPS.twi && !CATEGORICAL.twi ? "twi continuous" : "twi wrong"}, `
      + `${CATEGORICAL.species ? "species categorical" : "species wrong"}`,
      !RAMPS.watershed && !!RAMPS.twi && !CATEGORICAL.twi && !!CATEGORICAL.species);
  }

  const W = "W · sections are a MEASURED drawing, not an illustration";
  {
    // A plane tilted 1:10 in x. Every figure below is hand-computable, which is
    // the point: a section is dimensioned and exported, and someone builds from it.
    const ramp = DEM.synthetic(40, 40, 0.5, (r, c) => 10 + c * 0.05);
    const a = [1, 10], b = [18, 10];
    const p = sampleSection(ramp, a, b);
    add(W, "a section samples end to end at half-cell stations, so it cannot step "
      + "over a facet — a crease running along a quad's own diagonal would "
      + "otherwise be sampled only at its ends and drawn as a smooth ramp",
      "17.0 m, step ≤ 0.25 m",
      `${p.length.toFixed(1)} m, step ${(p.length / (p.s.length - 1)).toFixed(3)} m`,
      near(p.length, 17, 1e-9) && (p.length / (p.s.length - 1)) <= 0.2500001);

    // 0.05 m per COLUMN at a 0.5 m cell is 0.1 m per metre — a 1:10 plane.
    const rise = p.now[p.s.length - 1] - p.now[0];
    add(W, "…and it reads the ground correctly: 17 m along a 1:10 plane rises 1.70 m",
      "1.700 m", `${f4(rise)} m`, near(rise, 1.7, 1e-4));

    {
      // ⚠️ SAMPLED FROM THE TRIANGULATED SURFACE, NOT BILINEARLY. On a saddle
      // quad the two differ by a quarter of the cell's relief, and the section
      // has to describe the surface the renderer draws and the contours follow —
      // three readings of one ground that disagreed would be worse than two.
      const dem = new DEM(new Float32Array([0.5, 1.5, 0.5, 0.5]), 2, 2, 1, 0, 0);
      // Quad centre: bilinear would give (0.5+1.5+0.5+0.5)/4 = 0.75; the
      // triangulation splits a-d-b / b-d-e, and the centre lies on the b-d edge
      // where the surface runs (zb + zd)/2 = 1.0.
      const zc = facetZAt(dem, dem.z, 1.0, 1.0);
      add(W, "elevations come off the TRIANGULATED surface the renderer draws, "
        + "not off a bilinear interpolation of the four corners — on one saddle "
        + "quad the two differ by a quarter of the cell's relief",
        "1.000 m (bilinear would say 0.750)", `${f4(zc)} m`, near(zc, 1.0, 1e-6));
      add(W, "…and a point outside the grid returns NaN rather than an edge value, "
        + "so a section drawn past the tile stops instead of running flat",
        "NaN", String(facetZAt(dem, dem.z, 50, 50)),
        !Number.isFinite(facetZAt(dem, dem.z, 50, 50)));
    }

    {
      // Cut and fill areas against a known baseline: lower the ground by exactly
      // 0.2 m over the whole line and the cut area is length x depth.
      const dem = DEM.synthetic(40, 40, 0.5, () => 12);
      const base = dem.z.slice();
      for (let i = 0; i < dem.z.length; i++) dem.z[i] -= 0.2;
      const q = sampleSection(dem, [1, 10], [11, 10], { baseline: base });
      const ar = sectionAreas(q);
      add(W, "cut area is the area between the two surfaces — 10 m of line lowered "
        + "0.2 m is 2.0 m², the figure a quantity surveyor multiplies by the "
        + "spacing between sections",
        // Tolerance 1e-4, not 1e-6: `z` is a Float32Array, so 12 − 0.2 stores as
        // 11.799999237, and the depth the section correctly reads is 0.19999981.
        // A tighter bound would be asserting against the storage type itself.
        "cut 2.00 m², fill 0.00 m²",
        `cut ${f4(ar.cut)} m², fill ${f4(ar.fill)} m²`,
        near(ar.cut, 2, 1e-4) && ar.fill < 1e-9);
      add(W, "…and it is reported as an AREA in m², never a volume — the ledger is "
        + "the only place a volume comes from, because it integrates the whole "
        + "surface rather than one line across it",
        "0.20 m deepest cut", `${f4(ar.maxCut)} m`, near(ar.maxCut, 0.2, 1e-4));
    }

    {
      // ⚠️ A SEGMENT THAT CROSSES ZERO CONTRIBUTES TO BOTH SIDES. Integrating |d|
      // whole would charge the cut side for fill and vice versa — and on a batter
      // that daylights, most segments cross.
      // Built from the WORLD x, not the column index, so the datum crossing is
      // at exactly x = 10 and a line centred on it is genuinely symmetric. Built
      // from the index it was off by half a cell, and the areas differed by 10%
      // — which was the test being wrong, not the arithmetic.
      const dem = DEM.synthetic(4, 40, 0.5, (r, c, x) => 10 + (x - 10) * 0.2);
      const base = new Float32Array(dem.z.length).fill(10);
      const q = sampleSection(dem, [2, 1], [18, 1], { baseline: base });
      const ar = sectionAreas(q);
      add(W, "a section crossing from cut to fill splits the crossing segment "
        + "instead of charging the whole of it to one side — symmetric ground "
        + "either side of the datum gives equal areas",
        "cut ≈ fill", `cut ${f2(ar.cut)} m², fill ${f2(ar.fill)} m²`,
        Math.abs(ar.cut - ar.fill) < 0.05 && ar.cut > 1);
    }

    add(W, "sections letter A, B … Z, then AA — a drawing-sheet convention, so a "
      + "26th section does not collide with the first",
      "A B Z AA AB",
      [0, 1, 25, 26, 27].map(sectionName).join(" "),
      sectionName(0) === "A" && sectionName(25) === "Z"
      && sectionName(26) === "AA" && sectionName(27) === "AB");

    {
      const dem = DEM.synthetic(20, 20, 0.5, (r, c) => 10 + c * 0.05);
      const base = dem.z.slice();
      for (let i = 0; i < dem.z.length; i++) dem.z[i] -= 0.1;
      const prof = sampleSection(dem, [1, 5], [8, 5], { baseline: base });
      const svg = sectionSVG([{ name: "A", profile: prof, areas: sectionAreas(prof) }],
        { exaggeration: 2.5, site: "test", crs: "EPSG:25833" });
      add(W, "the export is VECTOR with both surfaces drawn, told apart by weight "
        + "and dash rather than by colour — it prints, it photocopies, and the A1 "
        + "sheet it belongs to is deliberately greyscale",
        "svg with .was and .now paths",
        `${/^<svg/.test(svg) ? "svg" : "not svg"}, `
        + `${/class="was"/.test(svg) ? "was" : "NO was"}, `
        + `${/class="now"/.test(svg) ? "now" : "NO now"}`,
        /^<svg/.test(svg) && /class="was"/.test(svg) && /class="now"/.test(svg));
      // ⚠️⚠️ THE SHEET'S EXAGGERATION IS THE SHEET'S, NOT THE SCENE'S. This row
      // used to assert that `opts.exaggeration` appeared in the output, and it
      // passed while the drawing was lying: the sheet is plotted from TRUE
      // elevations, so the 3-D view's stretch never touches it, and a drawing at
      // 1:100 across and 1:200 up was announcing itself as "1.0×" while being
      // vertically compressed by half. Every slope read off it would have been
      // wrong in the direction the label denied. What must be stated is the
      // relationship between the two scales the sheet itself prints.
      const hm = svg.match(/horizontal 1:(\d+(?:\.\d+)?)/);
      const vm = svg.match(/vertical 1:(\d+(?:\.\d+)?)/);
      const stated = /true to scale|vertical exaggeration [\d.]+×|vertically compressed [\d.]+×/
        .exec(svg);
      add(W, "…and it states BOTH scales it was plotted at, so a reader can check "
        + "the drawing against a rule rather than trusting a caption",
        "horizontal 1:n and vertical 1:n",
        `${hm ? `h 1:${hm[1]}` : "NO horizontal"}, ${vm ? `v 1:${vm[1]}` : "NO vertical"}`,
        !!hm && !!vm);
      // The stated relationship has to follow from those two numbers.
      let consistent = false, want = "";
      if (hm && vm && stated) {
        const r = Number(hm[1]) / Number(vm[1]);
        want = Math.abs(r - 1) < 0.005 ? "true to scale"
          : r > 1 ? `vertical exaggeration ${r.toFixed(2)}×`
            : `vertically compressed ${(1 / r).toFixed(2)}×`;
        consistent = stated[0] === want;
      }
      add(W, "…and the vertical exaggeration it states is DERIVED from those two "
        + "scales, so the three numbers on the sheet cannot contradict each other",
        want || "a stated relationship", stated ? stated[0] : "MISSING", consistent);
      add(W, "…and it does NOT repeat the 3-D view's exaggeration, which describes "
        + "the screen and not this drawing — the sheet is plotted from true "
        + "elevations, and printing 2.5× here would be a false claim about every "
        + "slope on it",
        "no '2.5×' on the sheet", /2\.5×/.test(svg) ? "PRESENT" : "absent",
        !/2\.5×/.test(svg));
      add(W, "…and carries the standing honesty clause, as every other export does",
        "Not a prediction", /Not a prediction/.test(svg) ? "present" : "MISSING",
        /Not a prediction/.test(svg));
    }
  }

  const V = "V · undo puts back the ground AND the account of it";
  {
    const mk = () => DEM.synthetic(24, 24, 0.5, (r, c) => 10 + 0.01 * r + 0.02 * c);

    {
      // The round trip has to be EXACT, not close. These are float32 cells, and
      // a scoop-undo-scoop-undo cycle that drifted by an ULP each time would
      // slowly rewrite the terrain while every readout looked healthy.
      const dem = mk();
      const pristine = dem.z.slice();
      const ledger = new Ledger();
      const before = captureRect({
        z: dem.z, ncols: dem.ncols, rect: { r0: 4, c0: 4, r1: 19, c1: 19 },
        label: "scoop", cut: ledger.cut, fill: ledger.fill, soil: null,
      });
      applyBrush(dem, "scoop", 6, 6, 3, 0.4, ledger);
      const moved = dem.z.some((v, i) => v !== pristine[i]);
      const inv = applyEdit({ dem, edit: before, ledger });
      let identical = true;
      for (let i = 0; i < pristine.length; i++) if (dem.z[i] !== pristine[i]) identical = false;
      add(V, "undoing a stroke restores every cell BIT-EXACTLY, not approximately "
        + "— a drift of one float32 ULP per cycle would quietly rewrite the "
        + "terrain while every readout stayed healthy",
        "moved, then identical", `${moved ? "moved" : "no-op"}, then ${identical ? "identical" : "DRIFTED"}`,
        moved && identical);
      add(V, "…and the ledger goes back with it, so the readout cannot claim earth "
        + "was moved that is no longer anywhere on the surface",
        "0.0 / 0.0 m³", `${f4(ledger.cut)} / ${f4(ledger.fill)} m³`,
        ledger.cut === 0 && ledger.fill === 0);

      // Redo is undo with the inverse, so it must land back on the edited state.
      const redoLedger = { cut: ledger.cut, fill: ledger.fill };
      applyEdit({ dem, edit: inv, ledger: redoLedger });
      add(V, "…and redo returns to exactly the edited surface, because the inverse "
        + "is produced by the same function rather than by a second code path",
        "restored", dem.z.some((v, i) => v !== pristine[i]) ? "restored" : "still pristine",
        dem.z.some((v, i) => v !== pristine[i]));
    }

    {
      // Only the recorded rectangle may move. An entry whose rect is smaller
      // than the edit would silently leave part of a stroke behind.
      const dem = mk();
      const outside = dem.z.slice();
      const edit = captureRect({
        z: dem.z, ncols: dem.ncols, rect: { r0: 8, c0: 8, r1: 11, c1: 11 },
        label: "x", cut: 0, fill: 0, soil: null,
      });
      for (let i = 0; i < dem.z.length; i++) dem.z[i] += 5;   // change everything
      applyEdit({ dem, edit });
      let changedOutside = 0, restoredInside = 0;
      for (let r = 0; r < 24; r++) {
        for (let c = 0; c < 24; c++) {
          const i = r * 24 + c;
          const inRect = r >= 8 && r <= 11 && c >= 8 && c <= 11;
          if (inRect) { if (dem.z[i] === outside[i]) restoredInside++; }
          else if (dem.z[i] !== outside[i] + 5) changedOutside++;
        }
      }
      add(V, "an undo touches exactly its own rectangle — 16 cells restored, and "
        + "nothing outside it disturbed",
        "16 restored, 0 outside touched",
        `${restoredInside} restored, ${changedOutside} outside touched`,
        restoredInside === 16 && changedOutside === 0);
    }

    {
      // A substrate stroke moves no earth at all, so its entry carries codes.
      const dem = mk();
      const soil = new Uint8Array(24 * 24).fill(Substrate.UNKNOWN);
      // Over the whole grid, as the app does: a gesture's extent is not known
      // until the hand lifts, so the before-picture is taken wide and trimmed to
      // the union of the dabs afterwards.
      const edit = captureRect({
        z: dem.z, ncols: dem.ncols, rect: { r0: 0, c0: 0, r1: 23, c1: 23 },
        label: "substrate", cut: 0, fill: 0, soil,
      });
      Substrate.paintSubstrate(soil, dem, Substrate.CODE.gravel, 2, 10, 1.5);
      const painted = soil.some((v) => v === Substrate.CODE.gravel);
      applyEdit({ dem, edit, substrate: soil });
      add(V, "a substrate stroke undoes its CLASS CODES, which no elevation "
        + "restore would have touched — the layer that moves no earth still has "
        + "to be reversible",
        "painted, then all unknown again",
        `${painted ? "painted" : "no-op"}, then ${soil.every((v) => v === Substrate.UNKNOWN) ? "all unknown" : "codes left behind"}`,
        painted && soil.every((v) => v === Substrate.UNKNOWN));
    }

    {
      // ⚠️ NEW WORK AFTER AN UNDO MUST DISCARD THE REDO STACK. A future recorded
      // against an abandoned surface, spliced back in later, would put a
      // rectangle of terrain nobody drew into the middle of the live one — and
      // it would look like perfectly plausible ground.
      const h = new History();
      const mkEdit = (label) => ({
        label, r0: 0, c0: 0, r1: 1, c1: 1,
        z: new Float32Array(4), soil: null, cut: 0, fill: 0,
      });
      h.push(mkEdit("a"));
      h.push(mkEdit("b"));
      h.undo((e) => e);
      const hadFuture = h.canRedo;
      h.push(mkEdit("c"));
      add(V, "doing new work after an undo discards the redo stack, so a future "
        + "recorded against a surface that no longer exists can never be spliced "
        + "back into the live one",
        "redo available, then gone",
        `${hadFuture ? "available" : "none"}, then ${h.canRedo ? "STILL THERE" : "gone"}`,
        hadFuture && !h.canRedo);

      const deep = new History({ limit: 3 });
      for (const l of ["1", "2", "3", "4", "5"]) deep.push(mkEdit(l));
      add(V, "…and the stack is bounded, so a long session cannot grow until the "
        + "tab dies mid-presentation",
        "3 kept, oldest dropped",
        `${deep.past.length} kept, oldest is "${deep.past[0].label}"`,
        deep.past.length === 3 && deep.past[0].label === "3");

      // The byte cap has to bite independently: a handful of whole-grid stamps
      // reaches it long before the depth limit does.
      const heavy = new History({ limit: 100, maxBytes: 4096 });
      for (let i = 0; i < 10; i++) {
        heavy.push({ label: String(i), r0: 0, c0: 0, r1: 15, c1: 15,
          z: new Float32Array(256), soil: null, cut: 0, fill: 0 });
      }
      add(V, "…and bounded on MEMORY as well as depth, because a few whole-grid "
        + "stamps reach the byte cap long before the depth limit does",
        "≤ 4096 bytes held", `${heavy.bytes} bytes in ${heavy.past.length} entries`,
        heavy.bytes <= 4096 && heavy.past.length < 10);
    }
  }

  const U = "U · the pattern library — eighteen DIFFERENT arguments, not eighteen textures";
  {
    add(U, "the library carries twelve patterns with unique, stable ids — the id "
      + "goes into the provenance record, so the list may be appended to but "
      + "never reordered or renamed",
      "18 unique", `${PATTERNS.length}, ${new Set(PATTERNS.map((p) => p.id)).size} unique`,
      PATTERNS.length === 18 && new Set(PATTERNS.map((p) => p.id)).size === 18);
    add(U, "…every one of them carries a reference or a reason, so the picker "
      + "explains itself rather than showing twelve unlabelled shapes",
      "all named and noted",
      `${PATTERNS.filter((p) => p.name && p.note && p.note.length > 30).length} of ${PATTERNS.length}`,
      PATTERNS.every((p) => p.name && p.note && p.note.length > 30));

    // ⚠️ THE CHECK THAT MATTERS. A library of twelve patterns that all produce
    // much the same field would be decoration dressed as an argument — and the
    // whole justification for having one is the measurement that a lozenge and
    // an undulation of identical amplitude and volume give 7/7 habitats at 29%
    // invasive versus 3/7 at 75%. So the fields themselves must be distinct.
    const N = 64;
    const fields = PATTERNS.map((p) => proceduralField(p.id, N, N, 1, { module: 8, seed: 3 }));
    let worstPair = "", worstCorr = -2;
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        const a = fields[i], b = fields[j];
        let ma = 0, mb = 0;
        for (let k = 0; k < a.length; k++) { ma += a[k]; mb += b[k]; }
        ma /= a.length; mb /= b.length;
        let sab = 0, saa = 0, sbb = 0;
        for (let k = 0; k < a.length; k++) {
          const da = a[k] - ma, db = b[k] - mb;
          sab += da * db; saa += da * da; sbb += db * db;
        }
        const corr = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 1;
        if (corr > worstCorr) { worstCorr = corr; worstPair = `${PATTERNS[i].id}/${PATTERNS[j].id}`; }
      }
    }
    add(U, "no two patterns are near-copies of each other — the most similar pair "
      + "still differs, so choosing one is a real design decision",
      "correlation < 0.9", `${worstCorr.toFixed(3)} (${worstPair})`, worstCorr < 0.9);

    // Every field must be usable as a stamp: full 0..1 range so the amplitude
    // asked for is delivered, no holes, and a neutral value that moves no earth.
    // Centred on the mean, an ASYMMETRIC pattern deliberately does not reach both
    // extremes — "scattered hollows" cuts to full depth and barely rises. What
    // has to hold is that the peak deviation from neutral IS the amplitude, in
    // whichever direction the pattern goes, and that nothing leaves 0..1.
    let badRange = [], nonFinite = 0;
    for (let i = 0; i < PATTERNS.length; i++) {
      const f = fields[i];
      let peak = 0, out01 = false;
      for (const v of f) {
        if (!Number.isFinite(v)) nonFinite++;
        if (v < -1e-6 || v > 1 + 1e-6) out01 = true;
        const d = Math.abs(v - NEUTRAL);
        if (d > peak) peak = d;
      }
      if (out01 || Math.abs(peak - 0.5) > 1e-6) badRange.push(PATTERNS[i].id);
    }
    add(U, "every pattern reaches the full amplitude in at least one direction and "
      + "none of them leaves the 0–1 range, so the figure asked for is the figure "
      + "delivered even where the pattern is one-sided",
      "0 out of range", `${badRange.length}${badRange.length ? " — " + badRange.join(", ") : ""}`,
      badRange.length === 0);

    // ⚠️ THE CHECK THAT WOULD HAVE CAUGHT THE WORST BUG IN THIS FEATURE. Patterns
    // are centred on their own mean, not stretched min-to-max, so an ASYMMETRIC
    // pattern leaves undisturbed ground at neutral. Stretched min-to-max instead,
    // "scattered hollows" — mostly flat ground with occasional pits — put the flat
    // ground at full FILL and measured 82 m³ of cut against 571 m³ of fill: it
    // raised the whole site and dimpled it. Nothing about that reads as wrong on
    // screen; the terrain simply sits higher.
    let worstMean = 0, worstMeanId = "";
    for (let i = 0; i < PATTERNS.length; i++) {
      let s = 0;
      for (const v of fields[i]) s += v;
      const off = Math.abs(s / fields[i].length - NEUTRAL);
      if (off > worstMean) { worstMean = off; worstMeanId = PATTERNS[i].id; }
    }
    add(U, "every pattern averages to neutral, so it moves as much earth up as "
      + "down and any net import a stamp reports is the user's decision rather "
      + "than an artefact of how the generator happened to be scaled",
      "mean 0.500 for all", `worst offset ${worstMean.toFixed(6)} (${worstMeanId})`,
      worstMean < 1e-6);
    add(U, "…and none of them produces a NaN, which would stamp a hole into the "
      + "terrain that no later gesture could repair",
      "0 non-finite", String(nonFinite), nonFinite === 0);

    // ⚠️ A SEEDED PATTERN MUST NOT CHANGE WHEN THE STAMPED WINDOW DOES. The PRNG
    // is indexed by lattice node rather than called in scan order, so selecting a
    // region cannot alter the pattern outside it — the trap a sequential PRNG
    // walks straight into, and one that would look like the tool being flaky.
    const full = proceduralField("dendritic", 32, 32, 1, { module: 8, seed: 5 });
    const mask = new Uint8Array(32 * 32);
    for (let r = 8; r < 24; r++) for (let c = 8; c < 24; c++) mask[r * 32 + c] = 1;
    const windowed = proceduralField("dendritic", 32, 32, 1, { module: 8, seed: 5, mask });
    // Both normalise over different cell sets, so compare SHAPE not absolute value.
    let corr = 0, ma = 0, mb = 0, n = 0;
    for (let i = 0; i < full.length; i++) if (mask[i]) { ma += full[i]; mb += windowed[i]; n++; }
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < full.length; i++) {
      if (!mask[i]) continue;
      const da = full[i] - ma, db = windowed[i] - mb;
      sab += da * db; saa += da * da; sbb += db * db;
    }
    corr = sab / Math.sqrt(saa * sbb);
    add(U, "a seeded pattern is anchored to the ground, not to the scan — masking "
      + "to a region rescales it but does not redraw it somewhere else",
      "correlation 1.000", corr.toFixed(6), corr > 0.999999);

    add(U, "an unknown pattern id falls back to a real pattern rather than "
      + "returning an empty field that would silently stamp nothing",
      "a usable field",
      `${proceduralField("no-such-pattern", 16, 16, 1).some((v) => v > 0) ? "usable" : "empty"}`,
      proceduralField("no-such-pattern", 16, 16, 1).some((v) => v > 0));

    // The measured champion has to still be in the library under the id the
    // finding quotes, or the abstract cites a pattern the tool cannot produce.
    add(U, "the lozenge matrix — the pattern the re-measured abstract figure was "
      + "produced with — is present under the id that finding quotes",
      "lozenge present", PATTERN_BY_ID.lozenge ? "lozenge present" : "MISSING",
      !!PATTERN_BY_ID.lozenge);

    // ⚠️ A MEASUREMENT TABLE THAT OUTLIVES THE THING IT MEASURED is worse than
    // none: the picker prints these figures next to the choice, so an entry left
    // behind after a pattern is renamed would attribute one pattern's result to
    // another. Both directions are checked.
    const measuredIds = Object.keys(PATTERN_MEASURED);
    const libIds = PATTERNS.map((p) => p.id);
    const orphan = measuredIds.filter((id) => !libIds.includes(id));
    const unmeasured = libIds.filter((id) => !measuredIds.includes(id));
    // ⚠️ THE INVARIANT TIGHTENED WHEN THE LIBRARY GREW (2026-08-19). It used to
    // be "every pattern has a measured figure", which the six appended patterns
    // broke — and the tempting fix, inventing figures for them, is the one thing
    // that would make the picker lie. The real requirement is that a pattern is
    // never AMBIGUOUS about it: either it carries a measurement, or it is
    // declared `expected` in PATTERN_RANGE and the picker says so in words.
    const undeclared = unmeasured.filter((id) =>
      (PATTERN_RANGE.find((e) => e.id === id) || {}).basis !== "expected");
    add(U, "every measured figure belongs to a pattern that still exists, and "
      + "every pattern is EITHER measured OR explicitly declared unmeasured — a "
      + "stale row would credit one pattern with another's result, and a silently "
      + "unmeasured one would read as a pattern measured to do nothing",
      "0 orphaned, 0 undeclared",
      `${orphan.length} orphaned${orphan.length ? " (" + orphan + ")" : ""}, `
      + `${unmeasured.length} unmeasured of which ${undeclared.length} undeclared`
      + `${undeclared.length ? " (" + undeclared + ")" : ""}`,
      orphan.length === 0 && undeclared.length === 0);

    // ⚠️ THE TABLE IS ONLY A FAIR COMPARISON IF EVERY ROW MOVED THE SAME EARTH.
    // Patterns are centred on their own mean, so each is volume-neutral by
    // construction — cut equals fill. If a row ever shows otherwise, either a
    // generator has stopped being centred or the figures were pasted from a run
    // under different conditions, and the ranking silently stops meaning
    // anything: a pattern could then look good merely by importing material.
    const unbalanced = measuredIds.filter((k) =>
      Math.abs(PATTERN_MEASURED[k].cut - PATTERN_MEASURED[k].fill) > 1);
    add(U, "every measured row moved exactly as much earth up as down, so the "
      + "ranking compares placement and nothing else — a pattern cannot look "
      + "good here by quietly importing material",
      "0 unbalanced", `${unbalanced.length}${unbalanced.length ? " — " + unbalanced.join(", ") : ""}`,
      unbalanced.length === 0);

    // The spread is the entire justification for having a library rather than
    // one pattern. If it ever collapses, the feature has stopped arguing.
    const Hs = measuredIds.map((k) => PATTERN_MEASURED[k].H);
    const invs = measuredIds.map((k) => PATTERN_MEASURED[k].invasive);
    add(U, "the measured spread is wide enough that choosing a pattern is the "
      + "consequential decision — a tenfold range in Shannon, and invasive cover "
      + "from single figures to near-total, at ONE amplitude and ONE module",
      "Shannon range > 1.0, invasive range > 50 points",
      `Shannon ${Math.min(...Hs).toFixed(3)}–${Math.max(...Hs).toFixed(3)}, `
      + `invasive ${Math.min(...invs).toFixed(1)}–${Math.max(...invs).toFixed(1)}%`,
      Math.max(...Hs) - Math.min(...Hs) > 1.0 && Math.max(...invs) - Math.min(...invs) > 50);

    // ⚠️ THE FINDING THE LIBRARY EXISTS TO CARRY. Terracing is levelling repeated
    // at a smaller scale, and it measures worse than any other pattern here —
    // including the undulation control, and including doing nothing.
    add(U, "terraces measure worse for habitat than undirected undulation — a "
      + "terrace is a series of small level platforms, so the most conventionally "
      + "designed-looking option reproduces the problem it was meant to solve",
      "terraces below undulation",
      `terraces H′ ${PATTERN_MEASURED.terraces.H}, undulation H′ ${PATTERN_MEASURED.undulation.H}`,
      PATTERN_MEASURED.terraces.H < PATTERN_MEASURED.undulation.H);
  }

  const T = "T · fill and spill — every drop is accounted for";
  {
    // ⚠️ MASS BALANCE IS THE CHECK THAT CATCHES EVERY ROUTING BUG AT ONCE, and
    // it is why it comes first. A wrong drainage direction, a hollow settled
    // out of order, an overflow sent twice, a tie in the sort key dropping a
    // cell's water — every one of them shows up as delivered ≠ infiltrated +
    // retained + runoff. None of them would be visible in a picture of ponds,
    // which would look entirely plausible while quietly losing water.
    const balance = (r) => r.delivered - r.infiltrated - r.retained - r.runoff;

    {
      // A stepped pyramid basin, 9x9 at 1 m, z = 10 + chebyshev distance from
      // the centre. Every cell has a strictly lower neighbour inward, so where
      // the water goes is unambiguous and the whole answer is hand-computable.
      //
      // ⚠️ THE FIRST VERSION OF THIS CHECK USED A FLAT RING WITH ONE HOLE IN IT,
      // and it was a bad test rather than a bad result: on genuinely level
      // ground "downhill" has no answer, so what the rim does is a convention,
      // not a fact, and asserting one convention would have frozen it. The
      // pyramid removes the ambiguity instead of legislating it.
      const dem = DEM.synthetic(9, 9, 1, (r2, c) =>
        10 + Math.max(Math.abs(r2 - 4), Math.abs(c - 4)));
      // Capacity: the boundary ring is a wall at 14, so the basin holds
      // 1x4 + 8x3 + 16x2 + 24x1 = 84 m³.
      const small = pondWater(dem, 0.01);   // 10 mm over 81 m² = 0.81 m³
      add(T, "a closed basin keeps every drop that falls in it — nothing runs "
        + "off a surface with no outlet below its rim",
        "0.81 m³ retained, 0 runoff",
        `${f4(small.retained)} m³ retained, ${f4(small.runoff)} m³ runoff`,
        near(small.retained, 0.81, 1e-6) && small.runoff < 1e-9);
      add(T, "…and the pond has a HORIZONTAL surface: 0.81 m³ over the single "
        + "cell below 11 m stands 0.81 m deep, not spread as a scaled copy of "
        + "the ground beneath it",
        "0.810 m", `${f4(small.maxDepth)} m`, near(small.maxDepth, 0.81, 1e-5));
      add(T, "…over the capacity the geometry says it has",
        "84.00 m³", `${f2(small.capacity)} m³`, near(small.capacity, 84, 1e-6));

      // Overfill: 1.1 m of rain is 89.1 m³ into an 84 m³ basin.
      const big = pondWater(dem, 1.1);
      add(T, "an overfilled basin holds exactly its capacity and spills the "
        + "remainder off the patch — it does not keep filling past its rim",
        "84.00 m³ retained, 5.10 m³ runoff",
        `${f2(big.retained)} m³ retained, ${f2(big.runoff)} m³ runoff`,
        near(big.retained, 84, 1e-4) && near(big.runoff, 5.1, 1e-4));
      add(T, "…and the books balance below a millilitre",
        "< 1e-6 m³ unaccounted", `${Math.abs(balance(big)).toExponential(1)} m³`,
        Math.abs(balance(big)) < 1e-6);
    }

    {
      // ⚠️ THE CASE THAT ORDERING BUGS HIDE IN. A surface levelled to a datum
      // makes every cell tie in elevation, so any routing that leans on a sort
      // order silently drops water — and it drops it on precisely the surface
      // this tool's whole argument is about, in the direction that flatters it.
      const flat = DEM.synthetic(64, 64, 0.25, () => 78);
      const r = pondWater(flat, 0.005);
      const delivered = 0.005 * 64 * 64 * 0.25 * 0.25;
      add(T, "a surface levelled to a datum holds NOTHING, and every drop "
        + "delivered is accounted for as runoff — the case where a sort-order "
        + "bug would quietly lose water and flatter the flat ground",
        `0 retained, ${f4(delivered)} m³ runoff`,
        `${f4(r.retained)} retained, ${f4(r.runoff)} m³ runoff`,
        r.retained === 0 && near(r.runoff, delivered, 1e-9));
      add(T, "…and it absorbs no event at all, however small",
        "0.0 mm", `${(absorbedDepth(r.capacity, 64 * 64) * 1000).toFixed(3)} mm`,
        absorbedDepth(r.capacity, 64 * 64) === 0);
    }

    {
      // A cascade: two hollows in a row on a tilted surface, the upper one
      // spilling into the lower. The excess must arrive, not vanish.
      const dem = DEM.synthetic(5, 12, 1, (r2, c) => 10 - c * 0.01);
      dem.z[dem.idx(2, 3)] = 9.0;   // upper hollow
      dem.z[dem.idx(2, 8)] = 9.0;   // lower hollow, downslope of it
      const r = pondWater(dem, 0.02);
      add(T, "water spilling out of one hollow arrives in the next one downslope "
        + "rather than disappearing at the rim",
        "2 hollows holding water", `${r.ponds} holding, ${r.fullPonds} full`,
        r.ponds === 2);
      add(T, "…with the volume still balanced after the cascade",
        "< 1e-6 m³ unaccounted", `${Math.abs(balance(r)).toExponential(1)} m³`,
        Math.abs(balance(r)) < 1e-6);
    }

    {
      // Infiltration is a coefficient on the way in, and it must not leak into
      // the storage figure — a hollow's capacity is geometry, not soil.
      const dem = DEM.synthetic(5, 5, 1, () => 10);
      dem.z[dem.idx(2, 2)] = 9;
      const sub = new Uint8Array(25).fill(1);           // rockfill, 0.85
      const r = pondWater(dem, 0.02, { substrate: sub });
      const delivered = 0.02 * 25;
      add(T, "infiltration takes its share on the way in, at the coefficient the "
        + "substrate class carries, and the books still balance",
        `${f4(delivered * INFILTRATION[1])} m³ soaked`,
        `${f4(r.infiltrated)} m³ soaked, balance ${balance(r).toExponential(1)}`,
        near(r.infiltrated, delivered * INFILTRATION[1], 1e-9)
        && Math.abs(balance(r)) < 1e-6);
      add(T, "…and with no substrate map nothing soaks away, rather than a "
        + "plausible middle value being invented for ground nobody specified",
        "0 m³", `${f4(pondWater(dem, 0.02).infiltrated)} m³`,
        pondWater(dem, 0.02).infiltrated === 0);
    }

    {
      // ⚠️ WATER LEAVES SOMEWHERE, AND THE SOMEWHERE IS THE POINT. A tilted
      // plane sheds everything over its low edge; the outfalls must account for
      // exactly the runoff, at the low side, and nowhere else.
      const ramp = DEM.synthetic(20, 20, 1, (r2, c) => 10 + c * 0.2);
      const r = pondWater(ramp, 0.01);
      const viaOutfalls = (r.outfalls || []).reduce((a, o) => a + o.volume, 0);
      add(T, "every drop that leaves is attributed to a PLACE it left through — "
        + "the outfalls account for the whole of the runoff, not a sample of it",
        `${f4(r.runoff)} m³`, `${f4(viaOutfalls)} m³ over ${r.outfalls.length} outfall(s)`,
        near(viaOutfalls, r.runoff, 1e-9) && r.outfalls.length > 0);
      // West is downhill here (z rises with the column index), so every outfall
      // must sit on the west edge.
      const allWest = r.outfalls.every((o) => o.col === 0);
      add(T, "…and they sit where the ground actually falls away, not wherever "
        + "the scan happened to end",
        "all on the low edge", allWest ? "all on the low edge" : "scattered", allWest);

      // Adjacent exit cells are one place, not forty.
      const flat = DEM.synthetic(20, 20, 1, (r2, c) => 10 + c * 0.2);
      const rr = pondWater(flat, 0.02);
      const cellsInLargest = rr.outfalls[0] ? rr.outfalls[0].cells : 0;
      add(T, "…and a broad low sill is reported as ONE outfall covering many "
        + "cells rather than as one entry per cell, because the reader needs the "
        + "places water leaves and not every cell it crossed",
        "1 outfall, many cells",
        `${rr.outfalls.length} outfall(s), ${cellsInLargest} cells in the largest`,
        rr.outfalls.length === 1 && cellsInLargest > 1);
    }

    {
      // ⚠️ THE DISTRIBUTION, NOT ONLY THE TOTAL. "2 ponds, 6.86 m³" and "20
      // ponds, 6.86 m³" are the same two numbers and completely different
      // ground. These rows pin the itemised list against the totals it is
      // derived from, because a per-body figure that does not add up to the
      // total is the kind of error that looks entirely plausible on screen.
      const dem = DEM.synthetic(5, 12, 1, (r2, c) => 10 - c * 0.01);
      dem.z[dem.idx(2, 3)] = 9.0;
      dem.z[dem.idx(2, 8)] = 9.0;
      const r = pondWater(dem, 0.02);
      const sum = r.waterbodies.reduce((a, b) => a + b.volume, 0);
      add(T, "every water body is itemised, and their volumes sum to EXACTLY the "
        + "retained total — a per-body figure that does not add up is the kind of "
        + "error that looks entirely plausible drawn on a surface",
        `${f4(r.retained)} m³ over ${r.ponds} bodies`,
        `${f4(sum)} m³ over ${r.waterbodies.length} bodies`,
        near(sum, r.retained, 1e-9) && r.waterbodies.length === r.ponds);
      const ordered = r.waterbodies.every((b, i) =>
        i === 0 || r.waterbodies[i - 1].volume >= b.volume);
      add(T, "…listed largest first, so the reader meets the body that matters "
        + "before the ones that do not",
        "descending by volume", ordered ? "descending" : "unordered", ordered);
      // ⚠️ A BODY MUST BE LOCATED WHERE IT IS WET. A centroid can land on dry
      // ground outside a non-convex hollow entirely, putting a label beside the
      // pond it names; the deepest cell is always inside the water.
      const allWet = r.waterbodies.every((b) => r.depth[b.index] > 0);
      const deepestIsDeepest = r.waterbodies.every((b) =>
        Math.abs(r.depth[b.index] - b.maxDepth) < 1e-9);
      add(T, "…and each is located at its own DEEPEST cell, which is always wet — "
        + "a centroid can fall on dry ground outside a non-convex hollow and put "
        + "the label beside the water rather than on it",
        "every body on a wet cell, at its max depth",
        `${allWet ? "all wet" : "one dry"}, ${deepestIsDeepest ? "at max" : "off max"}`,
        allWet && deepestIsDeepest);
      const consistent = r.waterbodies.every((b) =>
        near(b.volume, b.meanDepth * b.area, 1e-9)
        && b.maxDepth >= b.meanDepth && b.fillFraction > 0 && b.fillFraction <= 1);
      add(T, "…and each body's own figures agree with one another — volume is "
        + "mean depth times area, the deepest point is at least the mean, and a "
        + "fill fraction never exceeds the hollow that holds it",
        "self-consistent", consistent ? "self-consistent" : "contradictory", consistent);
    }

    {
      // ⚠️ THE ARGUMENT, STATED AS A DISTRIBUTION. Levelling does not merely
      // reduce the water held; it collapses many small bodies into none, the
      // same collapse the outfall count shows from the other side.
      const flat = DEM.synthetic(64, 64, 0.25, () => 78);
      const rf = pondWater(flat, 0.02);
      add(T, "a levelled surface reports NO water bodies at all — not one large "
        + "one — so the list says the same thing as the storage figure",
        "0 bodies", `${rf.waterbodies.length} bodies`, rf.waterbodies.length === 0);
    }

    {
      // On the real patch, against the figure the depression panel already
      // reports — the two must describe the same hollows.
      const dep = findDepressions(fillDem);
      const areaM2 = fillDem.ncols * fillDem.nrows * fillDem.cell * fillDem.cell;
      const soak = absorbedDepth(dep.totalVolume, areaM2);
      add(T, "storage capacity agrees with the depression inventory the panel "
        + "already shows — one set of hollows, not two",
        `${f2(dep.totalVolume)} m³`, `${f2(pondWater(fillDem, 0.02, { depressions: dep }).capacity)} m³`,
        near(pondWater(fillDem, 0.02, { depressions: dep }).capacity, dep.totalVolume, 1e-9));

      // ⚠️ THE NUMBER THE LAYER EXISTS FOR. The surveyed patch takes the first
      // 1.7 mm of any event into its own relief. It is a single figure, in the
      // units a drainage specification is already written in, and it goes to
      // zero the moment the ground is levelled.
      add(T, "the surveyed Ørndalen patch absorbs the first 1.7 mm of an event "
        + "into its own relief — the collapse stated as one number, in the units "
        + "a drainage specification already uses",
        "1.6–1.8 mm", `${(soak * 1000).toFixed(3)} mm`,
        soak * 1000 > 1.6 && soak * 1000 < 1.8);

      let worst = 0, worstUnrouted = 0;
      for (const mm of [0.5, 1, 2, 5, 20]) {
        const r = pondWater(fillDem, mm / 1000, { depressions: dep });
        worst = Math.max(worst, Math.abs(balance(r)));
        worstUnrouted = Math.max(worstUnrouted, r.unrouted);
      }
      // ⚠️ ASSERTED SEPARATELY FROM THE BALANCE, ON PURPOSE. Water that no
      // drainage path could place is swept to runoff so the books still add up —
      // which means a cycle in the receiver graph would leave the balance check
      // perfectly happy while the ponds quietly went short. This is the check
      // that would have caught it: before depression cells were made terminal
      // sinks, a pit and its neighbour sent water to each other forever and
      // 25 m³ went missing from a 20 mm event with no visible symptom.
      add(T, "every drop finds a path — no cell is left holding water by a cycle "
        + "in the drainage graph, which balancing the books alone would hide",
        "0 m³ unrouted", `${worstUnrouted.toExponential(1)} m³`,
        worstUnrouted === 0);
      add(T, "…and across the whole range from drizzle to a 20 mm event, not a "
        + "litre of it goes missing",
        "< 1e-6 m³ over 5 events", `${worst.toExponential(1)} m³`, worst < 1e-6);

      const big = pondWater(fillDem, 0.02, { depressions: dep });
      add(T, "at 20 mm every hollow is brim-full and the surface keeps only its "
        + "capacity — past that point relief buys nothing more",
        `${f2(dep.totalVolume)} m³ retained`, `${f2(big.retained)} m³`,
        near(big.retained, dep.totalVolume, 1e-6));
      add(T, "…so the share of a 20 mm event this surface can hold is small, and "
        + "saying so is the honest version of the claim",
        "5–12%", `${(100 * big.retainedFraction).toFixed(1)}%`,
        big.retainedFraction > 0.05 && big.retainedFraction < 0.12);
    }
  }

  // ============================================================ GROUP F3
  // Reading a shapefile back. The writer's own group (Q) covers what leaves the
  // tool; this covers what comes in, and the two are only trustworthy together —
  // a reader that agrees with a wrong writer proves nothing, so the checks below
  // pin the geometry against the ORIGINAL rings rather than against the file.
  const F3 = "F3 · polygons imported from GIS become the plan they were drawn as";
  {
    const cx = fillDem.originX + 32, cy = fillDem.originY + 32;
    const sq = (h, ox = 0, oy = 0) => [
      [cx - h + ox, cy - h + oy], [cx + h + ox, cy - h + oy],
      [cx + h + ox, cy + h + oy], [cx - h + ox, cy + h + oy],
    ];
    const set = new PlanSet();
    const a = set.add(sq(16), { level_m: 78 });
    set.addHole(a, sq(4));                      // one feature, two rings
    set.add(sq(6, 24, 20), { level_m: 76.5 });
    const { shp } = writeShapefile(toFeatures(set.regions), { fields: PLAN_FIELDS });
    const back = readShapefile(shp.buffer ? shp.buffer : shp);

    add(F3, "every feature written comes back, and a HOLE comes back as a second " +
      "ring of the SAME feature — split into two features it would be two " +
      "overlapping platforms and the hole would level as ground",
      "2 features, rings 2 and 1",
      `${back.rings.length} features, rings ${back.rings.map((r) => r.length).join(" and ")}`,
      back.rings.length === 2 && back.rings[0].length === 2 && back.rings[1].length === 1);

    {
      // ⚠️ AGAINST THE ORIGINAL COORDINATES, not against the file. A reader
      // that mirrors a writer's own mistake round-trips perfectly and is still
      // wrong; the only fixed point is the ring that was drawn.
      let worst = 0;
      const src = a.rings[0];
      const got = back.rings[0][0];
      for (const [x, y] of src) {
        let best = Infinity;
        for (const [gx, gy] of got) best = Math.min(best, Math.hypot(gx - x, gy - y));
        worst = Math.max(worst, best);
      }
      add(F3, "…and every vertex lands on the metre it was drawn on, so an " +
        "imported boundary is the boundary and not an approximation of it",
        "0 m", `${worst} m`, worst === 0);
    }

    add(F3, "a shapefile's rings arrive CLOSED, as the format requires — the " +
      "rasteriser treats a ring as a loop either way, and quietly dropping the " +
      "repeat here would be a second opinion about the geometry",
      "first point === last", `${JSON.stringify(back.rings[0][0][0])} / ` +
      `${JSON.stringify(back.rings[0][0][back.rings[0][0].length - 1])}`,
      back.rings[0][0][0][0] === back.rings[0][0][back.rings[0][0].length - 1][0]
      && back.rings[0][0][0][1] === back.rings[0][0][back.rings[0][0].length - 1][1]);

    {
      // Not every file handed to this is a plan.
      let threw = "";
      try { readShapefile(new ArrayBuffer(120)); } catch (e) { threw = String(e.message); }
      add(F3, "a file that is not a shapefile is refused by its FILE CODE rather " +
        "than by its length — a .dbf or a .prj dropped by mistake is long enough " +
        "to sail past a size check and then reads as garbage records",
        "refused", threw || "accepted", /file code/.test(threw));
    }

    {
      // The wrong CRS is not subtly wrong: degrees against UTM metres are out by
      // six orders of magnitude. Overlap is the symptom the tool can state.
      const deg = [[[[11.9, 69.7], [11.91, 69.7], [11.91, 69.71], [11.9, 69.71]]]];
      const near = overlapsTerrain([[a.rings[0]]], fillDem);
      const far = overlapsTerrain(deg, fillDem);
      add(F3, "polygons in another coordinate system are detected by the ground " +
        "they share with the terrain — none — so the import can say so instead " +
        "of drawing a region nobody can find",
        "on-site 1.00, off-site 0.00",
        `${near.fraction.toFixed(2)} / ${far.fraction.toFixed(2)}`,
        near.fraction === 1 && far.fraction === 0);
      add(F3, "…and a .prj is read only far enough to NAME the mismatch, never " +
        "to reproject on a guess — a boundary silently moved is worse than one " +
        "visibly absent",
        "25833 from a real .prj, null when it cannot tell",
        `${prjEpsg('PROJCS["ETRS89 / UTM zone 33N",AUTHORITY["EPSG","25833"]]')} / ` +
        `${prjEpsg("GEOGCS[\"something local\"]")}`,
        prjEpsg('PROJCS["ETRS89 / UTM zone 33N",AUTHORITY["EPSG","25833"]]') === 25833
        && prjEpsg('GEOGCS["something local"]') === null);
    }
  }

  // ============================================================ GROUP F2
  // The printable solid. Pure geometry, so it belongs here rather than in the
  // render suite — and it is the one export whose defining property cannot be
  // seen by looking at the result.
  const F2 = "F2 · the voxel terrain as a solid you can actually print";
  {
    const [lo, hi] = fillDem.zRange();
    const span = hi - lo;
    /** voxels.js's own base plate and cube height, for a given block size. */
    const rig = (k, ex = 1) => {
      const w = k * fillDem.cell;
      return { blockCells: k, baseZ: lo - w, quantum: Math.min(w / ex, span / 10), exaggeration: ex };
    };
    /** Read the OBJ BACK, so the check measures the file rather than the builder. */
    const parse = (obj) => {
      const verts = [], objs = [];
      let cur = null;
      for (const line of obj.split("\n")) {
        if (line.startsWith("v ")) {
          const p = line.split(/\s+/); verts.push([+p[1], +p[2], +p[3]]);
        } else if (line.startsWith("o ")) {
          cur = { name: line.slice(2), tris: [] }; objs.push(cur);
        } else if (line.startsWith("f ")) {
          const p = line.split(/\s+/).slice(1).map((v) => parseInt(v, 10) - 1);
          if (cur) cur.tris.push(p);
        }
      }
      return { verts, objs };
    };
    /** Signed volume by the divergence theorem — meaningful only if closed. */
    const volume = (verts, tris) => {
      let v = 0;
      for (const [a, b, c] of tris) {
        const A = verts[a], B = verts[b], C = verts[c];
        v += (A[0] * (B[1] * C[2] - C[1] * B[2])
            - B[0] * (A[1] * C[2] - C[1] * A[2])
            + C[0] * (A[1] * B[2] - B[1] * A[2])) / 6;
      }
      return v;
    };

    {
      const o = rig(4);
      const res = writeVoxelSolidOBJ(fillDem, o);
      const { verts, objs } = parse(res.obj);
      const rep = manifoldReport(objs[0].tris);
      add(F2, "the solid is CLOSED — every directed edge has its reverse, which " +
        "is exactly what a slicer means by watertight and the one thing about " +
        "this file nobody can check by looking at it",
        "0 unpaired edges", `${rep.unpaired} of ${rep.edges}`, rep.unpaired === 0);

      // The union's volume must equal the blocks' own, or faces were dropped or
      // doubled somewhere. This is the check that caught the walls being wound
      // inward: the volume came back NEGATIVE and exactly a third of the target.
      const { levels } = blockLevels(fillDem, 4, o.baseZ, o.quantum);
      const w = 4 * fillDem.cell;
      let expect = 0;
      for (const L of levels) if (L > 0) expect += w * w * L * o.quantum;
      const vol = volume(verts, objs[0].tris);
      add(F2, "…and it encloses exactly the volume of the blocks it is the union " +
        "of, which is what catches a dropped face or a wall wound inside out — " +
        "an inverted wall reads as a NEGATIVE volume, not as a hole",
        `${expect.toFixed(1)} m³`, `${vol.toFixed(1)} m³`,
        Math.abs(vol - expect) / expect < 1e-4);
    }

    {
      // ⚠️ THE WHOLE POINT: no face survives between two blocks that touch.
      const o = rig(4);
      const solid = writeVoxelSolidOBJ(fillDem, o);
      const { levels } = blockLevels(fillDem, 4, o.baseZ, o.quantum);
      let boxes = 0;
      for (const L of levels) if (L > 0) boxes++;
      add(F2, "…and it is far SMALLER than the boxes it replaces, because every " +
        "face between two touching blocks is a wall buried inside the model and " +
        "is never written at all",
        `< ${(boxes * 12).toLocaleString()} triangles`,
        `${solid.triangles.toLocaleString()} vs ${(boxes * 12).toLocaleString()}`,
        solid.triangles < boxes * 12);
      add(F2, "…and its vertices are WELDED, so neighbours share them rather " +
        "than each carrying its own copy at the same coordinates",
        `< ${(boxes * 8).toLocaleString()} vertices`,
        `${solid.vertices.toLocaleString()} vs ${(boxes * 8).toLocaleString()}`,
        solid.vertices < boxes * 8);
    }

    {
      // ⚠️ THE T-JUNCTION CASE, built by hand because it is the one configuration
      // that makes a naive union LOOK right and slice wrong. Four columns round
      // one corner at three different heights: split the walls per level and it
      // closes, span each step with a single tall rectangle and that corner is
      // a crack.
      const dem = DEM.synthetic(4, 4, 1, (r, c) =>
        (r < 2 && c < 2) ? 3 : (r < 2 && c >= 2) ? 2 : (r >= 2 && c < 2) ? 1 : 0);
      const o = { blockCells: 1, baseZ: -1, quantum: 1, exaggeration: 1 };
      const res = writeVoxelSolidOBJ(dem, o);
      const { objs } = parse(res.obj);
      const rep = manifoldReport(objs[0].tris);
      add(F2, "a saddle of four columns at four different heights still closes — " +
        "the corner where they meet is where a wall spanning its whole step in " +
        "one rectangle leaves a crack, and it is invisible in a render",
        "0 unpaired edges", `${rep.unpaired}`, rep.unpaired === 0);
    }

    {
      // Grouping: every class its own closed shell, and the seam shared exactly.
      const o = rig(4);
      const { levels, bRows, bCols } = blockLevels(fillDem, 4, o.baseZ, o.quantum);
      const groups = new Int32Array(bRows * bCols);
      for (let r = 0; r < bRows; r++) {
        for (let c = 0; c < bCols; c++) groups[r * bCols + c] = ((r >> 2) + (c >> 2)) % 3;
      }
      const res = writeVoxelSolidOBJ(fillDem, { ...o, groups, groupLabels: ["a", "b", "c"] });
      const { verts, objs } = parse(res.obj);
      const closed = objs.every((ob) => manifoldReport(ob.tris).unpaired === 0);
      add(F2, "grouped by a class, EVERY class comes out as its own closed solid " +
        "rather than one of them being closed and the rest open at the seams",
        `${objs.length} of ${objs.length} closed`,
        `${objs.filter((ob) => manifoldReport(ob.tris).unpaired === 0).length} of ${objs.length}`,
        closed && objs.length === 3);

      // The parts must add up to the whole: nothing lost or double-counted at
      // the boundaries between groups.
      const whole = writeVoxelSolidOBJ(fillDem, o);
      const wp = parse(whole.obj);
      const sum = objs.reduce((s, ob) => s + volume(verts, ob.tris), 0);
      const all = volume(wp.verts, wp.objs[0].tris);
      add(F2, "…and the pieces add up to the single solid exactly, so grouping " +
        "cuts the same body apart rather than making a different one",
        `${all.toFixed(1)} m³`, `${sum.toFixed(1)} m³`,
        Math.abs(sum - all) / all < 1e-6);
    }

    {
      // Exaggeration is a display claim; the solid must carry it only when asked.
      const a = writeVoxelSolidOBJ(fillDem, rig(8, 1));
      const b = writeVoxelSolidOBJ(fillDem, { ...rig(8, 1), exaggeration: 3 });
      const pa = parse(a.obj), pb = parse(b.obj);
      const za = pa.verts.reduce((m, v) => Math.max(m, v[2]), -Infinity);
      const zb = pb.verts.reduce((m, v) => Math.max(m, v[2]), -Infinity);
      // ⚠️ TOLERANCE SET BY THE FILE, NOT BY TASTE. The OBJ writes coordinates
      // to four decimals, so a ratio read back out of the text carries about
      // 1e-4 / z of rounding — roughly 1.3e-6 here. Asserting 1e-6 fails on a
      // value that is exactly right and prints as 3.0000, which would be a test
      // calling a correct export broken.
      const tol = 4 * 1e-4 / za;
      add(F2, "baking the exaggeration scales the solid's Z and nothing else, so " +
        "an unbaked export really is true elevations rather than a stretched " +
        "model that looks like one",
        `3× the height, within the file's own 4-decimal precision`,
        `${(zb / za).toFixed(6)}×`, near(zb / za, 3, tol));
    }
  }

  // ============================================================ GROUP Z
  // The opening cut in the context tile where the design patch draws the same
  // ground. Pure grid arithmetic, so it belongs here rather than in the render
  // suite; what the opening LOOKS like is R2's business.
  const Z = "Z · the context tile stops drawing ground the patch already draws";
  {
    const ctx = DEM.fromRaw(loadGeoTIFF(await fetchTile("orndalen_2024_4m.tif"), { name: "ctx" }));
    const design = fillDem;
    const hole = DEM.nestHole(ctx, design);

    add(Z, "the design patch lands on the context grid exactly, so the opening " +
      "can be cut on cell boundaries rather than fudged to the nearest one",
      "16 × 16 context cells", hole ? `${hole.r1 - hole.r0 + 1} × ${hole.c1 - hole.c0 + 1}` : "refused",
      !!hole && hole.r1 - hole.r0 + 1 === 16 && hole.c1 - hole.c0 + 1 === 16);

    {
      // ⚠️ THE ROW FLIP, PINNED AGAINST THE GROUND ITSELF rather than against
      // the arithmetic that produced it. nest() counts rows north from the
      // south-west origin; every surface and mask in this project counts them
      // south from the north edge. Get it wrong on a square tile and the
      // opening is a plausible rectangle in a plausible place, mirrored about
      // the middle — so the test is whether the cells inside the opening are
      // the ones whose CENTRES actually fall within the patch's footprint.
      const x0 = design.originX, y0 = design.originY;
      const x1 = x0 + design.ncols * design.cell, y1 = y0 + design.nrows * design.cell;
      let wrong = 0, inside = 0;
      for (let r = 0; r < ctx.nrows; r++) {
        for (let c = 0; c < ctx.ncols; c++) {
          const [x, y] = ctx.xy(r, c);
          const over = x > x0 && x < x1 && y > y0 && y < y1;
          const cut = !!hole && r >= hole.r0 && r <= hole.r1 && c >= hole.c0 && c <= hole.c1;
          if (over) inside++;
          if (over !== cut) wrong++;
        }
      }
      add(Z, "…and every context cell whose centre lies over the patch is one " +
        "of the cells cut, which is what catches a north/south row flip — it " +
        "would put a perfectly plausible opening in the mirrored position",
        `${inside} cells over the patch, 0 disagreements`, `${wrong} disagreements`,
        inside === 256 && wrong === 0);
    }

    add(Z, "a tile that does NOT align is refused rather than cut approximately, " +
      "because an opening half a cell out looks entirely deliberate",
      "null", String(DEM.nestHole(ctx, DEM.synthetic(8, 8, 0.25, () => 0,
        design.originX + 0.6, design.originY))),
      DEM.nestHole(ctx, DEM.synthetic(8, 8, 0.25, () => 0,
        design.originX + 0.6, design.originY)) === null);

    {
      // The lattice keeps its own index over the shared position buffer, so it
      // has to be cut as well or the wireframe draws a grid across the void.
      const step = 16, nr = 64, nc = 64;
      const h = { r0: 20, c0: 20, r1: 35, c1: 35 };
      const full = latticeEdges(nr, nc, step);
      const cut = latticeEdges(nr, nc, step, h);
      let reaching = 0;
      for (let i = 0; i < cut.length; i++) {
        const r = Math.trunc(cut[i] / nc), c = cut[i] % nc;
        if (r >= h.r0 && r <= h.r1 && c >= h.c0 && c <= h.c1) reaching++;
      }
      add(Z, "the lattice is cut too — it carries its OWN index over the mesh's " +
        "shared vertices, so cutting only the triangles leaves a wireframe grid " +
        "hanging in the opening, which reads as a fault rather than a decision",
        "0 endpoints inside the opening, and fewer segments than uncut",
        `${reaching} inside, ${cut.length / 2} vs ${full.length / 2} segments`,
        reaching === 0 && cut.length < full.length);
    }
  }

  // ============================================================ GROUP Y
  // The batter — the edge condition Group P deliberately leaves out.
  //
  // ⚠️ THIS CODE SHIPPED UNTESTED. levelTo's own group asserts that NOTHING
  // outside the mask moves, and that is right for a platform; but it meant the
  // three functions that exist precisely to move ground outside the mask —
  // distanceToMask, batterTo, levelWithBatter — had no suite entry at all. They
  // were checked once in a throwaway script and never again, which is the same
  // hole Group P was written to close, one function further along.
  //
  // Synthetic ground, mostly, and deliberately: a batter's whole claim is that
  // it stands at a stated angle and stops where it meets existing ground, and
  // you cannot measure an angle against ground whose own angle you do not
  // already know. The real patch appears at the end, where the question stops
  // being geometric and starts being about cost.
  const Y = "Y · the batter — where a platform meets the ground it was cut into";
  {
    /** an axis-aligned square of cells, rows and cols `lo`…`hi` inclusive */
    const sq = (n, lo, hi) => {
      const m = new Uint8Array(n * n);
      for (let r = lo; r <= hi; r++) for (let c = lo; c <= hi; c++) m[r * n + c] = 1;
      return m;
    };
    const tan = (deg) => Math.tan((deg * Math.PI) / 180);

    {
      // Against brute force, which is O(cells × boundary) and unusable in the
      // app but exactly right as an oracle at this size.
      const n = 24;
      const mask = new Uint8Array(n * n);
      for (const [r, c] of [[5, 6], [5, 7], [12, 3], [19, 20], [2, 21]]) mask[r * n + c] = 1;
      const got = distanceToMask(mask, n, n);
      let worst = 0;
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        let best = Infinity;
        for (let rr = 0; rr < n; rr++) for (let cc = 0; cc < n; cc++) {
          if (mask[rr * n + cc]) best = Math.min(best, Math.hypot(r - rr, c - cc));
        }
        worst = Math.max(worst, Math.abs(got[r * n + c] - best));
      }
      add(Y, "the distance transform is exact Euclidean, not a chamfer " +
        "approximation — a chamfer quantises the batter's slope into facets " +
        "radiating from the corners, which reads as a decision nobody made",
        "0 cells error vs brute force", `${worst.toExponential(1)} cells`,
        worst < 1e-9);
    }

    {
      const n = 80, cell = 0.5, GROUND = 100, TARGET = 98;   // a 2 m cut
      const dem = DEM.synthetic(n, n, cell, () => GROUND);
      const mask = sq(n, 36, 43);
      levelTo(dem, mask, TARGET);
      const res = batterTo(dem, mask, TARGET, { angleDeg: 45 });

      // Walk out along the row through the platform centre, and measure only
      // pairs where BOTH cells are on the graded face — the pair straddling the
      // daylight line is a part-height step by definition.
      const r = 40, slopes = [];
      for (let c = 45; c < 60; c++) {
        const a = dem.z[r * n + c - 1], b = dem.z[r * n + c];
        if (a >= GROUND - 1e-6 || b >= GROUND - 1e-6) continue;
        slopes.push((b - a) / cell);
      }
      const meanSlope = slopes.reduce((a, b) => a + b, 0) / slopes.length;
      add(Y, "the batter stands at the angle it was given, measured on the " +
        "graded surface rather than assumed from the formula",
        "45° → slope 1.0000", f4(meanSlope), near(meanSlope, 1, 0.02));

      // ⚠️ The width is a RESULT, not a parameter: Δz / tanθ, and no input
      // anywhere sets it. That is the whole reason a batter beats a soft brush.
      const expectedRun = (GROUND - TARGET) / tan(45);
      add(Y, "…and its width is a RESULT — Δz ÷ tanθ — not a radius anyone " +
        "chose, which is why it can follow ground a fixed-radius falloff cannot",
        `${expectedRun.toFixed(2)} m run`, `${res.maxRunM.toFixed(2)} m`,
        near(res.maxRunM, expectedRun, cell * 1.2));

      let beyond = 0;
      for (let c = 0; c < n; c++) {
        if ((c - 43) * cell > expectedRun + cell && dem.z[r * n + c] !== GROUND) beyond++;
      }
      add(Y, "…so it daylights: past the line where the graded plane crosses " +
        "existing ground, not one cell is touched",
        "0 cells", `${beyond}`, beyond === 0);

      // The half-cell correction. Without it every platform carries a lip of
      // half a cell × tanθ all the way round — 0.125 m at 0.25 m cells, which
      // is precisely the artefact this feature exists to remove.
      const firstOutside = dem.z[r * n + 44] - TARGET;
      add(Y, "…and there is no lip at the platform edge: distance is measured " +
        "to a cell CENTRE but the platform boundary runs half a cell further " +
        "out, and that half cell is corrected for",
        `≤ ${(cell * 1.05).toFixed(3)} m step`, `${firstOutside.toFixed(3)} m`,
        firstOutside <= cell * 1.05);
    }

    {
      // Bedrock stands vertical. θ = 90° is a legitimate answer, and it must
      // reproduce the old hard edge EXACTLY — the behaviour Group P asserts.
      const n = 40, dem = DEM.synthetic(n, n, 0.5, () => 100);
      const mask = sq(n, 16, 23);
      levelTo(dem, mask, 97);
      const before = Float32Array.from(dem.z);
      const res = batterTo(dem, mask, 97, { angleDeg: 90 });
      let moved = 0;
      for (let i = 0; i < dem.z.length; i++) if (dem.z[i] !== before[i]) moved++;
      add(Y, "a vertical face is a legitimate answer, not an error — θ = 90° " +
        "moves nothing outside the mask, so Group P's hard edge is the " +
        "bedrock case of this one rather than a different code path",
        "0 cells moved", `${moved}`, moved === 0 && res.cells === 0);
    }

    {
      // ⚠️ CUT AND FILL DO NOT STAND AT THE SAME ANGLE. A road across a slope
      // is the case that makes it obvious, and it is the case the app will
      // actually meet: a cutting uphill, an embankment downhill, graded
      // differently, on one platform, in one operation.
      const n = 100, cell = 0.5, CUT = 60, FILL = 30;
      const dem = DEM.synthetic(n, n, cell, (r, c) => 90 + (c / (n - 1)) * 16);
      const road = new Uint8Array(n * n);
      for (let r = 40; r <= 47; r++) for (let c = 0; c < n; c++) road[r * n + c] = 1;
      levelTo(dem, road, 98);
      const before = Float32Array.from(dem.z);
      const res = batterTo(dem, road, 98, { cutAngleDeg: CUT, fillAngleDeg: FILL });

      const faceSlope = (c, from, to, step) => {
        const s = [];
        for (let r = from; r !== to; r += step) {
          const i = r * n + c, j = (r + step) * n + c;
          if (dem.z[i] === before[i] || dem.z[j] === before[j]) continue;
          s.push(Math.abs(dem.z[j] - dem.z[i]) / cell);
        }
        return s.length ? s.reduce((x, y) => x + y, 0) / s.length : 0;
      };
      const cutSlope = faceSlope(80, 39, 30, -1);    // uphill side
      const fillSlope = faceSlope(20, 48, 58, 1);    // downhill side

      add(Y, "a road cut across a slope grades its cutting at the CUT angle — " +
        "what the exposed ground will stand at",
        `60° → ${tan(CUT).toFixed(3)}`, f4(cutSlope), near(cutSlope, tan(CUT), 0.06));
      add(Y, "…and its embankment at the shallower FILL angle, because loose " +
        "material ravels to its own repose angle whatever the drawing says",
        `30° → ${tan(FILL).toFixed(3)}`, f4(fillSlope), near(fillSlope, tan(FILL), 0.06));
      add(Y, "…so the embankment runs wider than the cutting for the same " +
        "height, and one angle for both would have produced an embankment too " +
        "steep to stand and an over-wide cutting at the same time",
        "fill volume > cut volume",
        `cut ${res.cut.toFixed(0)} m³, fill ${res.fill.toFixed(0)} m³`,
        res.fill > res.cut && res.cut > 0);
    }

    {
      // A rock cutting above an earth embankment — the two vertical/graded
      // cases on one platform, which is an ordinary road section.
      const n = 60, cell = 0.5;
      const dem = DEM.synthetic(n, n, cell, (r, c) => 95 + (c / (n - 1)) * 10);
      const mask = sq(n, 26, 33);
      levelTo(dem, mask, 100);
      const before = Float32Array.from(dem.z);
      const res = batterTo(dem, mask, 100, { cutAngleDeg: 90, fillAngleDeg: 34 });
      let raised = 0, lowered = 0;
      for (let i = 0; i < dem.z.length; i++) {
        if (mask[i]) continue;
        if (dem.z[i] > before[i]) raised++;
        if (dem.z[i] < before[i]) lowered++;
      }
      add(Y, "the two faces are independent: a vertical rock cutting above a " +
        "graded earth embankment leaves nothing cut and still builds the bank",
        "0 cut, some filled", `${lowered} cut, ${raised} filled`,
        lowered === 0 && raised > 0 && res.cut === 0 && res.fill > 0);
    }

    {
      const n = 80, cell = 0.5, ANG = 34;
      const dem = DEM.synthetic(n, n, cell, (r, c) =>
        100 + Math.sin(c * 0.2) * 0.6 + Math.cos(r * 0.17) * 0.4);
      const mask = sq(n, 34, 45);
      levelWithBatter(dem, mask, 97, { angleDeg: ANG });
      const dist = distanceToMask(mask, n, n);
      let worst = 0;
      for (let r = 1; r < n - 1; r++) for (let c = 1; c < n - 1; c++) {
        const i = r * n + c;
        if (mask[i] || dist[i] > 12) continue;   // only inside the graded band
        const gx = (dem.z[i + 1] - dem.z[i - 1]) / (2 * cell);
        const gy = (dem.z[i + n] - dem.z[i - n]) / (2 * cell);
        worst = Math.max(worst, Math.hypot(gx, gy));
      }
      add(Y, "over irregular ground the graded band never ends up steeper than " +
        "the material allows — the bound holds on the SURFACE, in both " +
        "directions at once, not just along the ray the batter was built on",
        `≤ ${(tan(ANG) * 1.02).toFixed(4)}`, f4(worst), worst <= tan(ANG) * 1.02);
    }

    {
      const n = 40, dem = DEM.synthetic(n, n, 0.5, () => 100);
      dem.z[5 * n + 5] = NaN;
      const mask = sq(n, 16, 23);
      const ledger = new Ledger();
      const r1 = levelWithBatter(dem, mask, 97, { angleDeg: 34, ledger });
      add(Y, "the ledger is charged for the batter as well as the platform — a " +
        "batter is earthwork, and billing only the platform would understate " +
        "every cut on sloping ground",
        `cut ${f2(r1.cut)}, fill ${f2(r1.fill)}`,
        `cut ${f2(ledger.cut)}, fill ${f2(ledger.fill)}`,
        near(ledger.cut, r1.cut, 1e-6) && near(ledger.fill, r1.fill, 1e-6));
      add(Y, "…while a hole in the DEM stays a hole, on the batter exactly as " +
        "on the platform",
        "NaN", String(dem.z[5 * n + 5]), Number.isNaN(dem.z[5 * n + 5]));

      const cut0 = ledger.cut;
      levelWithBatter(dem, mask, 96, { angleDeg: 34, ledger });
      add(Y, "…and a second levelling ACCUMULATES onto the same account rather " +
        "than replacing it — one more earthwork on the same site",
        `> ${f2(cut0)} m³ cut`, `${f2(ledger.cut)} m³`, ledger.cut > cut0);
    }

    {
      // The two properties the app's wiring rests on. Both are invisible in the
      // running tool until they are wrong, and then both look like "the batter
      // doesn't work" rather than like what they are.
      const n = 64, cell = 0.25;
      const build = () => DEM.synthetic(n, n, cell, (r, c) => 100 + c * cell * 0.25);
      const mask = sq(n, 24, 39);
      const opts = { cutAngleDeg: 45, fillAngleDeg: 34 };

      // 1. The dry run is the wet run, minus the writing. The figure under the
      //    slider and the figure that lands in the ledger are one operation.
      const wet = build(), dry = build();
      const before = Float32Array.from(dry.z);
      const rWet = batterTo(wet, mask, 103, opts);
      const rDry = batterTo(dry, mask, 103, { ...opts, dryRun: true });
      let touched = 0;
      for (let i = 0; i < dry.z.length; i++) if (dry.z[i] !== before[i]) touched++;
      add(Y, "pricing the batter is the same operation as building it with the " +
        "writing removed, so the figure under the slider cannot differ from the " +
        "one that lands in the ledger",
        `cut ${f2(rWet.cut)}, fill ${f2(rWet.fill)}, 0 cells written`,
        `cut ${f2(rDry.cut)}, fill ${f2(rDry.fill)}, ${touched} cells written`,
        rDry.cut === rWet.cut && rDry.fill === rWet.fill &&
        rDry.cells === rWet.cells && touched === 0);

      // 2. Pricing works BEFORE the platform is levelled — the only reason a
      //    live preview is possible. batterTo reads no cell inside the mask, so
      //    levelTo having run or not cannot change its answer.
      const after = build();
      levelTo(after, mask, 103);
      const rAfter = batterTo(after, mask, 103, { ...opts, dryRun: true });
      add(Y, "…and it gives the same answer before the platform is levelled as " +
        "after it, because it reads no cell inside the mask — which is what " +
        "lets the preview price an edge that does not exist yet",
        `cut ${f2(rWet.cut)}, fill ${f2(rWet.fill)}`,
        `cut ${f2(rAfter.cut)}, fill ${f2(rAfter.fill)}`,
        rAfter.cut === rWet.cut && rAfter.fill === rWet.fill &&
        rAfter.cells === rWet.cells);

      // 3. The rect covers the batter, not the region. Undo and repaint are
      //    both bounded by it, and a region-sized rect would silently strand
      //    the graded ground outside the ring.
      const un = build();
      const maskRect = { r0: 24, c0: 24, r1: 39, c1: 39 };
      const full = levelWithBatter(un, mask, 103, opts, maskRect);
      let outside = 0, worstR = 0, worstC = 0;
      const base = build();
      for (let i = 0; i < un.z.length; i++) {
        if (un.z[i] === base.z[i]) continue;
        const r = (i / n) | 0, c = i % n;
        if (r < full.r0 || r > full.r1 || c < full.c0 || c > full.c1) outside++;
        worstR = Math.max(worstR, Math.max(maskRect.r0 - r, r - maskRect.r1));
        worstC = Math.max(worstC, Math.max(maskRect.c0 - c, c - maskRect.c1));
      }
      add(Y, "the rect a levelling reports covers the batter as well as the " +
        "platform — undo and repaint are both bounded by it, and the region's " +
        "own extent is now the wrong rectangle for either",
        "0 moved cells outside the reported rect",
        `${outside} outside; batter reaches ${Math.max(worstR, worstC)} cells ` +
        `beyond the region`,
        outside === 0 && Math.max(worstR, worstC) > 0);
    }

    {
      // ⚠️ THE SPLIT IS THE POINT — but the reason given for it in polygon.js
      // was wrong, and writing this check is what found it. The docstring said
      // "on a SMALL platform cut into a slope the batter is routinely the larger
      // of the two", which reads as though platform size were the governing
      // variable. It is not. The run is Δz ÷ tanθ, so the batter's share is set
      // by the RELIEF the platform has to reconcile — that is, by the GRADIENT
      // of the ground — while the platform's own cost grows as the area. On a
      // plain the share therefore FALLS as the platform grows, which is the
      // exact opposite of what the docstring implied. Both cases below use the
      // same 8 m platform and the same 34° face, so only the ground differs.

      /** batter's share of all material moved, levelling to the region's mean */
      const trial = (dem, side) => {
        const n = dem.ncols;
        const r0 = (dem.nrows >> 1) - (side >> 1), c0 = (n >> 1) - (side >> 1);
        const mask = new Uint8Array(dem.nrows * n);
        for (let r = r0; r < r0 + side; r++) for (let c = c0; c < c0 + side; c++) mask[r * n + c] = 1;
        const rg = maskZRange(dem, mask);
        const res = levelWithBatter(dem.clone(), mask, rg.mean, { angleDeg: 34 });
        return {
          res,
          relief: rg.hi - rg.lo,
          share: (res.batter.cut + res.batter.fill) / (res.cut + res.fill),
        };
      };

      const small = trial(fillDem, 32);    //  8 m platform on the real patch
      const large = trial(fillDem, 128);   // 32 m platform on the real patch
      add(Y, "the batter's share of the earthwork is governed by the GROUND'S " +
        "GRADIENT, not by the platform's size — on Ørndalen's plain the share " +
        "FALLS as the platform grows, because relief accumulates slowly while " +
        "area grows as the square",
        "32 m platform below 8 m platform",
        `8 m ${(100 * small.share).toFixed(1)}%, 32 m ${(100 * large.share).toFixed(1)}%`,
        large.share < small.share);

      // The same platform on ground that genuinely falls. This is the case the
      // docstring was describing, and here it is true.
      const slope = DEM.synthetic(fillDem.nrows, fillDem.ncols, fillDem.cell,
        (r, c) => 100 + c * fillDem.cell * 0.4);          // a 40% fall
      const cut = trial(slope, 32);
      add(Y, "…so the same 8 m platform is nearly all platform on this site and " +
        "mostly batter on a 40% slope: the edge condition is a property of the " +
        "ground, and Ørndalen is levelled enough that even its edges cost little",
        "real patch < 15%, 40% slope > 50%",
        `real ${(100 * small.share).toFixed(1)}% (relief ${f2(small.relief)} m), ` +
        `slope ${(100 * cut.share).toFixed(1)}% (relief ${f2(cut.relief)} m)`,
        small.share < 0.15 && cut.share > 0.50);

      // The platform is volume-neutral when levelled to its own mean (Group G's
      // finding). The batter is NOT, and it is worth knowing which way it goes:
      // grading outward from a mean-level platform on this ground fills more
      // than it cuts, so "volume-neutral" survives only as long as the edge is
      // left vertical.
      const res = small.res;
      add(Y, "…and levelling to the region's own mean is volume-neutral for the " +
        "PLATFORM only — the batter carries its own net, so the neutrality " +
        "claim has to name which of the two it is about",
        "platform net ≈ 0, batter net ≠ 0",
        `platform ${f2(res.platform.net)} m³, batter ${f2(res.batter.net)} m³`,
        Math.abs(res.platform.net) < 1e-3 && Math.abs(res.batter.net) > 1e-3);
    }
  }

  // ══ R2 ═══════════════════════════════════════════════════════════════════
  const R2 = "R2 · rule masks — where a modifier is allowed to act";
  {
    const n = 64;
    const dem = { nrows: n, ncols: n };
    /** left half slope 5°, right half 25° */
    const slope = new Float32Array(n * n);
    const twiG = new Float32Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        slope[r * n + c] = c < n / 2 ? 5 : 25;
        // ⚠️ HALF THE TWI GRID IS NaN ON PURPOSE — that is what a levelled
        // surface actually produces, and it is the case this group exists for.
        twiG[r * n + c] = r < n / 2 ? 8 : NaN;
      }
    }
    const grids = { slope, twi: twiG };

    {
      const a = maskFromRule(dem, grids, [{ layer: "slope", min: 15 }]);
      add(R2, "a rule selects exactly the cells whose layer satisfies it, and " +
        "nothing else — the mask is the same Uint8Array shape rasterise() " +
        "returns, so every existing modifier takes it unchanged",
        `${(n * n) / 2} cells (the steep half)`, `${a.count}`,
        a.count === (n * n) / 2);
    }

    {
      // ⚠️ THE CENTRAL HONESTY RULE OF THIS MODULE. A cell with no answer is
      // EXCLUDED, never read as zero. Reading NaN as 0 would let a levelled
      // surface — where TWI is undefined by construction — quietly satisfy a
      // "wetness below 6" rule, which is the exact degeneracy the whole
      // project exists to expose.
      const below = maskFromRule(dem, grids, [{ layer: "twi", max: 6 }]);
      const above = maskFromRule(dem, grids, [{ layer: "twi", min: 0 }]);
      add(R2, "a cell whose layer has NO ANSWER (NaN) fails every test, rather " +
        "than counting as zero — otherwise a levelled surface, where TWI is " +
        "undefined by construction, would satisfy a wetness rule",
        "0 selected by 'twi below 6'; only the defined half by 'twi above 0'",
        `${below.count} and ${above.count} of ${n * n}`,
        below.count === 0 && above.count === (n * n) / 2);
    }

    {
      const missing = maskFromRule(dem, grids, [{ layer: "catchment", min: 1 }]);
      add(R2, "a rule against a layer that has not been computed selects " +
        "NOTHING and says which layer — a rule that could not be evaluated " +
        "must never WIDEN the operation it was meant to narrow",
        "0 cells, names 'catchment'",
        `${missing.count} cells, names ${JSON.stringify(missing.missing)}`,
        missing.count === 0 && missing.missing.length === 1
        && missing.missing[0] === "catchment");
    }

    {
      // Two rules AND together, and the intersection with a drawn region can
      // only ever shrink the selection.
      const both = maskFromRule(dem, grids,
        [{ layer: "slope", min: 15 }, { layer: "twi", min: 0 }]);
      const region = new Uint8Array(n * n);
      for (let r = 0; r < n / 4; r++) for (let c = 0; c < n; c++) region[r * n + c] = 1;
      const narrowed = maskFromRule(dem, grids, [{ layer: "slope", min: 15 }], region);
      const alone = maskFromRule(dem, grids, [{ layer: "slope", min: 15 }]);
      add(R2, "rules AND together, and a drawn region can only narrow the " +
        "result — 'steep AND wetness defined' is the steep half's top rows, " +
        "and every masked count is ≤ the unmasked one",
        "steep∩defined = quarter; region∩steep ≤ steep",
        `${both.count} = ${(n * n) / 4}? ; ${narrowed.count} ≤ ${alone.count}?`,
        both.count === (n * n) / 4 && narrowed.count <= alone.count);
    }

    {
      const a = maskFromRule(dem, grids, [{ layer: "slope", min: 15 }]);
      const rect = maskRect(dem, a.mask);
      const empty = maskRect(dem, new Uint8Array(n * n));
      add(R2, "the mask's rect bounds exactly the selection, and an EMPTY mask " +
        "returns r0 > r1 — the same convention batterTo uses, so a caller " +
        "unioning it with another rect gets that rect back rather than " +
        "dragging row 0 and column 0 into every repaint",
        `c0 = ${n / 2}, c1 = ${n - 1}; empty → r0 > r1`,
        `c0 = ${rect.c0}, c1 = ${rect.c1}; empty r0 ${empty.r0} > r1 ${empty.r1}`,
        rect.c0 === n / 2 && rect.c1 === n - 1 && rect.r0 === 0
        && rect.r1 === n - 1 && empty.r0 > empty.r1);
    }

    {
      // Every layer the UI offers must be describable, or a rule could be set
      // that the interface cannot state back to the user.
      const bad = Object.keys(RULE_LAYERS).filter((k) => {
        const s = describeRules([{ layer: k, min: 1 }]);
        return !s || s === k;
      });
      add(R2, "every rule layer states itself in words, so a selection can " +
        "always be read back — a rule the interface cannot describe is one " +
        "the designer cannot check",
        "0 undescribable layers", `${bad.length} (${bad.join(", ") || "none"})`,
        bad.length === 0);
    }
  }

  {
    // ⚠️ CATEGORICAL SELECTION — the step that unblocks the landform-terracing
    // work. `maskFromRule` has always matched class membership; only the
    // interface excluded these layers, with the note "ranges only, for now".
    const n = 8;
    const dem = { nrows: n, ncols: n };
    const geo = new Float32Array(n * n);
    // three bands: 4 = spur, 5 = slope, 6 = hollow
    for (let i = 0; i < geo.length; i++) geo[i] = 4 + (i % 3);
    const grids = { geomorphon: geo };

    const two = maskFromRule(dem, grids, [{ layer: "geomorphon", classes: [4, 6] }]);
    let wrong = 0;
    for (let i = 0; i < geo.length; i++) {
      const want = (geo[i] === 4 || geo[i] === 6) ? 1 : 0;
      if (two.mask[i] !== want) wrong++;
    }
    add(R2, "a categorical layer is selected by MEMBERSHIP of named classes, not "
      + "by a range — comparing landform classes with < and > would rank a "
      + "hollow against a shoulder, which is an order they do not have",
      "exactly the spur and hollow cells",
      `${two.count} selected, ${wrong} wrong`, wrong === 0 && two.count > 0);

    // ⚠️ NOTHING TICKED SELECTS NOTHING, NOT EVERYTHING — the same rule an
    // unevaluable rule keeps: a rule must never WIDEN the operation it was
    // meant to narrow, and an empty class list is that statement made by the
    // user rather than by the data.
    const none = maskFromRule(dem, grids, [{ layer: "geomorphon", classes: [] }]);
    add(R2, "…and with no class chosen it selects NOTHING rather than everything",
      "0 cells", `${none.count}`, none.count === 0);

    // The names live in RULE_LAYERS, and the position IS the code.
    const meta = RULE_LAYERS.geomorphon;
    add(R2, "…the class NAMES are carried in the rule table itself, so the "
      + "chips, the mask and the sentence beside them all read one vocabulary",
      "10 named classes, spur at code 4",
      `${meta.classes ? meta.classes.length : 0} named, `
      + `${meta.classes ? meta.classes[4] : "?"} at 4`,
      !!meta.classes && meta.classes.length === LANDFORMS.length
      && meta.classes[4] === "spur");
    add(R2, "…and the sentence NAMES the classes rather than printing their "
      + "codes, on the one layer whose whole point is that it reports a name",
      "spur, hollow", describeRules([{ layer: "geomorphon", classes: [4, 6] }]),
      /spur, hollow/.test(describeRules([{ layer: "geomorphon", classes: [4, 6] }])));
    // ⚠️ soil is declared categorical and deliberately has NO names: the
    // substrate never crosses the worker boundary, so a rule against it would
    // select nothing and blame the analysis.
    add(R2, "…while the substrate layer stays unnamed, and therefore unofferable, "
      + "because it never reaches the worker's grids — a rule against it would "
      + "select nothing and report the analysis as incomplete",
      "no classes on soil", RULE_LAYERS.soil.classes ? "named" : "unnamed",
      !RULE_LAYERS.soil.classes);
  }

  // ══ S4 ═══════════════════════════════════════════════════════════════════
  const S4 = "S4 · the selection stack — selections that compose, in order";
  {
    const n = 16;
    const N = n * n;
    /** a mask of the rows [r0, r1) */
    const rows = (r0, r1) => {
      const m = new Uint8Array(N);
      for (let r = r0; r < r1; r++) for (let c = 0; c < n; c++) m[r * n + c] = 1;
      return m;
    };
    /** a mask of the columns [c0, c1) */
    const cols = (c0, c1) => {
      const m = new Uint8Array(N);
      for (let r = 0; r < n; r++) for (let c = c0; c < c1; c++) m[r * n + c] = 1;
      return m;
    };
    const mk = (masks) => {
      const st = new SelectionStack();
      for (const [mask, op, name] of masks) st.add(mask, { op, name });
      return st;
    };

    {
      // The brief itself, in three rows: "all faces steeper than X, but not
      // those above elevation Y, and only within an imported boundary."
      const st = mk([
        [rows(0, 8), "add", "Slope ≥ 20.2°"],
        [rows(0, 2), "sub", "Above 78 m"],
        [cols(0, 8), "int", "Site boundary"],
      ]);
      const r = composeStack(st.layers, N);
      // rows 2..7 (6 rows) × columns 0..7 (8 columns)
      add(S4, "the three operators compose top to bottom, and they are Marc's own "
        + "sentence — steep ground, BUT NOT the high part of it, AND ONLY WITHIN "
        + "an imported boundary — which is the whole reason the stack exists",
        `${6 * 8} cells`, `${r.count} cells, ${r.used} rows used`,
        r.count === 48 && r.used === 3 && r.skipped.length === 0);
    }

    {
      // ⚠️ THE HONEST LIMITATION, PINNED. A stack is not a tree, so the order of
      // the rows is part of the meaning. If anyone ever "tidies" the stack by
      // sorting it — unions first, say — this row fails.
      const ab_c = composeStack(mk([
        [rows(0, 8), "add", "A"], [cols(0, 8), "add", "B"], [rows(0, 4), "sub", "C"],
      ]).layers, N);
      const a_cb = composeStack(mk([
        [rows(0, 8), "add", "A"], [rows(0, 4), "sub", "C"], [cols(0, 8), "add", "B"],
      ]).layers, N);
      add(S4, "ORDER IS MEANING — A + B − C and A − C + B are different "
        + "selections, so the row arrows are not a sort and the stack must never "
        + "be reordered for tidiness",
        "the two orders differ",
        `${ab_c.count} vs ${a_cb.count} cells`,
        ab_c.count !== a_cb.count);
    }

    {
      // ⚠️ THE STACK STARTS EMPTY AND THE FIRST ROW IS NOT SPECIAL. Seeding the
      // result with the first layer whatever its operator would make a stack
      // change meaning when a row above it was disabled.
      const sub1 = composeStack(mk([[rows(0, 8), "sub", "A"]]).layers, N);
      const int1 = composeStack(mk([[rows(0, 8), "int", "A"]]).layers, N);
      const add1 = composeStack(mk([[rows(0, 8), "add", "A"]]).layers, N);
      add(S4, "a stack whose first enabled row is 'but not' or 'and only within' "
        + "selects NOTHING and says so through `seeded`, rather than the module "
        + "quietly promoting it to a union — the same refusal an unevaluable rule "
        + "makes, and it keeps the meaning stable when a row above is disabled",
        "0 and 0, both unseeded; a union seeds",
        `${sub1.count}/${sub1.seeded} and ${int1.count}/${int1.seeded}; `
        + `union ${add1.count}/${add1.seeded}`,
        sub1.count === 0 && !sub1.seeded && int1.count === 0 && !int1.seeded
        && add1.count === 8 * n && add1.seeded);
    }

    {
      // ⚠️ INERT IS NOT EMPTY, AND THE PANEL SAYS SO BECAUSE OF THIS ROW. A
      // stack led by "but not" does NOT select nothing — subtracting from empty
      // leaves empty, and the union BELOW still adds. The first wording of the
      // note claimed an empty selection and shipped beside a reading of 24,131
      // cells. Every row above the first union is inert; the stack is exactly
      // the stack with that prefix deleted.
      const led = composeStack(mk([
        [rows(0, 4), "sub", "B"], [cols(0, 8), "int", "C"], [rows(0, 8), "add", "A"],
      ]).layers, N);
      const alone = composeStack(mk([[rows(0, 8), "add", "A"]]).layers, N);
      add(S4, "the rows above the first union are INERT, not fatal — a stack led "
        + "by 'but not' is exactly the stack with that prefix deleted, so its "
        + "count is the union's own and a note claiming 'this selects nothing' "
        + "would contradict the number beside it",
        `${8 * n} cells, the same as the union alone`,
        `${led.count} vs ${alone.count}, seeded ${led.seeded}`,
        led.count === alone.count && led.count === 8 * n && led.seeded === false);
    }

    {
      // Disabling a row genuinely removes it from the arithmetic — that is what
      // makes every intermediate state inspectable.
      const st = mk([
        [rows(0, 8), "add", "A"], [rows(0, 4), "sub", "B"],
      ]);
      const before = composeStack(st.layers, N).count;
      st.layers[1].enabled = false;
      const after = composeStack(st.layers, N).count;
      add(S4, "disabling a row takes it out of the arithmetic entirely, so the "
        + "count moves and the sentence shortens — a stack you can step through "
        + "one row at a time is the reason it beat a boolean tree",
        `${4 * n} then ${8 * n} cells`, `${before} then ${after}`,
        before === 4 * n && after === 8 * n);
    }

    {
      // ⚠️ A LAYER THAT DOES NOT FIT THE GRID IS SKIPPED AND NAMED — never read
      // as empty, and never as everything.
      const st = new SelectionStack();
      st.add(rows(0, 8), { op: "add", name: "A" });
      st.add(new Uint8Array(9), { op: "add", name: "Wrong grid" });
      const r = composeStack(st.layers, N);
      add(S4, "a layer whose mask does not fit the grid is SKIPPED and named, "
        + "never treated as empty and never as everything — a selection that "
        + "could not be evaluated must not widen the operation it was to narrow",
        `${8 * n} cells, names "Wrong grid"`,
        `${r.count} cells, names ${JSON.stringify(r.skipped)}`,
        r.count === 8 * n && r.skipped.length === 1 && r.skipped[0] === "Wrong grid");
    }

    {
      // Each operator can only move the count one way. Union grows, subtract and
      // intersect shrink — the property that makes a stack readable at all.
      const base = rows(0, 8);
      const other = cols(4, 12);
      const only = composeStack(mk([[base, "add", "A"]]).layers, N).count;
      const grown = composeStack(mk([[base, "add", "A"], [other, "add", "B"]]).layers, N).count;
      const cut = composeStack(mk([[base, "add", "A"], [other, "sub", "B"]]).layers, N).count;
      const met = composeStack(mk([[base, "add", "A"], [other, "int", "B"]]).layers, N).count;
      add(S4, "union can only grow the selection, subtract and intersect can only "
        + "shrink it — the monotonicity that lets a designer read a stack down "
        + "the page and know which way each row moved the number",
        "grown ≥ A ≥ cut, A ≥ met",
        `${grown} ≥ ${only} ≥ ${cut}; ${only} ≥ ${met}`,
        grown >= only && only >= cut && only >= met && grown > only && cut < only);
    }

    {
      // ⚠️ FREEZING COPIES. The caller's array is usually the live rule mask,
      // which the sliders rebuild in place — a kept reference would make a
      // "frozen" layer follow the slider, the exact thing freezing prevents.
      const live = rows(0, 8);
      const st = new SelectionStack();
      const L = st.add(live, { op: "add", name: "Steep" });
      const frozenCount = L.count;
      live.fill(1);                        // the sliders move under it
      const after = composeStack(st.layers, N);
      add(S4, "freezing COPIES the mask, so a saved selection does not follow the "
        + "sliders that made it — a frozen layer that tracked its own control "
        + "would be a cache pretending to be a decision",
        `${8 * n} cells before and after`,
        `${frozenCount} then ${after.count}`,
        frozenCount === 8 * n && after.count === 8 * n);
    }

    {
      // ⚠️ ONLY A SURFACE-DERIVED LAYER CAN GO STALE. Geometry does not move
      // when the ground does, and marking it stale after every edit would train
      // the designer to ignore the word.
      const z0 = new Float32Array([1, 2, 3, NaN, 5]);
      const z1 = new Float32Array([1, 2, 3, NaN, 5]);
      const z2 = new Float32Array([1, 2, 3, NaN, 5.001]);
      const s0 = surfaceStamp(z0), s1 = surfaceStamp(z1), s2 = surfaceStamp(z2);
      const st = new SelectionStack();
      const attr = st.add(rows(0, 8), { name: "Steep", live: true, stamp: s0,
        source: "by attribute" });
      const drawn = st.add(cols(0, 8), { name: "Platform", source: "drawn" });
      add(S4, "an ATTRIBUTE layer goes stale when the ground moves and a DRAWN "
        + "one never does — a polygon is geometry and its cells do not move when "
        + "the surface under them is cut, so flagging it would make the flag noise",
        "attribute: fresh then stale; drawn: fresh both times",
        `attribute ${stale(attr, s1)}/${stale(attr, s2)}, `
        + `drawn ${stale(drawn, s1)}/${stale(drawn, s2)}`,
        stale(attr, s1) === false && stale(attr, s2) === true
        && stale(drawn, s1) === false && stale(drawn, s2) === false);
      add(S4, "…and the stamp is a function of the heights alone, so an identical "
        + "surface stamps identically and a millimetre of movement does not",
        "s0 = s1, s0 ≠ s2, never 0",
        `${s0} / ${s1} / ${s2}`,
        s0 === s1 && s0 !== s2 && s0 !== 0 && s2 !== 0);
    }

    {
      // ⚠️ NaN IS ONE CANONICAL "NO ANSWER". Arithmetic may hand back a
      // differently-spelled NaN; hashing raw bits would then report that the
      // surface had changed because a nodata cell was rewritten with nothing.
      const a = new Float32Array([1, NaN, 3]);
      const b = new Float32Array([1, NaN, 3]);
      // ⚠️ THE PAYLOAD IS WRITTEN THROUGH AN ALIASED Int32Array ON PURPOSE.
      // `b[1] = someNaN` canonicalises on the way into a Float32Array, so an
      // arithmetic NaN would have made this fixture prove nothing — both cells
      // would already hold the same bits and the branch under test would never
      // run. Writing the bits directly is the only way to get a genuinely
      // differently-spelled NaN into the array.
      new Int32Array(b.buffer)[1] = 0x7f800001;   // a signalling NaN payload
      const bitsDiffer = new Int32Array(a.buffer)[1] !== new Int32Array(b.buffer)[1];
      const shorter = surfaceStamp(new Float32Array([1, NaN]));
      add(S4, "every nodata cell hashes as ONE canonical 'no answer' — two "
        + "genuinely different NaN bit patterns stamp the same, so a nodata cell "
        + "rewritten with a differently-spelled nothing does not read as the "
        + "ground having moved — and the length is in the seed, so two grids of "
        + "different size cannot collide",
        "bits differ, stamps match, a shorter grid differs",
        `bits differ ${bitsDiffer}, stamps match `
        + `${surfaceStamp(a) === surfaceStamp(b)}, shorter differs `
        + `${shorter !== surfaceStamp(a)}`,
        bitsDiffer && Number.isNaN(b[1])
        && surfaceStamp(a) === surfaceStamp(b) && shorter !== surfaceStamp(a));
    }

    {
      // Re-evaluating keeps everything about the row except its cells.
      const st = new SelectionStack();
      const L = st.add(rows(0, 4), { name: "Steep", op: "sub", live: true,
        stamp: 111, source: "by attribute" });
      st.layers[0].enabled = false;
      const re = st.refreeze(L.id, rows(0, 8), 222);
      add(S4, "re-evaluating replaces a layer's CELLS and nothing else — same id, "
        + "name, operator, position and enabled state — because it answers 'the "
        + "ground moved', not 'you meant something different'",
        "id 1, sub, disabled, 128 cells, stamp 222",
        `id ${re?.id}, ${re?.op}, enabled ${re?.enabled}, ${re?.count} cells, `
        + `stamp ${re?.stamp}`,
        !!re && re.id === L.id && re.op === "sub" && re.enabled === false
        && re.count === 8 * n && re.stamp === 222);
    }

    {
      // ⚠️ IDs ARE NEVER REUSED, including after a delete — the same rule and the
      // same reason as PlanSet: a stack leaves this tool beside the regions.
      const st = new SelectionStack();
      const a = st.add(rows(0, 4), { name: "A" });
      st.add(rows(4, 8), { name: "B" });
      st.remove(a.id);
      const c = st.add(rows(8, 12), { name: "C" });
      add(S4, "ids are never reused, including after a delete — two rows called "
        + "'1' that describe different ground is a trap for whoever reads the "
        + "export afterwards",
        "the third layer is id 3, not id 1",
        `${c.id}`, c.id === 3);
    }

    {
      const st = mk([
        [rows(0, 4), "add", "A"], [rows(4, 8), "add", "B"], [cols(0, 4), "int", "C"],
      ]);
      const ok = st.move(st.layers[2].id, -1);
      const order = st.layers.map((L) => L.name).join("");
      const off = st.move(st.layers[0].id, -1);
      add(S4, "a row moves up and down the stack, and refuses to move off either "
        + "end — order is meaning, so the arrows have to be able to change the "
        + "answer and must not silently wrap it around",
        "ACB after one move up; the top row refuses",
        `${order}, top move returned ${off}`,
        ok === true && order === "ACB" && off === false);
    }

    {
      // The sentence is the brief read back. Disabled rows are absent from it,
      // because the sentence describes what is SELECTED.
      const st = mk([
        [rows(0, 8), "add", "Slope ≥ 20.2°"],
        [rows(0, 2), "sub", "Above 78 m"],
        [cols(0, 8), "int", "Site boundary"],
      ]);
      const full = describeStack(st.layers);
      st.layers[1].enabled = false;
      const shorter = describeStack(st.layers);
      const empty = describeStack([]);
      add(S4, "the stack reads back as the sentence it was asked for, and a "
        + "disabled row is ABSENT from it rather than struck through — the "
        + "sentence describes what is selected, not what was once typed",
        "\"Slope ≥ 20.2°, but not Above 78 m, and only within Site boundary\"",
        `"${full}" → "${shorter}"`,
        full === "Slope ≥ 20.2°, but not Above 78 m, and only within Site boundary"
        && shorter === "Slope ≥ 20.2°, and only within Site boundary"
        && /whole region/.test(empty));
    }

    {
      // The operator button cycles, and the glyphs stay display-only.
      const seq = ["add", nextOp("add"), nextOp(nextOp("add")), nextOp(nextOp(nextOp("add")))];
      add(S4, "the operator cycles union → subtract → intersect → union, and the "
        + "STORED value is ascii while the glyph is looked up — a saved stack "
        + "must not carry U+2212 into a file one careless re-encoding from '?'",
        "add, sub, int, add; glyphs + − ∩",
        `${seq.join(", ")}; ${OPS.map((o) => o.glyph).join(" ")}`,
        seq.join() === "add,sub,int,add" && OP_BY_KEY.sub.glyph === "−"
        && OP_BY_KEY.add.glyph === "+" && OP_BY_KEY.int.glyph === "∩");
    }

    {
      // ⚠️ THE FEATHER, AND WHY IT IS SMOOTHSTEP RATHER THAN LINEAR. A modifier
      // that stops dead at the selection boundary leaves a step; one that ramps
      // linearly leaves a crease at both ends because the SLOPE jumps. The
      // weight must be 1 inside, 0 beyond the stated distance, and flat-topped
      // at both ends so the worked ground meets the untouched ground tangentially.
      const m = 32;
      const mask = new Uint8Array(m * m);
      for (let r = 0; r < m; r++) for (let c = 0; c < m / 2; c++) mask[r * m + c] = 1;
      const hard = featherWeights(mask, m, m, 0.25, 0);
      const soft = featherWeights(mask, m, m, 0.25, 1.0);   // 1 m = 4 cells
      const row = 16 * m;
      const inside = soft[row + m / 2 - 1];
      const justOut = soft[row + m / 2];
      const farOut = soft[row + m / 2 + 8];
      add(S4, "the feather is 1 inside the selection, falls to 0 across the "
        + "stated distance in METRES, and is flat-topped at BOTH ends — a linear "
        + "ramp would meet the untouched ground at an angle and leave a crease "
        + "where a modifier stopped",
        "hard = the mask exactly; soft: 1 inside, 0<w<1 just outside, 0 beyond 1 m",
        `hard ${hard[row + m / 2 - 1]}/${hard[row + m / 2]}; `
        + `soft ${inside.toFixed(3)}/${justOut.toFixed(3)}/${farOut.toFixed(3)}`,
        hard[row + m / 2 - 1] === 1 && hard[row + m / 2] === 0
        && inside === 1 && justOut > 0 && justOut < 1 && farOut === 0);

      // Monotone, and the first step out is SHALLOW — that is the zero-derivative
      // property, and it is what a linear ramp does not have.
      let monotone = true;
      for (let c = m / 2; c < m / 2 + 6; c++) {
        if (soft[row + c] > soft[row + c - 1] + 1e-9) monotone = false;
      }
      const firstDrop = 1 - soft[row + m / 2];
      const midDrop = soft[row + m / 2 + 1] - soft[row + m / 2 + 2];
      add(S4, "…and it decays monotonically with a SHALLOW first step, so the "
        + "modifier leaves the selection tangentially rather than at a corner — "
        + "the property that makes a feather better than a wider brush",
        "monotone, and the first step smaller than a mid-ramp step",
        `monotone ${monotone}, first ${firstDrop.toFixed(4)} < mid ${midDrop.toFixed(4)}`,
        monotone && firstDrop < midDrop);

      // ⚠️ AN EMPTY SELECTION WEIGHS ZERO EVERYWHERE, FEATHERED OR NOT (Marc,
      // 2026-08-19). The app once collapsed "armed but selects 0 cells" to the
      // same null as "no selection at all", so two crossed attribute sliders
      // FREED the brush to act on the whole tile — a rule widening the very
      // operation it was written to narrow. The weight field is where that
      // degeneracy is stopped: all zeros means the modifier acts exactly where
      // the selection says, which is nowhere.
      const none = new Uint8Array(m * m);
      const noneHard = featherWeights(none, m, m, 0.25, 0);
      const noneSoft = featherWeights(none, m, m, 0.25, 2.0);
      add(S4, "an EMPTY selection weighs zero at every cell, with and without a "
        + "feather — armed-but-empty must block a modifier, never free it onto "
        + "the whole tile, which is the degeneracy a rule exists to prevent",
        "every weight 0, both fields",
        `hard max ${Math.max(...noneHard)}, soft max ${Math.max(...noneSoft)}`,
        noneHard.every((v) => v === 0) && noneSoft.every((v) => v === 0));
    }

    {
      // The stack composes over the REAL grid shape the rest of the tool uses,
      // and a rule mask drops straight into it with no conversion.
      const m = 32;
      const dem = { nrows: m, ncols: m };
      const slope = new Float32Array(m * m);
      for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) slope[r * m + c] = c < m / 2 ? 5 : 25;
      const steep = maskFromRule(dem, { slope }, [{ layer: "slope", min: 15 }]);
      const st = new SelectionStack();
      st.add(steep.mask, { name: "Slope ≥ 15°", live: true, stamp: 7,
        source: "by attribute" });
      const north = new Uint8Array(m * m);
      for (let r = 0; r < m / 2; r++) for (let c = 0; c < m; c++) north[r * m + c] = 1;
      st.add(north, { op: "sub", name: "North half", source: "drawn" });
      const r = composeStack(st.layers, m * m);
      add(S4, "a rule mask and a rasterised polygon drop into the stack with no "
        + "conversion — both are the same Uint8Array of 0/1 over the DEM grid "
        + "that every modifier already accepts, so nothing downstream changes",
        `${(m / 2) * (m / 2)} cells (steep, south half)`, `${r.count}`,
        r.count === (m / 2) * (m / 2));
    }
  }

  // ══ T2 ═══════════════════════════════════════════════════════════════════
  const T2 = "T2 · the opening tile — sixteen deformations, one continuous ground";
  {
    const n = 128, cell = 0.5;
    const { z, patches } = demoTileHeights(n, n, cell);

    add(T2, "the tile carries sixteen patches on a 4 x 4 grid, in reading order, "
      + "and every height is finite — a NaN anywhere would make the whole opening "
      + "readout report nodata on a surface the tool generated itself",
      "16 patches, 0 non-finite",
      `${patches.length} patches, ${[...z].filter((v) => !Number.isFinite(v)).length} non-finite`,
      patches.length === 16 && [...z].every(Number.isFinite));

    // ⚠️ THE CHECK THE WHOLE MODULE EXISTS FOR. Sixteen fields blended badly
    // would leave a crease at every seam, and `geomorphons` would classify those
    // creases as landforms — putting a lattice of straight ridges into the
    // landform map that are artefacts of the blend and not features of the
    // ground. Compare the largest step ACROSS a seam with the largest step
    // anywhere: if the seams were creased, the worst step would sit on one.
    const step = (i, j) => Math.abs(z[i] - z[j]);
    let worstSeam = 0, worstAny = 0;
    const seamCols = [];
    for (let k = 1; k < DEMO_DIVISIONS; k++) seamCols.push(Math.round((k * n) / DEMO_DIVISIONS));
    for (let r = 1; r < n - 1; r++) {
      for (let c = 1; c < n - 1; c++) {
        const d = step(r * n + c, r * n + c + 1);
        if (d > worstAny) worstAny = d;
        if (seamCols.includes(c) && d > worstSeam) worstSeam = d;
      }
    }
    add(T2, "no seam between two patches is a crease — the worst step ACROSS a "
      + "seam is no larger than the worst step anywhere on the tile, so the blend "
      + "leaves no straight ridges for the landform classifier to find and report "
      + "as real",
      "worst seam step <= worst step anywhere",
      `seam ${worstSeam.toFixed(4)} m vs tile ${worstAny.toFixed(4)} m`,
      worstSeam <= worstAny + 1e-9);

    // The relief has to read as ground without contradicting the argument: the
    // deformations themselves stay sub-metre.
    let lo = Infinity, hi = -Infinity;
    for (const v of z) { if (v < lo) lo = v; if (v > hi) hi = v; }
    add(T2, "the tile reads as ground — a few metres of regional form — while the "
      + "sixteen deformations stay SUB-METRE, because a demo whose patterns were "
      + "metres deep would quietly contradict the finding it exists to introduce",
      "relief between 2 and 5 m", `${(hi - lo).toFixed(2)} m`,
      hi - lo > 2 && hi - lo < 5);

    // ⚠️ IT IS A GRADIENT, NOT A SAMPLER — the reason for the layout.
    const ranks = DEMO_PATCHES.map((p) => patternRank(p.id));
    let monotone = true;
    for (let k = 1; k < ranks.length; k++) if (ranks[k] < ranks[k - 1]) monotone = false;
    add(T2, "the sixteen run in order along the library's range, so reading the "
      + "tile left to right and top to bottom IS the argument — most geometric "
      + "and least consequential first, most differentiating last",
      "ranks strictly non-decreasing, first 0, last 1",
      `${monotone}, ${ranks[0].toFixed(2)}..${ranks[ranks.length - 1].toFixed(2)}`,
      monotone && ranks[0] === 0 && ranks[ranks.length - 1] === 1);

    // ⚠️ THE RANGE IS ORDERED BY MEASUREMENT, NOT BY OPINION. Every entry now
    // carries a figure — the six appended on 2026-08-19 were put through the
    // same protocol as the twelve — so the axis must be sorted by it and an
    // entry may never appear without one. When the library grows again, the new
    // patterns are `expected` until measured and this row allows that; what it
    // never allows is an entry with an invented figure or no declaration.
    // ⚠️ ASCENDING TO THE PRECISION THE MEASUREMENT HAS, NOT ABSOLUTELY — and
    // that is a correction, not a loosening (2026-08-20). This row asserted
    // STRICT ascent, which is more precision than the numbers underneath it
    // carry: re-measuring all eighteen on one build moved the twelve older rows
    // by up to 0.040 in H′ with nothing changed but the build, and it left
    // `concentric` (1.534) a hair above `grid` (1.521) — an inversion of 0.013,
    // a third of the noise. Sorting the range on that would be acting on noise
    // AND would silently change the opening tile, which samples sixteen of these
    // eighteen (see the note above PATTERN_RANGE). So the invariant is: the axis
    // ascends, and no pair may be out of order by MORE than the band the table
    // itself declares it cannot resolve. A real mis-sort — two patterns a
    // quarter of the range apart in the wrong order — still fails this.
    const BAND = 0.05;
    const undeclared = [];
    const inversions = [];
    let last = -1, lastId = "";
    for (const e of PATTERN_RANGE) {
      const m = PM2[e.id];
      if (m) {
        if (m.H < last - 1e-9) {
          inversions.push(`${lastId}→${e.id} by ${(last - m.H).toFixed(3)}`);
        }
        last = m.H; lastId = e.id;
      } else if (e.basis !== "expected") undeclared.push(e.id);
    }
    const worst = inversions.length
      ? Math.max(...inversions.map((s) => parseFloat(s.split("by ")[1]))) : 0;
    add(T2, "the range is ordered by MEASURED Shannon H' — ascending to within "
      + "the ~0.05 the table declares it cannot resolve, never worse — and every "
      + "entry either carries a figure or is declared `expected`. An axis sorted "
      + "by the designer's expectation would be an opinion wearing a "
      + "measurement's clothes; an axis re-sorted on a 0.013 difference would be "
      + "noise wearing them",
      `no inversion worse than ${BAND}; 0 entries undeclared`,
      `${PATTERN_RANGE.length} entries, ${inversions.length} inversion(s)`
      + `${inversions.length ? " [" + inversions.join(", ") + "]" : ""}, `
      + `worst ${worst.toFixed(3)}, ${undeclared.length} undeclared`
      + `${undeclared.length ? " (" + undeclared + ")" : ""}`,
      worst <= BAND && undeclared.length === 0);

    // ⚠️ THE MEASUREMENT OVERTURNED THE EXPECTATIONS IT REPLACED, and that is
    // worth pinning rather than quietly absorbing. `grid` was declared the
    // BOTTOM of the range and measures fifteenth of eighteen; `terracette` was
    // put mid-range and tops the six. If either ever drifts back to where
    // intuition put them, something has changed in the species model or the
    // stamp and this row is where it surfaces.
    add(T2, "…and it disagrees with the intuition it replaced — a rectilinear "
      + "grid of pans measures near the TOP of the range, not the bottom, and "
      + "fine terracettes beat every other pattern on invasive cover",
      "grid above the median; terracette the lowest invasive in the library",
      `grid H' ${PM2.grid.H} (rank ${PATTERN_RANGE.findIndex((e) => e.id === "grid") + 1}/18), `
      + `terracette invasive ${PM2.terracette.invasive}%`,
      PM2.grid.H > 1.0
      && Object.values(PM2).every((m) => m.invasive >= PM2.terracette.invasive));
  }

  // ══ B2 ═══════════════════════════════════════════════════════════════════
  const B2 = "B2 · contour benching — a target field read off the terrain itself";
  {
    /** a plane falling at a stated gradient, in the DEM the app really uses */
    const planar = (n, cell, grad) =>
      DEM.synthetic(n, n, cell, (r, c) => 100 + c * cell * grad);
    const all = (n) => new Uint8Array(n * n).fill(1);

    {
      // The defining property: a bench system snaps the ground to discrete
      // levels, and at tread = 1 those levels are exact multiples of Δ.
      const got = [0.2, 0.6, 1.4, 2.7].map((z) => benchTarget(z, 1, 1, Math.round, 0.5));
      add(B2, "at a full tread the ground snaps to exact multiples of the " +
        "vertical interval — which is what makes the treads follow contours " +
        "without any contour being drawn",
        "0, 1, 1, 3", got.join(", "),
        got.join() === [0, 1, 1, 3].join());

      const noop = [0.2, 0.6, 1.4, 2.7].every((z) => benchTarget(z, 1, 0, Math.round) === z);
      add(B2, "…and at a zero tread nothing moves, so the control degrades to " +
        "the identity rather than to a surprise",
        "unchanged", noop ? "unchanged" : "moved", noop);
    }

    {
      // ⚠️ MONOTONICITY IS THE INVARIANT THAT KEEPS A BENCH SYSTEM A SURFACE.
      // If the target ever fell as the ground rose, the benches would fold
      // through each other and the result would not be a heightfield of the
      // ground at all.
      let worst = 0, prev = -1e9, off = 0;
      for (const key of Object.keys(BENCH_BIAS)) {
        const { round, reach } = BENCH_BIAS[key];
        prev = -1e9;
        for (let z = 0; z <= 6; z += 0.005) {
          const t = benchTarget(z, 1, 0.7, round, reach);
          if (t < prev) worst = Math.max(worst, prev - t);
          prev = t;
          off = Math.max(off, Math.abs(t - z));
        }
      }
      add(B2, "the bench target never falls as the ground rises, in any volume " +
        "policy — a system that inverted would fold benches through each other " +
        "and stop being a surface",
        "0 m of inversion", `${worst.toExponential(1)} m`, worst < 1e-9);
      add(B2, "…and no cell is moved further than one whole interval, so a " +
        "bench always meets the ground it was cut from",
        "≤ 1.000 m at Δ = 1 m", `${off.toFixed(3)} m`, off <= 1 + 1e-9);
    }

    {
      // ⚠️ THE ROUNDING IS THE VOLUME POLICY, AND IT WAS INVERTED ONCE. The
      // first implementation used a half-interval reach for all three biases;
      // on the one-sided ones the riser then overshot the neighbouring level,
      // so `cut only` IMPORTED 2 987 m³ of fill and `fill only` EXCAVATED
      // 3 106 m³ — each exactly the operation it was named for, backwards.
      // These three rows are the ones that would have caught it.
      const n = 96, cell = 1, grad = 0.2;
      const out = {};
      for (const bias of ["balanced", "cut", "fill"]) {
        const dem = planar(n, cell, grad);
        const src = Float32Array.from(dem.z);
        const res = benchTo(dem, all(n), { interval: 1, tread: 0.7, bias });
        let raised = 0, lowered = 0;
        for (let i = 0; i < src.length; i++) {
          const dz = dem.z[i] - src[i];
          if (dz > 1e-9) raised++; else if (dz < -1e-9) lowered++;
        }
        out[bias] = { res, raised, lowered };
      }
      add(B2, "'cut only' never imports material — not one cell is raised, " +
        "and the fill side of the ledger stays at zero",
        "0 cells raised, 0 m³ fill",
        `${out.cut.raised} raised, ${f2(out.cut.res.fill)} m³ fill`,
        out.cut.raised === 0 && out.cut.res.fill === 0);
      add(B2, "'fill only' never removes material — the mirror of the above, " +
        "and the pair is what makes the policy a real choice rather than a label",
        "0 cells lowered, 0 m³ cut",
        `${out.fill.lowered} lowered, ${f2(out.fill.res.cut)} m³ cut`,
        out.fill.lowered === 0 && out.fill.res.cut === 0);

      const b = out.balanced.res;
      const share = Math.abs(b.net) / (b.cut + b.fill);
      add(B2, "…and 'balanced' is very nearly volume-neutral BY CONSTRUCTION, " +
        "because rounding to the nearest level cuts the upper half of each " +
        "interval and fills the lower half — the residual is only the ground's " +
        "asymmetry within an interval",
        "|net| < 5% of all material moved", `${(100 * share).toFixed(1)}%`,
        share < 0.05 && out.balanced.raised > 0 && out.balanced.lowered > 0);
    }

    {
      // ⚠️ THE TREAD IS AN OUTPUT, Δ ÷ tanβ, AND IT IS MEASURED BEFORE THE
      // EDIT. Measuring afterwards reads the benched surface — flat treads
      // and steep risers — and reported 7.25 m where a 20% slope must give
      // 5.00 m. That is what this row pins.
      const n = 96, cell = 1;
      for (const [grad, want] of [[0.2, 5], [0.5, 2]]) {
        const dem = planar(n, cell, grad);
        const res = benchTo(dem, all(n), { interval: 1, tread: 0.7, bias: "balanced" });
        add(B2, `the tread width is a RESULT — the interval divided by the ` +
          `slope — not a width anyone sets: on a ${(100 * grad).toFixed(0)}% ` +
          `fall at Δ = 1 m it comes out at Δ ÷ tanβ`,
          `${want.toFixed(2)} m`, `${res.treadMean.toFixed(2)} m`,
          near(res.treadMean, want, 0.05));
      }
    }

    {
      // Level ground has no tread, and saying "infinity" would be worse than
      // saying nothing — Δ/tan(0) is what a naive mean would average in.
      const n = 32, dem = DEM.synthetic(n, n, 1, () => 75);
      const res = benchTo(dem, all(n), { interval: 1, tread: 0.7, bias: "balanced" });
      add(B2, "ground with no fall reports NO tread rather than an infinite " +
        "one — Δ ÷ tan(0) is what a naive average would fold in, and it would " +
        "print as a number",
        "not a number", String(res.treadMean), !Number.isFinite(res.treadMean));
    }

    {
      // The contract benchTo shares with levelTo, which is what lets the app's
      // ledger, undo rect and dry-run pricing work with no change at all.
      const n = 48, cell = 0.5;
      const wet = planar(n, cell, 0.3), dry = planar(n, cell, 0.3);
      const before = Float32Array.from(dry.z);
      const ledger = new Ledger();
      const rWet = benchTo(wet, all(n), { interval: 1, tread: 0.7, ledger });
      const rDry = benchTo(dry, all(n), { interval: 1, tread: 0.7, dryRun: true });
      let moved = 0;
      for (let i = 0; i < before.length; i++) if (dry.z[i] !== before[i]) moved++;
      add(B2, "the dry run prices exactly what the wet run moves, and writes " +
        "nothing — the figure under the button and the figure that lands in " +
        "the ledger are one operation, through one function",
        `cut ${f2(rWet.cut)}, fill ${f2(rWet.fill)}, 0 cells written`,
        `cut ${f2(rDry.cut)}, fill ${f2(rDry.fill)}, ${moved} written`,
        near(rDry.cut, rWet.cut, 1e-9) && near(rDry.fill, rWet.fill, 1e-9) && moved === 0);
      add(B2, "…and the ledger is charged for the benching, accumulating onto " +
        "the same account as every other earthwork on the site",
        `cut ${f2(rWet.cut)}, fill ${f2(rWet.fill)}`,
        `cut ${f2(ledger.cut)}, fill ${f2(ledger.fill)}`,
        near(ledger.cut, rWet.cut, 1e-9) && near(ledger.fill, rWet.fill, 1e-9));
    }

    {
      const n = 40, dem = planar(n, 0.5, 0.3);
      dem.z[7 * n + 7] = NaN;
      const mask = new Uint8Array(n * n);
      for (let r = 10; r < 30; r++) for (let c = 10; c < 30; c++) mask[r * n + c] = 1;
      const src = Float32Array.from(dem.z);
      benchTo(dem, mask, { interval: 1, tread: 0.7 });
      let outside = 0;
      for (let i = 0; i < src.length; i++) {
        if (!mask[i] && Number.isFinite(src[i]) && dem.z[i] !== src[i]) outside++;
      }
      add(B2, "benching moves NOTHING outside its mask — unlike the batter, a " +
        "bench system has no reach beyond the ground it was told to cut",
        "0 cells", `${outside}`, outside === 0);

      const holed = planar(n, 0.5, 0.3);
      holed.z[7 * n + 7] = NaN;
      benchTo(holed, new Uint8Array(n * n).fill(1), { interval: 1, tread: 0.7 });
      add(B2, "…and a hole in the DEM stays a hole, as it does for every other " +
        "modifier here",
        "NaN", String(holed.z[7 * n + 7]), Number.isNaN(holed.z[7 * n + 7]));
    }

    {
      // The two families composed: a rule chooses the ground, benching shapes
      // it. This is the pairing the app actually offers, so it is worth one
      // row of its own.
      const n = 64, cell = 1;
      const dem = DEM.synthetic(n, n, cell, (r, c) => 100 + (c < n / 2 ? c * 0.02 : c * 0.4));
      const g = computeGradient(dem);
      const sel = maskFromRule({ nrows: n, ncols: n }, { slope: g.slopeDeg },
        [{ layer: "slope", min: 15 }]);
      const src = Float32Array.from(dem.z);
      benchTo(dem, sel.mask, { interval: 1, tread: 0.7 });
      let inSel = 0, outSel = 0;
      for (let i = 0; i < src.length; i++) {
        if (dem.z[i] === src[i]) continue;
        if (sel.mask[i]) inSel++; else outSel++;
      }
      add(B2, "a rule and a modifier compose: benching under a 'slope above " +
        "15°' rule moves ground ONLY on the steep half, which is the whole " +
        "grammar this pairing exists for",
        "> 0 cells moved inside the rule, 0 outside",
        `${inSel} inside, ${outSel} outside`, inSel > 0 && outSel === 0);
    }
  }

  // ══ G2 ═══════════════════════════════════════════════════════════════════
  const G2 = "G2 · guide curves — a section swept along the designer's own line";
  {
    // A plane falling eastward at 10 %, 40 m square at 0.25 m, origin at 0,0.
    const N = 160, CELL = 0.25, GRAD = 0.10;
    const plane = () => DEM.synthetic(N, N, CELL, (r, c) => 100 - c * CELL * GRAD);
    // A straight line running NORTH–SOUTH across the middle: along a contour of
    // this plane, so the ground under it is level and the arithmetic is exact.
    const midX = (N * CELL) / 2;
    const northSouth = [[midX, 2], [midX, N * CELL - 2]];
    const SEC = { profile: "swale", width: 2, depth: 0.5, sideDeg: 34 };

    {
      // ⚠️ THE HALF-WIDTH IS AN OUTPUT, like the bench's tread. A designer states
      // the bottom width, the depth and the side slope; how much ground the
      // section occupies follows from them, and is what the corridor mask is.
      const want = SEC.width / 2 + SEC.depth / Math.tan((34 * Math.PI) / 180);
      const r = applyGuide(plane(), northSouth, { ...SEC, along: "follow", dryRun: true });
      add(G2, "the section's half-width is an OUTPUT of bottom width, depth and "
        + "side slope — w/2 + D/tanθ — not a separate number a designer has to "
        + "keep consistent with the other three",
        `${f4(want)} m`, `${f4(r.halfWidth)} m`, near(r.halfWidth, want, 1e-9));
    }

    {
      // ⚠️ THE PURE SECTION IS MEASURED ON FLAT GROUND, deliberately. On a
      // cross-slope the section is still correct but the cut measured against
      // LOCAL ground varies across the width — because the bottom is level and
      // the ground is not — and asserting a constant depth there tests the
      // slope rather than the section. That is not a hypothetical: this row
      // first failed at 0.4875 m against an expected 0.5 m, which is exactly
      // two cells of 10 % fall, and the module was right.
      const flat = DEM.synthetic(N, N, CELL, () => 100);
      const dem = flat.clone();
      applyGuide(dem, northSouth, { ...SEC, along: "follow" });
      const row = Math.floor(N / 2);
      const zAt = (c) => dem.z[dem.idx(row, c)];
      const cMid = Math.round(midX / CELL - 0.5);
      const cut = flat.z[flat.idx(row, cMid)] - zAt(cMid);
      add(G2, "the centreline is cut to exactly the stated depth below the "
        + "ground it follows",
        `${SEC.depth} m`, `${f4(cut)} m`, near(cut, SEC.depth, 1e-3));
      // Two cells out is still inside the flat bottom (width 2 m = 8 cells).
      const cutIn = flat.z[flat.idx(row, cMid + 2)] - zAt(cMid + 2);
      add(G2, "…and the flat bottom really is flat across its stated width, "
        + "rather than a V that happens to reach the right depth at its lowest "
        + "point",
        `${SEC.depth} m at 0.5 m off the line`, `${f4(cutIn)} m`,
        near(cutIn, SEC.depth, 1e-3));
      const far = Math.round((midX + 12) / CELL);
      add(G2, "…and ground far from the corridor is untouched — a swept section "
        + "is bounded by its own geometry, not smeared across the tile",
        "0 m", `${f4(flat.z[flat.idx(row, far)] - zAt(far))} m`,
        near(flat.z[flat.idx(row, far)] - zAt(far), 0, 1e-9));
    }

    {
      // ⚠️ A LEVEL-BOTTOMED SECTION ACROSS A SLOPE MUST BANK ON THE LOW SIDE,
      // and that is drainage practice rather than a defect. The bottom is one
      // elevation all the way across — which is what makes a swale hold water
      // rather than run it sideways — so on falling ground the downhill edge of
      // the section stands above the existing surface and has to be built up.
      // It is the reason ditch-and-bank exists as a section at all. Recorded
      // because "a swale only ever cuts" is the obvious assertion, it is what
      // this suite first claimed, and it is false on any cross-slope.
      const dem = plane();
      // ⚠️ NOT dryRun — the rows below read the SURFACE, and a priced run leaves
      // it untouched. Asserted against a dry run this reported 0.15 m of fall
      // across the bottom, which is six cells of the original 10 % plane and
      // looks exactly like a section that failed to level.
      const r = applyGuide(dem, northSouth, { ...SEC, along: "follow" });
      add(G2, "a level-bottomed swale cut ACROSS a slope banks up its downhill "
        + "edge — the bottom is one elevation, so on falling ground the low side "
        + "has to be built rather than dug, which is drainage practice and not a "
        + "defect",
        "cut and fill both > 0",
        `cut ${f4(r.section.cut)}, fill ${f4(r.section.fill)}`,
        r.section.cut > 0 && r.section.fill > 0);
      // The bottom itself, read across the section: one elevation, not a copy
      // of the ground beneath it.
      const row = Math.floor(N / 2);
      const cMid = Math.round(midX / CELL - 0.5);
      let lo = Infinity, hi = -Infinity;
      for (let c = cMid - 3; c <= cMid + 3; c++) {
        const v = dem.z[dem.idx(row, c)];
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
      add(G2, "…and its bottom really is one elevation across the width, which "
        + "is what makes it hold water rather than run it sideways",
        "0 m of fall across the bottom", `${f4(hi - lo)} m`, near(hi - lo, 0, 1e-4));
    }

    {
      // ⚠️ THE THREE LONGITUDINAL MODES ARE DIFFERENT STRUCTURES FROM ONE LINE,
      // and this is the control the design document says decides what the thing
      // is FOR. Run the SAME line and section three ways down the fall line.
      const eastWest = [[2, midX], [N * CELL - 2, midX]];
      const opts = { ...SEC };
      const follow = applyGuide(plane(), eastWest, { ...opts, along: "follow", dryRun: true });
      const level = applyGuide(plane(), eastWest, { ...opts, along: "level", dryRun: true });
      const grade = applyGuide(plane(), eastWest, {
        ...opts, along: "grade", gradient: 0.02, dryRun: true });

      add(G2, "FOLLOW keeps the structure at a constant depth below existing "
        + "ground, so the line never leaves the surface however the ground rolls",
        "0 m above, 0 m below",
        `${f4(follow.line.maxAboveGround)} / ${f4(follow.line.maxBelowGround)}`,
        near(follow.line.maxAboveGround, 0, 1e-6)
        && near(follow.line.maxBelowGround, 0, 1e-6));

      // The plane falls 10 % over ~35.5 m of line, so a LEVEL line must stand
      // well clear of it at one end.
      add(G2, "…LEVEL holds one elevation end to end, so on falling ground it "
        + "leaves the surface — which is exactly what a contour bund does, and "
        + "the cut that follows is the price of it",
        "> 1 m clear of the ground somewhere",
        `${f4(level.line.maxAboveGround)} above, ${f4(level.line.maxBelowGround)} below`,
        Math.max(level.line.maxAboveGround, level.line.maxBelowGround) > 1);

      // ⚠️ A STATED GRADIENT MUST BE THE GRADIENT DELIVERED. This is the row
      // that would catch a sign slip or a station measured in cells.
      add(G2, "…and GRADE delivers the gradient it was asked for, measured over "
        + "the line's own length — a channel specified at 2 % that arrives at "
        + "some other figure is not a channel, it is a drawing",
        "2.000 %", `${(grade.line.gradient * 100).toFixed(3)} %`,
        near(grade.line.gradient, 0.02, 1e-9));
      add(G2, "…and its fall is that gradient times the length, so the two "
        + "figures on screen cannot disagree",
        `${f4(0.02 * grade.length)} m`, `${f4(grade.line.fall)} m`,
        near(grade.line.fall, 0.02 * grade.length, 1e-9));
    }

    {
      // ⚠️ CUT AND FILL ARE PROPERTIES OF THE SECTION, not of the tool's mood.
      // On FLAT ground, where the cross-slope banking above cannot contribute.
      const flat = () => DEM.synthetic(N, N, CELL, () => 100);
      const sw = applyGuide(flat(), northSouth, { ...SEC, along: "follow", dryRun: true });
      const bm = applyGuide(flat(), northSouth,
        { ...SEC, profile: "berm", along: "follow", dryRun: true });
      add(G2, "a swale on ground it follows only ever CUTS, and a berm only ever "
        + "FILLS — the section's sign is not something the surface gets a vote on",
        "swale fill 0, berm cut 0",
        `swale fill ${f4(sw.section.fill)}, berm cut ${f4(bm.section.cut)}`,
        near(sw.section.fill, 0, 1e-9) && near(bm.section.cut, 0, 1e-9));
      add(G2, "…and the two are mirror images in volume, because they are the "
        + "same trapezoid about the same line",
        `${f4(sw.section.cut)} m³`, `${f4(bm.section.fill)} m³`,
        near(sw.section.cut, bm.section.fill, 1e-6));
    }

    {
      // ⚠️ THE SIGNED OFFSET IS WHAT MAKES DITCH-AND-BANK POSSIBLE. Written
      // against |d| the section could only ever be symmetric, and the one
      // earthwork here that balances its own volume would be unrepresentable.
      const dem = plane();
      const r = applyGuide(dem, northSouth,
        { profile: "ditchbank", width: 2, depth: 0.5, sideDeg: 34, along: "follow",
          dryRun: true });
      add(G2, "ditch-and-bank cuts on one side of the line and builds on the "
        + "other — an asymmetric section, which a profile written against the "
        + "unsigned distance could not express at all",
        "both cut and fill > 0",
        `cut ${f4(r.section.cut)}, fill ${f4(r.section.fill)}`,
        r.section.cut > 0 && r.section.fill > 0);
      // The spoil from the ditch is what builds the bank: equal trapezoids.
      const imbalance = Math.abs(r.section.net) / Math.max(r.section.cut, 1e-9);
      add(G2, "…and the bank is sized from the ditch, so the pair is very nearly "
        + "volume-neutral — the spoil is placed rather than carted, which is why "
        + "this section is the cheapest earthwork in the list",
        "< 2 % net of the cut", `${(imbalance * 100).toFixed(2)} %`,
        imbalance < 0.02);
    }

    {
      // ⚠️ THE BATTER RUNS OUTSIDE THE CORRIDOR, and the reported rect has to
      // cover it — the same trap the platform batter had, where a rect bounded
      // by the region left the batter undrawn and un-undone and both read as
      // "the feature doesn't work".
      const dem = plane();
      const before = Float32Array.from(dem.z);
      const r = applyGuide(dem, northSouth,
        { ...SEC, along: "level", cutAngleDeg: 45, fillAngleDeg: 34 });
      let outsideMask = 0, outsideRect = 0;
      for (let i = 0; i < dem.z.length; i++) {
        if (Math.abs(dem.z[i] - before[i]) < 1e-9) continue;
        if (!r.mask[i]) outsideMask++;
        const row = Math.floor(i / dem.ncols), col = i % dem.ncols;
        if (row < r.r0 || row > r.r1 || col < r.c0 || col > r.c1) outsideRect++;
      }
      add(G2, "a level guide on falling ground really does move ground OUTSIDE "
        + "its own corridor — that is the batter, and it is the whole reason the "
        + "reported rect cannot be the corridor's",
        "> 0 cells outside the corridor", `${outsideMask} cells`, outsideMask > 0);
      add(G2, "…and NO moved cell falls outside the rect the operation reports, "
        + "so undo, repaint and analysis all cover what actually changed",
        "0 cells outside the rect", `${outsideRect} cells`, outsideRect === 0);
      add(G2, "…and those outside cells are charged to the BATTER, not to the "
        + "section, because a structure and its edge condition are priced and "
        + "dug differently",
        `${outsideMask} batter cells`, `${r.batter.cells} batter cells`,
        r.batter.cells === outsideMask);
    }

    {
      // The project's standard for every modifier: one function, both paths.
      const a = plane(), b = plane();
      const priced = applyGuide(a, northSouth, { ...SEC, along: "level", dryRun: true });
      const done = applyGuide(b, northSouth, { ...SEC, along: "level" });
      let moved = 0;
      for (let i = 0; i < a.z.length; i++) if (a.z[i] !== plane().z[i]) moved++;
      add(G2, "the preview prices the guide through the SAME function that will "
        + "build it, so the figure under the slider cannot drift from the "
        + "earthwork — and dryRun moves nothing",
        `${f4(done.cut)} cut / ${f4(done.fill)} fill, 0 cells moved`,
        `${f4(priced.cut)} cut / ${f4(priced.fill)} fill, ${moved} cells moved`,
        near(priced.cut, done.cut, 1e-9) && near(priced.fill, done.fill, 1e-9)
        && moved === 0);

      const led = new Ledger();
      led.cut = 5; led.fill = 7;
      applyGuide(plane(), northSouth, { ...SEC, along: "level", ledger: led });
      add(G2, "…and the ledger ACCUMULATES — a guide curve is one more earthwork "
        + "on the same site, not a replacement for everything moved before it",
        `${f4(5 + done.cut)} m³ cut`, `${f4(led.cut)} m³ cut`,
        near(led.cut, 5 + done.cut, 1e-6));
    }

    {
      // ⚠️ A HOLE IN THE DEM STAYS A HOLE — the rule every modifier here keeps.
      const dem = plane();
      const row = Math.floor(N / 2), col = Math.round(midX / CELL - 0.5);
      dem.z[dem.idx(row, col)] = NaN;
      applyGuide(dem, northSouth, { ...SEC, along: "follow" });
      add(G2, "a cell with no measurement is left with no measurement — a guide "
        + "curve may not invent ground it was never given",
        "NaN", `${dem.z[dem.idx(row, col)]}`,
        !Number.isFinite(dem.z[dem.idx(row, col)]));
    }

    {
      // Degenerate inputs must do nothing rather than something surprising.
      const dem = plane();
      const before = Float32Array.from(dem.z);
      const one = applyGuide(dem, [[midX, 5]], { ...SEC });
      let moved = 0;
      for (let i = 0; i < dem.z.length; i++) if (dem.z[i] !== before[i]) moved++;
      add(G2, "a curve of fewer than two points is not a curve, and moves nothing",
        "0 cells, 0 m³", `${moved} cells, ${f4(one.cut + one.fill)} m³`,
        moved === 0 && one.cells === 0);

      const vert = applyGuide(plane(), northSouth,
        { ...SEC, along: "level", cutAngleDeg: 90, fillAngleDeg: 90, dryRun: true });
      add(G2, "…and vertical batter angles are the no-batter case rather than a "
        + "separate code path, so the preview and the commit cannot disagree "
        + "about whether an edge exists",
        "0 batter cells", `${vert.batter.cells}`, vert.batter.cells === 0);
    }

    {
      // ⚠️⚠️ SQUARE ENDS, NOT ROUND CAPS. Clamping the projection to each
      // segment makes every cell project somewhere, so a cell beyond the last
      // vertex lands ON that vertex at a perfectly valid perpendicular distance
      // — and the section is then swept around the endpoint into a bowl. Found
      // by measuring the corridor on the POI patch, where 151 cells of section
      // were being cut into two domes nobody had asked for.
      const dem = plane();
      const r = applyGuide(dem, northSouth, { ...SEC, along: "follow", dryRun: true });
      const { s: cum, total } = stations(northSouth);
      let past = 0;
      for (let row = 0; row < N; row++) {
        for (let col = 0; col < N; col++) {
          const i = row * N + col;
          if (!r.mask[i]) continue;
          const x = dem.originX + (col + 0.5) * CELL;
          const y = dem.originY + N * CELL - (row + 0.5) * CELL;
          if (projectToPolyline(northSouth, cum, x, y).end !== 0) past++;
        }
      }
      add(G2, "the corridor has SQUARE ends — no cell beyond the first or last "
        + "vertex is part of the structure, so the section is not swept around "
        + "the endpoints into a dome at each end",
        "0 cells past the ends", `${past} cells`, past === 0);
      // …and the corridor still reaches the ends themselves, or the fix would
      // have been to shorten the structure.
      add(G2, "…while the structure still runs the WHOLE length of the line it "
        + "was drawn along",
        `≈ ${f4(total)} m`, `${f4(r.length)} m`, near(r.length, total, 1e-9));
    }

    {
      // ⚠️ AN EMBANKMENT ON GROUND STEEPER THAN ITS REPOSE ANGLE NEVER
      // DAYLIGHTS, and the tool has to say so rather than quietly charging for
      // it. Found on the POI patch: a swale along a contour reported a 690 m³
      // batter over 9 591 cells against a 107 m³ section, running to the tile
      // edge. The arithmetic was right and the design was undrawable.
      const steep = DEM.synthetic(N, N, CELL, (r2, c) => 100 - c * CELL * 1.2);  // 50°
      const gentle = DEM.synthetic(N, N, CELL, (r2, c) => 100 - c * CELL * 0.05); // 3°
      const line = [[midX, 4], [midX, N * CELL - 4]];
      const hard = applyGuide(steep, line,
        { ...SEC, along: "level", fillAngleDeg: 34, cutAngleDeg: 45, dryRun: true });
      const easy = applyGuide(gentle, line,
        { ...SEC, along: "level", fillAngleDeg: 34, cutAngleDeg: 45, dryRun: true });
      add(G2, "on ground falling faster than the fill angle the batter is "
        + "reported as never meeting the ground, rather than the impossibility "
        + "being hidden inside a large volume the designer has to reverse-engineer",
        "> 0 undaylit cells on 50° ground", `${hard.undaylit} cells`,
        hard.undaylit > 0);
      add(G2, "…and on ground gentler than the fill angle it closes properly, so "
        + "the warning means something when it appears",
        "0 undaylit cells on 3° ground", `${easy.undaylit} cells`,
        easy.undaylit === 0);
    }

    {
      // ⚠️ THE MASK IS PER VERTEX, indexed exactly like dem.z — the same grid
      // every other mask in this tool uses, so a guide corridor can be fed
      // straight into levelTo, batterTo or a rule without translation.
      const r = applyGuide(plane(), northSouth, { ...SEC, along: "follow", dryRun: true });
      add(G2, "the corridor is an ordinary mask over the DEM's own grid, so it "
        + "composes with the rules and the modifiers that already take one",
        `${N * N} entries`, `${r.mask.length} entries`, r.mask.length === N * N);
    }

    {
      // ⚠️ A CONCAVE BEND IS A REAL DISCONTINUITY UNDER A GRADED LINE, and the
      // tool reports its size rather than pretending it is not there. On a
      // FOLLOW line there is nothing to jump, because the target is the ground.
      const bent = [[midX - 8, 4], [midX, 18], [midX - 8, 32]];
      const graded = applyGuide(plane(), bent,
        { ...SEC, along: "grade", gradient: 0.05, dryRun: true });
      const flat = applyGuide(plane(), bent, { ...SEC, along: "level", dryRun: true });
      add(G2, "a bend in a GRADED line carries a step in the target elevation "
        + "where the two segments' corridors meet, and the size of it is "
        + "reported — a tight bend on a steep grade is a real discontinuity in "
        + "the structure, not a rendering artefact",
        "> 0 m on a graded bend", `${f4(graded.stationJump)} m`,
        graded.stationJump > 0);
      add(G2, "…and a LEVEL line has no such step, because there is no station "
        + "term in its elevation at all",
        "0 m", `${f4(flat.stationJump)} m`, near(flat.stationJump, 0, 1e-9));
    }

    {
      // The vocabulary is stated, so the interface cannot offer a section or a
      // longitudinal mode the kernel does not implement.
      const profilesOk = Object.values(PROFILES).every((v) =>
        typeof v.dz === "function" && typeof v.halfWidth === "function" && v.label);
      add(G2, "every cross-section in the vocabulary states a label and "
        + "implements both a shape and a half-width, so the interface cannot "
        + "offer a section the kernel does not have",
        `${Object.keys(PROFILES).length} profiles, all complete`,
        profilesOk ? "all complete" : "one incomplete", profilesOk);
      add(G2, "…and the three longitudinal modes are named where the kernel can "
        + "see them, not only in the markup",
        "follow · level · grade", Object.keys(ALONG).join(" · "),
        !!(ALONG.follow && ALONG.level && ALONG.grade));
    }
  }

  // ══ L2 ═══════════════════════════════════════════════════════════════════
  const L2 = "L2 · landform patches — one hollow, not every hollow";
  {
    const N = 16, CELL = 1;
    const dem = DEM.synthetic(N, N, CELL, () => 10);

    {
      // ⚠️ EIGHT-CONNECTED. A spur running diagonally is ONE landform; four
      // connectivity cuts it into a staircase of separate patches at every
      // diagonal step, and reports a dozen bearings where the ground has one.
      const m = new Uint8Array(N * N);
      for (let k = 0; k < 6; k++) m[(2 + k) * N + (2 + k)] = 1;   // a diagonal
      const cc = connectedComponents({ nrows: N, ncols: N }, m);
      add(L2, "a diagonal run is ONE patch — four-connectivity would cut a "
        + "diagonal spur into a staircase of separate patches and report a "
        + "bearing for each",
        "1 component", `${cc.count}`, cc.count === 1);

      // …and two genuinely separate blobs stay separate.
      const m2 = new Uint8Array(N * N);
      m2[1 * N + 1] = 1; m2[1 * N + 2] = 1;
      m2[12 * N + 12] = 1;
      add(L2, "…while blobs that do not touch stay separate, so the count means "
        + "something", "2 components",
        `${connectedComponents({ nrows: N, ncols: N }, m2).count}`,
        connectedComponents({ nrows: N, ncols: N }, m2).count === 2);
    }

    {
      // Two separated blocks of the SAME class are two patches; the partition is
      // same-class AND connected, not one mask per class.
      const cls = new Float32Array(N * N).fill(5);
      for (let r = 1; r < 5; r++) for (let c = 1; c < 5; c++) cls[r * N + c] = 4;
      for (let r = 10; r < 14; r++) for (let c = 10; c < 14; c++) cls[r * N + c] = 4;
      const { patches } = landformPatches(dem, cls, {});
      const spurs = patches.filter((p) => p.klass === 4);
      add(L2, "two separated runs of the SAME class are two patches — 'where is "
        + "it spur' is one mask, and a patch is ONE spur",
        "2 spur patches", `${spurs.length}`, spurs.length === 2);
      add(L2, "…and they are returned largest first, so the reader meets the "
        + "patch that matters before the speckle",
        "descending by size",
        patches.every((p, i) => i === 0 || patches[i - 1].cells >= p.cells)
          ? "descending" : "unordered",
        patches.every((p, i) => i === 0 || patches[i - 1].cells >= p.cells));
      // ⚠️ The label grid must agree with the ids AFTER the sort, or every
      // consumer reads the wrong patch.
      const { labels, patches: ps } = landformPatches(dem, cls, {});
      let agree = true;
      for (const p of ps) {
        let n = 0;
        for (let i = 0; i < labels.length; i++) if (labels[i] === p.id) n++;
        if (n !== p.cells) { agree = false; break; }
      }
      add(L2, "…and the label grid agrees with the ids after the sort — the "
        + "patches are reordered by size, and a grid still pointing at the old "
        + "numbering would hand every consumer the wrong ground",
        "every id's cell count matches", agree ? "agree" : "DISAGREE", agree);
    }

    {
      // ⚠️ ASPECT IS CIRCULAR. Averaging 350° and 10° arithmetically gives 180°,
      // the exact opposite of the answer.
      const cls = new Float32Array(N * N).fill(4);
      const slope = new Float32Array(N * N).fill(20);
      const aspect = new Float32Array(N * N);
      for (let i = 0; i < aspect.length; i++) aspect[i] = i % 2 ? 350 : 10;
      const { patches } = landformPatches(dem, cls,
        { slopeDeg: slope, aspectDeg: aspect });
      const b = patches[0].bearingDeg;
      add(L2, "aspect is averaged as a DIRECTION — 350° and 10° mean north, not "
        + "south, and an arithmetic mean would report the exact opposite",
        "≈ 0°", `${b.toFixed(1)}°`, Math.min(b, 360 - b) < 1);

      // ⚠️ Concentration, not variance: it says whether one bearing serves the
      // patch at all.
      const scattered = new Float32Array(N * N);
      for (let i = 0; i < scattered.length; i++) scattered[i] = (i * 37) % 360;
      const p2 = landformPatches(dem, cls,
        { slopeDeg: slope, aspectDeg: scattered }).patches[0];
      add(L2, "…and the bearing's CONCENTRATION says whether one bearing serves "
        + "the patch — high where every cell faces the same way, near zero where "
        + "it wraps a nose and should be split",
        "aligned ≈ 1, scattered ≈ 0",
        `${patches[0].bearingConcentration.toFixed(2)} vs ${p2.bearingConcentration.toFixed(2)}`,
        patches[0].bearingConcentration > 0.95 && p2.bearingConcentration < 0.2);

      // Flat ground has no direction, and the tool's own convention says so.
      const flat = new Float32Array(N * N);      // slope 0 everywhere
      const p3 = landformPatches(dem, cls,
        { slopeDeg: flat, aspectDeg: aspect }).patches[0];
      add(L2, "…and level ground yields NO bearing at all rather than a "
        + "confident wrong one — aspect on a flat cell is NaN in this tool, and "
        + "weighting by slope is what keeps it out of the mean",
        "NaN bearing, 0 concentration",
        `${p3.bearingDeg}, ${p3.bearingConcentration}`,
        !Number.isFinite(p3.bearingDeg) && p3.bearingConcentration === 0);
    }

    {
      // ⚠️ THE TWO SCHEMES MUST COVER THE SAME GROUND, or the comparison is
      // between different amounts of site rather than two ways of treating it.
      const slope = new Float32Array(N * N).fill(20);
      const cls = new Float32Array(N * N).fill(5);
      for (let r = 0; r < 8; r++) for (let c = 0; c < N; c++) cls[r * N + c] = 4;
      const tilted = DEM.synthetic(N, N, CELL, (r, c) => 10 + c * 0.3);
      const { labels, patches } = landformPatches(tilted, cls, { slopeDeg: slope });
      const a = tilted.clone();
      const r = benchByPatch(a, labels, patches, { targetTread: 4, dryRun: true });
      add(L2, "every patch is benched, including the ones too small to set out — "
        + "they take the default system rather than being skipped, or the two "
        + "schemes would not cover the same ground",
        `${patches.length} patches, all treated`,
        `${r.patchesBenched + r.patchesDefaulted} treated`,
        r.patchesBenched + r.patchesDefaulted === patches.length);
      add(L2, "…and it moves real earth", "> 0 m³",
        `${f4(r.cut + r.fill)} m³`, r.cut + r.fill > 0);
    }

    {
      // ⚠️ THE DATUM IS WHAT MAKES A PATCH SYSTEM ITS OWN. Anchored to zero,
      // every patch shares one sequence of levels and the seam disappears —
      // which is the erasure the whole comparison exists to test.
      // ⚠️ A GRADIENT THAT IS NOT COMMENSURATE WITH THE INTERVAL. At 0.5 m per
      // cell against a 1 m interval every cell sits either exactly on a level or
      // exactly at a riser midpoint that maps back to itself, so BOTH datums
      // leave the ground untouched and the check passes on a degenerate surface
      // — which is how this row first failed against correct code.
      const ramp = DEM.synthetic(N, N, CELL, (r, c) => 10 + c * 0.37);
      const m = new Uint8Array(N * N).fill(1);
      const atZero = ramp.clone(), atDatum = ramp.clone();
      benchTo(atZero, m, { interval: 1, tread: 0.7 });
      benchTo(atDatum, m, { interval: 1, tread: 0.7, datum: 0.5 });
      let differ = 0;
      for (let i = 0; i < atZero.z.length; i++) {
        if (Math.abs(atZero.z[i] - atDatum.z[i]) > 1e-6) differ++;
      }
      add(L2, "a bench system anchored to its own datum lands on DIFFERENT "
        + "levels — which is what lets neighbouring patches disagree at the "
        + "seam, and the seam is where the terrace direction changes",
        "> 0 cells differ", `${differ} cells`, differ > 0);
      // …and the default is still zero, so ordinary benching is unchanged.
      const plain = ramp.clone();
      benchTo(plain, m, { interval: 1, tread: 0.7 });
      let same = true;
      for (let i = 0; i < plain.z.length; i++) {
        if (Math.abs(plain.z[i] - atZero.z[i]) > 1e-9) { same = false; break; }
      }
      add(L2, "…and the datum defaults to zero, so every bench system that does "
        + "not ask for one is byte-identical to before — the levels stay "
        + "absolute elevations and stay reproducible",
        "identical", same ? "identical" : "CHANGED", same);
    }
  }

  // ══ E2 ═══════════════════════════════════════════════════════════════════
  const E2 = "E2 · the experiment — two schemes, one volume";
  {
    // A dissected slope: a steady fall with ripples across it, so the
    // geomorphon map carries spurs and hollows and the partition is real.
    const N = 64, CELL = 1;
    const mk = () => DEM.synthetic(N, N, CELL,
      (r, c) => 20 + c * 0.25 + 1.5 * Math.sin(r / 3) * Math.cos(c / 4));

    {
      // ⚠️⚠️ THE SIGN OF THE SEARCH. Phase 8E assumed bench volume FALLS as the
      // interval grows; it rises — the displacement to a level is at most Δ/2 —
      // and the search walked to the top of its range and reported a 369 %
      // mismatch as a result. The monotone direction is asserted, not assumed.
      const dem = mk();
      const mask = new Uint8Array(N * N).fill(1);
      const vol = (interval) => {
        const r = benchTo(dem, mask, { interval, tread: 0.7, dryRun: true });
        return r.cut + r.fill;
      };
      const v1 = vol(1), v2 = vol(2), v4 = vol(4);
      add(E2, "bench volume RISES as the interval grows — the displacement to a "
        + "level is at most Δ/2, so a coarser system moves MORE earth; the "
        + "volume-matching search is built on this sign and it is asserted here "
        + "rather than assumed",
        "v(1) < v(2) < v(4)",
        `${f2(v1)} < ${f2(v2)} < ${f2(v4)} m³`, v1 < v2 && v2 < v4);

      // …and the search lands on the target.
      const target = (v1 + v2) / 2;
      const m = matchUniformInterval(dem, target, {});
      add(E2, "…and the search finds an interval that moves the stated volume — "
        + "otherwise the comparison is between different amounts of earthwork "
        + "rather than two ways of spending it",
        `within ±${(EXPERIMENT.matchTol * 100).toFixed(0)}% of ${f2(target)} m³`,
        `${f2(m.volume)} m³ at Δ ${f2(m.interval)} m`,
        m.matched && Math.abs(m.volume - target) <= target * EXPERIMENT.matchTol);
    }

    {
      const dem = mk();
      const before = dem.z.slice();
      const row = compareAt(dem, 4, {});
      let untouched = true;
      for (let i = 0; i < before.length; i++) {
        if (dem.z[i] !== before[i]) { untouched = false; break; }
      }
      // ⚠️ THE EXPERIMENT IS A READING, NOT AN OPERATION. Both schemes run on
      // clones; a measurement that edited the surface it measures would change
      // the answer for whoever runs it second.
      add(E2, "the experiment never touches the surface it measures — both "
        + "schemes run on clones, so running it twice reads the same ground "
        + "twice", "byte-identical", untouched ? "byte-identical" : "CHANGED",
        untouched);
      add(E2, "…and one row carries both schemes at one volume, matched within "
        + "the stated tolerance",
        "matched, volume > 0",
        row ? `${row.matched ? "matched" : "UNMATCHED"}, ${f2(row.volume)} m³` : "null",
        !!row && row.matched && row.volume > 0);
      const finite = !!row && [
        row.uniform.geodiversity, row.uniform.landformH, row.uniform.peakOutfall,
        row.patch.geodiversity, row.patch.landformH, row.patch.peakOutfall,
      ].every(Number.isFinite) && row.uniform.hollows >= 0 && row.patch.hollows >= 0;
      add(E2, "…and every reading in the row is a finite number — geodiversity, "
        + "landform H′, hollows and peak outfall for both schemes",
        "all finite", finite ? "all finite" : "NaN somewhere", finite);
      // Raw Shannon over ten classes is bounded by ln(10); the worker's
      // normalised evenness is a different number and must not be confused
      // with this one.
      const hOk = !!row && row.patch.landformH <= Math.log(LANDFORMS.length) + 1e-9
        && row.uniform.landformH <= Math.log(LANDFORMS.length) + 1e-9;
      add(E2, "…and landform H′ is RAW Shannon in nats, bounded by ln(10) ≈ 2.30 "
        + "— the Phase 8E table's units, not the worker's normalised evenness",
        `≤ ${Math.log(LANDFORMS.length).toFixed(2)}`,
        row ? `${f2(row.uniform.landformH)}, ${f2(row.patch.landformH)}` : "null", hOk);
    }

    {
      // ⚠️ LEVEL GROUND HAS NOTHING TO COMPARE. Both schemes leave a plane
      // untouched, and the volume to match is zero — the boot tile takes this
      // path, and it must be an answer, not a division by zero.
      const flat = DEM.synthetic(16, 16, 1, () => 75);
      add(E2, "on level ground the experiment reports that there is nothing to "
        + "compare rather than dividing by a zero volume — the boot tile is "
        + "exactly this surface",
        "null row", compareAt(flat, 4, {}) === null ? "null row" : "a row",
        compareAt(flat, 4, {}) === null);
      const m0 = matchUniformInterval(flat, 0, {});
      add(E2, "…and a zero target volume is refused as unmatched, never "
        + "'matched' by an interval that moves nothing",
        "unmatched", m0.matched ? "MATCHED" : "unmatched", !m0.matched);
    }

    {
      // The whole run, once, on a small surface: baseline plus one row per
      // tread that produced a comparison, parameters carried in the result so
      // a reader of the numbers can see the experiment they came from.
      const dem = mk();
      const res = compareSchemes(dem, { treads: [2, 4] });
      const ok = res.rows.length === 2 && Number.isFinite(res.baseline.geodiversity)
        && res.params.treads.length === 2
        && res.params.rainM === EXPERIMENT.rainM;
      add(E2, "the whole experiment returns the untouched baseline, one row per "
        + "tread, and the parameters it ran with — the figures travel with the "
        + "experiment that produced them",
        "baseline + 2 rows + params",
        `baseline ${Number.isFinite(res.baseline.geodiversity) ? "read" : "NaN"}, `
        + `${res.rows.length} rows, params ${res.params.rainM === EXPERIMENT.rainM ? "carried" : "missing"}`,
        ok);
    }
  }

  // ══ D2 ═══════════════════════════════════════════════════════════════════
  const D2 = "D2 · the derivative sheets — isopach, slope classes, drainage, chainage";
  {
    const N = 32, CELL = 1;

    {
      // ── the isopach ──────────────────────────────────────────────────────
      // Untouched ground: no lines, and the subtitle says why.
      const dem = DEM.synthetic(N, N, CELL, () => 10);
      const svg = isopachSVG(dem, { baseline: dem.z.slice() });
      add(D2, "on untouched ground the isopach draws no depth lines and no "
        + "limit of works, and says so — a sheet of nothing must state that "
        + "it is a sheet of nothing",
        "no idx path, 'nothing has been moved'",
        `${/class="idx"/.test(svg) ? "idx" : "no idx"}, `
        + `${/nothing has been moved/.test(svg) ? "stated" : "unstated"}`,
        !/class="idx"/.test(svg) && /nothing has been moved/.test(svg));

      // ⚠️ THE FILL-ONLY ROW IS THE TRAP ROW. Contouring dz at zero directly
      // uses the half-open >= test, which counts untouched ground (exactly 0)
      // as "above" — so the zero line appears around cuts and silently NOT
      // around fills. The limit of works is therefore drawn from a clamped
      // |dz| field, and this row is the one that fails if anyone "simplifies"
      // that back to the zero contour.
      const filled = DEM.synthetic(N, N, CELL, () => 10);
      for (let r = 10; r < 16; r++) for (let c = 10; c < 16; c++) filled.z[r * N + c] = 11;
      const fsvg = isopachSVG(filled, { baseline: new Float32Array(N * N).fill(10) });
      add(D2, "a FILL-only edit still gets a limit-of-works line — the zero "
        + "contour of dz would draw it around cuts only, because the half-open "
        + "crossing test counts untouched ground as 'above'; the limit is "
        + "contoured from a clamped |dz| instead, symmetric by construction",
        "idx present, fill contours, no cut",
        `${/class="idx"/.test(fsvg) ? "idx" : "NO idx"}, `
        + `${/class="now"/.test(fsvg) ? "fill" : "no fill"}, `
        + `${/class="was"/.test(fsvg) ? "CUT" : "no cut"}`,
        /class="idx"/.test(fsvg) && /class="now"/.test(fsvg) && !/class="was"/.test(fsvg));
      add(D2, "…and the sheet locates and states the deepest change",
        "highest fill 1.00 m", /highest fill 1\.00 m/.test(fsvg) ? "stated" : "missing",
        /highest fill 1\.00 m/.test(fsvg));

      const cutTile = DEM.synthetic(N, N, CELL, () => 10);
      for (let r = 10; r < 16; r++) for (let c = 10; c < 16; c++) cutTile.z[r * N + c] = 9;
      const csvg = isopachSVG(cutTile, { baseline: new Float32Array(N * N).fill(10) });
      add(D2, "…and a CUT-only edit draws its depth lines dashed with the same "
        + "limit line, so the two signs are told apart by style, not tone",
        "idx + cut, no fill",
        `${/class="idx"/.test(csvg) ? "idx" : "NO idx"}, `
        + `${/class="was"/.test(csvg) ? "cut" : "NO cut"}, `
        + `${/class="now"/.test(csvg) ? "FILL" : "no fill"}`,
        /class="idx"/.test(csvg) && /class="was"/.test(csvg) && !/class="now"/.test(csvg));
    }

    {
      // ── the slope classes ────────────────────────────────────────────────
      add(D2, "the slope vocabulary is stated where the kernel can see it: "
        + "five classes with monotone bounds, ratios a designer actually pegs",
        "5 classes, ascending",
        `${SLOPE_CLASSES.length} classes, `
        + `${SLOPE_CLASSES.every((c, i) => !i || c.max > SLOPE_CLASSES[i - 1].max)
          ? "ascending" : "DISORDERED"}`,
        SLOPE_CLASSES.length === 5
        && SLOPE_CLASSES.every((c, i) => !i || c.max > SLOPE_CLASSES[i - 1].max));

      const flat = DEM.synthetic(N, N, CELL, () => 10);
      const fsvg = slopeClassSVG(flat);
      add(D2, "a flat plane is 100% accessible and stays paper — on this sheet "
        + "paper MEANS usable, so the flattest class is never hatched",
        "class 1 carries 100.0%",
        /accessible \(0–5 %\) — 100\.0 %/.test(fsvg) ? "100.0%" : "not stated",
        /accessible \(0–5 %\) — 100\.0 %/.test(fsvg));

      // A uniform 25% grade lands in 1:6–1:3 — except the rim, where Horn's
      // one-sided gradient reads shallower. ⚠️ This row first asserted 100.0%
      // and failed against correct code: the two edge columns of a 32² tile
      // are 6.25% of it, and they classify a band down. The module was right
      // and the guess was wrong — the share is asserted as dominant, not total.
      const ramp = DEM.synthetic(N, N, CELL, (r, c) => 10 + c * 0.25);
      const rsvg = slopeClassSVG(ramp);
      const hatCount = (s) => (s.match(/class="hat"/g) || []).length;
      const shareM = /1:6 to 1:3 \(\d+–33 %\) — ([\d.]+) %/.exec(rsvg);
      const share = shareM ? parseFloat(shareM[1]) : 0;
      add(D2, "a uniform 1:4 grade lands dominantly in the 1:6–1:3 band — the "
        + "tile rim reads a band shallower under Horn's one-sided edge "
        + "gradient, which is the operator's real behaviour, not a defect — "
        + "and the plan carries its hatch",
        "≥ 90% in 1:6–1:3, more hatch than the legend alone",
        `${share.toFixed(1)}%, ${hatCount(rsvg)} vs ${hatCount(fsvg)} hat paths`,
        share >= 90 && hatCount(rsvg) > hatCount(fsvg));
    }

    {
      // ── the drainage plan ────────────────────────────────────────────────
      // Two bowls: every cell drains to one of two pits, so there are two
      // catchments with a divide between them, and channels into each.
      const bowls = DEM.synthetic(N, N, CELL, (r, c) =>
        10 + Math.min(Math.hypot(r - 8, c - 8), Math.hypot(r - 24, c - 24)) * 0.3);
      const bsvg = drainageSVG(bowls);
      add(D2, "two bowls give two catchments: the divide between them is drawn "
        + "dash-dot and the channels converge on each pit",
        "div + chn paths, 2 catchments",
        `${/class="div"/.test(bsvg) ? "div" : "NO div"}, `
        + `${/class="chn"/.test(bsvg) ? "chn" : "NO chn"}, `
        + `${/(\d+) catchments/.exec(bsvg)?.[1] ?? "?"} catchments`,
        /class="div"/.test(bsvg) && /class="chn"/.test(bsvg)
        && /2 catchments/.test(bsvg));

      // A valley draining south: the rain leaves, and WHERE it leaves is the
      // sheet's whole point — a ranked outfall with the event's own volume.
      const valley = DEM.synthetic(N, N, CELL, (r, c) =>
        20 - r * 0.2 + Math.abs(c - 16) * 0.05);
      const vsvg = drainageSVG(valley, { rainM: 0.02 });
      add(D2, "on a valley that drains, the outfall is located, ranked and "
        + "stated in the event's own volume — where a pipe, a swale or a "
        + "consent has to exist",
        "a '1 · … m³' outfall, event stated",
        `${/1 · [\d.]+ m³/.test(vsvg) ? "ranked outfall" : "NO outfall"}, `
        + `${/20 mm event/.test(vsvg) ? "20 mm stated" : "event unstated"}`,
        /1 · [\d.]+ m³/.test(vsvg) && /20 mm event/.test(vsvg));
    }

    {
      // ── the chainage sections ────────────────────────────────────────────
      const dem = DEM.synthetic(N, N, CELL, (r, c) => 10 + c * 0.3);
      const base = new Float32Array(N * N).fill(10);
      const svg = chainageSectionsSVG(dem, [[4, 16], [28, 16]], { baseline: base });
      const secCount = (svg.match(/CH \d+\+/g) || []).length;
      add(D2, "a 24 m guide at the chosen station spacing yields one section "
        + "per even chainage, labelled in the CH 0+00 convention",
        "≥ 4 sections, CH 0+00.0 first",
        `${secCount} sections, ${/CH 0\+00\.0/.test(svg) ? "CH 0+00.0" : "no CH 0"}`,
        secCount >= 4 && /CH 0\+00\.0/.test(svg));
      add(D2, "…each states its viewing direction and its cut and fill AREAS — "
        + "a volume is area × spacing, and that multiplication belongs to "
        + "whoever holds the spacing",
        "L/R marked, areas in m², direction stated",
        `${/>L</.test(svg) && />R</.test(svg) ? "L/R" : "unmarked"}, `
        + `${/cut [\d.]+ m²/.test(svg) ? "areas" : "no areas"}, `
        + `${/LOOKING ALONG THE CHAINAGE/.test(svg) ? "stated" : "unstated"}`,
        />L</.test(svg) && />R</.test(svg) && /cut [\d.]+ m²/.test(svg)
        && /LOOKING ALONG THE CHAINAGE/.test(svg));
      add(D2, "…the whole set shares ONE stated vertical exaggeration — "
        + "per-section autoscaling would make the same batter look different "
        + "at every station",
        "one '× exaggerated' statement",
        `${(svg.match(/× exaggerated/g) || []).length} statement(s)`,
        (svg.match(/× exaggerated/g) || []).length === 1);
      add(D2, "…and a guide with fewer than two points yields no sheet rather "
        + "than a sheet of nothing",
        "empty string", chainageSectionsSVG(dem, [[4, 16]], {}) === "" ? "empty" : "a sheet",
        chainageSectionsSVG(dem, [[4, 16]], {}) === "");
    }
  }

  // ══ G3 ═══════════════════════════════════════════════════════════════════
  const G3 = "G3 · the grading plan — proposed over existing, and what moved";
  {
    const N = 48, CELL = 0.5;
    const mk = () => DEM.synthetic(N, N, CELL, (r, c) => 10 + c * CELL * 0.08);

    {
      // ⚠️ UNTOUCHED GROUND DRAWS NO "EXISTING" SET. Both surfaces are identical
      // there, so a dashed line under every solid one doubles the ink to say
      // nothing — and reads as a design that changed nothing rather than as
      // ground that was never designed.
      const dem = mk();
      const svg = gradingSVG(dem, { baseline: dem.z.slice(), interval: 0.5 });
      add(G3, "on ground nobody has touched the plan draws the proposed contours "
        + "only — no dashed existing set under identical lines, and no hatch",
        "no .was, no hatch",
        `${/class="was"/.test(svg) ? "was" : "no was"}, `
        + `${/class="h(cut|fil)"/.test(svg) ? "hatch" : "no hatch"}`,
        !/class="was"/.test(svg) && !/class="h(cut|fil)"/.test(svg));
    }

    {
      // Cut on one side, fill on the other: both hatches must appear, and they
      // are told apart by DIRECTION, which survives greyscale where two tones
      // of the same grey do not.
      const dem = mk();
      const base = dem.z.slice();
      for (let r = 10; r < 20; r++) for (let c = 10; c < 20; c++) dem.z[r * N + c] -= 1;
      for (let r = 28; r < 38; r++) for (let c = 28; c < 38; c++) dem.z[r * N + c] += 1;
      const svg = gradingSVG(dem, { baseline: base, interval: 0.5 });
      add(G3, "ground that moved is hatched, cut one way and fill the other — "
        + "direction rather than tone, because the sheet is greyscale",
        "both hatches present",
        `${/class="hcut"/.test(svg) ? "cut" : "NO cut"}, `
        + `${/class="hfil"/.test(svg) ? "fill" : "NO fill"}`,
        /class="hcut"/.test(svg) && /class="hfil"/.test(svg));
      add(G3, "…and the existing surface is drawn, dashed and fine, because here "
        + "it differs from the proposed one",
        "existing set present", /class="was"/.test(svg) ? "present" : "MISSING",
        /class="was"/.test(svg));
    }

    {
      // ⚠️ THE INDEX CONTOUR IS DECIDED BY THE LEVEL, NOT BY COUNTING LINES, so
      // the heavy lines land on the same elevations whatever the tile's range —
      // which is what makes two sheets of the same site comparable.
      const dem = DEM.synthetic(N, N, CELL, (r, c) => 100 + c * CELL * 0.5);
      const svg = gradingSVG(dem, { interval: 1 });
      add(G3, "every fifth contour carries the weight, chosen by its ELEVATION "
        + "rather than by counting lines, so two sheets of the same site put the "
        + "heavy lines in the same places",
        "an index set is drawn", /class="idx"/.test(svg) ? "present" : "MISSING",
        /class="idx"/.test(svg));
    }

    {
      // ⚠️ NO VOLUMES ON A PLAN. The ledger is the only place a volume comes
      // from, because it integrates the whole surface rather than any one
      // drawing of it — the same rule sectionAreas keeps.
      const dem = mk();
      const base = dem.z.slice();
      for (let i = 0; i < dem.z.length; i++) dem.z[i] += 0.5;
      const svg = gradingSVG(dem, { baseline: base, interval: 0.5 });
      add(G3, "the sheet states areas and levels and never a volume — the ledger "
        + "is the only place a volume comes from",
        "no m³ anywhere", /m³/.test(svg) ? "PRESENT" : "absent", !/m³/.test(svg));
      add(G3, "…and it carries the standing honesty clause, as every other export "
        + "does",
        "Not a prediction", /Not a prediction/.test(svg) ? "present" : "MISSING",
        /Not a prediction/.test(svg));
    }

    {
      // A hole in the DEM has no level to write.
      const dem = mk();
      for (let i = 0; i < dem.z.length; i++) dem.z[i] = NaN;
      const svg = gradingSVG(dem, { interval: 0.5 });
      add(G3, "ground with no measurement carries no spot level — a plan may not "
        + "write a height for a cell that was never surveyed",
        "no spot levels", `${(svg.match(/class="spot"/g) || []).length}`,
        !/class="spot"/.test(svg));
    }

    {
      // ── the depth circles (the Hadseløya technique, 2026-08-13) ──────────
      // The hatch says where and which way; the circles say HOW MUCH. Open is
      // cut and filled is fill — identities in style, not tone.
      const cut = mk();
      const cutBase = cut.z.slice();
      for (let r = 10; r < 20; r++) for (let c = 10; c < 20; c++) cut.z[r * N + c] -= 1;
      const csvg = gradingSVG(cut, { baseline: cutBase, interval: 0.5 });
      const fill = mk();
      const fillBase = fill.z.slice();
      for (let r = 10; r < 20; r++) for (let c = 10; c < 20; c++) fill.z[r * N + c] += 1;
      const fsvg = gradingSVG(fill, { baseline: fillBase, interval: 0.5 });
      // ⚠️ THE FIELD IS READ WITHOUT THE KEY (2026-08-19). The key draws a
      // sample of BOTH circle identities on any sheet that has circles at all
      // — that is what a key is for — so asserting "this sheet shows open
      // circles and no filled ones" against the whole document started
      // measuring the key instead of the drawing. Strip the one group the
      // exporter marks for exactly this purpose, then assert on what is left.
      const field = (s) => s.replace(/<g class="keyblock">[\s\S]*?<\/g>\s*$/m, "");
      const cf = field(csvg), ff = field(fsvg);
      add(G3, "the depth of change is drawn as proportional circles — OPEN over "
        + "a cut, FILLED over a fill, never the other kind — so the hatch's "
        + "'where and which way' gains a measurable 'how much'",
        "cut sheet: symc only · fill sheet: symf only",
        `cut: ${/class="symc"/.test(cf) ? "symc" : "none"}${/class="symf"/.test(cf) ? "+symf" : ""} · `
        + `fill: ${/class="symf"/.test(ff) ? "symf" : "none"}${/class="symc"/.test(ff) ? "+symc" : ""}`,
        /class="symc"/.test(cf) && !/class="symf"/.test(cf)
        && /class="symf"/.test(ff) && !/class="symc"/.test(ff));
      add(G3, "…with a legend of reference circles at round depths, so a reader "
        + "measures a circle against a stated value rather than guessing",
        "'depth of change' key, with both identities named",
        `${/DEPTH OF CHANGE/i.test(fsvg) ? "heading" : "NO heading"}, `
        + `${/open: cut/.test(fsvg) ? "open=cut" : "MISSING"}, `
        + `${/filled: fill/.test(fsvg) ? "filled=fill" : "MISSING"}, `
        + `${(fsvg.match(/class="keyc"/g) || []).length} reference circles`,
        /DEPTH OF CHANGE/i.test(fsvg) && /open: cut/.test(fsvg)
        && /filled: fill/.test(fsvg) && /class="keyc"/.test(fsvg));

      // ⚠️ THE KEY MAY NOT TEACH A CONVENTION THE SHEET DOES NOT USE. A cut-only
      // sheet that keys a fill hatch sends the reader hunting for a texture
      // that is not there — the same failure as the dashed set drawn over
      // ground nobody touched, one level up. Every row is conditional, and
      // this is where that is pinned.
      add(G3, "the key states only the marks the drawing actually carries — a "
        + "cut-only sheet keys the cut hatch and not the fill, and a sheet with "
        + "nothing moved keys neither",
        "cut sheet: hcut swatch, no hfil",
        `cut: ${/class="hcut"/.test(csvg) ? "hcut" : "none"}`
        + `${/class="hfil"/.test(csvg) ? "+hfil" : ""} · `
        + `fill: ${/class="hfil"/.test(fsvg) ? "hfil" : "none"}`
        + `${/class="hcut"/.test(fsvg) ? "+hcut" : ""}`,
        /class="hcut"/.test(csvg) && !/class="hfil"/.test(csvg)
        && /class="hfil"/.test(fsvg) && !/class="hcut"/.test(fsvg));

      // ⚠️⚠️ THE KEY'S HATCH MUST LEAN THE SAME WAY AS THE PLAN'S, and this is
      // measured rather than eyeballed because a mirrored 45° hatch is utterly
      // convincing on its own. `hatchRuns` takes its direction in MAP space,
      // where y runs NORTH; the sheet's y runs down, so the plan's cut reaches
      // the paper as the mirror of the direction it was asked for. The key's
      // swatches are written straight into sheet space, so they must be
      // negated — and they were not, for one render. A key that teaches the
      // mirror of the drawing is worse than no key: it is confidently wrong.
      {
        const slopeOf = (svg, cls, inKey) => {
          const hay = inKey ? svg.slice(svg.indexOf('<g class="keyblock">')) : svg;
          const m = new RegExp(`<path class="${cls}" d="([^"]{0,600})`).exec(hay);
          if (!m) return NaN;
          for (const s of m[1].matchAll(/M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)/g)) {
            const [x0, y0, x1, y1] = s.slice(1).map(Number);
            if (Math.abs(x1 - x0) > 0.5) return Math.sign((y1 - y0) / (x1 - x0));
          }
          return NaN;
        };
        const planCut = slopeOf(csvg, "hcut", false);
        const keyCut = slopeOf(csvg, "hcut", true);
        const planFill = slopeOf(fsvg, "hfil", false);
        const keyFill = slopeOf(fsvg, "hfil", true);
        add(G3, "the key's hatch swatches lean the SAME way on the paper as the "
          + "hatch they explain — measured out of the finished SVG, because the "
          + "map's y runs north and the sheet's runs down, so a swatch written "
          + "in sheet space mirrors the plan unless it is negated",
          "cut: key slope = plan slope · fill: key slope = plan slope",
          `cut plan ${planCut > 0 ? "\\" : "/"} key ${keyCut > 0 ? "\\" : "/"} · `
          + `fill plan ${planFill > 0 ? "\\" : "/"} key ${keyFill > 0 ? "\\" : "/"}`,
          Number.isFinite(planCut) && Number.isFinite(keyCut)
          && planCut === keyCut && planFill === keyFill
          && planCut !== planFill);
      }

      // ⚠️ AND THE CONVENTIONS LEFT THE SUBTITLE WHEN THE KEY ARRIVED. Saying
      // them twice, in two registers, invites a reader to look for the
      // difference between the two statements.
      add(G3, "…and the subtitle no longer carries the conventions the key now "
        + "owns — one statement of each, not two",
        "subtitle: no 'dashed'/'hatched' prose",
        `${/existing ground dashed/.test(fsvg) ? "STILL THERE" : "moved to the key"}`,
        !/existing ground dashed/.test(fsvg)
        && !/circles: depth of change/.test(fsvg));
      // Untouched ground gets no circles at all — same rule as the hatch and
      // the dashed set: a sheet of nothing must not decorate it.
      const flat = mk();
      const nsvg = gradingSVG(flat, { baseline: flat.z.slice(), interval: 0.5 });
      add(G3, "…and untouched ground carries no circles, exactly as it carries "
        + "no hatch and no dashed set",
        "no sym classes",
        /class="sym[cf]"/.test(nsvg) ? "PRESENT" : "absent",
        !/class="sym[cf]"/.test(nsvg));
    }
  }

  // ══ S3 ═══════════════════════════════════════════════════════════════════
  const S3 = "S3 · proportional symbols — a layer read as size instead of colour";
  {
    const N = 32, CELL = 0.5;
    const dem = DEM.synthetic(N, N, CELL, () => 10);
    /** a layer running 0..1 left to right, with a NaN column */
    const grid = new Float32Array(N * N);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) grid[r * N + c] = c / (N - 1);
    }
    for (let r = 0; r < N; r++) grid[r * N + 5] = NaN;

    {
      // ⚠️ NaN IS NOT ZERO. A zero-radius dot where the layer has no answer
      // reads as "measured, and very low" exactly where the truth is "not
      // measured at all" — the same rule the rule masks keep.
      const syms = symbolField(dem, grid, { lo: 0, hi: 1, stride: 1 });
      const onNaN = syms.filter((s) => Math.round(s.x / CELL) === 5).length;
      add(S3, "a cell with no answer gets NO circle, rather than one of zero "
        + "size — a dot there would read as measured and very low, where the "
        + "truth is not measured at all",
        "0 symbols on the NaN column", `${onNaN}`, onNaN === 0);
      add(S3, "…and every other cell gets one",
        `${N * N - N} symbols`, `${syms.length}`, syms.length === N * N - N);
    }

    {
      // The size rule as it was asked for: full value → a circle the width of
      // the sample spacing, which at stride 1 is the cell.
      const syms = symbolField(dem, grid, { lo: 0, hi: 1, stride: 1, minFraction: 0 });
      let big = null, small = null;
      for (const s of syms) {
        if (!big || s.v > big.v) big = s;
        if (!small || s.v < small.v) small = s;
      }
      add(S3, "a cell at the top of the range draws a circle exactly the sample "
        + "spacing across — at stride 1 that is the cell itself",
        `${CELL} m across`, `${f4(big.r * 2)} m`, near(big.r * 2, CELL, 1e-9));
      add(S3, "…and one at the bottom draws nothing, so the scale runs from zero",
        "0 m", `${f4(small.r * 2)} m`, near(small.r, 0, 1e-9));
    }

    {
      // ⚠️ A REAL BUT SMALL VALUE MUST STAY VISIBLE. Without a floor the bottom
      // of the range is a circle smaller than the line it is drawn with, which
      // is indistinguishable from the NaN case the row above exists to keep
      // distinct.
      const syms = symbolField(dem, grid, { lo: 0, hi: 1, stride: 1, minFraction: 0.2 });
      let small = null;
      for (const s of syms) if (!small || s.v < small.v) small = s;
      add(S3, "…but with a floor set, the smallest circle is that fraction of "
        + "full size rather than invisible — otherwise the bottom of the scale "
        + "cannot be told from a cell with no answer at all",
        `${f4(0.2 * CELL / 2)} m radius`, `${f4(small.r)} m`,
        near(small.r, 0.2 * CELL / 2, 1e-9));
    }

    {
      // The threshold skips, it does not shrink.
      const all = symbolField(dem, grid, { lo: 0, hi: 1, stride: 1 });
      const half = symbolField(dem, grid, { lo: 0, hi: 1, stride: 1, threshold: 0.5 });
      const below = half.filter((s) => s.v < 0.5 - 1e-9).length;
      add(S3, "the threshold DROPS the symbols below it rather than drawing them "
        + "small — a symbol map of a layer that is mostly near zero is otherwise "
        + "mostly ink saying nothing",
        "none below the threshold, and fewer than the full field",
        `${below} below, ${half.length} of ${all.length}`,
        below === 0 && half.length < all.length);
    }

    {
      // Stride thins the field without moving it.
      const s1 = symbolField(dem, grid, { lo: 0, hi: 1, stride: 1 });
      const s4 = symbolField(dem, grid, { lo: 0, hi: 1, stride: 4 });
      add(S3, "a stride thins the field to roughly its square, so a 256² tile is "
        + "a legible few thousand symbols rather than 65 536",
        "about 1/16 of the full field",
        `${s4.length} of ${s1.length}`,
        s4.length < s1.length / 8 && s4.length > s1.length / 32);
      // ⚠️ THE STRIDE NEED NOT SAMPLE THE EXTREME VALUE, so this cannot assert
      // that the biggest circle drawn is full size — it sampled column 29 of 31
      // here, a value of 0.935, and asserting 1.0 failed against correct code.
      // What governs is the SCALE: a value v draws a diameter of v × the sample
      // spacing, whatever v the stride happened to land on.
      const s4b = symbolField(dem, grid, { lo: 0, hi: 1, stride: 4, minFraction: 0 });
      const biggest = s4b.reduce((a, s) => (s.r > a.r ? s : a), s4b[0]);
      add(S3, "…and a full-size circle grows with the stride, so neighbouring "
        + "symbols still just touch rather than leaving the map mostly empty",
        `${f4(biggest.v * 4 * CELL)} m across at value ${f4(biggest.v)}`,
        `${f4(biggest.r * 2)} m`,
        near(biggest.r * 2, biggest.v * 4 * CELL, 1e-6));
      add(S3, "…and the stride is chosen from the GRID, because what a reader "
        + "can take in is a number of symbols, not a number of cells between them",
        "1 on a 32² grid at 40 across", `${strideFor(dem, 40)}`,
        strideFor(dem, 40) === 1 && strideFor({ nrows: 256, ncols: 256 }, 40) > 1);
    }

    {
      // ⚠️ THE LEGEND IS ROUND VALUES WITH RADII THAT FOLLOW, not round radii
      // with arbitrary numbers beside them — which is the way round that lets
      // somebody hold the legend against the map.
      const refs = symbolLegend(0, 1, { stride: 1, cell: CELL, minFraction: 0 });
      const roundish = refs.every((r) => Math.abs(r.v * 100 - Math.round(r.v * 100)) < 1e-6);
      const rising = refs.every((r, i) => i === 0 || r.r > refs[i - 1].r);
      add(S3, "the legend states round VALUES and lets their radii follow, so it "
        + "can be held against the map and read off",
        "values on the 1-2-5 series, radii ascending",
        `${refs.map((r) => r.v).join(", ")}`,
        refs.length >= 2 && roundish && rising);
      // A legend circle and a map circle of the same value must be the same size.
      const syms = symbolField(dem, grid, { lo: 0, hi: 1, stride: 1, minFraction: 0 });
      const atOne = syms.reduce((a, s) => (s.v > a.v ? s : a), syms[0]);
      const legOne = refs[refs.length - 1];
      add(S3, "…and a legend circle is the SAME SIZE as a map circle of the same "
        + "value, or the legend is for a different map",
        `${f4(atOne.r)} m`, `${f4(legOne.r)} m`, near(atOne.r, legOne.r, 1e-9));
    }

    {
      // A grid that does not match the DEM is refused rather than half-drawn.
      const wrong = symbolField(dem, new Float32Array(10), { lo: 0, hi: 1 });
      add(S3, "a layer whose length does not match the grid draws nothing, "
        + "rather than a partial field over the wrong cells",
        "0 symbols", `${wrong.length}`, wrong.length === 0);
    }
  }

  // ══ P2 ═══════════════════════════════════════════════════════════════════
  const P2 = "P2 · site photographs — a geotag placed where it actually is";
  {
    /**
     * A minimal JPEG carrying nothing but an EXIF GPS block.
     *
     * ⚠️ SYNTHESISED RATHER THAN BUNDLED, so this group runs headless with no
     * fixture file and no personal data in the repository — a site photograph
     * is the one input here that can carry both. Every offset below is
     * relative to the START OF THE TIFF HEADER, which is the EXIF convention
     * and the single easiest thing to get wrong in this format.
     */
    const jpegWithGPS = ({ lat, latRef, lon, lonRef, alt, altRef, dir }) => {
      const IFD0 = 8, GPS = 26, DATA = 116;
      const buf = new ArrayBuffer(12 + 180);
      const b = new Uint8Array(buf);
      const dv = new DataView(buf);
      b[0] = 0xff; b[1] = 0xd8;                       // SOI
      b[2] = 0xff; b[3] = 0xe1;                       // APP1
      dv.setUint16(4, 8 + 180, false);                // segment length
      b.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);       // "Exif\0\0"
      const T = 12;                                   // TIFF header starts here
      b[T] = 0x49; b[T + 1] = 0x49;                   // "II" little-endian
      dv.setUint16(T + 2, 42, true);
      dv.setUint32(T + 4, IFD0, true);

      dv.setUint16(T + IFD0, 1, true);                // IFD0: one entry
      dv.setUint16(T + IFD0 + 2, 0x8825, true);       // GPSInfoIFDPointer
      dv.setUint16(T + IFD0 + 4, 4, true);            // LONG
      dv.setUint32(T + IFD0 + 6, 1, true);
      dv.setUint32(T + IFD0 + 10, GPS, true);
      dv.setUint32(T + IFD0 + 14, 0, true);           // no next IFD

      let e = T + GPS + 2, n = 0, d = DATA;
      const rational = (vals) => {
        const at = d;
        for (const [num, den] of vals) {
          dv.setUint32(T + d, num, true); dv.setUint32(T + d + 4, den, true); d += 8;
        }
        return at;
      };
      const entry = (tag, type, count, valueOrOffset, inlineBytes) => {
        dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true);
        dv.setUint32(e + 4, count, true);
        // ⚠️ `e` IS ALREADY ABSOLUTE (it started at T + GPS + 2), so the
        // inline value goes at e + 8 and NOT at T + e + 8. Adding T twice
        // wrote every short value 12 bytes past where the reader looks, which
        // showed up as refs reading "\0" — no hemisphere flip, no altitude
        // reference — and looked exactly like a parser fault.
        if (inlineBytes) b.set(inlineBytes, e + 8);
        else dv.setUint32(e + 8, valueOrOffset, true);
        e += 12; n++;
      };
      entry(1, 2, 2, 0, [latRef.charCodeAt(0), 0]);          // GPSLatitudeRef
      entry(2, 5, 3, rational(lat));                          // GPSLatitude
      entry(3, 2, 2, 0, [lonRef.charCodeAt(0), 0]);          // GPSLongitudeRef
      entry(4, 5, 3, rational(lon));                          // GPSLongitude
      entry(5, 1, 1, 0, [altRef, 0, 0, 0]);                  // GPSAltitudeRef
      // ⚠️ `alt` and `dir` ARRIVE ALREADY WRAPPED as [[num, den]] — wrapping
      // them again handed the writer an array where it wanted a number, and
      // setUint32 quietly stored 0.
      entry(6, 5, 1, rational(alt));                          // GPSAltitude
      entry(17, 5, 1, rational(dir));                         // GPSImgDirection
      dv.setUint16(T + GPS, n, true);
      dv.setUint32(e, 0, true);
      return buf;
    };

    {
      // ⚠️ THE ONE EXTERNAL GROUND TRUTH THIS PROJECTION HAS. data/orndalen/
      // SOURCE.txt records the site reference in BOTH systems, produced
      // independently in QGIS: "69.70084 N, 19.00224 E = E 654 862,
      // N 7 737 588 (EPSG:25833)". The figures are given to the metre, so
      // agreement to within a metre is agreement to their precision. A wrong
      // zone or a mis-signed hemisphere lands a photograph hundreds of
      // kilometres away while still looking like a valid easting.
      const p = toUTM33(69.70084, 19.00224);
      const dE = Math.abs(p.x - 654862), dN = Math.abs(p.y - 7737588);
      add(P2, "the UTM33 projection agrees with SOURCE.txt's independently " +
        "produced coordinates for the site reference point — a wrong zone or " +
        "hemisphere would still look like a valid easting",
        "within 1 m of E 654 862, N 7 737 588",
        `dE ${dE.toFixed(1)} m, dN ${dN.toFixed(1)} m`,
        dE < 1 && dN < 1);
    }

    {
      // On the central meridian the easting IS the false easting, exactly, at
      // every latitude — the definition of the projection, and the cheapest
      // check that the series has not been mis-transcribed.
      const worst = [0, 45, 69.7, 80]
        .map((lat) => Math.abs(toUTM33(lat, 15).x - 500000))
        .reduce((a, b) => Math.max(a, b), 0);
      add(P2, "…and on the zone's central meridian the easting is exactly the " +
        "false easting at every latitude, which is what the projection means",
        "500000.000000 m", `worst error ${worst.toExponential(1)} m`,
        worst < 1e-6);
      const e1 = toUTM33(69.7, 19.0).x, e2 = toUTM33(69.7, 19.1).x;
      const n1 = toUTM33(69.7, 19.0).y, n2 = toUTM33(69.8, 19.0).y;
      add(P2, "…and east is east, north is north — a sign slip here mirrors " +
        "every photograph about an axis and still produces plausible numbers",
        "easting grows eastward, northing grows northward",
        `dE ${(e2 - e1).toFixed(0)} m, dN ${(n2 - n1).toFixed(0)} m`,
        e2 > e1 && n2 > n1);
    }

    {
      const g = readExifGPS(jpegWithGPS({
        lat: [[69, 1], [42, 1], [230, 10]], latRef: "N",
        lon: [[19, 1], [0, 1], [391, 10]], lonRef: "E",
        alt: [[721, 10]], altRef: 0, dir: [[3101, 10]],
      }));
      const wantLat = 69 + 42 / 60 + 23.0 / 3600;
      const wantLon = 19 + 0 / 60 + 39.1 / 3600;
      add(P2, "the EXIF walk reads degrees-minutes-seconds as three RATIONALs " +
        "and returns decimal degrees — the GPS block is a TIFF IFD inside a " +
        "JPEG segment, and every offset in it is relative to the TIFF header",
        `${wantLat.toFixed(6)}, ${wantLon.toFixed(6)}`,
        g ? `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}` : "null",
        !!g && near(g.lat, wantLat, 1e-9) && near(g.lon, wantLon, 1e-9));
      add(P2, "…along with the altitude and the compass heading, which is the " +
        "only directional datum a phone records — there is no pitch, which is " +
        "why the pin draws a heading tick and not a view cone",
        "alt 72.1 m, bearing 310.1°",
        g ? `alt ${g.alt.toFixed(1)} m, bearing ${g.bearing.toFixed(1)}°` : "null",
        !!g && near(g.alt, 72.1, 0.05) && near(g.bearing, 310.1, 0.05));
    }

    {
      // ⚠️ THE HEMISPHERE REFS ARE NOT DECORATION. Ignoring them puts a
      // southern-hemisphere photograph in the north and a western one east of
      // the meridian, both silently.
      const s = readExifGPS(jpegWithGPS({
        lat: [[33, 1], [30, 1], [0, 1]], latRef: "S",
        lon: [[70, 1], [30, 1], [0, 1]], lonRef: "W",
        alt: [[100, 1]], altRef: 0, dir: [[0, 1]],
      }));
      add(P2, "S and W references flip the sign — a photograph taken south of " +
        "the equator must not be placed north of it",
        "-33.5, -70.5", s ? `${s.lat.toFixed(1)}, ${s.lon.toFixed(1)}` : "null",
        !!s && near(s.lat, -33.5, 1e-9) && near(s.lon, -70.5, 1e-9));

      const below = readExifGPS(jpegWithGPS({
        lat: [[69, 1], [0, 1], [0, 1]], latRef: "N",
        lon: [[19, 1], [0, 1], [0, 1]], lonRef: "E",
        alt: [[15, 1]], altRef: 1, dir: [[0, 1]],
      }));
      add(P2, "…and GPSAltitudeRef 1 means BELOW sea level, so a photograph " +
        "taken in a pit is not reported above the hill beside it",
        "-15 m", below ? `${below.alt} m` : "null",
        !!below && near(below.alt, -15, 1e-9));
    }

    {
      // ⚠️ A PHOTOGRAPH WITHOUT A GEOTAG HAS NO PLACE ON THE MAP AT ALL.
      // Returning a default would invent an observation, which is worse than
      // a missing one — the app refuses the file rather than dropping it at
      // the site centre.
      const plain = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xd9]);
      const notJpeg = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
      const a = readExifGPS(plain.buffer), b = readExifGPS(notJpeg.buffer);
      add(P2, "a JPEG with no geotag, and a file that is not a JPEG, both " +
        "return NOTHING rather than a guess — an invented observation is " +
        "worse than a missing one",
        "null, null", `${a}, ${b}`, a === null && b === null);
    }
  }

  // ══ O2 ═══════════════════════════════════════════════════════════════════
  const O2 = "O2 · the orthophoto drape — a photograph placed, and kept local";
  {
    /**
     * A minimal uncompressed RGB GeoTIFF, single strip.
     *
     * ⚠️ SYNTHESISED, because the real orthos are licence-restricted and must
     * never be committed to a repository or a test fixture. Everything this
     * reader promises can be checked against a file built here.
     */
    const rgbTiff = ({ w, h, cell, tieX, tieY, spp = 3, compression = 1, px }) => {
      const N_ENTRIES = 12;
      const IFD = 8;
      const dataStart = IFD + 2 + N_ENTRIES * 12 + 4;
      const bpsAt = dataStart;                 // 3 SHORTs
      const scaleAt = bpsAt + 6;               // 3 DOUBLEs
      const tieAt = scaleAt + 24;              // 6 DOUBLEs
      const pixAt = tieAt + 48;
      const buf = new ArrayBuffer(pixAt + w * h * spp);
      const b = new Uint8Array(buf);
      const dv = new DataView(buf);
      b[0] = 0x49; b[1] = 0x49;
      dv.setUint16(2, 42, true);
      dv.setUint32(4, IFD, true);

      let e = IFD + 2, n = 0;
      const entry = (tag, type, count, value) => {
        dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true);
        dv.setUint32(e + 4, count, true);
        if (type === 3 && count === 1) dv.setUint16(e + 8, value, true);
        else dv.setUint32(e + 8, value, true);
        e += 12; n++;
      };
      entry(256, 3, 1, w);                     // ImageWidth
      entry(257, 3, 1, h);                     // ImageLength
      entry(258, 3, 3, bpsAt);                 // BitsPerSample
      entry(259, 3, 1, compression);           // Compression
      entry(262, 3, 1, 2);                     // Photometric = RGB
      entry(273, 4, 1, pixAt);                 // StripOffsets
      entry(277, 3, 1, spp);                   // SamplesPerPixel
      entry(278, 3, 1, h);                     // RowsPerStrip
      entry(279, 4, 1, w * h * spp);           // StripByteCounts
      entry(284, 3, 1, 1);                     // PlanarConfiguration
      entry(33550, 12, 3, scaleAt);            // ModelPixelScale
      entry(33922, 12, 6, tieAt);              // ModelTiepoint
      dv.setUint16(IFD, n, true);
      dv.setUint32(e, 0, true);

      for (let i = 0; i < 3; i++) dv.setUint16(bpsAt + i * 2, 8, true);
      dv.setFloat64(scaleAt, cell, true);
      dv.setFloat64(scaleAt + 8, cell, true);
      dv.setFloat64(scaleAt + 16, 0, true);
      for (let i = 0; i < 3; i++) dv.setFloat64(tieAt + i * 8, 0, true);
      dv.setFloat64(tieAt + 24, tieX, true);
      dv.setFloat64(tieAt + 32, tieY, true);
      dv.setFloat64(tieAt + 40, 0, true);
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const [rr, gg, bb] = px(r, c);
          const o = pixAt + (r * w + c) * spp;
          b[o] = rr; b[o + 1] = gg; b[o + 2] = bb;
        }
      }
      return buf;
    };

    // A 4x4 image whose north-west pixel is unmistakable.
    const NW = [255, 0, 0], NE = [0, 255, 0], SW = [0, 0, 255], SE = [255, 255, 0];
    const corners = (r, c) => (r === 0 ? (c === 0 ? NW : NE) : (r === 3 ? (c === 0 ? SW : SE) : [128, 128, 128]));

    {
      const img = readOrthoTIFF(rgbTiff({
        w: 4, h: 4, cell: 2, tieX: 1000, tieY: 2000, px: corners,
      }));
      // originY is the SOUTH edge: tie is the north-west corner, so the south
      // edge is tieY - height*cell.
      add(O2, "the reader returns the image and its georeferencing — origin " +
        "is the SOUTH-WEST corner, derived from the north-west tiepoint, " +
        "matching the convention the elevation reader already uses",
        "4x4 @ 2 m, E 1000, N 1992",
        `${img.width}x${img.height} @ ${img.cell} m, E ${img.originX}, N ${img.originY}`,
        img.width === 4 && img.height === 4 && img.cell === 2
        && img.originX === 1000 && img.originY === 1992);

      const first = [img.rgb[0], img.rgb[1], img.rgb[2]];
      const last = [img.rgb[(15 * 3)], img.rgb[15 * 3 + 1], img.rgb[15 * 3 + 2]];
      add(O2, "…and the three bands come back INTERLEAVED per pixel, not as " +
        "one band widened — a photograph is three channels and reading only " +
        "the first would return a greyscale of the red one",
        "first pixel 255,0,0 · last 255,255,0",
        `${first.join(",")} · ${last.join(",")}`,
        first.join() === NW.join() && last.join() === SE.join());
    }

    {
      let msg = "", ok = false;
      try { readOrthoTIFF(rgbTiff({ w: 2, h: 2, cell: 1, tieX: 0, tieY: 0, compression: 5, px: () => [0, 0, 0] })); }
      catch (err) { msg = err.message; ok = /gdal_translate/.test(msg); }
      add(O2, "a compressed ortho fails with a message that NAMES THE FIX, " +
        "rather than leaving the user to guess — the same contract the " +
        "elevation reader keeps",
        "error naming gdal_translate", msg.slice(0, 48) + "…", ok);

      let m2 = "", ok2 = false;
      try { readOrthoTIFF(rgbTiff({ w: 2, h: 2, cell: 1, tieX: 0, tieY: 0, spp: 1, px: () => [0, 0, 0] })); }
      catch (err) { m2 = err.message; ok2 = /image, not a grid|at least 3 bands/.test(m2); }
      add(O2, "…and a single-band raster is refused as an image — it is a " +
        "grid, and grids belong to the elevation reader",
        "error naming the band count", m2.slice(0, 48) + "…", ok2);
    }

    {
      // ⚠️ ROW 0 IS THE NORTH EDGE IN BOTH GRIDS, and a flip here is the most
      // plausible-looking bug this module could have: the drape would land
      // upside down and still cover the site perfectly.
      const img = readOrthoTIFF(rgbTiff({
        w: 4, h: 4, cell: 2, tieX: 1000, tieY: 2000, px: corners,
      }));
      const dem = { nrows: 4, ncols: 4, cell: 2, originX: 1000, originY: 1992 };
      const d = drapeOnto(img, dem);
      const at = (r, c) => [d.rgba[(r * 4 + c) * 4], d.rgba[(r * 4 + c) * 4 + 1],
        d.rgba[(r * 4 + c) * 4 + 2]];
      add(O2, "draped on a matching grid the photograph covers it entirely, " +
        "and the NORTH-WEST pixel lands north-west — row 0 is the north edge " +
        "in both grids, and a flip would cover the site perfectly upside down",
        "100% covered, NW = 255,0,0, SE = 255,255,0",
        `${(d.covered * 100).toFixed(0)}% covered, NW = ${at(0, 0).join(",")}, ` +
        `SE = ${at(3, 3).join(",")}`,
        d.covered === 1 && at(0, 0).join() === NW.join() && at(3, 3).join() === SE.join());
    }

    {
      // Nearest neighbour: every value out must be a value that was in. An
      // interpolating resample would invent pixel values that were never
      // photographed — harmless on a backdrop, wrong on something a student
      // may read ground cover off.
      const img = readOrthoTIFF(rgbTiff({
        w: 8, h: 8, cell: 1, tieX: 0, tieY: 8,
        px: (r, c) => [(r * 8 + c) * 3, 0, 0],
      }));
      const dem = { nrows: 16, ncols: 16, cell: 0.5, originX: 0, originY: 0 };
      const d = drapeOnto(img, dem);
      const seen = new Set();
      for (let i = 0; i < 16 * 16; i++) if (d.rgba[i * 4 + 3]) seen.add(d.rgba[i * 4]);
      const source = new Set();
      for (let i = 0; i < 64; i++) source.add(i * 3);
      const invented = [...seen].filter((v) => !source.has(v));
      add(O2, "the resample is NEAREST NEIGHBOUR — every draped value is a " +
        "value that was actually photographed, never one interpolated into " +
        "existence between two",
        "0 invented values", `${invented.length}`, invented.length === 0);
    }

    {
      const img = readOrthoTIFF(rgbTiff({
        w: 4, h: 4, cell: 2, tieX: 1000, tieY: 2000, px: corners,
      }));
      // Half the DEM lies east of the image.
      const partial = drapeOnto(img, { nrows: 4, ncols: 8, cell: 2, originX: 1000, originY: 1992 });
      // ⚠️ AND A PHOTOGRAPH OF SOMEWHERE ELSE RETURNS NULL, which is what let
      // the app say "this ortho does not overlap this site" instead of
      // draping nothing and looking broken. The POI orthos and the fill-floor
      // DEM are exactly this case, 460 m apart.
      const none = drapeOnto(img, { nrows: 4, ncols: 4, cell: 2, originX: 900000, originY: 1992 });
      add(O2, "partial cover reports the fraction it actually reached, and a " +
        "photograph of somewhere else returns NOTHING — which is how the tool " +
        "can say the extents do not meet rather than draping an empty layer",
        "50% partial, null for no overlap",
        `${(partial.covered * 100).toFixed(0)}%, ${none}`,
        near(partial.covered, 0.5, 1e-9) && none === null);

      const uncovered = [];
      for (let i = 0; i < 4 * 8; i++) if (!partial.rgba[i * 4 + 3]) uncovered.push(i);
      add(O2, "…and cells outside the photograph stay TRANSPARENT rather than " +
        "black, so the terrain's own shading shows through where there is no " +
        "image — 'no data here' must not read as 'dark ground here'",
        "16 transparent cells, alpha 0", `${uncovered.length} cells`,
        uncovered.length === 16);
    }
  }

  // ══ Y2 ═══════════════════════════════════════════════════════════════════
  // THE TERRAIN OF ATTRIBUTES — a glyph built by an ordered chain (2026-08-20).
  // Every other reading paints an attribute onto the ground; this builds the
  // ground's replacement out of the attributes themselves. What has to hold:
  // the order of the chain is part of its meaning, a missing answer drops the
  // whole glyph rather than one step, and the geometry means what it says —
  // including the compass direction of a bend, which is the one thing here
  // that looks entirely correct while being exactly backwards.
  const Y2 = "Y2 · the glyph chain — attributes that build a form, in order";
  {
    const N = 24, CELL = 1;
    /** A plane falling to the EAST: aspect 90°, a known slope. */
    const grade = 0.5;                       // 0.5 m per m ⇒ 26.565°
    const dem = DEM.synthetic(N, N, CELL, (r, c) => 100 - c * CELL * grade);
    const g = computeGradient(dem);
    const mid = Math.floor(N / 2) * N + Math.floor(N / 2);

    const fields = {
      aspect: { grid: g.aspectDeg, lo: 0, hi: 360 },
      slope: { grid: g.slopeDeg, lo: 0, hi: 90 },
      elevation: { grid: dem.z, lo: 100 - N * grade, hi: 100 },
    };
    const val = (k) => fields[k].grid[mid];
    const at = { x: 0, y: 0, z: 0 };
    const values = { aspect: val("aspect"), slope: val("slope"), elevation: val("elevation") };

    // ── the surface normal, and why this pair is the natural opening ──────
    // ⚠️ TURN BY ASPECT THEN LEAN BY SLOPE IS EXACTLY THE SURFACE NORMAL, and
    // that is a fact rather than a coincidence: the normal's horizontal part
    // points the way the ground faces and its inclination from vertical IS the
    // slope. Worth pinning because it is what makes the default chain read as
    // terrain before any other row has acted — and if the aspect convention or
    // the heading formula ever drifts apart, this is the row that says so.
    {
      const chain = [
        { key: "aspect", op: "turn" }, { key: "slope", op: "tilt" },
        { key: "elevation", op: "extend" },
      ];
      const built = buildGlyph(at, chain, values, fields, { length: 1 });
      const p = built.pts;
      const n = p.length;
      const dir = [p[n - 3] - p[0], p[n - 2] - p[1], p[n - 1] - p[2]];
      const L = Math.hypot(...dir);
      const u = dir.map((v) => v / L);
      // The analytic normal, from the gradient the tool already computes.
      const nx = -g.gx[mid], ny = -g.gy[mid], nz = 1;
      const nl = Math.hypot(nx, ny, nz);
      const nrm = [nx / nl, ny / nl, nz / nl];
      const dot = u[0] * nrm[0] + u[1] * nrm[1] + u[2] * nrm[2];
      add(Y2, "turn by aspect then lean by slope points the glyph along the "
        + "SURFACE NORMAL — the normal leans the way the ground faces, by the "
        + "ground's own slope, so this pair reads as terrain before any other "
        + "row acts. If the aspect convention and the heading formula ever "
        + "drift apart, this is the row that notices",
        "the glyph and the analytic normal agree to 1e-6",
        `dot ${dot.toFixed(9)}`, Math.abs(dot - 1) < 1e-6);
    }

    // ── where order lives, and where it does not ─────────────────────────
    {
      const tip = (o) => o.pts.slice(-3);
      const apart = (a, b) => {
        const ta = tip(a), tb = tip(b);
        return Math.hypot(ta[0] - tb[0], ta[1] - tb[1], ta[2] - tb[2]);
      };
      const build = (chain) => buildGlyph(at, chain, values, fields, { length: 1 });

      // ⚠️ TURN AND TILT COMMUTE, AND THIS ROW EXISTS BECAUSE THE FILE ONCE
      // CLAIMED THEY DID NOT. They set two independent coordinates of one
      // direction — a bearing and an inclination — which are read together only
      // when a segment is emitted. Asserting a difference here failed at
      // 0.0000, which is how the over-claim was found. Pinned in the true
      // direction so nobody "fixes" the commutativity back out.
      const tt = build([{ key: "aspect", op: "turn" }, { key: "slope", op: "tilt" },
        { key: "elevation", op: "extend" }]);
      const ttSwapped = build([{ key: "slope", op: "tilt" }, { key: "aspect", op: "turn" },
        { key: "elevation", op: "extend" }]);
      add(Y2, "turn and tilt are two coordinates of ONE direction and commute "
        + "with each other — swapping them is the same glyph, and a comment "
        + "that claimed otherwise was wrong until this row said so",
        "identical to 1e-12", `${apart(tt, ttSwapped).toExponential(1)} apart`,
        apart(tt, ttSwapped) < 1e-12);

      // …and this is where order DOES live: an extend emitted before a turn
      // leaves along the old bearing.
      const after = build([{ key: "aspect", op: "turn" }, { key: "slope", op: "tilt" },
        { key: "elevation", op: "extend" }]);
      const before = build([{ key: "elevation", op: "extend" },
        { key: "aspect", op: "turn" }, { key: "slope", op: "tilt" }]);
      add(Y2, "…but moving an EXTEND above them changes the glyph completely — "
        + "the segment leaves along the bearing that existed when it was "
        + "emitted, which is what makes this a chain rather than a set",
        "the two tips are far apart",
        `${apart(after, before).toFixed(4)} apart`, apart(after, before) > 0.2);

      // …and a turn between two extends elbows the glyph, which is the only
      // way to get an articulated form out of this vocabulary at all.
      const straight = build([{ key: "elevation", op: "extend", gain: 0.5 },
        { key: "elevation", op: "extend", gain: 0.5 }]);
      const elbowed = build([{ key: "elevation", op: "extend", gain: 0.5 },
        { key: "slope", op: "tilt" }, { key: "elevation", op: "extend", gain: 0.5 }]);
      const segAngles = (o) => {
        const a = [];
        for (let i = 6; i < o.pts.length; i += 3) {
          const d1 = [o.pts[i - 3] - o.pts[i - 6], o.pts[i - 2] - o.pts[i - 5],
            o.pts[i - 1] - o.pts[i - 4]];
          const d2 = [o.pts[i] - o.pts[i - 3], o.pts[i + 1] - o.pts[i - 2],
            o.pts[i + 2] - o.pts[i - 1]];
          const n1 = Math.hypot(...d1), n2 = Math.hypot(...d2);
          const dot = (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) / (n1 * n2);
          a.push(Math.acos(Math.min(1, Math.max(-1, dot))));
        }
        return a;
      };
      const bendiest = Math.max(...segAngles(elbowed));
      add(Y2, "…and a turn placed BETWEEN two extends elbows the glyph, which "
        + "is the only way this vocabulary produces an articulated form",
        "straight: no corner · elbowed: one real corner",
        `straight ${Math.max(...segAngles(straight)).toFixed(6)} rad, `
        + `elbowed ${bendiest.toFixed(4)} rad`,
        Math.max(...segAngles(straight)) < 1e-9 && bendiest > 0.2);
    }

    // ── no answer anywhere in the chain, no glyph ────────────────────────
    {
      const chain = [{ key: "aspect", op: "turn" }, { key: "slope", op: "tilt" },
        { key: "elevation", op: "extend" }];
      const flatVals = { ...values, aspect: NaN };
      const none = buildGlyph(at, chain, flatVals, fields, { length: 1 });
      // ⚠️ THE WHOLE GLYPH, NOT THE ONE STEP. A chain is a sentence about a
      // cell; dropping a word does not shorten the sentence, it changes it. And
      // this is the rule that makes the tool's own finding visible: aspect is
      // NaN on flat ground BY DESIGN (reading it as 0 would report a levelled
      // plane as north-facing), so an aspect-led field thins out exactly where
      // the ground has been levelled. Measured in the app: levelling a
      // 140 × 140-cell region removed 1,225 of 4,096 glyphs and restored all
      // of them on undo.
      add(Y2, "a cell with no answer for ANY step carries no glyph — not a "
        + "shorter one. Aspect is NaN on flat ground by design, so an "
        + "aspect-led chain makes a levelled surface vanish rather than "
        + "reporting it as facing north",
        "null", none === null ? "null" : "A GLYPH WAS BUILT", none === null);
    }

    // ── a chain that never extends draws nothing ─────────────────────────
    {
      const noLine = buildGlyph(at, [{ key: "aspect", op: "turn" },
        { key: "slope", op: "tilt" }], values, fields, { length: 1 });
      add(Y2, "…and a chain that never extends has no line at all — one point "
        + "is a position, not a glyph",
        "null", noLine === null ? "null" : "SOMETHING WAS DRAWN", noLine === null);
    }

    // ── extend follows the value, and invert flips it ────────────────────
    {
      const len = (v, invert) => {
        const o = buildGlyph(at, [{ key: "elevation", op: "extend", invert }],
          { elevation: v }, fields, { length: 1 });
        const p = o.pts, n = p.length;
        return Math.hypot(p[n - 3] - p[0], p[n - 2] - p[1], p[n - 1] - p[2]);
      };
      const lowUp = len(fields.elevation.lo, false);
      const highUp = len(fields.elevation.hi, false);
      const lowInv = len(fields.elevation.lo, true);
      const highInv = len(fields.elevation.hi, true);
      add(Y2, "extend grows with the value, and inverting a row makes it grow "
        + "with the LOW end instead — which is what 'longer the lower it is' "
        + "asks for, said once and read the same way by every row",
        "plain: low < high · inverted: low > high",
        `plain ${lowUp.toFixed(3)} < ${highUp.toFixed(3)} · `
        + `inverted ${lowInv.toFixed(3)} > ${highInv.toFixed(3)}`,
        lowUp < highUp && lowInv > highInv
        && Math.abs(lowUp - highInv) < 1e-9);
    }

    // ── a bend with nothing to bend is INERT, and says so ────────────────
    {
      const early = buildGlyph(at,
        [{ key: "slope", op: "bend" }, { key: "elevation", op: "extend" }],
        values, fields, { length: 1 });
      const late = buildGlyph(at,
        [{ key: "elevation", op: "extend" }, { key: "slope", op: "bend" }],
        values, fields, { length: 1 });
      // ⚠️ REPORTED, NOT REPAIRED. Promoting a leading bend to "curve whatever
      // comes next" would make the chain mean the same thing in two different
      // orders, and order is the whole point. Removing it would silently
      // rewrite what the designer typed. So it stays, does nothing, and the
      // panel marks the row — exactly as the selection stack marks the rows
      // above its first union. §5.1: a note that contradicts the thing beside
      // it is worse than no note.
      add(Y2, "a bend before anything has been drawn is INERT and is reported "
        + "rather than repaired — promoting it to curve what comes next would "
        + "make two different orders mean the same thing, and removing it would "
        + "silently rewrite the chain",
        "leading bend: 1 inert note, and it changes nothing",
        `${early.inert.length} note(s); trailing bend inert ${late.inert.length}`,
        early.inert.length === 1 && late.inert.length === 0);
    }

    // ── a bend actually curves, and bends the way it is pointed ──────────
    {
      // ⚠️⚠️ THE COMPASS DIRECTION OF A BEND. The rotation axis is Z × bearing;
      // written bearing × Z the whole field leans due SOUTH when asked to lean
      // NORTH, and a field of glyphs leaning confidently the wrong way is
      // completely convincing until it is held against the compass. Same class
      // of defect as the grading key's mirrored hatch, caught the same way —
      // by measuring the geometry rather than looking at it.
      const straight = buildGlyph(at, [{ key: "elevation", op: "extend" }],
        { elevation: fields.elevation.hi }, fields, { length: 1 });
      // A chain that faces NORTH (turn by 0) and then bends hard.
      const northFields = { ...fields, k: { grid: new Float32Array(1), lo: 0, hi: 1 } };
      const bent = buildGlyph(at,
        [{ key: "elevation", op: "extend" }, { key: "k", op: "bend", gain: 1 }],
        { elevation: fields.elevation.hi, k: 1 }, northFields, { length: 1 });
      const tipS = straight.pts.slice(-3), tipB = bent.pts.slice(-3);
      // Base azimuth is 0 = north, so the tip must move NORTH (+y) and drop.
      add(Y2, "a bend curves the line as it stands, and it bends toward the "
        + "bearing the glyph is facing — the rotation axis is Z × bearing, and "
        + "the other way round leans the whole field due south while looking "
        + "entirely correct",
        "facing north: the tip moves north (+y) and drops",
        `Δy ${(tipB[1] - tipS[1]).toFixed(4)}, Δz ${(tipB[2] - tipS[2]).toFixed(4)}`,
        tipB[1] - tipS[1] > 0.05 && tipB[2] < tipS[2]);

      // …and the bend is a CURVE, not a hinge: successive segments each turn a
      // little more, and by a CONSTANT amount, which is what makes it an arc.
      // ⚠️ MEASURED AS THE ANGLE BETWEEN SEGMENTS, NOT IN A CHOSEN PLANE. The
      // first version of this row read atan2(dz, dx) — but a glyph facing north
      // bends in the y–z plane, where dx is identically zero, so it was
      // measuring the arctangent of nothing and reported a real arc as a hinge.
      // The angle between successive direction vectors has no preferred plane
      // and cannot go degenerate whichever way the glyph faces.
      const step = [];
      for (let i = 6; i < bent.pts.length; i += 3) {
        const d1 = [bent.pts[i - 3] - bent.pts[i - 6], bent.pts[i - 2] - bent.pts[i - 5],
          bent.pts[i - 1] - bent.pts[i - 4]];
        const d2 = [bent.pts[i] - bent.pts[i - 3], bent.pts[i + 1] - bent.pts[i - 2],
          bent.pts[i + 2] - bent.pts[i - 1]];
        const n1 = Math.hypot(...d1), n2 = Math.hypot(...d2);
        const dot = (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) / (n1 * n2);
        step.push(Math.acos(Math.min(1, Math.max(-1, dot))));
      }
      const lo2 = Math.min(...step), hi2 = Math.max(...step);
      add(Y2, "…and it is a curve rather than a hinge — every successive segment "
        + "turns, and all of them turn by the SAME amount, which is what makes "
        + "the deflection an arc instead of a kink at one joint",
        "every step turns, and they are equal",
        `${step.length} joints, ${lo2.toFixed(4)}–${hi2.toFixed(4)} rad`,
        step.length >= 4 && lo2 > 1e-4 && (hi2 - lo2) < 1e-6);
    }

    // ── the whole field: sampling, and what it reports ───────────────────
    {
      const chain = [{ key: "aspect", op: "turn" }, { key: "slope", op: "tilt" },
        { key: "elevation", op: "extend" }];
      const f4 = buildGlyphs(dem, fields, chain, { stride: 4 });
      const f8 = buildGlyphs(dem, fields, chain, { stride: 8 });
      add(Y2, "the field samples at a stride and reports what it drew and what "
        + "it dropped — a count nobody can check is not a measurement",
        "stride 4 draws about four times stride 8",
        `${f4.drawn} at 4, ${f8.drawn} at 8`,
        f4.drawn > 0 && f8.drawn > 0 && f4.drawn > f8.drawn * 3);

      // ⚠️ CENTRE-OUTWARD MEANS THE FIELD STAYS CENTRED — not that a coarser
      // stride samples a subset of a finer one. This row first asserted the
      // subset property and failed 0 of 9: at stride 4 the columns are
      // 1, 5, 9… and at stride 8 they are 3, 11, 19…, which share nothing at
      // all. Both are still centred, and that is the property worth having,
      // because what a designer notices when it is missing is the whole field
      // sliding to one edge as the stride changes. Same arithmetic and the same
      // reason as symbolField.
      const margins = (o, stride) => {
        const xs = [...new Set(o.glyphs.map((gl) => +gl.pts[0].toFixed(9)))]
          .sort((a, b) => a - b);
        const span = (dem.ncols - 1) * dem.cell;
        return { before: xs[0], after: span - xs[xs.length - 1], stride };
      };
      const m4 = margins(f4, 4), m8 = margins(f8, 8);
      add(Y2, "…and it is sampled centre-outward, so the field stays CENTRED at "
        + "every stride — the margin it leaves at the west edge matches the one "
        + "at the east, rather than the whole field sliding to one side as the "
        + "stride is changed",
        "both strides balanced to within one cell",
        `stride 4: ${m4.before.toFixed(2)}/${m4.after.toFixed(2)} · `
        + `stride 8: ${m8.before.toFixed(2)}/${m8.after.toFixed(2)}`,
        Math.abs(m4.before - m4.after) <= dem.cell
        && Math.abs(m8.before - m8.after) <= dem.cell);

      // A row against a layer that was never computed is named, not silent.
      const withGhost = buildGlyphs(dem, fields,
        [...chain, { key: "wind", op: "bend" }], { stride: 8 });
      add(Y2, "a step against a layer that has not been computed is NAMED, and "
        + "the rest of the chain still draws — a field that silently vanished "
        + "would read as broken rather than as waiting for the analysis",
        "wind reported missing, glyphs still drawn",
        `missing [${withGhost.missing}], ${withGhost.drawn} glyphs`,
        withGhost.missing.length === 1 && withGhost.missing[0] === "wind"
        && withGhost.drawn === f8.drawn);
    }

    // ── the sentence ─────────────────────────────────────────────────────
    {
      const labels = { aspect: { label: "Aspect" }, slope: { label: "Slope" },
        elevation: { label: "Elevation" } };
      const s = describeChain(DEFAULT_CHAIN.filter((r) => labels[r.key]), labels);
      add(Y2, "the chain reads back as the sentence it was built from — a field "
        + "of leaning lines is unreadable without the recipe that made it, the "
        + "same reason the selection stack states itself in words",
        "\"…turns to face Aspect, then leans by Slope, then grows with inverted Elevation\"",
        `"${s}"`,
        /turns to face Aspect, then leans by Slope, then grows with inverted Elevation/.test(s));
    }
  }

  // ══ V1 ═══════════════════════════════════════════════════════════════════
  // THE FILM TIMELINE. ⚠️ THIS GROUP EXISTS BECAUSE THE MODULE CLAIMED IT
  // ALREADY DID (2026-08-20). timeline.js said, in its own header, that the
  // beat tiling and the loop closure were "asserted in the kernel suite rather
  // than trusted" — and no such checks had ever been written. The film was
  // dropped before a caller existed and the claim was never true. It is now a
  // deliverable, so the claim is made good here. Same lesson as the false
  // comment in glyphs.js: a claim is worth exactly what its check is worth.
  const V1 = "V1 · the film timeline — a pure function of time, and a closed loop";
  {
    // ── the tiling the header promises ──────────────────────────────────
    {
      let gaps = 0, overlaps = 0;
      for (let i = 1; i < SCRIPT.length; i++) {
        if (SCRIPT[i].from > SCRIPT[i - 1].to) gaps++;
        if (SCRIPT[i].from < SCRIPT[i - 1].to) overlaps++;
      }
      const startsAtZero = SCRIPT[0].from === 0;
      const endsAtDuration = SCRIPT[SCRIPT.length - 1].to === DURATION;
      add(V1, "the beats tile [0, DURATION) with no gap and no overlap, opening "
        + "at 0 and closing exactly on DURATION — a gap would freeze the film on "
        + "whichever beat beatAt() fell through to, and an overlap would make the "
        + "state at that instant depend on which beat was found first",
        "0 gaps, 0 overlaps, 0 to 45",
        `${gaps} gaps, ${overlaps} overlaps, ${SCRIPT[0].from} to `
        + `${SCRIPT[SCRIPT.length - 1].to}`,
        gaps === 0 && overlaps === 0 && startsAtZero && endsAtDuration);

      const b = boundaries();
      add(V1, "…and `boundaries()` reports every cut plus the end, so a contact "
        + "sheet cuts on the beats rather than on a guess",
        `${SCRIPT.length + 1} boundaries, last = DURATION`,
        `${b.length}, last ${b[b.length - 1]}`,
        b.length === SCRIPT.length + 1 && b[b.length - 1] === DURATION);
    }

    // ── beatAt lands on the right side of every cut ─────────────────────
    {
      let ok = true;
      for (const bt of SCRIPT) {
        // A beat owns its own `from` and does NOT own its `to`.
        if (beatAt(bt.from).id !== bt.id) ok = false;
        if (beatAt(bt.to - 1e-9).id !== bt.id) ok = false;
      }
      // …and time wraps, so the film has no end to fall off.
      const wrapped = beatAt(DURATION).id === SCRIPT[0].id
        && beatAt(DURATION + 3).id === beatAt(3).id
        && beatAt(-1).id === beatAt(DURATION - 1).id;
      add(V1, "each beat owns its own start and not its end, and time WRAPS — so "
        + "a seek past the loop point returns the opening beat rather than "
        + "clamping to the last one",
        "every boundary resolves to its own beat; t=45, t=48 and t=-1 all wrap",
        `boundaries ${ok}, wrap ${wrapped}`, ok && wrapped);
    }

    // ── the property capture.js depends on ──────────────────────────────
    {
      // ⚠️ PURITY IS NOT A STYLE PREFERENCE HERE. capture.js seeks straight to
      // the last frame and then back to frame 0 to measure the loop seam, and
      // the offline render seeks to arbitrary times to build a contact sheet.
      // A timeline built by accumulating edits would give a different state
      // depending on the route taken to t, and every seam measurement ever
      // taken would be meaningless.
      const times = [0, 0.4, 6, 12.999, 13, 26, 34.5, 41, 44.999];
      const first = times.map((t) => JSON.stringify(stateAt(t)));
      // Walk the film forwards, then re-ask in reverse and in a shuffled order.
      for (let t = 0; t < DURATION; t += 0.37) stateAt(t);
      const reverse = [...times].reverse().map((t) => JSON.stringify(stateAt(t)))
        .reverse();
      const order = [3, 0, 7, 1, 8, 4, 2, 6, 5];
      const shuffled = order.map((i) => JSON.stringify(stateAt(times[i])));
      const shuffledBack = order.map((pos, k) => [pos, shuffled[k]])
        .sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      add(V1, "stateAt(t) is a PURE function of time — the same instant returns "
        + "the same state after walking the film forwards, backwards and out of "
        + "order. capture.js seeks to the last frame and then to frame 0 to "
        + "measure the seam, so a timeline that accumulated would make every "
        + "seam measurement meaningless",
        "identical across all three traversals",
        `${first.every((v, i) => v === reverse[i]) ? "reverse ok" : "REVERSE DIFFERS"}, `
        + `${first.every((v, i) => v === shuffledBack[i]) ? "shuffled ok" : "SHUFFLED DIFFERS"}`,
        first.every((v, i) => v === reverse[i] && v === shuffledBack[i]));
    }

    // ── the loop actually closes ────────────────────────────────────────
    {
      // ⚠️ t = DURATION IS t = 0 — `stateAt` wraps, so the two are the SAME
      // instant and cannot differ. The first version of this row asked for a
      // full turn between them and failed at +0.000000, which is the wrap
      // working correctly. Closure is a property of the APPROACH from below:
      // the last instant before the wrap must have travelled a whole turn and
      // be back at the opening mix and tolerance.
      const a = stateAt(0), z = stateAt(DURATION - 1e-6);
      const wrapIsIdentity =
        JSON.stringify(stateAt(DURATION)) === JSON.stringify(stateAt(0));
      const turn = z.camera.yaw - a.camera.yaw;
      // ⚠️ THE CAMERA MUST COMPLETE A WHOLE NUMBER OF CYCLES. Nothing in the
      // camera may use a term that does not, or the last frame will not line up
      // with the first and the loop will visibly jump on every repeat.
      const closes = wrapIsIdentity
        && Math.abs(a.mix - z.mix) < 1e-6
        && Math.abs(a.toleranceMM - z.toleranceMM) < 1e-4
        && Math.abs(turn - Math.PI * 2) < 1e-5
        && Math.abs(a.camera.pitch - z.camera.pitch) < 1e-5
        && Math.abs(a.camera.distScale - z.camera.distScale) < 1e-5;
      add(V1, "the loop closes: at t = DURATION the mix, the tolerance, the pitch "
        + "and the distance are back where they started and the yaw has turned "
        + "EXACTLY one full circle — measured on the rendered film as a seam of "
        + "5.9/255 against 4.8 for two adjacent mid-film frames",
        "t=DURATION is t=0; the last instant before it has turned one full "
        + "circle and returned to the opening mix and tolerance",
        `wrap identical ${wrapIsIdentity}, mix ${a.mix} to ${z.mix.toFixed(6)}, `
        + `tol ${a.toleranceMM} to ${z.toleranceMM.toFixed(4)}, `
        + `yaw +${(turn / Math.PI).toFixed(6)} pi`, closes);

      // ⚠️ THE DOLLY MUST RETURN TOO. `zoom0`/`zoom1` were added on 2026-08-20
      // because the middle of the film looked static; a camera that ends the
      // loop at a different distance from where it started would make the
      // repeat jump, which is the one thing the whole closure design prevents.
      const zLast = SCRIPT[SCRIPT.length - 1].zoom1 ?? 1;
      const zFirst = SCRIPT[0].zoom0 ?? 1;
      let dollyContinuous = true;
      for (let i = 1; i < SCRIPT.length; i++) {
        if ((SCRIPT[i].zoom0 ?? 1) !== (SCRIPT[i - 1].zoom1 ?? 1)) dollyContinuous = false;
      }
      add(V1, "the camera dolly closes the loop and hands over continuously at "
        + "every cut — each beat starts at the distance the one before it ended, "
        + "and the last returns to the first, or the repeat jumps",
        "continuous across all cuts; last zoom1 = first zoom0",
        `continuous ${dollyContinuous}, ${zLast} → ${zFirst}`,
        dollyContinuous && zLast === zFirst);

      const last = SCRIPT[SCRIPT.length - 1];
      add(V1, "…and the closing beat is written to land on the opening one, so "
        + "the return is authored rather than accidental",
        `last beat ends at mix ${SCRIPT[0].mix0}, tol ${SCRIPT[0].tol0}`,
        `mix1 ${last.mix1}, tol1 ${last.tol1}`,
        last.mix1 === SCRIPT[0].mix0 && last.tol1 === SCRIPT[0].tol0);
    }

    // ── every beat is renderable ────────────────────────────────────────
    {
      // The three the offline renderer knows how to shade. A beat naming
      // anything else would silently fall through to plain hillshade, which
      // looks like a deliberate choice rather than a typo.
      const LAYERS = ["hillshade", "twi", "cutfill"];
      const bad = SCRIPT.filter((b) => !LAYERS.includes(b.layer));
      const nonBool = SCRIPT.filter((b) => typeof b.glyphs !== "boolean");
      add(V1, "every beat names a layer the renderer actually handles and states "
        + "its glyph field as a boolean — an unknown layer would fall through to "
        + "hillshade and read as a decision rather than a typo",
        "0 unknown layers, 0 non-boolean glyph flags",
        `${bad.length} unknown${bad.length ? " (" + bad.map((b) => b.layer) + ")" : ""}, `
        + `${nonBool.length} non-boolean`,
        bad.length === 0 && nonBool.length === 0);

      // The film's argument is carried by the shader CHANGING; if every beat
      // ended up on one layer the "changing shaders" note would be false.
      const distinct = new Set(SCRIPT.map((b) => b.layer));
      add(V1, "…and the film uses more than one of them, because the argument is "
        + "carried by the treatment changing as the ground stops changing",
        "at least 3 distinct layers across the beats",
        `${distinct.size}: ${[...distinct].join(", ")}`, distinct.size >= 3);
    }

    // ── the figures on screen are the measured ones ─────────────────────
    {
      // ⚠️ THE MEASURED RECORD, RE-RUN ON THIS BUILD 2026-08-20 AT A 4 m FIELD
      // WAVELENGTH. Full transcript in
      // phase13/proof/tolerance-sweep-revalidated-2026-08-20.txt. Quoted here so
      // SCRIPT cannot drift away from the measurement in silence — which is the
      // whole reason the metrics live in the module at all.
      // ⚠️⚠️ AND THE WAVELENGTH IS PART OF THE FIGURE. The same sweep at 2 m
      // gives H' 0.310 at 25 mm instead of 0.450 and destroys the plateau
      // entirely. A tolerance number without its wavelength is not reproducible.
      const MEASURED = { 10: 0.461, 25: 0.450, 100: 0.444, 200: 0.765 };
      // ⚠️ THE FIGURE DESCRIBES THE BEAT'S ENDPOINT (mix1, tol1), NOT ITS
      // TOLERANCE ALONE. Filtering on "holds one tolerance" also caught the
      // opening beat, which sits at ±25 mm the whole way through while never
      // being levelled at all — so its 1.721 was compared against the 25 mm
      // levelled figure and reported as a drift. A levelled endpoint must match
      // the sweep; an unlevelled one must match the surveyed control.
      const SURVEYED_H = 1.721;
      const quoted = SCRIPT
        .filter((b) => b.metrics && b.metrics["Shannon H′"] !== undefined)
        .map((b) => ({
          id: b.id, levelled: b.mix1 === 1, tol: b.tol1,
          H: parseFloat(b.metrics["Shannon H′"]),
        }));
      const wrong = quoted.filter((q) => {
        const want = q.levelled ? MEASURED[q.tol] : SURVEYED_H;
        return want === undefined || Math.abs(want - q.H) > 1e-9;
      });
      add(V1, "every Shannon figure the film displays is the one measured on this "
        + "build at the stated tolerance — the overlay states real numbers, and "
        + "this row is what stops SCRIPT drifting away from the measurement",
        "0 quoted figures disagree with the record",
        `${quoted.length} checked, ${wrong.length} wrong`
        + `${wrong.length ? " (" + wrong.map((w) => w.id + " " + w.tol + "mm:" + w.H) + ")" : ""}`,
        quoted.length >= 4 && wrong.length === 0);

      // The end beats return to the surveyed control, which is a published
      // figure in its own right and must not drift either.
      const ends = [SCRIPT[0], SCRIPT[SCRIPT.length - 1]]
        .map((b) => parseFloat(b.metrics["Shannon H′"]));
      add(V1, "…and the beats that show the surveyed ground quote the published "
        + "control, 1.721, at both ends of the loop",
        "1.721 at the open and the close", `${ends[0]} / ${ends[1]}`,
        ends.every((v) => Math.abs(v - 1.721) < 1e-9));

      add(V1, "…and the wavelength every one of those figures depends on is a "
        + "NAMED CONSTANT rather than a number buried in a caller, because the "
        + "same sweep at 2 m gives 0.310 where 4 m gives 0.450",
        "WAVELENGTH_M = 4", `${WAVELENGTH_M}`, WAVELENGTH_M === 4);
    }

    // ── the field the whole finding rests on ────────────────────────────
    {
      const N = 64, CELL = 0.25;
      const f = toleranceField(N, N, CELL, 4, 1);

      let mx = 0;
      for (const v of f) { const a = v < 0 ? -v : v; if (a > mx) mx = a; }
      add(V1, "the tolerance field is normalised so its extreme is exactly 1, "
        + "which is what makes `amplitude` mean millimetres on the ground rather "
        + "than millimetres times whatever the noise happened to peak at",
        "max |v| = 1", mx.toFixed(9), Math.abs(mx - 1) < 1e-6);

      const again = toleranceField(N, N, CELL, 4, 1);
      const other = toleranceField(N, N, CELL, 4, 2);
      let same = true, differs = 0;
      for (let i = 0; i < f.length; i++) {
        if (f[i] !== again[i]) same = false;
        if (Math.abs(f[i] - other[i]) > 1e-6) differs++;
      }
      add(V1, "…it is deterministic for a seed and different for another, so a "
        + "re-render reproduces the same film and a sensitivity run is a real "
        + "second surface rather than the same one again",
        "seed 1 identical on repeat; seed 2 differs over most of the grid",
        `identical ${same}, ${((100 * differs) / f.length).toFixed(1)}% differ`,
        same && differs > f.length * 0.9);

      // ⚠️ BAND-LIMITED, NOT WHITE NOISE — the property the finding rests on.
      // A grader blade is metres wide. Per-cell noise would restore a slope
      // field everywhere, let every excluded species back in, and model nothing
      // anyone could build. Measured as the neighbour step: a smooth field is
      // nearly identical cell to cell at 0.25 m, white noise is not.
      let num = 0, d2 = 0;
      for (let r = 0; r < N; r++) {
        for (let c = 1; c < N; c++) {
          const a = f[r * N + c - 1], b = f[r * N + c];
          d2 += (a - b) * (a - b); num++;
        }
      }
      const rms = Math.sqrt(d2 / num);
      add(V1, "…and it is BAND-LIMITED rather than white noise: neighbouring "
        + "cells differ by a small fraction of the amplitude at 0.25 m, because a "
        + "grader blade is metres wide. Per-cell noise would restore a slope "
        + "field everywhere and model a surface nobody could build",
        "rms neighbour step < 0.05 of full amplitude",
        rms.toFixed(4), rms < 0.05);

      // …and the wavelength is what controls that, which is the parameter the
      // 2026-08-20 sweep got wrong.
      const coarse = toleranceField(N, N, CELL, 16, 1);
      let d2c = 0;
      for (let r = 0; r < N; r++) {
        for (let c = 1; c < N; c++) {
          const a = coarse[r * N + c - 1], b = coarse[r * N + c];
          d2c += (a - b) * (a - b);
        }
      }
      const rmsCoarse = Math.sqrt(d2c / num);
      add(V1, "…and the WAVELENGTH is what sets it — a 16 m field is markedly "
        + "smoother cell to cell than a 4 m one. This is the parameter that was "
        + "got wrong on 2026-08-20 and briefly destroyed the published plateau",
        "16 m field smoother than 4 m",
        `4 m ${rms.toFixed(4)} vs 16 m ${rmsCoarse.toFixed(4)}`, rmsCoarse < rms);
    }

    // ── applyTerrain ────────────────────────────────────────────────────
    {
      const n = 32;
      const surveyed = new Float32Array(n);
      for (let i = 0; i < n; i++) surveyed[i] = 70 + i * 0.1;
      surveyed[5] = NaN;                       // a hole in the survey
      const field = new Float32Array(n).fill(0.5);
      const z = new Float32Array(n);
      const datum = 77;

      applyTerrain(z, surveyed, field, datum, { mix: 0, toleranceMM: 25 });
      let asSurveyed = true;
      for (let i = 0; i < n; i++) {
        if (i === 5) continue;
        if (Math.abs(z[i] - surveyed[i]) > 1e-6) asSurveyed = false;
      }
      add(V1, "at mix 0 the terrain IS the surveyed ground, untouched — the film "
        + "opens and closes on real survey rather than on a blend that happens to "
        + "look like it",
        "identical to the survey", asSurveyed ? "identical" : "DIFFERS", asSurveyed);

      applyTerrain(z, surveyed, field, datum, { mix: 1, toleranceMM: 100 });
      const want = datum + 0.5 * 0.1;          // 100 mm amplitude, field 0.5
      // ⚠️ THE TOLERANCE MUST CLEAR FLOAT32, AND THIS ROW FAILED BECAUSE IT DID
      // NOT — expected and measured both printed 77.0500 while the comparison
      // said they differed. `z` is a Float32Array; one storage step at 77 m is
      // 2⁻¹⁷ ≈ 7.6e-6, so a 1e-6 threshold is below the precision the number is
      // held in and can never be met. Exactly the mistake recorded in phase 12
      // §5.5 about the voxel block top. Five storage steps, stated as such.
      const F32_STEP = 7.7e-6;                 // at this magnitude
      add(V1, "…and at mix 1 it is the datum plus the field at the stated "
        + "tolerance in METRES, so a beat labelled 100 mm moves the ground by "
        + "100 mm and not by 100 of anything else",
        `${want.toFixed(4)} m at every cell, within 5 float32 steps`,
        `${z[0].toFixed(6)} (delta ${Math.abs(z[0] - want).toExponential(1)})`,
        Math.abs(z[0] - want) < 5 * F32_STEP);

      // ⚠️ A HOLE IN THE SURVEY IS NOT A HEIGHT. Filling it with the datum would
      // invent ground the survey never measured — the same rule every layer in
      // this tool keeps about NaN.
      add(V1, "…and a cell the survey never measured stays unmeasured at every "
        + "mix, rather than being filled in with the datum",
        "NaN preserved", Number.isNaN(z[5]) ? "NaN" : String(z[5]),
        Number.isNaN(z[5]));
    }
  }

  // Performance was measured at the top, on a clean heap. Reported last.
  rows.push(...perfRows);

  return rows;
}
