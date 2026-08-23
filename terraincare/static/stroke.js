// @ts-check
// Strokes, integrated along their path rather than sampled once per frame.
//
// THIS IS THE MOST IMPORTANT DETERMINISM DETAIL IN THE TOOL, and it is easy to
// get wrong invisibly. If a drag applies one brush dab per animation frame,
// then the volume of material moved depends on the frame rate: a stroke drawn
// at 120 fps removes roughly twice as much as the same stroke at 60 fps, and a
// single dropped frame changes the number. The video ends on "net earth moved
// ≈ 0 m³", so that figure has to be a property of the gesture, not of the
// machine that happened to render it.
//
// Instead, a stroke advances by fixed sub-steps in GROUND UNITS along its path.
// However many frames the path took, the same distance produces the same dabs.
// A stationary press still deposits at a fixed rate per unit time, so holding
// the brush in one place is also frame-rate independent.
//
// Group E of the self-test asserts this: the same stroke applied at dt = 1/30
// and dt = 1/120 must agree on cut volume within 0.5%.

import { applyBrush } from "./brush.js";

/** Sub-step spacing as a fraction of brush radius. */
const SUBSTEP_FRACTION = 0.25;
/** Ground units per second a held (stationary) brush advances its own clock. */
const HOLD_RATE = 2.0;

export class Stroke {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {import("./brush.js").Ledger} ledger
   * @param {{tool:string, radius:number, strength:number, target?:number}} cfg
   */
  constructor(dem, ledger, cfg) {
    this.dem = dem;
    this.ledger = ledger;
    this.cfg = cfg;
    /** @type {{x:number,y:number}|null} */
    this.last = null;
    /** distance credit carried across frames, ground units */
    this.carry = 0;
    /** union of every rect this stroke has touched, over its whole life */
    this.rect = null;
    /** union of the rects dabbed by the CURRENT to() call only */
    this._callRect = null;
    this.dabs = 0;
  }

  get substep() {
    return Math.max(this.cfg.radius * SUBSTEP_FRACTION, this.dem.cell * 0.5);
  }

  /**
   * Extend the stroke to a world point.
   *
   * Returns the dirty rect of THIS call's dabs (null if none landed), not the
   * whole stroke's union. The union is still kept on `this.rect`, but returning
   * it made every frame of a long drag re-upload and re-shade the entire
   * stroke's footprint: cells dabbed on frame 1 were "dirty" again on frame
   * 300, so the per-frame cost grew with the length of the gesture — precisely
   * the scaling the dirty-rect path exists to avoid, and the demo's authored
   * strokes are the long ones.
   *
   * @param {number} x @param {number} y
   * @param {number} dt seconds since the previous call (for a held brush)
   */
  to(x, y, dt = 0) {
    const step = this.substep;
    this._callRect = null;

    if (!this.last) {
      this._dab(x, y);
      this.last = { x, y };
      return this._callRect;
    }

    const dx = x - this.last.x, dy = y - this.last.y;
    let dist = Math.hypot(dx, dy);

    if (dist < 1e-9) {
      // Held in place: advance on time instead of distance, so pressing without
      // moving still deposits at a rate independent of frame rate.
      this.carry += HOLD_RATE * dt;
      while (this.carry >= step) {
        this.carry -= step;
        this._dab(x, y);
      }
      return this._callRect;
    }

    // Walk the segment in fixed ground-unit sub-steps, carrying the remainder
    // into the next frame so no distance is lost or double-counted at the seam.
    const ux = dx / dist, uy = dy / dist;
    let travelled = -this.carry;
    while (travelled + step <= dist) {
      travelled += step;
      this._dab(this.last.x + ux * travelled, this.last.y + uy * travelled);
    }
    this.carry = dist - travelled;
    this.last = { x, y };
    return this._callRect;
  }

  _dab(x, y) {
    const opts = this.cfg.target !== undefined ? { target: this.cfg.target } : {};
    // ⚠️ CAPTURED ONCE FOR THE WHOLE STROKE, not re-derived per dab. The weight
    // field is a function of the SELECTION, which cannot change mid-gesture —
    // and rebuilding an exact distance transform over 65 536 cells on every dab
    // would put an O(n) pass inside the pointer loop.
    if (this.cfg.weights) opts.weights = this.cfg.weights;
    const res = applyBrush(
      this.dem, /** @type {any} */ (this.cfg.tool), x, y,
      this.cfg.radius, this.cfg.strength, this.ledger, opts);
    this.dabs++;
    this.rect = this.rect ? union(this.rect, res.rect) : res.rect;
    this._callRect = this._callRect ? union(this._callRect, res.rect) : res.rect;
  }
}

/** @param {any} a @param {any} b */
function union(a, b) {
  return {
    r0: Math.min(a.r0, b.r0), c0: Math.min(a.c0, b.c0),
    r1: Math.max(a.r1, b.r1), c1: Math.max(a.c1, b.c1),
  };
}
