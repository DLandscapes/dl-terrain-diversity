// @ts-check
// Renderer, scene and camera.
//
// Ported from DL-3DGS Viewer (project/static/viewer.js) —
// the bootstrap (:28-66), the hand-rolled spherical controls (:321-385), the
// zoom-to-cursor logic (:398-435), the eased transition (:284-319) and the
// resize/loop pair (:536-571). Two deliberate departures from that source:
//
//   1. Z-UP, not Y-up. Terrain work is Z-up everywhere else in this office
//      (Rhino, QGIS, and DL-TerrainSlicer's own viewport at app.js:580), and a
//      DEM's elevation axis reading as "up" in the code as well as on screen
//      removes a whole class of confusion. The lighting rig, grid orientation
//      and dim-relative near/far come from DL-TerrainSlicer app.js:567-705.
//
//   2. TIME IS INJECTED. Nothing here reads performance.now() for anything that
//      moves; the eased camera takes its time from the Clock it was handed, so
//      the same code drives both live interaction and deterministic capture.
//      See clock.js for why this cannot be deferred.

import * as THREE from "three";
import { ease } from "./clock.js";

const FOV_Y = 55;
/**
 * Pitch of the top view: just under pi/2, because exactly vertical loses
 * azimuth — at 90° the up vector and the view direction are parallel, lookAt
 * has no way to orient the frame, and north can land anywhere. One thousandth
 * of a radian off vertical is 0.06°, which over a 64 m tile displaces the far
 * edge by 5 cm, and it makes the plan reliably north-up.
 */
const TOP_PITCH = 1.5533;
/**
 * Azimuth for every straight-down view: the camera enters a plan from the
 * SOUTH so that screen-up is north and screen-right is east.
 *
 * ⚠️ NOT ZERO, AND THE DIFFERENCE IS 180°. From the north side (yaw 0) the view
 * direction points south and down; screen "up", derived from world +Z against
 * it, comes out SOUTH with east on the left. Nothing is degenerate and nothing
 * throws — the plan is simply upside down, and it matches neither the pattern
 * preview, nor the exported figures, nor any plan drawing ever made.
 */
const TOP_YAW = Math.PI;

/**
 * Read a CSS custom property as a 0xRRGGBB integer.
 * @param {string} name @param {number} fallback
 */
function readCssColour(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!v) return fallback;
    const c = new THREE.Color(v);
    return (Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255);
  } catch {
    return fallback;
  }
}

/** Relative luminance of a 0xRRGGBB integer, 0..1. */
function luminance(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export class View {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} overlay
   * @param {import("./clock.js").Clock} clock
   */
  constructor(canvas, overlay, clock) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.clock = clock;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    // Render at 2x regardless of the display's own ratio, and let the browser
    // downscale — 4x supersampling on a 1x screen. MSAA alone cannot help a
    // flat-shaded heightfield: at grazing pitches every facet is a few pixels
    // across and ALL the image's spatial frequency lives on facet borders, so
    // during an orbit the tone of whole pixels flips (the boiling in the
    // 2026-07-30 capture). Measured on the grazing test view, a 0.004 rad
    // orbit step changed >25 luma on 27.4% of terrain pixels at 1x against
    // 10.6% with supersampling and the softened key light below — better than
    // the smooth-shaded surface ever measured (14.6%). Cost is 4x fragment
    // work on a Lambert material over 130k triangles; this stayed at 60 fps.
    this.renderer.setPixelRatio(Math.max(Math.min(window.devicePixelRatio || 1, 2), 2));
    // Clear colour is read from the --stage CSS token rather than hard-coded,
    // so the WebGL background and the CSS background cannot drift apart.
    this.stage = readCssColour("--stage", 0xffffff);
    this.renderer.setClearColor(this.stage, 1);
    this.onLight = luminance(this.stage) > 0.5;

    this.scene = new THREE.Scene();
    // INFINITE GROUND GRID, ported from DL-TerrainSlicer app.js:579-586. The
    // grid is drawn far past the terrain and fogged out, so it reads as
    // continuing forever instead of stopping at a visible square edge.
    //
    // Fog rather than a vertex-colour fade, for the reason that file records:
    // fog is applied per FRAGMENT, so the fade runs smoothly ALONG each line.
    // A vertex fade cannot do it — every grid line spans the whole extent, so
    // both of its endpoints sit at maximum radius and the line would fade
    // uniformly or not at all. The range is refreshed from the camera distance
    // in _applyCamera(), so the horizon sits at the same visual depth at any
    // zoom. Everything except the grid opts out with `fog: false`.
    this.scene.fog = new THREE.Fog(this.stage, 1, 2);
    // Two cameras kept in step, Blender-style: the same yaw/pitch/dist drives
    // both, so toggling projection does not move the viewpoint. Orthographic
    // matters here because the tool is used to read terrain — parallel
    // projection is what lets you compare two hollows' depths across the frame
    // without perspective foreshortening quietly making the far one look
    // shallower.
    this.camera = new THREE.PerspectiveCamera(FOV_Y, 1, 0.02, 5000);
    this.camera.up.set(0, 0, 1); // Z-up
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.02, 5000);
    this.orthoCamera.up.set(0, 0, 1);
    this.orthographic = false;

    // LIGHTING. The rig inherited from DL-TerrainSlicer used a flat ambient of
    // 0.55 against ~1.75 total — nearly a third of the light arriving from
    // everywhere at once, which is exactly the light that carries no shape
    // information. On a near-flat heightfield that reads as a pale slab.
    //
    // Replaced with: a hemisphere light, which is ambient that still knows
    // which way is up (sky above, warm ground bounce below, so a surface tilting
    // toward the sky brightens and one tilting away dims — form for free); a
    // dominant key from the NW at the same 315° the hillshade uses, so the 3D
    // view and the raster panels agree about where the light comes from; and a
    // weak cool fill from the opposite side to keep shadowed flanks readable
    // without flattening them.
    // INTENSITIES. three.js r155+ uses physically-correct lighting, where the
    // Lambert BRDF carries a 1/pi factor — so a light of intensity 1 delivers
    // about 0.32 of what the pre-r155 units would suggest. Values tuned by eye
    // against the old behaviour therefore come out roughly three times too
    // dark, which is exactly what happened here: a vertex colour of 0.83 was
    // rendering at a median of 142/255. These are scaled to compensate.
    // REBALANCED FOR HARD SHADING (2026-07-30). Under flat shading the key
    // light's dominance sets the luminance gap between adjacent facets, and
    // that gap is what shimmers when facets are a few pixels across: with the
    // key at 2.35 a grazing orbit step flipped >25 luma on a third of terrain
    // pixels. Shifting weight from the key to the hemisphere keeps the facets
    // (and the NW-lit form) but narrows the per-facet spread — 32.8% -> 18.3%
    // of pixels at 1x, before supersampling takes it further. Median terrain
    // luma held at 206 against 212 with the old rig.
    // ⚠️ THE RIG IS ACHROMATIC, AND IT HAS TO BE. It was a daylight rig — a
    // #eef2f6 sky over #8a8378 ground at 1.90, plus a #e8eef4 fill — which is
    // physically sensible outdoors and wrong here for the same reason the
    // sidebar is black and grey: colour in this interface means data. A
    // hemisphere light tinted cool above and warm below lays a blue cast on
    // every upward face and a tan one on every slope, so the terrain reads
    // faintly pastel even with no analysis on it, and every ramp painted over it
    // is shifted by a hue that means nothing.
    //
    // ⚠️ It also silently undid a decision surface.js states explicitly. That
    // file sets the base vertex colour to NEUTRAL GREY rather than warm stone,
    // with the note that "any colour here would tint every layer painted over it
    // and compete with ramps whose whole job is to mean something" — and then
    // the lighting put the hue straight back. Two files, one intention, opposite
    // results. The greys below hold the same intensities, so the form reads
    // exactly as before; only the cast is gone.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9a9a, 1.90));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.20));
    const key = new THREE.DirectionalLight(0xffffff, 1.45);
    key.position.set(-1, -0.6, 1.15); // NW, matching hillshade az 315
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(1, 0.8, 0.35);
    this.scene.add(fill);

    this.grid = null;
    this.sceneRadius = 1;
    /** the pickable terrain surface, set by the app */
    this.pickTarget = null;

    this._raycaster = new THREE.Raycaster();
    // pitch > 0 means the camera is above the ground looking down
    this._cam = { yaw: 0.55, pitch: 0.62, dist: 100, target: new THREE.Vector3() };
    /**
     * Claim a wheel event before the camera zooms. Return true if handled.
     * @type {((e: WheelEvent) => boolean|void)|null}
     */
    this.onWheel = null;
    this.home = null;
    this._anim = null;
    this._anchor = null;
    /** where a second press of the same axis button returns to */
    this._axisReturn = null;
    /** the vertical plane a section view cuts on, or null @type {THREE.Plane|null} */
    this._clipPlane = null;
    /**
     * PLAN MODE. A plan is a drawing surface, not a viewpoint: the moment the
     * camera can be tilted, a click on the terrain stops meaning a point on the
     * map and starts meaning "wherever the ray happened to land", and every
     * ring traced afterwards is foreshortened by an angle nothing records.
     * Locked, only pan and zoom remain — you can still get to any part of the
     * sheet, you just cannot turn it. See setOrbitLocked().
     */
    this.orbitLocked = false;
    this.onFrame = null;
    this.onPick = null;
    /** the app may claim a double-click, as it may claim a pointerdown */
    this.onDoubleClick = null;
    /**
     * A middle-button CLICK, as opposed to a middle-button drag, which pans.
     * Plan mode uses it to release the camera without leaving plan mode.
     */
    this.onMiddleClick = null;
    /**
     * Shift + right-drag, reported as a change in GROUND UNITS. The view knows
     * nothing about brushes — it reports the gesture and its scale, and the app
     * decides whether anything is listening and what to resize. If this is null
     * the gesture falls back to panning, so a mode with no brush is unaffected.
     * @type {((deltaGroundUnits: number) => void)|null}
     */
    this.onBrushResize = null;
    /** shift + LEFT drag: the brush strength, in metres per pixel of travel */
    this.onBrushStrength = null;

    this._initControls();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(
      /** @type {HTMLElement} */(canvas.parentElement));

    this.fps = 0;
    this._fpsFrames = 0;
    this._fpsAt = 0;
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ---------------------------------------------------------------- framing */

  /**
   * Frame a world-space box and place the grid under it.
   * @param {THREE.Box3} box
   */
  frame(box) {
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    const dim = Math.max(size.x, size.y, size.z) || 1;
    this.sceneRadius = dim * 0.5;

    this._cam.target.copy(centre);
    // Framing a new tile must not tilt a locked plan — loading terrain while
    // drawing is a change of subject, not a change of viewpoint.
    // TOP_YAW, not 0, whenever the camera is looking straight down — see the
    // axis-view table for why a plan has to be entered from the south.
    this._cam.yaw = this.orbitLocked ? TOP_YAW : 0.55;
    this._cam.pitch = this.orbitLocked ? TOP_PITCH : 0.62;
    // _fitDistance is the starting guess; _fitAndCentre then measures the real
    // projection and corrects both the distance and the aim.
    this._cam.dist = this._fitDistance(size);
    this._fitAndCentre(box);
    this._axisReturn = null; // the stored return view belonged to other terrain

    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      /** @type {any} */ (this.grid.material).dispose();
    }
    // ⚠️ BUILT BY HAND, NOT GridHelper, FOR ONE REASON: THE HOLE. The ground
    // grid is apparatus that says "here is the plane the site sits on", and it
    // has no business inside the site — the moment a student scoops below the
    // datum, a GridHelper's lines appear THROUGH the excavation, which reads as
    // the terrain being transparent. Worse on the teaching plane, where relief
    // is zero: the old drop of 0.15 × relief was 0.15 × 0 = 0, so the grid sat
    // exactly in the ground and the first cut exposed it.
    //
    // So the grid is cut open over the tile's footprint and dropped by a real
    // distance. Nothing can show through an opening.
    //
    // Tones follow the stage: light lines on a dark stage, dark on a light one.
    // The grid runs 14x past the terrain and is fogged out (see scene.fog), so
    // no edge is ever reachable. Cell size follows the TERRAIN — one twentieth
    // of its span — so a square stays a meaningful ground measure.
    const ground = Math.max(size.x, size.y) || 1;
    const cell = ground / 20;
    const span = ground * 14;
    const [gMajor, gMinor] = this.onLight ? [0xc9c4ba, 0xe2ded6] : [0x3a3f47, 0x24282e];
    // ⚠️ THE OPENING IS CUT ONLY WHEN THE GROUND IS FLAT (2026-08-11, Marc's
    // refinement). The grid running under the patch is worth having — it is
    // what says the site sits on a plane, and on ground with real relief it
    // is metres below the surface and can never be exposed. The collision is
    // specific to a FLAT tile: relief 0 means the grid and the terrain are the
    // same plane, and the first scoop reveals the lines through the hole.
    // So: essentially-flat tiles get the opening, everything else keeps a
    // whole grid. 1% of span is the test — the teaching plane is exactly 0,
    // the fill floor is 8%, the POI patch 32%.
    const flat = (size.z || 0) < Math.max(size.x, size.y) * 0.01;
    const hx = flat ? size.x / 2 * 1.02 : 0;
    const hy = flat ? size.y / 2 * 1.02 : 0;
    const half = span / 2;
    const n = Math.max(2, Math.round(span / cell));
    const majC = new THREE.Color(gMajor), minC = new THREE.Color(gMinor);
    const pos = [], col = [];
    /** Push a segment, split around the opening rather than crossing it. */
    const seg = (x0, y0, x1, y1, c) => {
      const spans = [];
      if (x0 === x1) {
        // vertical line: skip the part that runs through the opening
        if (Math.abs(x0) <= hx) { spans.push([y0, -hy], [hy, y1]); }
        else spans.push([y0, y1]);
        for (const [a, b] of spans) {
          if (b <= a) continue;
          pos.push(x0, a, 0, x0, b, 0);
          col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        }
      } else {
        if (Math.abs(y0) <= hy) { spans.push([x0, -hx], [hx, x1]); }
        else spans.push([x0, x1]);
        for (const [a, b] of spans) {
          if (b <= a) continue;
          pos.push(a, y0, 0, b, y0, 0);
          col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        }
      }
    };
    for (let i = 0; i <= n; i++) {
      const v = -half + (span * i) / n;
      const c = (i % 5 === 0) ? majC : minC;
      seg(v, -half, v, half, c);
      seg(-half, v, half, v, c);
    }
    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    gGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
    this.grid = new THREE.LineSegments(gGeo, new THREE.LineBasicMaterial({
      vertexColors: true,
      // Transparent so _applyCamera can fade it out of edge-on views.
      transparent: true, depthWrite: false, fog: true,
    }));
    // ⚠️ A REAL DROP, not a fraction of the relief — see above: on a flat tile
    // a proportional drop is zero. One twentieth of the tile's span puts the
    // plane clear below any plausible excavation while staying close enough to
    // read as the ground's own datum.
    this.grid.position.set(centre.x, centre.y, box.min.z - ground * 0.05);
    this.scene.add(this.grid);

    this.home = this.getCameraState();
    this._updateClip();
    this._applyCamera();
  }

  /**
   * Frame a box in the locked plan view, eased — the "start on the whole
   * sheet" move for entering plan mode.
   *
   * Unlike frame() this touches ONLY the camera: no grid rebuild, and `home`
   * keeps pointing at the oblique working view, so R after leaving plan mode
   * still resets to the view the tool opened with.
   *
   * ⚠️ THE FIT IS MEASURED AT THE DESTINATION POSE, NOT THE ONE BEING LEFT.
   * setOrbitLocked has just started a 0.45 s ease toward top, and projecting
   * corners against the in-flight camera is the setAxisView trap — it measures
   * the camera it was leaving. So the camera is snapped to the destination
   * silently, fitted and centred there, and then eased to the measured result
   * from where it really was. Nothing renders between the snap and the
   * restore: it is one synchronous pass inside a single JS turn.
   * @param {THREE.Box3} box
   * @param {{seconds?: number}} [opts]
   */
  /**
   * Fit a box WITHOUT changing where the camera is looking from.
   *
   * ⚠️ THE THIRD FRAMING METHOD, AND THE ORIENTATION IS THE WHOLE DIFFERENCE.
   * `frame()` re-aims to the default oblique and rebuilds the ground grid — it
   * is for adopting a new tile. `planFrame()` snaps to top — it is for entering
   * a plan. Neither is right for "zoom to what I have selected": that is a
   * change of DISTANCE, not of viewpoint, and swinging the camera round on the
   * way would lose the reader's place. Yaw and pitch are left exactly as they
   * are, and only the target and the distance move.
   *
   * The fit is therefore measured at the pose the camera is already in, so the
   * `setAxisView` trap — projecting against a camera mid-ease — cannot apply.
   * @param {THREE.Box3} box
   * @param {{seconds?: number}} [opts]
   */
  frameBox(box, opts = {}) {
    const from = this.getCameraState();
    box.getCenter(this._cam.target);
    const size = new THREE.Vector3();
    box.getSize(size);
    this._cam.dist = this._fitDistance(size);
    this._fitAndCentre(box);
    const dest = this.getCameraState();
    this.setCameraState(from, 0);
    this.setCameraState(dest, opts.seconds ?? 0.35);
  }

  planFrame(box, opts = {}) {
    const from = this.getCameraState();
    this._cam.yaw = TOP_YAW;
    this._cam.pitch = TOP_PITCH;
    box.getCenter(this._cam.target);
    const size = new THREE.Vector3();
    box.getSize(size);
    this._cam.dist = this._fitDistance(size);
    this._fitAndCentre(box);
    const dest = this.getCameraState();
    this.setCameraState(from, 0);
    this.setCameraState(dest, opts.seconds ?? 0.45);
  }

  /**
   * Camera distance that frames a heightfield tightly.
   *
   * Fitting the bounding SPHERE — the usual reflex — wastes most of the frame
   * on terrain, because a DEM is a wide flat plate: its sphere is dominated by
   * the horizontal diagonal while the plate itself projects to a thin band.
   * Measured on the 64 m Ørndalen patch, sphere-fitting filled only ~21% of the
   * viewport. So fit the PROJECTED extent instead: the ground span foreshortens
   * by sin(pitch) on the screen's vertical axis, while relief projects by
   * cos(pitch), and the horizontal axis takes the full span against the
   * horizontal field of view.
   *
   * @param {THREE.Vector3} size world-space bbox size
   */
  /**
   * Fit AND centre on the terrain's real projected extent, measured rather than
   * derived.
   *
   * ⚠️ `_fitDistance` FITS THE UNROTATED SPAN, and at any yaw but zero that is
   * too small. Phase 2 got half of this right — a heightfield must be fitted by
   * its projected extent, not its bounding sphere — but the formula it settled
   * on takes `max(size.x, size.y)` as the horizontal reach, which is the width
   * of the patch only when you are looking straight down one of its axes. At
   * the default yaw of 0.55 rad a square tile projects
   * `x·|cos| + y·|sin|` = 1.37× that, so it ran off both sides of the frame with
   * no margin at all while the maths reported a 12% one.
   *
   * ⚠️ AND AIMING AT THE BOX CENTRE DOES NOT CENTRE THE PICTURE. Under
   * perspective at a 35° pitch the near edge of a wide flat plate subtends far
   * more than the far edge, so the midpoint of what you SEE sits well below the
   * midpoint of what is THERE — the model rides high with dead paper beneath it.
   *
   * Both fall out of one measurement: project the eight corners, and scale and
   * shift until the NDC box is centred and inside the frame. Exact for any yaw,
   * pitch, aspect and exaggeration, and it cannot drift from the projection the
   * way a formula can.
   *
   * ⚠️ CORRECTED IN WORLD SPACE, not by offsetting the projection, so the camera
   * stays an ordinary orbit camera and nothing downstream — picking, the capture
   * path, the axis views — has to know this happened.
   *
   * Three passes: moving the target changes the projection it was measured
   * from. It converges immediately, and the loop is bounded rather than run to
   * a tolerance so it can never spin on a degenerate box.
   * @param {THREE.Box3} box
   */
  _fitAndCentre(box) {
    const MARGIN = 1.08;
    const corners = [];
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
      }
    }
    const right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
    const p = new THREE.Vector3();

    /** Projected NDC box of the eight corners, at the camera as it stands. */
    const ndc = () => {
      this._applyCamera();
      this.camera.updateMatrixWorld();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const c of corners) {
        p.copy(c).project(this.camera);
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
      }
      return { x0, x1, y0, y1 };
    };
    /** Slide the target so the projected box sits on the frame's centre. */
    const recentre = (b) => {
      const dx = (b.x0 + b.x1) / 2, dy = (b.y0 + b.y1) / 2;
      this.camera.matrixWorld.extractBasis(right, up, fwd);
      const vFov = (this.camera.fov * Math.PI) / 180;
      const halfV = Math.tan(vFov / 2) * this._cam.dist;
      const halfH = halfV * (this.camera.aspect > 0 ? this.camera.aspect : 1.5);
      this._cam.target.addScaledVector(right, dx * halfH);
      this._cam.target.addScaledVector(up, dy * halfV);
    };

    // ⚠️ THE ORDER MATTERS AND THE LAST STEP MUST BE THE CENTRING. Scaling the
    // distance moves the camera along its own axis, and under perspective at a
    // pitch that shifts the projected box as well as shrinking it — so a loop
    // that ends on a rescale leaves the model off-centre again. It measured
    // 5% margin above and 38% below on a 1520×900 frame while reporting a
    // centred fit: the square case, where the shift is symmetric, hid it.
    // Centring after scaling is safe the other way round, because sliding the
    // target sideways changes the extent only in the third decimal.
    for (let pass = 0; pass < 3; pass++) {
      const b = ndc();
      recentre(b);
      // NDC runs −1..1, so a half-extent of 1 exactly fills the frame.
      const need = Math.max((b.x1 - b.x0) / 2, (b.y1 - b.y0) / 2) * MARGIN;
      if (need > 1e-6) this._cam.dist *= need;
    }
    recentre(ndc());
    this._applyCamera();
  }

  _fitDistance(size) {
    const MARGIN = 1.12;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const tanV = Math.tan(vFov / 2);
    const aspect = this.camera.aspect > 0 ? this.camera.aspect : 1.5;
    const tanH = tanV * aspect;

    const ground = Math.max(size.x, size.y) || 1;
    const p = Math.abs(this._cam.pitch);
    // vertical screen extent of a plate of `ground` span plus its relief
    const projV = ground * Math.sin(p) + size.z * Math.cos(p);
    const needV = projV / 2 / tanV;
    const needH = ground / 2 / tanH;
    return Math.max(needV, needH, 1e-3) * MARGIN;
  }

  /**
   * Near/far derived from the CAMERA DISTANCE, not just scene size.
   *
   * The scene-size rule inherited from DL-TerrainSlicer gave near = dim/500 and
   * far = dim*40 — a ratio of 20 000:1, which on a 24-bit depth buffer leaves
   * too little precision at grazing angles and made triangles flicker and go
   * dark while orbiting. Deriving near from how far away the camera actually is
   * keeps the ratio around 500:1 at any zoom level, which is comfortable.
   */
  /**
   * Change the stage the model sits on.
   *
   * ⚠️ THE FOG HAS TO FOLLOW IT. The ground grid is faded out to a horizon with
   * THREE.Fog, and fog fades TOWARD A COLOUR — its own. Left at the old stage
   * colour it would fade the grid to white against a dark field, so the grid
   * would brighten into the distance instead of vanishing and the horizon would
   * read as a glowing band. `onLight` follows too, since the grid tones are
   * derived from whether the stage is light or dark.
   * @param {number} hex
   */
  setStageColour(hex) {
    this.stage = hex;
    this.renderer.setClearColor(hex, 1);
    this.onLight = luminance(hex) > 0.5;
    if (this.scene.fog) this.scene.fog.color.setHex(hex);
    // ⚠️ A GridHelper BAKES ITS TWO TONES INTO A VERTEX COLOUR ATTRIBUTE, so
    // there is nothing to restyle — the grid would have to be rebuilt, and
    // rebuilding it here means re-deriving its extent from the terrain, which is
    // frame()'s job and would move the camera. The material colour MULTIPLIES
    // the baked tones, so darkening it is enough to keep the grid a whisper
    // against a dark stage instead of the brightest thing in the frame.
    const gm = /** @type {any} */ (this.grid?.material);
    if (gm && gm.color) gm.color.setScalar(this.onLight ? 1 : 0.28);
  }

  _updateClip() {
    const d = Math.max(this._cam.dist, 1e-3);
    const r = Math.max(this.sceneRadius, 1e-3);
    // ⚠️ 0.002, NOT 0.01 — the near plane was clipping real terrain. At a
    // typical 50 m viewing distance on the 64 m design patch, a factor of 0.01
    // puts the near plane half a metre from the eye, and at the grazing pitches
    // this tool is used at the near edge of the tile passes inside that: the
    // ground nearest the camera simply vanishes, which reads as a hole in the
    // terrain rather than as a clip.
    //
    // The cost is depth-buffer precision, so this is a measured trade rather
    // than a preference. Far/near goes from ~640:1 to ~3 200:1 at that distance
    // — still six times better than the 20 000:1 scene-size rule that made
    // triangles flicker and go dark while orbiting, and render group R2's
    // grazing-orbit shimmer metric is unmoved: 3.4% before, 3.5% after.
    this.camera.near = Math.max(d * 0.002, 1e-4);
    // Far must clear the fog's own far plane, or the grid would be cut by the
    // frustum before the fade has finished and the hard edge would be back.
    this.camera.far = Math.max(d + r * 6, d * 3.2);
    this.camera.updateProjectionMatrix();
  }

  /* ---------------------------------------------------------------- camera */

  /** The camera actually being rendered. */
  get activeCamera() { return this.orthographic ? this.orthoCamera : this.camera; }

  _applyCamera() {
    const { yaw, pitch, dist, target } = this._cam;
    // Keep the grid's horizon proportional to how far out the camera is, so it
    // fades at the same visual depth at every zoom level. Set here rather than
    // in the frame loop so a manually driven render — the capture path, and
    // the render self-test — gets the same image as an animated one.
    if (this.scene.fog) {
      this.scene.fog.near = dist * 1.0;
      this.scene.fog.far = dist * 3.0;
    }
    // ⚠️ THE GROUND GRID FADES OUT OF EDGE-ON VIEWS. It is a plane in XY, so
    // in the front/side views — pitch barely above the horizon — it projects
    // to a band of stacked lines behind the model, which read as an artefact
    // (they were reported as one). A ground grid seen edge-on carries no
    // ground measure, so its opacity follows the sine of the viewing angle to
    // its own plane: full by ~11°, gone at the horizon, continuous in between
    // so orbiting through low pitch never pops. Set here, with the fog, so
    // manually driven renders get the same image as animated ones.
    if (this.grid) {
      // Floored at 0.03 rad: the named side views sit at pitch 0.02 — their
      // own epsilon above the horizon — and the ramp has to read THEM as
      // exactly edge-on, not as 10% of a grid.
      const s0 = Math.sin(0.03), s1 = Math.sin(0.2);
      const f = Math.min(1, Math.max(0, (Math.abs(Math.sin(pitch)) - s0) / (s1 - s0)));
      /** @type {any} */ (this.grid.material).opacity = f;
      this.grid.visible = f > 0.02;
    }
    const cp = Math.cos(pitch);
    // Z-up spherical: yaw about Z, pitch above the XY plane.
    const px = target.x + dist * cp * Math.sin(yaw);
    const py = target.y + dist * cp * Math.cos(yaw);
    const pz = target.z + dist * Math.sin(pitch);

    this.camera.position.set(px, py, pz);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(target);

    // The orthographic camera sits at the same point looking the same way; only
    // its frustum differs. Sizing it from dist and the perspective FOV means
    // the two projections frame the same thing, so toggling reads as a change
    // of projection rather than a jump.
    const o = this.orthoCamera;
    o.position.set(px, py, pz);
    o.up.set(0, 0, 1);
    o.lookAt(target);
    const halfH = Math.tan((this.camera.fov * Math.PI) / 360) * dist;
    const halfW = halfH * (this.camera.aspect || 1);
    o.left = -halfW; o.right = halfW; o.top = halfH; o.bottom = -halfH;
    o.near = this.camera.near; o.far = this.camera.far;
    o.updateProjectionMatrix();
  }

  /** @param {boolean} on */
  setOrthographic(on) {
    // ⚠️ Perspective is refused while the orbit is locked. A converging plan is
    // not a plan — a ring traced across a perspective view is a ring in a
    // trapezoid — and this is the one projection change the app must not be
    // able to make by accident. The caller disables the projection button in
    // plan mode as well, so this guard is a floor rather than the mechanism.
    if (this.orbitLocked && !on) return;
    this.orthographic = !!on;
    this._updateClip();
    this._applyCamera();
  }

  /**
   * Render one frame at an exact pixel size and hand it back as a plain 2D
   * canvas, then put every piece of state back as it was.
   *
   * WHY THIS EXISTS. Two jobs need pixels at a size the window does not have:
   * figures for the A1 poster (300 dpi, so ~3000 px across a 230 mm figure) and
   * the frame-accurate 45 s master, which should be rendered offline against
   * FixedStepClock rather than screen-captured. Doing either by poking the
   * renderer from outside DOES NOT WORK, and the reasons are worth recording
   * because they cost an afternoon:
   *
   *   - `setSize` alone STRETCHES the image. The orthographic frustum is derived
   *     from `camera.aspect` in `_applyCamera`, so growing the buffer without
   *     updating the aspect renders a square camera into a non-square frame.
   *   - `_loop` calls `_resize` on every rAF, so any external change is undone
   *     on the next frame. The capture must therefore be SYNCHRONOUS: nothing
   *     may await between setting the size and reading the pixels.
   *   - `setPixelRatio` is pinned to exactly 2 for supersampling (see the
   *     constructor). Raising it to reach a resolution overshoots fast — 6 gives
   *     a 36 Mpx buffer and returns an EMPTY render. Set the size directly and
   *     leave the ratio at 1 instead, so `width`x`height` means what it says.
   *
   * Reads the pixels through `drawImage` in the same tick as the render, which
   * is what makes it safe without `preserveDrawingBuffer` — the drawing buffer
   * is only cleared once the tick ends.
   *
   * The background is left as the stage colour rather than made transparent;
   * the renderer's context has no alpha, and keying the flat background out
   * afterwards is both easier and reversible.
   *
   * @param {number} width  pixels, not CSS units
   * @param {number} height
   * @returns {HTMLCanvasElement} a 2D canvas holding the frame
   */
  renderAt(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const max = this.renderer.capabilities.maxTextureSize || 8192;
    if (w > max || h > max) {
      throw new RangeError(`renderAt: ${w}x${h} exceeds this GPU's limit of ${max}px`);
    }

    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const keep = { w: size.x, h: size.y, dpr: this.renderer.getPixelRatio(), aspect: this.camera.aspect };

    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this._applyCamera();          // re-derives the ortho frustum from the new aspect
      this.renderer.render(this.scene, this.activeCamera);

      const out = document.createElement("canvas");
      out.width = w; out.height = h;
      const ctx = /** @type {CanvasRenderingContext2D} */ (out.getContext("2d"));
      ctx.drawImage(this.canvas, 0, 0, w, h, 0, 0, w, h);
      return out;
    } finally {
      // finally, not after the return: a throw mid-capture must not leave the
      // live view stuck at capture size.
      this.renderer.setPixelRatio(keep.dpr);
      this.renderer.setSize(keep.w, keep.h, false);
      this.camera.aspect = keep.aspect;
      this.camera.updateProjectionMatrix();
      this._applyCamera();
      this.renderer.render(this.scene, this.activeCamera);
    }
  }

  /**
   * Lock the camera to a drawing surface: top, orthographic, no orbit.
   *
   * Pan and zoom deliberately stay. A plan you cannot move around is a picture,
   * and the design patch is 64 m across at 0.25 m — the whole point is to work
   * on part of it at a time.
   * @param {boolean} on
   * @param {{seconds?: number}} [opts]
   */
  setOrbitLocked(on, opts = {}) {
    this.orbitLocked = !!on;
    if (!this.orbitLocked) return;
    // Discard the axis-view return state: while locked the axis buttons are
    // inert, and a stored "press Top again to go back" belongs to a session
    // where that was possible.
    this._axisReturn = null;
    this.orthographic = true;
    this.setCameraState({
      yaw: TOP_YAW, pitch: TOP_PITCH, dist: this._cam.dist, target: this._cam.target.toArray(),
    }, opts.seconds ?? 0.45);
  }

  /**
   * Snap to a named axis view, Blender-style. Orthographic by default, because
   * a "top view" that still converges is not a plan.
   *
   * TOGGLES BACK: pressing the same axis button again returns to the view you
   * were in before — snapping to Top to check a plan and then having to
   * re-orbit back to the working view by hand costs more than the check was
   * worth. The stored return view survives switching BETWEEN axis views (Top
   * then Front then Front again returns to the original working view, not to
   * Top), and is discarded the moment the camera is moved by hand, because the
   * axis view stopped being "a detour from" anywhere.
   *
   * @param {"top"|"bottom"|"front"|"back"|"left"|"right"} name
   * @param {{seconds?: number, ortho?: boolean}} [opts]
   * @returns {boolean} true if this call RETURNED to the previous view
   */
  setAxisView(name, opts = {}) {
    // ⚠️ While the orbit is locked the camera IS the top view; the other five
    // axes have nothing to snap to. Refused rather than ignored, so the caller
    // can disable the buttons and the keyboard shortcuts cannot get behind them.
    if (this.orbitLocked && name !== "top") return false;
    // yaw is measured about Z with 0 = looking from the north (+Y) side;
    // pitch is elevation above the horizon.
    const views = {
      // ⚠️ THE TOP VIEW LOOKS FROM THE SOUTH, AND THAT IS WHAT MAKES IT
      // NORTH-UP. With yaw 0 the camera sits on the +Y side looking down and
      // southward; screen "up" then derives from world +Z against that view
      // direction and resolves to SOUTH, with east on the left — a plan rotated
      // 180°. Correct for an oblique view, where the far distance belongs at the
      // top of the frame, and wrong for a plan, which is north-up by convention
      // in every drawing this tool exports and in the pattern preview beside it.
      // Measured: a scoop in the tile's north-west rendered lower-right.
      // Putting the camera on the south side instead gives screen-right = east
      // and screen-up = north, with no change to the camera maths.
      top: { yaw: Math.PI, pitch: TOP_PITCH },
      bottom: { yaw: Math.PI, pitch: -TOP_PITCH },
      front: { yaw: Math.PI, pitch: 0.02 },   // looking north, from the south
      back: { yaw: 0, pitch: 0.02 },          // looking south, from the north
      right: { yaw: Math.PI / 2, pitch: 0.02 },
      left: { yaw: -Math.PI / 2, pitch: 0.02 },
    };
    const v = views[name];
    if (!v) return false;

    if (this._axisReturn && this._axisReturn.name === name) {
      const back = this._axisReturn;
      this._axisReturn = null;
      this.orthographic = back.orthographic; // the projection is part of the view
      this.setCameraState(back.state, opts.seconds ?? 0.45);
      return true;
    }
    if (this._axisReturn) {
      this._axisReturn.name = name; // axis-to-axis: keep the original return view
    } else {
      this._axisReturn = {
        name, state: this.getCameraState(), orthographic: this.orthographic,
      };
    }

    if (opts.ortho !== false) this.orthographic = true;
    this.setCameraState({
      yaw: v.yaw, pitch: v.pitch, dist: this._cam.dist,
      target: this._cam.target.toArray(),
    }, opts.seconds ?? 0.45);
    return false;
  }

  /**
   * Look ALONG a section: orthographic, square to the line, with everything on
   * the near side of it clipped away — the drawing convention where you stand
   * at the cut and see the cut face plus whatever stands beyond it in elevation.
   *
   * ⚠️ THE YAW IS DERIVED, NOT LOOKED UP. The six named axis views are a table
   * because there are six of them; a section runs at whatever bearing it was
   * drawn at. `_applyCamera` places the camera at `(sin yaw, cos yaw)·dist` from
   * the target, so the offset is the OPPOSITE of the direction the camera looks
   * — hence `atan2(−vx, −vy)`. Checked against the table rather than trusted: a
   * west-to-east section comes out at yaw π, which is exactly the `front` view,
   * and a south-to-north one at π/2, which is `right`.
   *
   * ⚠️ A VERTICAL CLIPPING PLANE IS IMMUNE TO THE VERTICAL EXAGGERATION, and
   * that is the piece of luck that makes this simple. The scene applies
   * exaggeration by scaling z; a plane whose normal is horizontal is unmoved by
   * that, so the cut stays exactly on the line the user drew at 1× and at 8×.
   * A horizontal clip would need the scale folded into its constant.
   *
   * ⚠️ CLIPPING IS GLOBAL (`renderer.clippingPlanes`), NOT PER MATERIAL, on
   * purpose. Every overlay in this tool draws with `depthTest: false` and a high
   * render order so it can never shimmer against the surface — which means a
   * per-material clip would have to be applied to each of them by hand, and the
   * one that was missed would hang in front of the cut face looking deliberate.
   * A global plane reaches materials this file has never heard of.
   *
   * @param {number[]} a [x, y] one end of the section, in world units
   * @param {number[]} b [x, y] the other end
   * @param {{flip?: boolean, target?: number[], width?: number, height?: number,
   *          seconds?: number}} [opts]
   * @returns {boolean} false if the section is degenerate
   */
  setSectionView(a, b, opts = {}) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return false;
    const ux = dx / len, uy = dy / len;
    // The direction the camera LOOKS: the left normal of A→B, or its opposite.
    const s = opts.flip ? -1 : 1;
    const vx = -uy * s, vy = ux * s;

    const target = opts.target
      ? new THREE.Vector3().fromArray(opts.target)
      : new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, this._cam.target.z);

    // Frame the section's length across the screen and its relief up it, with a
    // margin, measured the same way _fitDistance does.
    const tan = Math.tan((this.camera.fov * Math.PI) / 360) || 1;
    const aspect = this.camera.aspect || 1;
    const halfW = (opts.width ?? len) / 2;
    const halfH = (opts.height ?? len / 4) / 2;
    const dist = Math.max(halfH, halfW / aspect) / tan * 1.12;

    this.orthographic = true;
    this.setSectionClip([vx, vy], a);
    this.setCameraState({
      yaw: Math.atan2(-vx, -vy),
      // The same epsilon above the horizon the named elevation views use, so
      // the ground grid reads this as edge-on and fades out of it.
      pitch: 0.02,
      dist, target: target.toArray(),
    }, opts.seconds ?? 0.45);
    // An axis view's "press again to go back" would return to a camera that no
    // longer has a clip; the caller owns leaving a section view.
    this._axisReturn = null;
    return true;
  }

  /**
   * Clip everything on the near side of a vertical plane, or stop clipping.
   * @param {number[]|null} normal [nx, ny] the direction to KEEP
   * @param {number[]} [point] [x, y] a point the plane passes through
   */
  setSectionClip(normal, point = [0, 0]) {
    if (!normal) {
      this.renderer.clippingPlanes = [];
      this.renderer.localClippingEnabled = false;
      this._clipPlane = null;
      return;
    }
    const n = new THREE.Vector3(normal[0], normal[1], 0).normalize();
    // three.js keeps the half-space where n·p + constant > 0.
    this._clipPlane = new THREE.Plane(n, -(n.x * point[0] + n.y * point[1]));
    this.renderer.localClippingEnabled = true;
    this.renderer.clippingPlanes = [this._clipPlane];
  }

  /** True while a section clip is in force. */
  get sectionClipped() { return !!this._clipPlane; }

  getCameraState() {
    return {
      yaw: this._cam.yaw, pitch: this._cam.pitch, dist: this._cam.dist,
      target: this._cam.target.toArray(),
    };
  }

  /**
   * @param {{yaw:number, pitch:number, dist:number, target:number[]}} s
   * @param {number} [seconds] 0 = snap. Eased moves run on the injected clock.
   * @param {string} [easing]
   */
  setCameraState(s, seconds = 0, easing = "inOutSine") {
    const to = {
      yaw: s.yaw, pitch: s.pitch, dist: s.dist,
      target: new THREE.Vector3().fromArray(s.target),
    };
    if (seconds <= 0) {
      this._cam.yaw = to.yaw;
      this._cam.pitch = to.pitch;
      this._cam.dist = to.dist;
      this._cam.target.copy(to.target);
      this._anim = null;
      this._updateClip();
      this._applyCamera();
      return;
    }
    const from = {
      yaw: this._cam.yaw, pitch: this._cam.pitch, dist: this._cam.dist,
      target: this._cam.target.clone(),
    };
    // take the short way round the yaw circle
    let dYaw = to.yaw - from.yaw;
    while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    this._anim = { from, to, dYaw, t0: this.clock.t, dur: seconds, easing };
  }

  _tickAnim() {
    if (!this._anim) return;
    const { from, to, dYaw, t0, dur, easing } = this._anim;
    const k = dur <= 0 ? 1 : Math.min(1, (this.clock.t - t0) / dur);
    const e = ease(/** @type {any} */(easing))(k);
    this._cam.yaw = from.yaw + dYaw * e;
    this._cam.pitch = from.pitch + (to.pitch - from.pitch) * e;
    this._cam.dist = from.dist + (to.dist - from.dist) * e;
    this._cam.target.lerpVectors(from.target, to.target, e);
    this._updateClip();
    this._applyCamera();
    if (k >= 1) this._anim = null;
  }

  resetCamera() {
    this._axisReturn = null;
    if (!this.home) return;
    // `home` is the oblique working view, and restoring it while the orbit is
    // locked would tilt the drawing surface. Locked, a reset restores only how
    // much of the plan is in frame.
    if (this.orbitLocked) {
      this.setCameraState({ ...this.home, yaw: TOP_YAW, pitch: TOP_PITCH }, 0.5);
      return;
    }
    this.setCameraState(this.home, 0.5);
  }

  /* -------------------------------------------------------------- controls */

  _initControls() {
    const c = this.canvas;
    let dragging = false, panning = false, sizing = false, strengthing = false, moved = 0, lastX = 0, lastY = 0;
    // Where the press landed, for telling a click from a drag by NET
    // displacement rather than by path length. See the pointerup handler.
    let downX = 0, downY = 0;

    c.addEventListener("contextmenu", (e) => e.preventDefault());

    // MIDDLE-CLICK AUTOSCROLL. Chrome starts its autoscroll mode on middle
    // `mousedown`, not on `pointerdown` or `auxclick` — so preventing the
    // default on those does nothing, and the browser takes over the pointer
    // mid-orbit. That is what made middle-drag stutter and hang: autoscroll
    // grabs the pointer, our pointermove stops arriving, and the scroll overlay
    // flickers over the canvas. The only listener that suppresses it is
    // mousedown. auxclick is kept as well, to stop the paste-on-middle-click
    // behaviour some platforms add on release.
    c.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    c.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });

    c.addEventListener("pointerdown", (e) => {
      // The app may claim the drag for a brush gesture instead of an orbit.
      if (this.onPointerDown && this.onPointerDown(e) === true) return;
      if (e.button === 1) e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      dragging = true; moved = 0;
      // right button or shift pans; middle button and alt orbit. With the orbit
      // locked, every camera drag pans instead — the alternative is a middle
      // button that does nothing, which reads as the app having hung.
      // ⚠️ SHIFT + RIGHT DRAG SIZES THE BRUSH, and is checked BEFORE the pan
      // test because shift and right-button each already mean "pan" on their
      // own. Both of those routes survive — plain right-drag and shift+left-drag
      // still pan — so this costs no way of moving the camera, it only claims
      // the one combination that was a duplicate.
      // ⚠️ SHIFT DRAGS THE BRUSH'S TWO NUMBERS, ONE PER BUTTON (Marc,
      // 2026-08-13): shift + LEFT sets the strength, shift + RIGHT the radius.
      // A pleasing symmetry, and it costs one of three ways of panning —
      // plain right-drag and the orbit-locked drag both still pan, so no way of
      // moving the camera is lost.
      sizing = e.button === 2 && e.shiftKey && !!this.onBrushResize;
      strengthing = e.button === 0 && e.shiftKey && !!this.onBrushStrength;
      panning = !sizing && !strengthing
        && (this.orbitLocked || e.button === 2 || e.shiftKey);
      lastX = e.clientX; lastY = e.clientY;
      downX = e.clientX; downY = e.clientY;
      this._anim = null;
    });

    // If capture is lost for any reason, drop the drag rather than leaving the
    // camera half-dragging and unresponsive to the next gesture.
    //
    // ⚠️ THE TOOL GESTURE HAS TO END HERE TOO, not just the camera drag. This
    // ended the camera drag only, while the app's own `painting` flag is
    // cleared solely in `onPointerUp` — so a pointercancel or a lost capture
    // left `painting` true for the rest of the session, and every subsequent
    // pointerMOVE went on applying the current tool with no button held. The
    // symptom is not "the camera is stuck": it is that the app appears frozen
    // in whichever tool was last used, because switching tool changes what the
    // runaway gesture paints but not the fact that it is running. It was
    // reported against the substrate painter, where a continuous unasked-for
    // paint is most visible, but it was never specific to that tool.
    //
    // `onPointerUp` opens with `if (!painting) return;`, so calling it on a
    // path where no gesture was running is a no-op and cannot double-fire.
    const endDrag = (e) => {
      dragging = false; panning = false; sizing = false; strengthing = false;
      if (this.onPointerUp) this.onPointerUp(e);
    };
    c.addEventListener("pointercancel", endDrag);
    c.addEventListener("lostpointercapture", endDrag);

    c.addEventListener("pointermove", (e) => {
      if (!dragging) {
        if (this.onPointerMove) this.onPointerMove(e);
        return;
      }
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      // A hand-driven move means the current view is no longer "a detour from"
      // anywhere; the axis buttons go back to snapping.
      this._axisReturn = null;
      if (sizing) {
        // Reported in WORLD units per pixel — the same conversion panning uses —
        // so the brush edge tracks the cursor at any zoom instead of the gesture
        // meaning a different amount of ground depending how far out you are.
        this.onBrushResize(dx * this._cam.dist * 0.0015);
        return;
      }
      if (strengthing) {
        // ⚠️ NOT SCALED BY CAMERA DISTANCE, unlike the radius above, and the
        // difference is real rather than an oversight. A radius is a length ON
        // THE GROUND, so its gesture has to mean the same number of metres
        // however far out you are. A strength is a depth per dab — a property
        // of the tool, not of the view — so it takes a fixed amount per pixel
        // and behaves identically at every zoom.
        // ⚠️ Rightward and upward both INCREASE, so the gesture reads the same
        // whichever axis the hand happens to favour.
        this.onBrushStrength((dx - dy) * 0.0016);
        return;
      }
      if (panning) {
        const k = this._cam.dist * 0.0015;
        const cam = this.activeCamera;
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
        this._cam.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      } else if (!this.orbitLocked) {
        // ⚠️ ORBITING OUT OF A SECTION VIEW RELEASES THE CLIP — the same rule
        // that lets perspective release the plan: serve the camera the hand is
        // asking for. The clip belongs to the square-on section view; orbited
        // away from, a clipped heightfield is an open shell seen from inside —
        // dark undersides, culled gaps, the cut face hanging in space — which
        // reads as the renderer breaking, and was reported as exactly that.
        // Zoom and pan do NOT release it: moving along the cut, or closer to
        // it, is still looking at the section.
        if (this.sectionClipped && this.onSectionOrbit) this.onSectionOrbit();
        this._cam.yaw -= dx * 0.005;
        // drag down = look from lower, matching the 3DGS feel
        this._cam.pitch -= dy * 0.005;
        // Floor the pitch just above the horizon. A heightfield is a function
        // graph: there is nothing meaningful underneath it, and dropping below
        // is how you end up looking at the back of the surface.
        this._cam.pitch = THREE.MathUtils.clamp(this._cam.pitch, 0.02, 1.54);
      }
      this._applyCamera();
    });

    c.addEventListener("pointerup", (e) => {
      if (this.onPointerUp) this.onPointerUp(e);
      if (!dragging) return;
      dragging = false;
      // A middle-button CLICK is its own gesture, distinct from a middle DRAG.
      // Plan mode uses it to hand the camera back without leaving plan mode —
      // see setPlanCameraFree in app.js.
      //
      // ⚠️ JUDGED ON NET DISPLACEMENT, NOT ON `moved`, AND WITH A LOOSER
      // THRESHOLD THAN A PICK. `moved` accumulates PATH LENGTH, and the pick's
      // 5 px is calibrated for a left click, which is a light press on a
      // stationary mouse. A middle click is not: pressing a scroll wheel takes
      // real force and physically shifts the mouse, and in plan mode the orbit
      // is locked so `panning` is already true — meaning that same jiggle pans
      // the camera and adds to `moved` on the way. Measured with a synthetic
      // pointer the path length is 0 and the click registers; with a physical
      // middle button it did not, which is exactly this difference.
      //
      // Net displacement ignores a there-and-back wobble, which is what a press
      // actually produces, while still refusing a genuine pan.
      if (e.button === 1) {
        const slip = Math.hypot(e.clientX - downX, e.clientY - downY);
        if (slip < 12 && this.onMiddleClick) this.onMiddleClick(e);
        return;
      }
      if (moved < 5 && this.onPick) {
        const hit = this.pick(e.clientX, e.clientY);
        if (hit) this.onPick(hit);
      }
    });

    // Zoom towards whatever is under the cursor rather than the orbit pivot:
    // with a fixed pivot you can scroll forever and never arrive at the thing
    // you are looking at.
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      // ⚠️ THE APP MAY CLAIM A WHEEL EVENT, exactly as it may claim a
      // double-click. A hook rather than a listener the app adds itself: at the
      // target element capturing and bubbling listeners both run in
      // registration order, so a later listener on this same canvas could not
      // get in front of this one however it was registered. Returning true
      // means the app handled it and the camera must not also zoom.
      //
      // preventDefault() stays unconditional and above the hook — the browser's
      // own Ctrl+wheel page zoom has never applied over this canvas, and a
      // claimed gesture must not start applying it.
      if (this.onWheel && this.onWheel(e) === true) return;
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height) return;
      this.zoomAt(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
        e.deltaY,
      );
    }, { passive: false });

    // Double-click recentres the pivot on the surface clicked — the quickest
    // way from "the whole site" to "this one hollow".
    c.addEventListener("dblclick", (e) => {
      // The app may claim the double-click, the same way it claims a
      // pointerdown for a brush gesture. Plan mode closes a ring on it, and
      // recentring the camera at the same moment would yank the sheet out from
      // under the ring that was just finished.
      //
      // A hook rather than a capture-phase listener elsewhere: at the TARGET
      // element, capturing and bubbling listeners both run in registration
      // order, so a later listener on this same canvas could not get in front
      // of this one however it was registered.
      if (this.onDoubleClick && this.onDoubleClick(e) === true) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (!hit) return;
      this._axisReturn = null;
      this.setCameraState({
        yaw: this._cam.yaw,
        pitch: this._cam.pitch,
        dist: Math.min(this._cam.dist, Math.max(this.sceneRadius * 0.7, 1e-3)),
        target: hit.toArray(),
      }, 0.65);
    });
  }

  /**
   * Zoom towards the point under the cursor — as a pure dolly, with the view
   * direction held exactly constant.
   *
   * The earlier version slid the orbit pivot towards the anchor and then
   * re-derived yaw/pitch from the new pivot. Re-deriving the angles changes the
   * direction the camera looks, so zooming read as the terrain swinging or
   * rotating rather than the view simply moving closer. The fix is to scale the
   * whole camera rig about the anchor point: eye and target are both moved
   * along their vectors from the anchor by the same factor, so yaw and pitch
   * are untouched by construction and the point under the cursor stays under
   * the cursor.
   *
   * @param {number} ndcX @param {number} ndcY @param {number} deltaY
   */
  zoomAt(ndcX, ndcY, deltaY) {
    this._anim = null;
    this._axisReturn = null;
    const scale = Math.exp(deltaY * 0.0012);
    const floor = Math.max(this.sceneRadius * 1e-4, 1e-4);
    const anchor = this._zoomAnchor(ndcX, ndcY);

    if (!anchor) {
      // Nothing under the cursor: fall back to a plain dolly on the pivot.
      this._cam.dist = THREE.MathUtils.clamp(this._cam.dist * scale, floor, 1e6);
      this._updateClip();
      this._applyCamera();
      return;
    }

    const eye = this.activeCamera.position.clone();
    const target = this._cam.target;

    // Clamp the scale so the dolly cannot overshoot through the anchor or push
    // the pivot absurdly far away.
    const distToAnchor = eye.distanceTo(anchor);
    let s = scale;
    if (distToAnchor * s < floor) s = floor / Math.max(distToAnchor, 1e-9);

    // eye' = anchor + (eye - anchor) * s ; target' = anchor + (target - anchor) * s
    const newEye = anchor.clone().addScaledVector(eye.clone().sub(anchor), s);
    const newTarget = anchor.clone().addScaledVector(target.clone().sub(anchor), s);

    const v = newEye.sub(newTarget);
    const d = v.length();
    if (d > 1e-6) {
      this._cam.target.copy(newTarget);
      this._cam.dist = THREE.MathUtils.clamp(d, floor, 1e6);
      // yaw/pitch are mathematically unchanged by a uniform scale about a
      // point, so they are deliberately NOT recomputed here.
    }
    this._updateClip();
    this._applyCamera();
  }

  /**
   * Surface point to zoom towards, cached across a scroll burst so a raycast
   * is not repeated for every notch at the same spot.
   * Uses the rAF timestamp rather than the scene clock on purpose: this is
   * input debouncing, not animation, and must not freeze under a fixed clock.
   */
  _zoomAnchor(ndcX, ndcY) {
    const now = this._rafNow;
    const a = this._anchor;
    if (a && now - a.at < 500 &&
        Math.abs(ndcX - a.x) < 0.02 && Math.abs(ndcY - a.y) < 0.02) {
      a.at = now;
      return a.point;
    }
    const point = this.pickNdc(ndcX, ndcY);
    this._anchor = { point, x: ndcX, y: ndcY, at: now };
    return point;
  }

  /* --------------------------------------------------------------- picking */

  /** World point under a client coordinate, or null. */
  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return this.pickNdc(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
  }

  /** @returns {THREE.Vector3 | null} */
  pickNdc(ndcX, ndcY) {
    if (!this.pickTarget) return null;
    this._raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.activeCamera);
    const hits = this._raycaster.intersectObject(this.pickTarget, false);
    return hits.length ? hits[0].point.clone() : null;
  }

  /* ------------------------------------------------------------------ loop */

  _resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    // No layout yet (container hidden, window collapsed). Keep the last size
    // rather than shrinking to nothing, so the view returns intact.
    if (!w || !h) return;
    const dpr = this.renderer.getPixelRatio();
    if (this.canvas.width !== Math.floor(w * dpr) ||
        this.canvas.height !== Math.floor(h * dpr)) {
      this.renderer.setSize(w, h, false);
    }
    if (this.camera.aspect !== w / h) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      // the orthographic frustum is derived from aspect too
      this._applyCamera();
    }
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    this._rafNow = now;
    // ResizeObserver callbacks arrive on the frame loop, which browsers
    // throttle for hidden frames; checking here is two integer comparisons and
    // makes resizing independent of that timing.
    this._resize();

    this.clock.tick();
    this._tickAnim();
    if (this.onFrame) this.onFrame();
    this.renderer.render(this.scene, this.activeCamera);

    // FPS is a diagnostic of real render throughput, so it is measured from the
    // rAF timestamp rather than the scene clock — under a FixedStepClock scene
    // time deliberately does not track wall time, and an "fps" derived from it
    // would be meaningless. This is the only place real time is read for
    // display, and nothing that moves depends on it.
    this._fpsFrames++;
    if (now - this._fpsAt > 500) {
      this.fps = Math.round((this._fpsFrames * 1000) / (now - this._fpsAt));
      this._fpsFrames = 0;
      this._fpsAt = now;
    }
  }
}
