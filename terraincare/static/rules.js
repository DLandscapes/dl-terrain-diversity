// @ts-check
// WHERE A MODIFIER APPLIES, DECIDED BY THE GROUND ITSELF.
//
// The first of the four families in DESIGN-controlled-transformation.md, and
// the smallest: a rule mask is an ordinary `Uint8Array` of 0/1 over the DEM
// grid — byte for byte what `rasterise()` already returns and what `levelTo`,
// `batterTo` and `applyPattern` already accept. Nothing downstream changes.
//
// ⚠️ THIS IS THE STEP THAT MAKES EVERY EXISTING MODIFIER TERRAIN-AWARE. The
// twelve stamp patterns are drawn in world XY and are blind to the ground:
// a lozenge lands identically on a flat plane and on a 20 m slope. A rule
// mask does not change what the pattern IS, it changes WHERE it is allowed to
// act — "terrace only where the slope exceeds 15°", "scoop only where the
// wetness index is already high" — which is most of the difference between a
// texture and a design decision.
//
// ⚠️ A RULE IS A CLAIM ABOUT THE SURVEYED GROUND, NOT ABOUT THE DESIGN. Rules
// read the analysis layers, which are computed from the CURRENT surface, so a
// rule re-evaluated after an edit selects different cells. That is correct —
// "where it is steep" means where it is steep now — but it makes the order of
// operations matter, and the interface says so rather than hiding it.
//
// ⚠️ NO RULE MAY INVENT DATA. A cell whose layer value is NaN — TWI on level
// ground, aspect on a flat cell, catchment before the first worker pass — is
// EXCLUDED, never treated as zero. Reading "undefined" as "0 and therefore
// below your threshold" is how a levelled surface would quietly satisfy a
// wetness rule, which is the exact degeneracy this project exists to expose.

import { LANDFORMS } from "./analysis/geomorphons.js";

/**
 * The layers a rule may be written against, and how each is read.
 *
 * `categorical` layers hold class CODES — a geomorphon type, a substrate class
 * — so they are matched by membership rather than by a range. Comparing them
 * with < and > would order categories that have no order, which is the same
 * mistake the legend refuses to make by drawing a key instead of a ramp.
 *
 * ⚠️ A CATEGORICAL LAYER CARRIES ITS CLASS NAMES HERE, and that is the only
 * place they are written down for a rule. The interface builds its class chips
 * from this list and `describeRules` names the same classes from it, so the
 * control and the sentence beside it cannot disagree — and the position in the
 * array IS the class code, which is a contract with `geomorphons.js`, whose
 * LANDFORMS is documented as being "in the order their codes run".
 *
 * ⚠️ `soil` IS DECLARED CATEGORICAL AND HAS NO NAMES HERE ON PURPOSE. The
 * substrate map never crosses the worker boundary — it lives on
 * `state.substrate`, not in `analysis.grids()` — so a rule against it would
 * select nothing and report "not computed yet" about a layer the user can
 * plainly see painted on the model. Wire it into the grids first, then name its
 * classes here and it becomes selectable with no other change.
 *
 * @type {Record<string, {label: string, unit: string, categorical?: boolean,
 *                        dp?: number, classes?: string[]}>}
 */
export const RULE_LAYERS = {
  elevation: { label: "Elevation", unit: " m", dp: 2 },
  slope: { label: "Slope", unit: "°", dp: 1 },
  twi: { label: "TWI · wetness", unit: "", dp: 1 },
  catchment: { label: "Catchment area", unit: " m²", dp: 0 },
  cutfill: { label: "Cut / fill so far", unit: " m", dp: 2 },
  depression: { label: "Depression depth", unit: " m", dp: 2 },
  tri: { label: "Ruggedness", unit: " m", dp: 3 },
  svf: { label: "Sky view factor", unit: "", dp: 2 },
  solar: { label: "Solar radiation", unit: " kWh/m²", dp: 0 },
  wind: { label: "Wind exposure", unit: "", dp: 2 },
  geomorphon: {
    label: "Landform class", unit: "", categorical: true, classes: LANDFORMS,
  },
  soil: { label: "Substrate class", unit: "", categorical: true },
};

/**
 * Build a mask from a set of rules, ANDed together.
 *
 * ⚠️ AND, NOT OR, AND THAT IS THE USEFUL DEFAULT. Rules in this tool read as
 * conditions a place must satisfy — "steep AND not bedrock" — and a designer
 * reaching for OR is usually describing two separate operations. Keeping the
 * combination to one word also keeps the readout honest: the count of cells
 * selected means one thing.
 *
 * @param {{nrows:number, ncols:number}} dem
 * @param {Record<string, Float32Array|Int32Array|undefined>} grids
 *   the worker's own layer grids, by the same keys RULE_LAYERS uses
 * @param {{layer:string, min?:number, max?:number, classes?:number[]}[]} rules
 * @param {Uint8Array|null} [within] optional mask to intersect with — the drawn
 *   region, so a rule narrows a design decision rather than replacing it
 * @returns {{mask: Uint8Array, count: number, missing: string[]}}
 *   `missing` names any rule whose layer has not been computed yet, so the
 *   caller can say so instead of silently selecting nothing.
 */
export function maskFromRule(dem, grids, rules, within = null) {
  const n = dem.nrows * dem.ncols;
  const mask = new Uint8Array(n);
  const missing = [];
  const active = [];

  for (const r of rules) {
    const g = grids[r.layer];
    if (!g || g.length !== n) { missing.push(r.layer); continue; }
    active.push({ ...r, g, cat: !!RULE_LAYERS[r.layer]?.categorical });
  }
  // No usable rule means no selection — NOT "everything". A rule that could
  // not be evaluated must never widen the operation it was meant to narrow.
  if (!active.length) return { mask, count: 0, missing };

  let count = 0;
  for (let i = 0; i < n; i++) {
    if (within && !within[i]) continue;
    let ok = true;
    for (const r of active) {
      const v = r.g[i];
      // ⚠️ NaN IS "NO ANSWER" AND FAILS EVERY TEST. See the header: reading it
      // as 0 would let a levelled surface satisfy a wetness rule.
      if (!Number.isFinite(v)) { ok = false; break; }
      if (r.cat) {
        if (!r.classes || !r.classes.includes(Math.round(v))) { ok = false; break; }
      } else {
        if (r.min !== undefined && v < r.min) { ok = false; break; }
        if (r.max !== undefined && v > r.max) { ok = false; break; }
      }
    }
    if (ok) { mask[i] = 1; count++; }
  }
  return { mask, count, missing };
}

/**
 * The bounding rectangle of a mask, in the shape every consumer here expects.
 *
 * ⚠️ AN EMPTY MASK RETURNS r0 > r1, deliberately — the same convention
 * `batterTo` uses for an empty batter, so a caller that unions this with
 * another rect gets the other rect back rather than dragging row 0 and column
 * 0 into every repaint.
 * @param {{nrows:number, ncols:number}} dem
 * @param {Uint8Array} mask
 */
export function maskRect(dem, mask) {
  let r0 = dem.nrows, r1 = -1, c0 = dem.ncols, c1 = -1;
  for (let r = 0; r < dem.nrows; r++) {
    for (let c = 0; c < dem.ncols; c++) {
      if (!mask[r * dem.ncols + c]) continue;
      if (r < r0) r0 = r; if (r > r1) r1 = r;
      if (c < c0) c0 = c; if (c > c1) c1 = c;
    }
  }
  return { r0, r1, c0, c1 };
}

/**
 * A human sentence for a rule set — shown beside the control, because a mask
 * covering 12 % of the site is a fact the designer has to be able to check.
 * @param {{layer:string, min?:number, max?:number, classes?:number[]}[]} rules
 */
export function describeRules(rules) {
  if (!rules.length) return "no rule — the whole region";
  return rules.map((r) => {
    const m = RULE_LAYERS[r.layer];
    if (!m) return r.layer;
    if (m.categorical) {
      const codes = r.classes || [];
      if (!codes.length) return `${m.label} — no class chosen, so nothing`;
      // ⚠️ NAMED, NOT NUMBERED. "Landform class in {4, 6}" asks the reader to
      // hold a lookup table in their head about the one layer in this tool
      // whose whole point is that it reports a NAME rather than an index.
      const named = codes.map((c) => (m.classes && m.classes[c]) || `class ${c}`);
      return `${m.label}: ${named.join(", ")}`;
    }
    const dp = m.dp ?? 2;
    const lo = r.min !== undefined ? `${r.min.toFixed(dp)}${m.unit}` : null;
    const hi = r.max !== undefined ? `${r.max.toFixed(dp)}${m.unit}` : null;
    if (lo && hi) return `${m.label} ${lo}–${hi}`;
    if (lo) return `${m.label} above ${lo}`;
    if (hi) return `${m.label} below ${hi}`;
    return m.label;
  }).join(" · and · ");
}
