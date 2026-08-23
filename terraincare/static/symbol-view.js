// @ts-check
// THE PROPORTIONAL SYMBOLS, DRAWN ON THE MODEL.
//
// symbols.js decides where the circles go and how big each one is; this file
// owns the three.js objects that draw them, and nothing else. Same split as
// surface.js / app.js, and the same conventions the other overlays keep:
// geometry LOCAL with the UTM origin on the group transform, depth testing OFF
// so a disc lying in the surface cannot tie with it per fragment and shimmer,
// and the vertical exaggeration carried on the group's z scale.
//
// ⚠️ ONE GEOMETRY FOR EVERY CIRCLE, not one mesh each. A legible field is one to
// four thousand symbols; that many Meshes is that many draw calls and that many
// matrices updated every frame, and the tool would drop frames while a hand is
// still dragging a brush. All the discs go into a single indexed buffer, which
// is one draw call whatever the count.
//
// ⚠️ THEY LIE FLAT, AT EACH CELL'S OWN HEIGHT. A symbol map is read in plan, and
// a disc tilted to follow the local slope foreshortens — so the value a reader
// measures would depend on the ground under it, which is precisely the thing the
// symbol is supposed to be independent of. Flat and at the cell's elevation: it
// reads as a true circle from above and still sits on the terrain in an oblique
// view, which is where the surface is legible.

import * as THREE from "three";

const INK = 0x26241f;
/** Segments per circle. 14 is smooth at any size these are drawn at. */
const SEG = 14;

export class SymbolField {
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
    this.group.renderOrder = 11;
    this.group.visible = false;
    this._ex = opts.verticalExaggeration ?? 1;
    this._fill = new THREE.MeshBasicMaterial({
      color: INK, transparent: true, opacity: 0.42,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false,
    });
    this._edge = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.75,
      depthTest: false, depthWrite: false, fog: false,
    });
    /** @type {THREE.Object3D[]} */
    this._parts = [];
    /** circles in the last build, for the readout and the suite */
    this.count = 0;
  }

  /** @param {number} v */
  setExaggeration(v) {
    this._ex = v;
    this.group.scale.z = v;
  }
  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  _clear() {
    for (const p of this._parts) {
      this.group.remove(p);
      /** @type {any} */ (p).geometry?.dispose();
    }
    this._parts.length = 0;
    this.count = 0;
  }

  /**
   * @param {{x:number,y:number,z:number,r:number}[]|null} symbols
   *   as symbolField() returns them, in local coordinates
   */
  setSymbols(symbols) {
    this._clear();
    if (!symbols || !symbols.length) return;

    // ⚠️ LIFTED, LIKE EVERY OTHER OVERLAY THAT LIES ON THE GROUND. Depth testing
    // is off so the discs always draw, but without the lift they read as being
    // INSIDE the surface at a grazing angle, which is the view a plan-mode user
    // tilts into first.
    const lift = Math.max(this.dem.cell * 0.02, 0.005);
    const n = symbols.length;
    const pos = new Float32Array(n * (SEG + 1) * 3);
    const idx = [];
    const ring = new Float32Array(n * SEG * 3);
    const ridx = [];

    let p = 0, q = 0;
    for (let k = 0; k < n; k++) {
      const s = symbols[k];
      const base = k * (SEG + 1);
      // ⚠️ THE LIFT IS DIVIDED BY THE EXAGGERATION so the discs sit the same
      // hair above the ground at 1× and at 8×. Baked flat it becomes a visible
      // float at high exaggeration and disappears into the surface at low.
      const z = s.z + lift / (this._ex || 1);
      pos[p++] = s.x; pos[p++] = s.y; pos[p++] = z;   // the centre
      for (let i = 0; i < SEG; i++) {
        const th = (i / SEG) * Math.PI * 2;
        const cx = s.x + Math.cos(th) * s.r, cy = s.y + Math.sin(th) * s.r;
        pos[p++] = cx; pos[p++] = cy; pos[p++] = z;
        ring[q++] = cx; ring[q++] = cy; ring[q++] = z;
        idx.push(base, base + 1 + i, base + 1 + ((i + 1) % SEG));
      }
      const rb = k * SEG;
      for (let i = 0; i < SEG; i++) ridx.push(rb + i, rb + ((i + 1) % SEG));
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, this._fill);
    mesh.frustumCulled = false;
    mesh.renderOrder = 11;
    this.group.add(mesh);
    this._parts.push(mesh);

    // An outline as well as a fill: at small sizes a 42%-opacity disc all but
    // disappears, and the edge is what makes the smallest symbols countable.
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.BufferAttribute(ring, 3));
    rg.setIndex(ridx);
    const line = new THREE.LineSegments(rg, this._edge);
    line.frustumCulled = false;
    line.renderOrder = 11;
    this.group.add(line);
    this._parts.push(line);

    this.count = n;
  }

  dispose() {
    this._clear();
    this._fill.dispose();
    this._edge.dispose();
  }
}
