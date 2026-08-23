// @ts-check
// Thin heightfield container. Mirrors the DTM dataclass in
// DL-TerrainSlicer (slicer/dtm.py), and carries the
// same house conventions used throughout this project (planning/02 §6):
//   - north-up: z[0] is the northernmost row
//   - NaN = nodata, no separate mask array
//   - non-square cells are rejected at the reader (geotiff.js), not here

export class DEM {
  /**
   * @param {Float32Array} z
   * @param {number} nrows
   * @param {number} ncols
   * @param {number} cell
   * @param {number} originX
   * @param {number} originY
   * @param {string} [name]
   */
  constructor(z, nrows, ncols, cell, originX, originY, name = "") {
    if (z.length !== nrows * ncols) {
      throw new Error(`DEM: z.length ${z.length} !== nrows*ncols ${nrows * ncols}`);
    }
    this.z = z;
    this.nrows = nrows;
    this.ncols = ncols;
    this.cell = cell;
    this.originX = originX;
    this.originY = originY;
    this.name = name;
    /**
     * The CRS THE FILE DECLARED, or null if it declared none.
     * ⚠️ NEVER DEFAULTED. Everything that prints or writes a coordinate system
     * must read this and say "unknown" when it is null, rather than fall back
     * to the site this tool was developed on. See geoKeys() in geotiff.js.
     * @type {string|null}
     */
    this.crs = null;
    /** @type {number|null} EPSG of the horizontal CRS, when the file gave one. */
    this.epsg = null;
  }

  /** @param {import("./geotiff.js").DEM} raw */
  static fromRaw(raw) {
    const d = new DEM(raw.z, raw.nrows, raw.ncols, raw.cell, raw.originX, raw.originY, raw.name);
    d.crs = raw.crs ?? null;
    d.epsg = raw.epsg ?? null;
    return d;
  }

  /**
   * Approximate latitude at the centre of the raster, in degrees, or null.
   *
   * ⚠️ FOR THE SUN, AND DECLARED AS APPROXIMATE. Solar radiation needs a
   * latitude; before this it used a CONSTANT 69.70084 — Ørndalen's — for every
   * raster ever loaded, so a site in Bavaria was lit by an arctic sun. Deriving
   * it from the georeference is wrong by a fraction of a degree; assuming it was
   * wrong by tens.
   *
   * ⚠️ ONLY FOR NORTHERN-HEMISPHERE UTM-STYLE GRIDS, which is what the EPSG
   * ranges below are: ETRS89 / UTM (25828-25838), WGS84 / UTM north
   * (32601-32660) and ED50 / UTM (23028-23038). Anything else returns null and
   * the caller must ask rather than assume.
   *
   * A UTM northing is the meridian arc from the equator MULTIPLIED by the
   * 0.9996 central-scale factor, so the arc is northing/0.9996 — and the arc is
   * converted with 111,132 m per degree, the MEAN meridian degree on WGS84.
   * ⚠️ NOT 111,320: that is a degree of longitude at the equator, and using it
   * here was wrong by about a quarter of a degree. ⚠️ AND THE ORIGIN IS THE
   * SOUTH-WEST CORNER, so the centre northing is origin PLUS half the height;
   * subtracting put the sample south of the raster.
   *
   * Checked against a control: Ørndalen's true centre is 69.70084 °N
   * (data/orndalen/SOURCE.txt) and this returns ~69.65 — within 0.06°. The
   * meridian degree varies from 110.57 km at the equator to 111.69 at the pole,
   * so a single mean constant costs up to ~0.15° anywhere on Earth. That is
   * ample for a sun angle and is why this is named APPROX and is never reported
   * as a measurement.
   * @returns {number|null}
   */
  approxLatitudeDeg() {
    const e = this.epsg;
    if (!e) return null;
    const utmNorth = (e >= 25828 && e <= 25838)
      || (e >= 32601 && e <= 32660)
      || (e >= 23028 && e <= 23038);
    if (!utmNorth) return null;
    const northing = this.originY + (this.nrows * this.cell) / 2;
    if (!Number.isFinite(northing) || northing <= 0) return null;
    const lat = (northing / 0.9996) / 111132;
    return lat > 0 && lat < 84 ? lat : null;
  }

  /** Row-major index. */
  idx(row, col) { return row * this.ncols + col; }

  /**
   * Where one DEM sits inside another, measured in the COARSER one's cells.
   *
   * ⚠️ LIVES HERE RATHER THAN IN dive.js SO IT CAN BE TESTED HEADLESS. This is
   * pure header arithmetic with no geometry in it, and the kernel suite runs in
   * Node where the bare specifier "three" does not resolve — anything reached
   * through surface.js is testable only in the browser.
   *
   * Reports the alignment error instead of rounding it away: a patch half a
   * cell off the national grid is a real condition that has to be refused, not
   * smoothed over, because a nest rectangle drawn off-grid looks perfectly
   * plausible and is wrong.
   * @param {DEM} outer
   * @param {DEM} inner
   */
  static nest(outer, inner) {
    const dx = (inner.originX - outer.originX) / outer.cell;
    const dy = (inner.originY - outer.originY) / outer.cell;
    const w = (inner.ncols * inner.cell) / outer.cell;
    const h = (inner.nrows * inner.cell) / outer.cell;
    const err = Math.max(
      Math.abs(dx - Math.round(dx)), Math.abs(dy - Math.round(dy)),
      Math.abs(w - Math.round(w)), Math.abs(h - Math.round(h)));
    return {
      col: Math.round(dx), row: Math.round(dy),
      cols: Math.round(w), rows: Math.round(h),
      ratio: outer.cell / inner.cell,
      alignmentError: err,
      aligned: err < 1e-6,
      contained: dx >= -1e-6 && dy >= -1e-6
        && dx + w <= outer.ncols + 1e-6 && dy + h <= outer.nrows + 1e-6,
    };
  }

  /**
   * The outer tile's cells that the inner tile covers, as a rect in the OUTER
   * tile's own row-from-north indexing — what a surface needs in order to stop
   * drawing ground that a finer tile is already drawing.
   *
   * ⚠️ THE ROW FLIP IS THE WHOLE DIFFICULTY, and it is silent when wrong.
   * `nest()` reports `row` as cells NORTHWARD from originY, because originY is
   * the SOUTH-west corner (dtm.py's convention). Every surface, mask and dirty
   * rect in this project counts rows SOUTHWARD from the north edge. Using
   * nest().row directly puts the hole the same distance from the wrong edge —
   * on a square tile that is a perfectly plausible rectangle in a perfectly
   * plausible place, mirrored about the middle, and nothing throws. Here it
   * would cut the context open somewhere the patch is not and leave the patch
   * double-drawn, which reads as two unrelated defects.
   *
   * ⚠️ RETURNS EVERY CELL THE INNER TILE TOUCHES, including partly. The inner
   * tile's edge runs along outer CELL EDGES while the outer surface's vertices
   * sit at cell CENTRES, so there is an unavoidable half-cell of disagreement:
   * cutting only fully-covered cells leaves a half-cell rim of coarse ground
   * inside the patch, which is the artefact being removed. Cutting generously
   * leaves at most half a coarse cell of gap instead, and the nest outline is
   * drawn along exactly that edge.
   *
   * @param {DEM} outer @param {DEM} inner
   * @returns {{r0:number,c0:number,r1:number,c1:number}|null} inclusive, or
   *   null when the two grids do not align or the inner is not contained —
   *   a caller must not cut a hole it cannot place exactly.
   */
  static nestHole(outer, inner) {
    const n = DEM.nest(outer, inner);
    if (!n.aligned || !n.contained) return null;
    // nest().row counts north from the south edge; flip to row-from-north.
    const rFromNorth = outer.nrows - (n.row + n.rows);
    return {
      r0: Math.max(0, rFromNorth),
      c0: Math.max(0, n.col),
      r1: Math.min(outer.nrows - 1, rFromNorth + n.rows - 1),
      c1: Math.min(outer.ncols - 1, n.col + n.cols - 1),
    };
  }

  at(row, col) { return this.z[this.idx(row, col)]; }

  /** World coordinates of a cell centre. Row 0 = north edge, per house convention. */
  xy(row, col) {
    const x = this.originX + (col + 0.5) * this.cell;
    const northY = this.originY + this.nrows * this.cell;
    const y = northY - (row + 0.5) * this.cell;
    return [x, y];
  }

  /** [min, max] over finite cells. */
  zRange() {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < this.z.length; i++) {
      const v = this.z[i];
      if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    return [lo, hi];
  }

  /** Independent copy (elevation array is cloned; caller may mutate freely). */
  clone() {
    return new DEM(this.z.slice(), this.nrows, this.ncols, this.cell, this.originX, this.originY, this.name);
  }

  /** Fraction of cells that are NaN. */
  nodataFraction() {
    let n = 0;
    for (let i = 0; i < this.z.length; i++) if (!Number.isFinite(this.z[i])) n++;
    return n / this.z.length;
  }

  /**
   * Build a synthetic DEM from a generator function of (row, col, x, y) -> z.
   * Used throughout the self-test suite for analytic surfaces with
   * hand-computable answers (planes, single-cell pits/peaks, etc).
   * @param {number} nrows @param {number} ncols @param {number} cell
   * @param {(row:number, col:number, x:number, y:number) => number} fn
   */
  static synthetic(nrows, ncols, cell, fn, originX = 0, originY = 0) {
    const z = new Float32Array(nrows * ncols);
    const dem = new DEM(z, nrows, ncols, cell, originX, originY, "synthetic");
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        const [x, y] = dem.xy(r, c);
        z[dem.idx(r, c)] = fn(r, c, x, y);
      }
    }
    return dem;
  }
}
