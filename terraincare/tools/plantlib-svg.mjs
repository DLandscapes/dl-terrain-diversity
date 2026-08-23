// @ts-check
/**
 * PLANT LIBRARY GENERATOR — orthographic elevation and plan of every growth
 * form, as vector line-work.
 *
 *   node --import ./tools/three-hook.mjs tools/plantlib-svg.mjs
 *
 * Writes, into `output/plant library orndalen/`:
 *   NN-<id>.svg        one sheet per plant, elevation + plan, named and scaled
 *   plant-overview.svg the 4×4 plate
 *   _plate.json        the same projected line-work as data, for the PNG step
 *
 * ⚠️ IT DRAWS THE REAL GEOMETRY, via `cadGeometry` from plants.js — the same
 * function the scatter calls. A library drawn from a copy would drift from the
 * scene the first time a form was tuned, and the drift would only be visible
 * once it was printed.
 *
 * Hidden surfaces are resolved with a painter's sort rather than backface
 * culling: several forms are deliberately open-ended (the tussock, the horsetail
 * tiers, the umbel's plate), and culling punches holes straight through them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { PLANT_LIBRARY, checkAgainstSpecies } from "../static/plantlib.js";
import {
  cadGeometry, FORMS, MOISTURE_ALPHA, compositeOverStage, PLANT_INK,
} from "../static/plants.js";
import { SPECIES } from "../static/analysis/species.js";

const OUT = new URL("../../output/plant library orndalen/", import.meta.url);

/**
 * Face tone comes from the plant's MOISTURE BAND, composited over the sheet —
 * the same derivation the scene's materials use, so paper matches screen.
 * ⚠️ Composited, not a real fill-opacity: the painter's sort below needs opaque
 * fills to hide back faces, and any true alpha makes every plant show its own
 * interior. See the note on compositeOverStage in plants.js.
 */
const fillOf = (band) => compositeOverStage(MOISTURE_ALPHA[band]);
const INK = PLANT_INK[0];
const hex = (v) => `#${v.toString(16).padStart(2, "0").repeat(3)}`;

/** Wettest first — the plate is ordered along the gradient, not by code. */
const BANDS = ["wet", "damp", "mesic", "dry", "xeric"];
const BAND_LABEL = {
  wet: "WET", damp: "DAMP", mesic: "MESIC", dry: "DRY", xeric: "XERIC",
};

/**
 * Project a geometry's triangles into 2D.
 * @param {any} geo
 * @param {"elevation"|"plan"} viewName
 */
function project(geo, viewName) {
  const p = geo.attributes.position.array;
  const index = geo.index ? geo.index.array : null;
  const n = index ? index.length : p.length / 3;
  const vert = (k) => {
    const j = (index ? index[k] : k) * 3;
    return [p[j], p[j + 1], p[j + 2]];
  };
  const tris = [];
  for (let t = 0; t + 2 < n; t += 3) {
    const v = [vert(t), vert(t + 1), vert(t + 2)];
    // SVG's y axis points down, so both views negate their vertical world axis.
    // Elevation looks along +Y (so depth is y, far first). Plan looks down -Z
    // with north up (so depth is z, lowest first).
    const pts = v.map(([x, y, z]) =>
      viewName === "elevation" ? [x, -z] : [x, -y]);
    const depth = viewName === "elevation"
      ? (v[0][1] + v[1][1] + v[2][1]) / 3
      : (v[0][2] + v[1][2] + v[2][2]) / 3;
    tris.push({ pts, depth });
  }
  // Painter's algorithm: draw the far ones first and let the near ones cover.
  tris.sort((a, b) => viewName === "elevation" ? b.depth - a.depth : a.depth - b.depth);
  return tris;
}

/** Fit a set of triangles into a box of side `side`, centred, at a GIVEN scale. */
function place(tris, scale, cx, cy) {
  return tris.map((t) => ({
    depth: t.depth,
    pts: t.pts.map(([x, y]) => [cx + x * scale, cy + y * scale]),
  }));
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One plant's line-work, both views, already scaled and positioned. */
function drawPlant(plant, cx, cyElev, cyPlan, boxScale) {
  const geo = cadGeometry(plant.form);
  const [r, h] = FORMS[plant.form];
  // ONE scale for both views, so elevation and plan are directly comparable —
  // and it is derived from the true metre size, not from each view's own extent.
  const extent = Math.max(2 * r, h);
  const scale = boxScale / extent;

  const elev = project(geo, "elevation");
  const plan = project(geo, "plan");
  // Elevation sits on its baseline; the form's origin is already ground level.
  const e = place(elev, scale, cx, cyElev);
  const pl = place(plan, scale, cx, cyPlan);
  return { e, pl, r, h, extent, scale };
}

function polys(tris, fill, stroke, sw) {
  return tris.map((t) =>
    `<polygon points="${t.pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")}" `
    + `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" `
    + `stroke-linejoin="round"/>`).join("");
}

// ── consistency gate ────────────────────────────────────────────────────────
const problems = checkAgainstSpecies(SPECIES);
if (problems.length) {
  console.error("library has drifted from SPECIES:\n  " + problems.join("\n  "));
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

// ── per-plant sheets ────────────────────────────────────────────────────────
const SHEET_W = 150, SHEET_H = 118, BOX = 44;
const plateData = [];

for (const plant of PLANT_LIBRARY) {
  const fill = hex(fillOf(plant.moisture));
  const stroke = hex(INK);
  const cxE = SHEET_W * 0.28, cxP = SHEET_W * 0.72;
  const baseline = 62;

  const geo = cadGeometry(plant.form);
  const [r, h] = FORMS[plant.form];
  const extent = Math.max(2 * r, h);
  const scale = BOX / extent;
  const elev = place(project(geo, "elevation"), scale, cxE, baseline);
  const plan = place(project(geo, "plan"), scale, cxP, baseline - BOX * 0.5);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}mm" height="${SHEET_H}mm" viewBox="0 0 ${SHEET_W} ${SHEET_H}">
<style>
  text { font-family: "Quattrocento Sans", "Source Sans 3", sans-serif; fill: #1a1a1a; }
  .cap { font-size: 2.6px; letter-spacing: .18em; fill: #6b6b6b; }
  .sci { font-size: 5.0px; font-style: italic; }
  .hab { font-size: 3.0px; fill: #4a4a4a; }
  .dim { font-size: 2.6px; fill: #6b6b6b; }
  .rule { stroke: #1a1a1a; stroke-width: .25; }
  .thin { stroke: #b4b4b4; stroke-width: .18; }
</style>
<text class="cap" x="6" y="9">PLANT LIBRARY · ØRNDALEN · ${String(plant.code).padStart(2, "0")}</text>
<line class="rule" x1="6" y1="12" x2="${SHEET_W - 6}" y2="12"/>

<line class="thin" x1="${cxE - BOX * 0.62}" y1="${baseline}" x2="${cxE + BOX * 0.62}" y2="${baseline}"/>
${polys(elev, fill, stroke, 0.22)}
<text class="cap" x="${cxE}" y="${baseline + 7}" text-anchor="middle">ELEVATION</text>

${polys(plan, fill, stroke, 0.22)}
<text class="cap" x="${cxP}" y="${baseline + 7}" text-anchor="middle">PLAN</text>

<text class="sci" x="6" y="${SHEET_H - 20}">${esc(plant.name)}</text>
<text class="hab" x="6" y="${SHEET_H - 14.5}">${esc(plant.habit)}</text>
<text class="dim" x="6" y="${SHEET_H - 8}">height ${h.toFixed(2)} m · spread ${(2 * r).toFixed(2)} m · ${BAND_LABEL[plant.moisture].toLowerCase()} · ${plant.source === "project" ? (plant.modelled ? "modelled species" : "project") : "PROPOSED — presence on site not verified"}</text>
</svg>
`;
  const file = `${String(plant.code).padStart(2, "0")}-${plant.id}.svg`;
  writeFileSync(new URL(file, OUT), svg, "utf8");
  plateData.push({ ...plant, h, r, elev, plan, fill, stroke });
}

// ── the 4×4 plate ───────────────────────────────────────────────────────────
// ⚠️ EACH CELL IS FITTED TO ITS OWN PLANT, AND EACH CARRIES A SCALE BAR.
// One shared scale was tried first and is unusable: the mountain birch is 4.20 m
// and the Sphagnum cushion 0.06 m, a ratio of 70:1, so at a cell height that
// shows the birch the moss draws 0.55 mm tall — invisible. A plate whose job is
// to show what sixteen plants look like cannot render twelve of them as dust.
// The honesty that a shared scale would have carried is carried instead by a
// per-cell scale bar and a printed height, which is what botanical plates and
// technical drawings have always done. The TRUE relative sizes are the scene's
// job, and the scene draws them at true proportion.
const CELL_W = 62, CELL_H = 78, MARG = 10, TOPBAR = 22;
const PLATE_W = MARG * 2 + CELL_W * 4;
const PLATE_H = TOPBAR + MARG + CELL_H * 4 + 8;

/** Largest round metric length that still fits inside the drawing. */
function scaleBarFor(extent) {
  for (const m of [2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01]) {
    if (m <= extent * 0.85) return m;
  }
  return 0.01;
}

/** One display list, rendered twice — as SVG here and as PNG in plantlib-png.py. */
const display = [];

// ⚠️ ORDERED WET → XERIC, NOT BY CLASS CODE. Reading the plate left to right,
// top to bottom, walks the moisture gradient, and the fills get lighter as it
// goes because opacity encodes the same variable. The codes stay in the
// filenames, where they have to be stable; the plate is free to be legible.
const ordered = [...PLANT_LIBRARY].sort((a, b) =>
  BANDS.indexOf(a.moisture) - BANDS.indexOf(b.moisture) || a.code - b.code);

ordered.forEach((plant, i) => {
  const col = i % 4, row = (i / 4) | 0;
  const x0 = MARG + col * CELL_W, y0 = TOPBAR + MARG + row * CELL_H;
  const cx = x0 + CELL_W / 2, baseline = y0 + CELL_H * 0.56;
  const [r, h] = FORMS[plant.form];
  const extent = Math.max(2 * r, h);
  const cellScale = (CELL_H * 0.40) / extent;
  const tris = place(project(cadGeometry(plant.form), "elevation"), cellScale, cx, baseline);
  const bar = scaleBarFor(extent);
  display.push({
    code: plant.code, name: plant.name, habit: plant.habit,
    invasive: !!plant.invasive, modelled: !!plant.modelled,
    proposed: plant.source === "proposed",
    band: BAND_LABEL[plant.moisture], alpha: MOISTURE_ALPHA[plant.moisture],
    fill: fillOf(plant.moisture), stroke: INK,
    x0, y0, cx, baseline, cellW: CELL_W, cellH: CELL_H,
    tris: tris.map((t) => t.pts),
    bar: { m: bar, px: bar * cellScale, label: bar >= 1 ? `${bar} m` : `${bar * 100} cm` },
    dims: `${h.toFixed(2)} m tall`,
  });
});

const cells = display.map((d) => `<g>
<text class="band" x="${d.x0 + 6}" y="${d.y0 + 5}">${d.band}</text>
${d.proposed ? `<text class="prop" x="${d.x0 + d.cellW - 6}" y="${d.y0 + 5}" text-anchor="end">PROPOSED</text>` : ""}
<line class="thin" x1="${d.x0 + 6}" y1="${d.baseline}" x2="${d.x0 + d.cellW - 6}" y2="${d.baseline}"/>
${polys(d.tris.map((pts) => ({ pts })), hex(d.fill), hex(d.stroke), 0.20)}
<line class="bar" x1="${d.cx - d.bar.px / 2}" y1="${d.baseline + 4}" x2="${d.cx + d.bar.px / 2}" y2="${d.baseline + 4}"/>
<text class="dim" x="${d.cx}" y="${d.baseline + 8}" text-anchor="middle">${d.bar.label} · ${d.dims}</text>
<text class="sci" x="${d.cx}" y="${d.y0 + d.cellH - 11}" text-anchor="middle">${esc(d.name)}</text>
<text class="hab" x="${d.cx}" y="${d.y0 + d.cellH - 6.5}" text-anchor="middle">${esc(d.habit)}</text>
</g>`).join("\n");

const plate = `<svg xmlns="http://www.w3.org/2000/svg" width="${PLATE_W}mm" height="${PLATE_H}mm" viewBox="0 0 ${PLATE_W} ${PLATE_H}">
<style>
  text { font-family: "Quattrocento Sans", "Source Sans 3", sans-serif; fill: #1a1a1a; }
  .cap { font-size: 3.0px; letter-spacing: .18em; fill: #6b6b6b; }
  .ttl { font-size: 7px; letter-spacing: .04em; }
  .sci { font-size: 3.4px; font-style: italic; }
  .hab { font-size: 2.4px; fill: #5a5a5a; }
  .dim { font-size: 2.3px; fill: #6b6b6b; }
  .band { font-size: 2.4px; letter-spacing: .16em; fill: #8a8a8a; }
  .prop { font-size: 2.2px; letter-spacing: .12em; fill: #a08a5a; }
  .rule { stroke: #1a1a1a; stroke-width: .3; }
  .thin { stroke: #b4b4b4; stroke-width: .18; }
  .bar  { stroke: #1a1a1a; stroke-width: .35; }
</style>
<text class="ttl" x="${MARG}" y="13">Plant library · Ørndalen</text>
<text class="cap" x="${PLATE_W - MARG}" y="13" text-anchor="end">ORDERED WET → XERIC · FACE OPACITY = MOISTURE · EACH CELL TO ITS OWN SCALE BAR</text>
<line class="rule" x1="${MARG}" y1="${TOPBAR - 4}" x2="${PLATE_W - MARG}" y2="${TOPBAR - 4}"/>
${cells}
</svg>
`;
writeFileSync(new URL("plant-overview.svg", OUT), plate, "utf8");
writeFileSync(new URL("_plate.json", OUT), JSON.stringify({
  plateW: PLATE_W, plateH: PLATE_H, marg: MARG, topbar: TOPBAR, cells: display,
}), "utf8");

console.log(`${PLANT_LIBRARY.length} sheets + plate written to`);
console.log(decodeURIComponent(OUT.pathname.slice(1)));
const modelled = PLANT_LIBRARY.filter((p) => p.modelled).length;
console.log(`${modelled} modelled, ${PLANT_LIBRARY.length - modelled} drawn only · plate ${PLATE_W}×${PLATE_H} mm`);
