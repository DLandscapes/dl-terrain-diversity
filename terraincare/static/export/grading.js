// @ts-check
// THE GRADING PLAN — the drawing this whole tool has been producing all along.
//
// A section says what happened along one line. A grading plan says what happened
// to the site, and it is the drawing an earthworks contractor is actually given:
// proposed contours over existing ones, the disturbed ground hatched, levels
// written where they matter, and a frame with a scale and a north point so the
// sheet means something away from the screen that drew it.
//
// ⚠️ EXISTING THIN AND DASHED, PROPOSED SOLID AND HEAVY. This is the convention,
// it is the same rule the section sheet and its key plan already follow, and it
// is what lets one drawing carry two surfaces without a key. Cut and fill are
// told apart by HATCH DIRECTION rather than by tone, because the A1 sheet this
// belongs to is deliberately greyscale and two greys photocopy to one.
//
// ⚠️ THE EXISTING SURFACE IS DRAWN ONLY WHERE IT MOVED. On ground nobody has
// touched the two sets of contours are identical, and a dashed line under every
// solid one doubles the ink to say nothing — worse, it reads as a design that
// changed nothing rather than as ground that was never designed.
//
// ⚠️ NO VOLUMES ON THIS SHEET. A plan carries areas and levels; the ledger is
// the only place in this tool a volume comes from, because it integrates the
// whole surface rather than any one drawing of it. The same rule sectionAreas
// keeps for the same reason.

import { contourSegments } from "../contours.js";
import { symbolField, strideFor, symbolLegend } from "../symbols.js";

// Shared with the derivative sheets (export/derivatives.js) — one vocabulary
// for sheet furniture, not a copy per drawing.
export const esc = (s) => String(s).replace(/[<>&"]/g,
  (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] || c));

/** A round-ish denominator for a printed scale. */
export function niceScale(v) {
  const steps = [1, 2, 2.5, 5, 10];
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const s of steps) if (v <= s * mag * 1.0001) return s * mag;
  return 10 * mag;
}

/**
 * Vector hatching over the cells where the ground moved, one direction per sign.
 *
 * ⚠️ SCANLINES CLIPPED TO A MASK, NOT A FILLED POLYGON. Turning a raster of
 * disturbed cells into closed rings means assembling marching-squares segments
 * into ordered loops and getting the nesting right for every hole — real work,
 * and every bug in it produces a plausible-looking wrong shape. Walking a family
 * of parallel lines and emitting the runs that fall over the right cells gives
 * true vector hatch with no topology to get wrong, and it clips to the ragged
 * edge of the disturbance exactly.
 *
 * @param {{nrows:number, ncols:number, cell:number}} dem
 * @param {Float32Array} dz  now − was, per cell
 * @param {number} sign  −1 for cut, +1 for fill
 * @param {{spacing:number, tol:number, dir:number}} o
 *   `spacing` metres between hatch lines, `dir` +1 for 45°, −1 for −45°
 */
function hatchRuns(dem, dz, sign, o) {
  const { nrows, ncols, cell } = dem;
  const W = ncols * cell, H = nrows * cell;
  const step = cell * 0.5;
  const at = (x, y) => {
    const c = Math.floor(x / cell), r = Math.floor((H - y) / cell);
    if (r < 0 || c < 0 || r >= nrows || c >= ncols) return 0;
    const v = dz[r * ncols + c];
    return Number.isFinite(v) ? v : 0;
  };
  const out = [];
  // Two 45° families, one per sign:
  //   dir +1 :  y = x − k , so k = x − y and runs from −H to W
  //   dir −1 :  y = k − x , so k = x + y and runs from 0 to W + H
  // Adjacent lines of either family are |Δk|/√2 apart on the ground, so the
  // sweep step is the wanted spacing times √2.
  const kMin = o.dir > 0 ? -H : 0;
  const kMax = o.dir > 0 ? W : W + H;
  const dk = Math.max(o.spacing, cell * 0.25) * Math.SQRT2;
  for (let k = kMin; k <= kMax; k += dk) {
    // Only the stretch of the line that is actually over the tile.
    const x0 = o.dir > 0 ? Math.max(0, k) : Math.max(0, k - H);
    const x1 = o.dir > 0 ? Math.min(W, k + H) : Math.min(W, k);
    if (!(x1 > x0)) continue;
    let run = null;
    for (let x = x0; x <= x1; x += step) {
      const y = o.dir > 0 ? x - k : k - x;
      const v = (y < 0 || y > H) ? 0 : at(x, y);
      const on = sign < 0 ? v < -o.tol : v > o.tol;
      if (on) {
        if (!run) run = [x, y, x, y];
        else { run[2] = x; run[3] = y; }
      } else if (run) { out.push(run); run = null; }
    }
    if (run) out.push(run);
  }
  return out;
}

/**
 * A grading plan as SVG.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {{baseline?: Float32Array|null, interval?: number, site?: string,
 *          crs?: string, provenance?: string, spotStride?: number,
 *          regions?: number[][][][], guide?: number[][],
 *          symbols?: boolean}} [opts]
 *   `regions` is a list of regions, each a list of rings of [x, y] in MAP units.
 *   `guide` is the guide centreline, likewise. `symbols` (default true) draws
 *   the depth of change as proportional circles — see the block below.
 * @returns {string}
 */
export function gradingSVG(dem, opts = {}) {
  const { nrows, ncols, cell, z, originX, originY } = dem;
  const W = ncols * cell, H = nrows * cell;
  const was = opts.baseline || null;

  // ── the sheet ────────────────────────────────────────────────────────────
  const PAD = 22, SHEET_W = 760, TITLE = 26;
  const planW = SHEET_W - PAD * 2;
  const mmPerM = planW / W;
  const planH = H * mmPerM;
  const top = PAD + TITLE;
  // North up: local y increases northward, the sheet's y increases downward.
  const X = (x) => PAD + x * mmPerM;
  const Y = (y) => top + (H - y) * mmPerM;

  let zlo = Infinity, zhi = -Infinity;
  for (let i = 0; i < z.length; i++) {
    const v = z[i];
    if (Number.isFinite(v)) { if (v < zlo) zlo = v; if (v > zhi) zhi = v; }
  }
  // Whether any level exists is a fact the KEY needs — a sheet with no
  // measured ground writes no spot levels, so it must not key them either.
  const zAny = Number.isFinite(zlo);
  if (!zAny) { zlo = 0; zhi = 1; }
  const interval = opts.interval || 0.5;
  const hScale = niceScale((W / planW) * 1000);

  // ── what moved ───────────────────────────────────────────────────────────
  // ⚠️ DECIDED ONCE, AND IT GOVERNS THE HATCH, THE EXISTING CONTOURS, THE
  // CAPTION — AND THE KEY. Written as a test inside the hatch block alone, the
  // dashed set was drawn on untouched ground under an identical solid one —
  // double the ink to say nothing, and it reads as a design that changed
  // nothing rather than as ground that was never designed. The suite caught
  // it; the header had already said it. One flag, and neither the title nor
  // the key can promise a set the sheet omits. Computed here, before the
  // header, because the key's height sets the sheet's height.
  let moved = false, hasCut = false, hasFill = false;
  /** @type {Float32Array|null} */
  let dz = null;
  if (was) {
    dz = new Float32Array(z.length);
    for (let i = 0; i < z.length; i++) {
      const a = z[i], b = was[i];
      dz[i] = (Number.isFinite(a) && Number.isFinite(b)) ? a - b : NaN;
      if (dz[i] < -0.02) hasCut = true;
      else if (dz[i] > 0.02) hasFill = true;
    }
    moved = hasCut || hasFill;
  }

  // ── the depth circles' shared facts ──────────────────────────────────────
  // The field itself is drawn later; the KEY needs the reference set and its
  // largest diameter now, because that diameter sets the key's height.
  const wantSymbols = !!(dz && moved && (opts.symbols ?? true));
  let maxAbs = 0;
  /** @type {Float32Array|null} */
  let absDz = null;
  if (wantSymbols && dz) {
    absDz = new Float32Array(dz.length);
    for (let i = 0; i < dz.length; i++) {
      const v = dz[i];
      absDz[i] = Number.isFinite(v) ? Math.abs(v) : NaN;
      if (Number.isFinite(v) && Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
  }
  const symStride = strideFor(dem);
  const refs = wantSymbols
    ? symbolLegend(0, maxAbs, { stride: symStride, cell, maxFraction: 0.9 })
      .filter((e) => e.v > 0)
    : [];

  // ── the key's geometry, before the header needs the sheet height ─────────
  // One framed band under the plan: line samples, earthwork swatches, the
  // depth circles and the scale bar, each row present ONLY when the drawing
  // above it shows that thing — the same one-flag honesty the caption keeps.
  //
  // ⚠️ EVERY COLUMN IS MEASURED AND THE BAND TAKES THE TALLEST. Sized by eye
  // the first time, the two hatch swatches were laid on the 4.6 mm text rhythm
  // while standing 6.4 mm tall, so they overlapped into one box — and the depth
  // column's identity row landed on the scale bar's own strip. A key whose rows
  // collide is worse than the prose it replaced, because it looks authoritative
  // while being unreadable.
  const hasRegions = !!(opts.regions && opts.regions.length);
  const hasGuide = !!(opts.guide && opts.guide.length > 1);
  const ROW = 4.6;                          // the text rhythm, column 1
  const SW_H = 6.4, SW_ROW = SW_H + 2.4;    // a swatch, and its own rhythm
  const keyRowsA = (moved ? 1 : 0) + 2 + (zAny ? 1 : 0)
    + (hasRegions ? 1 : 0) + (hasGuide ? 1 : 0);
  const keyColA = keyRowsA * ROW;
  const keyColB = ((hasCut ? 1 : 0) + (hasFill ? 1 : 0)) * SW_ROW;
  const maxRefD = refs.length
    ? Math.max(...refs.map((e) => 2 * e.r * mmPerM)) : 0;
  // The circles stand on a baseline, then the open/filled identity row below.
  const keyColC = refs.length ? maxRefD + 7.5 : 0;
  const KEY_TOP = Math.max(keyColA, keyColB, keyColC, 10);
  const KEY_BAR = 13;                       // the scale bar's strip, inside
  const KEY_H = 9 + KEY_TOP + KEY_BAR;      // 9 = the column headers' band
  const FOOT = 8 + KEY_H + 14;
  const SHEET_H = PAD + TITLE + planH + FOOT + PAD;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}mm" `
    + `height="${SHEET_H.toFixed(1)}mm" viewBox="0 0 ${SHEET_W} ${SHEET_H.toFixed(1)}">`);
  parts.push(`<style>
    text { font-family: "Source Sans 3", "Segoe UI", system-ui, sans-serif;
           fill: #1c1a16; font-variant-numeric: tabular-nums; }
    .ttl { font-size: 6px;   font-weight: 700; letter-spacing: 0.28px; }
    .sub { font-size: 3.2px; font-weight: 400; fill: #6b6659; }
    .axl { font-size: 2.8px; font-weight: 400; fill: #6b6659; }
    .spot{ font-size: 2.4px; font-weight: 600; }
    .ax  { fill: none; stroke: #6b6659; stroke-width: 0.18; }
    /* Existing thin and dashed UNDER proposed solid and heavy. */
    .was { fill: none; stroke: #1c1a16; stroke-width: 0.1; stroke-opacity: 0.5;
           stroke-dasharray: 1.1 0.9; }
    .now { fill: none; stroke: #1c1a16; stroke-width: 0.24; }
    /* Every fifth line carries the weight, as an index contour does. */
    .idx { fill: none; stroke: #1c1a16; stroke-width: 0.5; }
    .hcut{ stroke: #1c1a16; stroke-width: 0.13; stroke-opacity: 0.75; }
    .hfil{ stroke: #1c1a16; stroke-width: 0.3;  stroke-opacity: 0.5; }
    /* Depth circles: style, not tone — open photocopies against filled. */
    .symc circle { fill: none; stroke: #1c1a16; stroke-width: 0.18;
                   stroke-opacity: 0.8; }
    .symf circle { fill: #1c1a16; fill-opacity: 0.5; stroke: none; }
    .reg { fill: none; stroke: #1c1a16; stroke-width: 0.45; }
    .gui { fill: none; stroke: #1c1a16; stroke-width: 0.5;
           stroke-dasharray: 4 1.1 0.7 1.1; }
    .bar { stroke: #1c1a16; stroke-width: 0.18; }
    /* The key. Its frame is lighter than the plan's — it is furniture about
       the drawing, not part of it. */
    .key { fill: none; stroke: #6b6659; stroke-width: 0.15; stroke-opacity: 0.7; }
    .keyh{ font-size: 2.8px; font-weight: 700; letter-spacing: 0.18px;
           fill: #6b6659; text-transform: uppercase; }
    /* The nested reference circles are OUTLINES whatever they stand for —
       the identity row below them carries open-vs-filled, and drawing the
       sizes in one of the two identities would say the sizes belong to it. */
    .keyc{ fill: none; stroke: #1c1a16; stroke-width: 0.18; stroke-opacity: 0.8; }
  </style>`);

  // ── title ────────────────────────────────────────────────────────────────
  // ⚠️ THE SUBTITLE NAMES THE DRAWING; THE KEY EXPLAINS ITS MARKS (Marc,
  // 2026-08-19). It used to carry both, which put "existing ground dashed,
  // proposed solid; cut and fill hatched · circles: depth of change, open cut,
  // filled fill" into a 3.2 px run of prose the width of the sheet — a reader
  // at arm's length cannot hold that against the drawing, and a plan's
  // conventions belong in a key they can look BACK at. What stays here is what
  // identifies the sheet: where, in what system, at what scale.
  parts.push(`<text class="ttl" x="${PAD}" y="${(PAD + 8).toFixed(1)}">`
    + `GRADING PLAN</text>`);
  parts.push(`<text class="sub" x="${PAD}" y="${(PAD + 16).toFixed(1)}">`
    + `${esc(opts.site || "")} · ${esc(opts.crs || "")} · `
    + `${W.toFixed(0)} × ${H.toFixed(0)} m at ${cell} m · `
    + `contours ${interval} m, every fifth heavier · scale 1:${hScale} · `
    + `levels in metres`
    + `${moved ? "" : " · nothing has been moved on this ground yet"}</text>`);

  // ── hatching, under everything ───────────────────────────────────────────
  if (was && dz) {
    {
      const spacing = 1.6 / mmPerM;    // ~1.6 mm on the sheet, whatever the scale
      for (const [sign, cls, dir] of [[-1, "hcut", 1], [1, "hfil", -1]]) {
        const runs = hatchRuns(dem, dz, /** @type {number} */ (sign),
          { spacing, tol: 0.02, dir: /** @type {number} */ (dir) });
        if (!runs.length) continue;
        let d = "";
        for (const [x0, y0, x1, y1] of runs) {
          d += `M${X(x0).toFixed(2)} ${Y(y0).toFixed(2)}`
            + `L${X(x1).toFixed(2)} ${Y(y1).toFixed(2)}`;
        }
        parts.push(`<path class="${cls}" d="${d}"/>`);
      }
    }
  }

  // ── the depths, as proportional circles ──────────────────────────────────
  // Marc's Hadseløya technique (digital-landscapes.com, 2017): a terrain
  // attribute as a halftone of circles, each scaled to the normalised value at
  // its sample point, several attributes coexisting because each keeps its own
  // fill-and-stroke identity. Here it carries the ONE quantity this sheet's
  // hatch cannot: HOW MUCH. The hatch says where and which way; a circle whose
  // diameter is the depth of change says how deep, and can be measured against
  // the legend beside the scale bar. ⚠️ OPEN = CUT, FILLED = FILL — the
  // identities are style, not tone, for the same greyscale reason the hatch
  // runs in two directions. Same sampling module the 3-D symbols use
  // (symbols.js), so the sheet and the scene cannot disagree about where a
  // symbol stands or how it scales: centre-anchored stride, NaN gets no
  // circle, diameter linear in the value.
  if (wantSymbols && dz && absDz) {
    const syms = symbolField(dem, absDz, {
      lo: 0, hi: maxAbs, stride: symStride, maxFraction: 0.9,
      // Below the disturbance tolerance is untouched ground, not a small edit.
      threshold: maxAbs > 0 ? 0.02 / maxAbs : 1,
    });
    let cutC = "", fillC = "";
    for (const s of syms) {
      // The sample's own cell, for the SIGN the |dz| field discarded.
      const i = Math.round((H - s.y) / cell) * ncols + Math.round(s.x / cell);
      const el = `<circle cx="${X(s.x).toFixed(2)}" cy="${Y(s.y).toFixed(2)}" `
        + `r="${(s.r * mmPerM).toFixed(2)}"/>`;
      if (dz[i] < 0) cutC += el; else fillC += el;
    }
    if (cutC) parts.push(`<g class="symc">${cutC}</g>`);
    if (fillC) parts.push(`<g class="symf">${fillC}</g>`);
  }

  // ── contours ─────────────────────────────────────────────────────────────
  /** @param {Float32Array} grid @param {string} cls @param {boolean} index */
  const drawContours = (grid, cls, index) => {
    const seg = contourSegments(grid, nrows, ncols, cell, interval, { limit: 2000 });
    let d = "", di = "";
    for (let i = 0; i < seg.segments; i++) {
      const p = i * 6;
      const run = `M${X(seg.positions[p]).toFixed(2)} ${Y(seg.positions[p + 1]).toFixed(2)}`
        + `L${X(seg.positions[p + 3]).toFixed(2)} ${Y(seg.positions[p + 4]).toFixed(2)}`;
      // ⚠️ THE INDEX CONTOUR IS DECIDED BY THE LEVEL, NOT BY COUNTING LINES.
      // Every fifth level from zero, so the heavy lines land on the same
      // elevations whatever the tile's range — which is what makes two sheets of
      // the same site comparable, and is the rule contourLevels already follows.
      const lv = seg.positions[p + 2];
      const heavy = index && Math.abs(Math.round(lv / interval) % 5) === 0;
      if (heavy) di += run; else d += run;
    }
    if (d) parts.push(`<path class="${cls}" d="${d}"/>`);
    if (di) parts.push(`<path class="idx" d="${di}"/>`);
  };
  if (was && moved) drawContours(was, "was", false);
  drawContours(z, "now", true);

  // ── spot levels ──────────────────────────────────────────────────────────
  // ⚠️ A GRID OF LEVELS, NOT A LEVEL PER CELL. A contour says where a height
  // runs; a spot level says what the height IS at a point, which is what gets
  // set out on site. One every few metres is a drawing; one per cell is a wall
  // of digits with a plan somewhere behind it.
  {
    const stride = Math.max(1, Math.round(opts.spotStride
      ?? Math.max(4, Math.round(Math.max(nrows, ncols) / 12))));
    const r0 = Math.floor(((nrows - 1) % stride) / 2);
    const c0 = Math.floor(((ncols - 1) % stride) / 2);
    let t = "";
    for (let r = r0; r < nrows; r += stride) {
      for (let c = c0; c < ncols; c += stride) {
        const v = z[r * ncols + c];
        if (!Number.isFinite(v)) continue;   // no measurement, no level
        const x = X(c * cell), y = Y(H - r * cell);
        t += `<text class="spot" x="${x.toFixed(2)}" y="${(y - 0.8).toFixed(2)}" `
          + `text-anchor="middle">${v.toFixed(2)}</text>`
          + `<path class="ax" d="M${(x - 0.5).toFixed(2)} ${y.toFixed(2)}`
          + `h1M${x.toFixed(2)} ${(y - 0.5).toFixed(2)}v1"/>`;
      }
    }
    parts.push(t);
  }

  // ── the design objects ───────────────────────────────────────────────────
  for (const rings of (opts.regions || [])) {
    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      let d = "";
      ring.forEach(([x, y], i) => {
        d += `${i ? "L" : "M"}${X(x - originX).toFixed(2)} ${Y(y - originY).toFixed(2)}`;
      });
      parts.push(`<path class="reg" d="${d}Z"/>`);
    }
  }
  if (opts.guide && opts.guide.length > 1) {
    let d = "";
    opts.guide.forEach(([x, y], i) => {
      d += `${i ? "L" : "M"}${X(x - originX).toFixed(2)} ${Y(y - originY).toFixed(2)}`;
    });
    parts.push(`<path class="gui" d="${d}"/>`);
  }

  // ── frame, dimensions, north, scale ──────────────────────────────────────
  parts.push(`<rect class="ax" fill="none" x="${PAD}" y="${top.toFixed(2)}" `
    + `width="${planW.toFixed(2)}" height="${planH.toFixed(2)}"/>`);
  const fy = top + planH;
  parts.push(`<text class="axl" x="${(PAD + planW / 2).toFixed(2)}" `
    + `y="${(fy + 5).toFixed(2)}" text-anchor="middle">${W.toFixed(0)} m</text>`);
  parts.push(`<text class="axl" transform="translate(${(PAD - 3).toFixed(2)},`
    + `${(top + planH / 2).toFixed(2)}) rotate(-90)" text-anchor="middle">`
    + `${H.toFixed(0)} m</text>`);

  // ⚠️ NORTH IS UP BECAUSE THE SHEET PUTS IT THERE, and the arrow says so rather
  // than leaving the reader to assume it. Every plan this tool draws is north-up
  // — the top view is entered from the south for exactly that reason.
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
  // ── THE KEY ──────────────────────────────────────────────────────────────
  // ⚠️ A PLAN'S CONVENTIONS BELONG IN A KEY, NOT IN ITS SUBTITLE (Marc,
  // 2026-08-19). Everything the drawing says with a line weight, a hatch
  // direction or a circle is stated here once, at a size a reader can hold
  // against the sheet. Three columns, because the marks fall into three
  // families and mixing them makes a list nobody scans: what the LINES mean,
  // what the EARTHWORK marks mean, and how MUCH the circles stand for. The
  // scale bar joins them inside one frame — it is the fourth thing you look
  // back at, and it was floating loose under the plan.
  //
  // ⚠️ EVERY ROW IS CONDITIONAL ON THE DRAWING ABOVE IT. A key that lists a
  // dashed existing set on a sheet that draws none teaches a convention the
  // reader will then hunt for; on untouched ground the honest key is a short
  // one. This is the same one-flag rule the hatch, the dashed set and the
  // caption already keep, extended to the thing that explains them.
  {
    const ky = fy + 8;                       // the key's own top edge
    const kh = KEY_H;
    // ⚠️ THE KEY IS ONE ADDRESSABLE GROUP, and that is not cosmetic. It draws a
    // sample of every mark the plan uses — including BOTH circle identities on
    // a sheet whose field may legitimately carry only one — so a check that
    // asks "does this drawing show open circles over cut and nothing else"
    // must be able to read the field WITHOUT the key. The suite strips this
    // group before asserting on the field, which is why it is a group at all.
    parts.push(`<g class="keyblock">`);
    parts.push(`<rect class="key" x="${PAD}" y="${ky.toFixed(2)}" `
      + `width="${planW.toFixed(2)}" height="${kh.toFixed(2)}"/>`);

    // Three columns across the sheet's width, generously spaced — the key is
    // read across, not down, so the gutters carry the grouping.
    const colX = [PAD + 6, PAD + planW * 0.36, PAD + planW * 0.66];
    const contentTop = ky + 13.5;
    const head = (x, s) => `<text class="keyh" x="${x.toFixed(2)}" `
      + `y="${(ky + 6.5).toFixed(2)}">${s}</text>`;
    const rowY = (i) => contentTop + i * ROW;
    // A sample of the actual mark, drawn with the SAME class the plan uses, so
    // the key cannot drift from the drawing it explains.
    const swatch = (cls, x, y) => `<path class="${cls}" `
      + `d="M${x.toFixed(2)} ${y.toFixed(2)}h11"/>`;
    const label = (x, y, s) => `<text class="axl" x="${(x + 14).toFixed(2)}" `
      + `y="${(y + 1.1).toFixed(2)}">${s}</text>`;

    // ── column 1: the lines ──────────────────────────────────────────────
    const bits = [head(colX[0], "LINES")];
    {
      let i = 0;
      const line = (cls, text) => {
        const y = rowY(i++);
        bits.push(swatch(cls, colX[0], y), label(colX[0], y, text));
      };
      if (moved) line("was", "existing ground, before this design");
      line("now", `proposed contour, ${interval} m`);
      line("idx", `index contour, every ${(interval * 5).toFixed(1)} m`);
      if (zAny) {
        const y = rowY(i++);
        bits.push(`<path class="ax" d="M${(colX[0] + 5).toFixed(2)} ${y.toFixed(2)}`
          + `h1M${(colX[0] + 5.5).toFixed(2)} ${(y - 0.5).toFixed(2)}v1"/>`);
        bits.push(`<text class="spot" x="${(colX[0] + 5.5).toFixed(2)}" `
          + `y="${(y - 1.4).toFixed(2)}" text-anchor="middle">00.00</text>`);
        bits.push(label(colX[0], y, "spot level, metres above datum"));
      }
      if (hasRegions) line("reg", "region boundary, as drawn");
      if (hasGuide) line("gui", "guide centreline");
    }

    // ── column 2: the earthwork ──────────────────────────────────────────
    // ⚠️ THE SWATCH IS HATCHED AT THE SHEET'S OWN ANGLE AND SPACING, not a
    // token diagonal — a reader matches a key to a drawing by the texture,
    // and a swatch whose hatch runs the other way teaches the wrong sign.
    //
    // ⚠️⚠️ AND THE DIRECTION IS NEGATED, WHICH IS NOT A TYPO. `hatchRuns` takes
    // its `dir` in MAP space, where y increases NORTHWARD, and `Y()` flips that
    // onto a sheet whose y increases downward — so map dir +1 reaches the paper
    // as a line falling to the LEFT. These swatches are written straight into
    // sheet space with no `Y()` between them and the paper, so passing the
    // plan's own `dir` drew both keys as the mirror of the hatch they explain.
    // It shipped that way for one render and was caught by MEASURING both
    // slopes out of the finished SVG, not by looking — mirrored 45° hatching
    // is entirely convincing until you hold it against the drawing. A kernel
    // row now compares the two.
    if (moved) {
      bits.push(head(colX[1], "EARTHWORK"));
      let i = 0;
      /** @param {number} dir the MAP-space direction; negated onto the sheet */
      const patch = (cls, mapDir, text) => {
        const dir = -mapDir;
        const y = contentTop - 4.6 + (i++) * SW_ROW, w = 13, h = SW_H;
        // Lines across the swatch at ±45°, clipped to the box, at the SHEET's
        // own 1.6 mm spacing so the texture matches what it explains.
        let d = "";
        for (let k = -h; k <= w; k += 1.6) {
          const x0 = Math.max(0, k), x1 = Math.min(w, k + h);
          if (!(x1 > x0)) continue;
          const yA = dir > 0 ? (x0 - k) : (h - (x0 - k));
          const yB = dir > 0 ? (x1 - k) : (h - (x1 - k));
          d += `M${x0.toFixed(2)} ${yA.toFixed(2)}L${x1.toFixed(2)} ${yB.toFixed(2)}`;
        }
        bits.push(`<g transform="translate(${colX[1].toFixed(2)},${y.toFixed(2)})">`
          + `<path class="${cls}" d="${d}"/>`
          + `<rect class="ax" x="0" y="0" width="${w}" height="${h}"/></g>`);
        bits.push(`<text class="axl" x="${(colX[1] + 16).toFixed(2)}" `
          + `y="${(y + h / 2 + 1).toFixed(2)}">${text}</text>`);
      };
      if (hasCut) patch("hcut", 1, "cut — ground removed");
      if (hasFill) patch("hfil", -1, "fill — ground added");
    }

    // ── column 3: the depth circles ──────────────────────────────────────
    // ⚠️ NESTED, SHARING A BASELINE, NOT A ROW OF SEPARATE CIRCLES. Concentric
    // circles on one baseline is how a proportional-symbol key is read: the
    // eye compares diameters directly instead of carrying one across a gap.
    // Same reasoning as the axonometric's neighbour-comparison argument.
    if (refs.length) {
      bits.push(head(colX[2], "DEPTH OF CHANGE"));
      const base = contentTop + maxRefD;     // every circle sits on this line
      const cx = colX[2] + maxRefD / 2 + 2;
      for (let k = refs.length - 1; k >= 0; k--) {
        const rr = refs[k].r * mmPerM;
        bits.push(`<circle class="keyc" cx="${cx.toFixed(2)}" `
          + `cy="${(base - rr).toFixed(2)}" r="${rr.toFixed(2)}"/>`);
        bits.push(`<path class="ax" d="M${(cx + rr).toFixed(2)} `
          + `${(base - 2 * rr).toFixed(2)}H${(cx + maxRefD / 2 + 3).toFixed(2)}"/>`);
        bits.push(`<text class="axl" x="${(cx + maxRefD / 2 + 4).toFixed(2)}" `
          + `y="${(base - 2 * rr + 1).toFixed(2)}">`
          + `${refs[k].v.toFixed(refs[k].v < 1 ? 2 : 1)} m</text>`);
      }
      // The two identities, said once, beside the sizes they apply to.
      const iy = base + 5.5;
      bits.push(`<g class="symc"><circle cx="${(colX[2] + 2.4).toFixed(2)}" `
        + `cy="${(iy - 1).toFixed(2)}" r="2"/></g>`);
      bits.push(`<text class="axl" x="${(colX[2] + 6.4).toFixed(2)}" `
        + `y="${iy.toFixed(2)}">open: cut</text>`);
      bits.push(`<g class="symf"><circle cx="${(colX[2] + 32).toFixed(2)}" `
        + `cy="${(iy - 1).toFixed(2)}" r="2"/></g>`);
      bits.push(`<text class="axl" x="${(colX[2] + 36).toFixed(2)}" `
        + `y="${iy.toFixed(2)}">filled: fill</text>`);
    }

    // ── the scale bar, inside the key ────────────────────────────────────
    // ⚠️ A FIFTH OF THE SITE WAS TOO LONG A BAR ONCE IT WAS INSIDE THE KEY.
    // niceScale(W/5) put a 40 m bar across 63 % of this sheet, running under
    // all three columns and reading as a rule rather than as a reference. A
    // twelfth lands on 20 m here — long enough to measure against, short
    // enough to be one item in the band rather than its spine.
    {
      const barM = niceScale(W / 12), bw = barM * mmPerM;
      const sy = ky + kh - 8.6, bx = PAD + 6;
      for (let i = 0; i < 4; i++) {
        bits.push(`<rect class="bar" fill="${i % 2 ? "#1c1a16" : "none"}" `
          + `x="${(bx + i * bw / 2).toFixed(2)}" y="${sy.toFixed(2)}" `
          + `width="${(bw / 2).toFixed(2)}" height="2.2"/>`);
      }
      for (let i = 0; i <= 2; i++) {
        bits.push(`<text class="axl" x="${(bx + i * bw).toFixed(2)}" `
          + `y="${(sy + 6).toFixed(2)}" text-anchor="middle">${(i * barM).toFixed(0)}</text>`);
      }
      bits.push(`<text class="axl" x="${(bx + 2 * bw + 3).toFixed(2)}" `
        + `y="${(sy + 6).toFixed(2)}">metres · 1:${hScale} at this sheet size</text>`);
    }
    parts.push(bits.join(""));
    parts.push(`</g>`);
  }

  // ⚠️ THE FOOTER NO LONGER RE-EXPLAINS THE HATCH — the key does that now, and
  // saying it twice in two registers invites the reader to look for a
  // difference between them. What stays is the standing claim about what this
  // sheet may and may not carry.
  parts.push(`<text class="sub" x="${PAD}" y="${(SHEET_H - 8).toFixed(1)}">`
    + `Areas on the ground, never volumes: `
    + `the ledger is the only place a volume comes from. `
    + `${esc(opts.provenance
      || "DL-TerrainDiversity · a terrain analysis instrument. Not a prediction.")}`
    + `</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}
