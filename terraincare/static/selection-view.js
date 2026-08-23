// @ts-check
// THE SELECTION, DRAWN AS EDGES ON THE MESH.
//
// Follows the conventions section-view.js, dimensions.js and photo-view.js
// already set: geometry LOCAL with the UTM origin on the group transform,
// depth testing OFF so a line lying in the surface cannot tie with it per
// fragment and shimmer, and the vertical exaggeration carried on the group's
// z scale rather than baked into the vertices.
//
// ⚠️ THE BOUNDARY, NOT EVERY EDGE (2026-08-11). Marc asked for the selected
// faces' edges, and the literal reading — every edge of every selected cell —
// is what the first sketch of this did: on a rule selecting 26 373 cells at
// 0.25 m it drew ~52 000 segments a quarter-metre apart, which fills the
// selection with solid ink and hides the very ground being judged. It also
// buries the one thing a selection has to say, which is WHERE IT STOPS.
//
// So only edges on the boundary are drawn — the sides of a selected cell whose
// neighbour is NOT selected, or which fall off the grid. That is the marquee
// every CAD and GIS draws, it is a small fraction of the segment count, and it
// outlines holes as well as outer edges because a hole's rim is a boundary by
// exactly the same test.
//
// ⚠️ THE MASK IS PER VERTEX, NOT PER FACE, and the difference matters here.
// `rasterise()` and `maskFromRule()` both index like `dem.z` — one entry per
// GRID POINT — so a "cell" in this module is the square centred on a vertex,
// half a cell wide in each direction. Drawing the boundary on face corners
// instead would put the outline half a cell off, consistently, in a way that
// looks like a rounding bug and is really a confusion of two grids.
//
// ⚠️ THE OUTLINE IS DRAPED ON CORNERS, NOT FLOATED AT CELL CENTRES (2026-08-12).
// The first version gave all four sides of a cell that cell's OWN centre height,
// which makes every segment perfectly horizontal. Neighbouring cells sit at
// different heights, so on any sloping ground consecutive segments met in plan
// and not in z, and the boundary broke into a floating staircase. Measured on a
// 7×7 block over a 26° synthetic slope: 28 segments, 28 shared corners in plan,
// and 24 OF THOSE 28 CORNERS CARRIED MORE THAN ONE z — a 0.12 m vertical break
// at almost every corner, with 0 segments sloped. On the real POI patch
// (19.57° mean, 0.25 m cells) endpoints stood up to 0.632 m off the ground.
// Each endpoint now takes the height of the GRID CORNER it sits on — the mean
// of the up-to-four vertices around that corner, which is the bilinear value at
// that point. Every segment ending at a corner therefore gets a bit-identical
// 3D point, so the boundary closes, and it follows the ground instead of
// stepping over it. Plan geometry is unchanged; only z moved.

import * as THREE from "three";

const INK = 0x000000;

/**
 * Most selected cells that will carry a drawn mesh.
 *
 * ⚠️ MEASURED, NOT GUESSED. The 2026-08-11 attempt drew the lattice over 26 373
 * cells and produced solid ink. 4 000 cells is about 8 000 segments — dense
 * enough to read as a mesh at the zoom a selection of that size is looked at,
 * and an order of magnitude below the count that failed.
 */
const MESH_CELL_BUDGET = 4000;

export class SelectionOverlay {
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
    this.group.renderOrder = 14;   // above the plan rings and the sections
    this.group.visible = false;
    this._mat = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.95,
      depthTest: false, depthWrite: false, fog: false,
    });
    // ⚠️ A SECOND, QUIETER MATERIAL FOR THE INTERIOR LATTICE (Marc,
    // 2026-08-20). The boundary must stay the loudest thing the overlay draws —
    // it is the one fact a selection has to state, WHERE IT STOPS — so the mesh
    // edges inside it are thinner in effect: a third of the opacity, and drawn
    // under the boundary. At equal weight the outline disappears into its own
    // fill, which is how the 2026-08-11 version failed.
    this._matMesh = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.30,
      depthTest: false, depthWrite: false, fog: false,
    });
    /** segments drawn by the last build, for the self-test */
    this.count = 0;
    /** interior lattice segments in the last build, 0 when suppressed */
    this.meshCount = 0;
    /** true when the interior lattice was dropped for being too dense */
    this.meshSuppressed = false;
    this._line = null;
    this._mesh = null;
    /**
     * The selection this overlay is currently drawing, kept so the SAME
     * selection can be re-draped after the ground under it moves.
     * @type {Uint8Array|null}
     */
    this._mask = null;
  }

  /** @param {number} v */
  setExaggeration(v) { this.group.scale.z = v; }
  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  _clear() {
    for (const k of ["_line", "_mesh"]) {
      if (this[k]) {
        this.group.remove(this[k]);
        this[k].geometry.dispose();
        this[k] = null;
      }
    }
    this.count = 0;
    this.meshCount = 0;
    this.meshSuppressed = false;
  }

  /**
   * Outline a mask.
   * @param {Uint8Array|null} mask one entry per grid point, as dem.z
   */
  setMask(mask) {
    this._mask = mask || null;
    this._build();
  }

  /**
   * Re-drape the CURRENT selection onto the surface as it now stands.
   *
   * ⚠️ THE SELECTION IS NOT RE-EVALUATED HERE, and that is the whole point of
   * having a separate method. A rule reads the current surface, so re-running it
   * after an edit would select different cells — correct as a statement about
   * the ground, and wrong as a thing to do behind the designer's back, because
   * it silently changes what the next modifier acts on. What moved is the height
   * under the boundary, not the boundary, so only the drape is rebuilt. Asking
   * for the rule again is a click, and stays one.
   */
  refresh() { this._build(); }

  _build() {
    this._clear();
    const mask = this._mask;
    if (!mask) return;
    const { nrows, ncols, cell, z } = this.dem;
    const northY = nrows * cell;
    /** @type {number[]} */
    const pts = [];

    // ⚠️ LIFTED A HAIR ABOVE THE SURFACE as well as depth-tested off. Depth
    // testing is disabled so the line always draws, but the lift keeps it from
    // reading as *inside* the ground when the camera is nearly edge-on, which
    // is the angle a plan-mode user tilts into first.
    const lift = Math.max(cell * 0.02, 0.005);

    // Height at a GRID CORNER (R, C) — the point where up to four cells meet,
    // half a cell north-west of vertex (R, C). Averaging the vertices present
    // IS the bilinear value at that point; at the grid rim the ones that fall
    // outside are simply absent, so the corner takes the mean of what is really
    // there rather than of an invented neighbour. NaN in, NaN skipped — a cell
    // with no measurement must not pull a corner toward zero.
    const cornerZ = (R, C) => {
      let sum = 0, n = 0;
      for (let r = R - 1; r <= R; r++) {
        if (r < 0 || r >= nrows) continue;
        for (let c = C - 1; c <= C; c++) {
          if (c < 0 || c >= ncols) continue;
          const v = z[r * ncols + c];
          if (Number.isFinite(v)) { sum += v; n++; }
        }
      }
      return n ? sum / n + lift : NaN;
    };
    // ⚠️ ON THE SURFACE'S OWN LATTICE (2026-08-13). surface.js puts vertex
    // (r,c) at ((c+0.5)·cell, northY−(r+0.5)·cell) — brush.js, ponding.js and
    // the exporters all agree — so the cell centred on that vertex spans
    // [C·cell, (C+1)·cell] and its corners land on the C·cell lattice. The
    // first version wrote `C·cell − half`, which assumed vertices AT C·cell
    // and displaced the whole outline half a cell north-west of the terrain
    // it was outlining: cornerZ already sampled the right corner, so the
    // heights were correct and drawn in the wrong place. patch-view.js had
    // the correct lattice from the start; this now matches it.
    const px = (C) => C * cell;
    const py = (R) => northY - R * cell;
    /** One cell side, named by the two corners it runs between. */
    const seg = (R0, C0, R1, C1) => {
      const z0 = cornerZ(R0, C0), z1 = cornerZ(R1, C1);
      if (!Number.isFinite(z0) || !Number.isFinite(z1)) return;
      pts.push(px(C0), py(R0), z0, px(C1), py(R1), z1);
    };

    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        if (!mask[r * ncols + c]) continue;
        // A side is on the boundary when its neighbour is unselected or the
        // grid ends there.
        if (r === 0 || !mask[(r - 1) * ncols + c]) {
          seg(r, c, r, c + 1);            // north
        }
        if (r === nrows - 1 || !mask[(r + 1) * ncols + c]) {
          seg(r + 1, c, r + 1, c + 1);    // south
        }
        if (c === 0 || !mask[r * ncols + c - 1]) {
          seg(r, c, r + 1, c);            // west
        }
        if (c === ncols - 1 || !mask[r * ncols + c + 1]) {
          seg(r, c + 1, r + 1, c + 1);    // east
        }
      }
    }
    // ── the quad mesh inside the selection ────────────────────────────────
    // ⚠️ THIS WAS TRIED AND REJECTED ON 2026-08-11, AND THE REASON HAS NOT GONE
    // AWAY. Drawing every edge of every selected cell put ~52 000 segments a
    // quarter-metre apart over a 26 373-cell rule and filled the selection with
    // solid ink, hiding the ground being judged. Marc asked for it again on
    // 2026-08-20, so it is here — with the failure bounded rather than
    // rediscovered.
    //
    // ⚠️ THE BUDGET IS THE WHOLE DIFFERENCE. Below it the lattice reads as a
    // mesh; above it every version of this is ink, at any opacity, because the
    // spacing on screen is what fails and not the colour. Past the budget the
    // interior is dropped and `meshSuppressed` says so, so the caller can tell
    // the user rather than leaving them to wonder why a selection they just
    // widened stopped showing its cells.
    const interior = [];
    if (mask) {
      let selected = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) selected++;
      if (selected > 0 && selected <= MESH_CELL_BUDGET) {
        // Each cell contributes only its NORTH and WEST sides; the south and
        // east sides belong to the neighbours. Drawing all four would put two
        // coincident lines on every shared edge — double the buffer for an
        // identical picture, and a visibly heavier line wherever they overlap.
        for (let r = 0; r < nrows; r++) {
          for (let c = 0; c < ncols; c++) {
            if (!mask[r * ncols + c]) continue;
            const z0 = cornerZ(r, c), zN = cornerZ(r, c + 1), zW = cornerZ(r + 1, c);
            if (Number.isFinite(z0) && Number.isFinite(zN)) {
              interior.push(px(c), py(r), z0, px(c + 1), py(r), zN);
            }
            if (Number.isFinite(z0) && Number.isFinite(zW)) {
              interior.push(px(c), py(r), z0, px(c), py(r + 1), zW);
            }
          }
        }
      } else if (selected > MESH_CELL_BUDGET) {
        this.meshSuppressed = true;
      }
    }
    if (interior.length) {
      const gm = new THREE.BufferGeometry();
      gm.setAttribute("position",
        new THREE.BufferAttribute(new Float32Array(interior), 3));
      this._mesh = new THREE.LineSegments(gm, this._matMesh);
      this._mesh.frustumCulled = false;
      // Under the boundary, so the marquee still reads as the marquee.
      this._mesh.renderOrder = 13;
      this.group.add(this._mesh);
      this.meshCount = interior.length / 6;
    }

    if (!pts.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    this._line = new THREE.LineSegments(g, this._mat);
    this._line.frustumCulled = false;
    this._line.renderOrder = 14;
    this.group.add(this._line);
    this.count = pts.length / 6;
  }

  dispose() {
    this._clear();
    this._matMesh.dispose();
    this._mask = null;   // never hold a grid-sized array past the tile it indexes
    this._mat.dispose();
  }
}
