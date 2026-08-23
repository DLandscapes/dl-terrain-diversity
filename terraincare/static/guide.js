// @ts-check
// GUIDE CURVES — the designer's line, and a section swept along it.
//
// The third of the four families in DESIGN-controlled-transformation.md, and
// the one that document calls "the missing primitive". The tool has plan
// REGIONS (areas) and SECTION LINES (readings). It has had no way to say "a
// swale runs along HERE, shaped like THIS, falling at THAT" — which is how
// landscape earthworks are actually specified.
//
// ⚠️ IT IS THE SAME GRAMMAR AS EVERYTHING ELSE HERE, and that is why it needed
// no new mathematics:
//
//     modifier = TARGET FIELD × MASK × TRANSITION
//
//     levelWithBatter =  a constant       × polygon ring    × batter at θ
//     benchTo         =  round(z/Δ)·Δ     × a rule mask     × riser
//     applyGuide      =  centreline + section × the corridor × batter at θ
//
// A guide curve simply supplies a target field expressed in the curve's OWN
// coordinates — station along the line, and signed offset across it — instead
// of the tile's XY or the terrain's elevation. Everything downstream is the
// batter's vocabulary: two angles and a datum.
//
// ⚠️ THREE DECISIONS, NOT ONE, and keeping them separate is the whole design.
// A swale, a contour bund and a road ditch can be the SAME line and the same
// cross-section, differing only in what the centreline does with height:
//
//   ALONG  (longitudinal)  level → a bund that infiltrates
//                          grade → a channel that conveys
//                          follow → a constant depth below existing ground
//   ACROSS (cross-section) swale / berm / road / ditch-and-bank
//   EDGE   (transition)    the batter, at the cut and fill angles
//
// Collapsing "along" into the section — which is the tempting simplification,
// because a swale "obviously" follows the ground — would silently remove the
// one control that decides whether the structure holds water or moves it. That
// is the difference between infiltration and conveyance, and it is a dropdown.
//
// ⚠️ WHAT THIS STILL MAY NOT SAY. A graded channel conveys water; this tool
// cannot state how fast. The ponding model is fill-and-spill geometry with no
// time in it, and stream power is a proxy for erosive force, never a velocity
// in m/s. The interface may report a gradient, a capacity and a volume. It must
// not print a speed. See DESIGN-controlled-transformation.md §4.

/**
 * The cross-sections, as functions of SIGNED offset from the centreline.
 *
 * ⚠️ SIGNED, NOT ABSOLUTE, because ditch-and-bank is not symmetric — it cuts on
 * one side and places the spoil on the other, which is the cheapest earthwork in
 * this list and the only one that can be made volume-neutral by construction.
 * Writing the profile against |d| would make that section unrepresentable and
 * the omission would not look like an omission.
 *
 * Each returns metres relative to the centreline datum: negative is cut below
 * it, positive is built above it. `halfWidth` is where the section ends and the
 * batter takes over.
 */
export const PROFILES = {
  swale: {
    label: "Swale — flat bottom, graded sides",
    note: "Cut. Holds water when run level, moves it when graded.",
    /** @param {{width:number, depth:number, sideDeg:number}} p */
    halfWidth: (p) => p.width / 2 + p.depth / Math.tan(rad(p.sideDeg)),
    dz: (d, p) => {
      const a = Math.abs(d), run = p.depth / Math.tan(rad(p.sideDeg));
      if (a <= p.width / 2) return -p.depth;
      if (a >= p.width / 2 + run) return 0;
      return -p.depth + (a - p.width / 2) * Math.tan(rad(p.sideDeg));
    },
  },
  berm: {
    label: "Berm — raised bank",
    note: "Fill. A bund across the fall line holds water behind it.",
    halfWidth: (p) => p.width / 2 + p.depth / Math.tan(rad(p.sideDeg)),
    dz: (d, p) => {
      const a = Math.abs(d), run = p.depth / Math.tan(rad(p.sideDeg));
      if (a <= p.width / 2) return p.depth;
      if (a >= p.width / 2 + run) return 0;
      return p.depth - (a - p.width / 2) * Math.tan(rad(p.sideDeg));
    },
  },
  road: {
    label: "Road — crowned platform",
    note: "A level running surface with a camber shedding to both edges.",
    halfWidth: (p) => p.width / 2,
    // The camber is stated as the FALL from crown to edge, which is how a road
    // cross-fall is specified, rather than as an angle nobody quotes.
    dz: (d, p) => {
      const a = Math.min(Math.abs(d), p.width / 2);
      return -(p.depth) * (a / (p.width / 2 || 1));
    },
  },
  ditchbank: {
    label: "Ditch and bank — cut one side, build the other",
    note: "The spoil from the ditch becomes the bank. Near volume-neutral.",
    halfWidth: (p) => p.width + p.depth / Math.tan(rad(p.sideDeg)),
    /**
     * ⚠️ THE BANK IS SIZED FROM THE DITCH, NOT SET SEPARATELY. A ditch-and-bank
     * whose bank is specified independently is two structures that happen to be
     * adjacent; sizing the bank to hold exactly what the ditch removes is what
     * makes the pair one earthwork and lets it be built without importing or
     * carting away. The two are equal-area trapezoids about their own centres,
     * so equal width and depth gives equal area.
     */
    dz: (d, p) => {
      const run = p.depth / Math.tan(rad(p.sideDeg));
      const half = p.width / 2;
      if (d < 0) {                                   // the ditch
        const a = -d;
        if (a <= half) return -p.depth;
        if (a >= half + run) return 0;
        return -p.depth + (a - half) * Math.tan(rad(p.sideDeg));
      }
      if (d <= half) return p.depth;                 // the bank
      if (d >= half + run) return 0;
      return p.depth - (d - half) * Math.tan(rad(p.sideDeg));
    },
  },
};

/**
 * What the centreline does with height along its length.
 *
 * ⚠️ THIS IS THE CONTROL THAT DECIDES WHAT THE STRUCTURE IS FOR, which is why
 * it is a first-class choice and not a checkbox on the section.
 */
export const ALONG = {
  follow: {
    label: "Follow the ground — constant depth below grade",
    note: "The structure keeps its shape and rides the existing landform.",
  },
  level: {
    label: "Level — one elevation end to end",
    note: "A contour structure. Water spreads and infiltrates rather than running.",
  },
  grade: {
    label: "Constant gradient — falls at a stated rate",
    note: "Conveyance. The line leaves the ground where the ground disagrees.",
  },
};

const rad = (deg) => (deg * Math.PI) / 180;

/**
 * Cumulative length along a polyline, and its total.
 * @param {number[][]} pts [[x, y], …] in map units
 */
export function stations(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) {
    s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { s, total: s[s.length - 1] || 0 };
}

/**
 * The nearest point on a polyline to (x, y), in the curve's own coordinates.
 *
 * ⚠️ THE NEAREST SEGMENT WINS, AND ON A CONCAVE BEND TWO OF THEM COMPETE. Where
 * a line turns back on itself the corridors of two segments overlap, and a cell
 * in the overlap has two perfectly valid stations. Taking the nearest point
 * resolves it the way the eye does — the structure is where its nearest edge is
 * — but it means the STATION jumps across the bisector of the bend, and under a
 * graded longitudinal profile that jump is a step in the target elevation. It is
 * small when the bend is gentle and it is real; `applyGuide` reports the worst
 * one so a designer can see it rather than discover it in the surface.
 *
 * @param {number[][]} pts @param {number[]} cum cumulative stations
 * @param {number} x @param {number} y
 * ⚠️ AND IT REPORTS WHEN A CELL IS PAST THE END OF THE LINE. Clamping t to
 * [0, 1] makes every cell project somewhere, so a cell 20 m beyond the last
 * vertex projects onto that vertex at a perfectly valid distance — which gives
 * the corridor ROUND CAPS, and sweeps the section around them into a bowl at
 * each end. A structure runs from its first point to its last; the ends are
 * square. Measured on a 57 m line across the POI patch: 151 cells of section
 * were being cut into two domes nobody asked for. `end` is −1 before the start,
 * +1 past the finish, 0 on the line. ⚠️ Only the OUTER ends count — t clamps at
 * a shared vertex on every bend, and those cells are legitimately in the
 * corridor.
 *
 * @returns {{s:number, d:number, signed:number, seg:number, end:number}}
 *   `d` is the perpendicular distance, `signed` is negative to the LEFT of the
 *   direction of travel and positive to the right.
 */
export function projectToPolyline(pts, cum, x, y) {
  let best = { s: 0, d: Infinity, signed: 0, seg: 0, end: 0 };
  const last = pts.length - 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const vx = x2 - x1, vy = y2 - y1;
    const L2 = vx * vx + vy * vy;
    if (L2 === 0) continue;
    const raw = ((x - x1) * vx + (y - y1) * vy) / L2;
    const t = Math.max(0, Math.min(1, raw));
    const px = x1 + t * vx, py = y1 + t * vy;
    const d = Math.hypot(x - px, y - py);
    if (d < best.d) {
      // The 2-D cross product's sign is which side of the direction of travel
      // the point lies on — the only thing that makes an asymmetric section
      // (ditch-and-bank) mean anything.
      const cross = vx * (y - y1) - vy * (x - x1);
      const end = (i === 0 && raw < 0) ? -1 : (i === last && raw > 1) ? 1 : 0;
      best = { s: cum[i] + t * Math.sqrt(L2), d, signed: cross < 0 ? -d : d, seg: i, end };
    }
  }
  return best;
}

/**
 * Sample the existing ground at a world point, bilinearly.
 * NaN off the grid or over a hole — a guide curve may not invent ground.
 * @param {import("./dem.js").DEM} dem
 */
export function groundAt(dem, x, y) {
  const { originX, originY, nrows, ncols, cell, z } = dem;
  const fx = (x - originX) / cell - 0.5;
  const fy = (originY + nrows * cell - y) / cell - 0.5;
  const c0 = Math.floor(fx), r0 = Math.floor(fy);
  const tx = fx - c0, ty = fy - r0;
  let sum = 0, w = 0;
  for (let dr = 0; dr <= 1; dr++) {
    for (let dc = 0; dc <= 1; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= nrows || c >= ncols) continue;
      const v = z[r * ncols + c];
      if (!Number.isFinite(v)) continue;
      const ww = (dr ? ty : 1 - ty) * (dc ? tx : 1 - tx);
      sum += v * ww; w += ww;
    }
  }
  return w > 0 ? sum / w : NaN;
}

/**
 * The centreline's elevation as a function of station.
 *
 * Returns a sampler plus the figures a designer needs to judge the line before
 * committing it: the fall, the gradient, and — for the graded case — how far the
 * line ends up from the ground it started on.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {number[][]} pts
 * @param {{along:string, gradient?:number, datum?:number, samples?:number}} opts
 *   `gradient` in metres per metre (0.01 = 1 %), positive falling forward.
 */
export function centreline(dem, pts, opts) {
  const { s: cum, total } = stations(pts);
  const n = Math.max(2, opts.samples ?? Math.max(2, Math.ceil(total / dem.cell)));
  const zs = new Float64Array(n), ss = new Float64Array(n), gs = new Float64Array(n);
  const at = (st) => {
    // Walk to the segment holding this station and interpolate the world point.
    let i = 0;
    while (i + 2 < pts.length && cum[i + 1] < st) i++;
    const seg = Math.max(0, Math.min(pts.length - 2, i));
    const L = cum[seg + 1] - cum[seg];
    const t = L > 0 ? (st - cum[seg]) / L : 0;
    return [
      pts[seg][0] + t * (pts[seg + 1][0] - pts[seg][0]),
      pts[seg][1] + t * (pts[seg + 1][1] - pts[seg][1]),
    ];
  };
  for (let k = 0; k < n; k++) {
    const st = (k / (n - 1)) * total;
    ss[k] = st;
    const [x, y] = at(st);
    gs[k] = groundAt(dem, x, y);
  }
  const startZ = Number.isFinite(opts.datum) ? /** @type {number} */ (opts.datum) : gs[0];

  for (let k = 0; k < n; k++) {
    if (opts.along === "level") zs[k] = startZ;
    else if (opts.along === "grade") zs[k] = startZ - (opts.gradient ?? 0) * ss[k];
    else zs[k] = gs[k];                       // follow
  }

  /** Elevation at an arbitrary station, by linear interpolation of the samples. */
  const z = (st) => {
    if (!(total > 0)) return zs[0];
    const f = Math.max(0, Math.min(1, st / total)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(f)), t = f - i;
    return zs[i] + t * (zs[i + 1] - zs[i]);
  };

  // ⚠️ HOW FAR THE DESIGN LINE IS FROM THE GROUND, reported rather than hidden.
  // A graded line on undulating ground must leave the surface — that is what a
  // gradient MEANS — and the cut and fill that follow are the real cost of the
  // decision. A tool that quietly clamped the line to the ground would be
  // drawing a different structure from the one that was asked for.
  let maxAbove = 0, maxBelow = 0;
  for (let k = 0; k < n; k++) {
    if (!Number.isFinite(gs[k])) continue;
    const dz = zs[k] - gs[k];
    if (dz > maxAbove) maxAbove = dz;
    if (-dz > maxBelow) maxBelow = -dz;
  }
  return {
    z, total, samples: n,
    startZ, endZ: zs[n - 1],
    fall: zs[0] - zs[n - 1],
    gradient: total > 0 ? (zs[0] - zs[n - 1]) / total : 0,
    maxAboveGround: maxAbove, maxBelowGround: maxBelow,
    groundStart: gs[0], groundEnd: gs[n - 1],
  };
}

/**
 * Sweep a cross-section along a guide curve.
 *
 * Follows `levelWithBatter`'s contract exactly — same option names, same
 * `dryRun`, same ledger accumulation, same "a hole in the DEM stays a hole", and
 * the same split of the report into the structure and its edge condition,
 * because those are priced and dug differently.
 *
 * ⚠️ THE BATTER IS COMPUTED FROM THE CORRIDOR, NOT FROM `batterTo`. That
 * function takes a SCALAR target and finds its run with a distance transform,
 * which is exactly right for a platform at one elevation and cannot express a
 * target that changes along the line. Here the perpendicular distance is already
 * known for every cell — it is the section's own coordinate — so the run is
 * `offset − halfWidth` directly, and it stays correct while the section's
 * elevation varies underneath it. Using the distance transform would have
 * required a feature transform (which mask cell is nearest) as well, to know
 * WHICH target to batter to.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {number[][]} pts the centreline, [[x, y], …] in map units
 * @param {{profile?:string, width?:number, depth?:number, sideDeg?:number,
 *          along?:string, gradient?:number, datum?:number,
 *          cutAngleDeg?:number, fillAngleDeg?:number, angleDeg?:number,
 *          dryRun?:boolean, ledger?:import("./brush.js").Ledger}} [opts]
 */
export function applyGuide(dem, pts, opts = {}) {
  const EMPTY = {
    section: { cut: 0, fill: 0, net: 0, cells: 0 },
    batter: { cut: 0, fill: 0, net: 0, cells: 0 },
    cut: 0, fill: 0, net: 0, cells: 0, mask: new Uint8Array(dem.nrows * dem.ncols),
    length: 0, halfWidth: 0, stationJump: 0, undaylit: 0, maxRunM: 0,
    r0: dem.nrows, c0: dem.ncols, r1: -1, c1: -1,
  };
  if (!pts || pts.length < 2) return EMPTY;

  const kind = PROFILES[opts.profile ?? "swale"] ? (opts.profile ?? "swale") : "swale";
  const P = PROFILES[kind];
  const p = {
    width: opts.width ?? 2,
    depth: opts.depth ?? 0.5,
    sideDeg: opts.sideDeg ?? 34,
  };
  const halfWidth = P.halfWidth(p);
  const cutDeg = opts.cutAngleDeg ?? opts.angleDeg ?? 45;
  const fillDeg = opts.fillAngleDeg ?? opts.angleDeg ?? 34;
  const vertCut = cutDeg >= 89.5, vertFill = fillDeg >= 89.5;
  const tanCut = vertCut ? Infinity : Math.tan(rad(cutDeg));
  const tanFill = vertFill ? Infinity : Math.tan(rad(fillDeg));

  const { s: cum, total } = stations(pts);
  const line = centreline(dem, pts, {
    along: opts.along ?? "follow", gradient: opts.gradient, datum: opts.datum,
  });

  const { nrows, ncols, cell, originX, originY, z } = dem;
  const northY = originY + nrows * cell;
  const area = cell * cell;

  // ⚠️ THE SCAN IS BOUNDED BY THE CURVE, NOT BY THE TILE. A 12 m swale on a
  // 256² grid should not cost a full-grid sweep. The band is the section's own
  // half-width plus the furthest a batter could possibly run, which is the
  // tile's whole relief divided by the shallower of the two angles — a real
  // bound rather than a guessed margin.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < z.length; i++) {
    const v = z[i];
    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  const relief = Number.isFinite(hi - lo) ? hi - lo : 0;
  const softest = Math.min(vertCut ? Infinity : tanCut, vertFill ? Infinity : tanFill);
  const reach = Number.isFinite(softest) && softest > 0
    ? relief / softest + cell : cell;
  const band = halfWidth + reach;

  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const [x, y] of pts) {
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  const rowLo = Math.max(0, Math.floor((northY - (ymax + band)) / cell));
  const rowHi = Math.min(nrows - 1, Math.ceil((northY - (ymin - band)) / cell));
  const colLo = Math.max(0, Math.floor(((xmin - band) - originX) / cell));
  const colHi = Math.min(ncols - 1, Math.ceil(((xmax + band) - originX) / cell));

  const mask = new Uint8Array(nrows * ncols);
  let secCut = 0, secFill = 0, secCells = 0;
  let batCut = 0, batFill = 0, batCells = 0;
  let r0 = nrows, c0 = ncols, r1 = -1, c1 = -1;
  let stationJump = 0;
  /** batter cells still moving ground at the limit of the search band */
  let undaylit = 0;
  /** furthest the batter ran, metres */
  let maxRun = 0;

  for (let r = rowLo; r <= rowHi; r++) {
    const y = northY - (r + 0.5) * cell;
    for (let c = colLo; c <= colHi; c++) {
      const i = r * ncols + c;
      const zi = z[i];
      if (!Number.isFinite(zi)) continue;        // a hole in the DEM stays a hole
      const x = originX + (c + 0.5) * cell;
      const pr = projectToPolyline(pts, cum, x, y);
      if (pr.d > band) continue;
      // ⚠️ SQUARE ENDS. A cell past the first or last vertex is not on the
      // structure, however close it is to the endpoint — see projectToPolyline.
      if (pr.end !== 0) continue;

      const zc = line.z(pr.s);
      if (!Number.isFinite(zc)) continue;

      let target;
      if (pr.d <= halfWidth) {
        target = zc + P.dz(pr.signed, p);
        mask[i] = 1;
      } else {
        // The batter, run from the section's own outer edge at THIS station.
        const edge = zc + P.dz(pr.signed < 0 ? -halfWidth : halfWidth, p);
        const run = pr.d - halfWidth;
        if (zi > edge) {
          if (vertCut) continue;
          target = Math.min(zi, edge + run * tanCut);
        } else if (zi < edge) {
          if (vertFill) continue;
          target = Math.max(zi, edge - run * tanFill);
        } else continue;
        // ⚠️ A BATTER ON GROUND STEEPER THAN ITS OWN ANGLE NEVER DAYLIGHTS, and
        // that is not a rounding matter — it is the difference between a 12 m³
        // edge and one that runs to the boundary of the tile. An embankment
        // falls at its repose angle; where the ground falls faster, the two
        // never meet and the fill goes on for ever. MEASURED on the POI patch:
        // a swale along a contour reported a 690 m³ batter over 9 591 cells
        // against a 107 m³ section, reaching the tile edge. The arithmetic was
        // right and the design was undrawable, which is exactly the thing a
        // designer has to be told rather than charged for.
        // ⚠️ "STILL OPEN" MEANS IT RAN OFF THE TILE, not that it reached the
        // search band. The band is sized from the relief and is routinely wider
        // than the tile itself, so testing against it never fires — which is how
        // this check first passed on 50° ground with zero cells reported. The
        // observable fact is the one to test: the batter was still moving ground
        // when it reached the edge of the survey, so nobody knows where it ends.
        if (Math.abs(target - zi) > 1e-9) {
          if (r === 0 || c === 0 || r === nrows - 1 || c === ncols - 1) undaylit++;
          if (run > maxRun) maxRun = run;
        }
      }

      const dz = target - zi;
      if (dz === 0) continue;
      if (pr.d <= halfWidth) {
        if (dz > 0) secFill += dz * area; else secCut += -dz * area;
        secCells++;
      } else {
        if (dz > 0) batFill += dz * area; else batCut += -dz * area;
        batCells++;
      }
      if (!opts.dryRun) z[i] = target;
      if (r < r0) r0 = r; if (r > r1) r1 = r;
      if (c < c0) c0 = c; if (c > c1) c1 = c;
    }
  }

  // ⚠️ THE WORST STATION JUMP ON A CONCAVE BEND, measured along the section's
  // own edge rather than asserted to be small. Under a graded longitudinal
  // profile this is a step in the target elevation, and a designer should be
  // told the size of it — a tight bend on a steep grade is a real discontinuity
  // in the structure, not a rendering artefact.
  if (pts.length > 2) {
    // Sampled in a ring around each interior vertex, at the section's outer
    // edge — the radius where the two segments' corridors actually meet. The
    // largest difference in TARGET ELEVATION between neighbouring samples is
    // the step the surface will carry.
    const N = 72;
    for (let v = 1; v + 1 < pts.length; v++) {
      const [vx, vy] = pts[v];
      let prev = null;
      for (let k = 0; k <= N; k++) {
        const th = (k / N) * Math.PI * 2;
        const pr = projectToPolyline(
          pts, cum, vx + Math.cos(th) * halfWidth, vy + Math.sin(th) * halfWidth);
        const zc = line.z(pr.s);
        if (prev !== null && Number.isFinite(zc) && Number.isFinite(prev)) {
          stationJump = Math.max(stationJump, Math.abs(zc - prev));
        }
        prev = zc;
      }
    }
  }

  const res = {
    section: { cut: secCut, fill: secFill, net: secFill - secCut, cells: secCells },
    batter: { cut: batCut, fill: batFill, net: batFill - batCut, cells: batCells },
    cut: secCut + batCut,
    fill: secFill + batFill,
    net: (secFill + batFill) - (secCut + batCut),
    cells: secCells + batCells,
    mask, length: total, halfWidth, profile: kind, line, stationJump,
    undaylit, maxRunM: maxRun,
    r0, c0, r1, c1,
  };
  if (opts.ledger && !opts.dryRun) {
    opts.ledger.cut += res.cut; opts.ledger.fill += res.fill;
  }
  return res;
}
