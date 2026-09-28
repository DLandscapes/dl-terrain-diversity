// @ts-check
// SECTION LINES IN THE VIEWPORT.
//
// Follows PlanOverlay's conventions exactly, because they are the ones this
// project paid for: geometry LOCAL with the UTM origin on the group transform
// (a section polyline is a fresh float32 buffer, so it is precisely where world
// coordinates creep back in), depth testing OFF so a line lying in the surface
// cannot tie with it per fragment and shimmer, and the exaggeration carried on
// the group's z scale rather than baked into the vertices.
//
// ⚠️ THE PROFILES ARE DRAWN IN PLACE, NOT OFF TO ONE SIDE. A section pinned
// beside the model would be a second drawing to look back and forth between. Cut
// along the line itself, the EXISTING ground floats above where material was
// taken and dips below where it was added — so the gap between the two lines is
// the earthwork, seen on the terrain it happened to, at the place it happened.
// The measured drawing with its dimensions and hatching is what the SVG export
// is for; this is the thing you look at while working.
//
// ⚠️ EXISTING GROUND IS DASHED AND FINE, PROPOSED IS SOLID AND HEAVY. The
// drawing convention, and the same one the SVG uses — a viewport that told them
// apart by colour and an export that told them apart by weight would be two
// vocabularies for one distinction.

import * as THREE from "three";
import { textSprite } from "./dimensions.js";

const INK = 0x1c1a16;

/**
 * A stepped polyline — horizontal runs at one level, vertical risers where the
 * level changes.
 *
 * ⚠️ THE RISER IS TWO POINTS AT THE SAME X AND Y, which is what makes the corner
 * 90° rather than merely steep. Sampling the level at each station and joining
 * the results would give a staircase with sloped treads: every segment would
 * carry both the run and the rise.
 *
 * ⚠️ SUB-SAMPLED BETWEEN STATIONS. A block is several cells wide and the profile
 * is sampled per cell, so a station-only walk can step up to a cell late. Four
 * sub-samples put the riser within an eighth of a cell of the block edge — 3 cm
 * on this site — without needing the exact crossing solved per segment.
 *
 * @param {ArrayLike<number>} xs @param {ArrayLike<number>} ys
 * @param {(x:number,y:number)=>number} zAt the DRAWN level, or NaN off the grid
 */
function staircase(xs, ys, zAt) {
  /** @type {number[]} */ const ox = [];
  /** @type {number[]} */ const oy = [];
  /** @type {number[]} */ const oz = [];
  const SUB = 4;
  let pz = NaN;
  const at = (x, y) => {
    const z = zAt(x, y);
    if (!Number.isFinite(z)) { pz = NaN; return; }
    if (!Number.isFinite(pz)) {
      ox.push(x); oy.push(y); oz.push(z); pz = z; return;
    }
    if (z !== pz) {
      ox.push(x); oy.push(y); oz.push(pz);   // finish the run
      ox.push(x); oy.push(y); oz.push(z);    // the riser
      pz = z;
    }
  };
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i], y0 = ys[i], dx = xs[i + 1] - x0, dy = ys[i + 1] - y0;
    for (let k = 0; k < SUB; k++) at(x0 + (dx * k) / SUB, y0 + (dy * k) / SUB);
  }
  const n = xs.length - 1;
  if (n >= 0) {
    at(xs[n], ys[n]);
    // The final run still needs its far end, which `at` only emits on a change.
    if (Number.isFinite(pz)) { ox.push(xs[n]); oy.push(ys[n]); oz.push(pz); }
  }
  return { xs: ox, ys: oy, zs: oz };
}

export class SectionOverlay {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.exaggeration = opts.verticalExaggeration ?? 1;
    this.group = new THREE.Group();
    // ⚠️ The origin lives HERE, never in a vertex buffer.
    this.group.position.set(dem.originX, dem.originY, 0);
    this.group.scale.set(1, 1, this.exaggeration);
    this.group.renderOrder = 11;   // above the plan overlay's rings

    /** @type {THREE.Material[]} */
    this._materials = [];
    this._now = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.95,
      depthTest: false, depthWrite: false, fog: false,
    });
    // ⚠️ LineDashedMaterial needs computeLineDistances() called on the geometry
    // or it renders solid — silently, with no warning, which would quietly
    // collapse the one distinction this overlay exists to draw.
    //
    // ⚠️ THE DASH IS MEASURED IN WORLD METRES, so a fixed size cannot serve
    // both scales: 0.9 m read as a coarse dot-dash on the 64 m patch and as a
    // solid line on the 1 km context, where it is under a pixel. Scaling it
    // to the tile's span makes the drawing read the same at every scale —
    // the rule the dimension frame and the section end-marks already follow.
    // 0.5% and 0.3% of span give 0.32 m / 0.19 m on the design patch: a fine
    // drafting dash rather than a chain line.
    const span = Math.max(dem.ncols, dem.nrows) * dem.cell;
    this._was = new THREE.LineDashedMaterial({
      color: INK, transparent: true, opacity: 0.55,
      dashSize: span * 0.005, gapSize: span * 0.003,
      depthTest: false, depthWrite: false, fog: false,
    });
    this._trace = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.45,
      depthTest: false, depthWrite: false, fog: false,
    });
    this._materials.push(this._now, this._was, this._trace);
    // The end-marks' fill. DoubleSide on purpose: these are flat XY triangles
    // a few metres across, and a winding slip on a single-sided material is
    // exactly the apron's inside-out failure — invisible from above, correct
    // from below, and no check that looks at counts would notice.
    // ⚠️ NO LONGER USED BY ANYTHING (2026-08-13). It filled the end-marks'
    // triangle and ring; both became a single drawn outline on `_headLine`.
    // Kept, because `_materials` is what dispose() walks and removing a member
    // of that list is how a leak gets introduced — and because a filled mark
    // may be wanted again for a printed sheet, where ink is cheap and hairlines
    // are not. Delete it with the next sweep if nothing has claimed it.
    this._mark = new THREE.MeshBasicMaterial({
      color: INK, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false,
    });
    this._materials.push(this._mark);
    // ⚠️ THE HEAD'S OWN LINE MATERIAL, at full strength. The ring is a mesh at
    // 0.85 and reads as a weight of ink; an open triangle is three hairlines
    // and would disappear beside it at the same opacity. It carries no
    // dashing — a section head is a solid mark, and the dash is reserved for
    // the cutting line itself.
    this._headLine = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.95,
      depthTest: false, depthWrite: false, fog: false,
    });
    this._materials.push(this._headLine);
    /**
     * The rubber band drawn while a section is being placed: dashed, because it
     * is a proposal rather than a cut. Same dash rhythm as the existing-ground
     * profile, so "dashed means not yet / not any more" reads consistently.
     */
    // ⚠ THE DASH IS SCALED TO THE TILE, not fixed. A literal 0.9 m dash reads
    // as a coarse dot-dash on the 64 m patch and as a SOLID LINE on the 1 km
    // context, where it falls under a pixel — the same trap `_was` documents
    // just above. Written fixed first, and corrected on reading that note.
    this._pendingLine = new THREE.LineDashedMaterial({
      color: INK, transparent: true, opacity: 0.75,
      dashSize: span * 0.006, gapSize: span * 0.004,
      depthTest: false, depthWrite: false, fog: false,
    });
    this._materials.push(this._pendingLine);
    /** Its own group — see the note in `_clear`. */
    this._pendingGroup = new THREE.Group();
    this.group.add(this._pendingGroup);
    /**
     * Letter sprites, cached by section name. Rebuilt sprites would allocate a
     * canvas texture per overlay refresh, and refreshes ride every stroke
     * settle — the cache makes a label a one-time cost per letter.
     * @type {Map<string, THREE.Sprite>}
     */
    this._labels = new Map();
    /**
     * The same letters again, drawn BLACK, for the hover state.
     *
     * ⚠️ A SECOND CACHE RATHER THAN A RESTYLED SPRITE, because a sprite's
     * appearance IS its canvas texture: there is no colour to set at draw
     * time. Swapping the material swaps the glyph, and the two are the same
     * text at the same metrics, so the mark does not move when it lights up.
     * @type {Map<string, THREE.SpriteMaterial>}
     */
    this._hotLabels = new Map();
    /**
     * Where each drawn section head IS, in world coordinates, so the app can
     * hit-test one without recomputing the placement.
     *
     * ⚠️⚠️ PUBLISHED RATHER THAN RE-DERIVED, and that is the point. The head
     * sits GAP + R * 0.68 up the bisector from an end, on the left of the cut
     * direction — five constants and a sign, all local to `_annotate`. A hit
     * test that recomputed them would be correct until the day the symbol is
     * restyled again, and then it would be silently aiming at where the mark
     * used to be. This is the mark's own answer to "where are you".
     * @type {{name:string, x:number, y:number, z:number, sprite:THREE.Sprite}[]}
     */
    this.heads = [];
    /** the head the pointer is over, by section name */
    this._hotName = null;
    /** how many line objects the last update drew, for the self-test */
    this.count = 0;
    /** the last setSections call, so setExaggeration can rebake a fold */
    this._last = null;
  }

  /** @param {number} v */
  setExaggeration(v) {
    this.exaggeration = v;
    this.group.scale.z = v;
    // ⚠️ A FOLDED SECTION CANNOT RIDE THE GROUP'S Z SCALE. Standing profiles
    // carry their heights in z, so the scale above is the whole update — but a
    // folded profile carries its heights as XY offsets, which the z scale
    // never touches. Left alone, the fold would keep the OLD exaggeration
    // while the ground and the standing drawing took the new one, and the two
    // readings of the same section would quietly disagree. Rebake instead.
    if (this._last && this._last.opts.folded) {
      this.setSections(this._last.sections, this._last.opts);
    }
  }
  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  /**
   * @param {THREE.Sprite} sp @param {string} name @param {boolean} on
   */
  _paintHot(sp, name, on) {
    if (!on) {
      const cold = /** @type {any} */ (sp)._cold;
      if (cold) sp.material = cold;
      return;
    }
    let hot = this._hotLabels.get(name);
    if (!hot) {
      // ⚠️ THE HEIGHT IS TAKEN FROM THE COLD SPRITE ITSELF, not recomputed from
      // the tile. Only the MATERIAL is swapped, so the sprite keeps its own
      // scale and the glyph cannot change size — and the sizing rule (a span
      // fraction, floored at three cells, shrunk for two characters) stays in
      // the one place that owns it. Written recomputed first, which is the
      // drift the heads array exists to avoid.
      const probe = textSprite(name, { worldHeight: sp.scale.y, colour: "#000000" });
      hot = /** @type {THREE.SpriteMaterial} */ (probe.material);
      this._hotLabels.set(name, hot);
    }
    sp.material = hot;
  }

  /**
   * Light up one section's letters, or none.
   *
   * ⚠️ THE AFFORDANCE, NOT DECORATION (2026-08-28, Marc: "when you hover over
   * one of the sections where the text is now gray, the letter should
   * highlight in black indicating that i can click on it"). Ctrl+click on a
   * head cuts to that section, and a control that gives no sign it is a
   * control is a control nobody finds.
   *
   * @param {string|null} name
   * @returns {boolean} true if the highlight changed
   */
  setHot(name) {
    if (name === this._hotName) return false;
    this._hotName = name;
    for (const h of this.heads) this._paintHot(h.sprite, h.name, h.name === name);
    return true;
  }

  _clear() {
    for (const c of [...this.group.children]) {
      // ⚠️ THE PENDING PREVIEW IS NOT PART OF THE DRAWN SECTIONS and must
      // survive a rebuild. It updates at pointer rate while a section is being
      // drawn, whereas setSections re-samples every profile — so the two are
      // kept in separate groups and never rebuilt together. Wiping it here
      // would clear the rubber band on the first settle after the anchor drops.
      if (c === this._pendingGroup) continue;
      this.group.remove(c);
      // Cached letter sprites are REUSED across refreshes — and a Sprite's
      // geometry is shared class-wide in three.js, so disposing it here would
      // blank every sprite in the scene, not only this one.
      if (/** @type {any} */ (c).isSprite) continue;
      /** @type {any} */ (c).geometry?.dispose();
    }
  }

  /**
   * The drafting marks a section line carries on a plan: a tick across each
   * end, a filled triangle pointing the direction the section LOOKS — which
   * is the fold side, left of the cut direction, so the arrows and the folded
   * drawing always agree — and the section's letter beyond each end.
   * @param {string} name
   * @param {number} ax @param {number} ay
   * @param {number} bx @param {number} by  trace ends, world XY
   * @param {number} z  the plane the marks lie in
   */
  _annotate(name, ax, ay, bx, by, z, opts = {}) {
    // `target` and `firstOnly` exist for the placement preview: while a section
    // is being drawn only the ANCHORED end has a head, and it is drawn into the
    // pending group so it can be rebuilt at pointer rate without touching the
    // sections themselves.
    const target = opts.target || this.group;
    const ends = opts.firstOnly ? [[ax, ay]] : [[ax, ay], [bx, by]];
    const { originX, originY } = this.dem;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (!len) return;
    const ux = dx / len, uy = dy / len;       // along the trace
    const px = -uy, py = ux;                  // left of it: the viewing side
    const span = Math.max(this.dem.ncols, this.dem.nrows) * this.dem.cell;
    const s = Math.max(this.dem.cell * 3, span * 0.02);

    // ⚠️ THE DRAFTING SECTION HEAD (2026-08-11): a circle carrying the letter,
    // with a triangle pointing the way the section LOOKS. The earlier mark was
    // a bare triangle with the letter set beside it, which read as an arrow
    // rather than as a section reference — this is the symbol the convention
    // actually uses, and it puts the identifier INSIDE the mark where a reader
    // expects to find it.
    //
    // ⚠️⚠️ THE HEAD LEFT THE CIRCLE, AND IT IS NOW OUTLINE (2026-08-13, Marc:
    // "hard to read the grey text with the dark-grey overlay of the
    // triangle"). The triangle's base used to be a chord straight ACROSS THE
    // CENTRE — from −u·R to +u·R through (ex, ey) — so a solid head covered
    // the exact half of the circle the letter sits in. Grey glyph over dark
    // grey fill is unreadable at any zoom, and no amount of restyling the text
    // fixes a symbol that draws over its own identifier.
    //
    // The head now sits OUTSIDE the ring, tangent to it, so nothing overlaps
    // the letter — which is what the drafting convention does anyway. And it
    // is drawn as three lines rather than filled, for the reason the dimension
    // frame's arrows were changed the same day: everything else in this
    // overlay is line-work of one weight, and a solid mark would be the only
    // filled shape in the scene.
    const R = s * 0.95;

    /**
     * ⚠️⚠️ THE HEAD STANDS OFF THE CUTTING LINE (2026-08-28, Marc: "the triangle
     * should have a distance to the section line"). RAISED, NOT SILENTLY
     * REVERSED: the note below records the 2026-08-13 decision that the base
     * lies ON the line, "which is how a section head relates to its cutting
     * line in drafting rather than floating beside it". Both conventions are
     * drawn in practice, and at the zoom this overlay is read at a base sitting
     * exactly on the trace merges with it — the gap is what keeps the head a
     * mark ON the drawing rather than a thickening OF the line.
     *
     * ⚠️ MEASURED, NOT GUESSED, AND THEN PULLED BACK IN. At R * 0.55 the trace
     * still met the base corner when rendered and zoomed: the gap existed
     * arithmetically and did not read. R * 1.15 was the first value where the
     * air was unmistakable — and, seen in use, unmistakably too much (Marc,
     * 2026-09-02: "graphically the arrow could be closer to the section line").
     * R * 0.70 sits between the two: above the value proven not to read, well
     * under the one that detached the head from its own line. Both earlier
     * numbers are kept here because they are the bracket this one sits in.
     *
     * ⚠️ IT IS DECLARED HERE, NOT INSIDE `pin`, BECAUSE THE LETTER NEEDS IT TOO.
     * The letter rides up the bisector measured FROM THE BASE, so lifting the
     * outline without lifting the label left the "A" stranded on the cutting
     * line outside its own triangle — which is the exact defect the 2026-08-13
     * note says the mark was redesigned to cure. One constant, both users.
     */
    const GAP = R * 0.70;

    /**
     * ⚠️ ONE CLOSED OUTLINE — A DROP, NOT A CIRCLE PLUS AN ARROW (Marc's
     * sketch, 2026-08-13). The mark was a ring with a separate triangle beside
     * it: two shapes the eye has to assemble, and the pair was what put a fill
     * over the letter in the first place. Drawn as a single teardrop the point
     * IS the direction — no second element to collide with anything — and the
     * round half is left entirely to the identifier, which is the one thing the
     * mark exists to carry.
     *
     * The geometry is the circle plus its two TANGENT lines to an apex out
     * along the view direction. Tangency is what makes it read as one drawn
     * object: lines struck from the apex to the circle's edge at any other
     * angle would either cut the circle or leave a visible kink where they
     * meet it. For an apex at distance D the tangent points sit at ±acos(R/D)
     * either side of the apex bearing, and the arc runs the LONG way round
     * between them — the near wedge is exactly what the flanks replace.
     */
    const pin = (ex, ey) => {
      // ⚠️ A ROUNDED TRIANGLE SITTING ON THE CUTTING LINE (Marc's second
      // sketch, and the better of the two). Against the teardrop: the WHOLE
      // shape points rather than just its tip, which is the least ambiguous
      // direction mark there is; its base lies ON the line, which is how a
      // section head relates to its cutting line in drafting rather than
      // floating beside it; and the fillets are the same move the buttons and
      // frames make, so the mark belongs to the interface it sits in.
      //
      // ⚠️ THE BASE MIDPOINT IS THE SECTION'S END, so the shape stands wholly
      // on the viewing side and the line runs into its base — never through
      // the letter, which was the original defect.
      // ⚠️⚠️ THE HEAD NOW STANDS OFF THE CUTTING LINE (2026-08-28, Marc: "the
      // triangle should have a distance to the section line"). RAISED, NOT
      // SILENTLY REVERSED: the note above says the base lies ON the line
      // "which is how a section head relates to its cutting line in drafting
      // rather than floating beside it", and that was the 2026-08-13 decision.
      // Both conventions are drawn in practice — heads on the line, and heads
      // set off it with the line running to a stop short of the mark — and at
      // the sizes this overlay is read at, a base sitting exactly on the trace
      // merges with it and the shape stops reading as a separate symbol. The
      // gap is what makes it a mark ON a drawing rather than a thickening OF
      // the line.
      const bxm = ex + px * GAP, bym = ey + py * GAP;   // base midpoint, lifted
      const w = R * 1.18;      // half the base
      const h = R * 2.00;      // apex height above it
      const rr = R * 0.30;     // corner radius
      const corners = [
        [bxm - ux * w, bym - uy * w],
        [bxm + px * h, bym + py * h],
        [bxm + ux * w, bym + uy * w],
      ];
      /** @type {number[][]} */
      const pts = [];
      // Each corner becomes an arc tangent to both of its edges: step in from
      // the corner by r/tan(θ/2) along each edge, and swing r about the point
      // on the bisector at r/sin(θ/2). Rounding a polygon any other way leaves
      // the arc off-tangent, which shows as a kink exactly where the eye is
      // drawn.
      for (let i = 0; i < 3; i++) {
        const V = corners[i];
        const P = corners[(i + 2) % 3], N2 = corners[(i + 1) % 3];
        const an = (A, B) => {
          const dx2 = A[0] - B[0], dy2 = A[1] - B[1];
          const L = Math.hypot(dx2, dy2) || 1;
          return [dx2 / L, dy2 / L];
        };
        const a = an(P, V), b = an(N2, V);
        const half = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) / 2;
        const dIn = rr / Math.tan(half);
        const T1 = [V[0] + a[0] * dIn, V[1] + a[1] * dIn];
        const T2 = [V[0] + b[0] * dIn, V[1] + b[1] * dIn];
        const bis = an([V[0] + a[0] + b[0], V[1] + a[1] + b[1]], V);
        const C = [V[0] + bis[0] * (rr / Math.sin(half)),
          V[1] + bis[1] * (rr / Math.sin(half))];
        let s0 = Math.atan2(T1[1] - C[1], T1[0] - C[0]);
        let s1 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
        let d2 = s1 - s0;
        while (d2 > Math.PI) d2 -= Math.PI * 2;      // always the short way
        while (d2 < -Math.PI) d2 += Math.PI * 2;
        const STEPS = 10;
        for (let k = 0; k <= STEPS; k++) {
          const t = s0 + d2 * (k / STEPS);
          pts.push([C[0] + Math.cos(t) * rr, C[1] + Math.sin(t) * rr]);
        }
      }
      pts.push(pts[0]);                             // closed

      /**
       * ⚠️⚠️ THE STROKE IS THICKENED BY DRAWING THE OUTLINE THREE TIMES, NOT BY
       * `linewidth` (2026-08-28, Marc: "a little thicker in stroke width").
       * `_headLine` is a LineBasicMaterial, and WebGL caps line width at one
       * pixel: MEASURED on this machine as
       * `gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE)` → **[1, 1]**. Setting
       * `linewidth` would have changed nothing while LOOKING like a fix — the
       * same shape of mistake as phase 16's `white-space: nowrap` that took
       * effect and did nothing.
       *
       * So the mark is stroked as three concentric passes, offset along the
       * outward normal from the shape's own centroid. The shape is convex, so
       * for a small offset that normal IS the parallel offset direction and the
       * passes stay tangent rather than crossing at the rounded corners.
       *
       * ⚠️ THIS THICKENS ONLY THE SECTION HEAD, deliberately. Everything else in
       * the overlay stays one weight; the head is the one mark that has to be
       * found before it is read, and it now carries the extra weight that says
       * so. If the whole overlay ever needs real strokes, that is Line2 from
       * three.js's examples and a second vendored file — a bigger decision than
       * this one.
       */
      let cx = 0, cy = 0;
      for (let i = 0; i + 1 < pts.length; i++) { cx += pts[i][0]; cy += pts[i][1]; }
      cx /= (pts.length - 1); cy /= (pts.length - 1);
      const STROKE = R * 0.045;                     // half the drawn weight
      const PASSES = [-STROKE, 0, STROKE];
      const arr = new Float32Array((pts.length - 1) * 6 * PASSES.length);
      let o = 0;
      for (const off of PASSES) {
        const at = (p) => {
          const nx = p[0] - cx, ny = p[1] - cy;
          const L = Math.hypot(nx, ny) || 1;
          return [p[0] + (nx / L) * off, p[1] + (ny / L) * off];
        };
        for (let i = 0; i + 1 < pts.length; i++) {
          const A = at(pts[i]), B = at(pts[i + 1]);
          arr[o] = A[0] - originX; arr[o + 1] = A[1] - originY; arr[o + 2] = z;
          arr[o + 3] = B[0] - originX; arr[o + 4] = B[1] - originY; arr[o + 5] = z;
          o += 6;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const m = new THREE.LineSegments(g, this._headLine);
      m.renderOrder = 12;
      m.frustumCulled = false;
      target.add(m);
    };

    /**
    // ⚠️ THE SEPARATE HEAD IS GONE — the drop above carries the direction in
    // its own point, so a second shape would be one mark too many.

    /**
     * The letter, in the widest part of the triangle.
     *
     * ⚠️ NOT AT THE BASE MIDPOINT ANY MORE. That point is now ON the cutting
     * line, so a letter centred there would sit half outside the shape and
     * across the line — the mark's own base would cut it in two. It rides up
     * the bisector to a third of the height, which is near the centroid and is
     * where a triangle has the room.
     *
     * ⚠️ AND IT SHRINKS FOR TWO CHARACTERS. `sectionName` runs A..Z and then
     * AA, AB — a triangle has far less interior width than the circle this
     * replaced, so the 27th section would have set its name wider than the
     * shape that carries it. Nobody cuts 27 sections, which is exactly why
     * this would have shipped unnoticed.
     */
    const letter = (ex, ey) => {
      let sp = this._labels.get(name);
      if (!sp) {
        const fit = name.length > 1 ? 0.62 : 1;
        sp = textSprite(name, { worldHeight: R * 1.05 * fit });
        this._labels.set(name, sp);
      }
      // One cached sprite per letter but TWO ends want it — clone shares the
      // material and texture, so the cost stays one canvas per letter.
      const use = sp.parent ? sp.clone() : sp;
      // ⚠️ THE COLD MATERIAL IS REMEMBERED ON THE SPRITE, not looked up later.
      // The first end reuses the CACHED object itself rather than a clone, so
      // lighting it up mutates the cache; without somewhere to put the original
      // back, a hover would leave that letter permanently black.
      /** @type {any} */ (use)._cold = use.material;
      // A third of the way up the bisector, measured from the base — which now
      // stands GAP clear of the cutting line, so the letter is lifted with it.
      const up = GAP + R * 2.00 * 0.34;
      use.position.set(ex + px * up - originX, ey + py * up - originY, z);
      target.add(use);
      // ⚠️ ONLY THE REAL SECTIONS ARE PICKABLE. The placement preview draws a
      // head too, into its own group, and registering it would let the user
      // ctrl-click a section that does not exist yet.
      if (target === this.group) {
        this.heads.push({
          name, x: ex + px * up, y: ey + py * up, z, sprite: use,
        });
        if (name === this._hotName) this._paintHot(use, name, true);
      }
    };

    for (const [ex, ey] of ends) {
      pin(ex, ey);       // one outline, its point along the view direction
      letter(ex, ey);    // in the round half, with nothing over it
    }
  }

  /**
   * Draw a set of sampled sections.
   *
   * `folded` rotates each profile 90° about its own trace, laying the vertical
   * drawing flat on the ground — the drafting fold-out, so a plan view shows
   * the section beside its line instead of edge-on, where a standing profile
   * projects to nothing. Heights become perpendicular offsets to the LEFT of
   * the direction the section was cut in, measured from the profile's lowest
   * point (the fold hinge, drawn as a faint datum line along the trace). The
   * offsets carry the vertical exaggeration so the folded and standing
   * drawings are the same section, not two claims about it — at 1.0× the fold
   * is true size.
   *
   * @param {{name: string, profile: any}[]} sections
   * @param {{selected?: string|null, folded?: boolean}} [opts]
   */
  /**
   * The live preview while a section is being placed: the anchored end's head,
   * and a dashed band from it to wherever the cursor is.
   *
   * ⚠️ THIS IS THE ONLY FEEDBACK THE FIRST CLICK USED TO HAVE (2026-08-28,
   * Marc: "when you first click with the left mouse button there is no visual
   * feedback"). Before this the anchor existed only as `state.sections.pending`
   * and a status line — the drawing said nothing at all, so the user had to
   * remember where they had clicked.
   *
   * ⚠️ IT IS DELIBERATELY CHEAP. It rebuilds on every pointer move, so it draws
   * two objects and sizes nothing it does not have to. `setSections` re-samples
   * every profile in the scene and must never be called from a move handler.
   *
   * @param {number[]|null} a  the anchored end, world XY, or null to clear
   * @param {number[]|null} b  the cursor, world XY, or null for the head alone
   * @param {string} [name]    the letter the finished section will carry
   */
  setPending(a, b, name = "?") {
    const g = this._pendingGroup;
    for (const c of [...g.children]) {
      g.remove(c);
      if (/** @type {any} */ (c).isSprite) continue;
      /** @type {any} */ (c).geometry?.dispose();
    }
    if (!a) return;
    const { originX, originY, cell, ncols, nrows } = this.dem;
    // Nearest-cell ground height; the marks sit in that plane. depthTest is off
    // so this is about being in the right place, not about being occluded.
    const zAt = (x, y) => {
      const c = Math.floor((x - originX) / cell), r = Math.floor((y - originY) / cell);
      if (c < 0 || r < 0 || c >= ncols || r >= nrows) return null;
      const v = this.dem.z[r * ncols + c];
      return Number.isFinite(v) ? v : null;
    };
    const za = zAt(a[0], a[1]);
    if (za === null) return;

    if (b) {
      const zb = zAt(b[0], b[1]);
      const pos = new Float32Array([
        a[0] - originX, a[1] - originY, za,
        b[0] - originX, b[1] - originY, zb === null ? za : zb,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const l = new THREE.Line(geo, this._pendingLine);
      l.computeLineDistances();          // or LineDashedMaterial renders solid
      l.frustumCulled = false;
      l.renderOrder = 12;
      g.add(l);
    }
    // The head at the anchor only: the far end is not placed yet, and drawing a
    // head there would claim a decision the user has not made.
    const bx = b ? b[0] : a[0] + cell, by = b ? b[1] : a[1];
    if (bx !== a[0] || by !== a[1]) {
      this._annotate(name, a[0], a[1], bx, by, za, { target: g, firstOnly: true });
    }
  }

  setSections(sections, opts = {}) {
    this._last = { sections, opts };
    this._clear();
    // ⚠️ THE HEADS ARE REBUILT WITH THE DRAWING, never carried over. They hold
    // sprite references into a group that `_clear` has just emptied; kept, they
    // would be a hit test aiming at marks that are no longer in the scene.
    this.heads = [];
    this.count = 0;
    const { originX, originY } = this.dem;
    const line = (xs, ys, zs, mat, dashed) => {
      const pos = new Float32Array(xs.length * 3);
      let n = 0;
      for (let i = 0; i < xs.length; i++) {
        if (!Number.isFinite(zs[i])) continue;
        pos[n * 3] = xs[i] - originX;
        pos[n * 3 + 1] = ys[i] - originY;
        pos[n * 3 + 2] = zs[i];
        n++;
      }
      if (n < 2) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, n * 3), 3));
      const l = new THREE.Line(g, mat);
      if (dashed) l.computeLineDistances();
      l.frustumCulled = false;
      this.group.add(l);
      this.count++;
    };

    for (const sec of sections) {
      const p = sec.profile;
      if (!p) continue;
      const hasWas = p.was && p.was.some((v) => Number.isFinite(v));

      if (opts.folded) {
        const n = p.x.length;
        const dx = p.x[n - 1] - p.x[0], dy = p.y[n - 1] - p.y[0];
        const len = Math.hypot(dx, dy);
        if (!len) continue;
        // Left of the cut direction, so the user chooses the side by the order
        // they clicked the two ends in.
        const px = -dy / len, py = dx / len;
        // The fold hinge: the lowest finite elevation on EITHER surface, so
        // both folded lines land on the same side of the trace and the gap
        // between them still reads as the earthwork.
        let z0 = Infinity;
        for (let i = 0; i < n; i++) {
          if (Number.isFinite(p.now[i]) && p.now[i] < z0) z0 = p.now[i];
          if (Number.isFinite(p.was[i]) && p.was[i] < z0) z0 = p.was[i];
        }
        if (!Number.isFinite(z0)) continue;
        // ⚠️ THE EXAGGERATION IS BAKED IN HERE, because these offsets are XY
        // and the group's z scale cannot reach them — see setExaggeration.
        const ex = this.exaggeration;
        const fold = (zs, mat, dashed) => {
          const fx = new Float64Array(n), fy = new Float64Array(n);
          for (let i = 0; i < n; i++) {
            const d = (zs[i] - z0) * ex;
            fx[i] = p.x[i] + px * d;
            fy[i] = p.y[i] + py * d;
          }
          // The z passed through is the ELEVATION array, so line() still drops
          // the stations where the surface has no value; the drawn height is
          // flattened onto the hinge afterwards.
          line(fx, fy, zs.map((v) => (Number.isFinite(v) ? z0 : v)), mat, dashed);
        };
        // The trace itself, faint — the hinge the drawing folded about, and
        // the zero line the offsets are read against.
        line([p.x[0], p.x[n - 1]], [p.y[0], p.y[n - 1]], [z0, z0], this._trace, false);
        if (hasWas) fold(p.was, this._was, true);
        fold(p.now, this._now, false);
        this._annotate(sec.name, p.x[0], p.y[0], p.x[n - 1], p.y[n - 1], z0);
        continue;
      }

      // The existing ground first, so the proposed line draws over it where the
      // two coincide — untouched ground should read as one line, not two.
      if (hasWas) {
        line(p.x, p.y, p.was, this._was, true);
      }
      // ⚠️⚠️ STEPPED WHEN THE GROUND IS DRAWN AS BLOCKS (Marc, 2026-09-27). A
      // smooth section over a voxel surface has the drawing and the model
      // disagreeing about what the ground is — the line curves through cubes it
      // is supposed to be a cut through. `stepZ` reads the levels voxels.js
      // actually drew, so the two agree by construction rather than by matching
      // parameters.
      //
      // ⚠️ THE EXISTING-GROUND LINE IS LEFT SMOOTH, and that is a decision. There
      // is no voxel surface for the baseline: stepping it to the CURRENT blocks
      // would draw a staircase the model never showed and imply the old ground
      // had been blocks too. It only appears where ground has been edited, so on
      // untouched ground the question does not arise.
      if (opts.stepZ) {
        const st = staircase(p.x, p.y, opts.stepZ);
        line(st.xs, st.ys, st.zs, this._now, false);
      } else {
        line(p.x, p.y, p.now, this._now, false);
      }
      {
        const n = p.x.length;
        const zA = [...p.now].find((v) => Number.isFinite(v));
        if (Number.isFinite(zA)) {
          this._annotate(sec.name, p.x[0], p.y[0], p.x[n - 1], p.y[n - 1], zA);
        }
      }
    }
  }

  dispose() {
    this._clear();
    for (const m of this._materials) m.dispose();
    for (const sp of this._labels.values()) {
      /** @type {any} */ (sp.material).map?.dispose();
      sp.material.dispose();
    }
    this._labels.clear();
  }
}
