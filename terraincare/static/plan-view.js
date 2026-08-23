// @ts-check
/**
 * PLAN MODE — what the regions look like in the scene.
 *
 * plan.js owns the rings and runs headless. This file owns the three.js objects
 * that draw them, and nothing else: it has no notion of tools, modes or which
 * button is pressed, and it never mutates a region. Same split as
 * surface.js / app.js.
 *
 * ⚠️ GEOMETRY IS LOCAL AND THE UTM ORIGIN RIDES ON THE GROUP, exactly as it
 * does on the terrain mesh (see the long note in surface.js). Ring coordinates
 * arrive in map units — eastings near 5.6e5 and northings near 7.74e6 — and a
 * float32 at that northing has a ULP of 0.5 m. Baking them into a vertex buffer
 * would quantise every vertex to a half-metre grid: a ring traced at 0.25 m
 * would render with its vertices visibly snapped, and worse, it would render
 * snapped while the polygon the LEVELLER used stayed exact, so the outline
 * would no longer show which cells were about to move. The group carries the
 * origin, where three.js matrix maths is float64. Defended in render group R9.
 *
 * VERTICAL EXAGGERATION rides on the group too, as scale.z, so geometry always
 * holds true metres and nothing here has to be rebuilt when the slider moves.
 */

import * as THREE from "three";
import { zAtWorld } from "./plan.js";

/** Ink, matching the sidebar's --ink. Chrome in this tool is achromatic. */
const INK = 0x26241f;
/**
 * The one exception, and it is inherited rather than invented: annotation fills
 * in this app are --card at low alpha (`#overlay svg polygon` in style.css).
 * A drawn region is that same kind of object — a mark ON the site rather than a
 * measurement OF it — so it takes the same fill.
 */
const CARD = 0xd9c39a;

/**
 * Metres the draped outline floats above the ground it is draped on.
 *
 * Tiny, and mostly ceremonial: every material here has depthTest off and a high
 * renderOrder, so the rings are drawn over the terrain whatever their depth.
 * That is deliberate. In a top orthographic view a ring lying exactly in the
 * surface ties with it at every pixel, and a depth tie resolved per-fragment is
 * the shimmer this project already fixed once on the wireframe. Turning the
 * test off settles it once, and a drawing overlay that is occasionally hidden
 * behind a mound would be worse than one that is always legible.
 */
const LIFT = 0.02;

/**
 * A polyline offset sideways by a constant distance — the corridor edge.
 *
 * ⚠️ DRAWING ONLY, AND DELIBERATELY NOT A MITRE JOIN. Each segment is offset
 * along its own normal and the results are joined vertex to vertex, which on a
 * bend leaves the two offset segments meeting slightly inside a true mitre. The
 * ground truth is `applyGuide`'s own perpendicular-distance test, which takes
 * the NEAREST segment, and that is exactly the rounded join this approximation
 * produces — so the line drawn here is closer to what the kernel will actually
 * cut than a mitred outline would be. A mitre would draw a sharp corner the
 * earthwork does not have.
 *
 * @param {number[][]} pts @param {number} d signed offset in map units
 */
function offsetPolyline(pts, d) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const vx = x2 - x1, vy = y2 - y1;
    const L = Math.hypot(vx, vy);
    if (L === 0) continue;
    // The left normal of the direction of travel, matching projectToPolyline's
    // sign convention: negative offsets fall to the left.
    const nx = -vy / L, ny = vx / L;
    if (!out.length) out.push([x1 + nx * d, y1 + ny * d]);
    out.push([x2 + nx * d, y2 + ny * d]);
  }
  return out;
}

/** Ring outlines, region fills and vertex handles for one terrain. */
export class PlanOverlay {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number, pixelRatio?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.exaggeration = opts.verticalExaggeration ?? 1;
    /**
     * gl_PointSize is in DEVICE pixels and three.js does not scale it by the
     * renderer's pixel ratio, which this app pins at 2 for supersampling. Left
     * unscaled the vertex handles come out half the intended size on every
     * screen — small enough to be hard to grab, which reads as the editing not
     * working rather than as the handles being small.
     */
    this.pixelRatio = opts.pixelRatio ?? 1;

    this.group = new THREE.Group();
    // ⚠️ The origin lives HERE, never in a vertex buffer. See the header.
    this.group.position.set(dem.originX, dem.originY, 0);
    this.group.scale.set(1, 1, this.exaggeration);
    this.group.renderOrder = 10;

    /** everything belonging to committed regions */
    this.regionGroup = new THREE.Group();
    /** the ring currently being traced, plus its rubber band */
    this.draftGroup = new THREE.Group();
    /** the guide curve — a centreline, not a boundary */
    this.guideGroup = new THREE.Group();
    this.group.add(this.regionGroup, this.draftGroup, this.guideGroup);

    /** @type {THREE.Material[]} */
    this._materials = [];
    this._line = this._makeLine(INK, 0.85);
    this._lineSoft = this._makeLine(INK, 0.4);
    this._draftLine = this._makeLine(INK, 0.85);
    this._handles = this._makePoints(INK, 9);
    this._draftHandles = this._makePoints(INK, 7);
    this._fill = this._makeFill(0.3);
    this._fillSoft = this._makeFill(0.14);
    // ⚠️ A CENTRELINE IS NOT A BOUNDARY, and it must not be drawn as one. A ring
    // says "this ground"; a guide says "along here, and the structure spreads
    // either side of me". They are drawn differently for the same reason the
    // photo pins and the pond pins are: two different claims that look alike
    // will be read as one. The centreline is a heavier solid line, its corridor
    // edges are lighter, and neither is ever closed.
    this._guideLine = this._makeLine(INK, 0.95);
    this._guideEdge = this._makeLine(INK, 0.35);
    this._guideHandles = this._makePoints(INK, 9);
  }

  _makeLine(color, opacity) {
    const m = new THREE.LineBasicMaterial({
      color, transparent: true, opacity,
      depthTest: false, depthWrite: false, fog: false,
    });
    this._materials.push(m);
    return m;
  }

  _makePoints(color, sizeCss) {
    const m = new THREE.PointsMaterial({
      color, size: sizeCss * this.pixelRatio, sizeAttenuation: false,
      transparent: true, depthTest: false, depthWrite: false, fog: false,
    });
    this._materials.push(m);
    return m;
  }

  _makeFill(opacity) {
    const m = new THREE.MeshBasicMaterial({
      color: CARD, transparent: true, opacity,
      // DoubleSide because the plate is horizontal and a region levelled below
      // the camera's eye line is seen from underneath the moment the view
      // leaves plan. A one-sided plate would simply vanish there.
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false,
    });
    this._materials.push(m);
    return m;
  }

  /** @param {number} v */
  setExaggeration(v) {
    this.exaggeration = v;
    this.group.scale.z = v;
  }

  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  /** World (x, y) to the group's local frame. */
  _local(x, y) {
    return [x - this.dem.originX, y - this.dem.originY];
  }

  /**
   * A ring as a flat local XYZ array, draped on the terrain.
   *
   * A vertex over a hole in the DEM keeps the last finite elevation rather than
   * carrying NaN into the buffer, where it would silently blank the whole line:
   * one NaN vertex makes the segments either side of it disappear, which looks
   * like a broken ring rather than like missing ground.
   * @param {number[][]} ring
   */
  _drape(ring) {
    const out = new Float32Array(ring.length * 3);
    let lastZ = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = ring[i];
      const [lx, ly] = this._local(x, y);
      let z = zAtWorld(this.dem, x, y);
      if (!Number.isFinite(z)) z = lastZ; else lastZ = z;
      out[i * 3] = lx; out[i * 3 + 1] = ly; out[i * 3 + 2] = z + LIFT;
    }
    return out;
  }

  /** @param {Float32Array} xyz */
  _positions(xyz) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(xyz, 3));
    return g;
  }

  /**
   * Redraw every committed region.
   * @param {import("./plan.js").Region[]} regions
   * @param {number|null} selectedId
   */
  setRegions(regions, selectedId = null) {
    this._clear(this.regionGroup);
    for (const region of regions) {
      // ⚠️ HIDDEN MEANS NOT DRAWN AT ALL, not drawn faintly. A half-visible
      // plate over the terrain is still a plate over the terrain, and the whole
      // reason to hide one is to look at the ground underneath it.
      if (region.hidden) continue;
      const on = region.id === selectedId;

      // The design plate, at the level the region is to be brought to. It sits
      // where the ground is ASKED to be, while the outline below is draped on
      // where the ground IS — so the gap between them is the cut or the fill,
      // standing in the viewport before any earth is moved.
      const shape = new THREE.Shape(
        region.rings[0].map(([x, y]) => new THREE.Vector2(...this._local(x, y))));
      for (let i = 1; i < region.rings.length; i++) {
        shape.holes.push(new THREE.Path(
          region.rings[i].map(([x, y]) => new THREE.Vector2(...this._local(x, y)))));
      }
      const plate = new THREE.Mesh(new THREE.ShapeGeometry(shape), on ? this._fill : this._fillSoft);
      plate.position.z = region.level_m + LIFT;
      plate.frustumCulled = false;
      plate.renderOrder = 10;
      this.regionGroup.add(plate);

      for (const ring of region.rings) {
        const line = new THREE.LineLoop(
          this._positions(this._drape(ring)), on ? this._line : this._lineSoft);
        line.frustumCulled = false;
        line.renderOrder = 11;
        this.regionGroup.add(line);

        // Handles only on the selected region. Every vertex of every region at
        // once turns a plan with six platforms in it into a field of dots.
        if (!on) continue;
        const pts = new THREE.Points(this._positions(this._drape(ring)), this._handles);
        pts.frustumCulled = false;
        pts.renderOrder = 12;
        this.regionGroup.add(pts);
      }
    }
  }

  /**
   * Redraw the ring being traced.
   * @param {number[][]} vertices placed so far
   * @param {number[]|null} cursor live pointer position, for the rubber band
   */
  setDraft(vertices, cursor) {
    this._clear(this.draftGroup);
    if (!vertices.length) return;
    const path = cursor ? [...vertices, cursor] : vertices;
    if (path.length >= 2) {
      // An open polyline, not a loop: the ring is not closed until the user
      // closes it, and drawing the closing segment early would make a
      // three-vertex sketch look like a finished triangle.
      const line = new THREE.Line(this._positions(this._drape(path)), this._draftLine);
      line.frustumCulled = false;
      line.renderOrder = 11;
      this.draftGroup.add(line);
    }
    const pts = new THREE.Points(this._positions(this._drape(vertices)), this._draftHandles);
    pts.frustumCulled = false;
    pts.renderOrder = 12;
    this.draftGroup.add(pts);
  }

  /**
   * Redraw the guide curve: its centreline, its handles, and the edges of the
   * corridor the section will occupy.
   *
   * ⚠️ THE CORRIDOR IS DRAWN, NOT LEFT TO THE IMAGINATION. A centreline alone
   * tells a designer where the structure runs and nothing about how much ground
   * it takes — and the half-width is an OUTPUT of the section (w/2 + D/tanθ),
   * so it is precisely the number that cannot be guessed from the controls. The
   * two offset lines are the mask boundary the ledger will be charged for.
   *
   * @param {number[][]} pts the centreline
   * @param {number[]|null} cursor live pointer, for the rubber band
   * @param {number} halfWidth metres, 0 to draw the line alone
   */
  setGuide(pts, cursor = null, halfWidth = 0) {
    this._clear(this.guideGroup);
    if (!pts || !pts.length) return;
    const path = cursor ? [...pts, cursor] : pts;
    if (path.length >= 2) {
      const line = new THREE.Line(
        this._positions(this._drape(path)), this._guideLine);
      line.frustumCulled = false;
      line.renderOrder = 11;
      this.guideGroup.add(line);

      if (halfWidth > 0) {
        for (const side of [-1, 1]) {
          const off = offsetPolyline(path, side * halfWidth);
          if (off.length < 2) continue;
          const e = new THREE.Line(
            this._positions(this._drape(off)), this._guideEdge);
          e.frustumCulled = false;
          e.renderOrder = 11;
          this.guideGroup.add(e);
        }
      }
    }
    const h = new THREE.Points(this._positions(this._drape(pts)), this._guideHandles);
    h.frustumCulled = false;
    h.renderOrder = 12;
    this.guideGroup.add(h);
  }

  /** @param {THREE.Group} g */
  _clear(g) {
    for (const child of g.children) {
      /** @type {any} */ (child).geometry?.dispose();
    }
    g.clear();
  }

  dispose() {
    this._clear(this.regionGroup);
    this._clear(this.draftGroup);
    this._clear(this.guideGroup);
    for (const m of this._materials) m.dispose();
    this._materials.length = 0;
  }
}
