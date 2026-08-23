// @ts-check
// THE ATTRIBUTE GLYPHS, DRAWN ON THE MODEL.
//
// glyphs.js decides what shape each glyph is; this file owns the three.js
// objects that draw them, and nothing else. Same split as symbols.js /
// symbol-view.js, and the same conventions every overlay here keeps: geometry
// LOCAL with the UTM origin on the group transform (see the float32 note in
// voxels.js — instance and vertex buffers both quantise to 0.5 m at this site's
// northing), and the vertical exaggeration carried on the group's z scale.
//
// ⚠️ ONE BUFFER FOR THE WHOLE FIELD, not a Line per glyph. A legible field is
// one to four thousand glyphs of seven points each; that many Line objects is
// that many draw calls, and the tool would drop frames while a hand is still on
// the brush. Every glyph goes into one LineSegments buffer, which is one draw
// call whatever the count — the same decision, for the same reason, as the
// symbol field and the voxel outlines.
//
// ⚠️ DEPTH TESTING STAYS ON, UNLIKE THE FLAT OVERLAYS. A disc lying in the
// surface has to defeat the depth test or it shimmers against the ground it
// lies on; a glyph STANDS UP OUT of the ground and is a solid object in the
// scene. Switching depth off would draw the far side of the field through the
// near side and destroy the only depth cue a field of thin lines has.

import * as THREE from "three";

const INK = 0x26241f;

export class GlyphField {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.group = new THREE.Group();
    this.group.position.set(dem.originX, dem.originY, 0);
    this.group.scale.set(1, 1, opts.verticalExaggeration ?? 1);
    this.group.renderOrder = 10;
    this.group.visible = false;
    this._ex = opts.verticalExaggeration ?? 1;
    this._mat = new THREE.LineBasicMaterial({
      color: INK, transparent: true, opacity: 0.7, fog: false,
    });
    /** @type {THREE.LineSegments|null} */
    this._lines = null;
    /** glyphs in the last build, for the readout and the suite */
    this.count = 0;
    /** line segments in the last build */
    this.segments = 0;
  }

  /** @param {number} v */
  setExaggeration(v) { this._ex = v; this.group.scale.z = v; }
  /** @param {boolean} on */
  setVisible(on) { this.group.visible = !!on; }
  /** @param {number} v */
  setOpacity(v) { this._mat.opacity = Math.min(1, Math.max(0.05, v)); }

  _clear() {
    if (this._lines) {
      this.group.remove(this._lines);
      this._lines.geometry.dispose();
      this._lines = null;
    }
    this.count = 0;
    this.segments = 0;
  }

  /**
   * @param {{pts:number[]}[]|null} glyphs as buildGlyphs() returns them
   */
  setGlyphs(glyphs) {
    this._clear();
    if (!glyphs || !glyphs.length) return;

    // Two vertices per segment; a glyph of k points has k−1 segments.
    let segs = 0;
    for (const g of glyphs) segs += g.pts.length / 3 - 1;
    if (segs <= 0) return;

    const pos = new Float32Array(segs * 2 * 3);
    let p = 0;
    for (const g of glyphs) {
      const a = g.pts;
      for (let i = 3; i < a.length; i += 3) {
        pos[p++] = a[i - 3]; pos[p++] = a[i - 2]; pos[p++] = a[i - 1];
        pos[p++] = a[i]; pos[p++] = a[i + 1]; pos[p++] = a[i + 2];
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(geo, this._mat);
    lines.frustumCulled = false;
    lines.renderOrder = 10;
    this.group.add(lines);
    this._lines = lines;
    this.count = glyphs.length;
    this.segments = segs;
  }

  dispose() { this._clear(); this._mat.dispose(); }
}
