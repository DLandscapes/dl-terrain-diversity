// @ts-check
// THE TERRAIN OF ATTRIBUTES — a glyph built by an ordered chain of operations,
// one glyph per sampled cell (Marc's idea, 2026-08-19; prototyped 2026-08-20).
//
// WHAT THIS IS. Every other reading in this tool paints an attribute ONTO the
// ground: a ramp on the surface, a size on a block, a circle on a sheet. The
// ground stays the subject and the attribute is a coat of paint. This inverts
// that. A glyph starts as a bare vertical line standing on a cell, knowing
// nothing, and each step of the chain lets one attribute act on it — turn it,
// tilt it, lengthen it, bend it. What you end up looking at is not terrain with
// data on it; it is a field whose entire form IS the data. The ground is gone
// and its measurements are standing where it was.
//
// ⚠️ AN ORDERED CHAIN, AND ORDER IS MEANING — BUT NOT BETWEEN EVERY PAIR, and
// the difference matters enough to write down. This file first claimed that
// turn-then-tilt was a different shape from tilt-then-turn. It is not, and a
// suite row caught it: `turn` and `tilt` set two independent coordinates of ONE
// direction — a bearing and an inclination — which are read together when a
// segment is finally emitted, so they commute with each other and always will.
//
// What order actually decides is where the EXTENDs fall among them, and what a
// BEND finds already drawn:
//
//   • an extend moved above a turn is emitted before that turn has happened,
//     so it leaves along the old bearing — and a turn BETWEEN two extends
//     elbows the glyph, which is the only way to get an articulated form;
//   • a bend acts on the line as it stands, so before the first extend it has
//     nothing to act on at all.
//
// So the chain is still a LIST that is never sorted or normalised — the same
// rule, for the same reason, as the selection stack — and a row still only
// moves when a hand moves it. The claim beside it is just narrower than the one
// that was written first. ⚠️ THE LESSON: a comment asserting a property is a
// claim, and it is worth exactly as much as the row that checks it.
//
// ⚠️ A ROW THAT HAS NOTHING TO ACT ON IS INERT, AND MUST BE SAID SO. `bend`
// reshapes the line as it stands, so a bend before the first `extend` bends a
// line of zero length and does nothing at all. It is not an error and it is not
// removed — that would silently rewrite the designer's sentence — so it is
// REPORTED, exactly as the selection stack reports the rows above its first
// union. See §5.1 of the phase-11 summary: a note that contradicts the thing
// beside it is worse than no note.
//
// ⚠️ NO ANSWER ANYWHERE IN THE CHAIN, NO GLYPH. The chain is a sentence about a
// cell; a missing word does not make a shorter sentence, it makes a different
// one. So a NaN in ANY row drops the whole glyph rather than skipping that step.
// This is the same rule symbols.js, rules.js and the voxel scale field keep, and
// here it does something the others cannot: aspect is NaN on flat ground (a
// deliberate inherited property — reading it as 0 would make a levelled plane
// report as north-facing), so an aspect-led chain makes a levelled surface
// LITERALLY VANISH. The tool's central finding, drawn by absence.
//
// ⚠️ ASPECT IS DELIBERATELY NOT IN `RULE_LAYERS`, and must not be added there
// to make it selectable here. A bearing is circular: 350°–10° is a perfectly
// ordinary range across north that a min/max pair cannot express, so putting
// aspect in the attribute-rule dropdown would ship a control that is wrong for
// it. It is named here instead, where it is read as a direction rather than
// compared against a threshold.

/** How a value is read. Anything not named here is a plain scalar. */
export const GLYPH_KIND = {
  aspect: "bearing",   // degrees, 0 = north, clockwise — used as a direction
  slope: "angle",      // degrees from horizontal — used as an angle
};

/** Layers this can be driven by that `RULE_LAYERS` does not carry. See above. */
export const GLYPH_EXTRA_LAYERS = {
  aspect: { label: "Aspect", unit: "°", dp: 0 },
};

/**
 * The four operations, in the order the panel offers them.
 *
 * ⚠️ THE KEY IS THE CONTRACT AND THE LABEL IS FOR READING, the same split the
 * selection stack's operators keep — a persisted chain stores `"turn"`, never a
 * glyph or a translated word.
 */
export const GLYPH_OPS = [
  { key: "turn", label: "turn", verb: "turns to face" },
  { key: "tilt", label: "tilt", verb: "leans by" },
  { key: "extend", label: "extend", verb: "grows with" },
  { key: "bend", label: "bend", verb: "bends with" },
];

/** @type {Record<string, {key:string,label:string,verb:string}>} */
export const GLYPH_OP_BY_KEY =
  Object.fromEntries(GLYPH_OPS.map((o) => [o.key, o]));

/** The chain the panel opens on — Marc's own example, read back as geometry. */
export const DEFAULT_CHAIN = [
  { key: "aspect", op: "turn", gain: 1, invert: false },
  { key: "slope", op: "tilt", gain: 1, invert: false },
  { key: "elevation", op: "extend", gain: 1, invert: true },
  { key: "wind", op: "bend", gain: 1, invert: false },
];

/** Steps per `extend`, so a later `bend` has something to curve. */
const STEPS = 6;
/** Most a full-gain bend may deflect the tip, in radians. */
const MAX_BEND = Math.PI * 0.66;
/** Smallest glyph an `extend` will draw, as a fraction of full length. */
const MIN_LEN = 0.12;

const DEG = Math.PI / 180;

/**
 * Unit heading from a bearing and an inclination.
 * `az` is clockwise from north; `incl` is measured FROM VERTICAL, so 0 stands
 * the glyph straight up — which is the state it starts in, knowing nothing.
 * @param {number} az @param {number} incl
 */
export function heading(az, incl) {
  const s = Math.sin(incl);
  return [s * Math.sin(az), s * Math.cos(az), Math.cos(incl)];
}

/**
 * The axis a bend toward bearing `az` turns about.
 *
 * ⚠️ IT IS Z × THE BEARING, NOT THE BEARING × Z. Written the other way round the
 * field bends due SOUTH when it is asked to bend north — and a field of glyphs
 * leaning confidently the wrong way looks entirely correct until it is measured
 * against the compass. Same class of mistake as the grading key's mirrored
 * hatch, and pinned by a check for the same reason.
 * @param {number} az
 */
function bendAxis(az) {
  return [-Math.cos(az), Math.sin(az), 0];
}

/** Rodrigues rotation of `v` about unit axis `k` by `th`. */
function rotate(v, k, th) {
  const c = Math.cos(th), s = Math.sin(th);
  const dot = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [
    v[0] * c + (k[1] * v[2] - k[2] * v[1]) * s + k[0] * dot * (1 - c),
    v[1] * c + (k[2] * v[0] - k[0] * v[2]) * s + k[1] * dot * (1 - c),
    v[2] * c + (k[0] * v[1] - k[1] * v[0]) * s + k[2] * dot * (1 - c),
  ];
}

/**
 * Normalise one value for one row.
 * @param {number} v @param {string} kind
 * @param {number} lo @param {number} hi @param {boolean} invert
 */
function normalise(v, kind, lo, hi, invert) {
  let t;
  if (kind === "bearing") t = ((v % 360) + 360) % 360 / 360;
  else if (kind === "angle") t = Math.min(1, Math.max(0, v / 90));
  else {
    const span = hi - lo;
    t = span > 0 ? (v - lo) / span : 0.5;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  return invert ? 1 - t : t;
}

/**
 * Build one glyph. Exported so the suite can assert on a single chain without
 * standing up a grid.
 *
 * @param {{x:number,y:number,z:number}} at  local coordinates of the cell
 * @param {{key:string, op:string, gain?:number, invert?:boolean}[]} chain
 * @param {Record<string, number>} values raw value per attribute key
 * @param {Record<string, {lo:number, hi:number, kind?:string}>} fields
 * @param {{length?:number}} [opts] `length` full glyph length in ground units
 * @returns {{pts:number[], inert:string[]}|null} null when a row has no answer
 */
export function buildGlyph(at, chain, values, fields, opts = {}) {
  const full = opts.length ?? 1;
  let az = 0, incl = 0;
  let px = at.x, py = at.y, pz = at.z;
  const pts = [px, py, pz];
  /** rows that could not act on anything — reported, never dropped */
  const inert = [];

  for (let ri = 0; ri < chain.length; ri++) {
    const row = chain[ri];
    const f = fields[row.key];
    const v = values[row.key];
    // ⚠️ A ROW AGAINST A LAYER THAT IS NOT THERE IS NOT "NO ANSWER" — it is a
    // chain that cannot be evaluated at all, and dropping every glyph silently
    // would read as the field being broken. Reported as inert instead.
    if (!f) { inert.push(`${row.key} is not computed`); continue; }
    if (!Number.isFinite(v)) return null;           // no answer, no glyph

    const kind = f.kind || GLYPH_KIND[row.key] || "scalar";
    const gain = row.gain ?? 1;
    const t = normalise(v, kind, f.lo, f.hi, !!row.invert);

    if (row.op === "turn") {
      // A bearing is used AS a bearing; anything else sweeps the full circle.
      az += gain * (kind === "bearing" ? v * DEG : t * Math.PI * 2);
    } else if (row.op === "tilt") {
      // An angle is used AS an angle. Aspect-then-slope therefore produces the
      // SURFACE NORMAL exactly: the normal leans in the direction the ground
      // faces, by the ground's own slope. That is not a coincidence to be
      // tidied away — it is why this pair reads as terrain before any other
      // row has acted.
      incl += gain * (kind === "angle" ? v * DEG : t * (Math.PI / 2));
    } else if (row.op === "extend") {
      const len = full * gain * (MIN_LEN + (1 - MIN_LEN) * t);
      const h = heading(az, incl);
      const step = len / STEPS;
      for (let s = 0; s < STEPS; s++) {
        px += h[0] * step; py += h[1] * step; pz += h[2] * step;
        pts.push(px, py, pz);
      }
    } else if (row.op === "bend") {
      // ⚠️ BENDS THE LINE AS IT STANDS. Before the first extend there is no
      // line, so the row is inert — said out loud rather than quietly promoted
      // to "curve whatever comes next", because that would make the chain mean
      // the same thing in two different orders and order is the whole point.
      if (pts.length <= 3) { inert.push(`${GLYPH_OP_BY_KEY.bend.label} before anything to bend`); continue; }
      const total = gain * t * MAX_BEND;
      const k = bendAxis(az);
      // Segment directions and lengths, then re-lay them with a rotation that
      // grows along the arc — which is a true bend rather than a hinge.
      const segs = [];
      let S = 0;
      for (let i = 3; i < pts.length; i += 3) {
        const dx = pts[i] - pts[i - 3], dy = pts[i + 1] - pts[i - 2],
          dz = pts[i + 2] - pts[i - 1];
        const L = Math.hypot(dx, dy, dz);
        segs.push([dx, dy, dz, L]);
        S += L;
      }
      if (!(S > 0)) { inert.push("nothing to bend"); continue; }
      let acc = 0;
      px = at.x; py = at.y; pz = at.z;
      pts.length = 3;
      for (const [dx, dy, dz, L] of segs) {
        const mid = (acc + L / 2) / S;
        const rv = rotate([dx, dy, dz], k, total * mid);
        px += rv[0]; py += rv[1]; pz += rv[2];
        pts.push(px, py, pz);
        acc += L;
      }
      // The tip now points elsewhere, and a later row has to inherit that.
      incl += total;
    }
  }
  // A chain that never extended has no line — one point is not a glyph.
  if (pts.length <= 3) return null;
  return { pts, inert };
}

/**
 * A glyph per sampled cell.
 *
 * @param {{nrows:number, ncols:number, cell:number, z:Float32Array}} dem
 * @param {Record<string, {grid:Float32Array|Int32Array, lo:number, hi:number,
 *                         kind?:string}>} fields
 * @param {{key:string, op:string, gain?:number, invert?:boolean}[]} chain
 * @param {{stride?:number, lengthFraction?:number}} [opts]
 * @returns {{glyphs:{pts:number[]}[], drawn:number, skipped:number,
 *            sampled:number, inert:string[], missing:string[]}}
 */
export function buildGlyphs(dem, fields, chain, opts = {}) {
  const stride = Math.max(1, Math.round(opts.stride ?? 4));
  const { nrows, ncols, cell, z } = dem;
  const northY = nrows * cell;
  // Full length spans the sample spacing, the same convention symbols.js uses
  // for a full-size circle — so neighbouring full glyphs just reach each other.
  const full = stride * cell * (opts.lengthFraction ?? 0.9);

  const missing = chain.filter((r) => !fields[r.key]).map((r) => r.key);
  const glyphs = [];
  let sampled = 0, skipped = 0;
  /** @type {Set<string>} */
  const inert = new Set();

  // Centre-outward, so changing the stride does not slide the whole field —
  // same reasoning and same arithmetic as symbolField.
  const r0 = Math.floor(((nrows - 1) % stride) / 2);
  const c0 = Math.floor(((ncols - 1) % stride) / 2);

  /** @type {Record<string, number>} */
  const values = {};
  for (let r = r0; r < nrows; r += stride) {
    for (let c = c0; c < ncols; c += stride) {
      const i = r * ncols + c;
      const zc = z[i];
      sampled++;
      if (!Number.isFinite(zc)) { skipped++; continue; }
      for (const row of chain) {
        const f = fields[row.key];
        if (f) values[row.key] = f.grid[i];
      }
      const g = buildGlyph({ x: c * cell, y: northY - r * cell, z: zc },
        chain, values, fields, { length: full });
      if (!g) { skipped++; continue; }
      for (const s of g.inert) inert.add(s);
      glyphs.push({ pts: g.pts });
    }
  }
  return {
    glyphs, drawn: glyphs.length, skipped, sampled,
    inert: [...inert], missing: [...new Set(missing)],
  };
}

/**
 * The chain as a sentence.
 *
 * ⚠️ NAMED, IN ORDER, AS ONE CLAUSE PER ROW — because the chain IS the reading,
 * and a field of leaning lines is unreadable without the sentence that built it.
 * Same reason `describeStack` exists.
 * @param {{key:string, op:string, gain?:number, invert?:boolean}[]} chain
 * @param {Record<string, {label:string}>} labels
 */
export function describeChain(chain, labels) {
  if (!chain.length) return "an upright line, and nothing acting on it";
  return "A line standing on each cell " + chain.map((r) => {
    const op = GLYPH_OP_BY_KEY[r.op];
    const name = labels[r.key]?.label || r.key;
    const g = (r.gain ?? 1) !== 1 ? ` ×${(r.gain ?? 1).toFixed(1)}` : "";
    return `${op ? op.verb : r.op} ${r.invert ? "inverted " : ""}${name}${g}`;
  }).join(", then ");
}
