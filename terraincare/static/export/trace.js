// @ts-check
// RASTER LABELS → POLYGON RINGS.
//
// The piece this project did not have. `polygon.js` goes the other way — it
// rasterises a drawn ring onto the grid — and every vector export so far has
// been of geometry the USER drew, which was already vector. A watershed is not
// drawn: it is a computed partition of cells, and getting it out as a shapefile
// means recovering its boundary.
//
// ⚠️ CELL EDGES, NOT MARCHING SQUARES, AND THE DIFFERENCE IS THE POINT. Marching
// squares interpolates a contour through a scalar field and would give smooth,
// plausible, WRONG basin boundaries — a divide is not a level set of anything.
// A basin is a set of whole cells, its boundary runs along cell edges, and the
// polygon this returns encloses exactly the cells that carry the label. The
// area of the ring equals the cell count times the cell area, exactly, and the
// suite asserts that rather than trusting it.
//
// ⚠️ DIRECTED EDGES, NOT AN UNDIRECTED SOUP. Two basins can meet at a single
// lattice point — four cells around a corner, two labels diagonally opposite —
// and at that point four boundary edges meet. Chaining undirected edges there
// is a coin toss that can weld two separate lobes into one self-touching ring.
// Each cell contributes its own boundary edges with a fixed winding, so every
// vertex has as many outgoing edges as incoming and the walk is determined.

/**
 * @typedef {object} TracedFeature
 * @property {number} label   the grid value this outline encloses
 * @property {number[][][]} rings  [outer, ...holes], world [x, y], closed
 * @property {number} cells   how many cells the component holds
 */

/**
 * Outline every connected component of every label in an integer grid.
 *
 * @param {Int32Array|Int16Array|Uint8Array} labels  one value per cell, row-major
 * @param {{nrows:number, ncols:number, cell:number, originX:number, originY:number,
 *          keep?: (label:number) => boolean}} g
 * @returns {TracedFeature[]}
 */
export function traceLabelRings(labels, g) {
  const { nrows, ncols, cell, originX, originY } = g;
  const keep = g.keep ?? ((v) => v >= 0);

  // ⚠️ COMPONENTS FIRST, THEN OUTLINES. Two basins that happen to carry the same
  // label — or one label used for a class rather than an instance, which is
  // exactly how MICRO is used — would otherwise come back as a single feature
  // with a dozen disjoint outer rings, and a shapefile polygon whose rings are
  // disjoint is a malformed polygon rather than a multipart one.
  const comp = new Int32Array(nrows * ncols).fill(-1);
  /** @type {{label:number, cells:number[]}[]} */
  const comps = [];
  const stack = [];
  for (let i = 0; i < labels.length; i++) {
    if (comp[i] !== -1 || !keep(labels[i])) continue;
    const label = labels[i];
    const id = comps.length;
    const cells = [];
    stack.length = 0;
    stack.push(i);
    comp[i] = id;
    while (stack.length) {
      const j = stack.pop();
      cells.push(j);
      const r = (j / ncols) | 0, c = j - r * ncols;
      // ⚠️ FOUR-CONNECTED, matching the edge walk below. Under 8-connectivity a
      // component may touch itself only at a corner, and its "boundary" is then
      // not a simple closed curve — the outline and the component would be
      // describing different shapes.
      if (c > 0) push(j - 1);
      if (c + 1 < ncols) push(j + 1);
      if (r > 0) push(j - ncols);
      if (r + 1 < nrows) push(j + ncols);
    }
    comps.push({ label, cells });
    function push(k) {
      if (comp[k] === -1 && labels[k] === label) { comp[k] = id; stack.push(k); }
    }
  }

  const out = [];
  for (let id = 0; id < comps.length; id++) {
    const rings = ringsOf(comps[id].cells, comp, id, nrows, ncols);
    if (!rings.length) continue;
    // grid lattice → world. y flips: row 0 is the TOP of the tile.
    const w = (ring) => ring.map(([c, r]) =>
      [originX + c * cell, originY + (nrows - r) * cell]);
    const world = rings.map(w);
    // ⚠️ THE BIGGEST BY |AREA| IS THE OUTER RING. Not the first traced, and not
    // the one with a particular winding — a component with a hole emits both in
    // an order that depends only on scan order.
    let bi = 0, ba = -1;
    for (let k = 0; k < world.length; k++) {
      const a = Math.abs(signedArea(world[k]));
      if (a > ba) { ba = a; bi = k; }
    }
    const ordered = [world[bi], ...world.filter((_, k) => k !== bi)];
    out.push({ label: comps[id].label, rings: ordered, cells: comps[id].cells.length });
  }
  return out;
}

/**
 * The closed cell-edge loops bounding one component.
 * @returns {number[][][]} rings in GRID lattice coordinates [c, r]
 */
function ringsOf(cells, comp, id, nrows, ncols) {
  const inside = (r, c) =>
    r >= 0 && c >= 0 && r < nrows && c < ncols && comp[r * ncols + c] === id;

  // Directed boundary edges, wound clockwise around each cell in grid space
  // (row index increasing downward). Shared edges between two cells of the
  // component are emitted by neither, so what survives is exactly the boundary.
  const V = ncols + 1;
  /** @type {Map<number, number[]>} vertex → end vertices of its outgoing edges */
  const outEdges = new Map();
  const add = (c0, r0, c1, r1) => {
    const a = r0 * V + c0, b = r1 * V + c1;
    const l = outEdges.get(a);
    if (l) l.push(b); else outEdges.set(a, [b]);
  };
  for (const j of cells) {
    const r = (j / ncols) | 0, c = j - r * ncols;
    if (!inside(r - 1, c)) add(c, r, c + 1, r);            // top,    →
    if (!inside(r, c + 1)) add(c + 1, r, c + 1, r + 1);    // right,  ↓
    if (!inside(r + 1, c)) add(c + 1, r + 1, c, r + 1);    // bottom, ←
    if (!inside(r, c - 1)) add(c, r + 1, c, r);            // left,   ↑
  }

  const rings = [];
  for (const [start, list] of outEdges) {
    while (list.length) {
      const ring = [];
      let a = start;
      let b = /** @type {number} */ (list.pop());
      // Guard: a malformed walk must not spin forever. Every edge is consumed
      // once, so the loop cannot exceed the edge count.
      for (let guard = 0; guard <= cells.length * 4 + 4; guard++) {
        ring.push([a % V, (a / V) | 0]);
        if (b === start) break;
        const nxt = outEdges.get(b);
        if (!nxt || !nxt.length) break;
        a = b;
        b = /** @type {number} */ (nxt.pop());
      }
      ring.push([start % V, (start / V) | 0]);
      if (ring.length > 3) rings.push(collapse(ring));
    }
  }
  return rings;
}

/**
 * Drop vertices that continue in the same direction.
 *
 * ⚠️ A COSMETIC SAVING WITH A REAL REASON. Traced raw, a 64 m basin edge is one
 * vertex every cell — 256 collinear points down a straight divide. The geometry
 * is identical either way; the file is several times smaller and a CAD reader
 * shows a straight run as one segment rather than as a row of handles.
 */
function collapse(ring) {
  const out = [ring[0]];
  for (let i = 1; i + 1 < ring.length; i++) {
    const [px, py] = out[out.length - 1], [x, y] = ring[i], [nx, ny] = ring[i + 1];
    if ((x - px) * (ny - y) !== (y - py) * (nx - x)) out.push(ring[i]);
  }
  out.push(ring[ring.length - 1]);
  return out;
}

/** Twice the signed area — sign is the winding, magnitude is 2×area. */
export function signedArea(ring) {
  let s = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return s / 2;
}

/** Ring area with holes subtracted, in map units². */
export function ringsArea(rings) {
  let a = Math.abs(signedArea(rings[0]));
  for (let i = 1; i < rings.length; i++) a -= Math.abs(signedArea(rings[i]));
  return a;
}
