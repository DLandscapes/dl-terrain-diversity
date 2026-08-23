// @ts-check
// THE DERIVATIVE SHEETS — the other drawings a GIS analysis becomes when a
// contractor, a drainage engineer or a quantity surveyor has to act on it.
//
// The grading plan (export/grading.js) is the first of the family; these are
// its siblings, and they keep its rules: greyscale, direction and density
// instead of tone, existing dashed under proposed solid, a dimensioned frame,
// a north point, a graphic scale, and ⚠️ NO VOLUMES ANYWHERE — the ledger is
// the only place a volume comes from. A section states areas, an isopach
// states depths, a drainage plan states where water leaves; none of them
// multiplies anything by anything.
//
// Four sheets:
//   isopachSVG           equal depth of cut and fill — where the work is deep
//   slopeClassSVG        the ground banded by gradient — what can be used how
//   drainageSVG          channels, divides, standing water and the outfalls
//   chainageSectionsSVG  cross-sections at even stations along the guide
//
// All four read the surface as it stands and change nothing.

import { contourSegments } from "../contours.js";
import { computeGradient } from "../analysis/horn.js";
import { flowAccumulation } from "../analysis/mfd.js";
import { watersheds } from "../analysis/watershed.js";
import { findDepressions } from "../analysis/indices.js";
import { pondWater } from "../analysis/ponding.js";
import { sampleSection, sectionAreas } from "../section.js";
import { stations } from "../guide.js";
import { esc, niceScale } from "./grading.js";

/* ───────────────────────────── shared furniture ─────────────────────────── */

const STYLE = `
    text { font-family: "Source Sans 3", "Segoe UI", system-ui, sans-serif;
           fill: #1c1a16; font-variant-numeric: tabular-nums; }
    .ttl { font-size: 6px;   font-weight: 700; letter-spacing: 0.28px; }
    .sub { font-size: 3.2px; font-weight: 400; fill: #6b6659; }
    .axl { font-size: 2.8px; font-weight: 400; fill: #6b6659; }
    .lbl { font-size: 2.6px; font-weight: 600; }
    .ax  { fill: none; stroke: #6b6659; stroke-width: 0.18; }
    .was { fill: none; stroke: #1c1a16; stroke-width: 0.1; stroke-opacity: 0.5;
           stroke-dasharray: 1.1 0.9; }
    .now { fill: none; stroke: #1c1a16; stroke-width: 0.24; }
    .idx { fill: none; stroke: #1c1a16; stroke-width: 0.5; }
    .hat { stroke: #1c1a16; stroke-width: 0.13; stroke-opacity: 0.7; fill: none; }
    .div { fill: none; stroke: #1c1a16; stroke-width: 0.32;
           stroke-dasharray: 2.4 0.8 0.5 0.8; }
    .chn { fill: none; stroke: #1c1a16; stroke-linecap: round; }
    .bar { stroke: #1c1a16; stroke-width: 0.18; }
`;

/**
 * A north-up plan sheet: title block, plan frame, dimensions, north point and
 * scale bar — the furniture every plan in this family shares, so four sheets
 * of one site read as one set. `body(X, Y, api)` draws the plan itself in map
 * metres through the two projectors.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {{title:string, subtitle:string, foot:string,
 *          legendH?: number}} o
 * @param {(X:(x:number)=>number, Y:(y:number)=>number,
 *          api:{parts:string[], mmPerM:number, top:number, planH:number,
 *               planW:number, PAD:number}) => void} body
 */
function planSheet(dem, o, body) {
  const { nrows, ncols, cell } = dem;
  const W = ncols * cell, H = nrows * cell;
  const PAD = 22, SHEET_W = 760, TITLE = 26, FOOT = 34;
  const planW = SHEET_W - PAD * 2;
  const mmPerM = planW / W;
  const planH = H * mmPerM;
  const legendH = o.legendH ?? 0;
  const SHEET_H = PAD + TITLE + planH + legendH + FOOT + PAD;
  const top = PAD + TITLE;
  const X = (x) => PAD + x * mmPerM;
  const Y = (y) => top + (H - y) * mmPerM;
  const hScale = niceScale((W / planW) * 1000);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}mm" `
    + `height="${SHEET_H.toFixed(1)}mm" viewBox="0 0 ${SHEET_W} ${SHEET_H.toFixed(1)}">`);
  parts.push(`<style>${STYLE}</style>`);
  parts.push(`<text class="ttl" x="${PAD}" y="${(PAD + 8).toFixed(1)}">${esc(o.title)}</text>`);
  parts.push(`<text class="sub" x="${PAD}" y="${(PAD + 16).toFixed(1)}">`
    + `${esc(o.subtitle)} · scale 1:${hScale}</text>`);

  body(X, Y, { parts, mmPerM, top, planH, planW, PAD });

  // Frame, dimensions, north, scale bar — the grading plan's own furniture.
  parts.push(`<rect class="ax" fill="none" x="${PAD}" y="${top.toFixed(2)}" `
    + `width="${planW.toFixed(2)}" height="${planH.toFixed(2)}"/>`);
  const fy = top + planH;
  parts.push(`<text class="axl" x="${(PAD + planW / 2).toFixed(2)}" `
    + `y="${(fy + 5).toFixed(2)}" text-anchor="middle">${W.toFixed(0)} m</text>`);
  parts.push(`<text class="axl" transform="translate(${(PAD - 3).toFixed(2)},`
    + `${(top + planH / 2).toFixed(2)}) rotate(-90)" text-anchor="middle">`
    + `${H.toFixed(0)} m</text>`);
  {
    const nx = PAD + planW - 10, ny = top + 10;
    parts.push(`<path class="ax" style="stroke-width:0.4" `
      + `d="M${nx} ${(ny + 7).toFixed(1)}V${(ny - 5).toFixed(1)}"/>`);
    parts.push(`<polygon fill="#1c1a16" points="${nx},${(ny - 7).toFixed(1)} `
      + `${(nx - 1.6).toFixed(1)},${(ny - 3.4).toFixed(1)} `
      + `${(nx + 1.6).toFixed(1)},${(ny - 3.4).toFixed(1)}"/>`);
    parts.push(`<text class="axl" x="${nx}" y="${(ny + 11).toFixed(1)}" `
      + `text-anchor="middle">N</text>`);
  }
  {
    const barM = niceScale(W / 5), bw = barM * mmPerM;
    const sy = fy + legendH + 12, bx = PAD;
    for (let i = 0; i < 4; i++) {
      parts.push(`<rect class="bar" fill="${i % 2 ? "#1c1a16" : "none"}" `
        + `x="${(bx + i * bw / 2).toFixed(2)}" y="${sy.toFixed(2)}" `
        + `width="${(bw / 2).toFixed(2)}" height="2.2"/>`);
    }
    for (let i = 0; i <= 2; i++) {
      parts.push(`<text class="axl" x="${(bx + i * bw).toFixed(2)}" `
        + `y="${(sy + 6).toFixed(2)}" text-anchor="middle">${(i * barM).toFixed(0)}</text>`);
    }
    parts.push(`<text class="axl" x="${(bx + 2 * bw + 3).toFixed(2)}" `
      + `y="${(sy + 6).toFixed(2)}">metres</text>`);
  }
  parts.push(`<text class="sub" x="${PAD}" y="${(SHEET_H - 8).toFixed(1)}">`
    + `${esc(o.foot)}</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}

/**
 * Scanline hatch over the cells where `test` holds — the grading plan's
 * hatcher, generalised from a sign on dz to any predicate. Same reasoning:
 * lines clipped to a mask have no ring topology to get wrong.
 * @param {{nrows:number, ncols:number, cell:number}} dem
 * @param {(i:number)=>boolean} test
 * @param {{spacing:number, dir:number}} o  dir +1 for 45°, −1 for −45°
 */
function hatchWhere(dem, test, o) {
  const { nrows, ncols, cell } = dem;
  const W = ncols * cell, H = nrows * cell;
  const step = cell * 0.5;
  const at = (x, y) => {
    const c = Math.floor(x / cell), r = Math.floor((H - y) / cell);
    if (r < 0 || c < 0 || r >= nrows || c >= ncols) return false;
    return test(r * ncols + c);
  };
  const out = [];
  const kMin = o.dir > 0 ? -H : 0;
  const kMax = o.dir > 0 ? W : W + H;
  const dk = Math.max(o.spacing, cell * 0.25) * Math.SQRT2;
  for (let k = kMin; k <= kMax; k += dk) {
    const x0 = o.dir > 0 ? Math.max(0, k) : Math.max(0, k - H);
    const x1 = o.dir > 0 ? Math.min(W, k + H) : Math.min(W, k);
    if (!(x1 > x0)) continue;
    let run = null;
    for (let x = x0; x <= x1; x += step) {
      const y = o.dir > 0 ? x - k : k - x;
      const on = y >= 0 && y <= H && at(x, y);
      if (on) {
        if (!run) run = [x, y, x, y];
        else { run[2] = x; run[3] = y; }
      } else if (run) { out.push(run); run = null; }
    }
    if (run) out.push(run);
  }
  return out;
}

/** Runs → one path element. */
function runsToPath(runs, X, Y, cls, extra = "") {
  if (!runs.length) return "";
  let d = "";
  for (const [x0, y0, x1, y1] of runs) {
    d += `M${X(x0).toFixed(2)} ${Y(y0).toFixed(2)}L${X(x1).toFixed(2)} ${Y(y1).toFixed(2)}`;
  }
  return `<path class="${cls}"${extra} d="${d}"/>`;
}

const PROVENANCE = "DL-TerrainDiversity · a terrain analysis instrument. Not a prediction.";

/* ─────────────────────────────── the isopach ────────────────────────────── */

/**
 * THE CUT/FILL ISOPACH — contours of equal DEPTH of change, which is the
 * drawing that says where the work is deep rather than where it is.
 *
 * The grading plan hatches the disturbed area; this sheet contours the field
 * `now − was` itself. ⚠️ CUT DASHED, FILL SOLID, THE ZERO LINE HEAVY: the
 * zero contour of dz is the LIMIT OF WORKS — the line a setting-out engineer
 * pegs — and it earns the index weight. Cut and fill are told apart by line
 * STYLE, not tone, for the same greyscale reason the grading plan hatches in
 * two directions.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {{baseline: Float32Array|null, site?: string, crs?: string,
 *          interval?: number, provenance?: string}} opts
 */
export function isopachSVG(dem, opts = {}) {
  const { nrows, ncols, cell, z } = dem;
  const was = opts.baseline || null;

  const dz = new Float32Array(z.length);
  let maxAbs = 0, moved = false;
  for (let i = 0; i < z.length; i++) {
    const a = z[i], b = was ? was[i] : NaN;
    dz[i] = (Number.isFinite(a) && Number.isFinite(b)) ? a - b : NaN;
    if (Number.isFinite(dz[i]) && Math.abs(dz[i]) > 0.02) {
      moved = true;
      if (Math.abs(dz[i]) > maxAbs) maxAbs = Math.abs(dz[i]);
    }
  }
  // An interval that lands a handful of lines each side of zero, from the
  // depth the ground actually carries — a fixed interval would draw one line
  // on a shallow scrape and eighty on a deep cut.
  const interval = opts.interval || Math.max(0.05, niceScale(Math.max(maxAbs, 0.05) / 5));

  return planSheet(dem, {
    title: "CUT / FILL ISOPACH",
    subtitle: `${opts.site || ""} · ${opts.crs || ""} · `
      + `equal depth of change at ${interval.toFixed(2)} m · `
      + (moved
        ? `cut dashed, fill solid, zero line heavy — the limit of works · `
          + `deepest change ${maxAbs.toFixed(2)} m`
        : `nothing has been moved on this ground yet`),
    foot: `Depths of change on the ground, never volumes: the ledger is the `
      + `only place a volume comes from. `
      + (opts.provenance || PROVENANCE),
  }, (X, Y, { parts }) => {
    if (!moved) return;
    const seg = contourSegments(dz, nrows, ncols, cell, interval, { limit: 4000 });
    let cut = "", fill = "";
    for (let i = 0; i < seg.segments; i++) {
      const p = i * 6;
      const run = `M${X(seg.positions[p]).toFixed(2)} ${Y(seg.positions[p + 1]).toFixed(2)}`
        + `L${X(seg.positions[p + 3]).toFixed(2)} ${Y(seg.positions[p + 4]).toFixed(2)}`;
      const lv = seg.positions[p + 2];
      // ⚠️ The zero level is skipped here and drawn from a clamped |dz| field
      // below. Contouring dz at 0 directly is ASYMMETRIC: the half-open >=
      // crossing test makes untouched ground (exactly 0) count as "above", so
      // the line appears along cut boundaries and silently not along fill
      // boundaries — a limit of works that only limits half the works.
      if (Math.abs(lv) < interval / 2) continue;
      if (lv < 0) cut += run; else fill += run;
    }
    if (cut) parts.push(`<path class="was" style="stroke-opacity:1" d="${cut}"/>`);
    if (fill) parts.push(`<path class="now" d="${fill}"/>`);
    {
      // The limit of works: |dz| clamped just above the disturbance tolerance
      // and contoured AT the tolerance — one clean, symmetric line around
      // every disturbed area, cut and fill alike. The clamp at 0.03 keeps the
      // level list to {0, 0.02}, and the half-open test draws nothing at 0.
      const clipped = new Float32Array(dz.length);
      for (let i = 0; i < dz.length; i++) {
        const v = dz[i];
        clipped[i] = Number.isFinite(v) ? Math.min(Math.abs(v), 0.03) : NaN;
      }
      const lim = contourSegments(clipped, nrows, ncols, cell, 0.02, { limit: 4000 });
      let zero = "";
      for (let i = 0; i < lim.segments; i++) {
        const p = i * 6;
        zero += `M${X(lim.positions[p]).toFixed(2)} ${Y(lim.positions[p + 1]).toFixed(2)}`
          + `L${X(lim.positions[p + 3]).toFixed(2)} ${Y(lim.positions[p + 4]).toFixed(2)}`;
      }
      if (zero) parts.push(`<path class="idx" d="${zero}"/>`);
    }

    // The two extremes, located and stated — the figures a checker reaches for.
    let iCut = -1, iFill = -1, vCut = 0, vFill = 0;
    for (let i = 0; i < dz.length; i++) {
      const v = dz[i];
      if (!Number.isFinite(v)) continue;
      if (v < vCut) { vCut = v; iCut = i; }
      if (v > vFill) { vFill = v; iFill = i; }
    }
    const H = nrows * cell;
    for (const [i, v, name] of [[iCut, vCut, "deepest cut"], [iFill, vFill, "highest fill"]]) {
      if (i < 0) continue;
      const r = (/** @type {number} */ (i) / ncols) | 0, c = /** @type {number} */ (i) - r * ncols;
      const x = X((c + 0.5) * cell), y = Y(H - (r + 0.5) * cell);
      parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="0.9" `
        + `fill="none" stroke="#1c1a16" stroke-width="0.3"/>`);
      parts.push(`<text class="lbl" x="${(x + 1.6).toFixed(2)}" y="${(y + 0.8).toFixed(2)}">`
        + `${name} ${Math.abs(/** @type {number} */ (v)).toFixed(2)} m</text>`);
    }
  });
}

/* ───────────────────────────── the slope classes ────────────────────────── */

/**
 * The slope bands, stated as the gradients design actually happens against.
 * ⚠️ RATIOS, NOT DEGREES: a landscape architect sets out 1:20 and 1:12
 * because they are accessibility limits, 1:3 because it is about where a
 * slope stops being maintainable and starts being a batter. The percentages
 * are printed too; degrees appear nowhere on this sheet because nobody pegs
 * one.
 */
export const SLOPE_CLASSES = [
  { max: 5,        label: "to 1:20 — accessible",        spacing: 0 },
  { max: 100 / 12, label: "1:20 to 1:12 — ramp limit",   spacing: 3.2 },
  { max: 100 / 6,  label: "1:12 to 1:6",                 spacing: 1.9 },
  { max: 100 / 3,  label: "1:6 to 1:3",                  spacing: 1.1 },
  { max: Infinity, label: "over 1:3 — batter",           spacing: 0.7, cross: true },
];

/**
 * THE SLOPE-CLASS PLAN — the ground banded by gradient, read as density:
 * the steeper, the closer the hatch, and the steepest class cross-hatched.
 * The flattest class stays paper, because on this sheet paper MEANS usable.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {{site?: string, crs?: string, provenance?: string}} [opts]
 */
export function slopeClassSVG(dem, opts = {}) {
  const { nrows, ncols, cell } = dem;
  const grad = computeGradient(dem);
  // Percent grade per cell, from the same Horn gradient every layer uses.
  const pct = new Float32Array(grad.slope.length);
  for (let i = 0; i < pct.length; i++) {
    const s = grad.slope[i];
    pct[i] = Number.isFinite(s) ? Math.tan(s) * 100 : NaN;
  }
  // Class per cell, and the share of the surveyed ground each class carries —
  // measured for the legend, because "how much of the site is accessible" is
  // the question this sheet exists to answer.
  const klass = new Int8Array(pct.length).fill(-1);
  const share = new Float64Array(SLOPE_CLASSES.length);
  let valid = 0;
  for (let i = 0; i < pct.length; i++) {
    const v = pct[i];
    if (!Number.isFinite(v)) continue;
    valid++;
    for (let k = 0; k < SLOPE_CLASSES.length; k++) {
      if (v <= SLOPE_CLASSES[k].max) { klass[i] = k; share[k]++; break; }
    }
  }

  const legendH = 6 + SLOPE_CLASSES.length * 5;
  return planSheet(dem, {
    title: "SLOPE CLASSES",
    subtitle: `${opts.site || ""} · ${opts.crs || ""} · `
      + `gradient bands from the Horn (1981) slope · the denser the hatch, `
      + `the steeper the ground · paper means to 1:20`,
    foot: `Gradients as ratios and percentages — nobody pegs a degree. `
      + `Shares are of the surveyed surface. `
      + (opts.provenance || PROVENANCE),
    legendH,
  }, (X, Y, { parts, mmPerM, top, planH, PAD }) => {
    for (let k = 1; k < SLOPE_CLASSES.length; k++) {
      const sc = SLOPE_CLASSES[k];
      const spacing = sc.spacing / mmPerM;
      const runs = hatchWhere(dem, (i) => klass[i] === k, { spacing, dir: 1 });
      parts.push(runsToPath(runs, X, Y, "hat"));
      if (sc.cross) {
        const runs2 = hatchWhere(dem, (i) => klass[i] === k, { spacing, dir: -1 });
        parts.push(runsToPath(runs2, X, Y, "hat"));
      }
    }
    // The legend: a swatch per class, its bounds, and its measured share.
    const ly = top + planH + 6;
    for (let k = 0; k < SLOPE_CLASSES.length; k++) {
      const sc = SLOPE_CLASSES[k];
      const y = ly + k * 5;
      parts.push(`<rect class="ax" x="${PAD}" y="${y.toFixed(1)}" width="10" height="3.4"/>`);
      if (sc.spacing) {
        // The swatch carries the same hatch the plan does, at sheet scale.
        let d = "";
        for (let x = 0; x < 10 + 3.4; x += sc.spacing) {
          const x0 = Math.max(0, x - 3.4), y0 = Math.min(3.4, x);
          d += `M${(PAD + x0).toFixed(2)} ${(y + (x - x0)).toFixed(2)}`
            + `L${(PAD + Math.min(10, x)).toFixed(2)} ${(y + Math.max(0, x - 10)).toFixed(2)}`;
        }
        parts.push(`<path class="hat" d="${d}"/>`);
        if (sc.cross) parts.push(`<path class="hat" transform="translate(${2 * PAD + 10},0) scale(-1,1)" d="${d}"/>`);
      }
      const pctShare = valid ? (100 * share[k] / valid) : 0;
      const lo = k === 0 ? 0 : SLOPE_CLASSES[k - 1].max;
      parts.push(`<text class="axl" x="${PAD + 13}" y="${(y + 2.7).toFixed(1)}">`
        + `${esc(sc.label)} (${lo.toFixed(0)}–`
        + `${Number.isFinite(sc.max) ? sc.max.toFixed(0) : "∞"} %) — `
        + `${pctShare.toFixed(1)} % of the surface</text>`);
    }
  });
}

/* ────────────────────────────── the drainage plan ───────────────────────── */

/**
 * THE DRAINAGE PLAN — where water runs, where it divides, where it stands,
 * and where it LEAVES. The last is the sheet's point: an outfall is a thing
 * that gets designed, consented and built, and this is the drawing it gets
 * designed on.
 *
 * ⚠️ VALUES BY MFD, LINES BY STEEPEST DESCENT. Accumulation keeps the house
 * rule (Freeman 1991 MFD); but a drawn channel needs ONE direction per cell,
 * so the line work follows the D8 receiver the watershed pass already keeps
 * "so a flow path can be traced for the UI". The subtitle says so.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {{site?: string, crs?: string, provenance?: string, rainM?: number,
 *          substrate?: Uint8Array|null}} [opts]
 */
export function drainageSVG(dem, opts = {}) {
  const { nrows, ncols, cell } = dem;
  const n = nrows * ncols;
  const W = ncols * cell, H = nrows * cell;
  const rainM = opts.rainM ?? 0.02;

  const flow = flowAccumulation(dem);
  const ws = watersheds(dem);
  const dep = findDepressions(dem);
  const pond = pondWater(dem, rainM, { substrate: opts.substrate || null, depressions: dep });

  // Channel classes by contributing area, as shares of the tile — the same
  // threshold meaning on a 64 m patch and a 1 km context.
  const tile = W * H;
  const CH = [
    { min: tile * 0.01, w: 0.22 },
    { min: tile * 0.05, w: 0.45 },
    { min: tile * 0.15, w: 0.8 },
  ];

  const outfalls = (pond.outfalls || []).slice(0, 12);

  return planSheet(dem, {
    title: "DRAINAGE PLAN",
    subtitle: `${opts.site || ""} · ${opts.crs || ""} · `
      + `accumulation by MFD (Freeman 1991), channels drawn along steepest `
      + `descent · divides dash-dot · standing water hatched at a `
      + `${(rainM * 1000).toFixed(0)} mm event · ${ws.count} catchments`,
    foot: `Outfalls ranked by the stated event's volume — where a pipe, a `
      + `swale or a consent has to exist. Areas and depths only; the ledger `
      + `is the only place a volume comes from — an outfall's figure is the `
      + `event's, not the design's. `
      + (opts.provenance || PROVENANCE),
  }, (X, Y, { parts }) => {
    // Standing water first, under the line work.
    const runs = hatchWhere(dem, (i) => pond.depth[i] > 0.001, { spacing: 0.8, dir: -1 });
    parts.push(runsToPath(runs, X, Y, "hat", ` style="stroke-opacity:0.5"`));

    // The channels: one segment per cell above threshold, along its receiver.
    const cx = (i) => ((i % ncols) + 0.5) * cell;
    const cy = (i) => H - (((i / ncols) | 0) + 0.5) * cell;
    for (let k = 0; k < CH.length; k++) {
      const hi = k + 1 < CH.length ? CH[k + 1].min : Infinity;
      let d = "";
      for (let i = 0; i < n; i++) {
        const a = flow.contributingArea[i];
        if (!(a >= CH[k].min && a < hi)) continue;
        const r = ws.receiver[i];
        if (r < 0 || r === i) continue;
        d += `M${X(cx(i)).toFixed(2)} ${Y(cy(i)).toFixed(2)}`
          + `L${X(cx(r)).toFixed(2)} ${Y(cy(r)).toFixed(2)}`;
      }
      if (d) parts.push(`<path class="chn" style="stroke-width:${CH[k].w}" d="${d}"/>`);
    }

    // The divides: sides where two different catchments meet. Same cell-edge
    // walk the patchwork uses, on the basin labels.
    {
      let d = "";
      const px = (C) => C * cell, py = (R) => H - R * cell;
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) {
          const b = ws.basin[r * ncols + c];
          if (b < 0) continue;
          if (r > 0) {
            const o = ws.basin[(r - 1) * ncols + c];
            if (o >= 0 && o !== b) {
              d += `M${X(px(c)).toFixed(2)} ${Y(py(r)).toFixed(2)}`
                + `L${X(px(c + 1)).toFixed(2)} ${Y(py(r)).toFixed(2)}`;
            }
          }
          if (c > 0) {
            const o = ws.basin[r * ncols + c - 1];
            if (o >= 0 && o !== b) {
              d += `M${X(px(c)).toFixed(2)} ${Y(py(r)).toFixed(2)}`
                + `L${X(px(c)).toFixed(2)} ${Y(py(r + 1)).toFixed(2)}`;
            }
          }
        }
      }
      if (d) parts.push(`<path class="div" d="${d}"/>`);
    }

    // The outfalls: located, ranked, and stated in the event's own volume.
    outfalls.forEach((of, i) => {
      const x = X(of.x - dem.originX), y = Y(of.y - dem.originY);
      const r = Math.max(0.8, Math.min(3, 0.8 + Math.sqrt(of.volume)));
      parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r.toFixed(2)}" `
        + `fill="none" stroke="#1c1a16" stroke-width="0.45"/>`);
      parts.push(`<text class="lbl" x="${(x + r + 1).toFixed(2)}" y="${(y + 0.9).toFixed(2)}">`
        + `${i + 1} · ${of.volume < 10 ? of.volume.toFixed(1) : of.volume.toFixed(0)} m³</text>`);
    });
  });
}

/* ─────────────────────────── the chainage sections ──────────────────────── */

/**
 * CROSS-SECTIONS AT EVEN CHAINAGE ALONG THE GUIDE — the drawing a road or
 * swale is actually built from: one section per station, existing dashed,
 * proposed solid, cut and fill stated as AREAS per section so a quantity
 * surveyor can do the multiplication themselves, once, with the spacing in
 * front of them.
 *
 * ⚠️ LOOKING ALONG THE CHAINAGE: left on the sheet is left when walking the
 * line from CH 0, and the sheet says so — a section that does not state its
 * viewing direction is a drawing of an unknowable place.
 *
 * ⚠️ ONE VERTICAL EXAGGERATION FOR THE WHOLE SET, stated once. Per-section
 * autoscaling would make the same batter look different at every station,
 * which is exactly the misjudgement a printed section exists to prevent.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {number[][]} guidePts  the guide centreline, world [x, y]
 * @param {{baseline?: Float32Array|null, spacing?: number, width?: number,
 *          site?: string, crs?: string, provenance?: string}} [opts]
 */
export function chainageSectionsSVG(dem, guidePts, opts = {}) {
  const { total, s: cum } = stations(guidePts);
  if (!(total > 0) || guidePts.length < 2) return "";
  // A spacing that lands 5–12 sections, rounded to a settable figure.
  const spacing = opts.spacing || niceScale(total / 8);
  const width = opts.width || Math.min(24, Math.max(8, total / 3));

  // The world point and direction at one chainage.
  const at = (st) => {
    let i = 0;
    while (i + 2 < guidePts.length && cum[i + 1] < st) i++;
    const seg = Math.max(0, Math.min(guidePts.length - 2, i));
    const L = cum[seg + 1] - cum[seg];
    const t = L > 0 ? (st - cum[seg]) / L : 0;
    const dx = guidePts[seg + 1][0] - guidePts[seg][0];
    const dy = guidePts[seg + 1][1] - guidePts[seg][1];
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: guidePts[seg][0] + t * dx, y: guidePts[seg][1] + t * dy,
      ux: dx / len, uy: dy / len,
    };
  };

  // Sample every station first: the shared z-range and the shared
  // exaggeration come from the whole set, not from any one section.
  const secs = [];
  for (let st = 0; st <= total + 1e-6; st += spacing) {
    const p = at(Math.min(st, total));
    // Perpendicular, LEFT of the direction of travel first: looking along
    // the chainage, left is on the left of the sheet.
    const lx = -p.uy, ly = p.ux;
    const a = [p.x + lx * width / 2, p.y + ly * width / 2];
    const b = [p.x - lx * width / 2, p.y - ly * width / 2];
    const prof = sampleSection(dem, a, b, { baseline: opts.baseline || null });
    const areas = opts.baseline ? sectionAreas(prof) : null;
    secs.push({ st: Math.min(st, total), prof, areas });
  }

  let zlo = Infinity, zhi = -Infinity;
  for (const s of secs) {
    for (const v of s.prof.now) if (Number.isFinite(v)) { zlo = Math.min(zlo, v); zhi = Math.max(zhi, v); }
    for (const v of s.prof.was) if (Number.isFinite(v)) { zlo = Math.min(zlo, v); zhi = Math.max(zhi, v); }
  }
  if (!Number.isFinite(zlo)) { zlo = 0; zhi = 1; }
  const relief = Math.max(0.5, zhi - zlo);

  // ── the sheet ────────────────────────────────────────────────────────────
  const PAD = 22, SHEET_W = 760;
  const bandW = SHEET_W - PAD * 2 - 26;   // 26 for the areas column
  const mmPerM = bandW / width;
  // One exaggeration for the set: enough to read, never more than 4×.
  const ex = Math.min(4, Math.max(1, (width / relief) / 5));
  const bandH = relief * mmPerM * ex + 8;
  const TITLE = 26;
  const SHEET_H = PAD + TITLE + secs.length * (bandH + 7) + 26 + PAD;

  const vScale = niceScale((width / bandW) * 1000 / ex);
  const hScale = niceScale((width / bandW) * 1000);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}mm" `
    + `height="${SHEET_H.toFixed(1)}mm" viewBox="0 0 ${SHEET_W} ${SHEET_H.toFixed(1)}">`);
  parts.push(`<style>${STYLE}</style>`);
  parts.push(`<text class="ttl" x="${PAD}" y="${(PAD + 8).toFixed(1)}">`
    + `CHAINAGE SECTIONS</text>`);
  parts.push(`<text class="sub" x="${PAD}" y="${(PAD + 16).toFixed(1)}">`
    + `${esc(opts.site || "")} · ${esc(opts.crs || "")} · `
    + `${secs.length} sections at ${spacing} m chainage over ${total.toFixed(1)} m · `
    + `${width.toFixed(0)} m wide, LOOKING ALONG THE CHAINAGE — left is left · `
    + `1:${hScale} across, 1:${vScale} up (${ex.toFixed(1)}× exaggerated) · `
    + `existing dashed, proposed solid</text>`);

  secs.forEach((sec, i) => {
    const top = PAD + TITLE + i * (bandH + 7);
    const X = (s) => PAD + s * mmPerM;
    const Yz = (v) => top + 4 + (zhi - v) * mmPerM * ex;
    const line = (arr, cls) => {
      let d = "", pen = false;
      for (let k = 0; k < arr.length; k++) {
        const v = arr[k];
        if (!Number.isFinite(v)) { pen = false; continue; }
        d += `${pen ? "L" : "M"}${X(sec.prof.s[k]).toFixed(2)} ${Yz(v).toFixed(2)}`;
        pen = true;
      }
      if (d) parts.push(`<path class="${cls}" d="${d}"/>`);
    };
    parts.push(`<rect class="ax" fill="none" x="${PAD}" y="${top.toFixed(2)}" `
      + `width="${bandW.toFixed(2)}" height="${bandH.toFixed(2)}"/>`);
    if (opts.baseline) line(sec.prof.was, "was");
    line(sec.prof.now, "now");
    // The centreline: where the guide itself crosses this section.
    const cxm = X(width / 2);
    parts.push(`<path class="div" d="M${cxm.toFixed(2)} ${top.toFixed(2)}`
      + `V${(top + bandH).toFixed(2)}"/>`);
    parts.push(`<text class="lbl" x="${PAD - 2}" y="${(top + 3.4).toFixed(2)}" `
      + `text-anchor="end">L</text>`);
    parts.push(`<text class="lbl" x="${(PAD + bandW + 2).toFixed(2)}" `
      + `y="${(top + 3.4).toFixed(2)}">R</text>`);
    // CH 0+00 chainage convention: hundreds + remainder.
    const ch = `CH ${Math.floor(sec.st / 100)}+${(sec.st % 100).toFixed(1).padStart(4, "0")}`;
    parts.push(`<text class="lbl" x="${PAD}" y="${(top - 1.2).toFixed(2)}">${ch}</text>`);
    if (sec.areas) {
      parts.push(`<text class="axl" x="${(PAD + bandW + 3).toFixed(2)}" `
        + `y="${(top + bandH / 2 - 1).toFixed(2)}">cut ${sec.areas.cut.toFixed(1)} m²</text>`);
      parts.push(`<text class="axl" x="${(PAD + bandW + 3).toFixed(2)}" `
        + `y="${(top + bandH / 2 + 3).toFixed(2)}">fill ${sec.areas.fill.toFixed(1)} m²</text>`);
    }
  });

  parts.push(`<text class="sub" x="${PAD}" y="${(SHEET_H - 8).toFixed(1)}">`
    + `Areas on each section, never volumes — a volume is area × spacing, and `
    + `that multiplication belongs to whoever holds the spacing. `
    + `${esc(opts.provenance || PROVENANCE)}</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}
