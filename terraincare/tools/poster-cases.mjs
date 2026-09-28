// @ts-check
// THE SIX CASES, REPRODUCED HEADLESS — and CHECKED against the sheet's own
// published figures before anything is drawn from them.
//
// Marc, 2026-09-04, on the final sheet: the analysis rasters become proportional
// symbols, three attributes rather than twelve, grayscale. That means redrawing
// every case figure — and a redraw is only honest if it is the SAME GROUND the
// sheet's numbers were measured on.
//
// ⚠️⚠️ THE CASE SURFACES WERE NEVER SAVED. The 2026-08-27 sheet's figures were
// produced in the browser and only the PNGs survive; no script in the tree
// rebuilds them. So they are reproduced here from the parameters the sheet
// STATES on its own face — and then verified against the values it PUBLISHES.
// If a reproduction is wrong, the figures would show one ground while the
// numbers beside them described another, and nothing on the sheet would look
// broken. That is the failure this file exists to make impossible.
//
// ⚠️ THE CHECK IS THE POINT, NOT THE DRAWING. `--verify` measures and compares;
// it draws nothing. Every published figure has to land inside its tolerance
// before the circle fields are generated at all.
//
// The six, as the sheet states them:
//   1 As surveyed          no gesture
//   2 Levelled platform    level to the region's own mean, 65.53 m, 6,144 cells
//   3 Terraced, uniform    one interval, 1.615 m, matched to case 4's volume
//   4 Terraced by landform an interval per landform unit, the SAME 1,144 m3
//   5 Steep ground only    slope >= 36 deg, terraced there and nowhere else
//   6 Pit and mound        a stamped pattern, 8 m wavelength
//
// Usage:
//   node tools/poster-cases.mjs --verify
//
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { DEM } from "../static/dem.js";
import { loadGeoTIFF } from "../static/geotiff.js";
import { measureSurface, compareAt, EXPERIMENT } from "../static/compare.js";
import { benchTo } from "../static/bench.js";
import { computeGradient } from "../static/analysis/horn.js";
import { geomorphons, LANDFORMS } from "../static/analysis/geomorphons.js";
import { landformPatches, benchByPatch } from "../static/patches.js";

const TILE = "orndalen_poi_025m.tif";

/**
 * ⚠️⚠️ THE SHEET'S ROW IS targetTread = 4 m, AND THAT WAS FOUND BY SEARCH, NOT
 * ASSUMED. The experiment runs five treads; only one reproduces what the sheet
 * publishes, and at 4 m EVERY stated figure lands exactly — 4,733 patches, 101
 * benched, 1,144 m3, uniform interval 1.615 m, and both cases' geodiversity,
 * hollows and peak outfall to the digit. At 2 m the same gesture gives 699 m3
 * and geodiversity 0.7854, which would have been a perfectly plausible-looking
 * wrong sheet.
 */
const SHEET_TREAD = 4;

export function poiPatch() {
  const b = readFileSync(join(process.cwd(), "..", "data", "orndalen", TILE));
  return DEM.fromRaw(loadGeoTIFF(
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), { name: TILE }));
}

/**
 * ⚠️ WHAT THE 2026-08-27 SHEET PUBLISHES, quoted so the check has something to
 * fail against. Not targets to tune toward — a reproduction that misses them is
 * a DIFFERENT GROUND, and figures drawn from it would show one hillside while
 * the numbers beside them described another.
 */
export const PUBLISHED = {
  "c1-surveyed": { geodiversity: 0.6925, hollows: 235 },
  "c3-uniform": { geodiversity: 0.6943, hollows: 151, outfall: 73.84 },
  "c4-landform": { geodiversity: 0.8130, hollows: 498, outfall: 14.29 },
  "c5-attribute": { hollows: 287, volume: 136 },
};

export function buildCases() {
  const base = poiPatch();
  const out = [];
  out.push({ id: "c1-surveyed", n: 1, label: "As surveyed", dem: base });

  // ⚠️ ONE CALL GIVES BOTH 3 AND 4, and it must: case 3's interval is SEARCHED
  // to match case 4's volume, so building them separately would decouple the
  // pair that the whole comparison rests on.
  const r = compareAt(base, SHEET_TREAD);
  if (!r) throw new Error("compareAt returned nothing at tread " + SHEET_TREAD);

  // compareAt measures but does not hand back the surfaces, so the two gestures
  // are re-applied here with its own reported interval — the uniform one is the
  // only one that needs it, and it is exact.
  const d3 = base.clone();
  benchTo(d3, new Uint8Array(base.nrows * base.ncols).fill(1), {
    interval: r.uniformInterval, tread: EXPERIMENT.treadShare, bias: EXPERIMENT.bias,
  });
  out.push({ id: "c3-uniform", n: 3, label: "Terraced, uniform", dem: d3,
    interval: r.uniformInterval, volume: r.volume });

  /**
   * ⚠️ CASE 4 IS REBUILT THE WAY `compareAt` BUILDS IT INTERNALLY, because that
   * function measures the surface and then discards it. The call below is a
   * line-for-line match of its own — the same geomorphons, the same patch
   * partition restricted to codes 0-9, the same bench parameters — so the
   * surface here is the one whose figures it reported.
   *
   * ⚠️ `only` EXCLUDES 255. Number.isFinite(255) is true, so without the
   * restriction the holes in a survey are partitioned and benched as if
   * "unknown" were a landform. compareAt's own note records this.
   */
  const gm = geomorphons(base);
  const grad = computeGradient(base);
  const only = LANDFORMS.map((_, code) => code);
  const { labels, patches } = landformPatches(base, gm.codes, {
    slopeDeg: grad.slopeDeg, aspectDeg: grad.aspectDeg, only,
  });
  const d4 = base.clone();
  const r4 = benchByPatch(d4, labels, patches, {
    targetTread: SHEET_TREAD, tread: EXPERIMENT.treadShare, bias: EXPERIMENT.bias,
    minCells: EXPERIMENT.minCells,
    minInterval: EXPERIMENT.minInterval, maxInterval: EXPERIMENT.maxInterval,
  });
  out.push({ id: "c4-landform", n: 4, label: "Terraced by landform", dem: d4,
    volume: (r4.cut || 0) + (r4.fill || 0), patchCount: patches.length,
    patchesBenched: r4.patchesBenched });

  // ── 5: the same terracing, only where a RULE selects ─────────────────────
  // "Selected by attribute — slope >= 36 deg, the steepest fifth of the hill"
  const g = computeGradient(base);
  const mask = new Uint8Array(base.nrows * base.ncols);
  let steep = 0;
  for (let i = 0; i < mask.length; i++) if (g.slopeDeg[i] >= 36) { mask[i] = 1; steep++; }
  /**
   * ⚠️⚠️ CASE 5 DOES NOT USE CASE 3'S INTERVAL, and assuming it did is what made
   * the first reproduction wrong — it gave 360 hollows against the published
   * 287. The sheet does not state case 5's interval; it states the CONSEQUENCES,
   * 136 m3 moved and 287 hollows left. Sweeping the interval against those two
   * figures lands on 0.95 m, where the volume is 136.4 m3 and the hollow count
   * is 287 exactly — both, at one value. Neighbouring intervals hit one or the
   * other but not the pair.
   */
  const C5_INTERVAL = 0.95;
  const d5 = base.clone();
  const r5 = benchTo(d5, mask, {
    interval: C5_INTERVAL, tread: EXPERIMENT.treadShare, bias: EXPERIMENT.bias,
  });
  out.push({ id: "c5-attribute", n: 5, label: "Steep ground only", dem: d5,
    interval: C5_INTERVAL, volume: (r5.cut || 0) + (r5.fill || 0),
    steepCells: steep, steepShare: steep / mask.length });

  out.sort((x, y) => x.n - y.n);
  return { cases: out, row: r };
}

/**
 * ⚠️⚠️ THIS BLOCK USED TO RUN ON IMPORT. tools/morph-states.mjs imports
 * poiPatch and PUBLISHED from here, so `node tools/morph-states.mjs --verify`
 * executed THIS file's verification instead, printed four cases that looked
 * entirely correct, and called process.exit before the caller's own main ever
 * ran. Nothing errored. A CLI in a module that is also a library has to know
 * whether it is the entry point.
 */
const IS_MAIN = !!process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN && process.argv.includes("--verify")) {
  const { cases, row } = buildCases();
  console.log("REPRODUCING THE CASES ON " + TILE + " at targetTread " + SHEET_TREAD + " m\n");
  console.log("  experiment row: patches " + row.patchCount + " · benched "
    + row.patchesBenched + " · volume " + row.volume.toFixed(0) + " m3 · uniform interval "
    + row.uniformInterval.toFixed(3) + " m\n");
  let bad = 0;
  for (const c of cases) {
    const m = measureSurface(c.dem);
    const p = PUBLISHED[c.id];
    console.log("  " + c.id.padEnd(14) + " geodiv " + m.geodiversity.toFixed(4)
      + "  hollows " + String(m.hollows).padStart(4)
      + "  outfall " + m.peakOutfall.toFixed(2)
      + (c.volume != null ? "  vol " + c.volume.toFixed(0) + " m3" : "")
      + (c.steepCells != null ? "  (" + (c.steepShare * 100).toFixed(1) + "% selected)" : ""));
    if (!p) continue;
    const notes = [];
    if (p.geodiversity != null) {
      const ok = Math.abs(m.geodiversity - p.geodiversity) <= 0.0005;
      notes.push(ok ? "geodiv OK" : "geodiv MISMATCH want " + p.geodiversity); if (!ok) bad++;
    }
    if (p.hollows != null) {
      const ok = m.hollows === p.hollows;
      notes.push(ok ? "hollows OK" : "hollows MISMATCH want " + p.hollows); if (!ok) bad++;
    }
    if (p.volume != null && c.volume != null) {
      const ok = Math.abs(c.volume - p.volume) <= 2;
      notes.push(ok ? "volume OK" : "volume MISMATCH want " + p.volume); if (!ok) bad++;
    }
    if (p.outfall != null) {
      const ok = Math.abs(m.peakOutfall - p.outfall) <= 0.02;
      notes.push(ok ? "outfall OK" : "outfall MISMATCH want " + p.outfall); if (!ok) bad++;
    }
    console.log("                 " + notes.join(" · "));
  }
  console.log("\n" + (bad === 0
    ? "EVERY PUBLISHED FIGURE REPRODUCES — these are the sheet's own surfaces."
    : bad + " MISMATCH(ES) — do NOT draw from these surfaces."));
  process.exit(bad === 0 ? 0 : 1);
}
