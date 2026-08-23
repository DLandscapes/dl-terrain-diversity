// @ts-check
// FILL AND SPILL — where a rainfall event actually ends up on this surface.
//
// Every other layer in this tool describes the ground's CAPACITY to do
// something: TWI says where moisture would tend to collect, the depression
// inventory says how much a hollow could hold. This one answers the question a
// designer and a municipality actually ask — put THIS much rain on THIS ground,
// and where is the water?
//
// ⚠️ WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT.
//
// It is not a flood model, not a hydraulic simulation, and not a prediction. No
// water is moved through time, nothing accelerates, there is no roughness
// coefficient, no wave, no momentum, and no rainfall–runoff calibration. Asked
// for a duration it would have no answer.
//
// What it computes is a purely GEOMETRIC statement about the surface: given a
// volume of water arriving with nowhere to go but downhill, and given that a
// closed hollow fills before it overflows, where does that volume come to rest?
// That is the same category of claim as TWI or a catchment area — a property of
// the shape, not a forecast of an event. The tool's standing rule holds here
// more than anywhere: a terrain analysis instrument. Not a prediction.
//
// THE METHOD is fill–spill–merge, in the sense of Barnes, Callaghan & Wickert
// (2020), riding on the priority flood that `findDepressions` already runs:
//
//   1. Rain lands on every cell and becomes a volume.
//   2. It runs downhill by steepest descent on the ground itself, with the
//      flood's own parent chain resolving the one case a gradient cannot — a
//      cell on a flat, where descent has no answer at all.
//   3. Reaching a depression, it stops and fills it. A partially filled hollow
//      is solved for its water LEVEL, so the pond has a horizontal surface
//      rather than a scaled copy of the ground beneath it.
//   4. Once a hollow is full it spills, and the excess carries on downstream
//      into whatever is below — which may be another hollow, which may itself
//      fill and spill, or may be the edge of the patch, where it leaves. The
//      overflow route is the parent chain, not descent: it is the only surface
//      on which "away from this full hollow" is a defined direction, since
//      descent out of a brim-full hollow leads straight back into it.
//
// ⚠️ SUB-BASIN STRUCTURE INSIDE ONE DEPRESSION IS NOT RESOLVED. `findDepressions`
// labels MAXIMAL depressions — hollows already merged at their common spill
// level — so a large hollow containing two small pits is treated as one water
// body, and a small amount of water in it is spread as one level rather than
// pooling separately in each pit. On this site that is a negligible
// simplification and the numbers say why: the design patch's 929 hollows hold
// 6.86 m³ between them, a mean of 7 litres each, so the median depression is a
// handful of 0.25 m cells with no interior structure to resolve. On coarser or
// gentler terrain it would matter, and the honest fix there is a full depression
// hierarchy rather than a fudge here.
//
// ⚠️ INFILTRATION IS A COEFFICIENT, NOT SOIL PHYSICS. There is no Richards
// equation here, no unsaturated conductivity and no antecedent moisture. Each
// substrate class carries one number: the fraction of incoming rain that soaks
// away rather than running off. It is a design assumption, stated on screen and
// exported with the run, and its purpose is to let the substrate SPECIFICATION
// change the hydrology — because on constructed ground it does, and because
// "leave it as crushed rock or specify a growing medium" is the decision this
// tool exists to make visible.

import { findDepressions } from "./indices.js";

/**
 * Fraction of incoming rain that infiltrates rather than running off, per
 * substrate class, indexed by the class codes in `substrate.js`.
 *
 * ⚠️ THESE ARE DESIGN ASSUMPTIONS, NOT MEASUREMENTS, and they are the author's
 * own — the same standing that the species envelopes carry, and they need the
 * same envelope review. They are ordered by the drainage property each class was
 * defined with (free / moderate / poor), which is the one hydrological fact the
 * vocabulary was cut along in the first place, so at minimum the ORDER is not
 * invented even where the values are approximate.
 *
 * bedrock 0.05 · rockfill 0.85 · gravel 0.70 · sand 0.55 · fines 0.25 ·
 * organic 0.35 · topsoil 0.50
 * @type {number[]}
 */
export const INFILTRATION = [0.05, 0.85, 0.70, 0.55, 0.25, 0.35, 0.50];

/** With no substrate map there is no basis for a figure, so nothing soaks away
 *  and the result is the surface's own behaviour on impermeable ground. Stated
 *  rather than defaulted to a plausible-looking middle value. */
export const NO_SUBSTRATE_INFILTRATION = 0;

/**
 * @typedef {Object} PondingResult
 * @property {Float32Array} depth       ponded water depth per cell, m (0 = dry)
 * @property {Float32Array} surface     water surface elevation where ponded, else NaN
 * @property {number} delivered         m³ of rain that landed on the patch
 * @property {number} infiltrated       m³ that soaked away
 * @property {number} retained          m³ standing on the surface at rest
 * @property {number} runoff            m³ that left across the patch edge
 * @property {number} retainedFraction  retained / (delivered − infiltrated)
 * @property {number} pondedCells       cells holding any water
 * @property {number} pondedArea        m²
 * @property {number} ponds             distinct water bodies holding water
 * @property {number} maxDepth          m
 * @property {number} capacity          m³ the surface could hold if saturated
 * @property {number} fullPonds         hollows filled to their spill point
 * @property {{label:number, index:number, row:number, col:number, cells:number,
 *             area:number, volume:number, capacity:number, fillFraction:number,
 *             full:boolean, maxDepth:number, meanDepth:number, level:number,
 *             x:number, y:number, z:number}[]} waterbodies
 *   every body actually holding water, largest first. Their volumes sum to
 *   `retained` exactly. Located at the deepest cell, which is always wet.
 */

/**
 * Route a rainfall depth over a surface and report where it comes to rest.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {number} rainfall_m depth of rain over the whole patch, metres
 * @param {{substrate?: Uint8Array|null, infiltration?: number[],
 *          depressions?: any}} [opts]
 * @returns {PondingResult}
 */
export function pondWater(dem, rainfall_m, opts = {}) {
  const { z, nrows, ncols, cell } = dem;
  const n = nrows * ncols;
  const area = cell * cell;
  const depth = new Float32Array(n);
  const surface = new Float32Array(n).fill(NaN);

  // The flood is reused when the caller already has it — a settle pass computes
  // it for the depression panel anyway, and running it twice per pass would
  // double the most expensive part of this layer for nothing.
  const dep = opts.depressions || findDepressions(dem);
  const { labels, filled, spillParent, depth: capacityDepth, depressions } = dep;

  const empty = {
    depth, surface, delivered: 0, infiltrated: 0, retained: 0, runoff: 0,
    retainedFraction: 0, pondedCells: 0, pondedArea: 0, ponds: 0, maxDepth: 0,
    capacity: dep.totalVolume, fullPonds: 0, unrouted: 0, outfalls: [],
    waterbodies: [],
  };
  if (!(rainfall_m > 0) || !depressions) return empty;

  // ── 1. what lands, and what soaks away ────────────────────────────────────
  const table = opts.infiltration || INFILTRATION;
  const sub = opts.substrate || null;
  const water = new Float64Array(n);   // m³ currently travelling with this cell
  let delivered = 0, infiltrated = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(z[i])) continue;
    const v = rainfall_m * area;
    delivered += v;
    // A substrate code outside the table — including UNKNOWN — infiltrates
    // nothing rather than taking a guessed middle value. Same rule the AR5
    // crosswalk follows for "constructed": absence of information is not a
    // licence to invent some.
    const f = sub && sub[i] < table.length ? table[sub[i]] : NO_SUBSTRATE_INFILTRATION;
    const soak = v * f;
    infiltrated += soak;
    water[i] = v - soak;
  }

  // ── 2. the depressions, and the cell each one spills through ──────────────
  const nDep = depressions.length;
  const byLabel = new Map();
  for (const d of depressions) byLabel.set(d.label, d);
  const inflow = new Float64Array(nDep + 1);
  const outlet = new Int32Array(nDep + 1).fill(-1);
  /** @type {Map<number, number[]>} */
  const cellsOf = new Map();
  for (let i = 0; i < n; i++) {
    const L = labels[i];
    if (!L) continue;
    let list = cellsOf.get(L);
    if (!list) { list = []; cellsOf.set(L, list); }
    list.push(i);
    // The cell whose own drainage parent lies OUTSIDE the depression is the one
    // the flood entered through, and therefore the one an overflow leaves by.
    const p = spillParent[i];
    if (outlet[L] === -1 && (p === -1 || labels[p] !== L)) outlet[L] = i;
  }

  // ── 3. where each cell's rain goes ────────────────────────────────────────
  //
  // ⚠️ THE FLOOD'S PARENT CHAIN IS THE WRONG DIRECTION FOR RAIN, and getting
  // this wrong is subtle enough to be worth stating plainly. `spillParent` is
  // the direction the flood came IN from, so following it always leads back out
  // to the boundary — it is the route an OVERFLOW takes when a full hollow
  // spills, and for that it is exactly right. Rain is the opposite problem:
  // it runs down the real surface, into hollows rather than out of them. Routed
  // on the parent chain alone, a hollow collects only the rain that lands
  // directly on it, and a bowl with a rim of level ground reports nearly empty.
  //
  // So rain follows STEEPEST DESCENT on the ground itself, and the parent chain
  // is kept only for the two cases descent cannot answer: a cell with no lower
  // neighbour at all, and the overflow route out of a full hollow.
  //
  // ⚠️ SINGLE-RECEIVER, WHERE THIS PROJECT OTHERWISE INSISTS ON MFD — the same
  // deliberate exception `watershed.js` takes, for the same reason. MFD splits a
  // cell's flow across up to eight neighbours, which is right for "how much
  // water passes here" and meaningless for "where does this parcel come to
  // rest". A volume settles in one hollow, not in a weighted eighth of eight.
  const receiver = new Int32Array(n).fill(-1);
  const DR = [-1, -1, -1, 0, 0, 1, 1, 1];
  const DC = [-1, 0, 1, -1, 1, -1, 0, 1];
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const i = r * ncols + c;
      const zi = z[i];
      if (!Number.isFinite(zi)) continue;
      let best = -1, bestSlope = 0;
      for (let m = 0; m < 8; m++) {
        const rr = r + DR[m], cc = c + DC[m];
        if (rr < 0 || rr >= nrows || cc < 0 || cc >= ncols) continue;
        const j = rr * ncols + cc;
        const zj = z[j];
        if (!Number.isFinite(zj)) continue;
        const drop = zi - zj;
        if (!(drop > 0)) continue;
        // Per unit distance, so a diagonal does not win on raw drop alone.
        const s = drop / (DR[m] && DC[m] ? Math.SQRT2 : 1);
        if (s > bestSlope) { bestSlope = s; best = j; }
      }
      // ⚠️ A CELL INSIDE A DEPRESSION IS A TERMINAL SINK, and it has to be said
      // explicitly rather than left to fall out. The tempting shortcut — "no
      // lower neighbour, so use the flood's parent" — is wrong for a pit in
      // exactly the way that is hardest to see: the flood reached the pit by
      // descending INTO it, so the pit's parent is UPHILL. Its receiver then
      // points back at a cell whose own steepest descent points at the pit, and
      // the two send water to each other forever. The topological pass below
      // never releases either of them and their water silently disappears —
      // measured, before this line existed, as 25 m³ vanishing from a 20 mm
      // event on the design patch, with no visible symptom anywhere.
      //
      // Making it a sink is also just correct: a depression settles as ONE body
      // at one level, so where inside it a drop arrives cannot matter.
      if (labels[i]) { receiver[i] = -1; continue; }
      // No lower neighbour and not in a hollow: a cell on a flat. The flood's
      // parent chain is the one direction defined there, because it resolves
      // flats by the order the flood reached them rather than by a gradient
      // that is zero. Outside a depression the parent is never uphill, so this
      // cannot reintroduce the cycle above.
      receiver[i] = best >= 0 ? best : spillParent[i];
    }
  }

  // ── 4. run the rain downhill, in exact topological order ──────────────────
  //
  // ⚠️ SORTING BY ELEVATION IS NOT GOOD ENOUGH HERE, and the case it fails on is
  // the one this whole tool is about. Ties in the sort key put a cell before the
  // cell it drains through, and its water is then handed to a neighbour that has
  // already passed everything on — so the volume is silently dropped. On rolling
  // ground that is a rare coincidence; on a surface LEVELLED TO A DATUM every
  // cell ties with every other, and the runoff figure would come out low on
  // precisely the case the argument rests on.
  //
  // So the receiver graph is walked as the forest it is: count each cell's
  // children, start from the cells nobody drains through, and release a cell
  // only once every one of its children has been handled. Exact whatever the
  // elevations do, and O(n) rather than O(n log n). It is a forest and not a
  // graph with cycles because elevation never increases along a step and
  // strictly decreases on every step that had a lower neighbour to take.
  const children = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const p = receiver[i];
    if (p >= 0) children[p]++;
  }
  const queue = new Int32Array(n);
  let qHead = 0, qTail = 0;
  for (let i = 0; i < n; i++) if (children[i] === 0) queue[qTail++] = i;

  let runoff = 0;
  /**
   * Where the water actually left, and how much went through each cell.
   *
   * ⚠️ THE ROUTING ALWAYS KNEW THIS AND THREW IT AWAY. Every parcel that leaves
   * does so through one identifiable cell on the edge, and collapsing all of
   * them into a single `runoff` total answers "how much left" while discarding
   * "from where" — which is the half a drainage engineer is actually held to.
   * An outfall is a thing that gets designed, consented and built; a runoff
   * figure is a number in a report.
   *
   * It also shows something the total cannot: levelling does not merely lose the
   * water, it CONCENTRATES it. A surveyed surface dribbles off along its whole
   * perimeter; a levelled one delivers everything through whichever point of the
   * edge happens to be lowest.
   * @type {Map<number, number>}
   */
  const exits = new Map();
  const leave = (cell, v) => {
    runoff += v;
    if (cell >= 0) exits.set(cell, (exits.get(cell) || 0) + v);
  };

  while (qHead < qTail) {
    const i = queue[qHead++];
    const p = receiver[i];
    if (Number.isFinite(z[i])) {
      const L = labels[i];
      const v = water[i];
      water[i] = 0;
      if (v > 0) {
        // A depression cell is a SINK in this pass. What it collects is settled
        // later, once the hollow's total is known — a hollow fills as one body,
        // so its cells cannot each decide independently what to pass on.
        if (L) inflow[L] += v;
        else if (p === -1) leave(i, v);
        else water[p] += v;
      }
    }
    // The parent is released once every child has been seen, water or not.
    if (p >= 0 && --children[p] === 0) queue[qTail++] = p;
  }

  // ⚠️ A LEAK DETECTOR, NOT A CORRECTION. If the receiver graph ever contains a
  // cycle again, the cells in it are never released and their water is simply
  // gone — and gone quietly, because a picture of ponds looks entirely
  // plausible while the total is short. Anything left holding water here is
  // swept to runoff so the books still balance, and counted separately so a
  // check can assert the count is zero rather than inferring it from a total
  // that has been made to add up.
  let unrouted = 0;
  for (let i = 0; i < n; i++) {
    if (water[i] > 0) { unrouted += water[i]; leave(i, water[i]); water[i] = 0; }
  }

  // ── 5. fill, spill, and cascade ───────────────────────────────────────────
  // Highest spill level first, so a hollow is solved only after everything that
  // could overflow into it already has.
  const bySpill = depressions.slice().sort((a, b) => b.spillZ - a.spillZ);
  const solved = new Uint8Array(nDep + 1);
  const full = new Uint8Array(nDep + 1);
  /** The total each hollow was last settled with, so a re-solve is triggered by
   *  water actually arriving rather than by a guess about whether it might. */
  const settledWith = new Float64Array(nDep + 1).fill(-1);
  /**
   * How much overflow each hollow has ALREADY passed downstream.
   *
   * ⚠️ Without this, a hollow that fills, spills, and is then handed more water
   * sends its whole excess again — the first spill counted twice. The volume
   * would not balance, and the error is in the direction that flatters the
   * surface, since the double-counted water is reported as leaving.
   */
  const sentExcess = new Float64Array(nDep + 1);

  /**
   * Send a volume downstream from a cell, into the first hollow it meets or off
   * the patch. A hollow already settled and FULL is passed straight through —
   * it has no room left, and its own excess has already gone the same way.
   * @returns {number} the label it landed in, or 0 for runoff
   */
  const sendFrom = (start, volume) => {
    let c = start, guard = 0, last = start;
    while (c >= 0 && guard++ < n) {
      last = c;
      const L = labels[c];
      if (L) {
        if (!solved[L] || !full[L]) { inflow[L] += volume; return L; }
        // Full and settled: step past it, out through its own outlet.
        const exit = outlet[L];
        c = exit >= 0 ? spillParent[exit] : -1;
        continue;
      }
      const p = spillParent[c];
      if (p === -1) break;
      c = p;
    }
    // An overflow that reaches the edge leaves through the last cell it stood
    // on, which is the outfall that spill is served by.
    leave(last, volume);
    return 0;
  };
  /** Did this label already settle, and has it since been given more water? */
  const needsResolve = (L) => L > 0 && solved[L] && inflow[L] > settledWith[L] + 1e-12;

  // A hollow that receives water after it was settled has to be settled again.
  // Only exact ties in spill elevation can cause it, so the loop converges at
  // once in practice; it is bounded rather than trusted.
  for (let pass = 0; pass < 4; pass++) {
    let again = false;
    for (const d of bySpill) {
      const L = d.label;
      if (solved[L] && !needsResolve(L)) continue;
      const total = inflow[L];
      const cells = cellsOf.get(L) || [];
      solved[L] = 1;
      settledWith[L] = total;

      if (total >= d.volume) {
        full[L] = 1;
        for (const j of cells) { depth[j] = capacityDepth[j]; surface[j] = filled[j]; }
        const excess = total - d.volume - sentExcess[L];
        sentExcess[L] = total - d.volume;
        if (excess > 1e-12) {
          const exit = outlet[L];
          const p = exit >= 0 ? spillParent[exit] : -1;
          if (p === -1) leave(exit, excess);
          else if (needsResolve(sendFrom(p, excess))) again = true;
        }
      } else {
        // Partially full: solve for the LEVEL that holds exactly this volume, so
        // the pond has a horizontal surface rather than a scaled copy of the
        // ground beneath it. Bisection rather than a closed form because the
        // depth–volume curve of a real hollow is whatever the ground happens to
        // be; 60 halvings take the bracket far below a micrometre.
        full[L] = 0;
        let loZ = d.minZ, hiZ = d.spillZ;
        for (let it = 0; it < 60; it++) {
          const mid = (loZ + hiZ) / 2;
          let v = 0;
          for (const j of cells) { const t = mid - z[j]; if (t > 0) v += t * area; }
          if (v > total) hiZ = mid; else loZ = mid;
        }
        const level = (loZ + hiZ) / 2;
        for (const j of cells) {
          const t = level - z[j];
          depth[j] = t > 0 ? t : 0;
          surface[j] = t > 0 ? level : NaN;
        }
      }
    }
    if (!again) break;
  }

  // ── 6. outfalls ───────────────────────────────────────────────────────────
  // ⚠️ CLUSTERED, NOT LISTED PER CELL. Water leaving over a broad low sill exits
  // through a run of adjacent cells, and reporting forty of them at a twentieth
  // of a cubic metre each would be true and useless — the reader needs the
  // handful of PLACES water leaves, not every cell it crossed on the way. Runs
  // of touching exit cells are merged and the volume summed; the cluster is
  // located at its own busiest cell, which is where a pipe would actually go.
  const outfalls = [];
  {
    const seen = new Set();
    const stack = [];
    for (const start of exits.keys()) {
      if (seen.has(start)) continue;
      seen.add(start);
      stack.length = 0; stack.push(start);
      let volume = 0, bestCell = start, bestV = -1, cells = 0;
      while (stack.length) {
        const i = stack.pop();
        const v = exits.get(i) || 0;
        volume += v; cells++;
        if (v > bestV) { bestV = v; bestCell = i; }
        const r = (i / ncols) | 0, c = i - r * ncols;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || rr >= nrows || cc < 0 || cc >= ncols) continue;
            const j = rr * ncols + cc;
            if (!exits.has(j) || seen.has(j)) continue;
            seen.add(j); stack.push(j);
          }
        }
      }
      const r = (bestCell / ncols) | 0, c = bestCell - r * ncols;
      outfalls.push({
        index: bestCell, row: r, col: c, cells, volume,
        x: dem.originX + (c + 0.5) * cell,
        y: dem.originY + nrows * cell - (r + 0.5) * cell,
        z: z[bestCell],
      });
    }
    outfalls.sort((a, b) => b.volume - a.volume);
  }

  // ── 7. the water bodies, one by one ───────────────────────────────────────
  //
  // ⚠️ THE PASS ALWAYS KNEW THIS AND THREW IT AWAY — the same omission the
  // outfalls had, and worth naming as a pattern rather than fixing twice in
  // silence. A count and a total ("2 ponds, 6.86 m³") answer how many and how
  // much altogether, and discard the distribution, which is the part a designer
  // is actually working on. Twenty hollows of a third of a cubic metre each and
  // one pond of six and a half are the same two numbers and completely
  // different ground: the first is a wet meadow, the second is a pond with a
  // dry field round it. Nothing extra is computed here — every figure below is
  // read off `depth`, which section 5 has already settled.
  //
  // ⚠️ A BODY IS LOCATED AT ITS DEEPEST CELL, not at its centroid. A hollow is
  // rarely convex and a centroid can land on dry ground outside the water
  // entirely — a label floating beside the pond it names. The deepest cell is
  // always wet, always inside, and is where the body reads as deepest, which is
  // where a person points when they say "that one".
  let retained = 0, pondedCells = 0, maxDepth = 0;
  const volOf = new Float64Array(nDep + 1);
  const heldCells = new Int32Array(nDep + 1);
  const deepestCell = new Int32Array(nDep + 1).fill(-1);
  const deepestDepth = new Float64Array(nDep + 1);
  for (let i = 0; i < n; i++) {
    const t = depth[i];
    if (!(t > 0)) continue;
    retained += t * area;
    pondedCells++;
    if (t > maxDepth) maxDepth = t;
    // Every ponded cell carries a label: section 5 only ever writes depth into
    // the cells of a depression, so the per-body volumes below sum to exactly
    // `retained` rather than to most of it.
    const L = labels[i];
    if (!L) continue;
    volOf[L] += t * area;
    heldCells[L]++;
    if (t > deepestDepth[L]) { deepestDepth[L] = t; deepestCell[L] = i; }
  }

  /** @type {any[]} */
  const waterbodies = [];
  let ponds = 0, fullPonds = 0;
  for (const d of depressions) {
    const L = d.label;
    const got = inflow[L];
    if (got > 0) ponds++;
    if (got >= d.volume && d.volume > 0) fullPonds++;
    // Holding water is the test, not having received it: a degenerate hollow of
    // no capacity is handed water and passes all of it on, and drawing a pin on
    // it would mark a body that is not there.
    if (!(volOf[L] > 0)) continue;
    const i = deepestCell[L];
    const r = (i / ncols) | 0, c = i - r * ncols;
    waterbodies.push({
      label: L, index: i, row: r, col: c,
      cells: heldCells[L], area: heldCells[L] * area,
      volume: volOf[L],
      capacity: d.volume,
      // How close this body is to spilling. The interesting ones on a designed
      // surface are the ones well short of 1 — a hollow that is full is doing no
      // more work, and the next millimetre of rain goes straight past it.
      fillFraction: d.volume > 0 ? Math.min(1, volOf[L] / d.volume) : 1,
      full: !!full[L],
      maxDepth: deepestDepth[L],
      meanDepth: volOf[L] / (heldCells[L] * area),
      level: surface[i],
      x: dem.originX + (c + 0.5) * cell,
      y: dem.originY + nrows * cell - (r + 0.5) * cell,
      z: z[i],
    });
  }
  waterbodies.sort((a, b) => b.volume - a.volume);

  const available = delivered - infiltrated;
  return {
    depth, surface, delivered, infiltrated, retained, runoff,
    retainedFraction: available > 0 ? retained / available : 0,
    pondedCells, pondedArea: pondedCells * area, ponds, maxDepth,
    capacity: dep.totalVolume, fullPonds, unrouted, outfalls, waterbodies,
  };
}

/**
 * The rainfall depth at which this surface's storage is exactly used up.
 *
 * ⚠️ THE MOST USEFUL SINGLE NUMBER THIS LAYER PRODUCES, and the one a
 * specification can be written against: below it the ground absorbs the event
 * into its own relief, above it the ground sheds. On a levelled surface it is
 * zero, which is the whole argument stated as one figure in millimetres rather
 * than as five separate collapses.
 *
 * This is the depth spread over the whole patch, so it ignores where the water
 * lands relative to where it can be stored — a hollow only fills from its own
 * catchment. It is therefore an UPPER bound on what the surface can absorb, and
 * `pondWater` measures the real figure.
 *
 * @param {number} capacity m³ of storage
 * @param {number} areaM2 m² of surface
 * @param {number} [infiltrationFraction]
 * @returns {number} metres of rainfall
 */
export function absorbedDepth(capacity, areaM2, infiltrationFraction = 0) {
  if (!(areaM2 > 0)) return 0;
  const f = Math.min(0.999, Math.max(0, infiltrationFraction));
  return capacity / areaM2 / (1 - f);
}
