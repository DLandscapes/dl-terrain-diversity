// @ts-check
// The terrain surface: a heightfield mesh in world coordinates, Z = elevation.
//
// This takes the deliberately boring CPU path — vertex positions written
// directly into the position attribute, with dirty-rect partial uploads and
// locally recomputed normals. There is no GLSL anywhere in this office's
// codebase, and a ShaderMaterial with float-texture displacement would be a
// day of learning float-texture formats for a grid where 130k triangles is
// nothing on any GPU made this decade. Treat the shader route as an
// optimisation to reach for only if measurement demands it.
//
// Vertex colours carry the shading so the surface can be tinted by an analysis
// layer later without swapping materials.

import * as THREE from "three";
import { DEM } from "./dem.js";
import { latticeEdges } from "./lattice.js";
import { contourSegments, niceInterval } from "./contours.js";

export class Surface {
  /**
   * @param {DEM} dem
   * @param {{verticalExaggeration?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.exaggeration = opts.verticalExaggeration ?? 1;
    /**
     * Per-cell ambient occlusion, 0..1 (1 = fully open sky). Supplied by the
     * worker's sky-view factor once a gesture settles. Lambert shading alone
     * makes a heightfield read as a flat sheet with light on it, because every
     * facet is lit purely by its own normal and nothing knows it is sitting
     * inside a hollow. Multiplying in sky-view factor is what gives the surface
     * plasticity — a scooped basin darkens towards its floor the way a real one
     * does, and micro-relief that a normal barely registers becomes legible.
     * @type {Float32Array|null}
     */
    this.ao = null;
    /**
     * How strongly sky-view occlusion darkens the surface.
     *
     * Was 0.85, which drove the darkest hollows to 15% of the base tone — the
     * relief shading read as murky, and because every analysis layer is
     * multiplied by this same term, it dragged those down with it. Occlusion
     * should model the sky a point cannot see, not act as a contrast control.
     */
    this.aoStrength = opts.aoStrength ?? 0.5;
    /** Percentile bounds of the current occlusion grid — see setAO(). */
    this._aoLo = 0;
    this._aoHi = 1;
    /** 0..1 share of aoStrength currently applied — see the fade in setAO(). */
    this._aoFade = 1;
    /** rAF id of a fade in flight, 0 otherwise. */
    this._aoAnim = 0;
    /**
     * Optional analysis layer painted onto the terrain, as the RGBA buffer the
     * worker already produced for the matching sidebar panel. Reusing that
     * buffer rather than re-deriving a colour here means the 3D view and the
     * panel cannot disagree: same ramp, same percentile stretch, same sign
     * conventions, one code path through analysis/ramps.js.
     * @type {Uint8ClampedArray|null}
     */
    this.layer = null;

    const { nrows, ncols, cell, originX, originY } = dem;
    this.geometry = new THREE.BufferGeometry();

    const vertexCount = nrows * ncols;
    this.positions = new Float32Array(vertexCount * 3);
    this.colors = new Float32Array(vertexCount * 3);
    this.normals = new Float32Array(vertexCount * 3);

    // XY from the grid, Z from the DEM. Row 0 is the NORTH edge, so Y
    // decreases as the row index increases — keeping that here means every
    // downstream world<->cell conversion agrees with dem.xy().
    //
    // GEOMETRY IS LOCAL: X/Y start at 0, and the UTM origin goes into
    // mesh.position instead. GPU vertex buffers are float32, and at this
    // site's northing (~7 737 700) a float32's ULP is 0.5 m — storing world
    // coordinates in the buffer quantised every vertex to a half-metre N-S
    // grid, silently collapsing PAIRS of 0.25 m rows onto the same
    // coordinate (measured: 129 distinct Y values across 256 rows) and
    // tearing the voxel field apart at small block sizes. The object
    // translation takes the same huge numbers through the CPU instead, where
    // matrices are float64 and the model and view translations cancel before
    // anything is narrowed to float32 — the standard relative-to-center
    // approach, and exactly why the world-positioned GridHelper always
    // rendered clean while the world-baked terrain did not.
    const northY = nrows * cell; // LOCAL north edge; world origin is on the mesh
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        const i = r * ncols + c;
        const o = i * 3;
        this.positions[o] = (c + 0.5) * cell;
        this.positions[o + 1] = northY - (r + 0.5) * cell;
        this.positions[o + 2] = 0; // filled by updateAll()
        this.normals[o + 2] = 1;
      }
    }

    // Triangle indices. Quads split consistently so the diagonal does not
    // alternate and produce a visible herringbone on smooth ground.
    /**
     * Cell rect this surface leaves open, or null. Set by `setHole()` when a
     * finer tile is drawn over part of this one.
     * @type {{r0:number,c0:number,r1:number,c1:number}|null}
     */
    this.hole = opts.holeCells ?? null;
    const indices = this._triangleIndex();

    const posAttr = new THREE.BufferAttribute(this.positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const normAttr = new THREE.BufferAttribute(this.normals, 3);
    normAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(this.colors, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry.setAttribute("position", posAttr);
    this.geometry.setAttribute("normal", normAttr);
    this.geometry.setAttribute("color", colAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // FrontSide, not DoubleSide. A heightfield is a function graph — there is
    // nothing meaningful underneath it — and rendering both faces made the
    // front and back of the same surface compete for depth at grazing angles,
    // which is what produced dark and flickering triangles while orbiting. The
    // camera's pitch is floored just above the horizon (view.js) so the
    // underside is never the thing you are looking at.
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
      // The scene fog exists only to fade the ground grid out to infinity
      // (view.js). Terrain must not fade with it — the far edge of the tile is
      // real information, and at the grazing camera angles this tool is used
      // at, most of the surface sits past the fog's near plane.
      fog: false,
      // HARD shading. Interpolated normals draw a smooth skin over the samples
      // and quietly imply the terrain is known between them, which is the
      // opposite of what this tool argues: the model is a discrete measurement
      // at 0.25 m, and the micro-relief that generates habitat lives at exactly
      // that scale. Flat shading gives every triangle one tone, so each facet
      // is a sample you can see, and it makes a scooped basin read as built
      // ground rather than a soft dent. It costs nothing — three.js derives the
      // face normal in the fragment shader, so the indexed geometry and its
      // per-vertex normal attribute stay exactly as they are.
      flatShading: true,
      // NO polygon offset. It was the flicker. The offset's `factor` term
      // scales with each triangle's own screen-space depth slope, so with the
      // lattice running exactly along triangle edges the margin the lines won
      // by was different for every facet and every camera angle — at grazing
      // pitches the winner flipped frame to frame, which is the shimmering in
      // the 2026-07-30 screen capture. The depth bias now lives on the LINE
      // material instead, as a constant clip-space push (see _buildWire),
      // which is how Blender's overlay wireframe does it: bias the wire, not
      // the surface, and bias it by a constant in NDC so no geometry- or
      // view-dependent term can vary the outcome.
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    // The UTM origin lives here, not in the vertex buffer — see the note on
    // the position loop above. Picking still returns world points (the
    // raycaster applies matrixWorld in float64), so nothing downstream cares.
    this.mesh.position.set(originX, originY, 0);

    // WIREFRAME. Its job changed when the shading went hard: flat facets
    // already show where every sample is, so a lattice at anything near cell
    // spacing now competes with them and reads as noise — measured by eye at 8
    // cells, where the far field turned to hatching. What the facets cannot
    // give is SCALE, so the lattice provides that instead: 16 divisions across
    // the tile, subdivided cell by cell so it lies on the surface.
    //
    // 16 divisions is not arbitrary on either tile. On the 64 m design patch it
    // draws a 4 m grid — the cell size of the national terrain data, so the
    // squares are exactly what hoydedata.no can resolve and every facet inside
    // one is relief it cannot see. On the 1 km context tile the same rule draws
    // 64 m squares, which is the design patch's own footprint. The two tiles
    // are 16x nested, and this is that nesting made visible.
    const shortSide = Math.min(nrows, ncols);
    this.wireStep = opts.wireStep ?? Math.max(1, Math.round(shortSide / 16));
    this._buildWire();

    /**
     * Contour interval in metres, or 0 for off. Off by default: the lattice
     * already carries scale, and two families of line work on the same surface
     * compete unless the user has asked for the second.
     */
    this.contourInterval = 0;
    /** @type {THREE.LineSegments|null} */
    this.contours = null;
    /** Segments in the last rebuild, for the readout. */
    this.contourSegmentCount = 0;
    this._buildContours();

    this.updateAll();
  }

  /**
   * The contour lines. Unlike the lattice, these CANNOT share the surface's
   * position buffer: a contour vertex sits between grid vertices, so the line
   * work is its own geometry and has to be rebuilt whenever the ground moves.
   * That is the whole cost of the feature, and it is why contours.js goes to
   * the trouble of testing each triangle only against the levels that actually
   * pass through it.
   */
  _buildContours() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    const mat = new THREE.LineBasicMaterial({
      // Darker and more opaque than the lattice (0x3a352c at 0.22). The lattice
      // is apparatus and should sit behind the terrain; a contour is a reading
      // OF the terrain and has to survive being drawn over a saturated analysis
      // ramp, which is the case it will most often be looked at in.
      color: 0x1c1a16, transparent: true, opacity: 0.55, depthWrite: false,
      fog: false,
    });
    // The same constant clip-space bias the wireframe carries, and for the same
    // reason: these segments lie exactly IN the triangles, so line-versus-face
    // is a depth tie at every pixel, and only a bias that is constant in NDC
    // settles every tie the same way at every camera angle. Slightly stronger
    // than the lattice's so that where a contour crosses a lattice line the
    // contour wins, rather than the two flickering for the pixel.
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n" +
        "\tgl_Position.z -= 3.0e-4 * gl_Position.w;",
      );
    };
    this.contours = new THREE.LineSegments(g, mat);
    this.contours.frustumCulled = false;
    this.contours.visible = false;
    this.mesh.add(this.contours);
  }

  /**
   * Rebuild the contour geometry from the DEM as it stands.
   *
   * Called after anything that moves the ground, and after a change of vertical
   * exaggeration — the lines are drawn at the exaggerated height because they
   * have to lie on the surface as DISPLAYED, while the levels they represent
   * stay true elevations.
   */
  refreshContours() {
    if (!this.contours) return;
    const on = this.contourInterval > 0;
    this.contours.visible = on;
    if (!on) { this.contourSegmentCount = 0; return; }
    const { z, nrows, ncols, cell } = this.dem;
    const { positions, segments } = contourSegments(
      z, nrows, ncols, cell, this.contourInterval,
      { exaggeration: this.exaggeration });
    this.contourSegmentCount = segments;
    const g = this.contours.geometry;
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setDrawRange(0, positions.length / 3);
    g.computeBoundingSphere();
  }

  /**
   * @param {number} metres 0 turns contours off
   */
  setContourInterval(metres) {
    this.contourInterval = metres > 0 ? metres : 0;
    this.refreshContours();
  }

  /** The interval this surface would choose for itself, from the 1-2-5 series. */
  suggestedContourInterval() {
    const [lo, hi] = this.dem.zRange();
    return Number.isFinite(lo) && Number.isFinite(hi) ? niceInterval(hi - lo) : 1;
  }

  /**
   * The triangle index, minus any quad that touches `this.hole`.
   *
   * ⚠️ THE VERTICES STAY. Only the index shrinks — the position, normal and
   * colour buffers keep their full 256² and every dirty-rect update, ramp
   * repaint and lattice share continues to address cells by `r * ncols + c`.
   * Compacting the vertex buffer instead would renumber every one of them, and
   * every rect in the app is expressed in cell indices.
   */
  _triangleIndex() {
    const { nrows, ncols } = this.dem;
    const h = this.hole;
    // A quad spans cells (r,c)…(r+1,c+1); drop it if ANY corner is in the hole,
    // so no triangle reaches into the opening from outside it.
    const covered = (r, c) => h
      && r + 1 >= h.r0 && r <= h.r1 && c + 1 >= h.c0 && c <= h.c1;
    let quads = 0;
    for (let r = 0; r < nrows - 1; r++) {
      for (let c = 0; c < ncols - 1; c++) if (!covered(r, c)) quads++;
    }
    const IndexArray = nrows * ncols > 65535 ? Uint32Array : Uint16Array;
    const indices = new IndexArray(quads * 6);
    let k = 0;
    for (let r = 0; r < nrows - 1; r++) {
      for (let c = 0; c < ncols - 1; c++) {
        if (covered(r, c)) continue;
        const a = r * ncols + c, b = a + 1, d = a + ncols, e = d + 1;
        indices[k++] = a; indices[k++] = d; indices[k++] = b;
        indices[k++] = b; indices[k++] = d; indices[k++] = e;
      }
    }
    return indices;
  }

  /**
   * Stop drawing the ground a finer tile is already drawing.
   *
   * ⚠️ BOTH INDICES, ALWAYS. The mesh and the lattice keep separate index
   * buffers over one shared position buffer, so cutting only the mesh leaves a
   * wireframe grid hanging in the opening.
   * @param {{r0:number,c0:number,r1:number,c1:number}|null} rect cells, inclusive
   */
  setHole(rect) {
    this.hole = rect;
    this.geometry.setIndex(new THREE.BufferAttribute(this._triangleIndex(), 1));
    this.geometry.computeBoundingSphere();
    if (this.wire) {
      const { nrows, ncols } = this.dem;
      this.wire.geometry.setIndex(new THREE.BufferAttribute(
        latticeEdges(nrows, ncols, this.wireStep, this.hole, { diagonals: false }), 1));
    }
  }

  /**
   * Build the lattice as an INDEXED line list over the surface's own position
   * attribute. Sharing the vertex buffer means the wireframe deforms with the
   * terrain for free — no second copy of the heightfield to keep in step, and
   * nothing to update when a brush stroke moves vertices. Because every index
   * pair is a real triangle edge, sharing the buffer also means every line is
   * exactly on the surface rather than merely near it.
   */
  _buildWire() {
    const { nrows, ncols } = this.dem;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", this.geometry.getAttribute("position"));
    g.setIndex(new THREE.BufferAttribute(
      latticeEdges(nrows, ncols, this.wireStep, this.hole, { diagonals: false }), 1));
    // Opacity 0.22, up from 0.16. At 0.11 the lattice measured a 15-luma drop
    // against a 212-luma surface and simply lost to the facets; the coarser
    // spacing is what buys the room to draw it stronger without crowding.
    const wireMat = new THREE.LineBasicMaterial({
      color: 0x3a352c, transparent: true, opacity: 0.22, depthWrite: false,
      fog: false, // as the surface: only the ground grid fades
    });
    // Constant clip-space depth bias, the way Blender's overlay wireframe does
    // it (overlay_wireframe_vert.glsl: `gl_Position.z -= ndc_offset_factor *
    // 0.5`). The lines lie exactly IN the triangle edges, so line-vs-face is a
    // depth tie at every pixel; a bias that is constant in NDC settles every
    // tie the same way at every angle. The polygon-offset scheme this replaces
    // biased the FACES instead, and its slope-proportional term made the
    // margin different per facet and per frame — the lattice shimmered during
    // orbit, worst at grazing pitches.
    //
    // This is the one shader patch in the codebase, and it is one line. The
    // "no GLSL" rule in the header stands for authored materials; this is the
    // documented exception the header reserves for when measurement demands
    // it — no fixed-function state expresses "bias lines, not polygons"
    // (glPolygonOffset does not apply to GL_LINES).
    wireMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n" +
        "\tgl_Position.z -= 2.0e-4 * gl_Position.w;",
      );
    };
    this.wire = new THREE.LineSegments(g, wireMat);
    this.wire.frustumCulled = false;
    this.mesh.add(this.wire);
  }

  /** @param {boolean} on */
  setWireframe(on) {
    if (this.wire) this.wire.visible = !!on;
  }

  /** Rewrite every vertex from the DEM. Use at load, or after a global change. */
  updateAll() {
    this.updateRect(0, 0, this.dem.nrows - 1, this.dem.ncols - 1);
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
  }

  /**
   * Rewrite elevations, normals and colours over a cell rectangle (inclusive).
   * Normals need one cell of margin because a vertex's normal depends on its
   * neighbours, so the written window is expanded by 1 before shading.
   * @param {number} r0 @param {number} c0 @param {number} r1 @param {number} c1
   */
  updateRect(r0, c0, r1, c1) {
    const { z, nrows, ncols } = this.dem;
    const ex = this.exaggeration;

    r0 = Math.max(0, r0); c0 = Math.max(0, c0);
    r1 = Math.min(nrows - 1, r1); c1 = Math.min(ncols - 1, c1);
    if (r1 < r0 || c1 < c0) return;

    // 1. elevations
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * ncols + c;
        const v = z[i];
        this.positions[i * 3 + 2] = Number.isFinite(v) ? v * ex : 0;
      }
    }

    // 2. normals + colours, one cell wider so seams are shaded consistently
    const nr0 = Math.max(0, r0 - 1), nc0 = Math.max(0, c0 - 1);
    const nr1 = Math.min(nrows - 1, r1 + 1), nc1 = Math.min(ncols - 1, c1 + 1);
    const cell = this.dem.cell;
    for (let r = nr0; r <= nr1; r++) {
      const rN = r > 0 ? r - 1 : 0;
      const rS = r < nrows - 1 ? r + 1 : nrows - 1;
      for (let c = nc0; c <= nc1; c++) {
        const i = r * ncols + c;
        const cW = c > 0 ? c - 1 : 0;
        const cE = c < ncols - 1 ? c + 1 : ncols - 1;

        const zW = this.positions[(r * ncols + cW) * 3 + 2];
        const zE = this.positions[(r * ncols + cE) * 3 + 2];
        const zN = this.positions[(rN * ncols + c) * 3 + 2];
        const zS = this.positions[(rS * ncols + c) * 3 + 2];

        // Central differences in world axes. Row index increases southward, so
        // dz/dy_world = (zN - zS) / span.
        const spanX = (cE - cW) * cell;
        const spanY = (rS - rN) * cell;
        const gx = spanX > 0 ? (zE - zW) / spanX : 0;
        const gy = spanY > 0 ? (zN - zS) / spanY : 0;

        // Surface normal of z = f(x,y) is (-dz/dx, -dz/dy, 1), normalised.
        let nx = -gx, ny = -gy, nz = 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        const o = i * 3;
        this.normals[o] = nx / len;
        this.normals[o + 1] = ny / len;
        this.normals[o + 2] = nz / len;

        // Base tone: warm stone, darker on steeper ground, and darkened again
        // by how little sky the point can see. The steepness term alone reads
        // as a flat sheet; the sky-view term is what makes hollows look like
        // hollows and gives the micro-relief its plasticity.
        const steep = Math.min(1, Math.hypot(gx, gy));
        let shade = 1 - steep * 0.18;
        if (this.ao) {
          const v = this.ao[i];
          if (Number.isFinite(v)) {
            // ⚠️ STRETCHED TO THIS SURFACE'S OWN SKY-VIEW RANGE, not to a fixed
            // 0.55–1.0 guess. The guess was the same class of mistake ramps.js
            // was corrected for in July — a fixed domain that turns out to sit
            // off the end of the data — and it cost most of the occlusion:
            // measured on the Ørndalen patch, sky-view runs 0.67 to 1.00, so
            // the bottom third of the assumed range was never reached and the
            // MEDIAN cell came out at 0.94 brightness. The relief was being
            // shaded by six percent.
            //
            // Percentile-stretched per surface, which is exactly the rule every
            // sequential analysis layer already follows and the reason they were
            // stretched in the first place: sky-view is scale- and
            // site-dependent, so one fixed domain cannot serve a quarry floor
            // and a mountainside.
            const lo = this._aoLo, hi = this._aoHi;
            const openness = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 1;
            shade *= 1 - this.aoStrength * this._aoFade * (1 - openness);
          }
        }
        if (this.flat) {
          // "None": plain white, with only the lighting rig shaping it. No
          // occlusion and no steepness term, so the terrain reads as an
          // uncoloured physical model — useful as a neutral base for a figure,
          // and as a way to see the form without any analysis interpreting it.
          this.colors[o] = 1; this.colors[o + 1] = 1; this.colors[o + 2] = 1;
        } else if (this.layer) {
          // Analysis colour, still shaded by the terrain so form stays legible
          // underneath it. The occlusion is eased off because a saturated ramp
          // carries its own contrast and would otherwise go muddy in hollows.
          const q = i * 4;
          const lit = 0.35 + 0.65 * shade;
          this.colors[o] = (this.layer[q] / 255) * lit;
          this.colors[o + 1] = (this.layer[q + 1] / 255) * lit;
          this.colors[o + 2] = (this.layer[q + 2] / 255) * lit;
        } else {
          // Neutral grey, not warm stone. The base shader is the reference the
          // analysis layers are read against, so it should carry no hue of its
          // own — any colour here would tint every layer painted over it and
          // compete with ramps whose whole job is to mean something.
          const g = 0.95 * shade;
          this.colors[o] = g;
          this.colors[o + 1] = g;
          this.colors[o + 2] = g;
        }
      }
    }

    // 3. partial uploads. Attribute update ranges are in ELEMENTS (floats), and
    // the rows written form one contiguous span from the first to the last
    // touched vertex — uploading that span is far cheaper than a full re-upload
    // and much simpler than one range per row.
    const first = (nr0 * ncols + nc0) * 3;
    const last = (nr1 * ncols + nc1) * 3 + 3;
    const posAttr = this.geometry.getAttribute("position");
    const normAttr = this.geometry.getAttribute("normal");
    const colAttr = this.geometry.getAttribute("color");
    for (const attr of [posAttr, normAttr, colAttr]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(first, last - first);
      attr.needsUpdate = true;
    }
  }

  /** World-space bounding box, respecting vertical exaggeration. */
  boundingBox() {
    this.geometry.computeBoundingBox();
    // Geometry is local (see constructor); shift back into world for framing.
    return /** @type {THREE.Box3} */ (this.geometry.boundingBox).clone()
      .translate(this.mesh.position);
  }

  /**
   * @param {number} v
   */
  setExaggeration(v) {
    this.exaggeration = v;
    this.updateAll();
    this.refreshContours();
  }

  /**
   * Supply a sky-view-factor grid to shade with. Arrives from the worker after
   * a gesture settles, so during a drag the surface simply keeps the previous
   * occlusion — which is correct, because the AO of ground you have not touched
   * has not changed.
   * @param {Float32Array|null} ao
   */
  setAO(ao) {
    // ⚠️ THE FIRST OCCLUSION FOR A SURFACE FADES IN; EVERY LATER ONE STEPS.
    // Sky-view lands seconds after a tile is adopted — measured 2.5 s on a
    // 512² drop, longer still on bigger ones — and it used to arrive as one
    // full-strength recolour of the whole model, mid-gesture if the user had
    // already started painting. Reported as "a sudden change in the shader
    // appearance over the whole model", which is exactly what it was. Later
    // arrivals only re-stretch an occlusion that is already showing, so their
    // deltas are small and a fade would just make every settle feel elastic.
    const first = !this.ao && !!ao && this.aoStrength > 0;
    this.ao = ao;
    // The stretch is computed ONCE per occlusion grid, not per vertex: the
    // per-cell loop below runs 65 536 times per refresh and a percentile sweep
    // inside it would be the whole cost of the pass.
    this._aoLo = 0; this._aoHi = 1;
    if (ao && ao.length) {
      const v = [];
      // Every 7th cell is plenty for a percentile on 65k samples and keeps the
      // sort off the critical path — the same sampling the ramps use.
      for (let i = 0; i < ao.length; i += 7) if (Number.isFinite(ao[i])) v.push(ao[i]);
      if (v.length > 16) {
        v.sort((a, b) => a - b);
        this._aoLo = v[Math.floor(0.02 * (v.length - 1))];
        this._aoHi = v[Math.floor(0.98 * (v.length - 1))];
        // A surface with almost no relief has almost no sky-view spread, and
        // stretching that to full contrast would invent shading from noise.
        if (this._aoHi - this._aoLo < 0.02) { this._aoLo = 0; this._aoHi = 1; }
      }
    }
    if (first) { this._fadeAO(); return; }
    // A fade already in flight keeps running and simply reads the new grid on
    // its next step; snapping _aoFade to 1 here would reintroduce the jump the
    // fade exists to remove, in the one window where both paths are live.
    if (!this._aoAnim) this._aoFade = 1;
    this.updateAll();
  }

  /**
   * Ease the occlusion in over the app's standard 0.45 s. Driven by wall time
   * so a throttled tab still ENDS at full strength, and recoloured at most
   * every 110 ms — a full recolour costs ~42 ms at 512², so easing per frame
   * would drop more frames than the step it replaces.
   */
  _fadeAO() {
    if (this._aoAnim) cancelAnimationFrame(this._aoAnim);
    this._aoFade = 0;
    this.updateAll();
    const t0 = performance.now();
    const D = 450, STEP = 110;
    let last = 0;
    const run = () => {
      const el = performance.now() - t0;
      if (el >= D) {
        this._aoAnim = 0;
        this._aoFade = 1;
        this.updateAll();
        return;
      }
      if (el - last >= STEP) {
        last = el;
        const f = el / D;
        this._aoFade = 0.5 - 0.5 * Math.cos(Math.PI * f); // inOutSine, as the camera
        this.updateAll();
      }
      this._aoAnim = requestAnimationFrame(run);
    };
    this._aoAnim = requestAnimationFrame(run);
  }

  /** @param {Uint8ClampedArray|null} rgba the worker's panel buffer, or null for plain relief */
  setLayer(rgba) {
    this.layer = rgba;
    this.updateAll();
  }

  /** @param {boolean} on plain white, no occlusion or slope shading */
  setFlat(on) {
    this.flat = !!on;
    this.updateAll();
  }

  /** Free GPU resources — mirrors the dispose loop in DL-TerrainSlicer app.js:636-645. */
  dispose() {
    // A fade still in flight would recolour a surface that no longer exists.
    if (this._aoAnim) { cancelAnimationFrame(this._aoAnim); this._aoAnim = 0; }
    if (this.contours) {
      // Unlike the wireframe, the contours own their position buffer outright,
      // so this geometry is disposed whole.
      this.contours.geometry.dispose();
      /** @type {any} */ (this.contours.material).dispose();
    }
    if (this.wire) {
      // The wireframe shares the surface's position attribute, so disposing its
      // geometry would free a buffer the mesh still owns. Drop the reference and
      // let the mesh's own dispose() release it once.
      this.wire.geometry.deleteAttribute("position");
      this.wire.geometry.dispose();
      /** @type {any} */ (this.wire.material).dispose();
    }
    this.geometry.dispose();
    this.material.dispose();
  }
}
