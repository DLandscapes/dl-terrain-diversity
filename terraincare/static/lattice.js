// @ts-check
// Which edges of the terrain triangulation the wireframe draws.
//
// This lives apart from surface.js, and deliberately free of three.js, so the
// one invariant that makes the lattice work can be asserted headlessly in the
// self-test: EVERY drawn segment must be an edge of the mesh's own
// triangulation. A segment that joins two vertices further apart than one cell
// is a straight chord across curved ground, and the terrain in between rises
// through it.
//
// That is not a theoretical worry — it is the bug this module was written to
// remove. The previous lattice joined vertices 4 cells apart on the real
// Ørndalen fill patch, where the surface rose above the chord by 0.022 m on
// average and up to 0.390 m, against a segment only 1 m long. Half of all
// segments were buried by more than 10 mm of terrain. The symptom was
// wireframe that vanished in patches and returned as the camera moved, which
// reads exactly like a depth-test tie — and was misdiagnosed as one. Polygon
// offset bought 9.0% -> 13.4% of the line work back and then saturated,
// because no depth bias can win against a third of a metre of solid ground.
//
// Subdividing each lattice line through the intervening vertices makes every
// segment a real triangle edge, which cannot be occluded by the surface it
// belongs to. The diagonal is drawn too: the mesh splits each quad along its
// anti-diagonal, so drawing that edge shows the triangulation the renderer is
// actually shading rather than a quad grid that exists nowhere in the geometry.

/**
 * The three edge directions present in the surface triangulation, as
 * [dRow, dCol]. Quads are split a-d-b / b-d-e with a=(r,c), b=(r,c+1),
 * d=(r+1,c), e=(r+1,c+1), so the shared edge b-d runs from north-east to
 * south-west — the ANTI-diagonal. Any other direction is not an edge of this
 * mesh, and a line drawn along it would cut through faces.
 */
export const EDGE_DIRECTIONS = [
  [0, 1],   // west-east, a-b
  [1, 0],   // north-south, a-d
  [1, -1],  // the quad diagonal, b-d
];

/**
 * Is (i, j) a single edge of the triangulation over an nrows x ncols grid?
 * @param {number} i @param {number} j @param {number} ncols
 */
export function isMeshEdge(i, j, ncols) {
  const dr = Math.trunc(j / ncols) - Math.trunc(i / ncols);
  const dc = (j % ncols) - (i % ncols);
  return EDGE_DIRECTIONS.some(([r, c]) =>
    (dr === r && dc === c) || (dr === -r && dc === -c));
}

/**
 * Vertex-index pairs for the wireframe: every `step`-th grid line in each
 * direction, plus one diagonal per coarse quad, each subdivided so that no
 * segment spans more than a single cell.
 *
 * Drawing every line instead would be ~195 000 segments at 256², roughly one
 * pixel apart — the line work paints over the surface it was meant to
 * describe, which is the same failure the voxel outlines hit. `step` decides
 * how coarse the lattice reads; the subdivision decides only whether it stays
 * on the surface, and costs nothing per frame because the wire shares the
 * mesh's position buffer.
 *
 * ⚠️ A HOLE MUST BE CUT HERE TOO, not only in the mesh index. The lattice keeps
 * its OWN index over the mesh's shared position buffer, so removing triangles
 * from the surface leaves the wireframe drawing a grid across the empty space —
 * which reads as a rendering fault rather than as a deliberate opening, and is
 * worse than the overlap it was meant to fix.
 *
 * @param {number} nrows @param {number} ncols
 * @param {number} step lattice spacing in cells
 * @param {{r0:number,c0:number,r1:number,c1:number}|null} [hole]
 *   inclusive cell rect to leave open. A segment is dropped when EITHER end
 *   falls inside it, so no line reaches into the opening from outside.
 * @param {{diagonals?: boolean}} [opts]
 *   ⚠️ `diagonals:false` DRAWS THE QUAD GRID ONLY (2026-08-11, Marc's call for
 *   the plan-sheet reading). The honesty argument above still stands — the
 *   mesh really is triangles, and the diagonal is the edge the renderer
 *   shades along — but at plan scale three line families over one surface
 *   read as hatching rather than as structure, and the drawing this tool is
 *   now dressed as does not have triangles in it. Every segment still
 *   satisfies isMeshEdge; dropping a family removes information, it never
 *   invents any. The suite keeps the default (all three directions).
 * @returns {Uint32Array} flat pairs, 2 indices per segment
 */
export function latticeEdges(nrows, ncols, step, hole = null, opts = {}) {
  step = Math.max(1, Math.round(step));
  /** @type {number[]} */
  const idx = [];
  const inHole = hole
    ? (i) => {
      const r = Math.trunc(i / ncols), c = i % ncols;
      return r >= hole.r0 && r <= hole.r1 && c >= hole.c0 && c <= hole.c1;
    }
    : () => false;
  const push = (a, b) => { if (!inHole(a) && !inHole(b)) idx.push(a, b); };

  // Grid lines. The final row and column are always drawn even when the step
  // does not land on them, so the lattice closes on the edge of the tile
  // instead of stopping one line short of it.
  const lines = (n) => {
    const out = [];
    for (let v = 0; v < n; v += step) out.push(v);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  };

  for (const r of lines(nrows)) {
    for (let c = 0; c + 1 < ncols; c++) push(r * ncols + c, r * ncols + c + 1);
  }
  for (const c of lines(ncols)) {
    for (let r = 0; r + 1 < nrows; r++) push(r * ncols + c, (r + 1) * ncols + c);
  }

  // One diagonal per coarse quad, walked as unit anti-diagonal edges:
  // (r+t, c+step-t) -> (r+t+1, c+step-t-1).
  if (opts.diagonals !== false) {
    for (let r = 0; r + step < nrows; r += step) {
      for (let c = 0; c + step < ncols; c += step) {
        for (let t = 0; t < step; t++) {
          push((r + t) * ncols + (c + step - t),
               (r + t + 1) * ncols + (c + step - t - 1));
        }
      }
    }
  }

  return Uint32Array.from(idx);
}

/**
 * How far the terrain rises above the straight chords of a set of segments, in
 * DEM units. Zero for any lattice built by latticeEdges(), by construction —
 * which is the point, and is why the self-test measures it against the chorded
 * lattice it replaced rather than merely asserting it.
 *
 * @param {Float32Array} z @param {number} ncols
 * @param {ArrayLike<number>} edges flat index pairs
 * @param {number} [exaggeration]
 */
export function chordDeviation(z, ncols, edges, exaggeration = 1) {
  let max = 0, sum = 0, n = 0;
  for (let k = 0; k < edges.length; k += 2) {
    const i = edges[k], j = edges[k + 1];
    const r0 = Math.trunc(i / ncols), c0 = i % ncols;
    const r1 = Math.trunc(j / ncols), c1 = j % ncols;
    const steps = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0));
    if (steps < 2) { n++; continue; }
    const dr = (r1 - r0) / steps, dc = (c1 - c0) / steps;
    const za = z[i], zb = z[j];
    let worst = 0;
    for (let t = 1; t < steps; t++) {
      const zt = z[(r0 + dr * t) * ncols + (c0 + dc * t)];
      const chord = za + (zb - za) * (t / steps);
      const d = (zt - chord) * exaggeration;
      if (d > worst) worst = d;
    }
    if (worst > max) max = worst;
    sum += worst; n++;
  }
  return { max, mean: n ? sum / n : 0, segments: n };
}
