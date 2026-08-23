// @ts-check
// WHERE THE CAMERA STOOD — site photographs as marks on the model.
//
// Follows the conventions section-view.js and dimensions.js already set:
// geometry LOCAL with the UTM origin on the group transform (a marker is a
// fresh float32 buffer, so this is exactly where world coordinates creep back
// in), depth testing off so a mark lying on the surface cannot shimmer against
// it, and the vertical exaggeration carried on the group's z scale.
//
// ⚠️ THE MARK IS A PIN, NOT A CAMERA — AND THAT IS A CLAIM ABOUT THE DATA
// (revised 2026-08-11). The first version drew a view cone opening along the
// recorded bearing, which reads as a field of view. The EXIF does not support
// that: it carries GPSImgDirection, a COMPASS HEADING, and nothing about the
// camera's pitch. Checked across the whole 2026-08-11 set — no SubjectDistance,
// no SubjectDistanceRange, no pitch, one focal length throughout — so a frame
// shot straight down at a plant and one shot along a valley are indis-
// tinguishable in the file, and both were being drawn as a horizontal wedge
// looking somewhere. For the down-shots that is simply false.
//
// So the symbol states only what is known, in three parts:
//   · a RING on the ground — the position, which is the solid fact
//   · a STEM and HEAD rising from it — "a photograph was taken here", legible
//     in plan (where a vertical line alone would project to nothing) and in
//     oblique alike
//   · a short flat TICK along the compass heading — subordinate, a line rather
//     than a wedge, because a line says "the phone faced this way" where a
//     wedge says "this is what was in frame". Absent when no heading was
//     recorded.
// Pitch is unknown and therefore undrawn.
//
// ⚠️ AND IT SITS ON THE GROUND, NOT AT THE GPS ALTITUDE. A phone's barometric
// altitude on this site was out by tens of metres in the sample set (several
// frames read 0.0 m, one read 116 m on ground near 75 m), so the marks are
// placed on the TERRAIN under the position and the recorded altitude is kept
// only as a reported number. A mark floating in the air would read as data.

import * as THREE from "three";

// ⚠️ THE INTERACTION INK RULE, IN THE SCENE (2026-08-11). The menu's controls
// rest in dark grey and commit to full black on hover or selection; the pins
// follow the same rule, for a reason that is practical rather than tidy —
// opening a photograph tells you WHICH picture but not WHERE it was taken, and
// with every pin identical the answer was a hunt. The selected pin going black
// against a field of grey answers it at a glance, and the list row goes black
// with it so both surfaces say the same thing.
const REST = 0x4a4a4a;
const SELECTED = 0x000000;

export class PhotoOverlay {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.group = new THREE.Group();
    this.group.position.set(dem.originX, dem.originY, 0);
    this.group.scale.set(1, 1, opts.verticalExaggeration ?? 1);
    this.group.renderOrder = 13;
    this.group.visible = false;
    const mesh = (color, opacity) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false,
    });
    const line = (color, opacity) => new THREE.LineBasicMaterial({
      color, transparent: true, opacity,
      depthTest: false, depthWrite: false, fog: false,
    });
    // Three weights: at rest, beyond the tile (same grey, weaker footing), and
    // selected — which is full black at full strength so it reads through a
    // crowd of pins from any distance.
    this._mat = mesh(REST, 0.85);
    this._line = line(REST, 0.5);
    this._faint = mesh(REST, 0.4);
    this._faintLine = line(REST, 0.26);
    this._sel = mesh(SELECTED, 1);
    this._selLine = line(SELECTED, 0.9);
    this.exaggeration = opts.verticalExaggeration ?? 1;
    /** the last setPhotos call, so setExaggeration can rebuild the pins */
    this._last = null;
    /** placed marks, for hit-testing from app.js */
    this.marks = [];
  }

  /**
   * @param {number} v
   * ⚠️ REBUILDS. The group's z scale is right for anything describing the
   * ground and wrong for a symbol standing on it — left alone, a pin becomes
   * a mast at 8× and its head an ellipse. The stem is divided by this factor
   * and the head un-scaled by it, both of which are baked at build time, so
   * changing the exaggeration has to rebuild rather than merely re-scale.
   */
  setExaggeration(v) {
    this.group.scale.z = v;
    if (this.exaggeration === v) return;
    this.exaggeration = v;
    if (this._last) this.setPhotos(this._last.photos, this._last.opts);
  }
  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }

  _clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      /** @type {any} */ (c).geometry?.dispose();
    }
    this.marks = [];
  }

  /**
   * @param {{name:string,x:number,y:number,bearing:number|null}[]} photos
   * @param {{radius?: number}} [opts] how far BEYOND the tile to keep drawing
   *   marks, in metres. Default 1000.
   *
   * ⚠️ MARKS BEYOND THE TILE ARE DRAWN DIFFERENTLY, AND THE DIFFERENCE IS THE
   * POINT (2026-08-11). A 64 m patch is far smaller than a site walk, so
   * skipping everything outside it hid most of a visit — but a photograph
   * taken off the surveyed grid has NO measured ground under it, and giving it
   * a solid mark at an invented height would state a position the data does
   * not support. So: on the tile, a filled disc standing on the terrain; off
   * it, an open ring at the height of the NEAREST measured cell, which is an
   * honest "about here, at about that level, beyond the model". Two marks, two
   * claims, visibly different.
   */
  setPhotos(photos, opts = {}) {
    this._clear();
    this._last = { photos, opts };
    const { originX, originY, nrows, ncols, cell } = this.dem;
    const span = Math.max(nrows, ncols) * cell;
    const radius = opts.radius ?? 1000;
    const r = Math.max(cell * 2, span * 0.006);   // the ground ring
    // ⚠️ THE STEM IS DIVIDED BY THE EXAGGERATION so the pin keeps ONE height
    // on screen. The group scales z, which is right for anything describing
    // the ground and wrong for a symbol standing on it: at 8× a pin would
    // grow into a mast. Rebuilt by setExaggeration for the same reason the
    // folded sections are.
    const stem = (span * 0.045) / (this.exaggeration || 1);
    const tick = r * 3.2;                          // the compass tick

    for (const p of photos) {
      const lx = p.x - originX, ly = p.y - originY;
      const W = ncols * cell, H = nrows * cell;
      const inside = lx >= 0 && ly >= 0 && lx <= W && ly <= H;
      // Distance to the tile's edge — 0 inside it — so the radius means what
      // it says: how far beyond the surveyed ground to keep drawing.
      const dx = Math.max(0, Math.max(-lx, lx - W));
      const dy = Math.max(0, Math.max(-ly, ly - H));
      if (Math.hypot(dx, dy) > radius) continue;
      // Clamped sample: the nearest measured cell. Inside the tile that IS the
      // cell under the camera; outside, it is the closest thing to ground truth
      // available, and the open ring says the height is borrowed.
      const z = this._groundAt(
        Math.min(originX + W - cell / 2, Math.max(originX + cell / 2, p.x)),
        Math.min(originY + H - cell / 2, Math.max(originY + cell / 2, p.y)));
      if (!Number.isFinite(z)) continue;

      // A photograph beyond the surveyed grid keeps the same symbol in a
      // lighter ink: same kind of thing, weaker footing — its height is
      // borrowed from the nearest measured cell, not read under the camera.
      // The selected pin overrides both: black, full strength, wherever it
      // stands, because its job is to be findable.
      const chosen = opts.selected != null && p.name === opts.selected;
      const mat = chosen ? this._sel : inside ? this._mat : this._faint;
      const lin = chosen ? this._selLine : inside ? this._line : this._faintLine;

      // 1. the ground ring — the position, which is the solid fact
      const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.62, r, 20), mat);
      ring.position.set(lx, ly, z);
      ring.renderOrder = 13;
      this.group.add(ring);

      // 2. the stem, and 3. the head — what makes it read as a pin from above
      // as well as from an angle. A sphere for the head because it presents
      // the same circle from every camera, with no texture and no billboard.
      const sg = new THREE.BufferGeometry();
      sg.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
        lx, ly, z, lx, ly, z + stem,
      ]), 3));
      const stemLine = new THREE.Line(sg, lin);
      stemLine.frustumCulled = false;
      this.group.add(stemLine);

      // The selected head is also LARGER. Colour alone is a weak signal at
      // the size these draw on a 1 km tile; size plus black is unmistakable.
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(r * (chosen ? 0.95 : 0.62), 10, 8), mat);
      head.position.set(lx, ly, z + stem);
      // ⚠️ THE HEAD IS UNSCALED IN Z. The group stretches z by the
      // exaggeration, which would squash a sphere into a lens; undoing it here
      // keeps the head round at every setting.
      head.scale.set(1, 1, 1 / (this.exaggeration || 1));
      head.renderOrder = 13;
      this.group.add(head);

      // 4. the compass tick — a LINE, not a wedge. See the header: the file
      // records a heading, not a field of view, and not a pitch.
      if (p.bearing !== null && p.bearing !== undefined) {
        // ⚠️ A COMPASS BEARING IS CLOCKWISE FROM NORTH; the world is
        // counter-clockwise from EAST. Getting this backwards mirrors every
        // mark about the north–south axis and still looks entirely plausible,
        // which is why it is written out rather than inlined.
        const th = ((90 - p.bearing) * Math.PI) / 180;
        const tg = new THREE.BufferGeometry();
        tg.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
          lx + Math.cos(th) * r, ly + Math.sin(th) * r, z,
          lx + Math.cos(th) * tick, ly + Math.sin(th) * tick, z,
        ]), 3));
        const t = new THREE.Line(tg, lin);
        t.frustumCulled = false;
        this.group.add(t);
      }
      // World position kept on the mark, not just the local one: app.js
      // projects these to find which pin the pointer is over. `zTop` is the
      // head, which is what the pointer is actually aiming at.
      this.marks.push({ ...p, z, zTop: z + stem, inside, lx, ly, r });
    }
    this.count = this.marks.length;
  }

  /** Terrain height under a world point, or NaN off-grid. */
  _groundAt(x, y) {
    const { originX, originY, nrows, ncols, cell, z } = this.dem;
    const c = Math.floor((x - originX) / cell);
    const r = Math.floor((originY + nrows * cell - y) / cell);
    if (r < 0 || c < 0 || r >= nrows || c >= ncols) return NaN;
    return z[r * ncols + c];
  }

  dispose() {
    this._clear();
    for (const m of [this._mat, this._line, this._faint, this._faintLine,
      this._sel, this._selLine]) m.dispose();
  }
}

/**
 * Which pin is under a screen point — the pure geometry, so it can be tested.
 *
 * ⚠️ PROJECTED, NOT RAYCAST. The marks lie flat ON the terrain with depth
 * testing off, so a ray would have to fight the surface for the hit and would
 * miss a pin the user can plainly see. Projecting the pin's own world points and
 * measuring in pixels tests exactly what is on screen.
 *
 * ⚠️ THE TARGET IS THE WHOLE STEM, NOT ITS TWO ENDS (2026-08-12, Marc: "…
 * sometimes instead of selecting you are painting"). A pin is drawn as a line
 * between the ground ring and the head, and every pixel of it is pin that the
 * user can see and aim at. Tested as a 24 px disc at each end instead, a click
 * halfway up a stem standing 192 px tall on screen is ~96 px from both and hits
 * neither — and the miss falls through to the brush, so aiming at a photograph
 * paints the terrain. MEASURED on the 41-photograph August walk, sampling along
 * each pin as drawn: at the default framing the two-disc rule caught 100 % of
 * the pin, but zoomed in — which is exactly when a person is aiming at one —
 * it fell to 94.4 %, then 71.4 %, then 63.8 %. Better than a third of the pin
 * was dead, and nothing about the dead part looked different. Distance to the
 * SEGMENT is 100 % at every zoom, because it is what "on the pin" means.
 *
 * ⚠️ AND THE TOLERANCE CANNOT BE A CONSTANT. The ground ring is drawn in METRES,
 * so it grows on screen as the camera comes in — measured up to 93 px of radius
 * — and a click plainly inside a ring that large was further than 24 px from its
 * centre and missed. The tolerance takes the ring's own projected radius
 * wherever that is larger, so the target is the pin as drawn.
 *
 * @param {{x:number, y:number, z:number, zTop?:number, r?:number}[]} marks
 * @param {number} px @param {number} py pointer, in canvas pixels
 * @param {(x:number, y:number, z:number) => [number, number]|null} project
 *   world → canvas pixels, or null when the point is behind the camera
 * @param {{pad?:number}} [opts]
 * @returns {any|null} the nearest mark whose drawn extent covers the point
 */
export function nearestPin(marks, px, py, project, opts = {}) {
  const pad = opts.pad ?? 24;
  /** Distance from the pointer to the segment a→b, in pixels. */
  const toSegment = (a, b) => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L2 = vx * vx + vy * vy;
    const t = L2 > 0
      ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / L2))
      : 0;
    return Math.hypot(a[0] + t * vx - px, a[1] + t * vy - py);
  };

  let best = null, bestD = Infinity;
  for (const m of marks) {
    const foot = project(m.x, m.y, m.z);
    const head = project(m.x, m.y, m.zTop ?? m.z);
    if (!foot && !head) continue;
    // The ring as it is actually drawn, measured rather than assumed: a world
    // point on its rim, projected, and the pixel distance back to the centre.
    const rim = m.r && foot ? project(m.x + m.r, m.y, m.z) : null;
    const ringPx = rim && foot ? Math.hypot(rim[0] - foot[0], rim[1] - foot[1]) : 0;
    const tol = Math.max(pad, ringPx);
    const d = foot && head
      ? toSegment(foot, head)
      : Math.hypot((foot || head)[0] - px, (foot || head)[1] - py);
    if (d < tol && d < bestD) {
      bestD = d;
      const at = head || foot;
      best = { ...m, sx: at[0], sy: at[1] };
    }
  }
  return best;
}
