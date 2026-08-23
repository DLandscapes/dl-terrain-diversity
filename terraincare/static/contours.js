// @ts-check
// CONTOURS — the line a landscape architect actually draws with.
//
// This lives apart from surface.js, and deliberately free of three.js, so the
// invariant that makes contours work can be asserted headlessly: every drawn
// segment must lie EXACTLY IN one of the mesh's own triangles.
//
// ⚠️ THIS IS THE LATTICE BUG AGAIN, AND IT IS WORTH STATING BEFORE THE CODE.
// The obvious implementation is marching squares over the four corners of each
// cell: interpolate the level along the cell's edges, join the crossings, done.
// It is also wrong here. The surface is not drawn as quads — surface.js splits
// every quad along its ANTI-diagonal into a-d-b and b-d-e — so a segment
// derived from the four corners passes through the bilinear surface, which is
// not the surface being rendered. Across the split it sits above one triangle
// and below the other. The symptom would be contour lines that vanish in
// patches and return as the camera moves, which is precisely the report that
// lattice.js was written to fix, and it would be misdiagnosed as depth fighting
// for exactly the same reason.
//
// So the marching is done PER TRIANGLE, over the same two triangles the
// renderer shades. A triangle is planar by definition, so linear interpolation
// along its edges puts the segment in its plane to floating-point precision. It
// cannot be occluded by the facet it belongs to, at any angle or exaggeration.
//
// A second thing falls out for free, and it is the reason contouring libraries
// are longer than this one: a triangle HAS NO SADDLE AMBIGUITY. Marching
// squares has to decide how to connect four crossings when two opposite corners
// are above the level and two below — the classic ambiguous case, resolved by
// convention, by the cell's mean, or by asymmetric lookup tables, and resolved
// differently by different libraries on the same data. Three vertices admit
// exactly zero or two crossings. There is nothing to disambiguate, so there is
// no convention to get wrong and no table to mistype.

/**
 * The contour levels crossing an elevation range, as exact multiples of the
 * interval. Anchored to zero rather than to the range's own minimum, so the
 * lines are at 77.0 m and 77.5 m rather than at "the bottom of this tile plus
 * half a metre" — which means they do not move when the terrain is edited, and
 * two tiles of the same site draw the same set.
 *
 * @param {number} zmin @param {number} zmax
 * @param {number} interval metres
 * @param {number} [limit] refuse to return more than this many levels
 * @returns {number[]} ascending
 */
export function contourLevels(zmin, zmax, interval, limit = 2000) {
  if (!(interval > 0) || !Number.isFinite(zmin) || !Number.isFinite(zmax)) return [];
  if (zmax < zmin) return [];
  const k0 = Math.ceil(zmin / interval);
  const k1 = Math.floor(zmax / interval);
  if (k1 < k0) return [];
  // ⚠️ A guard, not a nicety. The interval arrives from a slider, and an
  // interval far below the tile's vertical resolution would ask for hundreds of
  // thousands of levels — the tool would appear to hang while building line
  // work too dense to read. Refusing loudly is better than drawing it.
  if (k1 - k0 + 1 > limit) return [];
  const out = [];
  for (let k = k0; k <= k1; k++) out.push(k * interval);
  return out;
}

/**
 * A sensible interval for a surface, from the 1-2-5 series.
 *
 * Same series the scale bar uses (export/figure.js), for the same reason: a
 * contour interval is read off and multiplied in the head, and 0.25 m is a
 * number people can count in where 0.3 m is not.
 *
 * @param {number} relief metres of range
 * @param {number} [target] roughly how many lines to aim for
 */
export function niceInterval(relief, target = 12) {
  if (!(relief > 0)) return 1;
  const raw = relief / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm <= 1.5 ? 1 : norm <= 3.5 ? 2 : norm <= 7.5 ? 5 : 10;
  return step * mag;
}

/**
 * Where a level crosses one triangle, appended to `out` as two XYZ points.
 *
 * The three vertices are given as (x, y, z) triples in the surface's own LOCAL
 * coordinates. Interpolation is linear in the plane of the triangle, which is
 * what puts the segment in the facet rather than near it.
 *
 * ⚠️ THE ABOVE/BELOW TEST IS HALF-OPEN — `z >= level` counts as above. Using
 * two closed comparisons makes a vertex sitting exactly on the level belong to
 * both sides, which emits a zero-length segment at that vertex and, on a
 * surface levelled to a datum, emits one at every vertex of the flat. Same
 * class of defect as the scanline test in polygon.js, and it shows up on
 * exactly the surface this tool exists to talk about.
 *
 * @param {number[]} out flat XYZ, 6 numbers appended per crossing
 * @param {number} ax @param {number} ay @param {number} az
 * @param {number} bx @param {number} by @param {number} bz
 * @param {number} cx @param {number} cy @param {number} cz
 * @param {number} level
 */
function triangleCrossing(out, ax, ay, az, bx, by, bz, cx, cy, cz, level) {
  const a = az >= level, b = bz >= level, c = cz >= level;
  // All on one side: no crossing. This is the case for the overwhelming
  // majority of triangles at any usable interval, so it is tested first.
  if (a === b && b === c) return;

  let n = 0;
  // The odd vertex out is the one whose side differs; the level crosses the two
  // edges meeting at it. Walking all three edges and keeping those whose
  // endpoints differ finds the same pair without a case analysis.
  const edge = (px, py, pz, qx, qy, qz) => {
    const t = (level - pz) / (qz - pz);
    out.push(px + (qx - px) * t, py + (qy - py) * t, level);
    n++;
  };
  if (a !== b) edge(ax, ay, az, bx, by, bz);
  if (b !== c) edge(bx, by, bz, cx, cy, cz);
  if (c !== a) edge(cx, cy, cz, ax, ay, az);
  // Exactly two, always — a triangle cannot produce more. Kept as a structural
  // guard rather than a comment: if this ever fires, the geometry assumption
  // above has been broken and a silent single-endpoint segment would draw a
  // line to the origin.
  if (n !== 2) out.length -= n * 3;
}

/**
 * Contour line segments over a heightfield, as a flat XYZ line list.
 *
 * Positions are LOCAL — X from 0 at the west edge, Y from 0 at the south edge,
 * matching surface.js's vertex layout exactly, so the result can be added as a
 * child of the terrain mesh and inherit the UTM origin from its transform. The
 * reason is the one that cost this project three phases: a float32 vertex
 * buffer at this site's northing quantises to half a metre, so world
 * coordinates must never be baked into geometry.
 *
 * ⚠️ COST IS PROPORTIONAL TO THE LINE WORK, NOT TO CELLS × LEVELS. The naive
 * loop tests every triangle against every level, which at a 0.25 m interval on
 * the design patch is 130 000 triangles × 21 levels = 2.7 million tests for
 * perhaps 40 000 segments. Because the levels are exact multiples of the
 * interval, the ones a triangle can possibly cross follow directly from its own
 * min and max, so each triangle tests only the levels actually passing through
 * it — almost always zero or one. That is what makes this cheap enough to
 * rebuild inside a brush stroke rather than only when a gesture settles.
 *
 * @param {Float32Array} z elevations, row-major, NaN = nodata
 * @param {number} nrows @param {number} ncols
 * @param {number} cell ground units
 * @param {number} interval metres between levels
 * @param {{exaggeration?: number, limit?: number}} [opts]
 * @returns {{positions: Float32Array, segments: number, levels: number}}
 */
export function contourSegments(z, nrows, ncols, cell, interval, opts = {}) {
  const ex = opts.exaggeration ?? 1;
  const empty = { positions: new Float32Array(0), segments: 0, levels: 0 };
  if (!(interval > 0) || nrows < 2 || ncols < 2) return empty;

  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < z.length; i++) {
    const v = z[i];
    if (Number.isFinite(v)) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
  }
  const levels = contourLevels(zmin, zmax, interval, opts.limit ?? 2000);
  if (!levels.length) return empty;

  /** @type {number[]} */
  const out = [];
  const northY = nrows * cell; // LOCAL north edge, as surface.js builds it

  for (let r = 0; r + 1 < nrows; r++) {
    const yN = northY - (r + 0.5) * cell;
    const yS = northY - (r + 1.5) * cell;
    for (let c = 0; c + 1 < ncols; c++) {
      const ia = r * ncols + c;
      const za = z[ia], zb = z[ia + 1], zd = z[ia + ncols], ze = z[ia + ncols + 1];
      // ⚠️ A hole in the DEM removes the whole quad, not just the cell. Both
      // triangles reference the missing corner, and interpolating toward NaN
      // would emit a segment at NaN which three.js turns into an invisible
      // draw call and a corrupt bounding box.
      if (!Number.isFinite(za) || !Number.isFinite(zb)
        || !Number.isFinite(zd) || !Number.isFinite(ze)) continue;

      let lo = za, hi = za;
      if (zb < lo) lo = zb; if (zb > hi) hi = zb;
      if (zd < lo) lo = zd; if (zd > hi) hi = zd;
      if (ze < lo) lo = ze; if (ze > hi) hi = ze;
      const k0 = Math.ceil(lo / interval), k1 = Math.floor(hi / interval);
      if (k1 < k0) continue;

      const xW = (c + 0.5) * cell, xE = (c + 1.5) * cell;
      for (let k = k0; k <= k1; k++) {
        const level = k * interval;
        // The same two triangles surface.js indexes: a-d-b and b-d-e, with
        // a=(r,c), b=(r,c+1), d=(r+1,c), e=(r+1,c+1).
        triangleCrossing(out, xW, yN, za, xW, yS, zd, xE, yN, zb, level);
        triangleCrossing(out, xE, yN, zb, xW, yS, zd, xE, yS, ze, level);
      }
    }
  }

  const positions = new Float32Array(out.length);
  for (let i = 0; i < out.length; i += 3) {
    positions[i] = out[i];
    positions[i + 1] = out[i + 1];
    positions[i + 2] = out[i + 2] * ex;   // only Z carries the exaggeration
  }
  return { positions, segments: out.length / 6, levels: levels.length };
}

/**
 * How far each segment's midpoint departs from the surface it is drawn on,
 * measured against the same triangulation the renderer shades.
 *
 * Zero by construction for anything contourSegments() produced — which is the
 * point, and is why the self-test measures it rather than merely asserting it.
 * Fed segments derived from the four quad corners instead, it returns the real
 * departure across the split, so the check fails loudly if anyone replaces this
 * with a quad-based marching squares.
 *
 * @param {Float32Array} z @param {number} nrows @param {number} ncols
 * @param {number} cell
 * @param {ArrayLike<number>} positions flat XYZ line list, local coordinates
 * @param {number} [exaggeration]
 */
export function facetDeviation(z, nrows, ncols, cell, positions, exaggeration = 1) {
  const northY = nrows * cell;
  let max = 0, sum = 0, n = 0;
  for (let s = 0; s + 5 < positions.length; s += 6) {
    const mx = (positions[s] + positions[s + 3]) / 2;
    const my = (positions[s + 1] + positions[s + 4]) / 2;
    const mz = (positions[s + 2] + positions[s + 5]) / 2;

    // Which cell, and which of its two triangles, the midpoint lands in.
    const fc = mx / cell - 0.5, fr = (northY - my) / cell - 0.5;
    const c = Math.min(ncols - 2, Math.max(0, Math.floor(fc)));
    const r = Math.min(nrows - 2, Math.max(0, Math.floor(fr)));
    const u = fc - c, v = fr - r;             // 0..1 within the quad
    const ia = r * ncols + c;
    const za = z[ia], zb = z[ia + 1], zd = z[ia + ncols], ze = z[ia + ncols + 1];
    if (!Number.isFinite(za) || !Number.isFinite(zb)
      || !Number.isFinite(zd) || !Number.isFinite(ze)) continue;

    // The quad splits a-d-b / b-d-e; the shared edge b-d runs from the
    // north-east corner to the south-west one, so u + v < 1 is the a side.
    let zs;
    if (u + v <= 1) zs = za + (zb - za) * u + (zd - za) * v;
    else zs = ze + (zd - ze) * (1 - u) + (zb - ze) * (1 - v);

    const d = Math.abs(mz - zs * exaggeration);
    if (d > max) max = d;
    sum += d; n++;
  }
  return { max, mean: n ? sum / n : 0, samples: n };
}
