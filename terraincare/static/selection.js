// @ts-check
// SELECTIONS THAT COMPOSE — an ordered stack, not a boolean tree.
//
// Marc's brief (DESIGN-controlled-transformation.md, and Phase 9 §11): import a
// polygon; draw a polygon; select by attribute; SAVE a selection as a layer;
// list those layers outside the sub-menus; enable several at once; and subtract
// one from another — "all faces steeper than X, but not those above elevation Y,
// and only within an imported boundary".
//
// That sentence is the specification, and it is the reason the three operators
// carry the words they do below: `and also`, `but not`, `and only within` are
// the brief's own conjunctions, so a stack read top to bottom reproduces the
// sentence a designer said out loud.
//
// ⚠️ AN ORDERED STACK, NOT A BOOLEAN TREE. A general expression needs
// parentheses and nesting, and neither survives a 260 px panel. A stack reads
// top to bottom like a recipe and every intermediate state is inspectable — you
// can disable one row and watch the count move, which is not true of a tree. The
// honest limitation is written down rather than hidden: `(A ∪ B) ∩ (C ∪ D)`
// cannot be said in one stack without care, and ORDER MATTERS — `A + B − C` and
// `A − C + B` are different selections. A check pins exactly that, so nobody
// later "optimises" the stack by sorting it.
//
// ⚠️ A SAVED SELECTION IS FROZEN, AND THAT IS A DECISION RATHER THAN A CACHE.
// A rule re-reads the current surface, so a live "steep ground" layer would
// change under the designer the moment they cut — the selection they are cutting
// inside would stop being the one they accepted, mid-gesture. Freezing makes a
// saved selection a DECISION; `stale()` and a visible re-evaluate action are how
// it stops being a lie. See `surfaceStamp`.
//
// ⚠️ AND ONLY A SURFACE-DERIVED LAYER CAN GO STALE. A drawn or imported polygon
// is geometry: `rasterise()` reads rings and the georeference, never z, so its
// cells do not move when the ground does. Marking it stale after every edit
// would train the designer to ignore the word. `live` records which kind a layer
// is, and `stale()` consults it.

import { distanceToMask } from "./polygon.js";

/**
 * How far a modifier reaches PAST the selection, and how it lets go.
 *
 * ⚠️ A HARD-EDGED SELECTION CUTS A CLIFF. Restricting a brush to a mask and
 * stopping dead at its boundary leaves a vertical step exactly the height of
 * whatever was moved — the selection stops being a place you are working and
 * becomes a cookie cutter. Marc asked for the alternative: the selected ground
 * moves fully, and ground just outside it moves less and less with distance.
 *
 * ⚠️ SMOOTHSTEP, NOT LINEAR, AND THAT IS THE WHOLE POINT. A linear ramp is
 * continuous in height but not in SLOPE: it meets the untouched ground at an
 * angle, leaving a visible crease at the feather's outer edge and a second one
 * at the selection boundary. `1 − t²(3 − 2t)` has zero derivative at BOTH ends,
 * so the worked ground leaves the selection tangentially and rejoins the
 * untouched ground tangentially. That is the "sharing some tangency" the brief
 * asked for, and it is why the feather is worth more than a wider brush.
 *
 * ⚠️ THE DISTANCE FIELD IS EXACT, not a few dilations. `distanceToMask` is the
 * Felzenszwalb two-pass transform the batter already relies on — O(n) and exact
 * Euclidean — so the feather is round where the selection is round rather than
 * carrying the diamond or square bias a chamfer approximation would.
 *
 * @param {Uint8Array} mask the selection, 0/1 over the DEM grid
 * @param {number} nrows @param {number} ncols
 * @param {number} cellSize metres per cell — the feather is specified in METRES,
 *   because it is a length on the ground, not a count of cells
 * @param {number} featherMetres 0 disables it and restores the hard edge
 * @returns {Float32Array} per-cell weight in [0,1]; 1 inside the selection
 */
export function featherWeights(mask, nrows, ncols, cellSize, featherMetres) {
  const n = nrows * ncols;
  const w = new Float32Array(n);
  if (!(featherMetres > 0) || !(cellSize > 0)) {
    for (let i = 0; i < n; i++) w[i] = mask[i] ? 1 : 0;
    return w;
  }
  const d = distanceToMask(mask, nrows, ncols);   // in CELLS
  const R = featherMetres / cellSize;
  for (let i = 0; i < n; i++) {
    if (mask[i]) { w[i] = 1; continue; }
    const t = d[i] / R;
    if (t >= 1) { w[i] = 0; continue; }
    w[i] = 1 - t * t * (3 - 2 * t);
  }
  return w;
}

/**
 * The three operators, in the order the panel offers them and the order a row
 * cycles through on click.
 *
 * ⚠️ THE GLYPH IS FOR DISPLAY AND THE KEY IS THE CONTRACT. Storing `"−"` as the
 * stored value would put U+2212 into every persisted stack and every test
 * comparison, where it is one careless save-as-Latin-1 away from becoming `-`
 * or `?`. The key is ASCII; the glyph and the verb are looked up from it.
 */
export const OPS = [
  { key: "add", glyph: "+", label: "union", verb: "and also" },
  { key: "sub", glyph: "−", label: "subtract", verb: "but not" },
  { key: "int", glyph: "∩", label: "intersect", verb: "and only within" },
];

/** @type {Record<string, {key:string, glyph:string, label:string, verb:string}>} */
export const OP_BY_KEY = Object.fromEntries(OPS.map((o) => [o.key, o]));

/** The operator after this one, wrapping — what a click on the op button does. */
export function nextOp(key) {
  const i = OPS.findIndex((o) => o.key === key);
  return OPS[(i < 0 ? 0 : i + 1) % OPS.length].key;
}

/**
 * @typedef {object} SelectionLayer
 * @property {number} id
 * @property {string} name        user-facing, and one rename away from being
 *                                user-supplied text — never interpolated as HTML
 * @property {string} op          an OPS key: "add" | "sub" | "int"
 * @property {boolean} enabled
 * @property {Uint8Array} mask    the frozen cells, over the DEM grid
 * @property {number} count       cells in `mask`, counted once at freeze
 * @property {string} source      how it was made: "drawn", "from file",
 *                                "by attribute"
 * @property {boolean} live       whether its cells were derived from the SURFACE
 *                                (an attribute rule) rather than from geometry
 * @property {number} stamp       `surfaceStamp` at the moment it was frozen;
 *                                0 for a geometry layer, which cannot go stale
 * @property {string} [sentence]  the recipe in words, for the row's tooltip
 * @property {any} [recipe]       enough to re-evaluate — the rule array for an
 *                                attribute layer, the region id for a drawn one
 */

/**
 * A fingerprint of the surface, so a frozen selection can say whether the ground
 * has moved under it.
 *
 * ⚠️ PURE, AND OVER THE HEIGHTS ONLY. A counter incremented at every mutation
 * site would have to find every mutation site in a seven-thousand-line shell,
 * and would drift silently the first time somebody added a modifier and forgot.
 * Reading the array is O(n) once per freeze and per check — 65 536 cells at this
 * site, measured well under a frame — and it cannot be forgotten.
 *
 * ⚠️ EVERY NON-FINITE VALUE HASHES AS ONE CANONICAL "NO ANSWER". NaN has 2^23
 * payloads and arithmetic is free to hand back a different one; hashing the raw
 * bits would report "the surface changed" because a nodata cell was rewritten
 * with a differently-spelled nothing.
 *
 * @param {ArrayLike<number>} z
 * @returns {number} an unsigned 32-bit fingerprint; never 0, so 0 is free to
 *   mean "not stamped" on a geometry layer
 */
export function surfaceStamp(z) {
  const f = new Float32Array(1);
  const bits = new Int32Array(f.buffer);
  // Seeded with the length, so two grids of different size cannot collide
  // however their values line up.
  let h = Math.imul(0x811c9dc5 ^ z.length, 16777619);
  const CANONICAL_NAN = 0x7fc00000;
  for (let i = 0; i < z.length; i++) {
    const v = z[i];
    let b;
    if (Number.isFinite(v)) { f[0] = v; b = bits[0]; } else b = CANONICAL_NAN;
    h = Math.imul(h ^ (b & 0xff), 16777619);
    h = Math.imul(h ^ ((b >>> 8) & 0xff), 16777619);
    h = Math.imul(h ^ ((b >>> 16) & 0xff), 16777619);
    h = Math.imul(h ^ ((b >>> 24) & 0xff), 16777619);
  }
  // 0 is reserved for "no stamp", so a hash that lands there is nudged. One
  // value in four billion reads as its neighbour; none reads as "unstamped".
  return (h >>> 0) || 1;
}

/**
 * Has the ground moved since this layer was frozen?
 * @param {SelectionLayer} layer
 * @param {number} stamp `surfaceStamp` of the surface as it stands
 */
export function stale(layer, stamp) {
  return !!layer.live && layer.stamp !== stamp;
}

/**
 * Apply the stack top to bottom.
 *
 * ⚠️ IT STARTS FROM EMPTY, AND THE FIRST ROW IS NOT SPECIAL. Seeding the result
 * with the first layer whatever its operator — the obvious convenience — would
 * mean a stack whose top row says `but not` quietly behaving as `and also`, and
 * the same stack would change meaning when a row above it was disabled. So the
 * arithmetic is honest and `seeded` reports whether the first ENABLED row is a
 * union; the panel says so in words rather than the module guessing.
 *
 * ⚠️ A LAYER WHOSE MASK DOES NOT FIT THE GRID IS SKIPPED AND NAMED, never
 * treated as empty and never as everything — the same refusal `maskFromRule`
 * makes about an uncomputed layer. A selection that could not be evaluated must
 * not widen the operation it was meant to narrow.
 *
 * @param {SelectionLayer[]} layers in panel order, top first
 * @param {number} n cells in the DEM grid
 * @returns {{mask: Uint8Array, count: number, used: number, skipped: string[],
 *            seeded: boolean}}
 */
export function composeStack(layers, n) {
  const mask = new Uint8Array(n);
  /** @type {string[]} */
  const skipped = [];
  let used = 0;
  /** @type {boolean|null} */
  let seeded = null;

  for (const L of layers) {
    if (!L.enabled) continue;
    if (!L.mask || L.mask.length !== n) { skipped.push(L.name); continue; }
    if (seeded === null) seeded = L.op === "add";
    used++;
    const m = L.mask;
    if (L.op === "add") {
      for (let i = 0; i < n; i++) if (m[i]) mask[i] = 1;
    } else if (L.op === "sub") {
      for (let i = 0; i < n; i++) if (m[i]) mask[i] = 0;
    } else {
      for (let i = 0; i < n; i++) if (!m[i]) mask[i] = 0;
    }
  }

  let count = 0;
  for (let i = 0; i < n; i++) if (mask[i]) count++;
  return { mask, count, used, skipped, seeded: seeded ?? false };
}

/**
 * The stack as one English sentence, built from the brief's own conjunctions.
 *
 * The first enabled row contributes its NAME alone — "Slope ≥ 20.2°" — and every
 * row after it contributes its verb and its name, so the whole reads
 * "Slope ≥ 20.2°, but not Above 78 m, and only within Site boundary". Disabled
 * rows are absent rather than struck through: the sentence describes what is
 * SELECTED, and a row that is off is not part of it.
 *
 * @param {SelectionLayer[]} layers
 */
export function describeStack(layers) {
  const on = layers.filter((L) => L.enabled);
  if (!on.length) return "no selection — modifiers act on the whole region";
  const parts = on.map((L, i) => {
    const op = OP_BY_KEY[L.op] ?? OP_BY_KEY.add;
    // ⚠️ THE FIRST ROW STILL SHOWS ITS VERB IF IT IS NOT A UNION. A stack that
    // begins "but not X" selects nothing, and the sentence has to say the
    // strange thing rather than tidy it into "X".
    return i === 0 && L.op === "add" ? L.name : `${op.verb} ${L.name}`;
  });
  return parts.join(", ");
}

/**
 * The saved selections, in panel order.
 *
 * IDs are handed out here and never reused, including after a delete — the same
 * rule and the same reason as `PlanSet`: a stack is exported alongside the
 * regions, and two rows called "3" that describe different ground is a trap for
 * whoever reads the pair afterwards.
 */
export class SelectionStack {
  constructor() {
    /** @type {SelectionLayer[]} */
    this.layers = [];
    this._nextId = 1;
  }

  get length() { return this.layers.length; }

  /** Enabled layers only — what `composeStack` will actually use. */
  get activeCount() { return this.layers.filter((L) => L.enabled).length; }

  /**
   * Freeze a mask as a new layer, on top of the stack.
   *
   * ⚠️ THE MASK IS COPIED. The caller's array is very often the live rule mask,
   * which `syncRuleUI` rebuilds in place on the next slider move — keeping the
   * reference would make a "frozen" layer follow the slider, which is precisely
   * the behaviour freezing exists to prevent.
   *
   * @param {Uint8Array} mask
   * @param {{name?:string, op?:string, source?:string, live?:boolean,
   *          stamp?:number, sentence?:string, recipe?:any}} [opts]
   * @returns {SelectionLayer}
   */
  add(mask, opts = {}) {
    const id = this._nextId++;
    const copy = new Uint8Array(mask);
    let count = 0;
    for (let i = 0; i < copy.length; i++) if (copy[i]) count++;
    /** @type {SelectionLayer} */
    const layer = {
      id,
      name: opts.name ?? `Selection ${id}`,
      op: opts.op ?? "add",
      enabled: true,
      mask: copy,
      count,
      source: opts.source ?? "drawn",
      live: !!opts.live,
      // A geometry layer is stamped 0: it cannot go stale, and carrying a real
      // stamp would invite a later `stale()` that forgot to consult `live`.
      stamp: opts.live ? (opts.stamp ?? 0) : 0,
      sentence: opts.sentence,
      recipe: opts.recipe,
    };
    this.layers.push(layer);
    return layer;
  }

  /**
   * Replace a layer's cells in place, keeping its id, name, operator, position
   * and enabled state — what "re-evaluate" does.
   * @param {number} id
   * @param {Uint8Array} mask
   * @param {number} stamp
   */
  refreeze(id, mask, stamp) {
    const L = this.byId(id);
    if (!L) return null;
    L.mask = new Uint8Array(mask);
    let count = 0;
    for (let i = 0; i < L.mask.length; i++) if (L.mask[i]) count++;
    L.count = count;
    if (L.live) L.stamp = stamp;
    return L;
  }

  /** @param {number} id */
  byId(id) { return this.layers.find((L) => L.id === id) ?? null; }

  /** @param {number} id @returns {boolean} whether anything was removed */
  remove(id) {
    const i = this.layers.findIndex((L) => L.id === id);
    if (i < 0) return false;
    this.layers.splice(i, 1);
    return true;
  }

  /**
   * Move a layer up (-1) or down (+1) the stack.
   *
   * ⚠️ ORDER IS MEANING HERE, not presentation. Moving a `but not` above the row
   * it was subtracting from changes the answer, which is why the panel has
   * arrows at all and why they are not a sort.
   * @param {number} id @param {number} delta
   * @returns {boolean} whether it moved
   */
  move(id, delta) {
    const i = this.layers.findIndex((L) => L.id === id);
    if (i < 0) return false;
    const j = i + delta;
    if (j < 0 || j >= this.layers.length) return false;
    const [L] = this.layers.splice(i, 1);
    this.layers.splice(j, 0, L);
    return true;
  }

  clear() { this.layers.length = 0; }
}
