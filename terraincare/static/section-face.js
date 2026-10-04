// @ts-check
// THE CUT FACE — what a section view is actually looking at.
//
// ⚠️ A HEIGHTFIELD IS AN OPEN SHELL, NOT A SOLID, and that is the whole reason
// this file exists. Clipping the terrain with a vertical plane does not produce
// a face: it produces a hole, and the camera looks straight through the cut at
// the UNDERSIDE of the surface beyond it — lit from below, back-faces culled,
// and completely unreadable. A section drawing has a cut face because the
// ground is solid; this tool models the ground as a surface, so the face has to
// be drawn.
//
// It is drawn from the profile `section.js` already samples — the same numbers
// the section sheet and the SVG export are made of, so the face on screen and
// the drawing on paper cannot disagree about the same cut.
//
// ⚠️ AND IT IS NUDGED OFF THE CLIP PLANE, by a fraction of a cell, toward the
// half that is kept. Geometry lying EXACTLY on a clipping plane is a knife
// edge: whether a fragment survives is decided by floating-point noise, so the
// face flickers, or vanishes, or shows in bands. The nudge is smaller than the
// half-cell the polygon rasteriser already rounds to, and it is toward the
// viewer's side, which is where a cut face belongs anyway.
//
// ⚠️⚠️ REBUILT 2026-08-28 ON FOUR NOTES FROM MARC, all about the same thing —
// that this had been drawn as a diagram of the section rather than as a SECTION:
//
//   "the section line should be a little thicker than other lines displayed"
//   "perhaps the now beige terrain filling could be replaced with a diagonal
//    line hatch? — can you propose something?"
//   "vertical lines where the anchor points of the section are, and then having
//    the section or that line hatch all the way through the entire terrain"
//   "on top of the vertical lines there could then be the A-A"
//
// The last of those is the substantive one, and it names a real defect rather
// than a preference. THE CLIP PLANE IS INFINITE. It cuts the whole tile, not
// the stretch between the two points that were clicked — so a face that stopped
// at the section's ends left bare open shell running on to the tile edge, which
// is visible in any orbited view. The face now spans the FULL intersection of
// the plane with the ground, and the two clicked points are marked ON it by
// verticals carrying the letter. That is also the drafting convention: the cut
// runs the width of the drawing and the section reference marks the extent.
//
// ⚠️ WHAT THE HATCH IS AND IS NOT. It is poché — the convention for cut
// material — at 45°, over a pale ground rather than over nothing: cut material
// is solid, and a transparent fill would show the far terrain through the
// stuff the cut is passing through. It carries NO data. Nothing about spacing,
// angle or weight encodes a soil, a stratum or a material, and it must never be
// made to, because this model holds one surface and no subsurface at all.

import * as THREE from "three";
import { textSprite } from "./dimensions.js";

/**
 * Poché ground — paper, not sand. The hatch does the work; this stops daylight.
 *
 * ⚠️ DESATURATED 2026-10-04 (Marc: "the only thing below it is a little yellow
 * in the hatch — can that be desaturated?"). Measured as channel spread, which
 * is the honest figure at these lightnesses — HLS saturation reads 50 % for the
 * near-white sheet tone and means nothing there. The fill spread 15 and the
 * hatch 13, against the house nodata grey at 12 and the sheet at 4; at the
 * hatch's 50 % opacity the two composited to a warm grey that reads yellow
 * beside the cool end of an analysis layer. Both are halved to 7 and 6, at the
 * same lightness and the same hue, so the poché still reads as paper rather
 * than going dead neutral against a palette that is warm everywhere else.
 */
const CUT_FILL = 0xeeebe7;
/** The hatch itself: ink, held well back from the profile's weight. */
const CUT_HATCH = 0x474541;
const CUT_EDGE = 0x26241f;

export class SectionFace {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.group = new THREE.Group();
    // ⚠️ The origin lives HERE, never in a vertex buffer — see surface.js.
    this.group.position.set(dem.originX, dem.originY, 0);
    this.group.scale.set(1, 1, opts.verticalExaggeration ?? 1);
    this.group.renderOrder = 6;   // under the line overlays, over the terrain
    this.group.visible = false;
    /**
     * ⚠️⚠️ THE THREE LAYERS OF THE FACE ARE COPLANAR BY CONSTRUCTION, AND THAT
     * HAS TO BE PAID FOR IN THE DEPTH BUFFER (2026-09-02, Marc: "it looks like
     * it's double and the lower part is flickering as it is co-planar with the
     * beige hatch").
     *
     * The poché ground, the hatch and the ground line's ribbon all lie in the
     * cut plane, nudged off it by the SAME amount — so at every fragment where
     * the ribbon's lower half overlaps the hatch, two primitives claim the
     * identical depth and which one survives is decided by floating-point
     * noise. That is the flicker, and it is also why the band read as double:
     * the half above the profile drew cleanly against the sky while the half
     * below dithered against the fill.
     *
     * ⚠️ `renderOrder` DOES NOT FIX THIS, and reaching for it is the obvious
     * wrong move. Render order decides the sequence primitives are SUBMITTED
     * in; the depth TEST still runs, and with `depthFunc` LESS the later of two
     * equal-depth fragments is rejected. The layers were already ordered 6/7/8
     * and it changed nothing.
     *
     * ⚠️ AND THE FIX IS NOT A BIGGER NUDGE EITHER. Nudging further along the
     * clip normal moves the geometry in WORLD units, and whether that clears
     * the tie depends on the camera distance and the depth range — it would
     * hold on the 64 m patch and fail on the 1 km context, which is the same
     * class of trap as the fixed 0.9 m dash. `polygonOffset` biases in
     * DEPTH-BUFFER units, which is exactly the quantity in dispute.
     */
    this._fill = new THREE.MeshBasicMaterial({
      color: CUT_FILL,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
      // DoubleSide because which way the strip winds depends on the direction
      // the section happened to be drawn in, and a face that vanished when you
      // cut A→B instead of B→A would look like the feature not working. The
      // apron shipped inside out for exactly this reason.
      side: THREE.DoubleSide, fog: false,
    });
    // Between the two: in front of the ground it hatches, behind the line.
    this._hatch = new THREE.LineBasicMaterial({
      color: CUT_HATCH, transparent: true, opacity: 0.5, fog: false,
      polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: 0,
    });
    // The anchor verticals cross the whole face and would fight the hatch the
    // same way; they win by the same margin the ground line does.
    this._edge = new THREE.LineBasicMaterial({
      color: CUT_EDGE, transparent: true, opacity: 0.9, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    /**
     * The ground line's weight, as a FACE rather than a line.
     *
     * ⚠️ `linewidth` IS INERT — ALIASED_LINE_WIDTH_RANGE is [1,1] on every
     * WebGL context this app has ever run on, and this project has already
     * paid for that lesson once in section-view.js. A thick line has to be
     * geometry. Here it can be a ribbon rather than the three-pass stroke that
     * file uses, because the cut face is a known PLANE: a strip straddling the
     * profile inside that plane is a true constant-width line seen square-on,
     * and stays correct when the view is orbited.
     */
    this._weight = new THREE.MeshBasicMaterial({
      color: CUT_EDGE, side: THREE.DoubleSide, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    /** @type {THREE.Object3D[]} */
    this._parts = [];
    /** letter sprites, cached by section name — see SectionOverlay's note */
    this._labels = new Map();
    /**
     * The ground line, kept so its weight can be rewritten without rebuilding
     * the face. See `setScreenWeight`.
     * @type {{mesh: THREE.Mesh, X: number[], Y: number[], Z: number[],
     *         S: number[], n: number, ux: number, uy: number, ex: number}|null}
     */
    this._ribbon = null;
    /** the last half-thickness written, in DRAWN units, to avoid rewriting */
    this._weightAt = -1;
    /** stations in the last face built, for the suite */
    this.count = 0;
    /** hatch segments in the last face built, for the suite */
    this.hatchCount = 0;
  }

  /** @param {number} v */
  setExaggeration(v) { this.group.scale.z = v; }
  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  _clear() {
    for (const p of this._parts) {
      this.group.remove(p);
      // Cached letter sprites share their geometry class-wide in three.js;
      // disposing it here would blank every sprite in the scene.
      if (!(/** @type {any} */ (p).isSprite)) /** @type {any} */ (p).geometry?.dispose();
    }
    this._parts.length = 0;
    // ⚠️ THE RIBBON IS ONE OF THE PARTS JUST DISPOSED. Left pointing at a dead
    // geometry, the next `setScreenWeight` would write into a buffer nothing
    // draws — silently, because writing to a disposed attribute does not throw.
    this._ribbon = null;
    this._weightAt = -1;
    this.count = 0;
    this.hatchCount = 0;
  }

  /** @param {THREE.Object3D} o */
  _add(o) {
    /** @type {any} */ (o).frustumCulled = false;
    this.group.add(o);
    this._parts.push(o);
  }

  /**
   * Build the face for one section.
   *
   * @param {{s:Float64Array, x:Float64Array, y:Float64Array, now:Float64Array}} profile
   *   as `sampleSection` returns it — world coordinates, half-cell stations.
   *   ⚠️ The fields are `x` and `y`, not `xs`/`ys`; guessing them cost a run.
   *   ⚠️ AND IT IS THE EXTENDED PROFILE, spanning the plane's full crossing of
   *   the tile — not the stretch between the clicked points. See `anchors`.
   * @param {{baseZ:number, normal:number[], nudge?:number,
   *          anchors?:number[], name?:string, exaggeration?:number}} opts
   *   `normal` is the direction the clip KEEPS; the face is nudged along it.
   *   `anchors` are the two clicked points as STATIONS along the extended
   *   profile, in metres from its start; they get the verticals and the letter.
   */
  setSection(profile, opts) {
    this._clear();
    if (!profile || profile.s.length < 2) return;
    const { originX, originY, cell } = this.dem;
    const nudge = opts.nudge ?? cell * 0.02;
    const nx = opts.normal[0] * nudge, ny = opts.normal[1] * nudge;
    const base = opts.baseZ;
    // ⚠️ THE EXAGGERATION IS NEEDED AS A NUMBER HERE, not just as the group's z
    // scale, because the hatch has to be 45° ON SCREEN. An angle is not a
    // height: sheared by the group scale, a hatch generated in ground units
    // would come out at 45° only at 1.0× and lean at every other setting.
    const ex = opts.exaggeration ?? this.group.scale.z ?? 1;

    // -------------------------------------------------- the kept stations
    const S = [], X = [], Y = [], Z = [];
    for (let i = 0; i < profile.s.length; i++) {
      const z = profile.now[i];
      // ⚠️ A HOLE IN THE DEM BREAKS THE FACE, it does not bridge it. Carrying
      // the strip across a gap would draw solid ground where the survey has
      // none, which is the one thing a measured drawing must never do.
      if (!Number.isFinite(z)) continue;
      S.push(profile.s[i]);
      X.push(profile.x[i] - originX + nx);
      Y.push(profile.y[i] - originY + ny);
      Z.push(z);
    }
    const n = S.length;
    if (n < 2) return;

    /** station → local XY, by linear interpolation between samples */
    const at = (s) => {
      let i = 0;
      while (i + 2 < n && S[i + 1] < s) i++;
      const t = S[i + 1] === S[i] ? 0 : (s - S[i]) / (S[i + 1] - S[i]);
      return [X[i] + (X[i + 1] - X[i]) * t, Y[i] + (Y[i + 1] - Y[i]) * t,
              Z[i] + (Z[i + 1] - Z[i]) * t];
    };

    // -------------------------------------------------- the poché ground
    const pos = [];
    for (let i = 0; i < n; i++) pos.push(X[i], Y[i], Z[i], X[i], Y[i], base);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    const idx = [];
    for (let i = 0; i + 1 < n; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, this._fill);
    mesh.renderOrder = 6;
    this._add(mesh);
    this.count = n;

    // -------------------------------------------------- the hatch
    let hiZ = -Infinity;
    for (const z of Z) if (z > hiZ) hiZ = z;
    const height = Math.max((hiZ - base) * ex, cell);
    /**
     * ⚠️ SPACING IS SET BY THE FACE'S HEIGHT, NOT ITS LENGTH, and not by the
     * tile. The section view frames on the relief, so the height is what fills
     * the screen; spacing tied to the length would go coarse on a short cut and
     * invisible on a long one while the drawing looked the same size.
     */
    const sp = height / 13;
    const hatch = [];
    // A 45° family in drawn (s, Z) space is Z = s − c. Perpendicular spacing
    // between neighbours is |Δc| / √2, so the step is sp·√2.
    const step = sp * Math.SQRT2;
    const cMin = S[0] - hiZ * ex, cMax = S[n - 1] - base * ex;
    // A backstop, not a design parameter: a pathological aspect ratio must not
    // be allowed to spend minutes generating lines nobody can resolve.
    const MAX = 900;
    let lines = 0;
    for (let c = Math.ceil(cMin / step) * step; c <= cMax && lines < MAX; c += step, lines++) {
      for (let i = 0; i + 1 < n; i++) {
        const s0 = S[i], s1 = S[i + 1];
        const z0 = Z[i] * ex, z1 = Z[i + 1] * ex, bz = base * ex;
        // u ∈ [0,1] across the interval; both the hatch and the ground are
        // linear in u, so each constraint is one linear inequality.
        const ds = s1 - s0;
        // hatch above base:  (s0 − c − bz) + ds·u ≥ 0
        // ground above hatch: (z0 − s0 + c) + (dz − ds)·u ≥ 0
        let lo = 0, hi = 1;
        const clip = (A, B) => {
          if (Math.abs(B) < 1e-12) { if (A < 0) { lo = 1; hi = 0; } return; }
          const u = -A / B;
          if (B > 0) { if (u > lo) lo = u; } else if (u < hi) hi = u;
        };
        clip(s0 - c - bz, ds);
        clip(z0 - s0 + c, (z1 - z0) - ds);
        if (hi <= lo) continue;
        for (const u of [lo, hi]) {
          const s = s0 + ds * u;
          const p = at(s);
          hatch.push(p[0], p[1], (s - c) / ex);
        }
      }
    }
    if (hatch.length) {
      const hg = new THREE.BufferGeometry();
      hg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(hatch), 3));
      const hl = new THREE.LineSegments(hg, this._hatch);
      hl.renderOrder = 7;
      this._add(hl);
      this.hatchCount = hatch.length / 6;
    }

    // -------------------------------------------------- the ground line
    /**
     * ⚠️ A RIBBON, STRADDLING THE PROFILE. Hung below it instead, the drawn
     * ground would sit half a line-weight low — which is the difference between
     * a drafted line and a line that is wrong by its own thickness.
     */
    /**
     * ⚠️ MEASURED, NOT CHOSEN, AND NOW ONLY A STARTING VALUE. height/50 put the
     * ribbon at 2.9 px on the section view's own framing, which was right there
     * and wrong everywhere else — see `setScreenWeight`, which overwrites this
     * from the camera on the next frame. It is kept as the first write so the
     * face is never drawn with a zero-width line for one frame.
     */
    /**
     * ⚠️ A RIBBON, STRADDLING THE PROFILE. Hung below it instead, the drawn
     * ground would sit half a line-weight low — which is the difference between
     * a drafted line and a line that is wrong by its own thickness.
     */
    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position",
      new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    const widx = [];
    for (let i = 0; i + 1 < n; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      widx.push(a, b, c, b, d, c);
    }
    wg.setIndex(widx);
    const wm = new THREE.Mesh(wg, this._weight);
    wm.renderOrder = 8;
    this._add(wm);
    // The trace's own direction in plan. A section is a STRAIGHT line in plan,
    // so this is one vector for the whole ribbon rather than one per station.
    const tdx = X[n - 1] - X[0], tdy = Y[n - 1] - Y[0];
    const tl = Math.hypot(tdx, tdy) || 1;
    this._ribbon = { mesh: wm, X, Y, Z, S, n, ux: tdx / tl, uy: tdy / tl, ex };
    this._weightAt = -1;
    this._writeRibbon(height / 50 / ex);

    // -------------------------------------------------- the anchors
    /**
     * ⚠️ THESE ARE THE SECTION, and the face around them is only the ground the
     * plane happens to also cut. Without them the drawing would say the cut
     * runs the width of the tile, when what was actually asked for was the
     * stretch between two clicked points.
     */
    if (!opts.anchors) return;
    const top = hiZ + height * 0.10 / ex;
    for (const s of opts.anchors) {
      if (!Number.isFinite(s) || s < S[0] || s > S[n - 1]) continue;
      const p = at(s);
      const vg = new THREE.BufferGeometry();
      vg.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
        p[0], p[1], base, p[0], p[1], top,
      ]), 3));
      const vl = new THREE.Line(vg, this._edge);
      vl.renderOrder = 8;
      this._add(vl);

      const name = opts.name || "";
      if (!name) continue;
      let sprite = this._labels.get(name);
      if (!sprite) {
        // ⚠️ ALSO MEASURED. At 0.085 the letter came out 6 px and read as a
        // speck of dirt on the drawing rather than as the section reference.
        sprite = textSprite(name, { worldHeight: height * 0.26 / ex });
        this._labels.set(name, sprite);
      }
      // Both ends want the same letter — as they do on the plan, where a
      // section is A–A and not A–B. A clone shares the material and texture.
      const use = sprite.parent ? sprite.clone() : sprite;
      use.position.set(p[0], p[1], top + height * 0.17 / ex);
      this._add(use);
    }
  }

  /**
   * Rewrite the ground line at a given half-thickness, in DRAWN units.
   *
   * ⚠️ PERPENDICULAR TO THE PROFILE, NOT STRAIGHT DOWN IN Z. Offsetting purely
   * in z gives a band whose apparent width is `t·cos(slope)` — so the line
   * thins wherever the ground steepens and vanishes on a cliff, which is the
   * opposite of what a drafted line does. The offset runs along the in-plane
   * normal, so the width is the same on a terrace and on a batter.
   *
   * ⚠️ THE NORMAL IS AVERAGED BETWEEN THE TWO ADJACENT SEGMENTS. Taking one
   * segment's normal per vertex opens a wedge at every station where the ground
   * changes slope, and at 0.25 m stations that is most of them.
   * @param {number} t half-thickness, in drawn units
   */
  _writeRibbon(t) {
    const r = this._ribbon;
    if (!r || !(t > 0) || Math.abs(t - this._weightAt) < t * 0.02) return;
    this._weightAt = t;
    const { X, Y, Z, S, n, ux, uy, ex } = r;
    const pos = /** @type {THREE.BufferAttribute} */
      (r.mesh.geometry.getAttribute("position"));
    const a = /** @type {Float32Array} */ (pos.array);
    for (let i = 0; i < n; i++) {
      // tangent in the cut plane's own (along, up) coordinates, DRAWN units
      const i0 = i > 0 ? i - 1 : i, i1 = i + 1 < n ? i + 1 : i;
      const ds = S[i1] - S[i0];
      const dz = (Z[i1] - Z[i0]) * ex;
      const L = Math.hypot(ds, dz) || 1;
      // in-plane normal: rotate the tangent a quarter turn
      const ns = -dz / L, nz = ds / L;
      const ox = ux * ns * t, oy = uy * ns * t, oz = (nz * t) / ex;
      const o = i * 6;
      a[o]     = X[i] + ox; a[o + 1] = Y[i] + oy; a[o + 2] = Z[i] + oz;
      a[o + 3] = X[i] - ox; a[o + 4] = Y[i] - oy; a[o + 5] = Z[i] - oz;
    }
    pos.needsUpdate = true;
    r.mesh.geometry.computeBoundingSphere();
  }

  /**
   * Hold the ground line at a constant weight ON SCREEN.
   *
   * ⚠️⚠️ THE RIBBON IS WORLD-SPACE GEOMETRY, SO WITHOUT THIS IT FATTENS AS YOU
   * ZOOM IN (2026-09-02, Marc: "fix the section line weight to stay constant on
   * zoom"). Measured before: ~3 px at the section view's own framing and **78 px**
   * zoomed in, while every contour beside it stayed 1 px — so the closer you
   * looked, the more the cut line read as a slab rather than as a line.
   *
   * ⚠️ IT IS NOT `linewidth`, WHICH IS INERT, and it is not Line2 either. The
   * cut face is a known PLANE and the ribbon already lies in it, so the whole
   * fix is to rewrite the half-thickness from the camera each frame. No shader,
   * no new dependency, and the geometry stays inspectable.
   *
   * @param {number} worldPerPixel  drawn metres covered by one screen pixel
   * @param {number} [px]  the wanted TOTAL weight on screen
   */
  setScreenWeight(worldPerPixel, px = 3) {
    if (!(worldPerPixel > 0)) return;
    this._writeRibbon((px / 2) * worldPerPixel);
  }

  dispose() {
    this._clear();
    this._fill.dispose();
    this._hatch.dispose();
    this._edge.dispose();
    this._weight.dispose();
  }
}
