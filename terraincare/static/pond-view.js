// @ts-check
// WHAT EACH WATER BODY HOLDS, LABELLED ON THE MODEL.
//
// The rainfall layer already draws WHERE the water stands, as blocks. This says
// HOW MUCH each body holds, on the body itself. The two are deliberately
// separate: the blocks are a picture of a surface, and a designer reading them
// can see that a hollow is wet without having any idea whether it is holding
// forty litres or four cubic metres — which is the number the drainage argument
// is actually made in.
//
// Follows the conventions this project has already paid for, in photo-view.js,
// dimensions.js and selection-view.js: geometry LOCAL with the UTM origin on the
// group transform (see reference float32/UTM — world coordinates in a float32
// buffer quantise to half a metre at this site's northing), depth testing OFF so
// a label lying in the surface cannot tie with it per fragment and shimmer, and
// the vertical exaggeration carried on the group's z scale rather than baked
// into vertices.
//
// ⚠️ A PIN IS ANCHORED AT THE BODY'S DEEPEST CELL, which `pondWater` supplies.
// A centroid can land on dry ground outside a non-convex hollow entirely, which
// puts the label beside the pond it names. The deepest cell is always wet and
// always inside, and is where a person points when they say "that one".
//
// ⚠️ THE LEADER RISES FROM THE WATER SURFACE, NOT FROM THE GROUND. The body's
// own level is what the number describes, and a stem starting at the bed would
// pass up through the water it is measuring and read as taller than the pond is
// deep — which is exactly the misreading this label exists to prevent.
//
// ⚠️ NOT EVERY BODY GETS A PIN. A 20 mm event on the design patch produces
// hundreds of hollows holding a few litres each; labelling all of them is a wall
// of illegible text over the model and buries the four that matter. The caller
// asks for the largest N, and the readout says how many were left unlabelled, so
// the omission is stated rather than silent.

import * as THREE from "three";
import { textSprite } from "./dimensions.js";
// ⚠️ ONE FORMATTER, in the module the chart axis and the sidebar also read it
// from. A pin and an axis disagreeing about the same pond is the first symptom
// of two of these.
import { fmtVolume } from "./hud.js";

const INK = 0x1c1a16;
/** The interface's rest grey — pins commit to full ink only when they matter. */
const REST = 0x4a4a4a;

export class PondPins {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.group = new THREE.Group();
    // ⚠️ The origin lives HERE, never in a vertex buffer.
    this.group.position.set(dem.originX, dem.originY, 0);
    this.group.scale.set(1, 1, opts.verticalExaggeration ?? 1);
    this.group.renderOrder = 15;   // above the selection outline
    this.group.visible = false;
    this._ex = opts.verticalExaggeration ?? 1;
    // ⚠️ A DOTTED LEADER, NOT A SOLID STEM (2026-08-12, Marc). The photo pins
    // already own the solid-stem-and-head symbol, and two different claims drawn
    // the same way is the confusion this project keeps refusing elsewhere — a
    // photograph is an OBSERVATION, one moment at one point; a water body is a
    // MODELLED quantity over an area. A dotted line is the drafting convention
    // for a projected or derived dimension rather than a surveyed thing, which
    // is exactly the distinction.
    //
    // ⚠️ LineDashedMaterial NEEDS computeLineDistances() ON THE GEOMETRY or it
    // renders SOLID — silently, with no warning — which would collapse the one
    // distinction this material exists to draw. Same trap section-view.js
    // carries a note about.
    this._line = new THREE.LineDashedMaterial({
      color: INK, transparent: true, opacity: 0.75,
      depthTest: false, depthWrite: false, fog: false,
    });
    // The foot mark carries the full / not-full state, so the label does not
    // have to spend colour on it. Weight is the distinction, as it is in the
    // readout: a body at its spill point reads heavier.
    this._footFull = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.95,
      depthTest: false, depthWrite: false, fog: false,
    });
    this._footOpen = new THREE.LineBasicMaterial({
      color: REST, transparent: true, opacity: 0.6,
      depthTest: false, depthWrite: false, fog: false,
    });
    /** @type {THREE.Object3D[]} */
    this._parts = [];
    /** bodies actually labelled by the last build, for the readout and the suite */
    this.count = 0;
    /** bodies deliberately left unlabelled, so the omission can be stated */
    this.omitted = 0;
  }

  /** @param {number} v */
  setExaggeration(v) {
    this._ex = v;
    this.group.scale.z = v;
    // ⚠️ THE STEM IS DIVIDED BY THE EXAGGERATION AND THE HEAD IS NOT SCALED, so
    // a pin keeps ONE height on screen at every setting — the same rule the
    // photo pins follow. A stem that grew with the exaggeration would read as
    // the water getting deeper when only the drawing was stretched.
    for (const p of this._parts) {
      if (/** @type {any} */ (p).userData.isSprite) {
        p.scale.z = 1 / v;
      }
    }
  }

  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  _clear() {
    for (const p of this._parts) {
      this.group.remove(p);
      const any = /** @type {any} */ (p);
      if (any.geometry) any.geometry.dispose();
      if (any.material && any.material.map) any.material.map.dispose();
      if (any.material && any.isSprite) any.material.dispose();
    }
    this._parts.length = 0;
    this.count = 0;
    this.omitted = 0;
  }

  /**
   * Label the water bodies.
   * @param {{volume:number, level:number, z:number, x:number, y:number,
   *          full:boolean}[]|null} bodies largest first, as pondWater returns
   * @param {{max?:number}} [opts]
   */
  setBodies(bodies, opts = {}) {
    this._clear();
    if (!bodies || !bodies.length) return;
    const max = opts.max ?? 12;
    const shown = bodies.slice(0, max);
    this.omitted = bodies.length - shown.length;

    const { cell, nrows, ncols, originX, originY } = this.dem;
    const span = Math.max(nrows, ncols) * cell;
    // A leader long enough to lift the label clear of the water and short enough
    // not to become the drawing. Proportional to the patch, so it reads the same
    // on the 64 m design patch and the 1 km context tile.
    const stem = span * 0.075;
    const dash = span * 0.006;

    for (const b of shown) {
      // Local coordinates: the group carries the UTM origin.
      const lx = b.x - originX, ly = b.y - originY;
      // The water surface, falling back to the bed for a body with no level.
      const base = Number.isFinite(b.level) ? b.level : b.z;

      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
        lx, ly, base,
        lx, ly, base + stem / this._ex,
      ]), 3));
      const ln = new THREE.LineSegments(g, this._line);
      // ⚠️ WITHOUT THIS THE DASHES DO NOT EXIST and the line draws solid.
      ln.computeLineDistances();
      ln.frustumCulled = false;
      ln.renderOrder = 15;
      this.group.add(ln);
      this._parts.push(ln);

      // ⚠️ EVERY LABEL IN FULL INK ON PAPER (2026-08-12, Marc: "with the gray
      // these texts are difficult to read"). The earlier version carried the
      // full/not-full distinction in the TEXT COLOUR, which made half the labels
      // grey-on-terrain and unreadable — and it spent colour, which in this
      // interface means data, on a two-state flag. The state moved to the
      // leader's foot: a filled dot for a body at its spill point, an open ring
      // for one with capacity in hand. Same information, and the number stays
      // legible over any ramp underneath it.
      const sp = textSprite(fmtVolume(b.volume), {
        worldHeight: span * 0.032, colour: "#26241f", plate: true,
      });
      sp.position.set(lx, ly, base + (stem + span * 0.026) / this._ex);
      sp.userData.isSprite = true;
      sp.scale.z = 1 / this._ex;
      sp.renderOrder = 16;
      this.group.add(sp);
      this._parts.push(sp);

      // The foot mark, drawn flat on the water surface.
      const rr = span * 0.004, seg = 20;
      const ring = [];
      for (let k = 0; k <= seg; k++) {
        const th = (k / seg) * Math.PI * 2;
        ring.push(lx + Math.cos(th) * rr, ly + Math.sin(th) * rr, base);
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ring), 3));
      const rl = new THREE.Line(rg, b.full ? this._footFull : this._footOpen);
      rl.frustumCulled = false;
      rl.renderOrder = 15;
      this.group.add(rl);
      this._parts.push(rl);
    }
    this.count = shown.length;
  }

  dispose() {
    this._clear();
    for (const m of [this._line, this._footFull, this._footOpen]) m.dispose();
  }
}

