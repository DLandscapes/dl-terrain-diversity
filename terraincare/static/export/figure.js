// @ts-check
// A publishable figure: the analysis raster, its ramp, its units, and enough
// provenance that the image can be read a year later by someone who was not
// here.
//
// The panel on screen is legible because the whole interface is around it — the
// legend under the shading selector, the site card, the method note. An
// exported raster on its own loses all of that, and a colour ramp with no
// legend is decoration. So the figure carries: what the layer is, the ramp with
// its real stretched domain in real units, the site and CRS, the cell size, the
// date, the Kartverket attribution the licence requires, and the fact that this
// is a terrain analysis instrument rather than a prediction. That last line is
// the one most likely to be dropped and the one that matters most once an image
// travels without its author.
//
// Type is drawn in the committed theme's own faces, so a figure lifted into a
// slide still looks like it came from this office.

const INK = "#26241f";
const INK_SOFT = "#7a766d";
const LINE = "#ddd8cf";
// PURE WHITE, not the theme's --sheet (#fdfcf9). The warm paper tone is right
// inside the app, where it sits against the beige sidebar and reads as stock;
// exported and dropped into a slide, a report or the poster it reads as a
// cream rectangle on a white page — the one place the committed theme should
// not follow the image out of the tool. White also lets the figure sit
// invisibly on any white ground without a visible plate edge.
const SHEET = "#ffffff";
const HEAD = '"Source Sans 3", "Segoe UI", system-ui, sans-serif';
const BODY = '"Quattrocento Sans", "Segoe UI", system-ui, sans-serif';

// The whole figure is drawn at 2x and downscaled by whoever displays it.
// At 1x the ~1000 px canvas was visibly pixelated the moment it was zoomed,
// printed, or dropped on a slide - text worst of all. 2x keeps the file
// small enough to email while making type and hairlines crisp; the raster
// cells stay deliberately un-smoothed either way (a DEM cell is a
// measurement, not a sample of something continuous).
const EXPORT_SCALE = 2;

// ONE TONE FOR EVERYTHING BELOW THE RASTER: scale bar, its numbers, the
// compass ring, needle and "N", the credits, and the DL mark.
//
// Before this the footer was a patchwork — the bar's end label bold black
// against its other numbers in grey, the compass needle black against its own
// "N" in grey — which made the apparatus look assembled from parts rather than
// designed. None of these marks is data, and none should out-shout another;
// they are the frame around the evidence. Setting them all to the credits'
// tone is what makes the bottom of the figure read as one band.
const APPARATUS = INK_SOFT;

// Preloaded once so the synchronous canvas composition can stamp it. Guarded:
// the self-test imports scaleBarLength from this module under Node, where
// Image does not exist.
const LOGO = typeof Image !== "undefined" ? new Image() : null;
if (LOGO) LOGO.src = "static/logo-dl.png";

/**
 * The DL mark recoloured to the apparatus tone, built once and cached.
 *
 * The PNG is black artwork, and a black mark beside grey text was the loudest
 * thing in the credits line. Canvas cannot tint on draw, so the mark is stamped
 * into an offscreen buffer and `source-in` floods it with the tone, keeping the
 * alpha channel — which is the only way to recolour a raster logo without
 * shipping a second file.
 * @type {HTMLCanvasElement|null}
 */
let logoTinted = null;
function tintedLogo() {
  if (logoTinted) return logoTinted;
  if (!LOGO || !LOGO.complete || !LOGO.naturalWidth) return null;
  const c = document.createElement("canvas");
  c.width = LOGO.naturalWidth; c.height = LOGO.naturalHeight;
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
  g.drawImage(LOGO, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = APPARATUS;
  g.fillRect(0, 0, c.width, c.height);
  logoTinted = c;
  return c;
}

/**
 * @param {Object} spec
 * @param {Uint8ClampedArray} spec.rgba     the panel buffer, ncols*nrows*4
 * @param {number} spec.ncols @param {number} spec.nrows
 * @param {string} spec.title               e.g. "TWI · wetness"
 * @param {Array<[number,number,number]>} [spec.rampStops]  sampled ramp colours, low→high
 * @param {Array<{label:string, colour:number[], pct?:string}>} [spec.keys]  categorical key instead
 * @param {string} [spec.loLabel] @param {string} [spec.hiLabel]
 * @param {string} [spec.note]              one line under the legend
 * @param {{azimuthsDeg:number[], weights:number[], prevailingDeg:number, source:string}} [spec.rose]
 * @param {number} spec.cellSize            ground units per cell, for the scale bar
 * @param {string} spec.siteLine            site / CRS / cell size
 * @param {Array<[string,string]>} [spec.metrics]  measured figures, label→value
 * @returns {HTMLCanvasElement}
 */
export function composeFigure(spec) {
  const PAD = 34;
  const IMG = 620;              // the raster, square
  const LEGEND_W = 300;
  // ⚠️ FILLETED CORNERS ON THE PLATE AND THE LEGEND BAR (Marc, 2026-08-19), and
  // ONE radius for both, so the two read as parts of one drawing rather than as
  // two graphics that happen to sit side by side.
  // ⚠️ THE RASTER IS CLIPPED TO THE FILLET, NOT INSET INSIDE IT. A rounded frame
  // drawn over a square image leaves four white nicks at the corners, which is
  // the exact failure the standing rule about filleted images records — the
  // frame must be filled edge to edge. Clipping means the data runs to the
  // curve, and the corner cells are cropped rather than blanked. Those corner
  // cells are the only measurements this costs: at a 10 px radius on a 620 px
  // plate that is a little over a tenth of a per cent of the tile, and the
  // graticule and scale bar still read against the full extent.
  const FILLET = 10;
  const W = PAD * 2 + IMG + 28 + LEGEND_W;
  const H = PAD * 2 + IMG + 74; // room for the title above and credits below

  const cv = document.createElement("canvas");
  cv.width = W * EXPORT_SCALE; cv.height = H * EXPORT_SCALE;
  const ctx = /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d"));
  // everything below draws in the same logical coordinates as before
  ctx.scale(EXPORT_SCALE, EXPORT_SCALE);

  ctx.fillStyle = SHEET;
  ctx.fillRect(0, 0, W, H);

  // Title
  ctx.fillStyle = INK;
  ctx.font = `700 25px ${HEAD}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(spec.title, PAD, PAD + 24);

  const top = PAD + 50;

  // The raster, drawn through an offscreen canvas at native size and scaled up
  // with smoothing OFF. A DEM cell is a measurement, not a sample of something
  // continuous, and interpolating it in the export would show detail the data
  // does not have — the same reason the sidebar panels are image-rendering:
  // pixelated.
  const off = document.createElement("canvas");
  off.width = spec.ncols; off.height = spec.nrows;
  /** @type {CanvasRenderingContext2D} */ (off.getContext("2d"))
    .putImageData(new ImageData(spec.rgba, spec.ncols, spec.nrows), 0, 0);

  // Fit inside the square box PRESERVING ASPECT. A dropped GeoTIFF need not be
  // square, and stretching it to fill would make the scale bar below a lie in
  // one axis — the bar is the reason this now matters.
  const scale = Math.min(IMG / spec.ncols, IMG / spec.nrows);
  const dw = spec.ncols * scale, dh = spec.nrows * scale;
  const dx = PAD + (IMG - dw) / 2, dy = top + (IMG - dh) / 2;

  // The raster is drawn INSIDE the rounded clip, so it reaches the curve.
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(dx, dy, dw, dh, FILLET);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, dx, dy, dw, dh);
  ctx.imageSmoothingEnabled = true;
  ctx.restore();

  // A 4x4 graticule over the raster, and a hairline frame around it. The grid
  // is not decoration: with the scale bar it turns the figure into something
  // measurable by eye, because each square is exactly a quarter of the tile —
  // 16 m on the design patch, 256 m on the context tile — so a reader can step
  // off a distance anywhere in the frame instead of only along the bar.
  //
  // Drawn in ink at low alpha rather than in white or black outright: the
  // ramps in this tool run to near-white at one end and near-black at the
  // other, and a single opaque tone would disappear into one of them.
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(dx, dy, dw, dh, FILLET);
  ctx.clip();
  // 0.40, not 0.28: measured against the TWI raster, which is the busiest
  // surface the tool produces, a lighter grid simply disappeared into it.
  ctx.strokeStyle = "rgba(38,36,31,0.40)";
  ctx.lineWidth = 0.85;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const gx = Math.round(dx + (dw * i) / 4) + 0.5;
    const gy = Math.round(dy + (dh * i) / 4) + 0.5;
    ctx.moveTo(gx, dy); ctx.lineTo(gx, dy + dh);
    ctx.moveTo(dx, gy); ctx.lineTo(dx + dw, gy);
  }
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(Math.round(dx) + 0.5, Math.round(dy) + 0.5,
    Math.round(dw), Math.round(dh), FILLET);
  ctx.stroke();

  // Legend column
  const lx = PAD + IMG + 28;
  let ly = top + 4;

  ctx.fillStyle = INK_SOFT;
  ctx.font = `700 12px ${HEAD}`;
  ctx.fillText("LEGEND", lx, ly + 11);
  ly += 26;

  const barW = LEGEND_W, barH = 17;
  if (spec.keys && spec.keys.length) {
    // Named classes get a KEY, one row per class. A gradient here would imply
    // that "ridge" sits between "peak" and "shoulder" on some scale, which is
    // exactly the false ordering the categorical ramp exists to avoid.
    for (const { label, colour, pct } of spec.keys) {
      ctx.fillStyle = `rgb(${colour[0]},${colour[1]},${colour[2]})`;
      ctx.fillRect(lx, ly - 9, 12, 12);
      ctx.strokeStyle = LINE;
      ctx.strokeRect(lx + 0.5, ly - 8.5, 11, 11);
      ctx.fillStyle = INK;
      ctx.font = `12px ${BODY}`;
      ctx.fillText(label, lx + 20, ly);
      if (pct) {
        ctx.font = `700 12px ${HEAD}`;
        ctx.fillStyle = INK_SOFT;
        const w = ctx.measureText(pct).width;
        ctx.fillText(pct, lx + LEGEND_W - w, ly);
      }
      ly += 17;
    }
    ly += 10;
  } else {
    const grad = ctx.createLinearGradient(lx, 0, lx + barW, 0);
    const stops = spec.rampStops || [];
    stops.forEach((c, i) => {
      grad.addColorStop(i / (stops.length - 1), `rgb(${c[0]},${c[1]},${c[2]})`);
    });
    // ⚠️ THE BAR TAKES THE SAME FILLET AS THE PLATE, at a radius scaled to its
    // own height — a 10 px radius on a 17 px bar would round it into a pill and
    // say "tag" rather than "scale". Half the bar height is the ceiling.
    const barR = Math.min(FILLET, barH / 2);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(lx, ly, barW, barH, barR);
    ctx.fill();
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    ctx.roundRect(lx + 0.5, ly + 0.5, barW - 1, barH - 1, barR);
    ctx.stroke();
    ly += barH + 17;

    ctx.font = `13px ${BODY}`;
    ctx.fillStyle = INK;
    ctx.fillText(spec.loLabel || "", lx, ly);
    const hiW = ctx.measureText(spec.hiLabel || "").width;
    ctx.fillText(spec.hiLabel || "", lx + barW - hiW, ly);
    ly += 26;
  }

  if (spec.note) {
    ctx.fillStyle = INK_SOFT;
    ctx.font = `12px ${BODY}`;
    ly = wrap(ctx, spec.note, lx, ly, LEGEND_W, 16);
    ly += 10;
  }

  if (spec.rose) ly = drawRose(ctx, spec.rose, lx, ly, LEGEND_W);

  ctx.fillStyle = INK_SOFT;
  ctx.font = `12px ${BODY}`;
  ly = wrap(ctx, spec.siteLine, lx, ly, LEGEND_W, 16);

  // The measured figures, in the caption column where a reader expects them.
  // A raster on its own says where a value is high; these say what the surface
  // actually IS, and they are the numbers the tool's argument turns on — so an
  // exported figure carries its own evidence rather than needing the app open
  // beside it.
  if (spec.metrics && spec.metrics.length) {
    ly += 16;
    ctx.fillStyle = INK_SOFT;
    ctx.font = `700 12px ${HEAD}`;
    ctx.fillText("MEASURED", lx, ly);
    ly += 8;
    ctx.strokeStyle = LINE;
    ctx.beginPath(); ctx.moveTo(lx, ly + 0.5); ctx.lineTo(lx + LEGEND_W, ly + 0.5); ctx.stroke();
    ly += 18;
    for (const [label, value] of spec.metrics) {
      ctx.font = `12px ${BODY}`;
      ctx.fillStyle = INK_SOFT;
      ctx.fillText(label, lx, ly);
      ctx.font = `700 12px ${HEAD}`;
      ctx.fillStyle = INK;
      const vw = ctx.measureText(value).width;
      ctx.fillText(value, lx + LEGEND_W - vw, ly);
      ly += 19;
    }
  }

  // Scale bar and north arrow, at the FOOT of the caption column — bottom-
  // aligned with the raster, left-aligned with the legend above them. They sat
  // on the image at first, which is the cartographic habit, but here the
  // raster is the evidence and a plate laid over it hides data and competes
  // with ramps that run to white at one end. Out here they read as apparatus,
  // which is what they are.
  drawScaleAndNorth(ctx, {
    x: lx,
    yBottom: top + IMG,
    colW: LEGEND_W,
    metresPerPx: (spec.ncols * spec.cellSize) / dw,
  });

  // Credits, along the bottom. The Kartverket line is a licence obligation, not
  // a courtesy; the instrument line keeps the claim honest once the image
  // travels on its own ("Not a prediction" is the part that must never drop).
  const foot = H - PAD + 6;
  ctx.fillStyle = INK_SOFT;
  ctx.font = `11px ${BODY}`;
  const lead = "Terrain data © Kartverket (hoydedata.no), NLOD / CC BY 4.0 · "
    + "DL-TerrainDiversity, Digital Landscapes · ";
  ctx.fillText(lead, PAD, foot - 15);
  let cx2 = PAD + ctx.measureText(lead).width;
  // A small DL mark, then the address as plain text.
  //
  // It was briefly set in italic with an underline, to read as a link. That was
  // the wrong instinct: the underline in a printed figure promises a click that
  // a JPEG can never honour, and the italic broke the one line of the figure
  // whose whole job is to sit quietly and be legible. An address in running
  // text is already recognisably an address.
  const mark = tintedLogo();
  if (mark) {
    ctx.drawImage(mark, cx2, foot - 15 - 10, 12, 12);
    cx2 += 16;
  }
  ctx.fillText("www.digital-landscapes.com", cx2, foot - 15);
  ctx.fillText("A terrain analysis instrument: indices computed with SAGA/QGIS "
    + "definitions. Not a prediction.", PAD, foot);

  return cv;
}

/**
 * A round scale-bar length for a frame spanning `extentM` ground units, taken
 * from the 1-2-5 series so the bar reads as a measurement rather than as
 * whatever the arithmetic happened to produce.
 *
 * Exported and asserted in the self-test because a scale bar is the one piece
 * of figure chrome a reader will MEASURE AGAINST, and a wrong one is a citable
 * error rather than a cosmetic glitch.
 *
 * @param {number} extentM ground units across the drawn raster
 * @param {number} [fraction] target share of the frame
 */
export function scaleBarLength(extentM, fraction = 0.2) {
  const target = extentM * fraction;
  if (!(target > 0)) return { niceM: 0, label: "" };
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const mant = target / pow;
  const niceM = (mant >= 5 ? 5 : mant >= 2 ? 2 : 1) * pow;
  const label = niceM >= 1000
    ? `${(niceM / 1000).toFixed(niceM % 1000 ? 1 : 0)} km`
    : niceM >= 1 ? `${niceM} m` : `${niceM.toFixed(2)} m`;
  return { niceM, label };
}

/**
 * North arrow and scale bar, inset bottom-right of the raster.
 *
 * Both are cheap to draw and expensive to omit: a terrain figure without a
 * scale is a texture, and one without an orientation cannot be compared with a
 * map. They sit ON the raster rather than beside it so that a reader who crops
 * the image — which is what happens to figures — keeps them.
 *
 * NORTH IS STRAIGHT UP, always, and that is a fact about the data rather than
 * a drawing convention: row 0 of every grid in this tool is the north edge
 * (dem.js), the export writer preserves it, and the self-test asserts it
 * survives a GeoTIFF round trip. If that convention ever broke, this arrow
 * would be the most visible casualty.
 */
function drawScaleAndNorth(ctx, box) {
  const COMPASS_R = 19;
  const compassCx = box.x + box.colW - COMPASS_R - 1;
  const compassCy = box.yBottom - COMPASS_R - 15;

  // ---- North: a tapered needle in a hairline ring -------------------------
  // Three refinements over the first attempt, all of them about weight. The
  // ring is drawn in the theme's rule tone rather than in ink, so it sits
  // behind the needle instead of competing with it. The needle is a TAPERED
  // lozenge — wide at the pivot, pointed at the rim — because a constant-width
  // bar reads as a tally mark, and the taper is what makes it read as an
  // instrument. And the pivot is a small filled dot, which is what stops the
  // shape looking like it is falling out of the bottom of the circle.
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(compassCx, compassCy, COMPASS_R, 0, Math.PI * 2);
  ctx.stroke();

  const tip = compassCy - COMPASS_R + 4.5;
  const tail = compassCy + 5.5;
  ctx.fillStyle = APPARATUS;
  ctx.beginPath();
  ctx.moveTo(compassCx, tip);
  ctx.lineTo(compassCx + 2.6, tail);
  ctx.lineTo(compassCx - 2.6, tail);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(compassCx, compassCy + 3, 1.6, 0, Math.PI * 2);
  ctx.fill();

  // "N" above the ring, where a compass card carries it.
  ctx.font = `700 9px ${HEAD}`;
  ctx.fillStyle = APPARATUS;
  const nW = ctx.measureText("N").width;
  ctx.fillText("N", compassCx - nW / 2, compassCy - COMPASS_R - 6);

  // ---- Scale: a thin run, then a solid block ------------------------------
  // The architectural bar from Marc's reference drawing: the first half is a
  // thin strip, the second half a solid block on the same baseline, with a
  // short riser marking zero. No intermediate labels and no ticks - the
  // thickness change IS the halfway mark, and with lengths from the 1-2-5
  // series half is always a round number anyway. Bolder than the bumped
  // hairline it replaces, which read as ornament at figure size.
  const gap = 26;
  const maxBar = box.colW - COMPASS_R * 2 - gap;
  const { niceM, label } = scaleBarLength(maxBar * box.metresPerPx, 1.0);
  const barPx = Math.round(niceM / box.metresPerPx);
  const bx = Math.round(box.x);
  const by = Math.round(box.yBottom - 16);   // shared bottom edge
  const half = Math.round(barPx / 2);
  const THICK = 6, THIN = 2;

  ctx.fillStyle = APPARATUS;
  ctx.fillRect(bx, by - THICK, 1.25, THICK);            // zero riser
  ctx.fillRect(bx, by - THIN, half, THIN);              // thin first half
  ctx.fillRect(bx + half, by - THICK, barPx - half, THICK); // solid second half

  // Labels above the ends only, as drawn in the reference — same tone and the
  // same weight as each other. The end label was bold black against a grey
  // zero, which made the bar look like two different drawings; the unit it
  // carries is enough to mark it as the one that matters.
  ctx.font = `9px ${HEAD}`;
  ctx.fillStyle = APPARATUS;
  const yLab = by - THICK - 6;
  ctx.fillText("0", bx - 1, yLab);
  ctx.fillText(label, bx + barPx - ctx.measureText(label).width + 1, yLab);
}

/**
 * The directional weighting the wind-exposure layer applied, drawn as a rose.
 *
 * ⚠️ THIS IS NOT A FREQUENCY WIND ROSE, and the caption says so. A conventional
 * rose shows how often the wind blows from each sector, measured. We do not
 * have that for Ørndalen — met.no's directional normals for station SN90450
 * are not published in a form this build can read — and drawing petals with
 * invented percentages beside a real terrain analysis would be fabricating the
 * most citable-looking thing on the page. What is drawn instead is the honest
 * thing and the more useful one: the actual cos-weighted kernel the
 * computation used, straight from `directionalWeights()` in horizon.js, so the
 * rose and the raster cannot disagree.
 *
 * Compass convention: north up, clockwise, matching the azimuths everywhere
 * else in the tool.
 */
function drawRose(ctx, rose, lx, ly, colW) {
  const R = 62;
  const cx = lx + colW / 2;
  // +40, not +16: the compass labels sit R+20 out, so a tighter centre puts
  // "N" on top of the section heading.
  const cy = ly + R + 40;

  ctx.fillStyle = INK_SOFT;
  ctx.font = `700 12px ${HEAD}`;
  ctx.fillText("DIRECTIONAL WEIGHTING", lx, ly + 2);

  // Rings at 0.5 and 1.0 for scale.
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  for (const f of [0.5, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
    ctx.stroke();
  }

  const maxW = Math.max(...rose.weights, 1e-9);
  const step = (Math.PI * 2) / rose.azimuthsDeg.length;

  // Petals. Screen y grows downward while compass bearings grow clockwise from
  // north, so north is -y and east is +x.
  for (let d = 0; d < rose.azimuthsDeg.length; d++) {
    const w = rose.weights[d] / maxW;
    if (w <= 0.001) continue;
    const az = (rose.azimuthsDeg[d] * Math.PI) / 180;
    const a0 = az - step * 0.4, a1 = az + step * 0.4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(a0) * R * w, cy - Math.cos(a0) * R * w);
    ctx.lineTo(cx + Math.sin(a1) * R * w, cy - Math.cos(a1) * R * w);
    ctx.closePath();
    // The wind ramp's own tones, so the rose belongs to the map beside it.
    ctx.fillStyle = `rgba(64,116,140,${0.25 + 0.6 * w})`;
    ctx.fill();
  }

  // The prevailing direction, as an arrow pointing the way the wind comes FROM.
  const pv = (rose.prevailingDeg * Math.PI) / 180;
  const px = cx + Math.sin(pv) * (R + 9), py = cy - Math.cos(pv) * (R + 9);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(px, py);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px, py, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = INK;
  ctx.fill();

  ctx.font = `11px ${HEAD}`;
  ctx.fillStyle = INK_SOFT;
  for (const [label, deg] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
    const a = (deg * Math.PI) / 180;
    const tx = cx + Math.sin(a) * (R + 20), ty = cy - Math.cos(a) * (R + 20);
    const m = ctx.measureText(label).width;
    ctx.fillText(label, tx - m / 2, ty + 4);
  }

  // Clear of the "S" label, which sits R+20 below the centre.
  let y = cy + R + 46;
  ctx.font = `11px ${BODY}`;
  ctx.fillStyle = INK_SOFT;
  y = wrap(ctx, `cos weighting about ${rose.prevailingDeg}°, clipped at zero — `
    + `the lee half of the compass contributes nothing. Not a frequency rose: `
    + `prevailing direction from ${rose.source}.`, lx, y, colW, 15);
  return y + 12;
}

/** Word-wrap, returning the next free baseline. */
function wrap(ctx, text, x, y, maxW, lh) {
  const words = String(text).split(/\s+/);
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      y += lh;
      line = w;
    } else line = test;
  }
  if (line) { ctx.fillText(line, x, y); y += lh; }
  return y;
}
