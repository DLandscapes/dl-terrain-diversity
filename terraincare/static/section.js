// @ts-check
// SECTIONS — the drawing a landscape architect actually reasons in.
//
// The plan says where; the section says what it costs. Everything else in this
// tool reports earthwork as a number in the ledger or a colour in the cut/fill
// raster, and neither of those shows the SHAPE of the change: how deep the cut
// runs, how far the fill carries, what the batter would have to be, whether the
// new ground meets the old one gently or in a step. A section shows all four at
// once, which is why it is the drawing this discipline never stopped using.
//
// ⚠️ THE PROFILE IS SAMPLED FROM THE TRIANGULATED SURFACE, NOT BY BILINEAR
// INTERPOLATION — the same decision, for the same reason, as contours.js. The
// terrain is DRAWN as two triangles per cell (surface.js splits every quad along
// its anti-diagonal), so a bilinear sample would return elevations that are not
// on the surface anyone is looking at. On a saddle quad the two differ by a
// quarter of the cell's relief, and a section is a MEASURED drawing: it is
// dimensioned, it is exported, and someone will build from it. It has to
// describe the surface the rest of the tool describes.
//
// ⚠️ TWO PROFILES, ALWAYS. A section of the modified ground alone says nothing
// about the work — it is just a hillside. What carries the argument is the pair:
// the original ground and the new ground on one drawing, with the area between
// them separated into cut and fill. That area is the quantity earthworks are
// costed on, and here it comes out of the same surfaces the ledger integrates,
// so the section and the ledger cannot disagree.

/**
 * Elevation of the TRIANGULATED surface at a world point, or NaN outside it.
 *
 * Mirrors the split in surface.js exactly: quads go a-d-b / b-d-e with a=(r,c),
 * b=(r,c+1), d=(r+1,c), e=(r+1,c+1), so the shared edge b-d runs north-east to
 * south-west and `u + v <= 1` is the a side.
 *
 * @param {{z: Float32Array, nrows: number, ncols: number, cell: number,
 *          originX: number, originY: number}} dem
 * @param {Float32Array} z  which elevations to read — the live surface or a baseline
 * @param {number} x @param {number} y
 */
export function facetZAt(dem, z, x, y) {
  const { nrows, ncols, cell, originX, originY } = dem;
  const northY = originY + nrows * cell;
  const fc = (x - originX) / cell - 0.5;
  const fr = (northY - y) / cell - 0.5;
  if (!(fc >= -0.5) || !(fr >= -0.5) || fc > ncols - 0.5 || fr > nrows - 0.5) return NaN;
  const c = Math.min(ncols - 2, Math.max(0, Math.floor(fc)));
  const r = Math.min(nrows - 2, Math.max(0, Math.floor(fr)));
  const u = Math.min(1, Math.max(0, fc - c));
  const v = Math.min(1, Math.max(0, fr - r));
  const i = r * ncols + c;
  const za = z[i], zb = z[i + 1], zd = z[i + ncols], ze = z[i + ncols + 1];
  if (!Number.isFinite(za) || !Number.isFinite(zb)
    || !Number.isFinite(zd) || !Number.isFinite(ze)) return NaN;
  return u + v <= 1
    ? za + (zb - za) * u + (zd - za) * v
    : ze + (zd - ze) * (1 - u) + (zb - ze) * (1 - v);
}

/**
 * @typedef {Object} Profile
 * @property {Float64Array} s   chainage from the start of the line, metres
 * @property {Float64Array} x   world easting per station
 * @property {Float64Array} y   world northing per station
 * @property {Float64Array} now elevation on the current surface
 * @property {Float64Array} was elevation on the baseline, or NaN if none given
 * @property {number} length    total length, metres
 */

/**
 * Sample a section line at the DEM's own resolution.
 *
 * ⚠️ THE STEP IS HALF A CELL, NOT A CELL. A section drawn at exactly the cell
 * pitch can walk along a row of quads and miss the diagonal inside each one, so
 * a ridge running on the split would be sampled only at its ends and the drawing
 * would show a smooth ramp across ground that actually has a crease in it.
 * Half-cell sampling costs nothing here and cannot skip a facet.
 *
 * @param {{z: Float32Array, nrows: number, ncols: number, cell: number,
 *          originX: number, originY: number}} dem
 * @param {number[]} a  [x, y] start
 * @param {number[]} b  [x, y] end
 * @param {{baseline?: Float32Array|null, step?: number}} [opts]
 * @returns {Profile}
 */
export function sampleSection(dem, a, b, opts = {}) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  const step = opts.step ?? dem.cell * 0.5;
  const n = Math.max(2, Math.round(length / step) + 1);
  const s = new Float64Array(n), xs = new Float64Array(n), ys = new Float64Array(n);
  const now = new Float64Array(n), was = new Float64Array(n);
  const base = opts.baseline || null;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const x = a[0] + dx * t, y = a[1] + dy * t;
    s[i] = length * t; xs[i] = x; ys[i] = y;
    now[i] = facetZAt(dem, dem.z, x, y);
    was[i] = base ? facetZAt(dem, base, x, y) : NaN;
  }
  return { s, x: xs, y: ys, now, was, length };
}

/**
 * Cut and fill AREA on the section, in m².
 *
 * ⚠️ AN AREA, NOT A VOLUME, AND THE DIFFERENCE MATTERS ON A DRAWING. This is the
 * area between the two profiles — what a quantity surveyor reads off a section
 * and multiplies by the spacing between sections to get a volume. Reporting it
 * as m³ would invite exactly that multiplication to happen twice. The ledger
 * remains the only place a volume comes from, because the ledger integrates the
 * whole surface rather than one line across it.
 *
 * Trapezoidal between stations, with any station where either surface is missing
 * dropped rather than treated as zero — a hole in the DEM is not flat ground.
 *
 * @param {Profile} p
 * @returns {{cut: number, fill: number, net: number, maxCut: number, maxFill: number}}
 */
export function sectionAreas(p) {
  let cut = 0, fill = 0, maxCut = 0, maxFill = 0;
  for (let i = 0; i + 1 < p.s.length; i++) {
    const d0 = p.now[i] - p.was[i], d1 = p.now[i + 1] - p.was[i + 1];
    if (!Number.isFinite(d0) || !Number.isFinite(d1)) continue;
    if (-d0 > maxCut) maxCut = -d0;
    if (d0 > maxFill) maxFill = d0;
    const w = p.s[i + 1] - p.s[i];
    // A segment that crosses zero contributes to BOTH, split at the crossing —
    // integrating |d| whole would charge the cut side for fill and vice versa,
    // and on a batter that crosses daylight most segments do cross.
    if (d0 === 0 && d1 === 0) continue;
    if ((d0 >= 0) === (d1 >= 0)) {
      const area = 0.5 * (Math.abs(d0) + Math.abs(d1)) * w;
      if (d0 + d1 >= 0) fill += area; else cut += area;
    } else {
      const t = Math.abs(d0) / (Math.abs(d0) + Math.abs(d1));
      const a0 = 0.5 * Math.abs(d0) * (w * t);
      const a1 = 0.5 * Math.abs(d1) * (w * (1 - t));
      if (d0 >= 0) { fill += a0; cut += a1; } else { cut += a0; fill += a1; }
    }
  }
  const last = p.now[p.s.length - 1] - p.was[p.s.length - 1];
  if (Number.isFinite(last)) {
    if (-last > maxCut) maxCut = -last;
    if (last > maxFill) maxFill = last;
  }
  return { cut, fill, net: fill - cut, maxCut, maxFill };
}

/** Section names run A, B, … Z, then AA. Same convention as a drawing sheet. */
export function sectionName(index) {
  let n = index, out = "";
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; }
  while (n >= 0);
  return out;
}

/* --------------------------------------------------------------- the drawing */

const esc = (s) => String(s).replace(/[<>&"]/g,
  (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] || c));

/**
 * Nice tick values across a range, from the 1-2-5 series.
 *
 * ⚠️ THE SAME SERIES THE CONTOUR INTERVAL AND THE SCALE BAR USE. An axis is read
 * off and multiplied in the head exactly as they are, and three different tick
 * rules in one tool would be three different habits to learn. Kept local rather
 * than imported from hud.js so this module stays loadable with no dependencies —
 * it runs in Node in the kernel suite, where hud.js has no business being.
 * @param {number} lo @param {number} hi @param {number} [target]
 */
function niceTicks(lo, hi, target = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n <= 1.5 ? 1 : n <= 3.5 ? 2 : n <= 7.5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) {
    out.push(+v.toFixed(10));
  }
  return out;
}

/** A round-ish number for a printed scale denominator. */
function niceScale(v) {
  const steps = [1, 2, 2.5, 5, 10];
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const s of steps) if (v <= s * mag * 1.0001) return s * mag;
  return 10 * mag;
}

/**
 * A measured section sheet as SVG.
 *
 * ⚠️ VECTOR, NOT A RASTER, AND STATED AT A SCALE. A section is the one drawing
 * from this tool that someone might dimension off, so it leaves as geometry with
 * a stated horizontal and vertical scale rather than as pixels. The exaggeration
 * is printed on every section because a vertically exaggerated section read as
 * true would misjudge every slope on it — the same rule the OBJ exporter follows
 * when it refuses to bake exaggeration silently.
 *
 * ⚠️ THE TWO SURFACES ARE DIFFERENTIATED BY WEIGHT AND DASH, NOT BY COLOUR. This
 * prints, it photocopies, and it goes on an A1 sheet that is deliberately
 * greyscale (see output/poster/README.txt). Existing ground is a fine dashed
 * line, proposed ground a solid heavy one — the drawing convention, and legible
 * with no key.
 *
 * ⚠️ ONE TYPEFACE, FOUR SIZES (2026-08-12, Marc: "the fonts and sizes look very
 * different"). This sheet was set in Georgia — a serif face that appears nowhere
 * else in the project, while the app, the interface and the A1 poster are all
 * Source Sans 3 with Quattrocento Sans, and the poster even ships those two font
 * files. A drawing exported from the tool that does not look like it came from
 * the tool is the one thing a measured sheet should never be. The scale below is
 * deliberately short — title, subtitle, axis, annotation — because a drawing with
 * six sizes reads as six levels of importance and has three.
 *
 * ⚠️ AND IT ANSWERS QUESTIONS, NOT JUST "WHAT SHAPE". The earlier sheet drew the
 * two surfaces, hatched between them and printed a single line of totals, which
 * is a picture with a caption. A section is read for numbers: how high is that,
 * how far along, how steep, how much. So the drawing now carries a labelled
 * elevation axis, a chainage axis, both stated scales, a slope profile beneath
 * it, and a cut/fill balance bar — each of which is a question somebody asks of
 * a section and had to answer by measuring the paper with a ruler.
 *
 * @param {{name: string, profile: Profile, areas: ReturnType<typeof sectionAreas>}[]} sections
 * @param {{exaggeration?: number, site?: string, crs?: string, provenance?: string,
 *          behind?: Profile[][]}} [opts]
 *   `behind` optionally carries, per section, a set of profiles sampled PARALLEL
 *   to the line and further from the viewer — drawn receding, so the sheet shows
 *   the landform standing behind the cut instead of a bare line. Vector, because
 *   the A1 pipeline is.
 *   `plan` optionally carries, per section, the key plan: contours of the ground
 *   either side of the line, already in the section's own coordinates (station
 *   along, offset across) so it lands square to the page. See sectionPlanBand().
 * @returns {string}
 */
export function sectionSVG(sections, opts = {}) {
  // ⚠️ `opts.exaggeration` IS DELIBERATELY UNUSED. It describes the 3-D view;
  // this sheet is plotted from true elevations and states its own scales. It is
  // still accepted so callers need not change, and ignored so the sheet cannot
  // repeat the claim that made it wrong. See the note by `drawnEx` below.
  // ROW is measured, not guessed: the last thing drawn is the balance bar's
  // labels at plotB + 73.5, and plotB is 158 below the row's top.
  const PAD = 22, W = 760, ROW = 236, GAP = 24;
  const AXW = 30;                        // room for the elevation axis
  const plotW0 = W - PAD * 2 - AXW;
  /**
   * ⚠️ THE PLAN STRIP IS DRAWN AT THE SECTION'S OWN SCALE, so its height is a
   * consequence of the section's LENGTH, not a layout choice — a 20 m band under
   * a drawing at 1:100 is 200 mm tall and there is no honest way around it. Rows
   * therefore have different heights and the sheet is laid out by accumulation
   * rather than by a fixed pitch.
   *
   * ⚠️ AND WHERE IT WILL NOT FIT, THE BAND IS NARROWED — never the scale. A short
   * section has a large mm-per-metre, so ±10 m could run to metres of paper.
   * Rescaling the strip on its own would break the alignment with the profile,
   * which is the only reason it is here; showing less ground keeps every
   * millimetre true and the sheet says how much is shown.
   */
  // 260 mm lets the requested ±10 m band survive at any section longer than
  // about 53 m on this sheet; shorter sections narrow, and say so.
  const PLAN_CAP = 260;
  const planFor = (k) => {
    const band = Array.isArray(opts.plan) ? opts.plan[k] : null;
    if (!band || !(band.length > 0)) return null;
    const mmPerM = plotW0 / band.length;
    const shownHalf = Math.min(band.half, (PLAN_CAP / 2) / mmPerM);
    return { band, mmPerM, shownHalf, h: 2 * shownHalf * mmPerM };
  };
  // Measured, not guessed: the plan opens at balY + 24 (which is ROW + 10) and
  // its last mark is the scale-bar figures at h + 25 below that.
  const rowH = (k) => {
    const p = planFor(k);
    return ROW + (p ? p.h + 40 : 0);
  };
  let H = PAD * 2;
  for (let k = 0; k < sections.length; k++) H += rowH(k) + GAP;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" `
    + `viewBox="0 0 ${W} ${H}">`);
  parts.push(`<style>
    text { font-family: "Source Sans 3", "Segoe UI", system-ui, sans-serif;
           fill: #1c1a16; font-variant-numeric: tabular-nums; }
    .ttl  { font-size: 6px;   font-weight: 700; letter-spacing: 0.28px; }
    .sub  { font-size: 3.2px; font-weight: 400; fill: #6b6659; }
    .axl  { font-size: 2.8px; font-weight: 400; fill: #6b6659; }
    .ann  { font-size: 2.8px; font-weight: 600; }
    .ax   { fill: none; stroke: #6b6659; stroke-width: 0.18; }
    .grd  { fill: none; stroke: #6b6659; stroke-width: 0.1; stroke-dasharray: 0.8 1.2; }
    .was  { fill: none; stroke: #1c1a16; stroke-width: 0.22; stroke-dasharray: 1.6 1.1; }
    .now  { fill: none; stroke: #1c1a16; stroke-width: 0.75; stroke-linejoin: round; }
    .bhd  { fill: none; stroke: #1c1a16; stroke-linejoin: round; }
    .cut  { fill: #1c1a16; fill-opacity: 0.13; }
    .fil  { fill: #1c1a16; fill-opacity: 0.30; }
    .slp  { fill: #1c1a16; fill-opacity: 0.18; stroke: #1c1a16; stroke-width: 0.18; }
    .bar  { stroke: #1c1a16; stroke-width: 0.18; }
    /* The key plan. Existing ground thin and dashed UNDER proposed solid and
       heavy — the grading-plan convention, and the same rule the two profiles
       above already follow, so one sheet reads by one habit. */
    .pnow { fill: none; stroke: #1c1a16; stroke-width: 0.2; }
    .pwas { fill: none; stroke: #1c1a16; stroke-width: 0.11; stroke-opacity: 0.55;
            stroke-dasharray: 1.1 0.9; }
    .lvl  { font-size: 2.3px; font-weight: 600; fill: #1c1a16; }
    /* Dash-dot: the drawing convention for a cutting plane. */
    .cutline { fill: none; stroke: #1c1a16; stroke-width: 0.42;
               stroke-dasharray: 4 1.1 0.7 1.1; }
    .arrow   { fill: #1c1a16; }
  </style>`);
  // Hatches: cut and fill are told apart by direction, which survives greyscale
  // printing where two tones of the same grey do not.
  parts.push(`<defs>
    <pattern id="hcut" width="2.2" height="2.2" patternTransform="rotate(45)"
      patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="2.2" stroke="#1c1a16" stroke-width="0.22"/>
    </pattern>
    <pattern id="hfil" width="2.2" height="2.2" patternTransform="rotate(-45)"
      patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="2.2" stroke="#1c1a16" stroke-width="0.45"/>
    </pattern>
  </defs>`);

  let top = PAD;
  sections.forEach((sec, k) => {
    const { profile: p, areas } = sec;
    // Defensive: `behind` is optional, and a caller that supplies the wrong
    // shape should lose the receding lines, not the whole sheet.
    const behind = Array.isArray(opts.behind?.[k]) ? opts.behind[k] : [];
    const plan = planFor(k);
    let zlo = Infinity, zhi = -Infinity;
    for (let i = 0; i < p.s.length; i++) {
      for (const v of [p.now[i], p.was[i]]) {
        if (Number.isFinite(v)) { if (v < zlo) zlo = v; if (v > zhi) zhi = v; }
      }
    }
    // ⚠️ THE RECEDING PROFILES SHARE THE SECTION'S SCALE, they do not set their
    // own. A hill standing behind the cut can be higher than anything on the
    // line, and rescaling to fit it would silently change the vertical scale the
    // sheet has just printed — so they are allowed to run off the top, which is
    // what a real elevation does, and the axis stays true.
    if (!Number.isFinite(zlo)) { zlo = 0; zhi = 1; }
    const relief = Math.max(zhi - zlo, 0.5);
    zlo -= relief * 0.12; zhi += relief * 0.12;

    const plotW = plotW0;
    const plotH = 132;
    const plotY = top + 26;               // top of the plot box
    const plotB = plotY + plotH;          // its baseline
    const chainY = plotB + 11;            // the chainage axis labels
    const slopeY = plotB + 22;            // top of the slope strip
    const slopeH = 26;
    const balY = slopeY + slopeH + 16;    // the balance bar

    const X = (s) => PAD + AXW + (p.length ? (s / p.length) * plotW : 0);
    const Y = (z) => plotB - ((z - zlo) / (zhi - zlo)) * plotH;

    const path = (sArr, arr) => {
      let d = "", pen = false;
      for (let i = 0; i < sArr.length; i++) {
        const v = arr[i];
        if (!Number.isFinite(v)) { pen = false; continue; }
        d += `${pen ? "L" : "M"}${X(sArr[i]).toFixed(2)} ${Y(v).toFixed(2)}`;
        pen = true;
      }
      return d;
    };

    // The area between the surfaces, split so cut and fill hatch differently.
    let band = "";
    for (let i = 0; i + 1 < p.s.length; i++) {
      const n0 = p.now[i], n1 = p.now[i + 1], w0 = p.was[i], w1 = p.was[i + 1];
      if (![n0, n1, w0, w1].every(Number.isFinite)) continue;
      const fillSide = (n0 - w0) + (n1 - w1) >= 0;
      band += `<polygon class="${fillSide ? "fil" : "cut"}" `
        + `fill="url(#${fillSide ? "hfil" : "hcut"})" points="`
        + `${X(p.s[i]).toFixed(2)},${Y(w0).toFixed(2)} `
        + `${X(p.s[i + 1]).toFixed(2)},${Y(w1).toFixed(2)} `
        + `${X(p.s[i + 1]).toFixed(2)},${Y(n1).toFixed(2)} `
        + `${X(p.s[i]).toFixed(2)},${Y(n0).toFixed(2)}"/>`;
    }

    // ── the numbers the sheet is read for ────────────────────────────────────
    // Printed scales. The viewBox is in millimetres, so a metre of ground is
    // plotW/length mm across and plotH/(zhi−zlo) mm up; the denominators follow.
    const hScale = niceScale((p.length / plotW) * 1000);
    const vScale = niceScale(((zhi - zlo) / plotH) * 1000);
    // Bearing of A→B, from north, clockwise — a section is meaningless without
    // knowing which way it looks.
    const bx = p.x[p.x.length - 1] - p.x[0], by = p.y[p.y.length - 1] - p.y[0];
    const bearing = ((Math.atan2(bx, by) * 180) / Math.PI + 360) % 360;

    parts.push(`<g>`);
    parts.push(`<text class="ttl" x="${PAD}" y="${top + 10}">`
      + `SECTION ${esc(sec.name)}–${esc(sec.name)}</text>`);
    // ⚠️⚠️ THE SHEET'S EXAGGERATION IS THE SHEET'S, NOT THE SCENE'S, and the two
    // are unrelated. This drawing is plotted from TRUE elevations — sampleSection
    // reads dem.z — so the 3-D view's vertical exaggeration never touches it. The
    // earlier sheet printed `opts.exaggeration` anyway, which meant a drawing at
    // 1:100 across and 1:200 up announced itself as "1.0×" while being vertically
    // COMPRESSED by half. Every slope read off it would have been wrong in the
    // direction the label denied. The honest figure is the ratio of the two
    // scales the sheet has just printed, and it is derived from them so the three
    // numbers cannot disagree.
    const drawnEx = hScale / vScale;
    const exWord = Math.abs(drawnEx - 1) < 0.005 ? "true to scale"
      : drawnEx > 1 ? `vertical exaggeration ${drawnEx.toFixed(2)}×`
        : `vertically compressed ${(1 / drawnEx).toFixed(2)}×`;
    parts.push(`<text class="sub" x="${PAD}" y="${top + 18}">`
      + `length ${p.length.toFixed(1)} m · bearing ${bearing.toFixed(0)}° · `
      + `horizontal 1:${hScale} · vertical 1:${vScale} · ${exWord}`
      + ` · plotted from true elevations</text>`);

    // Elevation gridlines and labels.
    for (const z of niceTicks(zlo, zhi, 5)) {
      const y = Y(z);
      if (y < plotY - 0.5 || y > plotB + 0.5) continue;
      parts.push(`<path class="grd" d="M${X(0).toFixed(2)} ${y.toFixed(2)}`
        + `H${X(p.length).toFixed(2)}"/>`);
      parts.push(`<text class="axl" x="${(PAD + AXW - 3).toFixed(2)}" `
        + `y="${(y + 1).toFixed(2)}" text-anchor="end">${z.toFixed(1)}</text>`);
    }
    parts.push(`<text class="axl" x="${PAD}" y="${(plotY - 3).toFixed(2)}">m</text>`);

    // ⚠️ THE LANDFORM BEHIND THE CUT, IN VECTOR. Drawn FIRST so the section's own
    // lines sit in front of it, and lightened with distance — the only depth cue
    // available on a sheet that must stay greyscale and must stay geometry.
    behind.forEach((q, i) => {
      const t = (i + 1) / (behind.length + 1);
      const w = (0.34 * (1 - t) + 0.1).toFixed(2);
      const o = (0.55 * (1 - t) + 0.12).toFixed(2);
      parts.push(`<path class="bhd" style="stroke-width:${w};stroke-opacity:${o}" `
        + `d="${path(q.s, q.now)}"/>`);
    });

    parts.push(band);
    parts.push(`<path class="was" d="${path(p.s, p.was)}"/>`);
    parts.push(`<path class="now" d="${path(p.s, p.now)}"/>`);

    // The plot box: elevation axis up the left, ground line along the bottom.
    parts.push(`<path class="ax" d="M${X(0).toFixed(2)} ${plotY.toFixed(2)}`
      + `V${plotB.toFixed(2)}H${X(p.length).toFixed(2)}"/>`);

    // Chainage ticks and labels.
    for (const s of niceTicks(0, p.length, 8)) {
      if (s < -1e-9 || s > p.length + 1e-9) continue;
      const x = X(s);
      parts.push(`<path class="ax" d="M${x.toFixed(2)} ${plotB.toFixed(2)}`
        + `v2.4"/>`);
      parts.push(`<text class="axl" x="${x.toFixed(2)}" y="${chainY.toFixed(2)}" `
        + `text-anchor="middle">${s.toFixed(0)}</text>`);
    }
    parts.push(`<text class="axl" x="${X(p.length).toFixed(2)}" `
      + `y="${(chainY + 4.2).toFixed(2)}" text-anchor="end">metres along A–A</text>`);

    // End marks, so the drawing says which end is which without the plan.
    parts.push(`<text class="ann" x="${X(0).toFixed(2)}" y="${(plotY - 3).toFixed(2)}" `
      + `text-anchor="middle">${esc(sec.name)}</text>`);
    parts.push(`<text class="ann" x="${X(p.length).toFixed(2)}" `
      + `y="${(plotY - 3).toFixed(2)}" text-anchor="middle">${esc(sec.name)}</text>`);

    // ── the slope strip ──────────────────────────────────────────────────────
    // ⚠️ SLOPE IS READ OFF THE TRUE GROUND, NOT OFF THE DRAWING. The section
    // above is vertically exaggerated, so every angle on it is a lie by
    // construction — which is exactly why this strip exists and why it is
    // computed from metres rather than measured off the plot.
    {
      let maxSlope = 0, sum = 0, n = 0;
      const slopes = [];
      for (let i = 0; i + 1 < p.s.length; i++) {
        const z0 = p.now[i], z1 = p.now[i + 1];
        const ds = p.s[i + 1] - p.s[i];
        if (!Number.isFinite(z0) || !Number.isFinite(z1) || !(ds > 0)) {
          slopes.push(NaN); continue;
        }
        const deg = Math.atan2(Math.abs(z1 - z0), ds) * 180 / Math.PI;
        slopes.push(deg);
        if (deg > maxSlope) maxSlope = deg;
        sum += deg; n++;
      }
      const cap = Math.max(5, Math.ceil(maxSlope / 5) * 5);
      const SY = (deg) => slopeY + slopeH - (deg / cap) * slopeH;
      let d = `M${X(0).toFixed(2)} ${(slopeY + slopeH).toFixed(2)}`;
      for (let i = 0; i < slopes.length; i++) {
        const v = Number.isFinite(slopes[i]) ? slopes[i] : 0;
        d += `L${X(p.s[i]).toFixed(2)} ${SY(v).toFixed(2)}`
          + `L${X(p.s[i + 1]).toFixed(2)} ${SY(v).toFixed(2)}`;
      }
      d += `L${X(p.length).toFixed(2)} ${(slopeY + slopeH).toFixed(2)}Z`;
      parts.push(`<path class="slp" d="${d}"/>`);
      parts.push(`<path class="ax" d="M${X(0).toFixed(2)} ${slopeY.toFixed(2)}`
        + `V${(slopeY + slopeH).toFixed(2)}H${X(p.length).toFixed(2)}"/>`);
      parts.push(`<text class="axl" x="${(PAD + AXW - 3).toFixed(2)}" `
        + `y="${(slopeY + 3).toFixed(2)}" text-anchor="end">${cap}°</text>`);
      parts.push(`<text class="axl" x="${(PAD + AXW - 3).toFixed(2)}" `
        + `y="${(slopeY + slopeH).toFixed(2)}" text-anchor="end">0°</text>`);
      parts.push(`<text class="sub" x="${PAD}" y="${(slopeY - 3).toFixed(2)}">`
        + `GROUND SLOPE along the section · mean ${(n ? sum / n : 0).toFixed(1)}° · `
        + `steepest ${maxSlope.toFixed(1)}° · measured on the true surface, not off this drawing`
        + `</text>`);
    }

    // ── the cut/fill balance ─────────────────────────────────────────────────
    // ⚠️ AREAS, NOT VOLUMES — see sectionAreas(). A quantity surveyor multiplies
    // these by the spacing between sections; printing m³ here would invite that
    // multiplication to happen twice.
    {
      const total = areas.cut + areas.fill;
      const barW = plotW, barH = 5.5;
      const cutW = total > 0 ? (areas.cut / total) * barW : 0;
      parts.push(`<text class="sub" x="${PAD}" y="${(balY - 3).toFixed(2)}">`
        + `CUT AND FILL — areas on this section, not volumes</text>`);
      if (cutW > 0) {
        parts.push(`<rect class="bar" fill="url(#hcut)" x="${X(0).toFixed(2)}" `
          + `y="${balY.toFixed(2)}" width="${cutW.toFixed(2)}" height="${barH}"/>`);
      }
      if (barW - cutW > 0) {
        parts.push(`<rect class="bar" fill="url(#hfil)" `
          + `x="${(X(0) + cutW).toFixed(2)}" y="${balY.toFixed(2)}" `
          + `width="${(barW - cutW).toFixed(2)}" height="${barH}"/>`);
      }
      const net = areas.fill - areas.cut;
      parts.push(`<text class="axl" x="${X(0).toFixed(2)}" `
        + `y="${(balY + barH + 4).toFixed(2)}">`
        + `cut ${areas.cut.toFixed(2)} m² · deepest ${areas.maxCut.toFixed(2)} m</text>`);
      parts.push(`<text class="axl" x="${(X(0) + barW).toFixed(2)}" `
        + `y="${(balY + barH + 4).toFixed(2)}" text-anchor="end">`
        + `fill ${areas.fill.toFixed(2)} m² · highest ${areas.maxFill.toFixed(2)} m</text>`);
      parts.push(`<text class="ann" x="${(X(0) + barW / 2).toFixed(2)}" `
        + `y="${(balY + barH + 4).toFixed(2)}" text-anchor="middle">`
        + `net ${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(2)} m²</text>`);
    }

    // ── the plan strip ───────────────────────────────────────────────────────
    // ⚠️ ALIGNED WITH THE PROFILE ABOVE IT, WHICH IS THE WHOLE POINT. Same left
    // edge, same width, same metre — so a feature read on the section can be
    // found on the plan by dropping straight down the sheet. That is why the
    // strip is drawn at the section's scale and narrowed rather than rescaled
    // when it will not fit.
    if (plan) {
      const py = balY + 24;
      const { band, mmPerM, shownHalf, h } = plan;
      const PY = (t) => py + (shownHalf - t) * mmPerM;
      const clip = `planclip${k}`;
      parts.push(`<defs><clipPath id="${clip}">`
        + `<rect x="${X(0).toFixed(2)}" y="${py.toFixed(2)}" `
        + `width="${plotW.toFixed(2)}" height="${h.toFixed(2)}"/></clipPath></defs>`);
      parts.push(`<text class="sub" x="${PAD}" y="${(py - 3).toFixed(2)}">`
        + `PLAN — the ground ±${shownHalf.toFixed(0)} m either side of the line, `
        + `contours at ${band.interval} m, drawn at the section's own scale and `
        + `aligned with it`
        + (band.wasSegments ? ` · thin dashed = ground before the design` : "")
        + `</text>`);

      const pathOf = (seg) => {
        let d = "";
        for (let i = 0; i + 3 < seg.length; i += 4) {
          d += `M${X(seg[i]).toFixed(2)} ${PY(seg[i + 1]).toFixed(2)}`
            + `L${X(seg[i + 2]).toFixed(2)} ${PY(seg[i + 3]).toFixed(2)}`;
        }
        return d;
      };

      parts.push(`<g clip-path="url(#${clip})">`);
      // ⚠️ EXISTING GROUND UNDER PROPOSED, THIN AND DASHED UNDER SOLID AND
      // HEAVY. This is the grading-plan convention, and it is the same rule the
      // section above already follows for its two profiles — so one sheet reads
      // by one habit. Drawn FIRST so the proposed lines sit over it.
      if (band.wasSegments) {
        parts.push(`<path class="pwas" d="${pathOf(band.wasSegments)}"/>`);
      }
      parts.push(`<path class="pnow" d="${pathOf(band.segments)}"/>`);
      parts.push(`</g>`);

      // ── contour heights ──────────────────────────────────────────────────
      // ⚠️ ONE LABEL PER LEVEL, PLACED ON A SEGMENT THAT IS ACTUALLY THERE.
      // Labelling at a computed position would put figures on empty paper where
      // a level does not reach; the label rides a real segment, chosen well off
      // the section line so it never collides with it.
      if (band.levels && band.levels.length) {
        /** @type {Map<number, {x:number, y:number, d:number}>} */
        const best = new Map();
        const wantT = shownHalf * 0.62;
        for (let i = 0; i < band.levels.length; i++) {
          const lv = band.levels[i];
          if (!Number.isFinite(lv)) continue;
          const t = (band.segments[i * 4 + 1] + band.segments[i * 4 + 3]) / 2;
          const s = (band.segments[i * 4] + band.segments[i * 4 + 2]) / 2;
          if (Math.abs(t) > shownHalf || s < 2 || s > p.length - 2) continue;
          const d = Math.abs(t - wantT);
          const cur = best.get(lv);
          if (!cur || d < cur.d) best.set(lv, { x: s, y: t, d });
        }
        for (const [lv, at] of best) {
          parts.push(`<text class="lvl" x="${X(at.x).toFixed(2)}" `
            + `y="${(PY(at.y) + 0.9).toFixed(2)}" text-anchor="middle">`
            + `${(+lv.toFixed(3))}</text>`);
        }
      }

      // ── the section line, and which way it looks ─────────────────────────
      // ⚠️ DASH-DOT, THE DRAWING CONVENTION FOR A CUTTING PLANE — the same mark
      // a plan carries to say "the section is taken here", so the strip reads as
      // a key plan rather than as a second drawing that happens to have a line
      // across it.
      parts.push(`<path class="cutline" d="M${X(0).toFixed(2)} ${PY(0).toFixed(2)}`
        + `H${X(p.length).toFixed(2)}"/>`);
      // ⚠️ THE ARROWS POINT THE WAY THE SECTION VIEW LOOKS, which is along the
      // LEFT normal of A→B — the same direction setSectionView takes and the
      // same half of the world it keeps. Drawn at both ends, as a cutting plane
      // is marked, pointing toward the +offset edge, which is the top of this
      // strip.
      const arm = Math.min(h * 0.22, 9);
      for (const s of [0, p.length]) {
        const x = X(s), y0 = PY(0);
        parts.push(`<path class="cutline" style="stroke-dasharray:none" `
          + `d="M${x.toFixed(2)} ${y0.toFixed(2)}V${(y0 - arm).toFixed(2)}"/>`);
        const tipY = y0 - arm, wArr = arm * 0.3;
        parts.push(`<polygon class="arrow" points="`
          + `${x.toFixed(2)},${tipY.toFixed(2)} `
          + `${(x - wArr).toFixed(2)},${(tipY + wArr * 1.5).toFixed(2)} `
          + `${(x + wArr).toFixed(2)},${(tipY + wArr * 1.5).toFixed(2)}"/>`);
      }
      parts.push(`<text class="ann" x="${(X(0) - 2.5).toFixed(2)}" `
        + `y="${(PY(0) + 1).toFixed(2)}" text-anchor="end">${esc(sec.name)}</text>`);
      parts.push(`<text class="ann" x="${(X(p.length) + 2.5).toFixed(2)}" `
        + `y="${(PY(0) + 1).toFixed(2)}">${esc(sec.name)}</text>`);

      // ── the frame, dimensioned ───────────────────────────────────────────
      parts.push(`<rect class="ax" fill="none" x="${X(0).toFixed(2)}" `
        + `y="${py.toFixed(2)}" width="${plotW.toFixed(2)}" height="${h.toFixed(2)}"/>`);
      // Across the band, on the left, with the architectural tick at each end.
      const dimX = X(0) - 7;
      parts.push(`<path class="ax" d="M${dimX.toFixed(2)} ${py.toFixed(2)}`
        + `V${(py + h).toFixed(2)}"/>`);
      for (const yy of [py, py + h]) {
        parts.push(`<path class="ax" d="M${(dimX - 1.4).toFixed(2)} ${(yy + 1.4).toFixed(2)}`
          + `L${(dimX + 1.4).toFixed(2)} ${(yy - 1.4).toFixed(2)}"/>`);
      }
      parts.push(`<text class="axl" transform="translate(${(dimX - 2.5).toFixed(2)},`
        + `${(py + h / 2).toFixed(2)}) rotate(-90)" text-anchor="middle">`
        + `${(2 * shownHalf).toFixed(0)} m</text>`);
      // Along the band, under it.
      const dimY = py + h + 7;
      parts.push(`<path class="ax" d="M${X(0).toFixed(2)} ${dimY.toFixed(2)}`
        + `H${X(p.length).toFixed(2)}"/>`);
      for (const xx of [X(0), X(p.length)]) {
        parts.push(`<path class="ax" d="M${(xx - 1.4).toFixed(2)} ${(dimY + 1.4).toFixed(2)}`
          + `L${(xx + 1.4).toFixed(2)} ${(dimY - 1.4).toFixed(2)}"/>`);
      }
      parts.push(`<text class="axl" x="${(X(p.length / 2)).toFixed(2)}" `
        + `y="${(dimY + 4.2).toFixed(2)}" text-anchor="middle">`
        + `${p.length.toFixed(1)} m</text>`);

      // ── the scale bar ────────────────────────────────────────────────────
      // ⚠️ A GRAPHIC SCALE SURVIVES REPRODUCTION; a printed ratio does not. A
      // sheet photocopied at 94% still carries a bar that measures correctly,
      // and "1:100" on the same sheet is then simply wrong.
      {
        const barM = niceScale(p.length / 5);
        const bw = barM * mmPerM, sy = dimY + 12;
        const bx = X(0);
        for (let i = 0; i < 4; i++) {
          parts.push(`<rect class="bar" fill="${i % 2 ? "#1c1a16" : "none"}" `
            + `x="${(bx + i * bw / 2).toFixed(2)}" y="${sy.toFixed(2)}" `
            + `width="${(bw / 2).toFixed(2)}" height="2.2"/>`);
        }
        for (let i = 0; i <= 2; i++) {
          parts.push(`<text class="axl" x="${(bx + i * bw).toFixed(2)}" `
            + `y="${(sy + 6).toFixed(2)}" text-anchor="middle">`
            + `${(i * barM).toFixed(0)}</text>`);
        }
        parts.push(`<text class="axl" x="${(bx + 2 * bw + 3).toFixed(2)}" `
          + `y="${(sy + 6).toFixed(2)}">metres</text>`);
      }
    }
    parts.push(`</g>`);
    top += rowH(k) + GAP;
  });

  parts.push(`<text class="sub" x="${PAD}" y="${H - 8}">`
    + `${esc(opts.site || "")} · ${esc(opts.crs || "")} · `
    + `existing ground dashed, proposed solid, receding lines are the landform behind the cut · `
    + `${esc(opts.provenance || "DL-TerrainDiversity · a terrain analysis instrument. Not a prediction.")}`
    + `</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}
