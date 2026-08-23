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
     * Letter sprites, cached by section name. Rebuilt sprites would allocate a
     * canvas texture per overlay refresh, and refreshes ride every stroke
     * settle — the cache makes a label a one-time cost per letter.
     * @type {Map<string, THREE.Sprite>}
     */
    this._labels = new Map();
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

  _clear() {
    for (const c of [...this.group.children]) {
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
  _annotate(name, ax, ay, bx, by, z) {
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
      const w = R * 1.18;      // half the base
      const h = R * 2.00;      // apex height above it
      const rr = R * 0.30;     // corner radius
      const corners = [
        [ex - ux * w, ey - uy * w],
        [ex + px * h, ey + py * h],
        [ex + ux * w, ey + uy * w],
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
      const arr = new Float32Array((pts.length - 1) * 6);
      for (let i = 0; i + 1 < pts.length; i++) {
        const o = i * 6;
        arr[o] = pts[i][0] - originX; arr[o + 1] = pts[i][1] - originY; arr[o + 2] = z;
        arr[o + 3] = pts[i + 1][0] - originX; arr[o + 4] = pts[i + 1][1] - originY;
        arr[o + 5] = z;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const m = new THREE.LineSegments(g, this._headLine);
      m.renderOrder = 12;
      m.frustumCulled = false;
      this.group.add(m);
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
      // A third of the way up the bisector, from the base on the cutting line.
      const up = R * 2.00 * 0.34;
      use.position.set(ex + px * up - originX, ey + py * up - originY, z);
      this.group.add(use);
    };

    for (const [ex, ey] of [[ax, ay], [bx, by]]) {
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
  setSections(sections, opts = {}) {
    this._last = { sections, opts };
    this._clear();
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
      line(p.x, p.y, p.now, this._now, false);
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
