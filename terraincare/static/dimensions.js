// @ts-check
// THE SHEET DRESSING — dimension lines around the patch, in the scene.
//
// Part of the technical-drawing reading of the plan (2026-08-11, with the
// section end-marks in section-view.js): the patch presented as a drawn sheet,
// its extent dimensioned on all four sides. Follows PlanOverlay's conventions,
// because they are the ones this project paid for: geometry LOCAL with the UTM
// origin on the group transform, depth testing OFF so lines lying in the sheet
// cannot shimmer against it, and the exaggeration carried on the group's z
// scale rather than baked into vertices.
//
// ⚠️ VISIBILITY IS THE CALLER'S DECISION. The frame reads as a drawing sheet,
// which is right for plan mode and the instrument and wrong for a bare oblique
// working view — app.js shows it exactly when one of those two is on.

import * as THREE from "three";

const INK = 0x1c1a16;

/**
 * Text as a sprite, from a small canvas. Billboarded, which on a plan reads as
 * ordinary annotation and in an oblique view stays legible instead of
 * foreshortening — the same trade every CAD viewport makes for its labels.
 *
 * ⚠️ SIZING A CANVAS RESETS ITS CONTEXT, fonts included — set the font AFTER
 * width/height, and measure with the same font string both times.
 *
 * ⚠️ `plate` PUTS THE TEXT ON PAPER (2026-08-12, Marc: "with the gray these
 * texts are difficult to read"). A label floating directly on the model has to
 * survive whatever the ramp underneath happens to be doing — dark ink on a dark
 * cut/fill band is unreadable, and the fix is not a heavier colour, because the
 * next layer will defeat that too. A small filleted paper plate behind the text
 * is the same move the readout cards already make against the viewport, and it
 * makes contrast a property of the label rather than a bet on the terrain.
 * @param {string} text
 * @param {{worldHeight?: number, colour?: string, plate?: boolean}} [opts]
 */
export function textSprite(text, opts = {}) {
  const worldHeight = opts.worldHeight ?? 1.6;
  const FONT = '600 48px "Source Sans 3", "Segoe UI", system-ui, sans-serif';
  const pad = opts.plate ? 16 : 10;
  const cv = document.createElement("canvas");
  let g = /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d"));
  g.font = FONT;
  cv.width = Math.ceil(g.measureText(text).width) + pad * 2;
  cv.height = 48 + pad * 2;
  g = /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d"));
  g.font = FONT;
  if (opts.plate) {
    const rr = 12, w = cv.width, h = cv.height;
    g.beginPath();
    g.moveTo(rr, 0); g.arcTo(w, 0, w, h, rr); g.arcTo(w, h, 0, h, rr);
    g.arcTo(0, h, 0, 0, rr); g.arcTo(0, 0, w, 0, rr); g.closePath();
    g.fillStyle = "rgba(253,252,249,0.92)";   // --sheet, the interface's paper
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = "rgba(38,36,31,0.28)";
    g.stroke();
  }
  g.fillStyle = opts.colour ?? "#26241f";
  g.textBaseline = "middle";
  g.fillText(text, pad, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, fog: false,
  });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(worldHeight * (cv.width / cv.height), worldHeight, 1);
  sp.renderOrder = 12;
  return sp;
}

export class DimensionFrame {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.group = new THREE.Group();
    // ⚠️ The origin lives HERE, never in a vertex buffer.
    this.group.position.set(dem.originX, dem.originY, 0);
    this.group.scale.set(1, 1, opts.verticalExaggeration ?? 1);
    this.group.renderOrder = 12;
    this.group.visible = false;
    /** the droppers and the footprint, rebuilt as the ground moves */
    this._dropGroup = new THREE.Group();
    this.group.add(this._dropGroup);

    const w = dem.ncols * dem.cell, h = dem.nrows * dem.cell;
    // The sheet plane: the patch's lowest elevation, so the frame underlines
    // the ground rather than floating through it. Scaled with z like the rest.
    const z = dem.zRange()[0];
    this._baseZ = z;
    this._span = Math.max(w, h);
    const span = Math.max(w, h);
    const off = span * 0.055;   // the dimension line, clear of the patch
    const tick = span * 0.016;  // the 45° architectural tick at each end

    this._line = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.7,
      depthTest: false, depthWrite: false, fog: false,
    });
    // ⚠️ THREE WEIGHTS, THREE JOBS. The dimension lines MEASURE, so they are the
    // most present. The footprint is the model's own plan and reads next. The
    // droppers only CONNECT the two, and a dropper as heavy as a dimension line
    // reads as a wall — which is the misreading this convention exists to avoid,
    // since it puts a vertical surface where the drawing means empty air.
    this._foot = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.5,
      depthTest: false, depthWrite: false, fog: false,
    });
    this._drop = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.28,
      depthTest: false, depthWrite: false, fog: false,
    });

    const segs = [];
    /** @param {number[][]} pts polyline in local XY at the sheet plane */
    const line = (pts) => { segs.push(pts); };

    // One side: extension lines from the corners, the dimension line, and an
    // ARROWHEAD at each end.
    //
    // ⚠️ ARROWS, NOT THE 45° OBLIQUE (2026-08-13, Marc's call). The oblique tick
    // is the architectural convention and the note here used to defend it on
    // the grounds that arrowheads clog at small print sizes. That reasoning was
    // inherited from paper drawings and does not hold for this object: these
    // dimensions are drawn in the VIEWPORT at a size that follows the model, on
    // screen and in a screen recording, where nothing is reduced to 1:200 and an
    // arrow is simply less ambiguous — an oblique tick has to be read as a
    // terminator, an arrow states which way the measurement runs. The printed
    // sheets in export/ are a separate drawing system and are untouched.
    //
    // ⚠️ THE HEAD POINTS OUTWARD, ALONG THE DIMENSION LINE — toward the witness
    // line it terminates at, which is the convention that makes an arrow mean
    // "the measurement ends HERE" rather than "something is over there". Drawn
    // as two barbs off the tip rather than a filled triangle: everything else in
    // this overlay is line-work of one weight, and a solid head would be the
    // only filled mark in the scene.
    // South (y=0) and north (y=h) dimension the WIDTH; west/east the HEIGHT.
    const side = (a, b, out) => {
      const [ax, ay] = a, [bx, by] = b, [ox, oy] = out;
      const gap = off * 0.25;
      line([[ax + ox * gap, ay + oy * gap], [ax + ox * (off + tick), ay + oy * (off + tick)]]);
      line([[bx + ox * gap, by + oy * gap], [bx + ox * (off + tick), by + oy * (off + tick)]]);
      line([[ax + ox * off, ay + oy * off], [bx + ox * off, by + oy * off]]);
      // The unit vector ALONG the dimension line, from a toward b.
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      // Barb geometry: length along the line, half-width across it. 0.42 of the
      // barb length gives roughly the 15° half-angle a drafting arrow carries.
      const head = tick * 1.15, wing = head * 0.42;
      const tips = [
        { px: ax + ox * off, py: ay + oy * off, sx: ux, sy: uy },   // points back along +u
        { px: bx + ox * off, py: by + oy * off, sx: -ux, sy: -uy },
      ];
      for (const { px, py, sx, sy } of tips) {
        // Two barbs from the tip, each swung off the shaft by the wing offset.
        const bxx = px + sx * head, byy = py + sy * head;
        line([[px, py], [bxx - sy * wing, byy + sx * wing]]);
        line([[px, py], [bxx + sy * wing, byy - sx * wing]]);
      }
    };
    side([0, 0], [w, 0], [0, -1]);   // south
    side([0, h], [w, h], [0, 1]);    // north
    side([0, 0], [0, h], [-1, 0]);   // west
    side([w, 0], [w, h], [1, 0]);    // east

    for (const pts of segs) {
      const pos = new Float32Array(pts.length * 3);
      pts.forEach(([x, y], i) => { pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z; });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const l = new THREE.Line(geo, this._line);
      l.frustumCulled = false;
      this.group.add(l);
    }

    // The figures. One decimal only when the extent is not whole metres —
    // "64 m" reads as a drawing, "64.0 m" reads as apparatus.
    const fmt = (v) => `${v % 1 ? v.toFixed(1) : v.toFixed(0)} m`;
    const lh = span * 0.03;
    const labels = [
      [w / 2, -(off + tick * 2.6), fmt(w)],
      [w / 2, h + off + tick * 2.6, fmt(w)],
      [-(off + tick * 2.6), h / 2, fmt(h)],
      [w + off + tick * 2.6, h / 2, fmt(h)],
    ];
    for (const [x, y, text] of labels) {
      const sp = textSprite(String(text), { worldHeight: lh });
      sp.position.set(Number(x), Number(y), z);
      this.group.add(sp);
    }

    this.refresh();
  }

  /**
   * The corner droppers and the footprint rectangle.
   *
   * ⚠️ THE OLDEST TRICK IN AXONOMETRIC DRAWING, and it is doing real work rather
   * than decoration. A heightfield floating in space gives the eye no purchase
   * on where it actually sits: four verticals down to a datum and a rectangle
   * joining their feet fix the model over its own plan, and the plan is the same
   * extent the dimension lines have just measured. Without it a tilted view of a
   * tilted landform is genuinely ambiguous about which way the ground falls.
   *
   * ⚠️ REBUILT, BECAUSE THE TOPS MOVE. The droppers start at the terrain's four
   * corner elevations, so any edit that touches a corner leaves them hanging —
   * the same class of staleness as the contours, the sections, the apron, the
   * selection outline and the cut face. They are kept in their own group so a
   * refresh rebuilds four lines and a rectangle rather than re-rasterising the
   * dimension labels, which are canvas textures and cost real time.
   *
   * ⚠️ THE SHEET PLANE ITSELF IS NOT REBUILT, deliberately. It is set when the
   * tile loads and the dimension lines and figures sit on it. Those figures
   * measure the PLAN EXTENT — 64 m — which no edit can change; only the droppers
   * describe elevation, so only they need to follow the ground.
   */
  refresh() {
    for (const c of [...this._dropGroup.children]) {
      this._dropGroup.remove(c);
      /** @type {any} */ (c).geometry?.dispose();
    }
    const dem = this.dem;
    if (!dem) return;
    const w = dem.ncols * dem.cell, h = dem.nrows * dem.cell;
    const z = this._baseZ;
    const at = (r, c) => dem.z[r * dem.ncols + c];
    // ⚠️ ROWS COUNT SOUTHWARD FROM THE NORTH EDGE while local y increases
    // northward — the same inversion that shipped the apron inside out. Row 0 is
    // y = h, not y = 0.
    const corners = [
      [0, 0, at(dem.nrows - 1, 0)],              // south-west
      [w, 0, at(dem.nrows - 1, dem.ncols - 1)],  // south-east
      [w, h, at(0, dem.ncols - 1)],              // north-east
      [0, h, at(0, 0)],                          // north-west
    ];

    const add = (pts, closed) => {
      const n = pts.length;
      const pos = new Float32Array(n * 3);
      pts.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const l = closed ? new THREE.LineLoop(geo, this._foot)
        : new THREE.Line(geo, this._drop);
      l.frustumCulled = false;
      l.renderOrder = 12;
      this._dropGroup.add(l);
    };

    // The footprint: the plan the model stands over, and the same rectangle the
    // four dimension lines describe.
    add(corners.map(([x, y]) => [x, y, z]), true);

    for (const [x, y, cz] of corners) {
      // A hole at a corner has no elevation to drop from; nothing is drawn
      // rather than a line to an invented height.
      if (!Number.isFinite(cz)) continue;
      add([[x, y, cz], [x, y, z]], false);
    }
  }

  /** @param {number} v */
  setExaggeration(v) { this.group.scale.z = v; }
  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  dispose() {
    // ⚠️ TRAVERSE, DO NOT WALK THE TOP LEVEL. The droppers and the footprint
    // live in a nested group, so a loop over `group.children` removes that group
    // whole and leaks every geometry inside it.
    const shared = new Set([this._line, this._foot, this._drop]);
    this.group.traverse((c) => {
      /** @type {any} */ (c).geometry?.dispose();
      const m = /** @type {any} */ (c).material;
      // Sprite materials own a canvas texture each; the three line materials are
      // shared by everything and are disposed once, below.
      if (m && !shared.has(m)) { m.map?.dispose(); m.dispose(); }
    });
    this.group.clear();
    for (const m of shared) m.dispose();
  }
}
