// @ts-check
/**
 * THE APRON — the graded ring that carries the 0.25 m design patch out into the
 * 4 m context tile, so the two scales meet as one ground rather than as a fine
 * plate dropped into a hole.
 *
 * ⚠️ THE PROBLEM IS NOT A GAP, IT IS TWO DIFFERENT SURVEYS. Cutting the context
 * open under the patch (see dive.js) stopped the coarse tile drawing over ground
 * the fine one resolves, which was right. What it left is the real difficulty:
 * along the patch boundary the two datasets simply do not agree — one is a 4 m
 * aggregate, the other a 0.25 m measurement of the same place — so even a
 * perfect abutment would show a step. And the resolutions differ by 16×, so
 * there are 256 fine vertices along an edge where the coarse tile has 16.
 *
 * ⚠️ 10 m IS THE ONLY SENSIBLE BUFFER, AND IT IS NOT A ROUND-NUMBER CHOICE. The
 * design tile's edge lies on a context CELL BOUNDARY, while a surface's vertices
 * sit at cell CENTRES — so the context's vertex lattice, measured from the patch
 * corner, runs …−10, −6, −2, +2, +6… A buffer of 8, 12 or 16 m lands half a cell
 * off that lattice and the apron's outer edge would have no vertices to meet.
 * Usable widths are 2 + 4k: 2, 6, 10, 14, 18. Ten is the first that gives the
 * blend room to work. Measured against the real tiles, not assumed.
 *
 * HOW IT IS BUILT
 *
 * A non-uniform Cartesian grid over the patch-plus-buffer square, with the
 * quads the design surface already draws left out:
 *
 *   - Along each axis the coordinates are the design surface's OWN vertex
 *     positions across the patch, with graded steps outward on either side —
 *     fine where it meets the patch, opening to roughly the context's own cell
 *     size at the rim. The inner boundary therefore coincides with the design
 *     mesh's boundary vertices exactly, and cannot crack.
 *   - The outer boundary lands on the context's surviving vertex ring. The
 *     apron has more vertices along that rim than the context does, but each
 *     sits ON the straight segment between two context vertices, so the two
 *     surfaces are geometrically coincident there.
 *
 * ⚠️ AND THE RESOLUTION TRANSITION IS IN THE DATA, NOT IN THE TRIANGLES. There
 * is no 0.25 m data outside the patch — the design tile is exactly 64 m — so
 * nothing out here can carry fine detail, and grading the mesh finer than the
 * coarse surface it is reproducing would buy nothing. What the apron carries is
 * the DISCREPANCY between the two surveys: it equals the fine mesh at the patch
 * edge, equals the coarse mesh at the rim, and fades one into the other with a
 * smoothstep. The eye reads that as the detail dissolving into the backdrop,
 * which is what is actually happening.
 */
import * as THREE from "three";

/** Cubic smoothstep — zero slope at both ends, so neither seam shows a crease. */
const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Height of a DEM's rendered SURFACE at a local point, interpolated over the
 * TRIANGLE the renderer actually draws.
 *
 * ⚠️ TRIANGLE, NOT BILINEAR, and this project has now paid for that distinction
 * three times — contours had to be marched over triangles, the stems sank into
 * the ground when they read cell centres, and here it decides whether the
 * apron's rim lies exactly on the context's edge or a few centimetres off it.
 * surface.js splits every quad `a,d,b` and `b,d,e`, diagonal from (r,c+1) to
 * (r+1,c); a bilinear read agrees with that only along the diagonal itself.
 * @param {import("./dem.js").DEM} dem
 * @param {number} lx @param {number} ly local metres within `dem`
 */
export function surfaceZ(dem, lx, ly) {
  const { nrows, ncols, cell, z } = dem;
  const northY = nrows * cell;
  const fc = lx / cell - 0.5, fr = (northY - ly) / cell - 0.5;
  const c0 = Math.max(0, Math.min(ncols - 2, Math.floor(fc)));
  const r0 = Math.max(0, Math.min(nrows - 2, Math.floor(fr)));
  const u = Math.max(0, Math.min(1, fc - c0));
  const v = Math.max(0, Math.min(1, fr - r0));
  const za = z[r0 * ncols + c0];
  const zb = z[r0 * ncols + c0 + 1];
  const zd = z[(r0 + 1) * ncols + c0];
  const ze = z[(r0 + 1) * ncols + c0 + 1];
  if (!Number.isFinite(za) || !Number.isFinite(zb)
    || !Number.isFinite(zd) || !Number.isFinite(ze)) return NaN;
  return u + v <= 1
    ? za + u * (zb - za) + v * (zd - za)
    : ze + (1 - u) * (zd - ze) + (1 - v) * (zb - ze);
}

/**
 * The apron's coordinate list along one axis, in metres relative to the design
 * tile's origin: graded steps in, the design surface's own vertex positions
 * across the middle, graded steps out.
 *
 * ⚠️ THE MIDDLE IS COPIED, NOT REGENERATED. Recomputing the design lattice with
 * its own arithmetic would land within a rounding of the real vertices and open
 * a hairline crack all the way round that no amount of looking would explain.
 * @param {number} cell design cell size @param {number} n design cells
 * @param {number} buffer metres
 * @param {number} steps graded rows on each side
 */
export function apronAxis(cell, n, buffer, steps = 13) {
  const inner = [];
  for (let i = 0; i < n; i++) inner.push((i + 0.5) * cell);
  const lo = inner[0], hi = inner[inner.length - 1];
  // A power curve: small steps against the patch, opening outward. p > 1 puts
  // the fine spacing where the discrepancy is still being carried.
  const P = 1.7;
  const out = [];
  for (let k = steps; k >= 1; k--) {
    out.push(lo - (lo + buffer) * Math.pow(k / steps, P));
  }
  const after = [];
  for (let k = 1; k <= steps; k++) {
    after.push(hi + (n * cell + buffer - hi) * Math.pow(k / steps, P));
  }
  return [...out, ...inner, ...after];
}

export class Apron {
  /**
   * @param {import("./dem.js").DEM} design
   * @param {import("./dem.js").DEM} context
   * @param {{buffer?: number, verticalExaggeration?: number,
   *          contextColors?: THREE.BufferAttribute|null}} [opts]
   *   `contextColors` is the CONTEXT SURFACE's own colour attribute. Passed in
   *   rather than reproduced: the backdrop's tone is `0.95 × shade` with the
   *   shade varying per vertex, and a constant grey chosen to look about right
   *   would be about right only until that shading changed.
   */
  constructor(design, context, opts = {}) {
    this.design = design;
    this.context = context;
    this.buffer = opts.buffer ?? 10;
    this.exaggeration = opts.verticalExaggeration ?? 1;
    this.contextColors = opts.contextColors ?? null;

    this.xs = apronAxis(design.cell, design.ncols, this.buffer);
    this.ys = apronAxis(design.cell, design.nrows, this.buffer);
    /** first and last index of the design tile's own vertices, on each axis */
    this.i0 = 13; this.i1 = 13 + design.ncols - 1;

    this.geometry = new THREE.BufferGeometry();
    this._build();
    this._refreshZ();

    this.material = new THREE.MeshLambertMaterial({
      // ⚠️ WHITE MATERIAL × PER-VERTEX GREY, exactly as surface.js does it, so
      // the apron IS the backdrop's colour rather than an approximation of it.
      // A flat tone picked to match measured close and still read as a distinct
      // collar: the context carries its own occlusion, 0.78 to 0.95, and
      // anything constant sits wrong against half of it.
      color: 0xffffff,
      vertexColors: true,
      side: THREE.FrontSide,
      fog: false,
      // ⚠️ SMOOTH, unlike the terrain. surface.js shades hard so every facet
      // reads as a discrete 0.25 m sample, which is the argument. The apron is
      // not a measurement — it is an interpolation between two of them — and
      // faceting it would give the invented ground the same visual authority as
      // the surveyed ground beside it.
      flatShading: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // Local geometry, world origin on the object — the float32 rule that cost
    // this project three phases.
    this.mesh.position.set(design.originX, design.originY, 0);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  /**
   * Everything that does NOT change when the ground is edited: the lattice, the
   * triangles, the backdrop's tone, and the per-vertex terms of the blend that
   * depend only on the context. Run once.
   */
  _build() {
    const { xs, ys, design, context, buffer } = this;
    const nx = xs.length, ny = ys.length;
    const N = nx * ny;
    this.zc = new Float32Array(N);
    this.zcEdge = new Float32Array(N);
    this.fade = new Float32Array(N);
    this.edgeX = new Float32Array(N);
    this.edgeY = new Float32Array(N);
    const W = design.ncols * design.cell, H = design.nrows * design.cell;
    // The design tile's origin, in the CONTEXT's local frame.
    const ox = design.originX - context.originX;
    const oy = design.originY - context.originY;
    const lo = xs[this.i0], hiX = xs[this.i1];
    const loY = ys[this.i0], hiY = ys[this.i1];

    /**
     * The context surface's own tone at a local point in the CONTEXT's frame.
     *
     * ⚠️ NEAREST VERTEX, NOT INTERPOLATED, and that is the right call here. The
     * context is FLAT-shaded: each of its facets carries one tone, so its
     * colour is a per-facet quantity that happens to be stored per vertex.
     * Interpolating it would give the apron a smooth wash where the surface it
     * abuts has discrete steps, and the seam would read as a change of
     * material. Falls back to the base 0.95 when no attribute was supplied.
     */
    const colours = this.contextColors;
    const toneAt = (cx2, cy2) => {
      if (!colours) return 0.95;
      const { nrows, ncols, cell } = context;
      const northY = nrows * cell;
      const c = Math.max(0, Math.min(ncols - 1, Math.round(cx2 / cell - 0.5)));
      const r = Math.max(0, Math.min(nrows - 1, Math.round((northY - cy2) / cell - 0.5)));
      return colours.getX(r * ncols + c);
    };

    const pos = new Float32Array(nx * ny * 3);
    const col = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = xs[i], y = ys[j];
        const k = j * nx + i;
        const o = k * 3;
        // How far outside the design tile this vertex is, 0 at the patch edge
        // and 1 at the rim. Chebyshev, so the corners reach 1 as well.
        const d = Math.max(0, -x, x - W, -y, y - H);
        const s = smoothstep(Math.min(1, d / buffer));
        // The coarse surface here, and at the nearest point on the patch edge.
        const zc = surfaceZ(context, ox + x, oy + y);
        const ex_ = Math.min(hiX, Math.max(lo, x));
        const ey_ = Math.min(hiY, Math.max(loY, y));
        const zcEdge = surfaceZ(context, ox + ex_, oy + ey_);
        // ⚠️ CACHED, BECAUSE THE GROUND UNDER THE PATCH MOVES AND THIS DOES NOT.
        // Only `zfEdge` depends on the design surface; the context height, the
        // fade and the edge point are fixed for the life of the apron. Keeping
        // them means an edit re-solves one sample per vertex instead of four,
        // which is what lets the seam follow a brush stroke at gesture rate.
        this.zc[k] = Number.isFinite(zc) ? zc : 0;
        this.zcEdge[k] = Number.isFinite(zcEdge) ? zcEdge : 0;
        this.fade[k] = 1 - s;
        this.edgeX[k] = ex_;
        this.edgeY[k] = ey_;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = 0;   // filled by _refreshZ

        // ⚠️ THE BACKDROP'S TONE ALL THE WAY IN, NOT A FADE TO THE PATCH'S.
        // The design surface is currently painted with an analysis ramp, and
        // carrying that outward would claim the layer had been computed over
        // ground where there is no data to compute it from. The apron is
        // invented ground — an interpolation between two surveys — and it
        // should read as backdrop right up to the seam, where measured ground
        // takes over. The geometry blends; the meaning does not.
        const g = toneAt(ox + x, oy + y);
        col[o] = g; col[o + 1] = g; col[o + 2] = g;
      }
    }

    const idx = [];
    const inPatch = (i, j) =>
      i >= this.i0 && i + 1 <= this.i1 && j >= this.i0 && j + 1 <= this.i1;
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        // Leave out exactly the quads the design surface already draws.
        if (inPatch(i, j)) continue;
        const a = j * nx + i, b = a + 1, d2 = a + nx, e = d2 + 1;
        // Same diagonal as surface.js, so a shared edge is genuinely shared.
        //
        // ⚠️ BUT THE OPPOSITE WINDING, AND COPYING surface.js's LITERALLY IS
        // WRONG HERE. That file's row index runs SOUTHWARD — its vertex y is
        // `northY − (r + 0.5)·cell`, decreasing as r grows — while this grid's
        // `ys` run northward, increasing with j. The same index pattern over
        // mirrored geometry gives mirrored triangles: every normal pointed at
        // the ground, and FrontSide then culled the entire apron from any camera
        // above it. It was invisible, not misdrawn, and every seam measurement
        // passed to the bit while it was inside out — orientation is not a
        // property any of them look at.
        idx.push(a, b, d2, b, e, d2);
      }
    }

    const posAttr = new THREE.Float32BufferAttribute(pos, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);   // rewritten on every edit
    this.geometry.setAttribute("position", posAttr);
    this.geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    this.geometry.setIndex(idx);
    this.triangles = idx.length / 3;
  }

  /**
   * Re-solve the heights against the design surface as it stands NOW.
   *
   * ⚠️ THE APRON IS STITCHED TO GROUND THAT MOVES. It is built from the design
   * surface's boundary heights, so the moment a brush touches the edge of the
   * patch — or a region is levelled, or a pattern stamped across it — the seam
   * it was built to close tears open, and a hole appears in exactly the place
   * the whole feature exists to have none. Nothing throws; the apron simply
   * describes a boundary that has moved.
   *
   * ⚠️ AND THE ANSWER IS TO FOLLOW THE GROUND, NOT TO CAP THE HOLE. A vertical
   * skirt across the gap would close it, and would put a cliff at the seam —
   * undoing the blend rather than maintaining it. The cost of doing it properly
   * is one design sample per vertex, because everything else was cached at
   * build time.
   */
  _refreshZ() {
    const ex = this.exaggeration;
    const pos = /** @type {THREE.BufferAttribute} */ (this.geometry.getAttribute("position"));
    const arr = /** @type {Float32Array} */ (pos.array);
    const n = this.zc.length;
    for (let k = 0; k < n; k++) {
      const zf = surfaceZ(this.design, this.edgeX[k], this.edgeY[k]);
      // ⚠️ THE OFFSET IS WHAT IS BLENDED, not the two heights. Lerping z_fine
      // toward z_coarse would drag the patch's own boundary height away from the
      // value the design mesh draws there, opening the very step the apron
      // exists to close. Carrying the DIFFERENCE and fading it to zero leaves
      // both seams exact by construction.
      const dz = Number.isFinite(zf) ? zf - this.zcEdge[k] : 0;
      arr[k * 3 + 2] = (this.zc[k] + dz * this.fade[k]) * ex;
    }
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }

  /** The design surface changed — re-solve the seam. */
  refresh() { this._refreshZ(); }

  /** @param {number} v */
  setExaggeration(v) {
    this.exaggeration = v;
    this._refreshZ();
  }

  setVisible(on) { this.mesh.visible = !!on; }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
