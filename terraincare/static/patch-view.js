// @ts-check
// THE LANDFORM PATCHWORK, DRAWN — each workable patch outlined, each with its
// terrace line as a short tick.
//
// Step B of DESIGN-landform-terracing.md made the partition computable;
// Phase 8E measured it and found the strongest result the project has. This
// module makes it VISIBLE, because "the two largest spurs bear 131° and 334°"
// is a sentence until the two ticks are on the ground pointing different
// ways — the patchwork is the picture the finding needs.
//
// Follows the conventions selection-view.js set, for the same reasons: local
// geometry with the UTM origin on the group transform, depth test off, the
// exaggeration on the group's z scale, and every boundary endpoint draped on
// the GRID CORNER it sits on (the bilinear height) so the outline closes in
// 3-D instead of breaking into the floating staircase Phase 8D measured.
//
// ⚠️ ONLY THE WORKABLE PATCHES ARE DRAWN, AND THE SEAM ONLY WHERE TWO OF THEM
// MEET. The POI patch partitions into 4 870 patches of which 102 carry 64
// cells or more; the rest is speckle — real classification, not terrace
// units. Drawing every speck's rim would bury the patchwork in exactly the
// ink the selection outline once buried the selection in. So a side is drawn
// only where two patches ABOVE the size threshold meet; where a workable
// patch borders speckle the line simply stops, which is honest — there is no
// worked seam there to draw. The partition itself is untouched: patches.js
// reports every patch, and the experiment benches every patch. The threshold
// here decides what is DRAWN, nothing else.
//
// ⚠️ THE TICK IS THE TERRACE LINE, NOT THE FALL LINE. A patch's bearingDeg is
// the slope-weighted mean ASPECT — the direction the ground faces, straight
// downslope. A terrace follows the contour, at right angles to that, so the
// tick is drawn perpendicular to the stored bearing. It is a LINE, not an
// arrow: a terrace direction is a direction modulo 180°, and an arrowhead
// would claim a sense the geometry does not have.
//
// ⚠️ THE TICK'S LENGTH CARRIES THE BEARING'S CONCENTRATION. A concentration
// near 1 means one bearing serves the whole patch and the tick is drawn at
// full length; a patch that wraps a nose has no single direction, and its
// tick shrinks toward a dot rather than confidently pointing somewhere the
// ground disagrees with. A NaN bearing (a flat patch — no direction exists)
// draws no tick at all, the same convention the aspect layer and the patch
// statistics already keep.

import * as THREE from "three";
// ⚠️ THE CONTOURS' OWN SAMPLER, deliberately reused rather than reimplemented.
// `facetZAt` interpolates inside the triangle the renderer shades, which is
// what puts a line IN the mesh instead of over a bilinear surface nobody draws
// — see the lattice note in contours.js. A second copy of that arithmetic is
// how an overlay and the surface it sits on drift apart.
import { facetZAt } from "./section.js";

const INK = 0x000000;

export class PatchOverlay {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number, minCells?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.minCells = opts.minCells ?? 64;
    this.group = new THREE.Group();
    this.group.position.set(dem.originX, dem.originY, 0);
    this.group.scale.set(1, 1, opts.verticalExaggeration ?? 1);
    this.group.renderOrder = 13;   // under the selection outline: a selection
                                   // is an instruction, the patchwork a reading
    this.group.visible = false;
    // The seam recedes, the ticks speak: the boundary at about half ink so
    // the layer underneath stays legible through it, the ticks at full ink
    // because they are the one figure each patch states.
    this._seamMat = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.45,
      depthTest: false, depthWrite: false, fog: false,
    });
    this._tickMat = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.95,
      depthTest: false, depthWrite: false, fog: false,
    });
    /** @type {Int32Array|null} */ this._labels = null;
    /** @type {any[]|null} */ this._patches = null;
    /** boundary segments drawn by the last drape, for the self-test */
    this.count = 0;
    /** ticks drawn by the last drape, for the self-test */
    this.tickCount = 0;
    /** cell sides the boundary was traced from, before smoothing */
    this.sideCount = 0;
    // ⚠️ THE CACHED TRACE (data) AND THE DRAWN OBJECTS (three.js) ARE DIFFERENT
    // THINGS, and they are named apart on purpose: `_outline`/`_ticks` are the
    // partition's own geometry in local XY and survive every edit, while
    // `_seam`/`_tickLine` are the meshes hung on the current ground and are
    // disposed on every drape. Sharing one name for both is how a re-drape
    // ends up disposing the thing it is about to draw from.
    /** @type {{closed:boolean, pts:number[][]}[]|null} */ this._outline = null;
    /** @type {any[]|null} */ this._ticks = null;
    this._seam = null;
    this._tickLine = null;
  }

  /** @param {number} v */
  setExaggeration(v) { this.group.scale.z = v; }
  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  _clear() {
    for (const key of ["_seam", "_tickLine"]) {
      const obj = this[key];
      if (obj) {
        this.group.remove(obj);
        obj.geometry.dispose();
        this[key] = null;
      }
    }
    this.count = 0;
    this.tickCount = 0;
  }

  /**
   * Draw a partition.
   * @param {Int32Array|null} labels one entry per grid point, as dem.z
   * @param {any[]|null} patches the measured patches the labels index
   */
  setPartition(labels, patches) {
    this._labels = labels || null;
    this._patches = patches || null;
    this._trace();     // the expensive half: chains, smoothing, tick anchors
    this._drape();     // the cheap half: hang it on the ground as it stands
  }

  /**
   * Re-drape the CURRENT partition onto the surface as it now stands.
   *
   * ⚠️ THE PARTITION IS NOT RE-EVALUATED — the same contract as the selection
   * outline, for the same reason. The landform map is a reading of the
   * surface, so recomputing it after an edit gives different patches; doing
   * that unasked would silently redraw the patchwork behind the designer's
   * back mid-design. What moved is the ground under the lines; only the
   * drape is rebuilt, and asking for the partition again stays a click.
   *
   * ⚠️ AND THAT IS WHY THE TRACE IS CACHED. `refreshSurfaceOverlays` calls this
   * on EVERY edit, throttled to 50 ms during a stroke. Tracing, chaining and
   * corner-cutting the POI patch's boundary measures ~570 ms, so re-running it
   * per refresh would have made the tool unusable the moment the patchwork was
   * shown — a brush stroke costing half a second a frame. The chains and their
   * smoothed XY are a function of the PARTITION, which by the contract above
   * does not change here; only z does. So the geometry is traced once in
   * `setPartition` and merely re-hung on the ground here.
   */
  refresh() { this._drape(); }

  /**
   * The expensive half: cell sides → chains → smoothed XY, plus each tick's
   * anchor cell. All of it a function of the labels alone, so it survives every
   * edit until the partition is asked for again.
   */
  _trace() {
    const labels = this._labels, patches = this._patches;
    this._outline = null;
    this._ticks = null;
    if (!labels || !patches) return;
    const { nrows, ncols, cell, z } = this.dem;
    const northY = nrows * cell;
    const half = cell / 2;
    const lift = Math.max(cell * 0.02, 0.005);

    // ⚠️ THE SURFACE'S OWN CONVENTION, deliberately: cell (r,c) is centred at
    // ((c+0.5)·cell, northY−(r+0.5)·cell) — the placement surface.js, brush.js,
    // ponding.js and the exporters all share — so the NW corner of cell (R,C)
    // sits at (C·cell, northY−R·cell) and the patchwork registers with the
    // terrain it partitions. (selection-view.js put its lattice half a cell
    // from this until 2026-08-13; both modules now share this lattice.)
    const px = (C) => C * cell;
    const py = (R) => northY - R * cell;

    // Which ids are workable — drawn — at this size threshold.
    const keep = new Uint8Array(patches.length + 1);
    for (const p of patches) if (p.cells >= this.minCells) keep[p.id] = 1;

    // ⚠️ NO cornerZ HERE ANY MORE. The selection outline drapes on grid corners
    // because it runs ON the lattice and every endpoint IS a corner; a smoothed
    // boundary has vertices between corners, so it is sampled on the facets
    // instead — see the projection note below.
    // ⚠️ THE BOUNDARY IS TRACED, SMOOTHED AND RE-PROJECTED — it is no longer
    // drawn straight off the cell lattice (2026-08-13, Marc: "the outlines of
    // the patches are still jaggery — which is understandable as these are the
    // mesh edge faces, but could we rebuild these boundaries and project them
    // back onto the mesh… like the contour lines do").
    //
    // A staircase is what a per-cell partition gives, and at 0.25 m it reads as
    // noise rather than as a landform. So the sides are collected as corner
    // pairs first, chained into polylines, corner-cut, and only then sampled
    // onto the SURFACE'S OWN FACETS — the same last step `contourSegments`
    // takes, which is why a contour lies in the mesh instead of floating over
    // it.
    //
    // ⚠️ SMOOTHING IS A DRAWING DECISION AND CHANGES NO MEASUREMENT. The
    // partition, its patch statistics and the uniform-vs-patch experiment all
    // still run on the per-cell labels; this is the line's appearance only,
    // and the status line says so. Cartographic generalisation, stated rather
    // than silent.
    //
    // ⚠️ CHAINS BREAK AT JUNCTIONS, and that is what keeps the topology honest.
    // Where three regions meet, a corner carries three segment ends; smoothing
    // through such a point would pull the shared boundary of two patches away
    // from the boundary of the third and open a gap that was never in the data.
    // Junction corners are therefore pinned, and each arc between them is
    // smoothed on its own.
    const cornerKey = (R, C) => R * (ncols + 1) + C;
    /** @type {number[][]} each entry [keyA, keyB] */
    const sides = [];
    const seg = (R0, C0, R1, C1) => {
      sides.push([cornerKey(R0, C0), cornerKey(R1, C1)]);
    };

    // ⚠️⚠️ EVERY WORKABLE PATCH GETS A CLOSED OUTLINE (2026-08-13). The first
    // rule drew a side only where TWO workable patches met. That has three
    // consequences and Marc found all three by eye on one screenshot:
    //
    //   - a patch surrounded by speckle got NO outline at all while still
    //     getting its tick, so the tick lay on bare ground as a stray mark;
    //   - a patch bordering speckle had its outline STOP mid-run, so no
    //     boundary ever closed;
    //   - only interior sides were tested, so a patch running off the survey
    //     was open along the tile edge as well.
    //
    // The rule is now the one selection-view.js already uses and which closes
    // by construction: draw a side wherever what is DRAWN on one side differs
    // from what is drawn on the other, with speckle and the world beyond the
    // grid both counting as nothing. A patch is a shape again, a speck becomes
    // a hole with its own rim, and a tick can no longer appear without the
    // patch it belongs to. ⚠️ Each side is still visited once — a cell tests
    // only its north and west neighbours — so a shared boundary is one
    // segment, not the same segment drawn from both of its cells.
    /** what is drawn at a cell: its patch if workable, otherwise nothing */
    const drawn = (i) => { const id = labels[i]; return id && keep[id] ? id : 0; };
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        const a = drawn(r * ncols + c);
        if (a !== (r > 0 ? drawn((r - 1) * ncols + c) : 0)) seg(r, c, r, c + 1);
        if (a !== (c > 0 ? drawn(r * ncols + c - 1) : 0)) seg(r, c, r + 1, c);
        // ⚠️ THE LAST ROW AND COLUMN OWN THEIR FAR SIDES. No cell beyond them
        // will ever test those, and without this every patch touching the
        // edge of the survey stays open along it.
        if (r === nrows - 1 && a) seg(r + 1, c, r + 1, c + 1);
        if (c === ncols - 1 && a) seg(r, c + 1, r + 1, c + 1);
      }
    }
    // ── chain the sides into polylines, breaking at junctions ───────────────
    /** @type {Map<number, number[]>} corner key → indices into `sides` */
    const inc = new Map();
    sides.forEach(([a, b], i) => {
      if (!inc.has(a)) inc.set(a, []);
      if (!inc.has(b)) inc.set(b, []);
      inc.get(a).push(i); inc.get(b).push(i);
    });
    const used = new Uint8Array(sides.length);
    /** @type {number[][]} polylines, as corner keys */
    const chains = [];
    /** Walk from `key` along `si`, stopping at any corner that is not simple. */
    const walk = (key, si) => {
      const chain = [key];
      let at = key, s = si;
      for (;;) {
        used[s] = 1;
        const [a, b] = sides[s];
        at = a === at ? b : a;
        chain.push(at);
        const next = (inc.get(at) || []).filter((k) => !used[k]);
        // Degree 2 means exactly one way onward; anything else is a junction
        // or an end, and the chain stops there so the corner stays pinned.
        if ((inc.get(at) || []).length !== 2 || next.length !== 1) break;
        s = next[0];
      }
      return chain;
    };
    // Junctions and ends first, so every arc between them is found as an arc…
    for (const [key, list] of inc) {
      if (list.length === 2) continue;
      for (const si of list) if (!used[si]) chains.push(walk(key, si));
    }
    // …and whatever is left is a pure closed ring with no junction on it.
    for (let i = 0; i < sides.length; i++) {
      if (!used[i]) chains.push(walk(sides[i][0], i));
    }

    // ── corner-cutting, and the ring case ───────────────────────────────────
    // Chaikin: each pass replaces every span by its quarter and three-quarter
    // points, which halves the turn at every corner. Two passes take a
    // right-angled staircase to a visibly rounded line without pulling it more
    // than half a cell off the cells it describes.
    const PASSES = 2;
    const keyXY = (k) => {
      const R = Math.floor(k / (ncols + 1));
      return [px(k - R * (ncols + 1)), py(R)];
    };
    const chaikin = (pts, closed) => {
      let cur = pts;
      for (let p = 0; p < PASSES; p++) {
        const out = [];
        if (!closed) out.push(cur[0]);
        const n = cur.length;
        const last = closed ? n : n - 1;
        for (let i = 0; i < last; i++) {
          const a = cur[i], b = cur[(i + 1) % n];
          out.push([a[0] + (b[0] - a[0]) * 0.25, a[1] + (b[1] - a[1]) * 0.25]);
          out.push([a[0] + (b[0] - a[0]) * 0.75, a[1] + (b[1] - a[1]) * 0.75]);
        }
        if (!closed) out.push(cur[n - 1]);
        cur = out;
      }
      return cur;
    };

    // The smoothed outline, in LOCAL XY and independent of the ground.
    /** @type {{closed:boolean, pts:number[][]}[]} */
    this._outline = [];
    for (const chain of chains) {
      const closedRing = chain.length > 2 && chain[0] === chain[chain.length - 1];
      const raw = (closedRing ? chain.slice(0, -1) : chain).map(keyXY);
      if (raw.length < 2) continue;
      this._outline.push({ closed: closedRing, pts: chaikin(raw, closedRing) });
    }
    /** cell sides the boundary was traced from, before smoothing — for checks */
    this.sideCount = sides.length;

    // The ticks: one per workable patch with a bearing, along the CONTOUR
    // (bearing + 90°), length from the patch's size scaled by the bearing's
    // concentration. Anchor and direction are properties of the partition, so
    // they are computed here; only the height is left to the drape.
    /** @type {{r:number, c:number, x:number, y:number, tx:number, ty:number, L:number}[]} */
    this._ticks = [];
    for (const p of patches) {
      if (!keep[p.id] || !Number.isFinite(p.bearingDeg)) continue;
      const th = (p.bearingDeg * Math.PI) / 180;
      // Aspect points downslope: (sin θ east, cos θ north). The terrace line
      // is perpendicular: rotate a quarter turn.
      const tx = Math.cos(th), ty = -Math.sin(th);
      const L = Math.min(20 * cell, Math.max(4 * cell, 0.15 * Math.sqrt(p.area)))
        * Math.max(0.15, p.bearingConcentration);
      // ⚠️⚠️ THE TICK STANDS ON THE PATCH, NOT ON ITS CENTROID (2026-08-13,
      // Marc: "the random lines are still visible"). A centroid is a mean, and
      // the mean of a crescent, a ring or an L is OUTSIDE the shape — so on a
      // landform map, where hollows wrap spurs constantly, ticks were landing
      // on ground belonging to no patch at all and reading as stray marks. The
      // earlier note here called that acceptable; it is not, because a mark
      // that is not on the thing it describes is indistinguishable from noise.
      //
      // The anchor is now the patch cell NEAREST the centroid, which is inside
      // by construction and is still the patch's stated position wherever the
      // shape is convex enough for the centroid to be its own answer. Searched
      // within the patch's own bounding box, which patches.js already reports.
      // ⚠️ THE BOX IS AN OPTIMISATION, NOT A REQUIREMENT. `landformPatches`
      // always reports r0..c1, but a caller that omits them would otherwise
      // hand this loop NaN bounds, which iterates zero times and drops EVERY
      // tick — silently, with the outlines still drawn, so the patchwork just
      // looks like it has no bearings. Falling back to the whole grid is one
      // line and turns a silent wrong answer into a slow right one.
      let rr = -1, cc = -1, best = Infinity;
      const tc = p.x / cell, tr = nrows - p.y / cell;   // centroid in cell units
      const r0 = Number.isFinite(p.r0) ? p.r0 : 0;
      const r1 = Number.isFinite(p.r1) ? p.r1 : nrows - 1;
      const c0 = Number.isFinite(p.c0) ? p.c0 : 0;
      const c1 = Number.isFinite(p.c1) ? p.c1 : ncols - 1;
      for (let r = Math.max(0, r0); r <= Math.min(nrows - 1, r1); r++) {
        for (let c = Math.max(0, c0); c <= Math.min(ncols - 1, c1); c++) {
          if (labels[r * ncols + c] !== p.id) continue;
          const d = (r + 0.5 - tr) ** 2 + (c + 0.5 - tc) ** 2;
          if (d < best) { best = d; rr = r; cc = c; }
        }
      }
      if (rr < 0) continue;                    // no cell carries this id
      this._ticks.push({
        r: rr, c: cc, tx, ty, L,
        x: (cc + 0.5) * cell, y: northY - (rr + 0.5) * cell,
      });
    }
  }

  /**
   * The cheap half: hang the cached geometry on the ground as it now stands.
   * Runs on every edit; must stay proportional to the line work, never to the
   * grid.
   */
  _drape() {
    this._clear();
    if (!this._outline || !this._ticks) return;
    const { nrows, ncols, cell, z, originX, originY } = this.dem;
    const lift = Math.max(cell * 0.02, 0.005);

    // ⚠️ THE SAME LAST STEP A CONTOUR TAKES. `facetZAt` interpolates within the
    // triangle the renderer actually shades — the a-d-b / b-d-e split — so the
    // line lies IN the mesh rather than over a bilinear surface that is not
    // being drawn. Sampling the four cell corners instead would put the line up
    // to a quarter of a metre off the facet on a 1 m quad, which is the lattice
    // bug the contours already carry a note about.
    /** @type {number[]} */
    const seamPts = [];
    for (const { closed, pts } of this._outline) {
      const n = pts.length;
      const span = closed ? n : n - 1;
      let prevZ = NaN;
      for (let i = 0; i < span; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const za = Number.isFinite(prevZ)
          ? prevZ : facetZAt(this.dem, z, a[0] + originX, a[1] + originY);
        const zb = facetZAt(this.dem, z, b[0] + originX, b[1] + originY);
        prevZ = zb;
        // A hole in the survey breaks the line rather than bridging it.
        if (!Number.isFinite(za) || !Number.isFinite(zb)) { prevZ = NaN; continue; }
        seamPts.push(a[0], a[1], za + lift, b[0], b[1], zb + lift);
      }
    }
    if (seamPts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(seamPts), 3));
      this._seam = new THREE.LineSegments(g, this._seamMat);
      this._seam.frustumCulled = false;
      this._seam.renderOrder = 13;
      this.group.add(this._seam);
      this.count = seamPts.length / 6;
    }

    // The tick stands a little higher than the boundary so the two never fight
    // where a tick crosses one edge-on.
    const tickLift = lift * 2;
    /** @type {number[]} */
    const tickPts = [];
    for (const t of this._ticks) {
      const zc = z[t.r * ncols + t.c];
      if (!Number.isFinite(zc)) continue;
      tickPts.push(
        t.x - t.tx * t.L, t.y - t.ty * t.L, zc + tickLift,
        t.x + t.tx * t.L, t.y + t.ty * t.L, zc + tickLift,
      );
    }
    if (tickPts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tickPts), 3));
      this._tickLine = new THREE.LineSegments(g, this._tickMat);
      this._tickLine.frustumCulled = false;
      this._tickLine.renderOrder = 13;
      this.group.add(this._tickLine);
      this.tickCount = tickPts.length / 6;
    }
    void nrows;
  }

  dispose() {
    this._clear();
    this._labels = null;   // never hold a grid-sized array past its tile
    this._patches = null;
    this._outline = null;  // …nor the trace taken from it
    this._ticks = null;
    this._seamMat.dispose();
    this._tickMat.dispose();
  }
}
