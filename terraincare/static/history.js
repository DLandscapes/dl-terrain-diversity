// @ts-check
// UNDO — the difference between recovering from a bad gesture and starting over.
//
// Until now the only way back was "reset terrain", which throws the whole
// session away. That is fine for a test and useless for a live presentation:
// one stroke too deep in front of an audience and the only option was to lose
// every edit made since the tile loaded.
//
// ⚠️ WHAT AN UNDO ENTRY HAS TO CARRY, AND WHY IT IS MORE THAN THE ELEVATIONS.
// A gesture in this tool changes up to four things at once, and restoring only
// the obvious one leaves the app self-contradictory:
//
//   z          the ground itself
//   ledger     cut and fill, which ACCUMULATE — undoing a stroke without
//              rewinding the ledger leaves the readout claiming earth was moved
//              that is no longer anywhere on the surface, and the tool's closing
//              claim is precisely that the ledger cannot drift from the ground
//   substrate  class codes, for a paint stroke, which moves no earth at all
//   the rect   so everything downstream can be refreshed over the same window
//
// ⚠️ RECT-SCOPED, NOT WHOLE-GRID. A brush stroke touches on the order of a
// thousand cells out of 65 536, so storing the whole surface per gesture would
// spend 262 kB to record 3 kB of change. The caller takes a full copy while a
// gesture is in flight — it cannot know the final rect until the hand lifts —
// and trims to the union rect at the end, so the steady-state cost is the size
// of the edits rather than the size of the terrain.
//
// ⚠️ SYMMETRIC BY CONSTRUCTION. `applyEdit` returns the inverse of what it just
// applied, so redo is undo with the stacks swapped and there is no second code
// path that could disagree with the first. This is the same reasoning that keeps
// the figure exporter reading the app's own state rather than re-deriving it.

/**
 * @typedef {Object} Edit
 * @property {string} label            what to say in the status line
 * @property {number} r0 @property {number} c0
 * @property {number} r1 @property {number} c1
 * @property {Float32Array} z          elevations over the rect, row-major within it
 * @property {Uint8Array|null} soil    substrate codes over the same rect, or null
 * @property {number} cut              ledger totals as they were BEFORE the edit
 * @property {number} fill
 */

/** Bytes an entry occupies, for the memory cap. */
export function editBytes(edit) {
  return edit.z.byteLength + (edit.soil ? edit.soil.byteLength : 0) + 64;
}

/**
 * Copy a rectangle of state out of the live grids.
 *
 * `z` may be a snapshot taken before the edit rather than the DEM's own array —
 * which is how a brush stroke is recorded, since its final extent is not known
 * until the gesture ends.
 *
 * @param {{z: Float32Array, ncols: number, rect: {r0:number,c0:number,r1:number,c1:number},
 *          label: string, cut: number, fill: number, soil?: Uint8Array|null}} o
 * @returns {Edit}
 */
export function captureRect(o) {
  const { r0, c0, r1, c1 } = o.rect;
  const w = c1 - c0 + 1, h = r1 - r0 + 1;
  const z = new Float32Array(w * h);
  const soil = o.soil ? new Uint8Array(w * h) : null;
  for (let r = 0; r < h; r++) {
    const src = (r0 + r) * o.ncols + c0;
    z.set(o.z.subarray(src, src + w), r * w);
    if (soil && o.soil) soil.set(o.soil.subarray(src, src + w), r * w);
  }
  return { label: o.label, r0, c0, r1, c1, z, soil, cut: o.cut, fill: o.fill };
}

/**
 * Put an edit back, and return the inverse so it can be re-applied.
 *
 * ⚠️ THE LEDGER IS RESTORED, NOT ADJUSTED. Subtracting the operation's own
 * cut and fill would accumulate float error every time a gesture is undone and
 * redone, and the whole point of the ledger is that it cannot drift from the
 * ground. The totals as they stood before the edit are recorded and put back
 * verbatim — the one place in this codebase where assigning to the ledger
 * instead of accumulating into it is correct, because the stack is LIFO and the
 * value being restored is by definition the one that was true.
 *
 * @param {{dem: {z: Float32Array, ncols: number}, edit: Edit,
 *          substrate?: Uint8Array|null, ledger?: {cut:number, fill:number}}} o
 * @returns {Edit} the inverse edit
 */
export function applyEdit(o) {
  const { edit, dem } = o;
  const w = edit.c1 - edit.c0 + 1, h = edit.r1 - edit.r0 + 1;
  const inverse = captureRect({
    z: dem.z, ncols: dem.ncols,
    rect: { r0: edit.r0, c0: edit.c0, r1: edit.r1, c1: edit.c1 },
    label: edit.label,
    cut: o.ledger ? o.ledger.cut : 0,
    fill: o.ledger ? o.ledger.fill : 0,
    soil: edit.soil ? o.substrate : null,
  });

  for (let r = 0; r < h; r++) {
    const dst = (edit.r0 + r) * dem.ncols + edit.c0;
    dem.z.set(edit.z.subarray(r * w, r * w + w), dst);
    if (edit.soil && o.substrate) {
      o.substrate.set(edit.soil.subarray(r * w, r * w + w), dst);
    }
  }
  if (o.ledger) { o.ledger.cut = edit.cut; o.ledger.fill = edit.fill; }
  return inverse;
}

/**
 * The undo and redo stacks, with a depth and a memory cap.
 *
 * Bounded on BOTH, because the two failure modes are different: a long session
 * of small brush strokes runs into the depth limit, and a handful of whole-grid
 * pattern stamps runs into the byte limit long before the depth one. Either
 * unbounded would grow until the tab died mid-presentation.
 */
export class History {
  /** @param {{limit?: number, maxBytes?: number}} [opts] */
  constructor(opts = {}) {
    this.limit = opts.limit ?? 40;
    this.maxBytes = opts.maxBytes ?? 48 * 1024 * 1024;
    /** @type {Edit[]} */ this.past = [];
    /** @type {Edit[]} */ this.future = [];
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  get bytes() {
    let n = 0;
    for (const e of this.past) n += editBytes(e);
    for (const e of this.future) n += editBytes(e);
    return n;
  }

  /**
   * Record an edit.
   *
   * ⚠️ THIS CLEARS THE REDO STACK, and that is not a detail. Once new work is
   * done from an undone state, the future that was recorded describes a surface
   * that no longer exists — redoing into it would splice a rectangle of some
   * abandoned version of the terrain into the live one, and the result would
   * look like plausible ground while corresponding to nothing anyone drew.
   * @param {Edit} edit
   */
  push(edit) {
    this.past.push(edit);
    this.future.length = 0;
    while (this.past.length > this.limit) this.past.shift();
    while (this.past.length > 1 && this.bytes > this.maxBytes) this.past.shift();
  }

  /** @param {(e: Edit) => Edit} apply @returns {Edit|null} the edit that was undone */
  undo(apply) {
    const e = this.past.pop();
    if (!e) return null;
    this.future.push(apply(e));
    return e;
  }

  /** @param {(e: Edit) => Edit} apply @returns {Edit|null} */
  redo(apply) {
    const e = this.future.pop();
    if (!e) return null;
    this.past.push(apply(e));
    return e;
  }

  clear() { this.past.length = 0; this.future.length = 0; }
}
