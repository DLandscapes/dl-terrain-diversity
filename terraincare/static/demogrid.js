// @ts-check
// THE OPENING TILE'S OWN 4 × 4 DIVISION, DRAWN ON THE GROUND.
//
// Marc, 2026-08-28: "we could add to enhance the grid appearance a 4x4 grid
// projected onto the mesh - fitting also the different terrain morphologies
// when you start the tool".
//
// ⚠️⚠️ THIS IS NOT DECORATION, AND THAT IS THE WHOLE JUSTIFICATION. `demotile.js`
// builds the opening surface as "one 64 m tile divided into a 4 × 4 grid, each
// cell carrying a DIFFERENT deformation, blended into one continuous surface",
// and the sixteen are taken IN ORDER along PATTERN_RANGE — the top-left corner
// is the most geometric and least consequential ground the library can make,
// the bottom-right the most differentiating. In that file's own words, "reading
// across the tile is reading the argument the whole tool exists to make."
//
// The blend is a partition of unity, so the seams are invisible by design — and
// therefore so is the structure. A viewer meeting the tool for the first time
// has no way to know there are sixteen deliberate cells, let alone that they
// are ordered as an argument. These lines say where the cells are.
//
// ⚠️⚠️ IT MUST NEVER BE DRAWN ON A SURVEYED TILE. A 4 × 4 division is TRUE of the
// generated tile and false of Ørndalen: ruling a grid over surveyed ground would
// assert a structure the ground does not have, which is the same class of error
// as a caption describing a figure that is not there. The caller is responsible
// for only building this for the generated tile, and app.js keys on the tile's
// own name to decide.
//
// Conventions follow SectionOverlay exactly, because they are the ones this
// project paid for: geometry LOCAL with the UTM origin on the group transform,
// depth testing OFF so a line lying in the surface cannot tie with it per
// fragment and shimmer, and the exaggeration carried on the group's z scale
// rather than baked into the vertices.

import * as THREE from "three";

const INK = 0x1c1a16;

export class DemoGridOverlay {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number, divisions?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.divisions = opts.divisions ?? 4;
    this.exaggeration = opts.verticalExaggeration ?? 1;
    this.group = new THREE.Group();
    // ⚠️ The origin lives HERE, never in a vertex buffer.
    this.group.position.set(dem.originX, dem.originY, 0);
    this.group.scale.set(1, 1, this.exaggeration);
    // Under the plan overlay's rings and the section marks: this is the
    // quietest thing in the scene and must never compete with a drawn gesture.
    this.group.renderOrder = 9;

    /**
     * ⚠️ FAINT, AND DELIBERATELY FAINTER THAN THE CONTOURS. The cell boundaries
     * are a fact about how the demo surface was MADE, not a reading of the
     * ground. If they carried the weight of a contour the first glance would
     * rank them as the more important line, which is exactly backwards.
     */
    this._line = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.45,
      depthTest: false, depthWrite: false, fog: false,
    });
    /** how many line objects the last build drew, for the self-test */
    this.count = 0;
    this._build();
  }

  /** @param {number} v */
  setExaggeration(v) {
    this.exaggeration = v;
    this.group.scale.z = v;
  }

  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  /**
   * Nearest-cell ground height. depthTest is off, so this is about the line
   * lying in the surface rather than about being occluded by it.
   * @param {number} x @param {number} y  world XY
   */
  _zAt(x, y) {
    const { originX, originY, cell, ncols, nrows } = this.dem;
    const c = Math.min(ncols - 1, Math.max(0, Math.floor((x - originX) / cell)));
    // ⚠️⚠️ ROW 0 IS THE NORTHERNMOST ROW, and originY is the SOUTH-WEST corner —
    // see the header of dem.js and the vertex build in surface.js, which sets
    // y = northY - (r + 0.5) * cell. Written here first as (y - originY) / cell,
    // which is the SOUTH-up reading: it draped every line on the height of the
    // cell mirrored about the tile centre. depthTest is off for this overlay, so
    // the lines still drew over the ground and the error was invisible from
    // above — it is only wrong, not obviously wrong, which is why it survived a
    // render check. Caught while settling the same convention for the vector
    // export, where a mirrored basin would have been shipped as data.
    const r = Math.min(nrows - 1, Math.max(0,
      Math.floor((nrows * cell - (y - originY)) / cell)));
    const v = this.dem.z[r * ncols + c];
    return Number.isFinite(v) ? v : null;
  }

  _build() {
    const { originX, originY, cell, ncols, nrows } = this.dem;
    const W = ncols * cell, H = nrows * cell;
    const D = this.divisions;

    /**
     * ⚠️ EVERY LINE IS SAMPLED AT THE DEM'S OWN RESOLUTION, not drawn as two
     * endpoints. A straight segment between corners would cut through every
     * rise it crosses and hang in the air over every hollow — the grid has to
     * lie ON the ground to say anything about which cell you are looking at.
     * At 0.25 m over 64 m that is 256 samples a line, 6 lines: trivial.
     */
    const drape = (x0, y0, x1, y1) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(2, Math.ceil(len / cell));
      const pos = new Float32Array((steps + 1) * 3);
      let n = 0;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        const z = this._zAt(x, y);
        if (z === null) continue;
        pos[n * 3] = x - originX; pos[n * 3 + 1] = y - originY; pos[n * 3 + 2] = z;
        n++;
      }
      if (n < 2) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, n * 3), 3));
      const l = new THREE.Line(g, this._line);
      l.frustumCulled = false;
      this.group.add(l);
      this.count++;
    };

    // ⚠️ INTERIOR LINES ONLY — D − 1 of them each way, not D + 1. The tile's
    // perimeter is already drawn by the dimension frame, and a second line on
    // top of it would read as a heavier edge rather than as the same edge.
    for (let k = 1; k < D; k++) {
      const x = originX + (W * k) / D;
      const y = originY + (H * k) / D;
      drape(x, originY, x, originY + H);
      drape(originX, y, originX + W, y);
    }
  }

  dispose() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      /** @type {any} */ (c).geometry?.dispose();
    }
    this._line.dispose();
  }
}
