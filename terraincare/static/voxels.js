// @ts-check
// The terrain as a field of cubes.
//
// WHY THIS IS NOT JUST A LOOK. A smooth mesh interpolates between samples and in
// doing so implies a precision the data does not have. This project's central
// finding is the opposite: the micro-topography that generates habitat sits at
// or below the noise floor of national LiDAR, which is why it has to be designed
// rather than surveyed (planning/02 §4). Cubes state their own resolution
// openly — you can see exactly how coarse the reading is, in both plan and
// height.
//
// It also matches what the tool is about. Cut and fill are the removal and
// placement of material, and cubes read as material in a way a rubber sheet does
// not: scooping visibly takes stuff away. It is also how earthworks are actually
// specified and costed — in volumes of stuff, not in contours.
//
// THREE THINGS HAD TO BE RIGHT, and each was wrong at first:
//
//   1. SIZE. One block per DEM cell put 65 536 blocks on the patch, each two or
//      three screen pixels across; they merged back into a surface. Cells are
//      aggregated into blocks large enough to read as objects.
//   2. PROPORTION. Tying the height step to the level count let a 0.25 m block
//      get a 0.46 m step, so the field rendered as thin pillars. The step is now
//      capped at the block width, so a cube is never taller than it is wide.
//   3. ONE cube per column, STRETCHED to close gaps (2026-07-30, replacing the
//      earlier stack-of-cubes design on direct user feedback: the stacks read
//      as columns going down to the base plate, "not really voxels"). Each
//      column draws a single box whose top is its own level and whose bottom
//      reaches down exactly to its lowest neighbour's level — on gentle ground
//      that is one perfect cube, on a steep step a taller box, and nowhere can
//      the line of sight slip between columns into the void below.
//
// The tile perimeter gets NO skirt: out-of-grid neighbours are no constraint,
// so an edge column is a plain cube like any other and the field reads as a
// floating voxel sheet (decided over the alternative, a solid plinth skirt —
// seeing under the rim from a low outside angle is accepted).

import * as THREE from "three";

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

/** Aim for about this many blocks across the grid. */
const TARGET_BLOCKS_ACROSS = 64;

/** 8 line segments per cube: the top square plus the four vertical corners. */
const EDGE_VERTS = 16;

/**
 * Fraction of its cell each block leaves empty.
 *
 * Kept tiny, but no longer for the reason originally recorded. Phase 3 set this
 * to 0.4% because 8% "tore white gaps across the terrain at grazing angles",
 * and separately established that the z-fighting fear behind the original 8%
 * was itself unfounded (coincident faces sit back to back, so one is always
 * culled and the conflict never reaches the depth test).
 *
 * Re-measured 2026-07-31, after the stretched-cube rewrite and the float32
 * coordinate fix: the field shows 0.00% see-through at EVERY gap from 0% to 8%,
 * at both block sizes tested. The tearing was a property of the old stack
 * design plus half-metre position error, not of the gap — boxes now overlap
 * their lower neighbour by a full level, which closes the sight line whatever
 * the horizontal inset.
 *
 * So this value is now a free aesthetic choice rather than a constraint, and it
 * stays small only because touching blocks read as one solid ground. A visible
 * gap is available if the blocks should ever read as discrete objects instead.
 */
const BLOCK_GAP = 0.004;

/**
 * Fewest height steps worth showing. Below this the terrain flattens into a
 * plateau: an 8 m cube on ground with 5.5 m of relief cannot express structure,
 * because one cube is taller than the whole landform.
 */
const MIN_LEVELS = 10;

export class VoxelField {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number, aoStrength?: number, blockCells?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.exaggeration = opts.verticalExaggeration ?? 1;
    // Lighter than the smooth surface uses. A cube field already darkens three
    // ways the surface does not — side faces turned from the key light, the
    // drawn outlines, and the depth fade on buried cubes — and stacking full
    // occlusion on top of those made the whole field read muddy.
    this.aoStrength = opts.aoStrength ?? 0.45;

    this.blockCells = opts.blockCells ??
      Math.max(1, Math.round(dem.ncols / TARGET_BLOCKS_ACROSS));

    /** @type {Float32Array|null} */
    this.ao = null;
    /**
     * Analysis layer painted onto the cubes — the same RGBA buffer the worker
     * produced for the sidebar panel, so the 3D view and the panel cannot
     * disagree about ramp, stretch or sign convention.
     * @type {Uint8ClampedArray|null}
     */
    this.layer = null;
    /**
     * An analysis layer read as SIZE instead of as colour — the viewport's
     * version of the proportional-symbol technique the grading sheet uses
     * (symbols.js). Normalised 0..1 per cell against the ramp's own stretched
     * domain, NaN where the layer has no answer.
     *
     * ⚠️ SIZE AND COLOUR ARE TWO CHANNELS AND MAY CARRY TWO LAYERS. That is the
     * point of having both — wetness as tone under ruggedness as bulk says
     * something neither says alone. It is also the one thing that can mislead
     * here, so `sizeLayerName` travels with the field and the panel names both.
     * @type {Float32Array|null}
     */
    this.scale = null;
    /** Smallest cube drawn, as a fraction of full — never 0; see below. */
    this.scaleMin = 0.15;

    const [lo, hi] = dem.zRange();
    this._lo = lo;
    this._span = hi - lo;
    this.baseZ = lo - this.blockWidth;

    this.mesh = null;
    this.edges = null;
    this._capacity = 0;
    this.cubeCount = 0;

    // One box per block, exactly — the stretched-cube design needs no
    // grow-and-reallocate path.
    this._allocate(this.blockRows * this.blockCols);
    this._rebuildStacks();
  }

  /** Block footprint in ground units. */
  get blockWidth() { return this.blockCells * this.dem.cell; }

  /** Drawn footprint, a hair smaller so neighbours never share a face plane. */
  get drawWidth() { return this.blockWidth * (1 - BLOCK_GAP); }

  /**
   * Height quantum in GROUND units. Capped at the block width so a cube is
   * never taller than it is wide, and capped again at span/MIN_LEVELS so the
   * coarse end cannot collapse to one or two plateaus. Between the two, cubes
   * are exactly cubic.
   */
  get voxelHeight() {
    const cubic = this.blockWidth / Math.max(this.exaggeration, 1e-6);
    if (!(this._span > 0)) return cubic;
    return Math.min(cubic, this._span / MIN_LEVELS);
  }

  /** True when cubes really are cubes rather than flattened by the level cap. */
  get isCubic() {
    return Math.abs(this.voxelHeight - this.blockWidth / Math.max(this.exaggeration, 1e-6)) < 1e-9;
  }

  /** Number of height steps through the terrain's relief. */
  get levels() {
    return this._span > 0 ? Math.round(this._span / this.voxelHeight) : 1;
  }

  get blockRows() { return Math.ceil(this.dem.nrows / this.blockCells); }
  get blockCols() { return Math.ceil(this.dem.ncols / this.blockCells); }

  /* --------------------------------------------------------------- buffers */

  /** @param {number} capacity number of cube instances to make room for */
  _allocate(capacity) {
    const keepParent = this.mesh ? this.mesh.parent : null;
    if (this.mesh) this._disposeGpu();

    this._capacity = capacity;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    // fog:false — the scene fog fades only the ground grid (view.js).
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff, fog: false });
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    // Outlines are what make cubes read as cubes: every top face is parallel to
    // every other, so shading alone merges them into one field. Not instanced —
    // three.js sets the instancing shader define only for InstancedMesh, which
    // is a Mesh, so LineSegments cannot use it. One plain geometry holding every
    // cube's edges is simpler and cheap at this count.
    this.edgeVerts = new Float32Array(capacity * EDGE_VERTS * 3);
    const egeo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(this.edgeVerts, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    egeo.setAttribute("position", attr);
    this.edges = new THREE.LineSegments(egeo, new THREE.LineBasicMaterial({
      color: 0x3a352c, transparent: true, opacity: 0.20, depthWrite: false,
      fog: false,
    }));
    this.edges.frustumCulled = false;
    this.mesh.add(this.edges); // rides along, so the app tracks one object

    if (keepParent) keepParent.add(this.mesh);
  }

  _disposeGpu() {
    if (this.edges) {
      this.edges.geometry.dispose();
      /** @type {any} */ (this.edges.material).dispose();
    }
    if (this.mesh) {
      if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.material.dispose();
      this.mesh.dispose();
    }
  }

  /* ------------------------------------------------------------- sampling */

  /** Mean elevation, occlusion and layer colour over the cells in one block. */
  _aggregate(br, bc) {
    const { z, nrows, ncols } = this.dem;
    const k = this.blockCells;
    const r0 = br * k, c0 = bc * k;
    const r1 = Math.min(nrows - 1, r0 + k - 1);
    const c1 = Math.min(ncols - 1, c0 + k - 1);
    let zs = 0, zn = 0, as = 0, an = 0, lr = 0, lg = 0, lb = 0, ln = 0;
    let ss = 0, sn = 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * ncols + c;
        const v = z[i];
        if (Number.isFinite(v)) { zs += v; zn++; }
        if (this.ao) { const a = this.ao[i]; if (Number.isFinite(a)) { as += a; an++; } }
        if (this.layer) {
          const q = i * 4;
          lr += this.layer[q]; lg += this.layer[q + 1]; lb += this.layer[q + 2]; ln++;
        }
        // ⚠️ AVERAGED OVER THE CELLS THAT HAVE AN ANSWER, NOT OVER THE BLOCK.
        // Counting a NaN as zero would shrink a block because part of it was
        // unmeasured, which reads as a low value — the same misreading the
        // symbol field refuses by drawing no circle at all.
        if (this.scale) {
          const s = this.scale[i];
          if (Number.isFinite(s)) { ss += s; sn++; }
        }
      }
    }
    return {
      z: zn ? zs / zn : NaN,
      ao: an ? as / an : NaN,
      rgb: ln ? [lr / ln / 255, lg / ln / 255, lb / ln / 255] : null,
      s: sn ? ss / sn : NaN,
    };
  }

  /* -------------------------------------------------------------- building */

  _rebuildStacks() {
    const { nrows, cell, originX, originY } = this.dem;
    const ex = this.exaggeration;
    const w = this.blockWidth;
    const dw = this.drawWidth;
    const q = this.voxelHeight;
    // LOCAL coordinates, same reasoning as surface.js: instance translations
    // live in a float32 buffer, and at this site's northing (~7.7e6) float32
    // resolves only 0.5 m — which displaced half-metre blocks by up to their
    // own width and tore the field open. The UTM origin rides on
    // mesh.position, where CPU float64 cancels it against the camera.
    const northY = nrows * cell;
    const baseZ = this.baseZ * ex;
    this.mesh.position.set(originX, originY, 0);
    const cubeH = q * ex;
    const bRows = this.blockRows, bCols = this.blockCols;
    const nBlocks = bRows * bCols;

    if (!this._levels || this._levels.length !== nBlocks) {
      this._levels = new Int32Array(nBlocks);
      this._starts = new Int32Array(nBlocks);
      this._agg = new Array(nBlocks);
    }
    const levels = this._levels, starts = this._starts, aggs = this._agg;

    // Pass 1: level and aggregate per block, so neighbour lookups are reads.
    for (let br = 0; br < bRows; br++) {
      for (let bc = 0; bc < bCols; bc++) {
        const i = br * bCols + bc;
        const a = this._aggregate(br, bc);
        aggs[i] = a;
        levels[i] = Number.isFinite(a.z)
          ? Math.max(1, Math.round((a.z - this.baseZ) / q)) : -1;
      }
    }

    // Pass 2: how far down each column's single box must stretch. The bottom
    // reaches the lowest VALID neighbour's level, so a line of sight can never
    // slip between two columns into the void — and no further, so on gentle
    // ground the box is exactly one cube. Out-of-grid and nodata neighbours
    // are no constraint: the perimeter gets a plain cube, not a skirt down to
    // the base plate (the skirt is precisely what read as "not really
    // voxels").
    for (let br = 0; br < bRows; br++) {
      for (let bc = 0; bc < bCols; bc++) {
        const i = br * bCols + bc;
        const L = levels[i];
        if (L < 0) { starts[i] = 1; continue; }
        let lowest = L;
        for (let d = 0; d < 4; d++) {
          const nr = br + (d === 0 ? -1 : d === 1 ? 1 : 0);
          const nc = bc + (d === 2 ? -1 : d === 3 ? 1 : 0);
          if (nr < 0 || nr >= bRows || nc < 0 || nc >= bCols) continue;
          const nl = levels[nr * bCols + nc];
          if (nl >= 0 && nl < lowest) lowest = nl;
        }
        starts[i] = Math.max(1, Math.min(L, lowest));
      }
    }

    // Pass 3: write one box per column. Top at the column's own level, bottom
    // stretched to one level BELOW the lowest neighbour's top (starts-1), so
    // the box overlaps the neighbour's top cube by one level — hidden inside
    // the solid, and it is what keeps diagonal corners closed even though the
    // exposure pass only consults the four orthogonal neighbours.
    const colors = /** @type {THREE.InstancedBufferAttribute} */ (this.mesh.instanceColor);
    const E = this.edgeVerts;
    const hw = (dw / 2) * 1.012;
    const zPad = cubeH * 0.004;
    let n = 0;

    for (let br = 0; br < bRows; br++) {
      for (let bc = 0; bc < bCols; bc++) {
        const bi = br * bCols + bc;
        const L = levels[bi];
        if (L < 0) continue;
        const agg = aggs[bi];

        // ⚠️ NO ANSWER, NO CUBE — the rule symbols.js keeps, for the reason it
        // keeps it. A block scaled to its minimum where the layer is undefined
        // would read as "measured, and very low" exactly where the truth is
        // "not measured at all", and on TWI that is most of a levelled surface:
        // the tool would draw its own central finding as a small value rather
        // than as an absence.
        let f = 1;
        if (this.scale) {
          if (!Number.isFinite(agg.s)) continue;
          f = this.scaleMin + (1 - this.scaleMin) * agg.s;
        }

        let shade = 1;
        if (Number.isFinite(agg.ao)) {
          const openness = Math.min(1, Math.max(0, (agg.ao - 0.55) / 0.45));
          shade *= 1 - this.aoStrength * (1 - openness);
        }
        const t = this._span > 0 ? (agg.z - this._lo) / this._span : 0.5;
        const lift = 0.94 + 0.14 * t;

        const cx = (bc + 0.5) * w;
        const cy = northY - (br + 0.5) * w;

        // Box spans levels starts..L inclusive; exactly one cube on gentle
        // ground (starts === L), taller where a neighbour sits lower.
        //
        // ⚠️ SCALING TURNS THE STRETCH OFF, AND THAT IS NOT AN OMISSION. The
        // stretch exists to close the sight line between columns so the field
        // reads as continuous ground; a field whose blocks are deliberately
        // separated has already given that up, and stretching a narrowed block
        // down five levels draws exactly the thin pillars note 2 in this file's
        // header was written about. Scaled, each block is one cube.
        //
        // ⚠️ AND ITS TOP STAYS AT THE BLOCK'S OWN LEVEL, so the field's upper
        // silhouette is still the terrain. Shrinking about the centre would
        // move the ground surface by half a cube wherever the attribute is
        // low — size would then be quietly altering the elevation reading,
        // which is the one thing a terrain view may not do.
        const top = baseZ + L * cubeH;
        const boxW = dw * f;
        const boxH = this.scale ? cubeH * f : (L - starts[bi] + 1) * cubeH;
        const zc = this.scale ? top - boxH / 2
          : baseZ + ((starts[bi] - 1 + L) / 2) * cubeH;
        _m.makeScale(boxW, boxW, boxH);
        _m.setPosition(cx, cy, zc);
        this.mesh.setMatrixAt(n, _m);

        if (this.flat) {
          // "None": plain white, shaped only by the lighting rig.
          _c.setRGB(1, 1, 1);
        } else if (agg.rgb) {
          const lit = 0.45 + 0.55 * shade;
          _c.setRGB(agg.rgb[0] * lit, agg.rgb[1] * lit, agg.rgb[2] * lit);
        } else {
          const g = 0.95 * shade * lift;
          _c.setRGB(g, g, g);
        }
        colors.setXYZ(n, _c.r, _c.g, _c.b);

        const zt = zc + boxH / 2 + zPad;
        const zb = zc - boxH / 2 - zPad;
        const hwF = hw * f;
        const x0 = cx - hwF, x1 = cx + hwF, y0 = cy - hwF, y1 = cy + hwF;
        let p = n * EDGE_VERTS * 3;
        const seg = (ax, ay, az, bx, by, bz) => {
          E[p++] = ax; E[p++] = ay; E[p++] = az;
          E[p++] = bx; E[p++] = by; E[p++] = bz;
        };
        seg(x0, y0, zt, x1, y0, zt);
        seg(x1, y0, zt, x1, y1, zt);
        seg(x1, y1, zt, x0, y1, zt);
        seg(x0, y1, zt, x0, y0, zt);
        seg(x0, y0, zb, x0, y0, zt);
        seg(x1, y0, zb, x1, y0, zt);
        seg(x1, y1, zb, x1, y1, zt);
        seg(x0, y1, zb, x0, y1, zt);

        n++;
      }
    }

    this.cubeCount = n;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    colors.needsUpdate = true;
    this.edges.geometry.setDrawRange(0, n * EDGE_VERTS);
    this.edges.geometry.getAttribute("position").needsUpdate = true;

    // Outlines only help while a cube is big enough on screen to have a visible
    // one; past that the line work paints over the surface it describes.
    const op = n <= 30000 ? 0.20 : n <= 90000 ? 0.07 : 0;
    /** @type {any} */ (this.edges.material).opacity = op;
    this.edges.visible = op > 0;

    this.mesh.computeBoundingSphere();
  }

  /* ----------------------------------------------------------------- api */

  updateAll() { this._rebuildStacks(); }

  /**
   * A cube stack is not a per-cell mapping — changing one column can change how
   * far its neighbours are exposed, and it shifts every later instance index.
   * So an edit rebuilds the field. At a few thousand cubes that is well under a
   * millisecond, and it keeps the exposure logic in exactly one place.
   */
  updateRect() { this._rebuildStacks(); }

  /** @param {Float32Array|null} ao */
  setAO(ao) { this.ao = ao; this._rebuildStacks(); }

  /** @param {Uint8ClampedArray|null} rgba */
  setLayer(rgba) { this.layer = rgba; this._rebuildStacks(); }

  /** @param {boolean} on plain white, no occlusion or height shading */
  setFlat(on) { this.flat = !!on; this._rebuildStacks(); }

  /**
   * Read a layer as SIZE. Pass null to go back to solid ground.
   *
   * ⚠️ THE CALLER NORMALISES, AND IT MUST USE THE RAMP'S OWN STRETCHED DOMAIN.
   * Same rule and same reason as `refreshSymbols`: the worker percentile-
   * stretches every layer 2–98 % and publishes the result, so a field
   * normalised against the raw min and max would size a block differently from
   * the colour painted on it and one of the two would be wrong about the same
   * ground. Taking a NORMALISED grid here keeps that decision in the one place
   * that already owns it rather than duplicating the domain logic.
   *
   * ⚠️ AND `minFraction` IS NEVER 0. A block at the bottom of the domain is a
   * real measurement of a low value; drawn at zero size it would vanish, and an
   * absent block already means something else here — no answer at all.
   * @param {Float32Array|null} normalised 0..1 per cell, NaN = no answer
   * @param {{minFraction?: number}} [opts]
   */
  setScaleField(normalised, opts = {}) {
    this.scale = normalised;
    if (opts.minFraction !== undefined) {
      this.scaleMin = Math.min(0.9, Math.max(0.02, opts.minFraction));
    }
    this._rebuildStacks();
  }

  /** @param {number} v */
  setExaggeration(v) { this.exaggeration = v; this._rebuildStacks(); }

  boundingBox() {
    const { nrows, ncols, cell, originX, originY } = this.dem;
    const [, hi] = this.dem.zRange();
    return new THREE.Box3(
      new THREE.Vector3(originX, originY, this.baseZ * this.exaggeration),
      new THREE.Vector3(originX + ncols * cell, originY + nrows * cell, hi * this.exaggeration),
    );
  }

  dispose() { this._disposeGpu(); }
}
