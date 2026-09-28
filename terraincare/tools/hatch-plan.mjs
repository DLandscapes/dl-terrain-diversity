// @ts-check
// AN ATTRIBUTE AS LINEWORK — no colour ramp, no grey levels, one ink.
//
// Marc, 2026-09-08, for the right half of the 16:9 film: "an orthographic map
// projection of 2-4 attributes displayed in black and white hatches or linework
// which basically shows an increase or decrease in for example the closed
// depressions, the TWI".
//
// ⚠️⚠️ THIS EXISTS BECAUSE DESATURATION IS A MEASURED FAILURE. Greying the
// diverging ramps puts driest at grey 45 and wettest at grey 37 — a separation
// of 8 where about 40 is needed (2026-08-27). Hatching does not encode value as
// a TONE at all; it encodes it as the NUMBER OF LINES PER UNIT LENGTH. Density
// survives any reproduction that keeps black black and white white, including a
// projector with the contrast wound down and a photocopy of a photograph of a
// screen. That is the whole argument for the technique, and it is the same one
// as the proportional circles: the datum is a geometry, not a colour.
//
// ⚠️ THE HATCH IS A UNIFORM LATTICE SPLIT N WAYS, not N lattices of different
// spacing. Class k is drawn by sub-lattices 0..k-1, all sharing one period P, at
// offsets j*P/N. So class k has exactly k lines per P and the spacing is P/k —
// density is LINEAR in the class and every step looks like the same kind of
// step. Independent spacings (16, 8, 4, 2 px, say) double at each step and read
// as four unrelated textures rather than one scale.
//
// ⚠️ ROW 0 IS NORTH. y = 0 in the output is the top of the image and row 0 of
// the grid, so these plans are north-up. demogrid.js once read rows south-up and
// the mistake survived a render check, because a flipped map of a rough surface
// still looks like a map of a rough surface.
//
// ⚠️⚠️ THE DOMAIN IS HELD FROM CASE 1 AND NEVER RECOMPUTED PER STATE. The matrix
// sheet's own convention ("a domain held from case 1"), and it is the difference
// between a comparison and a decoration: a scale that restretches itself to each
// surface would show every ground as equally varied, which is precisely the
// claim under test.
//
// Usage:
//   node tools/hatch-plan.mjs --contact   write a 7-state x 3-attribute sheet
//
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { analyse } from "../static/analysis/indices.js";
import { buildStates } from "./morph-states.mjs";

/** Sub-lattices per attribute. 5 gives four visible steps above white. */
export const CLASSES = 5;

/**
 * Percentile domain over the finite values of a grid.
 * @param {Float32Array} g @param {number} loP @param {number} hiP
 */
export function percentileDomain(g, loP = 2, hiP = 98) {
  const v = [];
  for (const x of g) if (Number.isFinite(x)) v.push(x);
  if (!v.length) return [0, 1];
  v.sort((a, b) => a - b);
  const at = (p) => v[Math.min(v.length - 1, Math.max(0,
    Math.round((p / 100) * (v.length - 1))))];
  const lo = at(loP), hi = at(hiP);
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/**
 * Box-blur a field by `rad` cells, ignoring non-finite cells.
 *
 * ⚠️ THIS IS GENERALISATION AND IT IS DECLARED, NOT HIDDEN. TWI is a thin
 * channel network: hatched raw, every scan line crosses in and out of the wet
 * class every few cells and the result is a field of dashes that reads as noise
 * rather than as drainage. Hatching IS a generalisation — a hatch cell says
 * "about this wet around here" — so the field is generalised explicitly, by a
 * stated radius, instead of being left to fragment and calling the fragments
 * data. The radius appears in the caption for the same reason.
 *
 * @param {Float32Array} g @param {number} nrows @param {number} ncols
 * @param {number} rad cells; 0 returns the input untouched
 */
export function blurField(g, nrows, ncols, rad) {
  if (!rad) return g;
  const t = new Float32Array(g.length);
  const o = new Float32Array(g.length);
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      let s = 0, n = 0;
      for (let d = -rad; d <= rad; d++) {
        const cc = c + d;
        if (cc < 0 || cc >= ncols) continue;
        const v = g[r * ncols + cc];
        if (Number.isFinite(v)) { s += v; n++; }
      }
      t[r * ncols + c] = n ? s / n : NaN;
    }
  }
  for (let c = 0; c < ncols; c++) {
    for (let r = 0; r < nrows; r++) {
      let s = 0, n = 0;
      for (let d = -rad; d <= rad; d++) {
        const rr = r + d;
        if (rr < 0 || rr >= nrows) continue;
        const v = t[rr * ncols + c];
        if (Number.isFinite(v)) { s += v; n++; }
      }
      o[r * ncols + c] = n ? s / n : NaN;
    }
  }
  return o;
}

/**
 * Render one attribute as hatch linework.
 *
 * @param {Float32Array} g          one value per cell, row-major, row 0 = north
 * @param {number} nrows @param {number} ncols
 * @param {{w:number, h:number, domain:[number,number], angle?:number,
 *          period?:number, stroke?:number, solid?:boolean, blur?:number}} opts
 * @returns {{svg:string, lines:number, ink:number}}
 */
export function hatch(g0, nrows, ncols, opts) {
  const { w, h, domain } = opts;
  const angle = opts.angle ?? 0;          // 0 = horizontal, 45 = down-right
  const P = opts.period ?? 15;            // px, the full lattice period
  const stroke = opts.stroke ?? 0.9;
  const [lo, hi] = domain;
  const g = opts.solid ? g0 : blurField(g0, nrows, ncols, opts.blur ?? 0);

  /** class 0..CLASSES-1; 0 draws nothing, so the lowest band stays white. */
  const classAt = (x, y) => {
    const c = Math.min(ncols - 1, Math.max(0, Math.floor((x / w) * ncols)));
    const r = Math.min(nrows - 1, Math.max(0, Math.floor((y / h) * nrows)));
    const v = g[r * ncols + c];
    if (!Number.isFinite(v)) return 0;
    const t = (v - lo) / (hi - lo);
    return Math.min(CLASSES - 1, Math.max(0, Math.floor(t * CLASSES)));
  };

  if (opts.solid) {
    // A binary field: one rect per run of set cells, at cell resolution.
    const parts = [];
    let ink = 0;
    const sx = w / ncols, sy = h / nrows;
    for (let r = 0; r < nrows; r++) {
      let c = 0;
      while (c < ncols) {
        if (!(g[r * ncols + c] > 0)) { c++; continue; }
        let c1 = c;
        while (c1 + 1 < ncols && g[r * ncols + c1 + 1] > 0) c1++;
        parts.push(`M${(c * sx).toFixed(2)} ${(r * sy).toFixed(2)}`
          + `h${((c1 - c + 1) * sx).toFixed(2)}v${sy.toFixed(2)}`
          + `h${(-(c1 - c + 1) * sx).toFixed(2)}z`);
        ink += (c1 - c + 1);
        c = c1 + 1;
      }
    }
    return {
      svg: `<path d="${parts.join("")}" fill="#000" stroke="none"/>`,
      lines: parts.length, ink: ink / (nrows * ncols),
    };
  }

  const step = w / ncols;                 // sample once per cell across
  const segs = [];
  let drawn = 0, inkLen = 0;

  /**
   * ⚠️ INK IS MEASURED AS LENGTH x WIDTH OVER AREA, NOT AS A SEGMENT COUNT.
   * The first version reported `segments / samples`, which is a FRAGMENTATION
   * measure wearing the name of a density one: the smoothed ground drew 95 long
   * unbroken lines and scored 0.5%, while the surveyed ground drew 887 dashes of
   * almost no length and scored 4.3% — the exact opposite of what both look
   * like. The number existed to check that the drawing reads, so a number that
   * disagrees with the eye is worse than none.
   */
  const emit = (pts) => {
    let i = 0;
    while (i < pts.length) {
      if (!pts[i][2]) { i++; continue; }
      let j = i;
      while (j + 1 < pts.length && pts[j + 1][2]) j++;
      const x0 = pts[i][0], y0 = pts[i][1], x1 = pts[j][0], y1 = pts[j][1];
      segs.push(`M${x0.toFixed(1)} ${y0.toFixed(1)}L${x1.toFixed(1)} ${y1.toFixed(1)}`);
      inkLen += Math.hypot(x1 - x0, y1 - y0);
      drawn++;
      i = j + 1;
    }
  };

  for (let j = 1; j < CLASSES; j++) {
    const off = (j * P) / CLASSES;
    if (angle === 0) {
      for (let y = off; y < h; y += P) {
        const pts = [];
        for (let x = 0; x <= w; x += step) {
          pts.push([x, y, classAt(x, y) >= j]);
        }
        emit(pts);
      }
    } else {
      // 45 degrees, down-right. Lines of constant (x - y), spaced P apart along
      // their normal, so the perceived density matches the horizontal case.
      const d = P * Math.SQRT2;
      // ⚠️ THE SUB-LATTICE OFFSET GOES INTO THE START OF k. Without it every
      // class drew the SAME family of diagonals on top of itself, so classes 1-4
      // were one texture and the scale had one step instead of four.
      for (let k = -h + off * Math.SQRT2; k < w + h; k += d) {
        const pts = [];
        const t0 = Math.max(-k, 0);
        const len = Math.min(w - k, h) - t0;
        if (len <= 0) continue;
        for (let t = t0; t <= t0 + len; t += step) {
          const x = k + t, y = t;
          if (x < 0 || x > w || y < 0 || y > h) continue;
          pts.push([x, y, classAt(x, y) >= j]);
        }
        emit(pts);
      }
    }
  }

  return {
    svg: `<path d="${segs.join("")}" fill="none" stroke="#000"`
      + ` stroke-width="${stroke}" stroke-linecap="butt"/>`,
    lines: drawn, ink: (inkLen * stroke) / (w * h),
  };
}

/** The three attributes, with how each is drawn. */
/**
 * ⚠️ FIXED, NOT A PERCENTILE. "Flat" is a construction fact, not a relative one:
 * ground under 8 degrees is ground you can stand a machine on, on every surface
 * here and on any other. Same reasoning as indices.js's TRI_BINS — a class that
 * restretches itself per frame reports nothing across a morph.
 */
export const FLAT_DEG = 8;

export const ATTRS = [
  // ⚠️⚠️ NEITHER TWI NOR FLOW ACCUMULATION SURVIVES THIS SEQUENCE, AND THE
  // MEASUREMENT SAYS SO TWICE. On the uniform-terraced ground TWI is defined on
  // 54.0 % of cells, and flow accumulation is exactly 1 — nothing routed through
  // it — on 54.0 %. One cause, two symptoms: a flat tread has no slope, so
  // ln(a/tanb) has nothing to divide by and the router has nowhere downhill to
  // send water. TWI fails loudly as NaN; accumulation fails SILENTLY as 1, which
  // is worse. Either way the panel empties exactly where the gesture happened,
  // and in a silent film an empty panel reads as "none" rather than "undefined".
  //
  // So the third attribute is the MECHANISM instead of a casualty of it. The
  // sheet's own conclusion is that both terracing schemes "buy their
  // geodiversity by cutting FLAT TREADS"; flat ground runs 1.2 % of the surveyed
  // hillside to 46.8 % under uniform terracing. It is defined on 100 % of every
  // one of the seven grounds, it moves further than anything else in the set,
  // and it moves for the reason the film is about.
  { id: "flat", label: "Flat ground", note: "slope under " + FLAT_DEG + "°",
    angle: 0, period: 22, blur: 1, domain: [FLAT_DEG, 0] },
  { id: "tri", label: "Ruggedness", note: "terrain ruggedness index",
    angle: 45, period: 22, blur: 1 },
  { id: "dep", label: "Closed depressions", note: "where water is held",
    solid: true },
];

/**
 * Pull the three fields out of one analysis pass.
 *
 * ⚠️ ACCUMULATION IS TAKEN AS log10. Raw, it runs 1 to 4,428 with a median of
 * 13.5 and a 99th percentile of 376 — linear classes would put every cell except
 * the trunk channel in class 0 and the panel would be one black thread on white
 * paper. The drainage NETWORK is the thing that changes between these grounds,
 * and a network is only visible on a log scale.
 */
export function fieldsOf(dem) {
  const a = analyse(dem);
  let flatCells = 0, n = 0;
  for (const v of a.gradient.slopeDeg) {
    if (!Number.isFinite(v)) continue;
    n++; if (v < FLAT_DEG) flatCells++;
  }
  return {
    flat: a.gradient.slopeDeg, tri: a.tri, dep: a.depressions.depth,
    hollows: a.depressions.depressions.length,
    storage: a.depressions.totalVolume,
    flatShare: n ? flatCells / n : 0,
    geodiversity: a.metrics.geodiversity,
  };
}

/**
 * The domains, taken once from the surveyed ground and then HELD.
 *
 * ⚠️ The matrix sheet's own convention, and the difference between a comparison
 * and a decoration: a scale that restretched itself to each surface would draw
 * every ground as equally varied, which is the claim under test.
 *
 * @param {{acc:Float32Array, tri:Float32Array}} baseFields fields of case 1
 */
export function DOMAINS(baseFields) {
  return {
    // reversed on purpose: FLAT is the high class, so the panel FILLS as the
    // gesture flattens the ground rather than emptying as it would if steepness
    // were the datum. Fixed, never a percentile — see FLAT_DEG.
    flat: /** @type {[number,number]} */ ([FLAT_DEG, 0]),
    tri: percentileDomain(baseFields.tri, 2, 98),
    dep: /** @type {[number,number]} */ ([0, 1]),
  };
}

// ── contact sheet ───────────────────────────────────────────────────────────
function contact() {
  const states = buildStates();
  console.log("analysing " + states.length + " grounds ...");
  const rows = states.map((s) => ({ s, f: fieldsOf(s.dem) }));

  // ⚠️ DOMAIN FROM CASE 1, HELD. See the header.
  const base = rows[0].f;
  const domains = DOMAINS(base);
  console.log("  flat domain " + domains.flat.join(" .. ") + " deg (fixed)");
  console.log("  tri domain " + domains.tri.map((v) => v.toFixed(3)).join(" .. "));

  // ⚠️ RENDERED AT THE SIZE IT WILL BE USED. A hatch is a texture and its
  // legibility is a function of period against panel size, so judging it at
  // 300 px and shipping it at 560 would be judging a different drawing.
  const W = 560, H = 560;
  const cells = [];
  for (const { s, f } of rows) {
    const tds = [];
    for (const a of ATTRS) {
      const r = hatch(f[a.id], s.dem.nrows, s.dem.ncols, {
        w: W, h: H, domain: domains[a.id], angle: a.angle,
        period: a.period, solid: a.solid, blur: a.blur,
      });
      tds.push(`<td><div class="f"><svg width="${W}" height="${H}" `
        + `viewBox="0 0 ${W} ${H}">${r.svg}</svg></div>`
        + `<div class="c">${a.label} · ink ${(r.ink * 100).toFixed(2)}%`
        + (a.blur ? ` · generalised ${a.blur} cells` : "") + `</div></td>`);
    }
    cells.push(`<tr><th>${s.label}<br><span>${s.note}<br>`
      + `${f.hollows} hollows · ${f.storage.toFixed(1)} m³ held<br>`
      + `${(f.flatShare * 100).toFixed(1)}% flat · geodiv ${f.geodiversity.toFixed(4)}</span></th>${tds.join("")}</tr>`);
  }

  const html = `<!doctype html><meta charset="utf-8">
<style>
 body{background:#FDFCF9;color:#14130F;font:13px/1.35 "Source Sans 3",system-ui,sans-serif;margin:22px}
 table{border-collapse:collapse} th{text-align:left;vertical-align:top;width:170px;padding:8px 12px 8px 0;font-size:15px}
 th span{font-weight:400;color:#7C776C;font-size:12px}
 td{padding:0 10px 16px 0}
 .f{border:1px solid #D8D4CA;background:#fff;width:${W}px;height:${H}px}
 .c{color:#7C776C;font-size:11px;margin-top:3px}
 h1{font-size:20px;margin:0 0 4px} p{color:#7C776C;margin:0 0 16px;max-width:900px}
</style>
<h1>Attributes as linework — one ink, density is the datum</h1>
<p>Seven grounds down, three attributes across. Domains are held from
“As surveyed”, so a change of density between rows is a change in the ground and
not a change of scale. Wetness hatches horizontally, ruggedness at 45°,
closed depressions fill solid.</p>
<table>${cells.join("")}</table>`;

  const dir = join(process.cwd(), "..", "output", "video");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "HATCH-contact.html");
  writeFileSync(out, html, "utf8");
  console.log("wrote " + out);
}

const IS_MAIN = !!process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN && process.argv.includes("--contact")) contact();
