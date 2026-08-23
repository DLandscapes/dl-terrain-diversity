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

import * as THREE from "three";

/** Poché — the drawing convention for cut material. Warm, not black. */
const CUT_FILL = 0xcfc7b8;
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
    this._fill = new THREE.MeshBasicMaterial({
      color: CUT_FILL,
      // DoubleSide because which way the strip winds depends on the direction
      // the section happened to be drawn in, and a face that vanished when you
      // cut A→B instead of B→A would look like the feature not working. The
      // apron shipped inside out for exactly this reason.
      side: THREE.DoubleSide, fog: false,
    });
    this._edge = new THREE.LineBasicMaterial({
      color: CUT_EDGE, transparent: true, opacity: 0.9, fog: false,
    });
    /** @type {THREE.Object3D[]} */
    this._parts = [];
    /** stations in the last face built, for the suite */
    this.count = 0;
  }

  /** @param {number} v */
  setExaggeration(v) { this.group.scale.z = v; }
  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  _clear() {
    for (const p of this._parts) {
      this.group.remove(p);
      /** @type {any} */ (p).geometry?.dispose();
    }
    this._parts.length = 0;
    this.count = 0;
  }

  /**
   * Build the face for one section.
   *
   * @param {{s:Float64Array, x:Float64Array, y:Float64Array, now:Float64Array}} profile
   *   as `sampleSection` returns it — world coordinates, half-cell stations.
   *   ⚠️ The fields are `x` and `y`, not `xs`/`ys`; guessing them cost a run.
   * @param {{baseZ:number, normal:number[], nudge?:number}} opts
   *   `normal` is the direction the clip KEEPS; the face is nudged along it.
   */
  setSection(profile, opts) {
    this._clear();
    if (!profile || profile.s.length < 2) return;
    const { originX, originY, cell } = this.dem;
    const nudge = opts.nudge ?? cell * 0.02;
    const nx = opts.normal[0] * nudge, ny = opts.normal[1] * nudge;

    const pos = [];
    const top = [];
    let n = 0;
    for (let i = 0; i < profile.s.length; i++) {
      const z = profile.now[i];
      // ⚠️ A HOLE IN THE DEM BREAKS THE FACE, it does not bridge it. Carrying
      // the strip across a gap would draw solid ground where the survey has
      // none, which is the one thing a measured drawing must never do.
      if (!Number.isFinite(z)) continue;
      const lx = profile.x[i] - originX + nx;
      const ly = profile.y[i] - originY + ny;
      pos.push(lx, ly, z, lx, ly, opts.baseZ);
      top.push(lx, ly, z);
      n++;
    }
    if (n < 2) return;

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    // A triangle strip over pairs (top, base) — two triangles per station gap.
    const idx = [];
    for (let i = 0; i + 1 < n; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, this._fill);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    this.group.add(mesh);
    this._parts.push(mesh);

    // The ground line along the top of the face — the thing the eye reads as
    // "the profile", and the same line the section sheet draws.
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(top), 3));
    const line = new THREE.Line(lg, this._edge);
    line.frustumCulled = false;
    line.renderOrder = 7;
    this.group.add(line);
    this._parts.push(line);

    this.count = n;
  }

  dispose() {
    this._clear();
    this._fill.dispose();
    this._edge.dispose();
  }
}
