// @ts-check
// THE MORPH — one ground becoming another, with what it costs beside it.
//
// Marc, 2026-09-08: "on the left ... how it morphes from as surveyed -> to the
// terraced uniform -> to the terraced by landform -> to the steep ground only ->
// to the pit and mound -> ... to a very smoothed version -> and then back to the
// original state. - and on the right ... an orthographic map projection of 2-4
// attributes displayed in black and white hatches or linework which basically
// shows an increase or decrease".
//
// ⚠️⚠️ stateAt(t) IS A PURE FUNCTION OF t AND MUST STAY ONE. Frames are rendered
// out of order by the seam check and at random by the suite, so a timeline built
// by accumulating edits — level a bit more each frame — would give a different
// surface depending on the route taken to t. The six grounds are therefore built
// ONCE, up front, and every frame is a per-cell MIX between two of them. This is
// the same rule timeline.js carries, for the same reason.
//
// ⚠️ THE LEFT PANEL IS A PROFILE STACK, NOT A RENDER. Every other drawing in this
// project that shows the ground in three dimensions goes through three.js; this
// one is drawn as N south-to-north sections stacked in axonometric, each filled
// with the stage colour and stroked on top, so the one in front hides the one
// behind. That is a painter's algorithm with no depth buffer and no lighting,
// which means it is ONE INK — the same ink as the hatches on the right — and the
// two halves of the frame read as a single drawing rather than a photograph next
// to a diagram. It also morphs honestly: a section is the surface, so terraces
// arrive as steps and the pit-and-mound as ripples, with nothing to interpret.
//
// ⚠️ SECTIONS ARE DRAWN FAR TO NEAR. Reversing that paints the near rows first
// and lets the far ones cover them, which does not look like an error — it looks
// like a differently-shaped hill.

import { analyse } from "./analysis/indices.js";

/**
 * ⚠️⚠️ NO COLOUR ANYWHERE (Marc, 2026-09-08: "can we avoid using the color red
 * and keep everything black and white"). RED is kept as a NAME so nothing has to
 * be renamed at every call site, but it now resolves to the ink — and that is
 * deliberate rather than lazy: any place that used red to mean "this one is
 * above the surveyed value" has to find another way to say it, and a colour
 * hiding behind a variable called RED would be found by nobody. The bars now
 * carry direction by the tick and by which side of it they end on.
 */
export const INK = "#14130F";
export const STAGE = "#FDFCF9";
export const RED = "#14130F";          // was #C8382B — see above
export const DIM = "#7C776C";
export const HAIR = "#C9C4B8";
export const FONT = '"Source Sans 3", system-ui, sans-serif';

export const W = 1920, H = 1080;
export const FPS = 25;

/**
 * The order the grounds are visited, and how long each is held.
 *
 * ⚠️ IT RETURNS TO `c1-surveyed` SO THE LOOP CLOSES. The last transition targets
 * the first state, and the last frame must land on frame 0's surface or the film
 * jumps every time it repeats at the poster.
 */
export const ORDER = [
  "c1-surveyed", "c3-uniform", "c4-landform", "c5-attribute",
  "c6-pattern", "smoothed", "c1-surveyed",
];

/**
 * Seconds held still on each ground, and seconds spent moving to the next.
 *
 * ⚠️ WAS 4 s HELD AND 3 s MOVING, WHICH READ AS A SLIDESHOW. Marc, 2026-09-08:
 * "most of the time it stands in one state and then shifts very fast into the
 * other, opposed to this being a constant gradual change in morphology". Two
 * things were doing that. The holds were longer than the moves, so the film was
 * still for most of its length; and smoothstep puts nearly all of a move's
 * displacement into its middle third, so what movement there was arrived in a
 * rush. 1 s held against 6.5 s moving inverts the ratio — the film is now
 * changing 93 % of the time — and the ease below spreads the change evenly.
 *
 * 7 x 1.0 + 6 x 6.5 = 46.0 s exactly, so the frame count is unchanged at 1,150
 * and nothing downstream has to be re-specified.
 */
export const HOLD = 1.0;
export const MOVE = 6.5;

/** One full cycle. 7 stops: 7 holds + 6 moves. */
export const DURATION = ORDER.length * HOLD + (ORDER.length - 1) * MOVE;

/**
 * A TRAPEZOIDAL velocity profile, not smoothstep.
 *
 * ⚠️ SMOOTHSTEP IS THE WRONG CURVE FOR A LONG MOVE. Its velocity is a parabola
 * peaking at 1.5x the mean, so half the displacement happens in the middle
 * third and the ends barely move — over 6.5 s that reads as a pause, a lurch,
 * and another pause. This ramps the RATE up over the first 18 %, holds it
 * constant, and ramps it down over the last 18 %: the ground changes at one
 * steady speed for most of the move, with no velocity step at either end.
 */
const RAMP = 0.18;
const ease = (u) => {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const r = RAMP, k = 1 / (1 - r);
  if (u < r) return (u * u / (2 * r)) * k;
  // the tail is the mirror of the head: the displacement still to come is the
  // same shape as the displacement already made at the start.
  if (u > 1 - r) return 1 - ((1 - u) * (1 - u) / (2 * r)) * k;
  return (r / 2 + (u - r)) * k;
};

/**
 * Which two grounds, and how far between them, at time t.
 * @param {number} t seconds, any value; wrapped into [0, DURATION)
 * @returns {{a:number, b:number, u:number, held:boolean}} indices into ORDER
 */
export function stateAt(t) {
  const span = HOLD + MOVE;
  let x = ((t % DURATION) + DURATION) % DURATION;
  const i = Math.min(ORDER.length - 1, Math.floor(x / span));
  const within = x - i * span;
  if (within < HOLD || i >= ORDER.length - 1) {
    return { a: i, b: i, u: 0, held: true };
  }
  return { a: i, b: i + 1, u: ease((within - HOLD) / MOVE), held: false };
}

/**
 * Mix two surfaces into a working DEM, in place.
 *
 * ⚠️ WRITES INTO A DEM THAT ALREADY EXISTS. Allocating a 256x256 Float32Array per
 * frame is 4,500 allocations across a render and the garbage collector will take
 * them back mid-frame; the analysis then runs while the heap is being walked and
 * the per-frame cost stops being predictable.
 *
 * @param {import("./dem.js").DEM} out
 * @param {Float32Array} za @param {Float32Array} zb @param {number} u
 */
export function mixInto(out, za, zb, u) {
  const z = out.z;
  if (u <= 0) { z.set(za); return out; }
  if (u >= 1) { z.set(zb); return out; }
  for (let i = 0; i < z.length; i++) {
    const a = za[i], b = zb[i];
    // a hole in either survey stays a hole in the mix, rather than becoming
    // half of a number
    z[i] = (Number.isFinite(a) && Number.isFinite(b)) ? a + (b - a) * u : NaN;
  }
  return out;
}

// ── the left panel: a stack of sections ─────────────────────────────────────
/**
 * @param {CanvasRenderingContext2D} g
 * @param {import("./dem.js").DEM} dem
 * @param {{x:number, y:number, w:number, h:number, rows?:number,
 *          zScale?:number, depth?:number, shear?:number}} box
 */
export function drawProfiles(g, dem, box) {
  const { z, nrows, ncols } = dem;
  const rows = box.rows ?? 72;
  // ⚠️ HEADROOM IS SIZED TO THE RELIEF, NOT GUESSED. The stack needs room above
  // the first baseline for the tallest z excursion and no more: 20.19 m at
  // 7.2 px/m is 145 px, so 28 % of a 700 px box (196 px) is enough with margin.
  // At 0.52 the drawing sat in the lower half of its panel with 190 px of empty
  // paper above it, which reads as a composition mistake rather than a spare.
  const depth = box.depth ?? box.h * 0.72;   // how far the stack recedes
  const shear = box.shear ?? box.w * 0.16;   // lateral run of the recession
  const zScale = box.zScale ?? 7.2;          // px per metre

  // A fixed datum, taken from the first ground and never re-derived, so the
  // stack does not float up and down as the surface changes. Re-deriving it per
  // frame would hide the very thing the film is showing.
  const datum = box["datum"] ?? 55;

  const usableW = box.w - shear;
  const step = Math.max(1, Math.floor(nrows / rows));

  g.lineJoin = "round";
  g.lineCap = "round";

  // ⚠️⚠️ FAR IS HIGH ON THE PAGE AND IS DRAWN FIRST. The first version had this
  // inverted — the far row's baseline sat at the BOTTOM of the box and each
  // nearer section was drawn higher up. Since every section fills down to the
  // foot of the frame to hide what is behind it, each new fill then painted over
  // everything already drawn, and seventy-two sections rendered as ONE LINE. It
  // did not look like a bug; it looked like a plausible single profile.
  const headroom = box.h - depth;
  for (let r = 0; r < nrows; r += step) {
    const fr = r / (nrows - 1);
    const baseX = box.x + (1 - fr) * shear;   // far rows sit further right
    const baseY = box.y + headroom + depth * fr;
    const pts = [];
    for (let c = 0; c < ncols; c++) {
      const v = z[r * ncols + c];
      const zz = Number.isFinite(v) ? v : datum;
      pts.push([baseX + (c / (ncols - 1)) * usableW, baseY - (zz - datum) * zScale]);
    }
    // fill first, in the stage colour, so this section hides the ones behind it
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.lineTo(pts[pts.length - 1][0], box.y + box.h + 40);
    g.lineTo(pts[0][0], box.y + box.h + 40);
    g.closePath();
    g.fillStyle = STAGE;
    g.fill();
    // then the profile itself
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.strokeStyle = INK;
    g.lineWidth = 1.05;
    g.stroke();
  }
}

// ── the left panel, version 002: shaded mesh with contours on it ────────────
//
// Marc, 2026-09-08: "the big terrain on the left - it is difficult to read with
// the vertical contour lines - could we try one version with horizontal contour
// lines and a shaded underlay of the mesh below".
//
// The stack of SECTIONS is a vertical cut; what he is asking for is the other
// one — true isolines, which are horizontal cuts — over a shaded surface. Both
// are kept: drawProfiles is version 001, this is version 002.
//
// ⚠️⚠️ ONE PROJECTION, SHARED. The mesh and the contours are two drawings of the
// same surface, and if each carried its own copy of the axonometric arithmetic
// they would drift apart by a pixel or two and the lines would float off the
// ground they describe. makeProjector is the only place the mapping exists.
//
// ⚠️ CONTOURS ARE DRAWN BAND BY BAND, INTERLEAVED WITH THE MESH. Drawn all at
// once afterwards they show THROUGH the hills in front of them, because a
// painter's algorithm has no depth buffer to stop them. Each row's quads are
// filled, then that row's contour segments are stroked, then the next row
// covers whatever it should hide.

import { hillshade } from "./analysis/hillshade.js";
import { contourSegments } from "./contours.js";

/** Metres between contours. FIXED, so a change of line count between grounds is
 *  a change in the ground and not a change of scale. */
export const CONTOUR_M = 1.0;

/** Baseline for the plan's "A" and the section's caption. Below the plan key
 *  line at +20, so the two no longer collide. */
export const CAPTION_DY = 42;

/** ⚠️ ONE RADIUS FOR EVERY FRAME IN THE FILM — the plan, the section, the four
 *  attribute panels and the six filmstrip thumbnails. Two radii in one drawing
 *  reads as two kinds of frame, and there is only one kind here. */
export const PANEL_R = 10;

/** roundRect where the browser has it, a plain rect where it does not. */
export function framePath(g, x, y, w, h, r = PANEL_R) {
  g.beginPath();
  if (r && g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

/**
 * Local ground coordinates -> screen, for one box.
 * @param {import("./dem.js").DEM} dem
 * @param {{x:number,y:number,w:number,h:number,depth?:number,shear?:number,
 *          zScale?:number,datum?:number}} box
 */
export function makeProjector(dem, box) {
  const depth = box.depth ?? box.h * 0.72;
  const shear = box.shear ?? box.w * 0.16;
  const zScale = box.zScale ?? 7.2;
  const datum = box.datum ?? 55;
  const headroom = box.h - depth;
  const gw = dem.ncols * dem.cell, gh = dem.nrows * dem.cell;
  const usableW = box.w - shear;
  return (xl, yl, z) => {
    const fr = (gh - yl) / gh;               // 0 = north/far, 1 = south/near
    return [
      box.x + (1 - fr) * shear + (xl / gw) * usableW,
      box.y + headroom + depth * fr - (z - datum) * zScale,
    ];
  };
}

/**
 * The ground as a shaded mesh with contours draped on it.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {import("./dem.js").DEM} dem
 * @param {{x:number,y:number,w:number,h:number,step?:number,depth?:number,
 *          shear?:number,zScale?:number,datum?:number}} box
 */
export function drawTerrain(g, dem, box) {
  const { z, nrows, ncols, cell } = dem;
  const step = box.step ?? 2;
  const P = makeProjector(dem, box);
  const shade = hillshade(dem);
  const gh = nrows * cell;
  const datum = box.datum ?? 55;

  // Contour segments, bucketed by the row band they fall in, so they can be
  // drawn between the mesh rows rather than on top of all of them.
  const { positions } = contourSegments(z, nrows, ncols, cell, CONTOUR_M);
  /** @type {number[][]} */
  const bands = Array.from({ length: nrows }, () => []);
  for (let i = 0; i < positions.length; i += 6) {
    const yl = (positions[i + 1] + positions[i + 4]) / 2;
    const r = Math.max(0, Math.min(nrows - 1,
      Math.round((gh - yl) / cell - 0.5)));
    bands[r].push(i);
  }

  const zAt = (r, c) => {
    const v = z[r * ncols + c];
    return Number.isFinite(v) ? v : datum;
  };

  g.save();
  g.lineJoin = "round";
  g.lineCap = "round";

  for (let r = 0; r + step < nrows; r += step) {
    // ── the shaded band ──
    const yN = gh - (r + 0.5) * cell;
    const yS = gh - (r + step + 0.5) * cell;
    for (let c = 0; c + step < ncols; c += step) {
      const xW = (c + 0.5) * cell, xE = (c + step + 0.5) * cell;
      const a = P(xW, yN, zAt(r, c));
      const b = P(xE, yN, zAt(r, c + step));
      const d = P(xE, yS, zAt(r + step, c + step));
      const e = P(xW, yS, zAt(r + step, c));
      // ⚠️ SHADE IS MAPPED INTO A NARROW LIGHT BAND, not 0-255. A full-range
      // hillshade under black linework reads as a photograph with lines on it;
      // the lines stop being the drawing. 168-252 keeps the modelling legible
      // and leaves the ink the darkest thing in the frame.
      const s = 148 + (shade[r * ncols + c] / 255) * 104;
      g.fillStyle = `rgb(${s | 0},${s | 0},${(s * 0.995) | 0})`;
      g.beginPath();
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
      g.lineTo(d[0], d[1]); g.lineTo(e[0], e[1]);
      g.closePath();
      g.fill();
    }
    // ── this band's contours, on top of it but under everything nearer ──
    g.strokeStyle = INK;
    g.lineWidth = 0.85;
    g.beginPath();
    for (let rr = r; rr < r + step && rr < nrows; rr++) {
      for (const i of bands[rr]) {
        const p0 = P(positions[i], positions[i + 1], positions[i + 2]);
        const p1 = P(positions[i + 3], positions[i + 4], positions[i + 5]);
        g.moveTo(p0[0], p0[1]); g.lineTo(p1[0], p1[1]);
      }
    }
    g.stroke();
  }
  g.restore();
}

// ── the left panel, version 003: TOP VIEW ───────────────────────────────────
//
// Marc, 2026-09-08: "could we try having the big view rather in top view - and
// then also add a grid and perhaps labels of the height contours".
//
// ⚠️ IN PLAN, A CONTOUR IS THE WHOLE DRAWING. The axonometric needed a shaded
// mesh underneath because a line floating in space says nothing about which way
// is downhill; in plan the lines close, nest and read as form on their own, and
// the hillshade can drop back to a whisper. That is also why the grid can go in
// here and could not there: a square grid in plan is a scale, while in
// axonometric it is another set of lines competing with the contours.
//
// ⚠️ THE GRID IS GROUND METRES, NOT SCREEN PIXELS. 8 m squares on a 64 m tile,
// so it reads as eight by eight whatever size the panel is. A grid drawn at a
// fixed pixel pitch would silently change what it measured every time the layout
// moved.
//
// ⚠️ INDEX CONTOURS ARE LABELLED, INTERMEDIATE ONES ARE NOT. Every 5 m carries
// its height and a heavier line; the 1 m lines between are hairlines. Labelling
// all twenty would bury the drawing in numerals, and an unlabelled contour still
// counts — that is what an index line is for.

/** Ground metres between grid lines. */
export const GRID_M = 8;
/** Every Nth contour is an index contour: heavier, and labelled. */
export const INDEX_EVERY = 5;

/**
 * The ground seen from above: grid, contours, labels, and a faint shade.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {import("./dem.js").DEM} dem
 * @param {{x:number,y:number,w:number,h:number,labels?:boolean,
 *          ponds?:{x:number,y:number,v:number}[], pondMax?:number}} box
 *        `ponds` in GROUND metres with volume in m3; `pondMax` is the held scale
 */
export function drawPlan(g, dem, box) {
  const { z, nrows, ncols, cell } = dem;
  const gw = ncols * cell, gh = nrows * cell;
  // ⚠️ ONE SCALE FOR BOTH AXES, and the drawing is centred in whatever box it is
  // given. Fitting x and y independently would stretch a square tile into the
  // panel's aspect and every measured length on screen would be a lie.
  const s = Math.min(box.w / gw, box.h / gh);
  const ox = box.x + (box.w - gw * s) / 2;
  const oy = box.y + (box.h - gh * s) / 2;
  const P = (xl, yl) => [ox + xl * s, oy + (gh - yl) * s];   // yl up, screen down

  g.save();
  framePath(g, ox, oy, gw * s, gh * s);
  g.clip();

  // the faintest shade, so slope direction is legible without competing
  const shade = hillshade(dem);
  const img = g.createImageData(ncols, nrows);
  for (let i = 0; i < ncols * nrows; i++) {
    const v = 232 + (shade[i] / 255) * 23;                   // 232-255
    img.data[i * 4] = v; img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v - 1; img.data[i * 4 + 3] = 255;
  }
  const tmp = document.createElement("canvas");
  tmp.width = ncols; tmp.height = nrows;
  tmp.getContext("2d").putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(tmp, ox, oy, gw * s, gh * s);

  // the grid
  g.strokeStyle = HAIR;
  g.lineWidth = 0.7;
  g.beginPath();
  for (let m = 0; m <= gw + 0.001; m += GRID_M) {
    const a = P(m, 0), b = P(m, gh);
    g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
  }
  for (let m = 0; m <= gh + 0.001; m += GRID_M) {
    const a = P(0, m), b = P(gw, m);
    g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
  }
  g.stroke();

  // the contours, split into index and intermediate
  const { positions } = contourSegments(z, nrows, ncols, cell, CONTOUR_M);
  const isIndex = (zz) => Math.abs(zz / (CONTOUR_M * INDEX_EVERY)
    - Math.round(zz / (CONTOUR_M * INDEX_EVERY))) < 1e-6;
  for (const pass of [0, 1]) {
    g.beginPath();
    g.strokeStyle = INK;
    g.lineWidth = pass ? 1.5 : 0.7;
    g.globalAlpha = pass ? 1 : 0.55;
    for (let i = 0; i < positions.length; i += 6) {
      if ((isIndex(positions[i + 2]) ? 1 : 0) !== pass) continue;
      const a = P(positions[i], positions[i + 1]);
      const b = P(positions[i + 3], positions[i + 4]);
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    }
    g.stroke();
  }
  g.globalAlpha = 1;

  // ── the water, as proportional circles ──────────────────────────────────
  //
  // Marc, 2026-09-08: "the water bodies - could we instead use circles to
  // indicate these?"
  //
  // ⚠️ AREA IS THE DATUM, SO THE RADIUS GOES AS THE SQUARE ROOT. Sizing the
  // RADIUS by volume would overstate a big pond by the square of its size — the
  // classic proportional-symbol error, and one this project has already answered
  // once in poster-circles.mjs. This is the Hadseløya technique: one ink, and the
  // quantity carried by a geometry rather than by a tone.
  //
  // ⚠️ THE SCALE IS HELD ACROSS ALL SIX GROUNDS, passed in rather than derived
  // here. Re-deriving the largest pond per frame would draw every ground's
  // biggest pond at the same size and quietly delete the comparison.
  //
  // ⚠️ AND IT IS BETTER THAN THE FILL FOR A REASON BEYOND STYLE: a filled shape
  // reports where water touches, a circle reports how much there is. The shallow
  // sheet that flickered across the near-flat treads covered a quarter of the
  // tile while holding almost nothing, and as a circle it is correctly tiny.
  if (box.ponds && box.ponds.length) {
    const vmax = box.pondMax || 1;
    // half the lattice spacing: a full circle just touches its neighbours
    const RMAX = (POND_GRID_M * s) * 0.5;
    g.lineWidth = 1;
    for (const p of box.ponds) {
      const rad = RMAX * Math.sqrt(p.v / vmax);
      if (rad < 0.5) continue;                 // below this it is a smudge
      const q = P(p.x, p.y);
      g.beginPath();
      g.arc(q[0], q[1], rad, 0, Math.PI * 2);
      g.fillStyle = INK;
      g.fill();
      // a hairline of stage around each, so touching circles stay countable
      g.strokeStyle = STAGE;
      g.stroke();
    }
  }

  // ── labels on the index contours ────────────────────────────────────────
  // ⚠️ ONE LABEL PER LEVEL PER BAND, placed on a segment that is running
  // roughly horizontally. Labelling every index segment would print the same
  // number hundreds of times along one line; picking the flattest segment in
  // each horizontal band keeps the numeral upright and readable without
  // rotating type, and still puts a height on every line the eye follows.
  if (box.labels !== false) {
    const BANDS = 4;
    /** @type {Map<string, {x:number,y:number,z:number,flat:number}>} */
    const best = new Map();
    for (let i = 0; i < positions.length; i += 6) {
      const zz = positions[i + 2];
      if (!isIndex(zz)) continue;
      const a = P(positions[i], positions[i + 1]);
      const b = P(positions[i + 3], positions[i + 4]);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      const flat = Math.abs(dx) / len;                  // 1 = horizontal
      const band = Math.floor(((a[1] - oy) / (gh * s)) * BANDS);
      const key = zz.toFixed(2) + "|" + band;
      const prev = best.get(key);
      if (!prev || flat > prev.flat) {
        best.set(key, { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z: zz, flat });
      }
    }
    g.font = "600 13px " + FONT;
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const v of best.values()) {
      if (v.flat < 0.55) continue;                      // too steep to sit on
      const txt = v.z.toFixed(0);
      const wpx = g.measureText(txt).width + 7;
      g.fillStyle = STAGE;                              // break the line under it
      g.fillRect(v.x - wpx / 2, v.y - 8, wpx, 16);
      g.fillStyle = INK;
      g.fillText(txt, v.x, v.y);
    }
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
  }

  g.restore();

  // the tile edge, and what the grid is worth
  g.strokeStyle = DIM; g.lineWidth = 1;
  framePath(g, ox + 0.5, oy + 0.5, gw * s, gh * s);
  g.stroke();
  g.fillStyle = DIM; g.font = "13px " + FONT;
  g.fillText(GRID_M + " m grid  ·  " + CONTOUR_M + " m contours, index every "
    + (CONTOUR_M * INDEX_EVERY) + " m"
    + (box.ponds ? "  ·  circles = standing water per " + POND_GRID_M
        + " m, area ∝ volume" : ""),
    // ⚠️ CAPTION_DY, the same baseline the section's caption uses, so the two
    // captions sit on one line across the frame.
    ox, oy + gh * s + CAPTION_DY);

  // ── north ───────────────────────────────────────────────────────────────
  // ⚠️ ROW 0 IS NORTH and the plan is drawn north-up, so the mark points at the
  // top of the frame. It is DRAWN, not lettered: an "N" would be the only
  // letterform doing a diagram's job in a frame that otherwise says everything
  // with geometry.
  const nr = 9;
  const ncx = ox + gw * s - nr;
  const ncy = oy + gh * s + CAPTION_DY - 5;   // on the caption's own line
  // ⚠️ THE CAPTION GREY, NOT INK. It belongs to the apparatus of the drawing —
  // key line, scale, north — not to the ground being drawn, and in ink it read
  // as heavily as the contours it sits under.
  g.strokeStyle = DIM; g.lineWidth = 1.2;
  g.beginPath();
  g.arc(ncx, ncy, nr, 0, Math.PI * 2);
  g.moveTo(ncx, ncy - nr);
  g.lineTo(ncx, ncy);
  g.stroke();

  // ⚠️ THE GEOMETRY IS RETURNED so the section can share it. Two drawings of one
  // surface must not each work out their own mapping — see makeProjector.
  return { ox, oy, s, gw, gh };
}

/**
 * A section cut NORTH-SOUTH, stood on its side beside the plan.
 *
 * Marc, 2026-09-08: "since it is a landscape format ... to the right of the top
 * view have a section going in the y direction there - perhaps not as easy to
 * read since the section is not horizontal but I think it can be fine".
 *
 * ⚠️ IT IS ROTATED SO THE GROUND AXIS STAYS SHARED WITH THE PLAN. Northing runs
 * DOWN the page in both, at the same pixels per metre, so a feature at a given
 * northing sits at the same screen height in each. That is the whole reason to
 * accept a section read sideways: the alternative is a horizontal section under
 * the plan, which frees the reader from tilting their head and costs them the
 * correspondence, which is the more valuable of the two.
 *
 * ⚠️⚠️ 1:1, AND THAT IS WHY THE SCALE COMES FROM THE PLAN. Elevation is drawn at
 * the SAME px/m as northing, so the section carries no vertical exaggeration and
 * the film does not have to declare one. This project removed its exaggeration
 * slider for exactly this reason: a stretched section is a stated distortion
 * with nowhere on screen to state it.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {import("./dem.js").DEM} dem
 * @param {{ox:number,oy:number,s:number,gw:number,gh:number}} geo from drawPlan
 * @param {{x:number, w:number, atX?:number, ref?:Float32Array}} box
 *        `atX` = where to cut, metres; `ref` = the SURVEYED z, drawn dashed
 */
export function drawSection(g, dem, geo, box) {
  const { z, nrows, ncols, cell } = dem;
  const atX = box.atX ?? geo.gw / 2;
  const col = Math.min(ncols - 1, Math.max(0, Math.round(atX / cell - 0.5)));
  const ref = box.ref || null;

  // ⚠️⚠️ THE ELEVATION FRAME IS TAKEN FROM THE SURVEYED GROUND AND HELD. Derived
  // from the CURRENT surface it would rescale every frame: the smoothed state
  // spans 16.9 m against the survey's 20.19, so its profile would be stretched
  // to the same width and the film would show relief being lost while drawing it
  // unchanged. Same failure as a per-frame colour domain, and harder to notice.
  const frameZ = ref || z;
  let lo = Infinity, hi = -Infinity;
  for (const v of frameZ) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  lo = Math.floor(lo) - 1; hi = Math.ceil(hi) + 1;

  const s = geo.s;                                  // px per ground metre, shared
  const need = (hi - lo) * s;
  // if the box cannot hold the relief at 1:1, shrink the FRAME, never the scale
  const x0 = box.x + Math.max(0, (box.w - need) / 2);
  const X = (zz) => x0 + (zz - lo) * s;
  const Y = (r) => geo.oy + (r + 0.5) * cell * s;
  const H = geo.gh * s;

  g.save();
  framePath(g, box.x, geo.oy, box.w, H);
  g.clip();

  // ⚠️⚠️ NO GROUND FILL. It was a neutral grey and still "very dominant" (Marc,
  // 2026-09-08) - it occupied most of a tall frame and became the loudest shape
  // in a drawing whose subject is two thin lines. Nothing is lost by removing
  // it: which side is ground is already told by the profile's own form and by
  // the elevation ticks, and the section now carries the same weight as the
  // linework it sits beside.

  // ⚠️ THE SURVEYED PROFILE STAYS ON THE DRAWING, DASHED, under the current one.
  // Without it the section shows a shape with nothing to read it against, and
  // the whole point of the sequence is what the gesture moved. Drawn first and
  // thin so the live profile reads as the subject and this as the datum.
  if (ref) {
    g.beginPath();
    for (let r = 0; r < nrows; r++) {
      const v = ref[r * ncols + col];
      const px = X(Number.isFinite(v) ? v : lo), py = Y(r);
      if (r === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.setLineDash([5, 4]);
    g.strokeStyle = DIM; g.lineWidth = 1;
    g.stroke();
    g.setLineDash([]);
  }

  // the ground line itself
  g.beginPath();
  for (let r = 0; r < nrows; r++) {
    const v = z[r * ncols + col];
    const px = X(Number.isFinite(v) ? v : lo), py = Y(r);
    if (r === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.strokeStyle = INK; g.lineWidth = 1.8;
  g.stroke();
  g.restore();

  const step = CONTOUR_M * INDEX_EVERY;
  const firstTick = Math.ceil(lo / step) * step;
  // the scale bar's geometry, hoisted so the tick it sits on can open a gap for
  // it — see the bar block below
  // ⚠️ THE BAR IS ONE TICK INTERVAL, NOT TWO. The ticks are 5 m apart in
  // elevation and the bar is 5 m of northing, so at 1:1 the bar must be exactly
  // as long as the gap between two grey lines — a correspondence a reader can
  // check at a glance instead of counting two intervals against it.
  const barLevel = firstTick + step, barM = step;
  const barTop = geo.oy + 20, barLen = barM * s, barGap = 9;
  // elevation ticks, at the index contours, so plan and section share a datum
  g.strokeStyle = HAIR; g.lineWidth = 0.7;
  g.fillStyle = DIM; g.font = "11px " + FONT;
  g.textAlign = "center";
  for (let zz = firstTick; zz <= hi; zz += step) {
    const px = X(zz);
    if (px < box.x || px > box.x + box.w) continue;
    g.beginPath();
    if (Math.abs(zz - barLevel) < 1e-6) {
      // ⚠️ THE TICK BREAKS AROUND THE SCALE BAR. Run through it, the grey line
      // reads as part of the bar — a stem with two serifs — and the bar stops
      // being a separate object you measure with. A gap says the bar sits ON
      // the line rather than being made of it.
      g.moveTo(px, geo.oy); g.lineTo(px, barTop - barGap);
      g.moveTo(px, barTop + barLen + barGap); g.lineTo(px, geo.oy + H);
    } else {
      g.moveTo(px, geo.oy); g.lineTo(px, geo.oy + H);
    }
    g.stroke();
    g.fillText(zz.toFixed(0), px, geo.oy + H + 16);
  }
  g.textAlign = "left";
  g.strokeStyle = DIM; g.lineWidth = 1;
  framePath(g, box.x + 0.5, geo.oy + 0.5, box.w, H);
  g.stroke();

  // ── a GRAPHIC scale, top left inside the frame ──────────────────────────
  //
  // ⚠️⚠️ A BAR, NOT A RATIO WRITTEN OUT. This project already carries the lesson:
  // section-designed.svg declares "horizontal 1:100" as TEXT, which is false the
  // moment the drawing is reduced - and every drawing here is reduced, onto a
  // screen of unknown size. A bar is reduced WITH the drawing and stays true.
  //
  // ⚠️ IT MEASURES THE VERTICAL AXIS, which is northing - the same axis, and the
  // same px/m, as the plan beside it. So one bar scales both drawings, and the
  // "1:1" in the caption is something the reader can check rather than take.
  // ⚠️ THE BAR SITS ON AN ELEVATION TICK, IT DOES NOT FLOAT BESIDE THEM. Placed
  // at an arbitrary inset it read as a second ruler unrelated to the grid that
  // was already there (Marc, 2026-09-08). On the second tick line it coincides
  // with a line the drawing already has, with clear ground either side: the
  // frame edge to its left, the profile to its right.
  //
  // ⚠️ AND IT DOUBLES AS A CHECK ON THE 1:1 CLAIM: the bar is 5 m of NORTHING
  // and the ticks are 5 m apart in ELEVATION, so the two must match exactly.
  const bx = X(barLevel), by = barTop, bl = barLen;
  g.strokeStyle = INK; g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(bx, by); g.lineTo(bx, by + bl);
  g.moveTo(bx - 4, by); g.lineTo(bx + 4, by);
  g.moveTo(bx - 4, by + bl); g.lineTo(bx + 4, by + bl);
  g.stroke();
  g.font = "11px " + FONT;
  g.textBaseline = "middle";
  const lbl = barM + " m";
  const lw = g.measureText(lbl).width;
  g.fillStyle = STAGE;
  g.fillRect(bx + 7, by + bl / 2 - 8, lw + 6, 16);   // only behind the label
  g.fillStyle = DIM;
  g.fillText(lbl, bx + 10, by + bl / 2);
  g.textBaseline = "alphabetic";

  // ⚠️ SHORT ENOUGH TO SIT INSIDE ITS OWN FRAME. The full sentence ran 350 px
  // under a 270 px box and printed across the attribute panels beside it.
  g.fillStyle = DIM; g.font = "13px " + FONT;
  g.fillText("section A\u2013A  \u00b7  1:1", box.x, geo.oy + H + CAPTION_DY);

  // ── and the cut, marked on the plan ────────────────────────────────────
  const cx = geo.ox + atX * s;
  g.strokeStyle = INK; g.lineWidth = 1;
  g.setLineDash([7, 5]);
  g.beginPath();
  g.moveTo(cx, geo.oy - 10); g.lineTo(cx, geo.oy + H + 10);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = INK; g.font = "700 13px " + FONT;
  g.textAlign = "center";
  g.fillText("A", cx, geo.oy - 15);
  // ⚠️ THE "A" SITS BETWEEN THE FRAME AND THE CAPTIONS, not on them. It cannot
  // share CAPTION_DY: the plan's key line runs about 570 px from the left edge
  // and the cut is near the middle of the plan, so the two would print over each
  // other — which is the collision this label has already been moved for once.
  g.fillText("A", cx, geo.oy + H + 20);
  g.textAlign = "left";
}


// ── the right panel: attributes as hatching ─────────────────────────────────
/**
 * Paint a graded hatch straight onto the canvas.
 *
 * The same lattice as tools/hatch-plan.mjs: ONE period split CLASSES ways, so
 * class k draws k lines per period and density is linear in the class. Kept as a
 * separate implementation from the SVG one on purpose — this draws, that
 * serialises — but the geometry must not drift, so the suite checks them against
 * each other rather than trusting the comment.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {Float32Array} f  one value per cell, row 0 = north
 * @param {number} nrows @param {number} ncols
 * @param {{x:number,y:number,w:number,h:number,domain:[number,number],
 *          angle?:number, period?:number, solid?:boolean, blur?:number,
 *          zoom?:number, radius?:number}} o
 */
export function drawHatch(g, f, nrows, ncols, o) {
  const { x, y, w, h } = o;
  const [lo, hi] = o.domain;
  const CLASSES = 5;
  const P = o.period ?? 22;
  const angle = o.angle ?? 0;
  const src = o.solid ? f : blur(f, nrows, ncols, o.blur ?? 0);

  /**
   * ⚠️ ZOOM CROPS THE GRID, IT DOES NOT SCALE THE DRAWING. The panel shows a
   * central sub-rectangle of the tile, so the grid's own edge falls outside the
   * frame. Without it the last hatch line on every side lands exactly on the
   * boundary and gets chopped into a row of ticks — which reads as a dash-dotted
   * border the drawing never asked for, and worst on the 45° panel where the
   * lines meet the edge obliquely. Cropping is also the honest fix rather than
   * hiding the edge under a thicker frame: it is a callout of the patch.
   */
  const zoom = o.zoom ?? 1;
  const gx = (px) => (px / w - 0.5) / zoom + 0.5;   // 0..1 across the grid
  const gy = (py) => (py / h - 0.5) / zoom + 0.5;

  g.save();
  g.beginPath();
  const rad = o.radius ?? 0;
  if (rad && g.roundRect) g.roundRect(x, y, w, h, rad);
  else g.rect(x, y, w, h);
  g.clip();

  if (o.stippleUndefined) {
    // ⚠️⚠️ TESTED ON THE RAW FIELD, NOT THE BLURRED ONE. blur() only returns NaN
    // where EVERY neighbour is NaN, so a 3-cell blur fills almost all of the
    // undefined area in from its edges — the panel then stippled a handful of
    // cells while its own caption said 21 % of the surface had no value. The
    // hatch is a generalisation and should be blurred; the statement about where
    // the index does not exist must come from the index.
    g.fillStyle = "#9E998C";
    for (let py = 3; py < h; py += 6) {
      for (let px = 3; px < w; px += 6) {
        const c = Math.min(ncols - 1, Math.max(0, Math.floor(gx(px) * ncols)));
        const r = Math.min(nrows - 1, Math.max(0, Math.floor(gy(py) * nrows)));
        if (!Number.isFinite(f[r * ncols + c])) g.fillRect(x + px, y + py, 1.5, 1.5);
      }
    }
  }
  /**
   * ⚠️⚠️ CIRCLES, SO THE PANEL IS A LEGEND TO THE MAP. The plan draws water as
   * proportional symbols; a panel that drew the same quantity as a hatch would
   * be a second, unrelated encoding of one thing (Marc, 2026-09-09). With
   * circles the reader learns the symbol once, in the panel, and reads it in the
   * plan. Hatches stay on the FORM measures — flat ground and ruggedness — so
   * the two families of measure are told apart by technique, not just by label.
   *
   * ⚠️ AREA IS THE DATUM HERE TOO, so the radius goes as the square root, and
   * the lattice is COARSER than the plan's on purpose: the panel is a quarter of
   * the width, and a 1 m lattice would put every symbol under two pixels.
   */
  if (o.symbolCells) {
    const cells = o.symbolCells;
    const blocks = blockMeans(src, nrows, ncols, cells);
    const bw = w * (cells / ncols) * zoom;
    const rmax = (bw / 2) * 0.92;
    // ⚠️ OUTLINE FOR WETNESS, FILLED FOR STORAGE. Both are circles, so both read
    // as the same kind of measurement — but only the filled ones mean the same
    // thing as the filled circles in the plan. Fill therefore says "water that
    // stands here"; outline says "a tendency to be wet". The plan's legend is
    // the depressions panel specifically, and this is what makes that legible
    // rather than merely stated.
    //
    // ⚠️ AN OUTLINE NEEDS MORE ROOM THAN A DOT: below about a pixel of radius a
    // stroked circle is a grey smudge, so its floor is higher than the fill's.
    const outline = !!o.symbolOutline;
    g.fillStyle = INK;
    g.strokeStyle = INK;
    g.lineWidth = 0.9;
    for (const b of blocks) {
      const t = Math.max(0, Math.min(1, (b.v - lo) / (hi - lo)));
      const rad = rmax * Math.sqrt(t);
      if (rad < (outline ? 1.0 : 0.4)) continue;
      const gfx = (b.c0 + cells / 2) / ncols, gfy = (b.r0 + cells / 2) / nrows;
      const px = x + w * ((gfx - 0.5) * zoom + 0.5);
      const py = y + h * ((gfy - 0.5) * zoom + 0.5);
      g.beginPath();
      g.arc(px, py, rad, 0, Math.PI * 2);
      if (outline) g.stroke(); else g.fill();
    }
    g.restore();
    return;
  }

  if (o.solid) {
    // The same crop, applied to the cell grid: a cell's rect is scaled by the
    // zoom and re-centred, then the clip above removes what falls outside.
    const sx = (w * zoom) / ncols, sy = (h * zoom) / nrows;
    const ox = x - (w * (zoom - 1)) / 2, oy = y - (h * (zoom - 1)) / 2;
    g.fillStyle = INK;
    for (let r = 0; r < nrows; r++) {
      let c = 0;
      while (c < ncols) {
        if (!(src[r * ncols + c] > 0)) { c++; continue; }
        let c1 = c;
        while (c1 + 1 < ncols && src[r * ncols + c1 + 1] > 0) c1++;
        g.fillRect(ox + c * sx, oy + r * sy, (c1 - c + 1) * sx + 0.4, sy + 0.4);
        c = c1 + 1;
      }
    }
    g.restore();
    return;
  }

  const cls = (px, py) => {
    const c = Math.min(ncols - 1, Math.max(0, Math.floor(gx(px) * ncols)));
    const r = Math.min(nrows - 1, Math.max(0, Math.floor(gy(py) * nrows)));
    const v = src[r * ncols + c];
    if (!Number.isFinite(v)) return 0;
    const t = (v - lo) / (hi - lo);
    return Math.min(CLASSES - 1, Math.max(0, Math.floor(t * CLASSES)));
  };

  const step = w / ncols;

  /**
   * ⚠️⚠️ UNDEFINED IS DRAWN, NOT LEFT BLANK. TWI is undefined wherever the
   * ground is flat — 46 % of the uniform-terraced surface — because ln(a/tanβ)
   * has nothing to divide by on a tread. Left white it is indistinguishable
   * from "driest", and in a silent film the viewer reads white as none. A
   * stipple says "no value here" in a language no reader mistakes for a low
   * one, and it turns the failure into the finding: terracing does not merely
   * dry the ground, it removes the conditions under which wetness is defined.
   */


  g.strokeStyle = INK;
  g.lineWidth = 1.0;
  g.beginPath();

  for (let j = 1; j < CLASSES; j++) {
    const off = (j * P) / CLASSES;
    if (angle === 90) {
      for (let lx = off; lx < w; lx += P) {
        let run = -1;
        for (let ly = 0; ly <= h; ly += step) {
          const on = cls(lx, ly) >= j;
          if (on && run < 0) run = ly;
          else if (!on && run >= 0) {
            g.moveTo(x + lx, y + run); g.lineTo(x + lx, y + ly); run = -1;
          }
        }
        if (run >= 0) { g.moveTo(x + lx, y + run); g.lineTo(x + lx, y + h); }
      }
    } else if (angle === 0) {
      for (let ly = off; ly < h; ly += P) {
        let run = -1;
        for (let lx = 0; lx <= w; lx += step) {
          const on = cls(lx, ly) >= j;
          if (on && run < 0) run = lx;
          else if (!on && run >= 0) {
            g.moveTo(x + run, y + ly); g.lineTo(x + lx, y + ly); run = -1;
          }
        }
        if (run >= 0) { g.moveTo(x + run, y + ly); g.lineTo(x + w, y + ly); }
      }
    } else {
      const d = P * Math.SQRT2;
      for (let k = -h + off * Math.SQRT2; k < w + h; k += d) {
        const t0 = Math.max(-k, 0);
        const len = Math.min(w - k, h) - t0;
        if (len <= 0) continue;
        let run = -1;
        for (let t = t0; t <= t0 + len; t += step) {
          const px = k + t, py = t;
          const on = px >= 0 && px <= w && py >= 0 && py <= h && cls(px, py) >= j;
          if (on && run < 0) run = t;
          else if (!on && run >= 0) {
            g.moveTo(x + k + run, y + run); g.lineTo(x + k + t, y + t); run = -1;
          }
        }
        if (run >= 0) {
          const t = t0 + len;
          g.moveTo(x + k + run, y + run); g.lineTo(x + k + t, y + t);
        }
      }
    }
  }
  g.stroke();
  g.restore();
}

/**
 * Mean of a field over a lattice of `cells` x `cells` blocks.
 *
 * ⚠️ ONE IMPLEMENTATION, USED TWICE — by the panel that draws the symbols and by
 * the sweep that fixes their scale. Two copies would drift, and the drift would
 * show as circles that are all slightly too big or too small: a picture that
 * looks fine and measures wrong.
 *
 * @returns {{r0:number,c0:number,v:number}[]} blocks that have any finite value
 */
export function blockMeans(f, nrows, ncols, cells) {
  const out = [];
  for (let r0 = 0; r0 < nrows; r0 += cells) {
    for (let c0 = 0; c0 < ncols; c0 += cells) {
      let sum = 0, n = 0;
      for (let r = r0; r < Math.min(r0 + cells, nrows); r++) {
        for (let c = c0; c < Math.min(c0 + cells, ncols); c++) {
          const v = f[r * ncols + c];
          if (Number.isFinite(v)) { sum += v; n++; }
        }
      }
      if (n) out.push({ r0, c0, v: sum / n });
    }
  }
  return out;
}

/** Box blur, ignoring non-finite cells. See tools/hatch-plan.mjs. */
export function blur(g, nrows, ncols, rad) {
  if (!rad) return g;
  const t = new Float32Array(g.length), o = new Float32Array(g.length);
  for (let r = 0; r < nrows; r++) for (let c = 0; c < ncols; c++) {
    let s = 0, n = 0;
    for (let d = -rad; d <= rad; d++) {
      const cc = c + d; if (cc < 0 || cc >= ncols) continue;
      const v = g[r * ncols + cc]; if (Number.isFinite(v)) { s += v; n++; }
    }
    t[r * ncols + c] = n ? s / n : NaN;
  }
  for (let c = 0; c < ncols; c++) for (let r = 0; r < nrows; r++) {
    let s = 0, n = 0;
    for (let d = -rad; d <= rad; d++) {
      const rr = r + d; if (rr < 0 || rr >= nrows) continue;
      const v = t[rr * ncols + c]; if (Number.isFinite(v)) { s += v; n++; }
    }
    o[r * ncols + c] = n ? s / n : NaN;
  }
  return o;
}

/** Slope under this many degrees counts as flat. Fixed, never a percentile. */
export const FLAT_DEG = 8;

/**
 * ⚠️⚠️ WATER SHALLOWER THAN THIS IS NOT DRAWN, AND THAT FIXES A REAL FLICKER.
 * Marc, 2026-09-08: "it seems it is flickering - at 00:06 it suddenly inverts
 * and then inverts back". Measured, frame 172 (t = 6.88, u = 0.995) darkened the
 * plan by 43 grey levels for a single frame. The cause is an artefact of the
 * BLEND, not of either ground: a terrace tread that is 99.5 % of the way to
 * level still carries half a per cent of the original micro-relief, which is
 * enough to trap water behind countless millimetre rims across the whole tread.
 * Ponded area at that instant is 24.0 % of the tile; one frame later, at exactly
 * level, it drains to 4.9 %.
 *
 * The whole spike is water under 5 mm deep — at a 5 mm floor the same instant
 * reads 1.3 %, against 1.3 % for the settled ground. 10 mm is taken as the
 * drawing threshold: clear of the artefact, and defensible on its own terms,
 * since a one-centimetre film across a tread is not a water body.
 *
 * ⚠️ IT THRESHOLDS THE DRAWING ONLY. The hollow COUNT stays unfiltered, because
 * those are the figures the matrix sheet publishes — 235, 151, 498, 287, 194 —
 * and they must keep reproducing. The panel shows the water that would stand;
 * the number counts the depressions that exist.
 */
export const WATER_MIN_M = 0.010;

/**
 * Ground metres between water symbols. See readingsOf.
 *
 * ⚠️ 2 m WAS TOO COARSE (Marc, 2026-09-08: "i think we need even more"). At 1 m
 * the tile carries a 64 x 64 lattice, so the water reads as a texture that
 * thickens and thins rather than as a scatter of separate marks — which is the
 * whole reason for going to symbols. The trade is a smaller ceiling on each
 * circle, since a symbol may never exceed half its spacing; that is the right
 * trade, because the FIELD is the reading and no single patch needs to shout.
 */
export const POND_GRID_M = 1.0;

export const PANELS = [
  { id: "flat", label: "Flat ground", unit: "% of the surface",
    angle: 0, period: 22, blur: 1, domain: [FLAT_DEG, 0] },
  // ⚠️ TWI IS BACK, WITH ITS FAILURE MADE VISIBLE. It was pulled once because it
  // is undefined on 46 % of the uniform-terraced ground and the panel emptied
  // exactly where the gesture happened. Stippling the undefined area fixes the
  // reading without hiding the fact, and the unit line states the defined share
  // on every frame so the number is never quoted over a surface it does not
  // cover. Vertical hatch, so it cannot be confused with flat ground (horizontal)
  // or ruggedness (45°).
  // ⚠️ RUGGEDNESS SITS DIRECTLY UNDER FLAT GROUND (Marc, 2026-09-09). The two
  // are the same argument read twice — the gesture buys geodiversity by cutting
  // flat treads — so they belong adjacent, and wetness and storage then follow
  // as what that costs the water. The hatch ANGLES stay distinct regardless of
  // order: horizontal, 45°, vertical, solid.
  // ⚠️ THE INDICES ARE NAMED IN FULL, and by their conventional names: TRI is
  // the TERRAIN Ruggedness Index (Riley et al. 1999) but TWI is the TOPOGRAPHIC
  // Wetness Index (Beven & Kirkby 1979). Renaming the latter "Terrain" would
  // put a name on screen that its own literature does not use, in front of an
  // audience that reads that literature.
  { id: "tri", label: "Terrain Ruggedness Index", unit: "geodiversity",
    angle: 45, period: 22, blur: 1 },
  { id: "twi", label: "Topographic Wetness Index", unit: "mean TWI",
    symbolCells: 16, symbolOutline: true, blur: 1, stipple: true },
  { id: "dep", label: "Closed depressions", unit: "hollows", symbolCells: 16 },
];

/** Everything the right-hand side needs, from one analysis pass. */
export function readingsOf(dem) {
  const a = analyse(dem);
  let flatCells = 0, n = 0;
  for (const v of a.gradient.slopeDeg) {
    if (!Number.isFinite(v)) continue;
    n++; if (v < FLAT_DEG) flatCells++;
  }
  let twiSum = 0, twiN = 0;
  for (const v of a.twi) if (Number.isFinite(v)) { twiSum += v; twiN++; }
  // the drawable water: deep enough to be water. See WATER_MIN_M.
  const dep = a.depressions.depth;
  const shown = new Float32Array(dep.length);
  for (let i = 0; i < dep.length; i++) shown[i] = dep[i] > WATER_MIN_M ? dep[i] : 0;

  // ⚠️⚠️ ONE CIRCLE PER LATTICE NODE, NOT PER WATER BODY. Per-body circles were
  // the obvious reading of "use circles" and they failed for a reason worth
  // keeping: pond volume is heavily skewed, so the largest body set the scale and
  // every other one collapsed to a dot — "one very big one and many small ones"
  // (Marc, 2026-09-08) rather than a field. On a REGULAR lattice each symbol
  // reports the water in a fixed patch of ground, so the sizes are bounded by the
  // patch and vary smoothly across it: the quantity reads as a gradient, which is
  // what the Hadseløya technique actually does.
  //
  // ⚠️ THE LATTICE IS IN GROUND METRES so the field means the same thing at any
  // panel size, and the symbol can never exceed half its spacing, so a full
  // circle means "this patch is as wet as any patch ever gets" and the field
  // stays countable instead of merging into a blob.
  const cell = dem.cell, gh = dem.nrows * cell;
  const area = cell * cell;
  const step = Math.max(1, Math.round(POND_GRID_M / cell));
  const ponds = [];
  for (let r0 = 0; r0 < dem.nrows; r0 += step) {
    for (let c0 = 0; c0 < dem.ncols; c0 += step) {
      let v = 0;
      for (let r = r0; r < Math.min(r0 + step, dem.nrows); r++) {
        for (let c = c0; c < Math.min(c0 + step, dem.ncols); c++) {
          const d = shown[r * dem.ncols + c];
          if (d > 0) v += d * area;
        }
      }
      if (!(v > 0)) continue;
      ponds.push({
        x: (c0 + step / 2) * cell,
        y: gh - (r0 + step / 2) * cell,
        v,
      });
    }
  }
  return {
    fields: {
      flat: a.gradient.slopeDeg, twi: a.twi, tri: a.tri,
      dep: shown,
    },
    values: {
      flat: n ? (flatCells / n) * 100 : 0,
      // ⚠️ THE MEAN IS OVER DEFINED CELLS ONLY, which is the only mean there is
      // — but it therefore describes a shrinking share of the tile as the ground
      // flattens, so `twiDefined` travels with it and is printed beside it.
      twi: twiN ? twiSum / twiN : 0,
      tri: a.metrics.geodiversity,
      dep: a.depressions.depressions.length,
    },
    twiDefined: a.twi.length ? (twiN / a.twi.length) * 100 : 0,
    water: shown,          // the same threshold the panel uses
    ponds,
    storage: a.depressions.totalVolume,
  };
}
