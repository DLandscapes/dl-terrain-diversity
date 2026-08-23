// @ts-check
// The non-local analysis, off the render thread.
//
// SPLIT (measured, see README): flow accumulation, TWI and the depression
// inventory need a full-grid pass and cost 26 ms in Chromium on the real
// 256x256 patch. Slope, aspect, TRI and the cut/fill ledger are local 3x3
// operators the main thread redoes over the ~800-cell dirty rect under the
// brush, on the SAME frame as the gesture. So the hand never waits, and the
// hydrology trails it by about one display frame.
//
// This worker owns its own copy of the DEM. The main thread posts only the
// patched rectangle (~3 KB), never the whole grid, and gets back four
// colourised RGBA panels plus the metrics as transferables (zero-copy).
//
// COLOURISATION HAPPENS HERE, not on the GPU. It already holds the float grids
// and the ramp table, four panels cost ~0.8 ms, and — the load-bearing reason —
// it keeps every colour convention inside analysis/ramps.js where the self-test
// can assert on it. See that file's header for what went wrong when a sibling
// project scattered its ramps.

import { DEM } from "./dem.js";
import { computeGradient } from "./analysis/horn.js";
import { flowAccumulation } from "./analysis/mfd.js";
import { twi, tri, findDepressions, geodiversityFromTRI } from "./analysis/indices.js";
import { colourise, colouriseClasses, percentileDomain } from "./analysis/ramps.js";
import { horizonMap, skyViewFactor, positiveOpenness, windExposure } from "./analysis/horizon.js";
import { solarRadiation } from "./analysis/solar.js";
import { geomorphons } from "./analysis/geomorphons.js";
import { watersheds, colouriseBasins } from "./analysis/watershed.js";
import { assemble, SPECIES, SHANNON_MAX } from "./analysis/species.js";

/** @type {DEM | null} */
let dem = null;
/** Pristine elevations at load, for the cut/fill panel. */
let baseZ = null;
/**
 * The float grids behind the last pass, kept for export.
 *
 * The panels the main thread receives are RGBA — a picture of the analysis, at
 * 8 bits per channel through a percentile stretch. Exporting those into a GIS
 * would hand someone a colour image to measure, which is precisely the kind of
 * plausible-looking lie ramps.js exists to prevent. So export sends the VALUES,
 * and they are served from here on request rather than shipped on every pass:
 * nine grids is 2.4 MB per settle that nothing would read.
 * @type {Record<string, Float32Array>|null}
 */
let lastGrids = null;
/**
 * How the main thread wants the layers COLOURED — percentile cuts per layer
 * and palette variant per layer. Colour choices live here rather than on the
 * main thread because colourisation itself does, and splitting them would give
 * the panel and the 3D surface two different ideas of the same layer.
 * @type {{stretch: Record<string, number[]>, variant: Record<string, string>}}
 */
let view = { stretch: {}, variant: {} };
/**
 * Landform classes from the last settled pass, as the Uint8 codes the species
 * model wants. lastGrids.geomorphon holds the same thing widened to float32 for
 * the export writer; keeping the codes as well avoids converting back every
 * pass, and avoids the species layer inheriting the NaN-for-255 substitution
 * that widening introduces.
 * @type {Uint8Array|null}
 */
let lastLandform = null;
/**
 * The grids only a settle pass produces. A light pass must carry them forward
 * unchanged rather than dropping them — see where lastGrids is rebuilt.
 */
const SETTLE_GRIDS = ["svf", "openness", "solar", "wind", "geomorphon"];
/**
 * The substrate map, already widened to float32 with NaN for "unknown".
 *
 * ⚠️ THE WORKER DOES NOT OWN THIS GRID and never computes it. The main thread
 * owns it, because the substrate brush edits it and a paint stroke has to show
 * on the same frame as the hand — a round trip would make painting feel dead.
 * The worker holds a copy for one reason only: so the export path, which pulls
 * every layer from `lastGrids`, needs no special case for the one layer that
 * did not come from elevation.
 * @type {Float32Array|null}
 */
let substrateGrid = null;
/**
 * The same map as CLASS CODES, kept beside the float32 one.
 *
 * ⚠️ THE SPECIES MODEL CANNOT USE `substrateGrid`. That one is widened to
 * float32 with NaN for unknown because the export writer deals in float rasters
 * — but `assemble` indexes a per-class lookup table, and NaN is not an index.
 * Two representations of one map, for two consumers, and neither is redundant.
 * @type {Uint8Array|null}
 */
let substrateCodes = null;
/**
 * The period solar radiation integrates over, as days of year.
 *
 * Adjustable because at 69.7°N the answer changes CHARACTER with the season,
 * not just magnitude: over the growing season a south flank gets 1.32x a north
 * one, but around the equinoxes the sun barely clears the horizon and terrain
 * shadowing dominates everything, while at the solstice the midnight sun lights
 * north-facing ground that receives nothing at all in March. A single
 * Apr–Sep figure hides all of that. Default is the growing season.
 */
let solarPeriod = [91, 273];

/** The percentile cuts for a layer: the user's, or the layer's own default. */
/**
 * A domain for ground that has no relief: one metre either side of the single
 * value it holds, so it renders at the RAMP'S MIDPOINT rather than at an end.
 *
 * Mid-ramp is the honest picture of "one elevation everywhere". An end would say
 * "as high as it gets" or "as low as it gets", neither of which is true of a
 * plane, and both of which look like a fault.
 * @param {Float32Array} z
 */
function flatDomain(z) {
  for (let i = 0; i < z.length; i++) {
    if (Number.isFinite(z[i])) return [z[i] - 1, z[i] + 1];
  }
  return undefined;   // all nodata; colourise will paint "no answer"
}

function cuts(key, lo, hi) {
  const s = view.stretch[key];
  return s ? [s[0], s[1]] : [lo, hi];
}

/**
 * @param {number} seq
 * @param {boolean} wantPanels
 * @param {boolean} [heavy] also compute sky-view factor, openness and solar
 */
function runPass(seq, wantPanels, heavy = false) {
  if (!dem) return;
  const t0 = performance.now();

  const gradient = computeGradient(dem);
  const flow = flowAccumulation(dem);
  const twiGrid = twi(flow.specificCatchmentArea, gradient.slope);
  const triGrid = tri(dem);
  const depressions = findDepressions(dem);

  // Δz against the pristine surface — this is the cut/fill map, and its sign
  // convention is pinned in ramps.js: positive (fill) renders warm.
  const n = dem.z.length;
  const delta = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = dem.z[i], b = baseZ ? baseZ[i] : NaN;
    delta[i] = Number.isFinite(a) && Number.isFinite(b) ? a - b : NaN;
  }

  let slopeSum = 0, slopeN = 0;
  for (const v of gradient.slopeDeg) if (Number.isFinite(v)) { slopeSum += v; slopeN++; }
  let triSum = 0, triN = 0;
  for (const v of triGrid) if (Number.isFinite(v)) { triSum += v; triN++; }
  let twiValid = 0;
  for (const v of twiGrid) if (Number.isFinite(v)) twiValid++;

  // computeGradient already yields aspect in DEGREES (0 = N, clockwise) with
  // NaN where the ground is flat. That NaN is carried straight to the ramp
  // untouched, so a levelled surface can never render as north-facing — the
  // trap documented in planning/02 §6.
  const aspectDeg = gradient.aspectDeg;

  let caMax = 0;
  for (const v of flow.contributingArea) if (Number.isFinite(v) && v > caMax) caMax = v;

  const metrics = {
    slopeMeanDeg: slopeN > 0 ? slopeSum / slopeN : NaN,
    triMean: triN > 0 ? triSum / triN : NaN,
    catchmentMax: caMax,
    storageVolume: depressions.totalVolume,
    depressionCount: depressions.depressions.length,
    geodiversity: geodiversityFromTRI(triGrid),
    twiValidFraction: n > 0 ? twiValid / n : 0,
  };

  lastGrids = {
    slope: gradient.slopeDeg,
    aspect: gradient.aspectDeg,
    twi: twiGrid,
    catchment: flow.contributingArea,
    cutfill: delta,
    depression: depressions.depth,
    tri: triGrid,
    elevation: dem.z,
    // Carry EVERY settle-only grid across a light pass, not just three of them.
    // Two reasons, and the second is why the list is now derived rather than
    // typed out: an export taken while a gesture was still in flight silently
    // lacked wind.tif and geomorphon.tif, and — once the species model started
    // reading these — dropping wind between passes changed the number of axes
    // it aggregates over, so the assemblage rearranged itself every other frame.
    ...(lastGrids ? Object.fromEntries(
      SETTLE_GRIDS.filter((k) => lastGrids[k]).map((k) => [k, lastGrids[k]])) : {}),
  };

  /** @type {any} */
  const msg = { type: "result", seq, metrics, ms: 0, heavy };
  /** @type {ArrayBuffer[]} */
  const transfer = [];

  if (wantPanels) {
    // Depression depth below spill point — the "closed depressions" layer.
    // Every standard hydrology workflow fills these on sight; here they are the
    // whole point, so they get a map of their own. findDepressions already
    // returns exactly this grid (filled − z, zero outside depressions), so use
    // it rather than reconstructing it from the labels.
    const depth = depressions.depth;

    // Each sequential layer is stretched to its own data. Aspect is NOT — it is
    // a compass bearing, and 0–360 is its meaning, not a display choice.
    // Cut/fill is stretched symmetrically so zero stays exactly on the neutral
    // stop and untouched ground cannot drift to a faint colour.
    // Domains are computed once and reported alongside the pixels, so the
    // legend shows the range the image was actually stretched to rather than a
    // nominal one.
    // Contributing area in LOG10(m²). The quantity spans four orders of
    // magnitude on this patch — one cell's own 0.0625 m² on a ridge against
    // thousands at the outlet — so a linear stretch puts every hillslope in
    // the first swatch and shows nothing but the channel. Logging it is what
    // makes the drainage network legible as a network. Cells with no upslope
    // area at all would be log(0); they take the smallest representable value
    // rather than NaN, because "nothing drains through here" is an answer.
    const logCatchment = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = flow.contributingArea[i];
      logCatchment[i] = Number.isFinite(a) ? Math.log10(Math.max(a, 1e-6)) : NaN;
    }

    // Each layer's own default cuts, which the user's handles may override.
    // Aspect is NOT stretched — it is a compass bearing, and 0–360 is its
    // meaning, not a display choice, so it has no handles either.
    const dom = {
      slope: percentileDomain(gradient.slopeDeg, ...cuts("slope", 0.02, 0.98), { floorAtZero: true }),
      aspect: [0, 360],
      twi: percentileDomain(twiGrid, ...cuts("twi", 0.02, 0.98)),
      catchment: percentileDomain(logCatchment, ...cuts("catchment", 0.02, 0.995)),
      cutfill: percentileDomain(delta, ...cuts("cutfill", 0.01, 0.99), { symmetric: true }),
      // Ruggedness is strongly right-skewed — most of a graded surface really is
      // smooth, and the signal lives in the breaks of slope. Stretching to the
      // 98th percentile therefore spends most of the ramp on values almost no
      // cell has. Cut at the 90th so the common range gets the colour.
      tri: percentileDomain(triGrid, ...cuts("tri", 0.02, 0.90), { floorAtZero: true }),
      depression: percentileDomain(depth, ...cuts("depression", 0, 0.995), { floorAtZero: true }),
      // ⚠️ STRETCHED, NEVER FIXED. A site's elevation range is whatever the
      // site's is — 75.85–81.16 m here, some other five metres somewhere else,
      // and a dropped tile could be anywhere at all. A fixed domain would paint
      // most sites one flat colour, which is the trap Phase 3 already recorded
      // for solar. Cut narrowly, at 1/99: elevation has no long tail to protect
      // against, and a wider cut throws away contrast the site actually has.
      // ⚠️ AND A FALLBACK FOR GROUND WITH NO RELIEF AT ALL, which every other
      // layer here gets for free and elevation cannot. The others declare a
      // physically meaningful default domain — slope 0–35°, TWI 2–14 — so a
      // constant grid still lands somewhere sensible on the ramp. Elevation has
      // no universal range, so its declared domain is a placeholder and the
      // percentile stretch is the real one; when the stretch is unavailable,
      // that placeholder took over and a flat plane at 75 m clamped to the top
      // of the ramp and rendered as a solid dark slab. Centred on the value
      // instead, it renders mid-ramp — which is what "one elevation, no
      // variation" should look like. The workshop's teaching tile is exactly
      // this case, and so is any perfectly levelled surface.
      elevation: percentileDomain(dem.z, ...cuts("elevation", 0.01, 0.99))
        ?? flatDomain(dem.z),
    };
    const V = (k) => view.variant[k];
    const panels = {
      elevation: colourise("elevation", dem.z, dom.elevation, V("elevation")),
      slope: colourise("slope", gradient.slopeDeg, dom.slope, V("slope")),
      aspect: colourise("aspect", aspectDeg, undefined, V("aspect")),
      twi: colourise("twi", twiGrid, dom.twi, V("twi")),
      catchment: colourise("catchment", logCatchment, dom.catchment, V("catchment")),
      cutfill: colourise("cutfill", delta, dom.cutfill, V("cutfill")),
      tri: colourise("tri", triGrid, dom.tri, V("tri")),
      depression: colourise("depression", depth, dom.depression, V("depression")),
    };
    msg.panels = panels;
    msg.domains = dom;
    for (const k of Object.keys(panels)) transfer.push(panels[k].buffer);
  }

  // The expensive layers. Horizon tracing is O(cells x directions x steps), so
  // these run only when a gesture settles — never mid-drag. Sky-view factor is
  // also sent back raw, because the surface uses it for ambient occlusion.
  if (heavy) {
    const hz = horizonMap(dem);
    const svf = skyViewFactor(hz);
    const openness = positiveOpenness(hz);
    // A short period needs a finer day step, or a fortnightly sample can miss
    // it entirely — "Solstice · 21 Jun" is a single day, where dayStep 14 would
    // integrate nothing at all and render a blank layer.
    const span = solarPeriod[1] - solarPeriod[0];
    const dayStep = span <= 3 ? 1 : span <= 45 ? 3 : span <= 120 ? 7 : 14;
    // The latitude comes from the RASTER, not from this tool's home site.
    // approxLatitudeDeg() returns null for grids it cannot derive one from
    // (non-UTM, or no CRS in the file), and solarRadiation then falls back
    // to its own documented default rather than being handed a guess.
    const latitudeDeg = dem.approxLatitudeDeg?.() ?? undefined;
    const sun = solarRadiation(dem, gradient, hz, {
      dayStart: solarPeriod[0], dayEnd: solarPeriod[1], dayStep,
      ...(latitudeDeg === undefined ? {} : { latitudeDeg }),
    });
    // Keep the settle-only grids for export. svf's own buffer is transferred to
    // the main thread below (it doubles as ambient occlusion), so this holds a
    // copy rather than a reference that is about to be detached.
    lastGrids.svf = svf.slice();
    lastGrids.openness = openness;
    lastGrids.solar = sun.grid;

    // Wind exposure rides on the horizon map that svf and openness already
    // paid for, so it costs a pass over the grid rather than another trace.
    const wind = windExposure(hz);
    // Geomorphons trace their own eight rays — ~45 ms at the tuned radius, far
    // too slow for a drag, unremarkable inside a settle that already spends
    // ~430 ms on horizon work.
    const gm = geomorphons(dem, { radiusM: 1.5, flatnessDeg: 3 });
    // ⚠️ D8 here, MFD everywhere else — a basin is a partition and a partition
    // needs one receiver per cell. See analysis/watershed.js. ~11 ms, so it
    // rides the settle pass rather than needing one of its own.
    const ws = watersheds(dem);
    lastLandform = gm.codes;

    const hdom = {
      svf: percentileDomain(svf, ...cuts("svf", 0.02, 0.98)),
      openness: percentileDomain(openness, ...cuts("openness", 0.02, 0.98)),
      solar: percentileDomain(sun.grid, ...cuts("solar", 0.02, 0.98)),
      wind: percentileDomain(wind, ...cuts("wind", 0.02, 0.98)),
    };
    msg.heavy = {
      svfGrid: svf,
      domains: hdom,
      panels: {
        svf: colourise("svf", svf, hdom.svf, view.variant.svf),
        openness: colourise("openness", openness, hdom.openness, view.variant.openness),
        solar: colourise("solar", sun.grid, hdom.solar, view.variant.solar),
        wind: colourise("wind", wind, hdom.wind, view.variant.wind),
        // Classes, not a continuum — no domain, no stretch.
        geomorphon: colouriseClasses("geomorphon", gm.codes),
        // ⚠️ Its OWN colouriser, not colouriseClasses. Basin ids are nominal
        // and unbounded — 917 of them on this patch — so there is no authored
        // colour table to index. See analysis/watershed.js.
        watershed: colouriseBasins(ws.basin),
      },
      sun: { positions: sun.sunPositions, meanAltDeg: sun.meanAltDeg, maxAltDeg: sun.maxAltDeg,
             dayStart: solarPeriod[0], dayEnd: solarPeriod[1], dayStep },
      basins: {
        count: ws.count, micro: ws.micro, minCells: ws.minCells,
        dominance: ws.dominance, largest: ws.areas[0] ?? 0,
      },
      landform: {
        counts: Array.from(gm.counts),
        radiusM: gm.radiusM,
        flatnessDeg: gm.flatnessDeg,
      },
    };
    lastGrids.wind = wind;
    // Codes are Uint8; export writes float32 rasters, so widen once here
    // rather than making the export path know about class rasters.
    const gmF = new Float32Array(gm.codes.length);
    for (let i = 0; i < gm.codes.length; i++) {
      gmF[i] = gm.codes[i] === 255 ? NaN : gm.codes[i];
    }
    lastGrids.geomorphon = gmF;
    transfer.push(svf.buffer);
    for (const k of Object.keys(msg.heavy.panels)) transfer.push(msg.heavy.panels[k].buffer);

    // Landform diversity, the categorical sibling of geodiversity: Shannon
    // evenness over the ten classes. A planarized surface collapses to a
    // single class and reads 0, which is the same collapse the TRI-based
    // geodiversity reports — two independent measures of the same loss.
    let h = 0, tot = 0, occupied = 0;
    for (const c of gm.counts) tot += c;
    for (const c of gm.counts) {
      if (c === 0) continue;
      occupied++;
      const p = c / tot;
      h -= p * Math.log(p);
    }
    metrics.landformDiversity = occupied > 1 ? h / Math.log(gm.counts.length) : 0;
    metrics.landformClasses = occupied;

    let sMin = Infinity, sMax = -Infinity, sSum = 0, sN = 0;
    for (const v of sun.grid) if (Number.isFinite(v)) { if (v < sMin) sMin = v; if (v > sMax) sMax = v; sSum += v; sN++; }
    metrics.solarMin = sMin; metrics.solarMax = sMax; metrics.solarMean = sN ? sSum / sN : NaN;
    let oSum = 0, oN = 0;
    for (const v of svf) if (Number.isFinite(v)) { oSum += v; oN++; }
    metrics.svfMean = oN ? oSum / oN : NaN;
  }

  // ------------------------------------------------------------- the biotic layer
  //
  // Runs on EVERY pass, not only on settle, because the whole force of the tool
  // is that the habitat readout moves while the hand is still moving. It costs
  // ~8 ms on this grid, which fits inside the interactive budget alongside the
  // hydrology.
  //
  // It is fed FRESH twi and slope with the LAST SETTLED solar, wind and landform
  // — the same staleness convention the surface's ambient occlusion already
  // uses. That is sound here because the two axes carrying the collapse are the
  // live ones: measured on the real patch, planarizing takes the assemblage from
  // H' 1.720 to 0.499 with stale heavy grids in hand, and the following settle
  // finishes it at 0.029. The number falls during the gesture and lands on
  // release, rather than doing nothing and then jumping.
  const bio = assemble({
    twi: twiGrid, slope: gradient.slopeDeg, cell: dem.cell, elevation: dem.z,
    solar: lastGrids.solar || null,
    wind: lastGrids.wind || null,
    landform: lastLandform,
    // The sixth axis, present only when a substrate map is — see the note in
    // species.js. With none loaded this is null and k stays at 5, so every
    // published figure reproduces exactly.
    soil: substrateCodes,
  });
  metrics.shannon = bio.shannon;
  metrics.shannonMax = SHANNON_MAX;
  metrics.richness = bio.richness;
  metrics.speciesTotal = SPECIES.length;
  metrics.invasiveFraction = bio.invasiveFraction;
  metrics.bareFraction = (bio.bare + bio.classified) > 0
    ? bio.bare / (bio.bare + bio.classified) : 0;

  // Codes are Uint8 with 254 = bare and 255 = nodata; the export writer deals
  // in float32, so widen once here rather than teaching it about class rasters.
  const spF = new Float32Array(bio.codes.length);
  for (let i = 0; i < bio.codes.length; i++) {
    spF[i] = bio.codes[i] >= 254 ? NaN : bio.codes[i];
  }
  lastGrids.species = spF;
  lastGrids.suitability = bio.suitability;
  // Carried, never computed — see the declaration. Re-attached every pass
  // because lastGrids is rebuilt wholesale.
  if (substrateGrid && substrateGrid.length === n) lastGrids.soil = substrateGrid;

  if (wantPanels) {
    if (!msg.panels) msg.panels = {};
    msg.panels.species = colouriseClasses("species", bio.codes);
    transfer.push(msg.panels.species.buffer);
  }
  msg.assemblage = {
    counts: Array.from(bio.counts),
    bare: bio.bare,
    classified: bio.classified,
    // The class raster itself, for the 3D scatter. Transferred, not copied:
    // 64 KB a pass would otherwise be the largest thing crossing this boundary.
    // Safe to give away because lastGrids.species is a separate widened copy
    // and bio.codes is freshly allocated each pass.
    codes: bio.codes,
  };
  transfer.push(bio.codes.buffer);

  msg.ms = performance.now() - t0;
  // @ts-ignore - worker global
  self.postMessage(msg, transfer);
}

// @ts-ignore - worker global
self.onmessage = (e) => {
  const m = e.data;

  if (m.type === "init") {
    // ⚠️ BOTH of these must be INDEPENDENT copies. `m.z` is an ArrayBuffer, so
    // `new Float32Array(m.z)` is a VIEW over it, not a copy — writing the live
    // surface would then also overwrite the baseline, and Δz would be exactly
    // zero forever. That failed in the most plausible way possible: the cut/fill
    // panel rendered a uniform neutral tone, which reads as "nothing has been
    // edited yet" rather than as a bug. Caught only by painting and checking a
    // pixel; Group I now pins it.
    const incoming = new Float32Array(m.z);
    dem = new DEM(
      incoming.slice(), m.nrows, m.ncols, m.cell, m.originX, m.originY, m.name);
    dem.epsg = m.epsg ?? null;
    baseZ = incoming.slice();
    runPass(m.seq ?? 0, true, true);
    return;
  }

  if (m.type === "patch") {
    if (!dem) return;
    // Write the changed rectangle into our own copy. Row-major, inclusive.
    const { r0, c0, r1, c1 } = m.rect;
    const vals = new Float32Array(m.values);
    const w = c1 - c0 + 1;
    for (let r = r0; r <= r1; r++) {
      const src = (r - r0) * w;
      const dst = r * dem.ncols + c0;
      for (let c = 0; c < w; c++) dem.z[dst + c] = vals[src + c];
    }
    runPass(m.seq, m.wantPanels !== false, m.heavy === true);
    return;
  }

  if (m.type === "substrate") {
    // Codes in, float32 out: the export writer deals in float rasters, so widen
    // once here rather than teaching it about class rasters — the same
    // treatment geomorphons and species already get.
    //
    // ⚠️ Validated against the CURRENT dem. The worker is recreated per tile and
    // a substrate grid belongs to the DEM it was resampled onto; a stale one of
    // the wrong length is dropped rather than exported against the wrong
    // georeferencing.
    if (!dem) return;
    const codes = m.codes ? new Uint8Array(m.codes) : null;
    if (!codes || codes.length !== dem.z.length) {
      substrateGrid = null;
      substrateCodes = null;
      if (lastGrids) delete lastGrids.soil;
      // Losing the map removes the sixth axis, which changes the assemblage
      // just as gaining it does — so this needs a pass too, not just a clear.
      runPass(m.seq, true, false);
      return;
    }
    const f = new Float32Array(codes.length);
    for (let i = 0; i < codes.length; i++) f[i] = codes[i] >= 255 ? NaN : codes[i];
    substrateGrid = f;
    substrateCodes = codes;
    if (lastGrids) lastGrids.soil = f;
    // ⚠️ RECOMPUTE. Until substrate became the sixth species axis this handler
    // only stored the map, because nothing downstream read it — which is
    // exactly why painting bedrock changed the panel and left the vegetation
    // standing on it. A substrate edit is now a change to the model's inputs
    // and has to be answered like any other.
    runPass(m.seq, true, false);
    return;
  }

  if (m.type === "solar") {
    // Changing the period changes the NUMBERS, not just their colours, so this
    // cannot go down the recolour path — it needs a full settle pass.
    solarPeriod = m.period;
    if (dem) runPass(m.seq ?? 0, true, true);
    return;
  }

  if (m.type === "view") {
    // Re-colour from the grids already in hand. Dragging a stretch handle must
    // not re-run flow accumulation and horizon tracing — the numbers have not
    // changed, only the mapping from number to colour, and a settle pass per
    // drag frame would make the handle feel broken.
    view = {
      stretch: m.stretch || {},
      variant: m.variant || {},
    };
    if (!lastGrids || !dem) return;
    const t0 = performance.now();
    const panels = {}, domains = {};
    const opt = {
      slope: { floorAtZero: true }, tri: { floorAtZero: true },
      depression: { floorAtZero: true }, cutfill: { symmetric: true },
    };
    // ⚠️ THIS TABLE IS THE THIRD COPY OF THE SAME DEFAULTS, and it is what makes
    // adding a layer a three-place edit that fails silently in two of them. The
    // others are app.js's DEFAULT_CUTS, which decides whether a layer gets
    // handles at all, and the arguments to cuts() in the main pass above. Add a
    // layer to one and it stretches on the first pass but not when a handle is
    // dragged; add it to two and the handles never appear. Elevation was missing
    // here and in DEFAULT_CUTS, so its ramp had no handles and no recolour.
    const DEFAULTS = {
      elevation: [0.01, 0.99],
      slope: [0.02, 0.98], twi: [0.02, 0.98], catchment: [0.02, 0.995],
      cutfill: [0.01, 0.99], tri: [0.02, 0.90], depression: [0, 0.995],
      svf: [0.02, 0.98], openness: [0.02, 0.98], solar: [0.02, 0.98],
      wind: [0.02, 0.98],
    };
    for (const k of Object.keys(DEFAULTS)) {
      let g = lastGrids[k];
      if (!g) continue;
      // Catchment is held linear for export but coloured in log10 — see the
      // note where it is built. Recompute the log view rather than storing a
      // second grid that could drift from the first.
      if (k === "catchment") {
        const l = new Float32Array(g.length);
        for (let i = 0; i < g.length; i++) {
          l[i] = Number.isFinite(g[i]) ? Math.log10(Math.max(g[i], 1e-6)) : NaN;
        }
        g = l;
      }
      // Same flat-ground fallback the main pass uses — see flatDomain. Without
      // it here, re-colouring a constant layer drops its domain and the ramp
      // jumps to an end, which on the teaching plane is every layer until the
      // first gesture.
      const d = percentileDomain(g, ...cuts(k, ...DEFAULTS[k]), opt[k])
        ?? (k === "elevation" ? flatDomain(g) : undefined);
      domains[k] = d;
      panels[k] = colourise(k, g, d, view.variant[k]);
    }
    if (lastGrids.aspect) panels.aspect = colourise("aspect", lastGrids.aspect, undefined, view.variant.aspect);
    // @ts-ignore - worker global
    self.postMessage({ type: "recolour", seq: m.seq ?? 0, panels, domains,
      ms: performance.now() - t0 },
      Object.values(panels).map((p) => /** @type {Uint8ClampedArray} */ (p).buffer));
    return;
  }

  if (m.type === "grids") {
    // Copies, not transfers: the worker keeps computing with these every pass.
    /** @type {any} */
    const grids = {};
    for (const k of Object.keys(lastGrids || {})) grids[k] = lastGrids[k].slice();
    // @ts-ignore - worker global
    self.postMessage({ type: "grids", seq: m.seq ?? 0, grids },
      Object.values(grids).map((g) => /** @type {Float32Array} */ (g).buffer));
    return;
  }

  if (m.type === "reset") {
    // Restore the pristine surface without refetching — the demo timeline
    // needs frame 0 of take 7 to be identical to frame 0 of take 1.
    if (dem && baseZ) dem.z.set(baseZ);
    runPass(m.seq ?? 0, true, true);
    return;
  }
};
