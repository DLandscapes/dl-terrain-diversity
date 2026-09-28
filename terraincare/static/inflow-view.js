// @ts-check
/**
 * WHAT DRAINS IN, DRAWN ON THE CONTEXT.
 *
 * The picture that goes with `analysis/inflow.js`: the ground beyond the patch
 * that drains into it, shaded on the coarse tile, and an arrow at every cell
 * where the steepest path crosses the boundary.
 *
 * ⚠️ IT DRAWS ON THE CONTEXT'S GRID, AT THE CONTEXT'S RESOLUTION, and that is
 * the honest thing rather than a limitation to hide. The patch beneath it is
 * 0.25 m; this is 4 m, and the 4 m blockiness of the shaded catchment IS the
 * statement — the surrounding landform is known 16 × more coarsely than the
 * ground being designed. Smoothing the boundary would draw a precision the
 * national model does not have.
 *
 * ⚠️ ARROWS ARE SIZED BY CONTRIBUTING AREA, WITH A FLOOR. On the POI patch one
 * crossing carries 5,013 m² and the smallest carries a single cell, so a purely
 * proportional arrow would make everything except the main one invisible — the
 * same reason the drainage sheet classes its channels rather than scaling them
 * continuously. The area is on the readout; the arrow says WHERE.
 *
 * ⚠️ AND THE SHADING IS FLAT, NOT A RAMP. It answers a yes/no question — does
 * this ground drain into the patch — and a graded fill would invite reading a
 * depth or a rate into it, neither of which is computed here.
 */

import * as THREE from "three";

/** The catchment wash. Cool, and well back from the analysis ramps. */
const FILL = 0x3f7fa6;
const ARROW = 0x1c4f70;

export class InflowOverlay {
  /**
   * @param {import("./dem.js").DEM} context
   * @param {import("./analysis/inflow.js").Inflow} inflow
   * @param {{verticalExaggeration?: number, lift?: number}} [opts]
   */
  constructor(context, inflow, opts = {}) {
    this.dem = context;
    this.inflow = inflow;
    this.group = new THREE.Group();
    // ⚠️ The origin rides on the transform, never in a vertex buffer.
    this.group.position.set(context.originX, context.originY, 0);
    this.group.scale.set(1, 1, opts.verticalExaggeration ?? 1);
    this.group.renderOrder = 4;
    /**
     * ⚠️ LIFTED OFF THE GROUND IT DESCRIBES. Laid exactly on the context
     * surface this would z-fight it over the whole catchment; `polygonOffset`
     * would do for a flat sheet, but the wash follows the terrain and a
     * constant depth bias across a 500 m slope is not the same as clearance.
     * A lift proportional to the tile is both, and it is small enough that the
     * wash still reads as lying on the ground rather than hovering.
     */
    this.lift = opts.lift ?? Math.max(context.cell * 0.25, 0.4);

    this._fill = new THREE.MeshBasicMaterial({
      color: FILL, transparent: true, opacity: 0.30,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    this._line = new THREE.LineBasicMaterial({
      color: ARROW, transparent: true, opacity: 0.9,
      // ⚠️ DEPTH-TESTED (2026-09-27, Marc: "fix the other overlays for the
      // tilted view"). Off is right for a PLAN overlay — looking straight down
      // nothing occludes anything — and wrong the moment the camera tilts, where
      // linework showing through the ridge in front of it stops being a reading
      // and becomes noise. Safe here because this overlay already lifts itself
      // clear of the surface; the ones that do not keep the flag they have.
      depthTest: true, depthWrite: false, fog: false,
    });
    /** cells shaded, and arrows drawn — for the suite */
    this.cellCount = 0;
    this.arrowCount = 0;
    this._build();
  }

  /** @param {number} v */
  setExaggeration(v) { this.group.scale.z = v; }
  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  _zAt(r, c) {
    const v = this.dem.z[r * this.dem.ncols + c];
    return Number.isFinite(v) ? v : 0;
  }

  _build() {
    const { nrows, ncols, cell } = this.dem;
    const ext = this.inflow.external;
    const northY = nrows * cell;

    // ── the catchment, one quad per cell, draped on the coarse ground ────────
    const pos = [], idx = [];
    let v = 0;
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        if (!ext[r * ncols + c]) continue;
        const x0 = c * cell, x1 = x0 + cell;
        const y1 = northY - r * cell, y0 = y1 - cell;
        // ⚠️ THE CELL'S OWN HEIGHT AT ALL FOUR CORNERS, so the quad sits flat
        // like the cell it stands for. Interpolating the corners would round
        // the wash into a smooth sheet and lose the 4 m step that is the point.
        const z = this._zAt(r, c) + this.lift;
        pos.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z);
        idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
        v += 4;
        this.cellCount++;
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, this._fill);
      m.frustumCulled = false;
      m.renderOrder = 4;
      this.group.add(m);
    }

    // ── an arrow at every crossing, pointing into the patch ──────────────────
    const seg = [];
    const rect = this.inflow.rect;
    const cx = (rect.c0 + rect.c1 + 1) / 2, cr = (rect.r0 + rect.r1 + 1) / 2;
    for (const cr0 of this.inflow.crossings) {
      const col = Math.round((cr0.x - this.dem.originX) / cell - 0.5);
      const row = Math.round(nrows - 0.5 - (cr0.y - this.dem.originY) / cell);
      if (row < 0 || col < 0 || row >= nrows || col >= ncols) continue;
      const x = (col + 0.5) * cell, y = northY - (row + 0.5) * cell;
      const z = this._zAt(row, col) + this.lift;
      // Aim at the patch centre — the arrow says "in", not the exact D8 step,
      // which at 4 m would be one of eight directions and read as noise.
      let dx = (cx - (col + 0.5)), dy = -(cr - (row + 0.5));
      const L = Math.hypot(dx, dy) || 1;
      dx /= L; dy /= L;
      const len = cell * 2.2;
      const hx = x + dx * len, hy = y + dy * len;
      seg.push(x, y, z, hx, hy, z);
      // two barbs, swept back from the head
      const bw = cell * 0.55, bl = cell * 0.8;
      seg.push(hx, hy, z, hx - dx * bl - dy * bw, hy - dy * bl + dx * bw, z);
      seg.push(hx, hy, z, hx - dx * bl + dy * bw, hy - dy * bl - dx * bw, z);
      this.arrowCount++;
    }
    if (seg.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(seg), 3));
      const l = new THREE.LineSegments(g, this._line);
      l.frustumCulled = false;
      l.renderOrder = 11;
      this.group.add(l);
    }
  }

  dispose() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      /** @type {any} */ (c).geometry?.dispose();
    }
    this._fill.dispose();
    this._line.dispose();
  }
}
