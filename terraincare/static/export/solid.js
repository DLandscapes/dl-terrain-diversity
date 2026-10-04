// @ts-check
/**
 * THE VOXEL TERRAIN AS A CLOSED, PRINTABLE SOLID — one watertight shell rather
 * than a heap of overlapping boxes.
 *
 * ⚠️ WHAT WAS WRONG WITH THE OLD EXPORT. `writeVoxelOBJ` writes every block as
 * its own closed box: eight vertices, twelve triangles, all six faces. Its own
 * header says so — "neighbours overlap where they meet. Union to merge." On
 * screen that is invisible and harmless. Sent to a slicer it is neither: every
 * face between two touching blocks is a WALL BURIED INSIDE the solid, no two
 * boxes share a vertex, and the model is a self-intersecting soup rather than a
 * body with an inside and an outside. Some slicers repair it, many produce
 * internal perimeters, and the file is roughly four times larger than the shape
 * needs.
 *
 * ⚠️ AND IT NEEDS NO BOOLEAN. A general CSG union of ten thousand boxes is slow,
 * fragile and famously hard to make robust in floating point — and it is not
 * required here, because these boxes are not arbitrary. They are axis-aligned
 * columns standing on a regular grid at integer heights, and for that the union
 * has a closed form: emit a face only where a column meets AIR, and weld the
 * vertices. That is one pass over the blocks, exact, with no tolerance anywhere.
 *
 * ⚠️ THE ONE DETAIL THAT MAKES IT MANIFOLD RATHER THAN NEARLY MANIFOLD: every
 * wall is split into ONE QUAD PER LEVEL. It is tempting to emit each step as a
 * single tall rectangle spanning the whole height difference, and it looks
 * identical. It is not identical, and the failure is a T-junction at the corners
 * where four columns meet. Take heights A=2, B=1, C=0 around one corner: the
 * A|C wall contributes a vertical edge spanning levels 0–2, while A|B
 * contributes 1–2 and B|C contributes 0–1. One edge cannot pair with two, so
 * that corner is a crack — invisible on screen, and exactly what a slicer
 * reports as "not watertight". Split per level, every vertical segment is a
 * unit and pairs with exactly one partner.
 *
 * ⚠️ THE SOLID HAS A FLAT BOTTOM AT THE BASE PLATE, which is what makes it
 * printable at all: a surface has no thickness and cannot be sliced. The base is
 * voxels.js's own `baseZ`, so the object is the staircase you can see with a
 * floor under it, not a new interpretation of the ground.
 */

/**
 * @typedef {Object} SolidOpts
 * @property {number} blockCells      block footprint, in DEM cells
 * @property {number} baseZ           voxels.js's base plate, GROUND units
 * @property {number} quantum         voxels.js's cube height, GROUND units
 * @property {number} [exaggeration]  applied to Z on the way out
 * @property {Int32Array|null} [groups]
 *   one class id per block, row-major over the block grid, or null for a single
 *   solid. Blocks with id < 0 are left out of every group.
 * @property {string[]} [groupLabels] human names, indexed by class id
 */

/**
 * Level of each block column, quantised exactly as voxels.js quantises it, or
 * -1 where the block has no finite ground.
 *
 * ⚠️ MUST AGREE WITH voxels.js OR THE EXPORT IS A DIFFERENT SHAPE FROM THE ONE
 * ON SCREEN. Same aggregate (mean over the block's finite cells), same
 * quantisation, same floor of one level.
 * @param {import("../dem.js").DEM} dem
 * @param {number} k blockCells @param {number} baseZ @param {number} q
 */
export function blockLevels(dem, k, baseZ, q) {
  const { z, nrows, ncols } = dem;
  const bRows = Math.ceil(nrows / k), bCols = Math.ceil(ncols / k);
  const out = new Int32Array(bRows * bCols);
  for (let br = 0; br < bRows; br++) {
    for (let bc = 0; bc < bCols; bc++) {
      const r1 = Math.min(nrows - 1, br * k + k - 1);
      const c1 = Math.min(ncols - 1, bc * k + k - 1);
      let s = 0, n = 0;
      for (let r = br * k; r <= r1; r++) {
        for (let c = bc * k; c <= c1; c++) {
          const v = z[r * ncols + c];
          if (Number.isFinite(v)) { s += v; n++; }
        }
      }
      out[br * bCols + bc] = n
        ? Math.max(1, Math.round((s / n - baseZ) / q))
        : -1;
    }
  }
  return { levels: out, bRows, bCols };
}

/**
 * The majority class over each block, for grouping.
 *
 * ⚠️ MAJORITY, NOT THE CENTRE CELL. A block is an aggregate of up to sixty-four
 * cells and sampling one of them would let a single outlying cell decide which
 * solid a whole 2 m block joins. Ties go to the lower code, which is arbitrary
 * but stable — and stability is what matters, because an unstable tie would
 * move a block between two exported objects on re-export with no edit between.
 * @param {Uint8Array} codes per-CELL class
 * @param {import("../dem.js").DEM} dem @param {number} k @param {number} classes
 */
export function blockClasses(codes, dem, k, classes) {
  const { nrows, ncols } = dem;
  const bRows = Math.ceil(nrows / k), bCols = Math.ceil(ncols / k);
  const out = new Int32Array(bRows * bCols).fill(-1);
  const tally = new Int32Array(classes);
  for (let br = 0; br < bRows; br++) {
    for (let bc = 0; bc < bCols; bc++) {
      tally.fill(0);
      const r1 = Math.min(nrows - 1, br * k + k - 1);
      const c1 = Math.min(ncols - 1, bc * k + k - 1);
      for (let r = br * k; r <= r1; r++) {
        for (let c = bc * k; c <= c1; c++) {
          const v = codes[r * ncols + c];
          if (v < classes) tally[v]++;
        }
      }
      let best = -1, bn = 0;
      for (let i = 0; i < classes; i++) if (tally[i] > bn) { bn = tally[i]; best = i; }
      out[br * bCols + bc] = best;
    }
  }
  return out;
}

/** Welds vertices on an exact key — the lattice is integral, so no tolerance. */
class VertexPool {
  constructor() { this.map = new Map(); this.list = []; }
  /** @param {number} x @param {number} y @param {number} z */
  id(x, y, z) {
    const key = `${x}|${y}|${z}`;
    let i = this.map.get(key);
    if (i === undefined) {
      i = this.list.length;
      this.list.push([x, y, z]);
      this.map.set(key, i);
    }
    return i;
  }
}

/**
 * Build the closed shell for one set of columns.
 *
 * Faces are emitted only where a column meets air, so every interior wall is
 * absent by construction rather than removed afterwards.
 *
 * @param {(bi:number)=>boolean} inSet
 * @param {Int32Array} levels @param {number} bRows @param {number} bCols
 * @param {VertexPool} pool
 * @param {{w:number, northY:number, baseZ:number, q:number, ex:number}} g
 * @returns {number[][]} triangles as vertex-index triples
 */
function shell(inSet, levels, bRows, bCols, pool, g) {
  const tris = [];
  const { w, northY, baseZ, q, ex } = g;
  const Z = (lev) => (baseZ + lev * q) * ex;

  // Two triangles per quad, wound so the normal points OUT of the solid.
  const quad = (a, b, c, d) => { tris.push([a, b, c], [a, c, d]); };

  for (let br = 0; br < bRows; br++) {
    for (let bc = 0; bc < bCols; bc++) {
      const bi = br * bCols + bc;
      const L = levels[bi];
      if (L < 0 || !inSet(bi)) continue;

      const x0 = bc * w, x1 = x0 + w;
      const y1 = northY - br * w, y0 = y1 - w;      // y1 is the NORTH edge
      const zT = Z(L), zB = Z(0);

      // Top, seen from +Z: counter-clockwise.
      quad(pool.id(x0, y0, zT), pool.id(x1, y0, zT),
        pool.id(x1, y1, zT), pool.id(x0, y1, zT));
      // Bottom, wound the other way so it faces −Z.
      quad(pool.id(x0, y1, zB), pool.id(x1, y1, zB),
        pool.id(x1, y0, zB), pool.id(x0, y0, zB));

      // Walls. A neighbour outside the set is air, so the wall runs to the base.
      const sides = [
        { dr: -1, dc: 0, ax: [x0, y1], bx: [x1, y1] },   // north
        { dr: 1, dc: 0, ax: [x1, y0], bx: [x0, y0] },    // south
        { dr: 0, dc: 1, ax: [x1, y1], bx: [x1, y0] },    // east
        { dr: 0, dc: -1, ax: [x0, y0], bx: [x0, y1] },   // west
      ];
      for (const s of sides) {
        const nr = br + s.dr, nc = bc + s.dc;
        const inside = nr >= 0 && nr < bRows && nc >= 0 && nc < bCols
          && inSet(nr * bCols + nc) && levels[nr * bCols + nc] >= 0;
        const Ln = inside ? levels[nr * bCols + nc] : 0;
        if (Ln >= L) continue;                       // nothing exposed
        // ⚠️ ONE QUAD PER LEVEL — see the header. A single tall rectangle here
        // leaves T-junctions at every corner where four columns disagree.
        for (let lev = Ln; lev < L; lev++) {
          const za = Z(lev), zb = Z(lev + 1);
          // ⚠️ b BEFORE a. Taken the other way round the cross product points
          // INTO the solid — on the north face (ax→bx)=+X and (za→zb)=+Z give
          // +X × +Z = −Y, which is inward — and all four sides invert together,
          // so the shape renders and measures as a NEGATIVE volume with every
          // wall-to-top edge unpaired. Nothing looks wrong until a slicer
          // refuses it.
          quad(
            pool.id(s.bx[0], s.bx[1], za), pool.id(s.ax[0], s.ax[1], za),
            pool.id(s.ax[0], s.ax[1], zb), pool.id(s.bx[0], s.bx[1], zb));
        }
      }
    }
  }
  return tris;
}

/**
 * THE SMOOTH SURFACE AS A CLOSED, PRINTABLE BODY — the terrain with sides and a
 * floor, rather than the open sheet `writeOBJ` writes.
 *
 * `writeOBJ` exports the surface as it is drawn: a single layer of triangles
 * with no thickness. That is the right thing for Rhino or Blender and the wrong
 * thing for a slicer, which has no way to tell which side of an infinitely thin
 * sheet is inside. This builds the same surface and closes it.
 *
 * ⚠️ THE TOP IS THE MESH THAT WAS ON SCREEN, VERTEX FOR VERTEX. Same cell-centre
 * grid, same anti-diagonal split as `writeOBJ` and `surface.js`. Re-triangulating
 * "equivalently" would hand the printer a model that is not the one the designer
 * judged — and on a terrain of 0.25 m cells the difference is visible.
 *
 * ⚠️ WATERTIGHT BY CONSTRUCTION, NOT BY REPAIR. The floor is the top's OWN
 * triangulation mirrored downward, so it has exactly the same outline — then
 * every edge used by only one top triangle gets a vertical wall. Holes in the
 * data therefore close themselves: a nodata patch is a hole in the top, its rim
 * is a boundary, and the rim grows walls like any other. Filling nodata with an
 * invented height would have been the alternative, and it invents ground.
 *
 * ⚠️ EVERY VERTEX IS SHARED. Positions are pooled, so the wall that meets the
 * top uses the top's own vertex rather than a second one at the same
 * coordinates. Two vertices a float apart read as a crack to a slicer and are
 * the usual reason a visually perfect mesh prints with a seam.
 *
 * ⚠️ THE FLOOR IS FLAT AND THE MODEL CAN STAND ON IT. `baseThickness` is
 * material added BELOW the lowest ground, so a terrain whose lowest point is a
 * knife edge still has a slab to sit on — and a slab is also what lets the model
 * be laid on its back and printed standing, which is what it is for.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {{exaggeration?: number, baseThickness?: number, layerLabel?: string}} [opts]
 * @returns {{obj: string, triangles: number, vertices: number, shells: number,
 *            report: ReturnType<typeof manifoldReport>, minZ: number, baseZ: number,
 *            size: [number, number, number], dropped: number}}
 */
export function writeSurfaceSolidOBJ(dem, opts = {}) {
  const { z, nrows, ncols, cell } = dem;
  const ex = opts.exaggeration ?? 1;
  const thickness = Math.max(0, opts.baseThickness ?? 0);
  const northY = nrows * cell;

  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < z.length; i++) {
    const v = z[i];
    if (!Number.isFinite(v)) continue;
    if (v < minZ) minZ = v;
    if (v > maxZ) maxZ = v;
  }
  if (!Number.isFinite(minZ)) {
    throw new Error("the terrain has no finite heights — nothing to build a solid from");
  }
  // ⚠️⚠️ A FLOOR LEVEL WITH THE LOWEST GROUND IS NOT A SOLID. With no base the
  // floor sits exactly at the lowest cell, so every cell AT that height has its
  // top and bottom vertex in the same place: a zero-thickness sliver, which a
  // slicer either drops or prints as a stray film. On flat ground the whole body
  // degenerates — measured on an 8x8 plane: closed, manifold, correctly wound,
  // and 0.0 m³ of material. Refused here rather than discovered on the printer.
  if (!(thickness > 0)) {
    throw new Error(
      "a printable solid needs material under its lowest point — set a base "
      + "thickness above 0. With none, the floor touches the ground at the "
      + "lowest cell and the model has no thickness there."
    );
  }
  const baseZ = minZ * ex - thickness;

  // ── the vertex pool: one entry per (cell, layer), created on demand ─────
  /** @type {Map<number, number>} */ const pool = new Map();
  /** @type {number[][]} */ const verts = [];
  /** the DEM cell each vertex came from, so the floor twin is a lookup */
  /** @type {number[]} */ const vertCell = [];
  /** top = layer 0, floor = layer 1 */
  const id = (i, layer) => {
    const key = i * 2 + layer;
    let v = pool.get(key);
    if (v !== undefined) return v;
    const r = (i / ncols) | 0, c = i % ncols;
    verts.push([(c + 0.5) * cell, northY - (r + 0.5) * cell,
      layer === 0 ? z[i] * ex : baseZ]);
    vertCell.push(i);
    v = verts.length - 1;
    pool.set(key, v);
    return v;
  };
  /**
   * The floor vertex under a top vertex.
   * ⚠️ BY LOOKUP, NOT BY ROUNDING THE POSITION BACK TO A CELL. Recovering the
   * cell from x/y works until a cell size makes the division land on .4999,
   * and then one vertex of one wall quietly attaches to its neighbour.
   */
  const floorOf = (v) => id(vertCell[v], 1);

  /** @type {number[][]} */ const tris = [];
  const finite = (i) => Number.isFinite(z[i]);
  let dropped = 0;

  // ── the top, exactly as writeOBJ splits it ─────────────────────────────
  // Wound counter-clockwise seen from above, so the outward normal is +Z and
  // the floor and walls below can take their orientation from it.
  for (let r = 0; r < nrows - 1; r++) {
    for (let c = 0; c < ncols - 1; c++) {
      const a = r * ncols + c, b = a + 1, d = a + ncols, e = d + 1;
      if (finite(a) && finite(d) && finite(b)) tris.push([id(a, 0), id(d, 0), id(b, 0)]);
      else dropped++;
      if (finite(b) && finite(d) && finite(e)) tris.push([id(b, 0), id(d, 0), id(e, 0)]);
      else dropped++;
    }
  }
  if (!tris.length) {
    throw new Error("no complete cell in this terrain — the surface has no triangles to close");
  }
  const topCount = tris.length;

  // ── the floor: the same triangulation, mirrored down and reversed ──────
  for (let t = 0; t < topCount; t++) {
    const [a, b, c] = tris[t];
    tris.push([floorOf(a), floorOf(c), floorOf(b)]);
  }

  // ── the walls: every edge the top uses only once ───────────────────────
  // An edge with no opposite twin is a rim — the outside of the tile, or the
  // rim of a nodata hole. Both get the same wall, which is why holes need no
  // special case.
  /** @type {Set<string>} */ const topEdges = new Set();
  for (let t = 0; t < topCount; t++) {
    const [a, b, c] = tris[t];
    topEdges.add(`${a}>${b}`); topEdges.add(`${b}>${c}`); topEdges.add(`${c}>${a}`);
  }
  let walls = 0;
  for (const key of topEdges) {
    const [us, vs] = key.split(">");
    const u = +us, v = +vs;
    if (topEdges.has(`${v}>${u}`)) continue;         // interior: two triangles share it
    const ub = floorOf(u), vb = floorOf(v);
    // ⚠️⚠️ THE WALL TRAVERSES THE RIM EDGE BACKWARDS — v -> u, not u -> v.
    // Two faces sharing an edge must run along it in OPPOSITE directions, or
    // the edge is used twice the same way and pairs with nothing: the body is
    // open and every normal on that wall points inward. Written the obvious way
    // round first, this produced 56 unpaired edges on an 8x8 plane and a
    // NEGATIVE volume — a model that looks perfect on screen and prints inside
    // out. The quad is v -> u -> u_floor -> v_floor.
    tris.push([v, u, ub]);
    tris.push([v, ub, vb]);
    walls += 2;
  }

  // ── out ────────────────────────────────────────────────────────────────
  const out = [];
  out.push("# DL-TerrainDiversity — SOLID surface export (closed, for printing)");
  out.push(`# source ${dem.name || "(unnamed)"}`);
  out.push(`# grid ${ncols} x ${nrows} cells, ${cell} m`);
  out.push(`# COORDINATES ARE LOCAL: add the origin below to place this in ${dem.crs || "the source file's own coordinate system"}.`);
  out.push(`# origin_${dem.epsg ? `epsg${dem.epsg}` : "local"} ${dem.originX} ${dem.originY}`);
  out.push("# up_axis Z");
  out.push(ex === 1
    ? "# vertical_exaggeration 1 (true elevations)"
    : `# vertical_exaggeration ${ex} — Z IS NOT TRUE ELEVATION, divide by ${ex}`);
  out.push(`# base_thickness ${thickness} (material below the lowest ground)`);
  out.push(`# floor_z ${baseZ.toFixed(4)}`);
  if (opts.layerLabel) out.push(`# layer ${opts.layerLabel}`);
  out.push("# Terrain data (c) Kartverket, hoydedata.no, NLOD / CC BY 4.0");
  out.push("o terrain_solid");
  for (const [x, y, zz] of verts) {
    out.push(`v ${x.toFixed(4)} ${y.toFixed(4)} ${zz.toFixed(4)}`);
  }
  for (const [a, b, c] of tris) out.push(`f ${a + 1} ${b + 1} ${c + 1}`);

  const report = manifoldReport(tris);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of verts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return {
    obj: out.join("\n") + "\n",
    triangles: tris.length,
    vertices: verts.length,
    shells: 1,
    report,
    minZ,
    baseZ,
    size: [x1 - x0, y1 - y0, maxZ * ex - baseZ],
    dropped,
  };
}

/**
 * The voxel terrain as one or more watertight solids, in OBJ.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {SolidOpts & {layerLabel?: string}} opts
 * @returns {{obj: string, triangles: number, shells: number, vertices: number}}
 */
export function writeVoxelSolidOBJ(dem, opts) {
  const k = Math.max(1, Math.round(opts.blockCells));
  const ex = opts.exaggeration ?? 1;
  const { baseZ, quantum: q } = opts;
  const { levels, bRows, bCols } = blockLevels(dem, k, baseZ, q);
  const w = k * dem.cell;
  const northY = dem.nrows * dem.cell;
  const g = { w, northY, baseZ, q, ex };

  // ⚠️ ONE POOL ACROSS ALL GROUPS, deliberately. Two solids that abut share the
  // vertices along the seam, so the pair fits together exactly rather than to
  // within a rounding — which is what you want when the point of grouping is to
  // print the classes separately and lay them back together.
  const pool = new VertexPool();
  /** @type {{label: string, tris: number[][]}[]} */
  const parts = [];
  if (opts.groups) {
    const groups = opts.groups;
    const ids = [...new Set(Array.from(groups))].filter((v) => v >= 0).sort((a, b) => a - b);
    for (const id of ids) {
      const tris = shell((bi) => groups[bi] === id, levels, bRows, bCols, pool, g);
      if (tris.length) {
        parts.push({
          label: (opts.groupLabels && opts.groupLabels[id]) || `class_${id}`,
          tris,
        });
      }
    }
  } else {
    parts.push({ label: "terrain", tris: shell(() => true, levels, bRows, bCols, pool, g) });
  }

  const out = [];
  out.push("# DL-TerrainDiversity terrain export — VOXEL SOLID");
  out.push(`# source ${dem.name || "(unnamed)"}`);
  out.push(`# ${bCols} x ${bRows} block columns at ${w.toFixed(3)} m, from ${dem.ncols} x ${dem.nrows} cells at ${dem.cell} m`);
  out.push("# WATERTIGHT: the boundary of the union of the blocks, not the blocks themselves.");
  out.push("# Interior faces are never emitted and vertices are welded, so this is one");
  out.push("# closed 2-manifold shell per object — sliceable without repair.");
  out.push(`# base plate at ${(baseZ * ex).toFixed(4)} (local Z); the solid stands on it`);
  // ⚠️ THE CRS NAMED HERE IS THE DEM'S OWN. It was the literal
  // "EPSG:25833", so an OBJ exported from terrain anywhere else told the
  // reader to place it using this tool's home datum — and these two lines
  // are exactly what a reader USES to georeference the mesh. When the CRS
  // is unknown the token becomes origin_local, which states that the
  // origin is real but its system is not declared.
  out.push(`# COORDINATES ARE LOCAL: add the origin below to place this in ${dem.crs || "the source file's own coordinate system"}.`);
  out.push(`# origin_${dem.epsg ? `epsg${dem.epsg}` : "local"} ${dem.originX} ${dem.originY}`);
  out.push("# up_axis Z");
  out.push(ex === 1
    ? "# vertical_exaggeration 1 (true elevations, NN2000)"
    : `# vertical_exaggeration ${ex} — Z IS NOT TRUE ELEVATION, divide by ${ex}`);
  if (opts.groups) {
    out.push(`# grouped by ${opts.layerLabel || "a categorical layer"} — one closed solid per class`);
  }
  out.push("# Terrain data (c) Kartverket, hoydedata.no, NLOD / CC BY 4.0");

  const f = (v) => v.toFixed(4);
  for (const [x, y, z] of pool.list) out.push(`v ${f(x)} ${f(y)} ${f(z)}`);

  let triangles = 0;
  for (const p of parts) {
    out.push(`o ${p.label.replace(/[^A-Za-z0-9_.-]+/g, "_")}`);
    for (const t of p.tris) out.push(`f ${t[0] + 1} ${t[1] + 1} ${t[2] + 1}`);
    triangles += p.tris.length;
  }

  // ⚠️ MEASURED ON WHAT WAS JUST WRITTEN, not promised by the code that wrote
  // it. "Watertight" is a property of a file and the one property of this
  // export nobody can check by looking at the result.
  let unpaired = 0, nonManifold = 0;
  for (const p of parts) {
    const rep = manifoldReport(p.tris);
    unpaired += rep.unpaired;
    nonManifold += rep.duplicated;
  }

  return {
    obj: out.join("\n") + "\n",
    triangles,
    shells: parts.length,
    vertices: pool.list.length,
    closed: unpaired === 0,
    unpaired,
    /**
     * Edges where two parts of one solid meet corner-to-corner and nowhere
     * else. Not a hole — see manifoldReport — but a knife edge, and on a
     * GROUPED export there can be thousands of them, because a species class is
     * genuinely a scatter of patches rather than one lump. Worth knowing before
     * committing a print, so it is reported rather than buried.
     */
    nonManifold,
  };
}

/**
 * Two separate questions about a triangle soup, reported separately because
 * they have different consequences and only one of them is a defect here.
 *
 * `closed` — every directed edge's reverse is also present. A failure is a HOLE,
 * and a hole is what a slicer means by "not watertight": the body has no
 * well-defined inside and cannot be filled. This must be true.
 *
 * `manifold` — no directed edge is used more than once. A failure is an edge
 * with four faces on it rather than two.
 *
 * ⚠️ AND ON A STAIRCASE, A FEW NON-MANIFOLD EDGES ARE THE SHAPE, NOT A BUG.
 * Where four block columns meet at a corner in a saddle — two diagonally
 * opposite ones tall, the other two short — the two tall columns touch along
 * that vertical edge and nowhere else. Four wall faces meet on one edge. The
 * body is still closed, its volume is still exact, and there is no hole; the
 * contact is a knife edge, which is a real property of stacked cubes and would
 * be there in the blocks themselves. Measured on the real patch it is a handful
 * of edges out of hundreds of thousands — 48 at one cell per block, 0 at four.
 * Reported rather than silently repaired, because repairing it means moving
 * material the terrain does not have.
 * @param {number[][]} tris
 */
export function manifoldReport(tris) {
  const seen = new Map();
  for (const [a, b, c] of tris) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = `${u}>${v}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  let unpaired = 0, duplicated = 0;
  for (const [key, n] of seen) {
    if (n > 1) duplicated++;
    const [u, v] = key.split(">");
    if (!seen.has(`${v}>${u}`)) unpaired++;
  }
  return {
    edges: seen.size,
    unpaired,
    duplicated,
    closed: unpaired === 0,
    manifold: duplicated === 0,
  };
}
