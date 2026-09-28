// @ts-check
/**
 * WHAT ARRIVES FROM OUTSIDE — the context tile as an INPUT rather than a
 * backdrop.
 *
 * Marc, 2026-09-02: "for now the context does not serve any other purpose than
 * giving a visual reference … could the context be activated to also create an
 * input?" and, of the graded mesh: "it would transport the message that things
 * like water are also coming from outside the patch — and that we can not just
 * look at it in an isolated manner."
 *
 * ⚠️⚠️ THE MESH COULD NEVER HAVE CARRIED THAT MESSAGE. Tessellation is not a
 * claim about flow. What says water arrives from outside is a NUMBER: how much
 * ground beyond the patch drains into it, and where it crosses the edge. This
 * file computes that, and it is the first thing in the tool that reads the
 * context for anything but drawing.
 *
 * ⚠️ IT IS A 4 m ANSWER, AND IT MUST BE REPORTED AS ONE. The national model
 * resolves 4 m; the patch is 0.25 m. So this describes the SURROUNDING LANDFORM
 * at the only resolution that exists for it — 16 × coarser than the ground the
 * designer is editing. That is not a defect to be smoothed over: it is finding
 * 1, the thing the whole instrument exists to demonstrate, appearing again on
 * the input side. An external catchment stated to the nearest square metre
 * would be a false precision; the readout rounds and says which grid it is on.
 *
 * ⚠️ AND IT IS NOT A PREDICTION. There is no rainfall, no infiltration, no
 * roughness, no culvert and no soil here. It is a statement about the shape of
 * the ground beyond the patch: which of it lies upslope, and where the steepest
 * path from it crosses the boundary. The tool must never use the word
 * "predicts", and this is exactly the layer that would tempt someone to.
 *
 * ⚠️⚠️ EVERY CELL TOUCHING THE TILE EDGE IS AN OUTLET, BY THE PROJECT'S OWN
 * D8 CONVENTION — `watershed.js` breaks out the moment a neighbour is off-tile,
 * whatever the ground does. So the border ring can never be counted as draining
 * in, and more importantly the ground BEYOND the tile is not in the data at all.
 * Where the external catchment reaches that edge the true catchment is larger
 * than anything measurable here, and `truncated` says so. The figure is then a
 * LOWER BOUND and the readout must not print it as an equality.
 *
 * ⚠️ FOUND BY A CONTROL THAT WAS WRONG, WHICH IS WORTH RECORDING. The first
 * tests asserted that a plane tilted southward drains its whole upslope half
 * into a band across the tile. It does not — not under this convention — and
 * the shortfall was exactly the border ring. The code was right and the
 * expectation was wrong; on a 20-cell test tile the border is 19% of the
 * ground, which is why it showed up so loudly there and would have been a
 * quiet 1.6% on the real 256² context.
 *
 * ⚠️ D8 FOR "DOES THIS DRAIN INTO THE PATCH", MFD FOR "HOW MUCH". The same
 * split network.js documents, for the same reason: membership of a catchment
 * needs ONE downstream neighbour per cell, and MFD does not give one. The AREA
 * reported per crossing is the Freeman accumulation, which is the better
 * physical model; the ROUTING that decides whether a cell belongs is D8.
 */

import { watersheds, OUTLET, NO_DATA } from "./watershed.js";
import { flowAccumulation } from "./mfd.js";

/**
 * @typedef {object} Crossing
 * @property {number} x @property {number} y   world, the OUTSIDE cell's centre
 * @property {number} areaM2   contributing area arriving there (MFD)
 * @property {string} side     "N" | "S" | "E" | "W"
 */

/**
 * @typedef {object} Inflow
 * @property {number} externalM2   ground OUTSIDE the patch that drains into it
 * @property {number} patchM2      the patch's own area, for the ratio
 * @property {number} ratio        externalM2 / patchM2
 * @property {number} cell         the grid this was measured on, in metres
 * @property {Crossing[]} crossings  ranked, largest first
 * @property {Uint8Array} external   1 where a context cell drains into the patch
 * @property {{r0:number,c0:number,r1:number,c1:number}} rect  patch, context cells
 * @property {boolean} truncated  the external catchment reaches the tile edge,
 *   so the figure is a LOWER BOUND — see the note on the border convention
 * @property {number} edgeCells   how many of its cells sit on that edge
 */

/**
 * Which ground outside the patch drains into it.
 *
 * @param {import("../dem.js").DEM} context  the coarse tile
 * @param {{r0:number,c0:number,r1:number,c1:number}} rect  the patch, in
 *   context cells, row-from-north — `DEM.nestHole(context, patch)`.
 * @returns {Inflow}
 */
export function externalInflow(context, rect) {
  const { nrows, ncols, cell } = context;
  const n = nrows * ncols;
  const ws = watersheds(context);
  const flow = flowAccumulation(context);
  const recv = ws.receiver;

  const inside = (i) => {
    const r = (i / ncols) | 0, c = i - r * ncols;
    return r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1;
  };

  /**
   * Does this cell's steepest-descent path reach the patch?
   *
   * ⚠️ MEMOISED AND ITERATIVE, NOT RECURSIVE. A flow path on a 256² tile can be
   * hundreds of cells long and there are 65 536 of them; the obvious recursion
   * blows the stack on the first real tile. The walk pushes its path onto a
   * list and writes the verdict back along it, so every cell is decided once.
   *
   * 0 = not yet known · 1 = drains in · 2 = does not
   */
  const mark = new Uint8Array(n);
  const path = [];
  for (let s = 0; s < n; s++) {
    if (mark[s] || inside(s)) continue;
    path.length = 0;
    let cur = s;
    let verdict = 2;
    // ⚠️ A GUARD ON THE WALK. Depressions are not filled in this project, so a
    // path ends in a pit rather than always reaching an edge — and a receiver
    // chain that ever cycled would spin here forever.
    for (let step = 0; step <= n; step++) {
      if (mark[cur]) { verdict = mark[cur]; break; }
      if (inside(cur)) { verdict = 1; break; }
      const r = recv[cur];
      if (r === OUTLET || r === NO_DATA || r < 0 || r === cur) { verdict = 2; break; }
      path.push(cur);
      mark[cur] = 3;              // on the current walk, so a cycle is visible
      cur = r;
      if (mark[cur] === 3) { verdict = 2; break; }
    }
    for (const i of path) mark[i] = /** @type {any} */ (verdict);
  }

  const external = new Uint8Array(n);
  let cells = 0;
  for (let i = 0; i < n; i++) {
    if (mark[i] === 1 && !inside(i)) { external[i] = 1; cells++; }
  }

  // ── where it crosses ───────────────────────────────────────────────────────
  // A crossing is an OUTSIDE cell whose own receiver is INSIDE: the last cell
  // of the outside world on that path. Its MFD accumulation is what arrives.
  /** @type {Crossing[]} */
  const crossings = [];
  for (let i = 0; i < n; i++) {
    if (!external[i]) continue;
    const r = recv[i];
    if (r < 0 || !inside(r)) continue;
    const row = (i / ncols) | 0, col = i - row * ncols;
    /**
     * ⚠️ THE SIDE IS WHERE THE CELL IS, NOT WHICH WAY THE WATER MOVES.
     * Written first from the flow direction — receiver further south therefore
     * "S" — which is two errors compounding: it names the direction of travel
     * rather than the edge crossed, and rows count from the NORTH so the sign
     * was inverted as well. It put the patch's largest inflow, a cell one
     * column WEST of the boundary, on the south side. Caught by checking a
     * printed coordinate against the patch extent rather than by reading it.
     *
     * ⚠️ A DIAGONAL CELL IS OUTSIDE ON TWO COUNTS, so the larger overshoot
     * wins — the edge it is furthest beyond is the one it comes over.
     */
    const dN = rect.r0 - row, dS = row - rect.r1;
    const dW = rect.c0 - col, dE = col - rect.c1;
    let side = "N", worst = dN;
    if (dS > worst) { side = "S"; worst = dS; }
    if (dW > worst) { side = "W"; worst = dW; }
    if (dE > worst) { side = "E"; worst = dE; }
    crossings.push({
      x: context.originX + (col + 0.5) * cell,
      y: context.originY + (nrows - row - 0.5) * cell,
      areaM2: flow.contributingArea[i],
      side,
    });
  }
  crossings.sort((a, b) => b.areaM2 - a.areaM2);

  // Does the external catchment run off the edge of what we have?
  let edgeCells = 0;
  for (let i = 0; i < n; i++) {
    if (!external[i]) continue;
    const r = (i / ncols) | 0, c = i - r * ncols;
    if (r === 0 || c === 0 || r === nrows - 1 || c === ncols - 1) edgeCells++;
  }

  const patchCells = (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1);
  const a = cell * cell;
  return {
    externalM2: cells * a,
    patchM2: patchCells * a,
    ratio: patchCells ? (cells / patchCells) : 0,
    cell,
    crossings,
    external,
    rect,
    truncated: edgeCells > 0,
    edgeCells,
  };
}
