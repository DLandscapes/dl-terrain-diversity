// @ts-check
/**
 * THE CONTEXT AT A GRADED DENSITY — a restricted quadtree over the backdrop,
 * native where it meets the design patch and coarsening outward.
 *
 * Marc, 2026-09-02: "could we have the context mesh increasing gradually in
 * resolution as it comes closer to the 64x64 patch and reaching the same face
 * count at the border … like a tree like subdivision that progressively
 * subdivides … it would transport the message that things like water are also
 * coming from outside the patch — and that we can not just look at it in an
 * isolated manner."
 *
 * ⚠️⚠️ THE SUBDIVISION RUNS OUTWARD, NOT INWARD, AND THE DIFFERENCE IS THE
 * WHOLE HONESTY OF THIS FILE. There is no terrain data finer than 4 m outside
 * the patch — the national model resolves 4 m, and that is finding 1, the thing
 * this instrument exists to demonstrate. Subdividing the context BELOW its own
 * cell size toward the patch would manufacture vertices by interpolation and
 * draw them at the same density as the 0.25 m survey, which is precisely the
 * claim the tool spends its whole argument refusing to make. So the mesh is
 * NATIVE 4 m in a ring around the patch and gets COARSER with distance. The
 * gradation Marc asked for is real and visible; it simply runs the way the data
 * supports.
 *
 * ⚠️ AND THE 4 m → 0.25 m BRIDGE ALREADY EXISTS. `apron.js` grades triangle
 * size from the design mesh's own edge vertices out to the context's lattice
 * over a 10 m ring, and blends the two SURVEYS with a smoothstep. This file
 * hands that apron the same 4 m rim it already meets; nothing about the seam
 * changes. What changes is everything beyond it.
 *
 * ⚠️ IT IS AN INDEX BUFFER, NOT A MESH. Every vertex it uses is a vertex
 * `surface.js` already allocated, addressed by the same `r * ncols + c`, so the
 * positions, the per-vertex shading, the vertical exaggeration and the hole all
 * keep working untouched. Building a second mesh would have meant a second copy
 * of the heightfield to keep in step — the trap `_buildWire` records.
 *
 * ⚠️ RESTRICTED, meaning neighbouring blocks differ by at most one level. That
 * is what makes the stitch possible: a block whose neighbour is finer inserts
 * the midpoint of the shared edge, so both sides present two half-length edges
 * and meet exactly. Without the restriction a coarse block could face four
 * finer ones and one midpoint would not be enough — the surface would still
 * TILE, with no gap in plan, but the fine vertices would sit off the coarse
 * edge in Z and the ground would show a row of pinholes along the seam.
 *
 * ⚠️ EACH BLOCK FANS FROM ITS CENTRE VERTEX rather than splitting into two
 * triangles. The centre is a real lattice vertex carrying a real measured
 * height, so a 32 m block passes through the ground at its middle instead of
 * bridging it. Two triangles would have been cheaper and would have flattened
 * every summit that happened to land inside a block.
 */

/**
 * Build a graded index buffer over a surface's vertex lattice.
 *
 * @param {number} nrows @param {number} ncols  the vertex lattice
 * @param {{
 *   hole?: {r0:number,c0:number,r1:number,c1:number}|null,
 *   focus?: {r0:number,c0:number,r1:number,c1:number}|null,
 *   nativeRings?: number, maxLevel?: number,
 * }} [opts]
 *   `hole` is the opening the design patch draws through, in CELLS, exactly as
 *   `Surface.setHole` takes it. `focus` is what the density is graded toward,
 *   defaulting to the hole. `nativeRings` is how many quads stay at full
 *   resolution around the focus before coarsening begins.
 * @returns {{indices: Uint32Array, triangles: number, levels: Int32Array,
 *            blocks: number}}
 */
export function quadtreeIndex(nrows, ncols, opts = {}) {
  const QR = nrows - 1, QC = ncols - 1;          // quads, not vertices
  const hole = opts.hole ?? null;
  const focus = opts.focus ?? hole;
  const nativeRings = opts.nativeRings ?? 8;
  const maxLevel = opts.maxLevel ?? 5;           // 4 m → 128 m at the rim

  // ── 1. the level every quad would like ─────────────────────────────────────
  // Chebyshev distance to the focus rectangle, in quads. Rings double in width
  // as the level climbs, which is what a quadtree does anyway — a linear rule
  // would put most of the tile at one coarse level and grade nothing.
  const want = new Int32Array(QR * QC);
  for (let r = 0; r < QR; r++) {
    for (let c = 0; c < QC; c++) {
      let d = 0;
      if (focus) {
        const dr = Math.max(focus.r0 - 1 - r, r - (focus.r1 + 1), 0);
        const dc = Math.max(focus.c0 - 1 - c, c - (focus.c1 + 1), 0);
        d = Math.max(dr, dc);
      }
      const over = d - nativeRings;
      const lvl = over <= 0 ? 0 : Math.floor(Math.log2(1 + over / nativeRings)) + 1;
      want[r * QC + c] = Math.min(maxLevel, lvl);
    }
  }

  // ── 2. restrict it: neighbours may differ by at most one level ─────────────
  // ⚠️ ITERATED TO A FIXED POINT, not swept once. Lowering one block can put it
  // two levels below a neighbour that was already settled, so a single pass
  // leaves violations behind — and a violation is a visible row of pinholes.
  for (let pass = 0; pass < maxLevel + 2; pass++) {
    let changed = false;
    for (let r = 0; r < QR; r++) {
      for (let c = 0; c < QC; c++) {
        const i = r * QC + c;
        let lo = maxLevel;
        if (r > 0) lo = Math.min(lo, want[i - QC]);
        if (r + 1 < QR) lo = Math.min(lo, want[i + QC]);
        if (c > 0) lo = Math.min(lo, want[i - 1]);
        if (c + 1 < QC) lo = Math.min(lo, want[i + 1]);
        if (want[i] > lo + 1) { want[i] = lo + 1; changed = true; }
      }
    }
    if (!changed) break;
  }

  // ── 3. merge into aligned blocks, coarsest first ───────────────────────────
  const owner = new Int32Array(QR * QC).fill(-1);   // block level per quad
  /** @type {{r:number, c:number, s:number}[]} */
  const blocks = [];
  const inHole = (r, c) => hole
    && r + 1 >= hole.r0 && r <= hole.r1 && c + 1 >= hole.c0 && c <= hole.c1;

  for (let L = maxLevel; L >= 1; L--) {
    const S = 1 << L;
    for (let r = 0; r + S <= QR; r += S) {
      for (let c = 0; c + S <= QC; c += S) {
        let ok = true;
        for (let rr = r; rr < r + S && ok; rr++) {
          for (let cc = c; cc < c + S; cc++) {
            // ⚠️ A BLOCK NEVER STRADDLES THE OPENING. One quad of hole inside a
            // 128 m block would either punch a 128 m void in the backdrop or
            // pave over the patch entirely.
            if (owner[rr * QC + cc] !== -1 || want[rr * QC + cc] < L || inHole(rr, cc)) {
              ok = false; break;
            }
          }
        }
        if (!ok) continue;
        for (let rr = r; rr < r + S; rr++) {
          for (let cc = c; cc < c + S; cc++) owner[rr * QC + cc] = L;
        }
        blocks.push({ r, c, s: S });
      }
    }
  }
  // Everything unclaimed is native, one quad each — including the strip left
  // over when the lattice is not a power of two, which 256 vertices never is.
  for (let r = 0; r < QR; r++) {
    for (let c = 0; c < QC; c++) {
      if (owner[r * QC + c] !== -1 || inHole(r, c)) continue;
      owner[r * QC + c] = 0;
      blocks.push({ r, c, s: 1 });
    }
  }

  // ── 4. triangulate, inserting a midpoint wherever the neighbour is finer ───
  const V = (r, c) => r * ncols + c;
  /** level of the block owning the quad just outside an edge, or -1 */
  const outside = (r, c) => (r < 0 || c < 0 || r >= QR || c >= QC)
    ? -1 : owner[r * QC + c];
  const idx = [];
  for (const b of blocks) {
    const { r, c, s } = b;
    const h = s >> 1;
    const r1 = r + s, c1 = c + s;
    if (s === 1) {
      // Native quad: the diagonal surface.js already uses, so a native block
      // here and a native quad there split the same way.
      idx.push(V(r, c), V(r + 1, c), V(r, c + 1));
      idx.push(V(r, c + 1), V(r + 1, c), V(r + 1, c + 1));
      continue;
    }
    const L = owner[r * QC + c];
    // Perimeter, clockwise in lattice terms, with midpoints where needed.
    const ring = [];
    const edge = (ar, ac, br, bc, probeR, probeC) => {
      ring.push([ar, ac]);
      const o = outside(probeR, probeC);
      if (o !== -1 && o < L) ring.push([(ar + br) >> 1, (ac + bc) >> 1]);
    };
    edge(r, c, r, c1, r - 1, c + h);            // north, probe above
    edge(r, c1, r1, c1, r + h, c1);             // east,  probe right
    edge(r1, c1, r1, c, r1, c + h);             // south, probe below
    edge(r1, c, r, c, r + h, c - 1);            // west,  probe left
    const centre = V(r + h, c + h);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], bb = ring[(i + 1) % ring.length];
      idx.push(centre, V(a[0], a[1]), V(bb[0], bb[1]));
    }
  }

  return {
    indices: Uint32Array.from(idx),
    triangles: idx.length / 3,
    levels: owner,
    blocks: blocks.length,
  };
}
