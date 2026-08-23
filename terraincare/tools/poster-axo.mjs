// @ts-check
// THE AXONOMETRIC, AS VECTOR — the poster's last non-brandmark raster removed.
//
// Fig. 1 on the A1 sheet is already an SVG: leader lines, callout dots and set
// text. Only the terrain inside it was a PNG export. This draws that terrain as
// line-work instead, at the same 1086 x 750 viewBox, so it drops straight into
// the slot the <image> occupied.
//
// ⚠️ STACKED PROFILES, NOT A QUAD MESH, AND THE CALLOUT HAS TO CHANGE WITH IT.
// The PNG showed one quad per cell — 65 536 of them. As vector that is roughly
// a quarter of a million line segments, which is not a drawing, it is a
// stress test. Drawing one PROFILE PER CELL ROW keeps the data at full
// resolution in the direction the profile runs and costs 256 paths. The sheet's
// callout said "ONE QUAD PER CELL"; with this figure it must say what is
// actually drawn, and the poster is edited to match. A figure that quietly
// stops matching its own caption is worse than a raster.
//
// ⚠️ HIDDEN-LINE REMOVAL COMES FROM THE DRAWING ORDER, NOT FROM A DEPTH TEST.
// Each profile is a closed path filled with the sheet colour and then stroked
// along its top edge, drawn FAR TO NEAR. A nearer profile paints over whatever
// stood behind it, so ridges occlude the ground behind them exactly as they
// would in a rendered view. This is the oldest trick in axonometric drafting
// and it is the reason the figure reads as a surface rather than as a
// transparent net.
//
// ⚠️ THE VERTICAL EXAGGERATION IS DECLARED ON THE SHEET. It is a distortion,
// not a display preference — the same rule that took the exaggeration slider out
// of the interface. The caption states the factor.
//
// Usage:  node tools/poster-axo.mjs [outDir]

import { DEM } from "../static/dem.js";
import { loadGeoTIFF } from "../static/geotiff.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const W = 1086, H = 750;          // the slot the PNG occupied, exactly
const EXAGG = 2.5;                // declared in the poster caption
const ROW_STEP = 1;               // one profile per cell row

const SHEET = "#fdfcf9";
const INK = "#26241f";

function surveyedPatch() {
  const buf = readFileSync(join(process.cwd(), "..", "data", "orndalen",
    "orndalen_fill_025m.tif"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return DEM.fromRaw(loadGeoTIFF(ab, { name: "orndalen_fill_025m" }));
}

/**
 * Isometric projection. x east, y north, z up.
 *
 * ⚠️ TRUE ISOMETRIC (30°), not a free perspective. The figure sits beside a
 * scale bar and a stated relief, so the reader is entitled to measure it — and
 * only a parallel projection lets them. A perspective view would make the far
 * edge of the patch a different scale from the near edge while looking more
 * "realistic", which is exactly the kind of quiet lie this project avoids.
 */
const C = Math.cos(Math.PI / 6), S = Math.sin(Math.PI / 6);
const project = (x, y, z) => [(x - y) * C, (x + y) * S - z];

const dem = surveyedPatch();
const { nrows, ncols, cell, z } = dem;

// Pass one: the projected extent, so the drawing is fitted rather than guessed.
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
let zlo = Infinity, zhi = -Infinity;
for (const v of z) { if (Number.isFinite(v)) { if (v < zlo) zlo = v; if (v > zhi) zhi = v; } }
for (let r = 0; r < nrows; r++) {
  for (let c = 0; c < ncols; c++) {
    const v = z[r * ncols + c];
    if (!Number.isFinite(v)) continue;
    const [px, py] = project(c * cell, (nrows - 1 - r) * cell, (v - zlo) * EXAGG);
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
}
const pad = 12;
const scale = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY));
const ox = pad - minX * scale + ((W - pad * 2) - (maxX - minX) * scale) / 2;
const oy = pad - minY * scale + ((H - pad * 2) - (maxY - minY) * scale) / 2;
// SVG y runs down; the projection's y runs up, so it is flipped on placement.
const put = (x, y, v) => {
  const [px, py] = project(x, y, v);
  return [px * scale + ox, H - (py * scale + oy)];
};

// Pass two: one closed profile per cell row, FAR TO NEAR.
// The far edge is the highest row index (north); near is row 0.
const paths = [];
let floor = -Infinity;
for (let r = 0; r < nrows; r++) {
  const yN = (nrows - 1 - r) * cell;
  const pts = [];
  for (let c = 0; c < ncols; c++) {
    const v = z[r * ncols + c];
    if (!Number.isFinite(v)) continue;
    pts.push(put(c * cell, yN, (v - zlo) * EXAGG));
  }
  if (pts.length < 2) continue;
  for (const p of pts) if (p[1] > floor) floor = p[1];
}
for (let r = nrows - 1; r >= 0; r -= ROW_STEP) {
  const yN = (nrows - 1 - r) * cell;
  const pts = [];
  for (let c = 0; c < ncols; c++) {
    const v = z[r * ncols + c];
    if (!Number.isFinite(v)) continue;
    pts.push(put(c * cell, yN, (v - zlo) * EXAGG));
  }
  if (pts.length < 2) continue;
  const skirt = floor + 24;
  const d = "M" + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")
    + `L${pts[pts.length - 1][0].toFixed(1)} ${skirt.toFixed(1)}`
    + `L${pts[0][0].toFixed(1)} ${skirt.toFixed(1)}Z`;
  paths.push(d);
}

// ⚠️ THE STROKE IS THINNER THAN THE PROFILE SPACING. At 256 profiles across
// this slot the lines sit under two units apart; a 1-unit stroke would close the
// gaps into a solid mass and the surface would lose its shading entirely. The
// weight is set so the drawing reads as ruled tone, which is what gives an
// axonometric of this kind its relief.
const body = paths.map((d) =>
  `<path d="${d}" fill="${SHEET}" stroke="${INK}" stroke-width="0.55"`
  + ` stroke-linejoin="round"/>`).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"
  role="img" aria-label="Axonometric of the design patch">
<title>The design patch, isometric</title>
<desc>${paths.length} profiles, one per cell row, across a ${(ncols * cell)} m
square patch at ${cell} m. True isometric at 30 degrees so the figure can be
measured; vertical exaggeration ${EXAGG}x, declared. Relief ${(zhi - zlo).toFixed(2)} m
(${zlo.toFixed(2)} to ${zhi.toFixed(2)} m). Hidden line removal is by drawing
order — each profile is filled with the sheet colour and drawn far to near, so
nearer ground occludes what stands behind it. Vector throughout.</desc>
${body}
</svg>`;

const outDir = process.argv[2]
  || join(process.cwd(), "..", "output", "poster", "figures");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "axonometric.svg"), svg, "utf8");

console.log(`profiles      ${paths.length} (one per cell row)`);
console.log(`grid          ${nrows} x ${ncols} @ ${cell} m`);
console.log(`relief        ${(zhi - zlo).toFixed(2)} m  (${zlo.toFixed(2)}–${zhi.toFixed(2)})`);
console.log(`exaggeration  ${EXAGG}x, declared on the sheet`);
console.log(`size          ${(svg.length / 1024).toFixed(0)} kB`);
console.log(`written       ${join(outDir, "axonometric.svg")}`);
