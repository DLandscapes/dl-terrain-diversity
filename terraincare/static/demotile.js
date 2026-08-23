// @ts-check
// THE TILE THE TOOL OPENS ON — sixteen deformations on one continuous ground.
//
// Marc's brief, 2026-08-19, and the argument is his: the tool used to open on a
// perfectly flat plane or on a named Ørndalen patch, and BOTH were wrong for the
// first ten seconds. **Flat does not convey that this is about terrain at all** —
// every reading in the readout window is zero or undefined, so the instrument
// looks broken rather than empty. **A surveyed patch is too specific** — it
// reads as a tool about Ørndalen rather than a tool about ground, and the
// municipality's own proposal is not the subject of the first glance.
//
// So: one 64 m tile divided into a 4 × 4 grid, each cell carrying a DIFFERENT
// deformation, blended into one continuous surface. Every metric in the readout
// has something to report the moment it loads, and the twelve-pattern library —
// the thing Phase 7 measured — becomes the first thing anyone sees.
//
// ⚠️ IT KEEPS ØRNDALEN'S REAL GEOREFERENCE, AND THAT IS NOT LAZINESS. The Troms
// species envelopes and the 69.7° N solar geometry both follow from where the
// tile says it is. A fictional location silently invalidates the species model
// and the sun, and neither would announce it — they would simply return the
// wrong answer in the right units. The header is taken from the teaching tile
// rather than written down here, so there is exactly one place the site's
// coordinates live.
//
// ⚠️ THE PATTERNS ARE SUB-METRE AND THE BASE IS NOT. The whole claim of this
// project is that the relief which differentiates habitat sits BELOW the
// resolution of national terrain data. If the demo tile made its patterns metres
// deep it would quietly contradict the argument it exists to introduce. The base
// carries ~2.4 m of regional form so the thing reads as ground; the sixteen
// deformations are ±0.35 m, which is the scale the finding is about.

import { proceduralField, NEUTRAL, PATTERN_RANGE } from "./pattern.js";

/**
 * The sixteen cells, in reading order — left to right, top row first.
 *
 * ⚠️ THEY ARE THE RANGE, IN ORDER, AND THAT IS THE WHOLE POINT (Marc,
 * 2026-08-19). Sixteen arbitrary patterns would be a sampler. Sixteen taken in
 * order along `PATTERN_RANGE` is a GRADIENT: the top-left corner is the most
 * geometric and least consequential ground the library can make, the
 * bottom-right the most differentiating, and reading across the tile is reading
 * the argument the whole tool exists to make. Nothing has to be set up and
 * nothing has to be clicked.
 *
 * ⚠️ SIXTEEN OF EIGHTEEN, SAMPLED EVENLY, so the gradient keeps both ends. The
 * two it drops are interior — losing an end would flatten the very thing the
 * layout is for.
 *
 * ⚠️ THE MODULE IS CONSTANT ACROSS ALL SIXTEEN. It is tempting to vary it for
 * visual interest, and it would wreck the comparison: two cells would then
 * differ in BOTH pattern and scale, and no one could say which was doing the
 * work. Scale is the subject of its own experiment — see the landform-terracing
 * finding — and it does not belong loose in the demo tile.
 *
 * @type {{id: string, module: number, basis: string}[]}
 */
export const DEMO_PATCHES = (() => {
  const n = 16, N = PATTERN_RANGE.length;
  const out = [];
  for (let k = 0; k < n; k++) {
    const e = PATTERN_RANGE[Math.round((k * (N - 1)) / (n - 1))];
    out.push({ id: e.id, module: 8, basis: e.basis });
  }
  return out;
})();

/** How many cells the grid is divided into, per axis. */
export const DEMO_DIVISIONS = 4;

/**
 * Smoothstep, used as the BLEND parameter between neighbouring patches.
 *
 * ⚠️ NOT A LINEAR CROSS-FADE. Blending linearly between two fields is continuous
 * in height but not in slope, so every seam in the 4 × 4 grid would read as a
 * faint crease — and `geomorphons` would dutifully classify that crease as a
 * landform, putting sixteen straight ridges into the landform map that are
 * artefacts of the blend rather than features of the ground. Zero derivative at
 * both ends removes them.
 */
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * Build the heights for the opening tile.
 *
 * The base is a shallow trough falling gently to the south — enough regional
 * form that the tile reads as ground and that flow has somewhere to go, so TWI,
 * the watersheds and the ponding all have something true to say on load. It is
 * deliberately mild: the sixteen deformations are the subject.
 *
 * @param {number} nrows @param {number} ncols
 * @param {number} cell metres per cell
 * @param {{amplitude?: number, base?: number, relief?: number, fall?: number}} [opts]
 * @returns {{z: Float32Array, patches: {id:string, module:number, row:number, col:number}[]}}
 */
export function demoTileHeights(nrows, ncols, cell, opts = {}) {
  const amp = opts.amplitude ?? 0.35;      // ± metres, the deformations
  const base = opts.base ?? 75;            // the datum the teaching tile uses
  const relief = opts.relief ?? 1.2;       // depth of the trough, metres
  const fall = opts.fall ?? 1.2;           // fall from north to south, metres

  const n = nrows * ncols;
  const D = DEMO_DIVISIONS;

  // ⚠️ EACH FIELD IS GENERATED OVER THE WHOLE GRID, not over its own cell. A
  // field generated per-cell would have to be blended across a seam where the
  // two sides were built in different coordinate frames, and the pattern
  // generators are lattice-indexed — they give the same value for the same
  // world position however the window is placed, which is exactly the property
  // that makes a partition-of-unity blend produce one continuous surface.
  const fields = DEMO_PATCHES.map((p) =>
    proceduralField(p.id, nrows, ncols, cell, { module: p.module, seed: 1 }));

  const z = new Float32Array(n);
  for (let r = 0; r < nrows; r++) {
    // Patch coordinates: 0 at the tile's north/west edge, D at its south/east.
    const v = ((r + 0.5) / nrows) * D;
    const { i0: vi0, i1: vi1, t: vt } = span(v, D);
    const wv = smooth(vt);
    // North–south fall, and the trough's own axis runs the same way.
    const ny = (r + 0.5) / nrows;                 // 0 north … 1 south
    for (let c = 0; c < ncols; c++) {
      const u = ((c + 0.5) / ncols) * D;
      const { i0: ui0, i1: ui1, t: ut } = span(u, D);
      const wu = smooth(ut);
      const i = r * ncols + c;

      // Partition of unity over the four nearest patch cells: the weights sum
      // to 1 everywhere, so the amplitude is the same across a seam as it is at
      // a patch centre.
      let f = 0;
      f += (1 - wu) * (1 - wv) * fields[vi0 * D + ui0][i];
      f += wu * (1 - wv) * fields[vi0 * D + ui1][i];
      f += (1 - wu) * wv * fields[vi1 * D + ui0][i];
      f += wu * wv * fields[vi1 * D + ui1][i];

      // A shallow trough across the tile, deepest on the centre line.
      const cx = ((c + 0.5) / ncols) * 2 - 1;     // −1 west … +1 east
      z[i] = base - fall * ny + relief * cx * cx + amp * (f - NEUTRAL) * 2;
    }
  }

  const patches = DEMO_PATCHES.map((p, k) => ({
    ...p, row: Math.floor(k / D), col: k % D,
  }));
  return { z, patches };
}

/**
 * Which two patch cells a coordinate falls between, and how far.
 *
 * Patch centres sit at 0.5, 1.5, … so the outer half-cell at each edge has no
 * neighbour beyond it; there `i0 === i1` and the blend degenerates to that one
 * field, which is correct — the tile's own edge is not a seam.
 * @param {number} q position in patch units, 0..D
 * @param {number} D
 */
function span(q, D) {
  const s = q - 0.5;
  let i0 = Math.floor(s);
  let t = s - i0;
  if (i0 < 0) { i0 = 0; t = 0; }
  if (i0 >= D - 1) { i0 = D - 1; t = 0; }
  const i1 = Math.min(D - 1, i0 + 1);
  return { i0, i1, t };
}
