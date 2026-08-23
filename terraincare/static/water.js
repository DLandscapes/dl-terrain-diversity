// @ts-check
// STANDING WATER, AS VOLUME.
//
// The ponding layer (analysis/ponding.js) produces a depth per cell. It could
// be painted as another colour ramp, and it is — but a ramp is a picture of a
// number, and the thing this layer has to make felt is that water is STUFF
// occupying the hollows the ground offers it. So it is drawn as blocks, in the
// same language the voxel terrain already speaks: one column per ponded cell,
// standing from the ground up to the water surface.
//
// ⚠️ WHY BOXES RATHER THAN A WATER SURFACE MESH. A single translucent sheet at
// the water level is what a visualisation would do, and it reads beautifully on
// a lake. It reads as nothing here, because the ponds on this patch are a few
// cells across and a few centimetres deep — a sheet would be an invisible film.
// A column has a visible SIDE, and the side is the depth. It also makes the
// comparison the argument needs legible in one glance: the surveyed patch grows
// a scatter of small blocks, and the levelled one grows nothing at all, because
// there is nowhere for a block to stand.
//
// ⚠️ THE COLUMN'S BOTTOM IS THE GROUND, NOT THE BASE PLATE. Drawing every column
// from a common floor is the mistake the terrain voxels were corrected for in
// July — stacks reading as columns going down to a plinth rather than as
// material. Water sits ON the ground it found, so each box spans exactly from
// its own cell's elevation to the pond's surface, and a shallow pond over
// uneven ground is visibly shallower where the ground is higher.

import * as THREE from "three";

const _m = new THREE.Matrix4();

export class WaterField {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.exaggeration = opts.verticalExaggeration ?? 1;
    /** @type {Float32Array|null} per-cell ponded depth, m */
    this.depth = null;
    /** @type {Float32Array|null} per-cell water surface elevation */
    this.surface = null;
    /** @type {any[]} where the water leaves, and how much through each */
    this.outfalls = [];
    this.count = 0;
    this.spoutCount = 0;
    /** Block size in DEM cells — 1 while the terrain is the smooth surface. */
    this.blockCells = 1;
    /** voxels.js's base plate and cube height, in ground units, or null. */
    this.blockBaseZ = null;
    this.blockQuantum = null;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    // The box is built centred on the origin; shifting it so its BASE is at
    // z = 0 means an instance matrix is a plain scale-then-translate with the
    // translation at the ground, which is what keeps the maths here readable
    // and matches how voxels.js writes its own matrices.
    geo.translate(0, 0, 0.5);
    this.material = new THREE.MeshLambertMaterial({
      // Water is the one thing in this interface allowed a hue that is not an
      // analysis ramp, because it is not a reading of the ground — it is a
      // substance standing on it. It stays close to the wet end of the TWI ramp
      // so the two agree by eye: where the wetness map is blue, water collects.
      color: 0x2f6f9f,
      transparent: true,
      // Translucent enough to see the terrain through a deep pond, opaque
      // enough that a 2 cm film still registers against pale ground.
      opacity: 0.62,
      // ⚠️ NO DEPTH WRITE. Overlapping translucent boxes that write depth
      // occlude each other in draw order, so a pond renders as a patchwork of
      // its own cells with visible seams wherever two columns meet.
      depthWrite: false,
      fog: false,   // as the terrain: only the ground grid fades
    });
    /** @type {THREE.InstancedMesh|null} */
    this.mesh = null;
    this.geo = geo;
    this._capacity = 0;
    this._ensure(1024);
    this.group = new THREE.Group();
    // The UTM origin rides on the transform, never in a float32 instance
    // buffer — the rule render group R1 exists to defend.
    this.group.position.set(dem.originX, dem.originY, 0);
    if (this.mesh) this.group.add(this.mesh);
  }

  /**
   * Grow the instance buffer. An InstancedMesh's count is fixed at
   * construction, so a bigger pond means a new mesh — the same constraint that
   * made voxels.js refuse to have a setBlockCells().
   * @param {number} needed
   */
  _ensure(needed) {
    if (this.mesh && needed <= this._capacity) return;
    const capacity = Math.max(1024, 1 << Math.ceil(Math.log2(Math.max(1, needed))));
    if (this.mesh) {
      this.group?.remove(this.mesh);
      this.mesh.dispose();
    }
    this.mesh = new THREE.InstancedMesh(this.geo, this.material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this._capacity = capacity;
    if (this.group) this.group.add(this.mesh);
  }

  /**
   * Take a ponding result and rebuild the blocks.
   * @param {{depth: Float32Array, surface: Float32Array, outfalls?: any[]}|null} ponding
   */
  setPonding(ponding) {
    this.depth = ponding ? ponding.depth : null;
    this.surface = ponding ? ponding.surface : null;
    this.outfalls = ponding && ponding.outfalls ? ponding.outfalls : [];
    this.rebuild();
    this.rebuildSpouts();
  }

  /**
   * OUTFALLS — where the water leaves, and how much goes through each place.
   *
   * ⚠️ WATER THAT SIMPLY VANISHES AT THE EDGE IS THE ONE PLACE THIS LAYER LIED.
   * Everywhere else it shows a measured quantity where the quantity is; at the
   * boundary it showed nothing at all, and the ground read as though the water
   * had never arrived. The tempting fix — an invisible wall round the tile so
   * nothing escapes — is worse than the problem: the patch would then hold water
   * it demonstrably does not hold, and the retention figure this tool is going to
   * print in a paper would become a property of the fiction rather than of the
   * ground.
   *
   * So the water is drawn LEAVING: a spout hanging below the edge at each place
   * it goes, its length set by the volume passing through it. An outfall is a
   * real object — designed, consented, built — and this is where it would be.
   *
   * ⚠️ LENGTH IS LOGARITHMIC. Outfall volumes on this patch span three orders of
   * magnitude between a trickle over a sill and the low corner the whole site
   * drains to. Linear, every spout but one would be invisible; logarithmic, they
   * are all legible and the biggest is still plainly the biggest. It is a
   * legible mark, not a bar to be measured off — the number beside it is the
   * measurement.
   */
  rebuildSpouts() {
    const { z, nrows, ncols, cell } = this.dem;
    const ex = this.exaggeration;
    const list = this.outfalls || [];
    if (!this._spouts) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      geo.translate(0, 0, -0.5);   // hangs DOWN from its anchor
      this._spoutGeo = geo;
      this._spoutMat = new THREE.MeshLambertMaterial({
        color: 0x2f6f9f, transparent: true, opacity: 0.85,
        depthWrite: false, fog: false,
      });
      this._spouts = new THREE.InstancedMesh(geo, this._spoutMat, 256);
      this._spouts.frustumCulled = false;
      this._spouts.count = 0;
      this.group.add(this._spouts);
    }
    const mesh = this._spouts;
    let maxV = 0;
    for (const o of list) if (o.volume > maxV) maxV = o.volume;
    let n = 0;
    const northY = nrows * cell;
    for (const o of list) {
      if (n >= 256 || !(o.volume > 0) || !Number.isFinite(z[o.index])) continue;
      const f = Math.log10(1 + o.volume) / Math.log10(1 + Math.max(maxV, 1e-6));
      const len = (0.6 + 5.4 * f) * Math.max(cell * 2, 0.5);
      _m.makeScale(cell * 1.6, cell * 1.6, len * ex);
      _m.setPosition((o.col + 0.5) * cell, northY - (o.row + 0.5) * cell, z[o.index] * ex);
      mesh.setMatrixAt(n++, _m);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.spoutCount = n;
  }

  /**
   * Match the terrain's block size, so water stands on the ground as DRAWN.
   *
   * ⚠️ WATER WAS THE ONE LAYER THAT IGNORED THE BLOCK SLIDER. It drew one box
   * per DEM cell whatever the terrain was doing, so at eight cells to a block
   * the ground stood in 2 m steps and the ponds were still 0.25 m — a fine
   * mosaic laid over a coarse one, sunk into it on the rising side of every
   * step and hanging off it on the falling side. Nothing threw; it just looked
   * like the water had come from a different drawing, which it had.
   *
   * ⚠️ AND MATCHING THE FOOTPRINT ALONE IS NOT ENOUGH. voxels.js does not draw
   * a block at its mean elevation — it QUANTISES the top to a whole number of
   * cube heights above `baseZ`. Water placed at the true ground height under a
   * block whose top was rounded up sits inside the terrain and vanishes. So the
   * base comes from the same arithmetic the terrain uses, not from `z`.
   *
   * @param {{cells?: number, baseZ?: number, quantum?: number}|null} opts
   *   `cells` is the block size in DEM cells; `baseZ` and `quantum` are
   *   voxels.js's own base plate and cube height, in GROUND units. Pass null
   *   (or nothing) to go back to one box per cell on the smooth surface.
   */
  setBlocks(opts) {
    this.blockCells = Math.max(1, Math.round(opts?.cells ?? 1));
    this.blockBaseZ = opts && Number.isFinite(opts.baseZ) ? opts.baseZ : null;
    this.blockQuantum = opts && opts.quantum > 0 ? opts.quantum : null;
    this.rebuild();
    this.rebuildSpouts();
  }

  /**
   * Depth and water-surface elevation aggregated over one block, plus the
   * terrain height the block's water has to stand on.
   *
   * ⚠️ THE DEPTH IS A MEAN AND THE SURFACE IS A MAX, and the pair is deliberate.
   * A block holding one deep pothole and seven dry cells holds the mean volume —
   * showing the pothole's depth across the whole block would invent water. But
   * the water SURFACE of a pond is level by definition, so averaging it across a
   * block that is partly dry would tilt a flat pond; the highest standing
   * surface in the block is the one that is really there.
   */
  _aggregateWater(br, bc) {
    const { z, nrows, ncols } = this.dem;
    const k = this.blockCells;
    const r0 = br * k, c0 = bc * k;
    const r1 = Math.min(nrows - 1, r0 + k - 1);
    const c1 = Math.min(ncols - 1, c0 + k - 1);
    let ds = 0, dn = 0, zs = 0, zn = 0, top = -Infinity;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * ncols + c;
        const zg = z[i];
        if (!Number.isFinite(zg)) continue;
        zs += zg; zn++;
        const d = this.depth ? this.depth[i] : 0;
        ds += d > 0 ? d : 0; dn++;
        if (d > 0) {
          const sfc = this.surface && Number.isFinite(this.surface[i])
            ? this.surface[i] : zg + d;
          if (sfc > top) top = sfc;
        }
      }
    }
    if (!zn || !dn) return null;
    return { depth: ds / dn, ground: zs / zn, top };
  }

  rebuild() {
    const { z, nrows, ncols, cell } = this.dem;
    const ex = this.exaggeration;
    const depth = this.depth;
    if (!depth) { if (this.mesh) this.mesh.count = 0; this.count = 0; return; }
    // ⚠️ THE TEST IS QUANTISATION, NOT BLOCK SIZE, and getting that wrong left
    // one setting broken while every other looked right. At ONE cell per block
    // the footprints already agree — both are 0.25 m — so a `blockCells > 1`
    // shortcut sent the water down the per-cell path, which places it on the raw
    // DEM. But a one-cell voxel field still QUANTISES its tops, so half the
    // ponds sank into the blocks and half hung above them: 2 432 sunk and 2 493
    // floating, at the one block size where the sizes matched perfectly.
    if (this.blockCells > 1 || this.blockQuantum !== null) return this._rebuildBlocks();

    // ⚠️ A MINIMUM VISIBLE DEPTH, and it is a display decision that has to be
    // stated rather than hidden. The ponding layer resolves water a micron
    // deep, and drawing a box that thin produces a degenerate instance the
    // renderer turns into z-fighting confetti. Anything below a millimetre is
    // not drawn. It is still COUNTED — the retained volume and the ponded area
    // in the readout come from the analysis, never from what got drawn — so
    // the number and the picture disagree only in the direction of caution.
    const MIN_DRAW = 0.001;
    let needed = 0;
    for (let i = 0; i < depth.length; i++) if (depth[i] > MIN_DRAW) needed++;
    this._ensure(needed);
    const mesh = this.mesh;
    if (!mesh) return;

    const northY = nrows * cell;   // LOCAL north edge, as surface.js builds it
    let n = 0;
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        const i = r * ncols + c;
        const d = depth[i];
        if (!(d > MIN_DRAW)) continue;
        const zg = z[i];
        if (!Number.isFinite(zg)) continue;
        _m.makeScale(cell, cell, d * ex);
        _m.setPosition(
          (c + 0.5) * cell,
          northY - (r + 0.5) * cell,
          zg * ex,
        );
        mesh.setMatrixAt(n++, _m);
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.count = n;
  }

  /**
   * One box per terrain block, standing on the block's own drawn top.
   *
   * ⚠️ WATER THINNER THAN THE BLOCK RESOLVES IS NOT DRAWN, and that is the same
   * argument the whole tool makes rather than a shortcut. At eight cells to a
   * block the ground is described in 2 m steps, and a two-centimetre film
   * spread over a 2 m block is below what the representation can say — drawing
   * it would claim a precision the blocks do not have. The RETAINED VOLUME in
   * the readout still comes from the analysis at full resolution, so the number
   * and the picture disagree only in the direction of caution, exactly as the
   * per-cell path's minimum depth already does.
   */
  _rebuildBlocks() {
    const { nrows, ncols, cell } = this.dem;
    const ex = this.exaggeration;
    const k = this.blockCells;
    const bRows = Math.ceil(nrows / k), bCols = Math.ceil(ncols / k);
    const w = k * cell;
    const MIN_DRAW = 0.001;

    /** The terrain's drawn top for a block — quantised exactly as voxels.js does. */
    const drawnTop = (groundZ) => {
      if (this.blockQuantum === null || this.blockBaseZ === null) return groundZ;
      const L = Math.max(1, Math.round((groundZ - this.blockBaseZ) / this.blockQuantum));
      return this.blockBaseZ + L * this.blockQuantum;
    };

    const cells = [];
    for (let br = 0; br < bRows; br++) {
      for (let bc = 0; bc < bCols; bc++) {
        const a = this._aggregateWater(br, bc);
        if (!a || !(a.depth > MIN_DRAW) || !Number.isFinite(a.top)) continue;
        const base = drawnTop(a.ground);
        // The pond's own surface, but never below the ground it stands on: a
        // block whose top was rounded UP can swallow a shallow pond entirely,
        // and a negative-height box is a degenerate instance.
        const h = Math.max(a.top, base + a.depth) - base;
        if (!(h > MIN_DRAW)) continue;
        cells.push([br, bc, base, h]);
      }
    }

    this._ensure(cells.length);
    const mesh = this.mesh;
    if (!mesh) return;
    const northY = nrows * cell;
    let n = 0;
    for (const [br, bc, base, h] of cells) {
      _m.makeScale(w, w, h * ex);
      _m.setPosition(
        (bc * k + k / 2) * cell,
        northY - (br * k + k / 2) * cell,
        base * ex,
      );
      mesh.setMatrixAt(n++, _m);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.count = n;
  }

  /** @param {number} v */
  setExaggeration(v) {
    this.exaggeration = v;
    this.rebuild();
    this.rebuildSpouts();
  }

  /** @param {boolean} on */
  setVisible(on) {
    this.group.visible = !!on;
  }

  dispose() {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.dispose(); }
    if (this._spouts) { this.group.remove(this._spouts); this._spouts.dispose(); }
    this._spoutGeo?.dispose();
    this._spoutMat?.dispose();
    this.geo.dispose();
    this.material.dispose();
  }
}
