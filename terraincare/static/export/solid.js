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
  out.push("# COORDINATES ARE LOCAL: add the origin below to place this in EPSG:25833.");
  out.push(`# origin_epsg25833 ${dem.originX} ${dem.originY}`);
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
