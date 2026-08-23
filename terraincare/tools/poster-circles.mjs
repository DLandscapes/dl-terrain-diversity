// @ts-check
// TERRAIN ATTRIBUTES AS SVG CIRCLE FIELDS — figures for the A1 poster.
//
// Marc, 2026-08-19: translate the terrain attributes into SVG data rather than
// raster imagery, reusing the proportional circles the tool already draws, with
// the shader's own fill carried into each circle.
//
// ⚠️ THE FIGURE IS PRODUCED BY THE INSTRUMENT, NOT REDRAWN. This script imports
// the same modules the running app does — `demoTileHeights` for the opening
// tile, `analyse` for the layers, `symbolField` for the circle geometry,
// `sample` for the fill — so the poster is evidence produced by the thing it
// documents rather than an illustration of it. That is the poster README's own
// rule and it is the reason this lives here rather than in a drawing file.
//
// ⚠️ NO RASTER ANYWHERE IN THE OUTPUT. Every mark is a <circle> with a solid
// fill, so the sheet stays fully vector into the PDF and scales to any print
// size without resampling. It also means the figure is INSPECTABLE: a reader
// with the file can read the value off any circle.
//
// ⚠️ RADIUS AND FILL CARRY DIFFERENT THINGS, ON PURPOSE. Radius is the
// magnitude of the layer, fill is the same layer through the tool's own ramp.
// Encoding one quantity twice is redundant only in principle; in practice it is
// what makes the field legible at three metres (size) AND at one metre (tone),
// which is exactly the two reading distances the poster is built for.
//
// ⚠️⚠️ THE GREY SHEET DOES NOT USE THE COLOUR RAMP CONVERTED TO GREY, AND THAT
// IS A MEASURED DECISION RATHER THAN A PREFERENCE. The tool's continuous ramps
// are DIVERGING — twi runs deep red through cream to deep navy — so their two
// ends carry almost the same luminance. Measured on this build: the driest
// ground converts to grey 45 and the wettest to grey 37, a separation of 8,
// where roughly 40 levels are needed to tell two fills apart on paper at arm's
// length. A luminance conversion would therefore print the driest and the
// wettest ground as the SAME TONE, and the figure would be confidently wrong.
// The poster README already records the general form of this trap — "luma is
// useless against a diverging ramp".
// So: `colour` samples the instrument's own ramp, for a screen or colour sheet.
// `grey` maps the NORMALISED VALUE monotonically onto the paper's usable tonal
// span, which is the only mapping that keeps a diverging quantity readable in
// one ink. Both are driven by the same value, so the two sheets agree about
// which ground is wet even though they say it differently.
//
// Usage:  node tools/poster-circles.mjs [outDir]

import { DEM } from "../static/dem.js";
import { demoTileHeights } from "../static/demotile.js";
import { analyse } from "../static/analysis/indices.js";
import { symbolField, strideFor } from "../static/symbols.js";
import { sample } from "../static/analysis/ramps.js";
import { loadGeoTIFF } from "../static/geotiff.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const N = 256;
const CELL = 0.25;

/** The tile the tool opens on, built exactly as the app builds it. */
function openingTile() {
  const built = demoTileHeights(N, N, CELL);
  const dem = DEM.synthetic(N, N, CELL, () => 0);
  dem.z.set(built.z);
  return { dem, patches: built.patches };
}

/**
 * One layer as a field of filled circles.
 *
 * ⚠️ THE DOMAIN IS PERCENTILE-STRETCHED, matching the worker. A fixed domain
 * would put half these layers off the end of their own ramp — the mistake the
 * ramp table records from Phase 3 — and the circles would come out uniformly
 * pale or uniformly dark while the data underneath was perfectly differentiated.
 */
function circleField(dem, grid, rampId, opts = {}) {
  const finite = [];
  for (const v of grid) if (Number.isFinite(v)) finite.push(v);
  finite.sort((a, b) => a - b);
  const at = (p) => finite[Math.min(finite.length - 1,
    Math.max(0, Math.round(p * (finite.length - 1))))];
  const lo = at(0.02), hi = at(0.98);

  const stride = opts.stride ?? strideFor(dem, opts.target ?? 46);
  const pts = symbolField(dem, grid, {
    stride, lo, hi, minFraction: opts.minFraction ?? 0.14,
    maxFraction: opts.maxFraction ?? 0.98,
  });
  return { pts, lo, hi, stride, count: pts.length };
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

/**
 * The paper's usable tonal span, from the poster README's own measurement:
 * lighter than about 224 vanishes into the sheet, darker than about 96 crushes.
 * High value prints dark, which is the convention every shaded map already uses.
 */
const GREY_LIGHT = 224, GREY_DARK = 96;
function greyFill(t) {
  const g = Math.round(GREY_LIGHT - (GREY_LIGHT - GREY_DARK) * Math.min(1, Math.max(0, t)));
  return [g, g, g];
}

/**
 * @param {{pts:any[], lo:number, hi:number, stride:number}} field
 * @param {string} rampId
 * @param {{variant:string, span:number, title:string, unit:string}} o
 */
function toSVG(field, rampId, o) {
  const span = o.span;                       // ground metres across the tile
  const S = 1000 / span;                     // SVG units per metre
  const body = field.pts.map((p) => {
    const t = (p.v - field.lo) / (field.hi - field.lo || 1);
    const c = o.variant === "grey"
      ? greyFill(t)
      : sample(rampId, p.v, [field.lo, field.hi], "committed");
    // Three decimals is finer than any printer resolves at A1 and keeps the
    // file small; more would be false precision in a drawing.
    return `<circle cx="${(p.x * S).toFixed(2)}" cy="${((span - p.y) * S).toFixed(2)}"`
      + ` r="${(p.r * S).toFixed(2)}" fill="${rgb(c)}"/>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"
  role="img" aria-label="${o.title}">
<title>${o.title}</title>
<desc>${field.pts.length} proportional circles over a ${span} m square patch at
${CELL} m resolution, sampled every ${field.stride} cells. Circle radius and fill
both carry ${o.title.toLowerCase()}, percentile-stretched to
${field.lo.toFixed(3)}–${field.hi.toFixed(3)}${o.unit}. Fill is ${o.variant === "grey"
  ? "a monotone tone on the paper's usable span"
  : "the instrument's own ramp"}.
Vector throughout — no raster imagery.</desc>
${body}
</svg>`;
}

const outDir = process.argv[2]
  || join(process.cwd(), "..", "output", "poster", "figures");
mkdirSync(outDir, { recursive: true });

/**
 * ⚠️ THE SURVEYED PATCH IS READ FROM THE SAME GeoTIFF THE APP LOADS. The poster
 * has carried one raster since iteration 1 — a hillshade PNG of this patch —
 * and it is the last thing on the sheet that cannot be inspected, rescaled or
 * corrected without regenerating an image. Drawing it as circles from the
 * original elevations removes it.
 */
function surveyedPatch() {
  const buf = readFileSync(join(process.cwd(), "..", "data", "orndalen",
    "orndalen_fill_025m.tif"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return DEM.fromRaw(loadGeoTIFF(ab, { name: "orndalen_fill_025m" }));
}

const SUBJECTS = [
  { key: "opening", ...openingTile(), label: "the opening tile" },
  { key: "surveyed", dem: surveyedPatch(), patches: [], label: "the surveyed patch" },
];

const manifest = [];
for (const S0 of SUBJECTS) {
  const dem = S0.dem;
  const a = analyse(dem, { curvature: true });
  const span = dem.ncols * dem.cell;
  const LAYERS = [
    { id: "twi", grid: a.twi, title: "Wetness index", unit: "" },
    { id: "slope", grid: a.gradient.slopeDeg, title: "Slope", unit: "°" },
    { id: "tri", grid: a.tri, title: "Ruggedness", unit: " m" },
    { id: "elevation", grid: dem.z, title: "Elevation", unit: " m" },
  ];
  for (const variant of ["grey", "colour"]) {
    for (const L of LAYERS) {
      const f = circleField(dem, L.grid, L.id);
      const svg = toSVG(f, L.id, { variant, span, title: L.title, unit: L.unit });
      const name = `circles-${S0.key}-${L.id}-${variant}.svg`;
      writeFileSync(join(outDir, name), svg, "utf8");
      manifest.push({ name, subject: S0.key, layer: L.id, variant,
        circles: f.count, stride: f.stride,
        lo: +f.lo.toFixed(3), hi: +f.hi.toFixed(3), bytes: svg.length });
    }
  }
}
const { dem, patches } = SUBJECTS[0];

writeFileSync(join(outDir, "MANIFEST.json"), JSON.stringify({
  tile: "generated/sixteen-deformations",
  subjects: SUBJECTS.map((s) => ({ key: s.key, label: s.label,
    grid: `${s.dem.nrows} x ${s.dem.ncols} @ ${s.dem.cell} m` })),
  patches: patches.map((p) => p.id),
  produced: "tools/poster-circles.mjs",
  figures: manifest,
}, null, 2), "utf8");

console.log(`tile: ${N}x${N} @ ${CELL} m — ${patches.length} patches`);
for (const m of manifest) {
  console.log(`  ${m.name.padEnd(34)} ${String(m.circles).padStart(5)} circles · `
    + `stride ${m.stride} · ${(m.bytes / 1024).toFixed(0)} kB · `
    + `domain ${m.lo}…${m.hi}`);
}
console.log(`\nwritten to ${outDir}`);
