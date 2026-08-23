// @ts-check
// INSTRUMENT MODE — everything the terrain will tell you, laid over it at once.
//
// ⚠️ THIS IS A PRESENTATION MODE, NOT A NEW THEME, and the distinction is what
// makes it safe to have. The tool's committed look is achromatic: chrome in
// black, grey and white, colour reserved to mean data, and an A1 poster that is
// deliberately greyscale so it prints. None of that changes. What changes is
// that the DELIVERABLE is a screen recording — so there is a case for a mode
// built for the camera, dense and lit, that the figure exporter and the printed
// sheet never see. Switch it off and the instrument is exactly as it was.
//
// ⚠️ IT DRAWS ONLY WHAT THE APP HAS ALREADY MEASURED. Every number here is read
// from the same state the sidebar renders — there is no second computation of
// anything, and nothing is invented to fill a panel. A HUD that computed its own
// figures would be a second implementation of every metric in the tool, and the
// first time one drifted the screen would be showing two different terrains.
// Where a panel has no data yet it draws its frame empty rather than a plausible
// shape, because an empty frame reads as "not yet" and a plausible shape does not.
//
// THE DIAGRAMS, and why each is the right form for its quantity:
//
//   hypsometry   area against elevation — the oldest diagram in geomorphology,
//                and the one that shows at a glance whether ground is a plateau,
//                a slope or a basin. Levelling collapses it to a spike.
//   aspect rose  a circular quantity needs a circular plot; a bar chart of
//                compass bearings puts north at both ends and neither.
//   slope bars   a distribution, so a histogram
//   landform     ten named classes — ranked bars, because the order is by count
//                and not by anything about the classes themselves
//   species      the same, with the invasive marked, because that is the reading
//   balance      cut against fill about a hard zero: a signed gauge, since the
//                whole claim is about a quantity that can be either side of zero
//   water        delivered, split into what stayed and what left: a stacked bar,
//                because the parts sum to the whole and that is the point
//   section      the profile itself, if one has been cut
//
// The one thing deliberately NOT drawn is anything time-varying or animated for
// its own sake. Scanlines and sweeps read as a machine thinking; this machine
// has already finished thinking and the numbers are the result.

/**
 * The palette. ONE theme — paper — since 2026-08-10. There were three: cyan
 * and mono console looks over a dark stage, and this. The Mono button cycled
 * between the two consoles and could never return here, the state the mode
 * opens in; and the deliverable is a screen recording of a tool that is
 * committed to one language with the poster and the video. The consoles went.
 * The tokens keep the theme shape (scrim/label/panel all read through it), so
 * a future variant is a new entry, not a rewrite.
 *
 * PAPER — the readout as part of the interface rather than as a console
 * pasted over it.
 *
 * ⚠️ THESE ARE THE APP'S OWN TOKENS, NOT AN APPROXIMATION OF THEM. Every
 * value below is the literal --line / --ink / --ink-soft / --sheet from
 * style.css, and the scrim is the axis gizmo's own rgba(255,255,255,.82).
 * Eyeballing "about the same grey" is what makes two surfaces that should be
 * one read as two, and this canvas sits a few pixels from those buttons.
 *
 * ⚠️ NO FIELD GRID. A console draws one so its panels sit on something; on
 * paper it reads as graph paper printed over the model and fights the
 * contours, which are real lines about the real ground.
 */
export const THEMES = {
  paper: {
    bg: "#fdfcf9", grid: "rgba(0,0,0,0)", rule: "#ddd8cf",
    ink: "#26241f", dim: "#7a766d", hot: "#26241f",
    /* ⚠️ THE FLAG IS BLACK AND BOLD, NOT RED (2026-08-11, Marc). Colour in
       this interface means data; a warning hue was chrome speaking in the
       ramps' language. Emphasis is weight — flagged rows also render bold. */
    warn: "#000000", fill: "rgba(38,36,31,0.10)",
    /* ⚠️ STRUCTURE INSIDE A PANEL IS NOT THE FIELD GRID, and conflating the
       two is how three readouts silently vanished: the rose's range rings,
       the unlit half of every index bar and the separators in the bottom
       strip all drew in `grid`, which paper sets fully transparent to keep
       graph paper off the model. `faint` is the in-panel version — visible,
       quieter than `rule`. */
    faint: "#e7e2d9",
    /* Lit bar segments rest DARK GREY, not full ink — the interface's rest
       state (2026-08-11, matching the menu's controls and the DL site). The
       bars never hover to black: they are readouts on a pointer-inert canvas,
       and a bar that darkened under the mouse would promise an interaction
       that does not exist. Values and flags keep full ink/warn. */
    bar: "#4a4a4a",
    scrim: "rgba(255,255,255,0.82)",
    /** Filleted, like every button and card in the interface. */
    radius: 5,
    /** Paper wants the interface face, not the console's monospace. */
    face: '"Source Sans 3", "Segoe UI", system-ui, sans-serif',
  },
};

const MONO = '"SF Mono", "Cascadia Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace';

/**
 * Nice tick values across a range, from the 1-2-5 series.
 *
 * ⚠️ The same series the scale bar and the contour interval use. An axis is read
 * off and multiplied in the head exactly as they are, and three different tick
 * rules in one tool would be three different habits to learn.
 * @param {number} lo @param {number} hi @param {number} [target]
 * @returns {number[]}
 */
export function ticks(lo, hi, target = 4) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n <= 1.5 ? 1 : n <= 3.5 ? 2 : n <= 7.5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) {
    out.push(+v.toFixed(10));
  }
  return out;
}

/**
 * Area-by-elevation, as fractions summing to 1.
 *
 * ⚠️ NORMALISED, so the shape can be compared between a surveyed surface and a
 * levelled one whose relief is a hundredth of it. Absolute counts would make the
 * levelled case a single bar of 65 536 and tell you nothing you did not know.
 * @param {Float32Array} z @param {number} [bins]
 */
export function hypsometry(z, bins = 28) {
  let lo = Infinity, hi = -Infinity, n = 0;
  for (let i = 0; i < z.length; i++) {
    const v = z[i];
    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; n++; }
  }
  const out = new Float64Array(bins);
  if (!n || !(hi > lo)) return { bins: out, lo: Number.isFinite(lo) ? lo : 0, hi: Number.isFinite(hi) ? hi : 0, n };
  const span = hi - lo;
  for (let i = 0; i < z.length; i++) {
    const v = z[i];
    if (!Number.isFinite(v)) continue;
    const b = Math.min(bins - 1, Math.floor(((v - lo) / span) * bins));
    out[b] += 1;
  }
  for (let i = 0; i < bins; i++) out[i] /= n;
  return { bins: out, lo, hi, n };
}

/**
 * Aspect as a circular histogram, weighted by slope.
 *
 * ⚠️ WEIGHTED BY SLOPE, because an aspect on flat ground is meaningless — and on
 * this project's own convention it is NaN rather than north, which is exactly
 * the distinction the rose would otherwise destroy by binning it somewhere. A
 * flat surface therefore produces an empty rose, which is the truth.
 * @param {Float32Array} aspectDeg @param {Float32Array|null} slopeDeg @param {number} [sectors]
 */
export function aspectRose(aspectDeg, slopeDeg, sectors = 16) {
  const out = new Float64Array(sectors);
  let total = 0;
  for (let i = 0; i < aspectDeg.length; i++) {
    const a = aspectDeg[i];
    if (!Number.isFinite(a)) continue;
    const w = slopeDeg && Number.isFinite(slopeDeg[i]) ? slopeDeg[i] : 1;
    if (!(w > 0)) continue;
    const s = Math.min(sectors - 1, Math.floor(((a % 360) / 360) * sectors));
    out[s] += w; total += w;
  }
  if (total > 0) for (let i = 0; i < sectors; i++) out[i] /= total;
  return { sectors: out, total };
}

/**
 * A volume in the unit a person would actually say it in.
 *
 * ⚠️ LITRES BELOW A CUBIC METRE, and this is not cosmetic. The design patch's
 * hollows are tiny — a 2 mm event on the POI patch settles into 235 bodies whose
 * MEDIAN is half a litre — and printed as "0.00 m³" every one of them is the
 * same number, which destroys the distribution the figure exists to show.
 *
 * ⚠️ AND ROUNDING TO WHOLE LITRES IS THE SAME MISTAKE ONE DECIMAL PLACE DOWN.
 * The first version rounded, and printed the median body as "0 L" — a real
 * half-litre of standing water reported as nothing at all. Below a litre the
 * figure carries two significant figures instead, because the quantity being
 * shown IS the small one.
 *
 * ⚠️ IT LIVES HERE, in the module with no three.js dependency, so the chart
 * axis, the sidebar readout and the labels on the model all say a volume the
 * same way. Two formatters would drift, and the first symptom would be a pin
 * and an axis disagreeing about the same pond.
 * @param {number} m3
 */
export function fmtVolume(m3) {
  if (!(m3 > 0)) return "0";
  if (m3 >= 1) return `${m3.toFixed(m3 < 10 ? 2 : 1)} m³`;
  const L = m3 * 1000;
  if (L >= 10) return `${Math.round(L)} L`;
  if (L >= 1) return `${L.toFixed(1)} L`;
  return `${Number(L.toPrecision(2))} L`;
}

/** The same units, trimmed for an axis tick where space is the constraint. */
function tickVolume(m3) {
  if (m3 >= 1) return `${+m3.toPrecision(3)} m³`;
  return `${+(m3 * 1000).toPrecision(2)} L`;
}

/**
 * The water bodies a rainfall event produced, as a diagram.
 *
 * ⚠️ WHY A DIAGRAM AND NOT TWO MORE ROWS IN THE METRIC LIST. A count and a total
 * — "20 bodies, 6.9 m³" — are exactly what the list is good at, and they are
 * also what hides the answer: the same two numbers describe twenty puddles of a
 * third of a cubic metre each and one pond holding six and a half with dry
 * ground all round it. Those are different sites, different habitats and
 * different designs, and the difference is a DISTRIBUTION, which is a shape.
 *
 * TWO FORMS, because two different questions get asked of the same set:
 *
 *   rank     each body a bar, largest first. Answers "how many, and how much
 *            each" directly — the number of bars IS the count. A LOG height
 *            scale, because on real ground the largest body is routinely a
 *            thousand times the smallest and a linear axis draws one bar and a
 *            row of dust. The shape of the curve is the argument: differentiated
 *            ground gives a long gentle tail, levelled ground gives nothing at
 *            all, and a single spike means the site drains to one place.
 *   scatter  area against volume, log–log. Answers a different question — is
 *            the water SPREAD or HELD? A body's distance above the diagonal is
 *            its mean depth, so a wet meadow and a pond separate visibly even
 *            when they hold the same total.
 *
 * ⚠️ FULL BODIES ARE MARKED, and it is the most designable thing on the chart. A
 * hollow filled to its spill point is doing no more work: the next millimetre of
 * rain runs straight past it. A hollow well short of full still has capacity in
 * hand. That distinction is invisible in any total.
 *
 * Pure: it draws what it is given and measures nothing. Reading the values off
 * `pondWater` is the caller's job, so there is one implementation of the
 * hydrology and this cannot drift from it.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {{volume:number, area:number, full:boolean, meanDepth:number}[]} bodies
 * @param {{w:number, h:number, mode?:"rank"|"scatter", theme?:any, dpr?:number}} opts
 */
export function drawWaterBodies(g, bodies, opts) {
  const t = opts.theme || THEMES.paper;
  const mode = opts.mode || "rank";
  const W = opts.w, H = opts.h;
  g.save();
  g.clearRect(0, 0, W, H);
  g.fillStyle = t.bg;
  g.fillRect(0, 0, W, H);
  g.font = `500 11px ${t.face}`;
  g.textBaseline = "middle";

  const PAD = { l: 46, r: 10, t: 12, b: 26 };
  const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;

  if (!bodies.length) {
    // ⚠️ AN EMPTY FRAME, NOT A BLANK CANVAS. "No water body on this surface" is
    // a finding — it is the levelled case, and the whole argument — so it is
    // stated. Drawing nothing at all reads as "not computed yet".
    g.strokeStyle = t.faint;
    g.strokeRect(PAD.l + 0.5, PAD.t + 0.5, pw, ph);
    g.fillStyle = t.dim;
    g.textAlign = "center";
    g.fillText("no standing water — every drop leaves", PAD.l + pw / 2, PAD.t + ph / 2);
    g.restore();
    return;
  }

  const axis = (xs, ys, xlab, ylab) => {
    g.strokeStyle = t.rule;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(PAD.l + 0.5, PAD.t);
    g.lineTo(PAD.l + 0.5, PAD.t + ph + 0.5);
    g.lineTo(PAD.l + pw, PAD.t + ph + 0.5);
    g.stroke();
    g.fillStyle = t.dim;
    g.textAlign = "center";
    g.fillText(xlab, PAD.l + pw / 2, H - 8);
    g.save();
    g.translate(11, PAD.t + ph / 2);
    g.rotate(-Math.PI / 2);
    g.fillText(ylab, 0, 0);
    g.restore();
  };

  // Log scale with a floor, so a body of a few litres still has a bar rather
  // than a negative infinity.
  const vMax = Math.max(...bodies.map((b) => b.volume));
  const vMin = Math.min(...bodies.map((b) => b.volume));
  const lg = (v) => Math.log10(Math.max(v, 1e-6));
  const loV = lg(Math.min(vMin, vMax / 1000)), hiV = lg(vMax);
  const spanV = Math.max(hiV - loV, 0.3);

  /**
   * Decade ticks down the volume axis — what a log axis is read off, and the
   * only thing that turns a shape into a quantity.
   *
   * ⚠️ IN THE READOUT'S OWN UNITS. Written as plain decimals, every decade below
   * a litre printed "0.000" — four identical labels down the axis of a chart
   * whose entire subject is that those bodies differ from one another.
   */
  const yTicks = () => {
    g.textAlign = "right";
    for (let d = Math.ceil(loV); d <= hiV + 1e-9; d++) {
      const y = PAD.t + ph - ((d - loV) / spanV) * ph;
      if (y < PAD.t - 1 || y > PAD.t + ph + 1) continue;
      g.strokeStyle = t.faint;
      g.beginPath(); g.moveTo(PAD.l, y + 0.5); g.lineTo(PAD.l + pw, y + 0.5); g.stroke();
      g.fillStyle = t.dim;
      g.fillText(tickVolume(Math.pow(10, d)), PAD.l - 5, y);
    }
  };

  if (mode === "rank") {
    axis(null, null, `${bodies.length} water bodies, largest first`, "volume  (log)");
    const n = bodies.length;
    // Above ~120 bodies individual bars are thinner than a pixel gap, so they
    // are drawn as a continuous profile instead — the same information, and the
    // curve's shape is what is being read at that count anyway.
    const wide = n <= 120;
    const bw = pw / n;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      const hgt = ((lg(b.volume) - loV) / spanV) * ph;
      const x = PAD.l + i * bw;
      g.fillStyle = b.full ? t.ink : t.bar;
      const w2 = wide ? Math.max(1, bw - 1) : Math.max(1, bw);
      g.fillRect(x, PAD.t + ph - hgt, w2, hgt);
    }
    yTicks();
  } else {
    axis(null, null, "surface area  m²  (log)", "volume  (log)");
    const aMax = Math.max(...bodies.map((b) => b.area));
    const aMin = Math.min(...bodies.map((b) => b.area));
    const loA = lg(Math.min(aMin, aMax / 1000)), hiA = lg(aMax);
    const spanA = Math.max(hiA - loA, 0.3);
    // Iso-depth diagonals: volume = depth × area, so a constant mean depth is a
    // straight line on log–log. They turn the cloud into a reading rather than a
    // scatter — how deep, not just how big.
    g.setLineDash([3, 3]);
    for (const d of [0.01, 0.1, 1]) {
      g.strokeStyle = t.faint;
      g.beginPath();
      let started = false;
      for (let px = 0; px <= pw; px += 4) {
        const a = Math.pow(10, loA + (px / pw) * spanA);
        const y = PAD.t + ph - ((lg(a * d) - loV) / spanV) * ph;
        if (y < PAD.t || y > PAD.t + ph) { started = false; continue; }
        if (!started) { g.moveTo(PAD.l + px, y); started = true; } else g.lineTo(PAD.l + px, y);
      }
      g.stroke();
    }
    g.setLineDash([]);
    yTicks();
    // Area ticks along the bottom, so a point can be read as "half a square
    // metre holding two litres" rather than only as a position in a cloud.
    g.textAlign = "center";
    for (let d = Math.ceil(loA); d <= hiA + 1e-9; d++) {
      const x = PAD.l + ((d - loA) / spanA) * pw;
      if (x < PAD.l - 1 || x > PAD.l + pw + 1) continue;
      g.strokeStyle = t.faint;
      g.beginPath(); g.moveTo(x + 0.5, PAD.t); g.lineTo(x + 0.5, PAD.t + ph); g.stroke();
      g.fillStyle = t.dim;
      const v = Math.pow(10, d);
      g.fillText(`${+v.toPrecision(2)}`, x, PAD.t + ph + 10);
    }
    for (const b of bodies) {
      const x = PAD.l + ((lg(b.area) - loA) / spanA) * pw;
      const y = PAD.t + ph - ((lg(b.volume) - loV) / spanV) * ph;
      g.beginPath();
      g.arc(x, y, 2.6, 0, Math.PI * 2);
      // Full bodies solid, bodies with capacity in hand hollow — the ones with
      // room left are the ones a design can still use.
      if (b.full) { g.fillStyle = t.ink; g.fill(); }
      else { g.strokeStyle = t.bar; g.lineWidth = 1.2; g.stroke(); }
    }
  }
  g.restore();
}

/** A simple histogram, normalised. */
export function histogram(values, lo, hi, bins = 24) {
  const out = new Float64Array(bins);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const b = Math.min(bins - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * bins)));
    out[b] += 1; n++;
  }
  if (n) for (let i = 0; i < bins; i++) out[i] /= n;
  return { bins: out, n };
}

/* ------------------------------------------------------------------ drawing */

/** Corner brackets — the one piece of pure styling here, and it earns its place
 *  by making a panel legible as a panel without a filled box or a full border,
 *  neither of which can sit over a rendered model without hiding it. */
function bracket(g, x, y, w, h, t, len = 7) {
  g.strokeStyle = t.rule; g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, y + len); g.lineTo(x, y); g.lineTo(x + len, y);
  g.moveTo(x + w - len, y); g.lineTo(x + w, y); g.lineTo(x + w, y + len);
  g.moveTo(x + w, y + h - len); g.lineTo(x + w, y + h); g.lineTo(x + w - len, y + h);
  g.moveTo(x + len, y + h); g.lineTo(x, y + h); g.lineTo(x, y + h - len);
  g.stroke();
}

/** The dark ground a panel is read against. Inset slightly inside the brackets
 *  so the corner marks read as marks rather than as the edge of a box. */
function scrim(g, x, y, w, h, t) {
  if (!t.scrim) return;
  g.fillStyle = t.scrim;
  if (!t.radius) { g.fillRect(x - 3, y - 3, w + 6, h + 6); return; }
  // ⚠️ FILLETED AND BORDERED, matching the axis gizmo's own buttons — 1px
  // --line at 4–5px radius. A square-cornered white card a few pixels from a
  // rounded white button reads as two different systems, which is exactly what
  // the console theme is allowed to be and the paper theme is not.
  g.beginPath();
  g.roundRect(x - 3.5, y - 3.5, w + 7, h + 7, t.radius);
  g.fill();
  g.strokeStyle = t.rule;
  g.lineWidth = 1;
  g.stroke();
}

function label(g, text, x, y, t, { size = 9, colour = null, align = "left", bold = false } = {}) {
  // The console is monospace because it is pretending to be an instrument; on
  // paper the readout is part of the interface and takes the interface's face.
  g.font = `${bold ? "700 " : ""}${size}px ${t.face || MONO}`;
  g.fillStyle = colour || t.dim;
  g.textAlign = /** @type {CanvasTextAlign} */ (align);
  g.textBaseline = "alphabetic";
  g.fillText(text, x, y);
  g.textAlign = "left";
}

/** A panel frame with a title and an optional right-hand value. */
function panel(g, x, y, w, h, title, value, t) {
  scrim(g, x, y, w, h, t);
  bracket(g, x, y, w, h, t);
  label(g, title, x + 6, y + 12, t, { size: 8.5, colour: t.dim });
  if (value != null) label(g, String(value), x + w - 6, y + 12, t,
    { size: 9.5, colour: t.ink, align: "right" });
}

/** Sparkline-style filled histogram inside a panel body. */
function drawBars(g, x, y, w, h, bins, t, { peakColour = null } = {}) {
  let max = 0;
  for (const v of bins) if (v > max) max = v;
  if (!(max > 0)) return;
  const bw = w / bins.length;
  g.fillStyle = t.fill;
  g.beginPath();
  g.moveTo(x, y + h);
  for (let i = 0; i < bins.length; i++) {
    const bh = (bins[i] / max) * h;
    g.lineTo(x + i * bw, y + h - bh);
    g.lineTo(x + (i + 1) * bw, y + h - bh);
  }
  g.lineTo(x + w, y + h);
  g.closePath();
  g.fill();
  g.strokeStyle = peakColour || t.rule;
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i < bins.length; i++) {
    const bh = (bins[i] / max) * h;
    if (i === 0) g.moveTo(x, y + h - bh);
    g.lineTo(x + i * bw, y + h - bh);
    g.lineTo(x + (i + 1) * bw, y + h - bh);
  }
  g.stroke();
}

/** A signed gauge about a hard zero. The ± reference the ledger needs. */
function drawBalance(g, x, y, w, h, cut, fill, t) {
  const mid = x + w / 2;
  const span = Math.max(cut, fill, 1e-6);
  const cw = (cut / span) * (w / 2), fw = (fill / span) * (w / 2);
  g.fillStyle = t.fill;
  g.fillRect(mid - cw, y + 4, cw, h - 8);
  g.fillStyle = t.hot;
  g.globalAlpha = 0.55;
  g.fillRect(mid, y + 4, fw, h - 8);
  g.globalAlpha = 1;
  g.strokeStyle = t.ink; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(mid, y); g.lineTo(mid, y + h); g.stroke();
  label(g, "CUT", x + 2, y + h + 9, t, { size: 7.5 });
  label(g, "FILL", x + w - 2, y + h + 9, t, { size: 7.5, align: "right" });
}

/** Circular histogram. Radial ticks every 90°, so north is findable. */
function drawRose(g, cx, cy, r, sectors, t) {
  g.strokeStyle = t.faint ?? t.grid; g.lineWidth = 1;
  for (const f of [0.33, 0.66, 1]) {
    g.beginPath(); g.arc(cx, cy, r * f, 0, Math.PI * 2); g.stroke();
  }
  g.beginPath();
  for (let k = 0; k < 4; k++) {
    const a = (Math.PI / 2) * k - Math.PI / 2;
    g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  g.stroke();
  let max = 0;
  for (const v of sectors) if (v > max) max = v;
  if (max > 0) {
    const n = sectors.length, step = (Math.PI * 2) / n;
    g.fillStyle = t.fill; g.strokeStyle = t.ink; g.lineWidth = 1;
    for (let i = 0; i < n; i++) {
      const a0 = i * step - Math.PI / 2, a1 = a0 + step * 0.86;
      const rr = (sectors[i] / max) * r;
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, rr, a0, a1);
      g.closePath();
      g.fill(); g.stroke();
    }
  }
  label(g, "N", cx, cy - r - 3, t, { size: 7.5, align: "center" });
}

/**
 * A row of segmented ticks, some lit.
 *
 * ⚠️ TEXTURE, AND HONEST ABOUT IT. The reference consoles carry a great deal of
 * this — small segmented rows that read as instrumentation without stating a
 * quantity. Here every row is driven by a REAL fraction, so a row that is half
 * lit is half of something. The alternative, filling the frame with animated
 * segments that mean nothing, is the one thing a measuring instrument must not
 * do: it would make the true readings and the decoration indistinguishable.
 */
function segRow(g, x, y, w, frac, t, { seg = 14, h = 4, colour = null } = {}) {
  const gap = 2, sw = (w - gap * (seg - 1)) / seg;
  const lit = Math.round(Math.min(1, Math.max(0, frac)) * seg);
  // Filleted like every card and button — half the height, so a 3 px segment
  // reads as a soft pill rather than growing a visible radius of its own.
  const r = h / 2;
  for (let i = 0; i < seg; i++) {
    g.fillStyle = i < lit ? (colour || t.bar || t.ink) : (t.faint ?? t.grid);
    g.beginPath();
    g.roundRect(x + i * (sw + gap), y, sw, h, r);
    g.fill();
  }
}

/**
 * Hit regions of the last drawHUD pass, in the same CSS-pixel space it drew
 * in, most-recently-drawn last. The canvas itself is pointer-inert on purpose
 * — a readout must never swallow a brush stroke — so app.js hit-tests the
 * viewport's own pointer against these to raise the glossary popover.
 * @type {{x:number,y:number,w:number,h:number,key:string}[]}
 */
export const HUD_REGIONS = [];

/** Ranked named classes as horizontal bars. */
function drawClasses(g, x, y, w, h, items, t, { flagColour = null } = {}) {
  if (!items || !items.length) return;
  const rows = Math.min(items.length, Math.floor(h / 11));
  const total = items.reduce((a, b) => a + b.n, 0) || 1;
  for (let i = 0; i < rows; i++) {
    const it = items[i];
    const yy = y + i * 11;
    const frac = it.n / total;
    g.fillStyle = it.flag ? (flagColour || t.warn) : t.fill;
    g.fillRect(x + 92, yy + 2, Math.max(1, frac * (w - 128)), 6);
    label(g, it.label.slice(0, 16), x, yy + 8, t, { size: 8, bold: !!it.flag,
      colour: it.flag ? (flagColour || t.warn) : null });
    label(g, `${(frac * 100).toFixed(1)}%`, x + w, yy + 8, t,
      { size: 8, align: "right", bold: !!it.flag,
        colour: it.flag ? (flagColour || t.warn) : t.ink });
  }
}

/** A section profile, both surfaces, in a panel body. */
function drawProfile(g, x, y, w, h, profile, t) {
  if (!profile) return;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < profile.s.length; i++) {
    for (const v of [profile.now[i], profile.was[i]]) {
      if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  if (!Number.isFinite(lo) || !(hi > lo)) return;
  const X = (s) => x + (s / (profile.length || 1)) * w;
  const Y = (z) => y + h - ((z - lo) / (hi - lo)) * h;
  const stroke = (arr, dash, colour, width) => {
    g.setLineDash(dash); g.strokeStyle = colour; g.lineWidth = width;
    g.beginPath();
    let pen = false;
    for (let i = 0; i < profile.s.length; i++) {
      const v = arr[i];
      if (!Number.isFinite(v)) { pen = false; continue; }
      if (pen) g.lineTo(X(profile.s[i]), Y(v)); else g.moveTo(X(profile.s[i]), Y(v));
      pen = true;
    }
    g.stroke();
    g.setLineDash([]);
  };
  stroke(profile.was, [2, 2], t.dim, 1);
  stroke(profile.now, [], t.ink, 1.4);
}

/**
 * Draw the whole overlay.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {{w: number, h: number, theme: any, m: any, left?: number|null,
 *          right?: number|null, cards?: boolean}} o
 *   `left`: pixels the docked menu occupies from the left edge — the title
 *   card, the index rail and the bottom strip start clear of it.
 *   ⚠️ `right`: the same for the READOUT WINDOW on the right (2026-08-13). Once
 *   the readings moved into HTML windows, the band and the strip were running
 *   underneath one of them — Marc: "the panels look very randomly placed and
 *   not aligned to the other items such as the right menu". Both ends of both
 *   horizontals are now held off something real, which is the rule the index
 *   rail already followed for the gizmo.
 *   ⚠️ `cards`: draw the right-hand card column. **Default FALSE.** Landform,
 *   habitat and terrain form live in the readout window's Response panel now,
 *   and drawing them here as well is the two-copies-of-one-number trap Phase
 *   8C already paid for — worse here, because the two copies would physically
 *   overlap. Kept behind a flag rather than deleted so the old full-screen
 *   instrument frame can still be produced for a recording.
 */
export function drawHUD(g, o) {
  const t = o.theme, m = o.m || {};
  const W = o.w, H = o.h;
  HUD_REGIONS.length = 0;
  const reg = (x, y, w, h, key) => { HUD_REGIONS.push({ x, y, w, h, key }); };
  g.clearRect(0, 0, W, H);
  g.save();

  // A faint field grid, so the panels sit on something and the viewport reads as
  // an instrument rather than as a picture with numbers on it. The paper theme
  // sets grid fully transparent — see THEMES.
  g.strokeStyle = t.grid; g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x < W; x += 48) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); }
  for (let y = 0; y < H; y += 48) { g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); }
  g.stroke();

  // ⚠️ 12, NOT 14 (2026-08-13). Every floating window in the interface sits at
  // 12 px from its edge; the overlay sat at 14, so its band and strip missed
  // the menu's and the readout's edges by two pixels — near enough to look
  // like a mistake rather than a margin, which is half of what "not aligned"
  // was describing.
  const PW = 232, PH = 96, PAD = 12;
  const R = W - PAD - PW;
  // Where the top band and the bottom strip may begin and end: clear of the
  // floating menu on the left and the readout window on the right when either
  // is docked, the ordinary margin otherwise.
  const L0 = o.left ?? PAD;
  const R0 = o.right ?? (W - PAD);

  /**
   * ⚠️ THE TOP-RIGHT CORNER BELONGS TO THE AXIS GIZMO AND THE FPS READOUT, and
   * this canvas has no way to know that — they are HTML siblings, positioned by
   * CSS at right:12 top:12 and right:12 top:34, about 124 x 76 px of buttons.
   * The index rail used to run the full width and finish underneath them: two
   * sets of white cards, overlapping, one of them clickable and one not.
   *
   * Reserved here as a number rather than avoided by eye, and the title block
   * on the left is what sets the rail's other end — so both ends of the rail
   * are held off something real instead of being centred and hoping.
   */
  // 140 deep since the Exit button joined the gizmo stack — instrument mode
  // hides the sidebar, so the way out has to live on the viewport itself.
  const GIZMO_W = 140, GIZMO_H = 140;

  // ── the console frame ────────────────────────────────────────────────────
  // A bezel rather than panels floating on nothing: it is what makes the
  // viewport read as a screen INSIDE an instrument, which is the whole
  // character of the reference. Two hairlines and cut corners; no chrome.
  //
  // ⚠️ THE PAPER THEME HAS NO BEZEL. A frame drawn round the viewport says
  // "this is a screen inside a machine", which is the console's whole character
  // and the opposite of what a readout belonging to the interface should say.
  if (!t.radius) {
    g.strokeStyle = t.rule; g.lineWidth = 1;
    g.strokeRect(6.5, 6.5, W - 13, H - 13);
    g.strokeStyle = t.grid;
    g.strokeRect(10.5, 10.5, W - 21, H - 21);
  }

  // ── title block, top left ────────────────────────────────────────────────
  // The reference opens with what the thing IS before any measurement of it.
  // Here that is the provenance the tool already refuses to leave off an export.
  //
  // ⚠️ THE TITLE CARD SITS ON THE BAND'S OWN GRID: card width PW, the rail's
  // exact height, starting at L0 — clear of the docked menu like the rest of
  // the top band.
  // ⚠️ THE TITLE CARD IS THE SCENE CARD NOW (2026-08-11). The menu used to
  // repeat the grid, extent, z-range and origin in a card of its own; those
  // facts moved here — one statement about one subject, said once — which
  // bought the menu the space and cost this card 18 px. The rail matches its
  // height so the top band keeps one bottom edge. The credit line arrives
  // from hudMetrics already conditional: Kartverket is credited exactly when
  // Kartverket data is on screen.
  // ⚠️ 48 PX, DOWN FROM 60 (2026-08-11). The band keeps every claim it is
  // obliged to make — what this is, which ground, its grid, its extent, whose
  // data — by tightening the leading and dropping the "TERRAIN ANALYSIS ·
  // LIVE" strapline, which named the mode at a moment when there is only one.
  const TITLE_H = 48;
  {
    const tx = L0 + 6;
    scrim(g, L0, PAD, PW, TITLE_H, t);
    label(g, m.site || "ØRNDALEN", tx, PAD + 14, t, { size: 11.5, colour: t.ink });
    label(g, m.grid || "", tx, PAD + 25, t, { size: 6.5, colour: t.dim });
    label(g, m.zline || "", tx, PAD + 34, t, { size: 6.5, colour: t.dim });
    label(g, m.crs || "EPSG:25833 · NN2000", tx, PAD + 43, t, { size: 6.5, colour: t.dim });
  }

  // ── index rail, across the top ───────────────────────────────────────────
  // The abiotic indices at a constant rhythm — six since the biotic pair
  // moved to the habitat card. Each fraction is a real quantity against a
  // stated bound, so a full bar means the bound was reached.
  {
    // From the title card's right edge to the gizmo reserve, at the standard
    // gutter — both ends held off something real, and the same height as the
    // title so the top band has one bottom edge.
    // ⚠️ ENDS AT WHICHEVER COMES FIRST — the readout window's left edge or the
    // gizmo reserve. Before the readout existed the gizmo was the only thing up
    // there; now the window is usually the nearer obstruction, and the rail ran
    // under it.
    const ix = L0 + PW + PAD;
    const iw = Math.min(R0, W - GIZMO_W - PAD) - ix - PAD;
    if (iw > 240) {
      const idx = (m.indices || []).slice(0, 8);
      const cols = Math.max(1, idx.length), cw = (iw - 12) / cols;
      scrim(g, ix, PAD, iw, TITLE_H, t);
      idx.forEach((d, i) => {
        const cx = ix + 6 + i * cw, bw = cw - 14;
        // Centred in the band the title card sets.
        label(g, d.code, cx, PAD + 22, t, { size: 7.5, colour: t.dim });
        label(g, d.value, cx + bw, PAD + 22, t,
          { size: 8.5, align: "right", colour: d.flag ? t.warn : t.ink });
        segRow(g, cx, PAD + 29, bw, d.frac, t,
          { seg: 10, h: 3, colour: d.flag ? t.warn : null });
        reg(cx - 3, PAD + 4, cw - 8, TITLE_H - 8, `idx-${d.code}`);
      });
    }
  }

  // ⚠️ ONE DATUM FOR BOTH COLUMNS, and it is what stops the overlay looking
  // scattered. They used to start at the same y as each other but that y was
  // chosen to clear the TITLE BLOCK only — so the right column began at 88 and
  // ran straight under the axis gizmo, which reaches 110. Fixing that column
  // alone would have left the two starting at different heights, which is the
  // other half of the complaint. Both now hang from whichever obstruction is
  // deeper, so the columns share a top edge and neither collides.
  const COL_TOP = PAD + Math.max(TITLE_H + PAD, GIZMO_H);

  // ── the readout column, right (2026-08-11: ONE column) ───────────────────
  // The terrain-form panels used to stand in a left column of their own,
  // which fought the floating menu for the same edge. They are now ONE
  // grouped card in this column, below the earthwork balance — every reading
  // on the right, the whole left to the menu and the model. Cards that would
  // cross the bottom strip are skipped whole: a clipped histogram is not a
  // reading.
  const rLimit = H - PAD - 44 - PAD;   // the bottom strip's top, less a gutter
  // ⚠️ LANDFORM AND HYDROLOGY IN ONE CARD (2026-08-11). Four Measured values —
  // landform diversity, basin count, largest catchment, TWI defined — lived
  // ONLY in the menu's list, which is what forced that list to exist as a
  // second copy of the readout. Folded in here, the readout carries all
  // thirteen and the menu's copy can go. They belong together: a landform
  // vocabulary and a drainage structure are the same collapse seen twice.
  let y = COL_TOP;
  const LH = PH + 24;
  // ⚠️ OFF UNLESS ASKED FOR — see the `cards` note on drawHUD. These three
  // cards are the readout window's Response panel now, and drawing them here
  // as well put two copies of one number on top of each other.
  if (o.cards) {
  panel(g, R, y, PW, LH, "LANDFORM · HYDROLOGY",
    m.landformCount != null ? `${m.landformCount}/10` : null, t);
  drawClasses(g, R + 8, y + 24, PW - 16, PH - 44, m.landformItems, t);
  {
    const fy = y + LH - 20;
    const num = (v, dp = 0, unit = "") => (v == null || !Number.isFinite(v)
      ? "—" : `${v.toFixed(dp)}${unit}`);
    const area = (v) => (v == null ? "—"
      : v < 10000 ? `${v.toFixed(0)} m²` : `${(v / 10000).toFixed(2)} ha`);
    label(g, `DIVERSITY ${num(m.landformDiversity, 3)}`, R + 8, fy, t, { size: 7 });
    label(g, `BASINS ${m.basinCount ?? "—"}`, R + PW - 8, fy, t,
      { size: 7, align: "right" });
    label(g, `LARGEST ${area(m.basinLargest)}`, R + 8, fy + 11, t, { size: 7 });
    label(g, `TWI ${num(m.twiValid == null ? null : m.twiValid * 100, 0, "%")}`,
      R + PW - 8, fy + 11, t, { size: 7, align: "right" });
  }
  reg(R, y, PW, LH, "landformcard");

  y += LH + PAD;
  // ⚠️ THE ONE BIOTIC WINDOW (2026-08-11). Shannon, richness and the invasive
  // share moved HERE from the bottom strip and the index rail, at Marc's
  // decision: the readout's frame is abiotic terrain and its changes, and
  // everything the response model claims — an assumption, not a measurement —
  // lives in this single card, legible as one kind of statement. (A
  // disturbance-grade input, up to six levels, is planned as a future axis of
  // the same card.)
  const HB = PH + 18;
  panel(g, R, y, PW, HB, "HABITAT ASSEMBLAGE",
    m.shannon != null
      ? `H′ ${m.shannon.toFixed(3)} / ${(m.shannonMax ?? 1.95).toFixed(2)}` : null, t);
  drawClasses(g, R + 8, y + 24, PW - 16, PH - 32, m.speciesItems, t, { flagColour: t.warn });
  if (m.richness != null) {
    const inv = 100 * (m.invasiveFraction ?? 0);
    label(g, `HABITATS ${m.richness}/${m.speciesTotal ?? 7}`, R + 8, y + HB - 7, t,
      { size: 7.5 });
    label(g, `INVASIVE ${inv.toFixed(1)}%`, R + PW - 8, y + HB - 7, t,
      { size: 7.5, align: "right", bold: inv > 40,
        colour: inv > 40 ? t.warn : t.ink });
  }
  reg(R, y, PW, HB, "habitatcard");

  // ⚠️ THE EARTHWORK BALANCE CARD IS GONE (2026-08-11), and nothing was lost:
  // the bottom strip already carries CUT · FILL and NET EARTH as its last two
  // cells, so the card was a second rendering of two numbers that were
  // already on screen. The signed gauge went with it — a bar about a hard
  // zero is a nice drawing, but not worth 76 px of the model's frame when the
  // figures it decorates are three inches below.

  // Terrain form, grouped: both mini-histograms and the rose in one card —
  // three windows became one at Marc's call, to keep the column inside the
  // frame and the viewport clear for the model.
  y += HB + PAD;
  const TF = 118;
  if (y + TF <= rLimit) {
    panel(g, R, y, PW, TF, "TERRAIN FORM",
      m.hyps ? `${(m.hyps.hi - m.hyps.lo).toFixed(2)} m relief` : null, t);
    const hw = Math.floor(PW * 0.52), hx = R + 8;
    if (m.hyps) {
      drawBars(g, hx, y + 26, hw - 8, 26, m.hyps.bins, t);
      label(g, "HYPSOMETRY", hx, y + 62, t, { size: 6.5 });
    }
    if (m.slopeHist) {
      drawBars(g, hx, y + 74, hw - 8, 26, m.slopeHist.bins, t);
      label(g, `SLOPE · MEAN ${(m.slopeMean ?? 0).toFixed(1)}°`, hx, y + TF - 8, t,
        { size: 6.5 });
    }
    if (m.rose) {
      drawRose(g, R + hw + (PW - hw) / 2 - 4, y + 24 + (TF - 44) / 2,
        (TF - 62) / 2, m.rose.sectors, t);
    }
    reg(R, y, PW, TF, "terrainform");
    y += TF + PAD;
  }

  if (m.water && y + 62 <= rLimit) {
    panel(g, R, y, PW, 62, "RAINFALL EVENT", `${(m.water.rain * 1000).toFixed(1)} mm`, t);
    reg(R, y, PW, 62, "watercard");
    const bw = PW - 20, bx = R + 10, by = y + 26;
    const kept = m.water.delivered > 0 ? m.water.retained / m.water.delivered : 0;
    const soak = m.water.delivered > 0 ? m.water.infiltrated / m.water.delivered : 0;
    g.fillStyle = t.fill; g.fillRect(bx, by, bw, 12);
    g.fillStyle = t.hot; g.globalAlpha = 0.7;
    g.fillRect(bx, by, bw * kept, 12);
    g.globalAlpha = 0.35;
    g.fillRect(bx + bw * kept, by, bw * soak, 12);
    g.globalAlpha = 1;
    g.strokeStyle = t.rule; g.strokeRect(bx + 0.5, by + 0.5, bw - 1, 11);
    label(g, `HELD ${(kept * 100).toFixed(0)}%`, bx, by + 24, t, { size: 7.5 });
    label(g, `SHED ${((1 - kept - soak) * 100).toFixed(0)}%`, bx + bw, by + 24, t,
      { size: 7.5, align: "right" });
  }
  }   // ← end of the `cards` column

  // ── bottom strip: the headline figures, as a readout ─────────────────────
  // ⚠️ THE LOWER-RIGHT CORNER BELONGS TO THE BRANDMARK — an HTML sibling at
  // right:16 bottom:12, like the gizmo in the top-right — so the strip runs
  // from the left margin and STOPS SHORT of it. Reserved as a number for the
  // same reason GIZMO_W is: the canvas cannot see its neighbours, and a strip
  // that ran the full width put "Digital Landscapes" on top of the last
  // readout cell. (The mark lost its (c) glyph on 2026-08-16, mirroring
  // DL-TerrainSlicer build 24 - so 200 is now slightly generous, which is the
  // safe direction to be wrong in.)
  const BRAND_W = 200;
  // 44 px, down from 54: the figures set the height, and they are 15 px tall
  // over a 7.5 px label — the rest was air.
  const stripH = 44, sy = H - PAD - stripH;
  // ⚠️ THE STRIP ENDS WHERE THE READOUT WINDOW BEGINS, not at the brandmark
  // alone. With the window docked right the strip ran underneath it — the
  // brandmark reserve only ever protected the corner.
  const sw = Math.min(R0, W - PAD - BRAND_W) - L0;
  scrim(g, L0, sy, sw, stripH, t);
  bracket(g, L0, sy, sw, stripH, t);
  const cells = m.readout || [];
  const cw = sw / Math.max(1, cells.length);
  cells.forEach((c, i) => {
    const cx = L0 + i * cw;
    if (i > 0) {
      g.strokeStyle = t.faint ?? t.grid; g.beginPath();
      g.moveTo(cx, sy + 8); g.lineTo(cx, sy + stripH - 8); g.stroke();
    }
    label(g, c.k, cx + 10, sy + 15, t, { size: 7 });
    label(g, c.v, cx + 10, sy + 34, t, { size: 14, colour: c.flag ? t.warn : t.ink });
    if (c.info) reg(cx, sy, cw, stripH, c.info);
  });

  // ── section profiles, if any have been cut ───────────────────────────────
  // Up to three side by side in the band between the columns — one panel read
  // as the other sections not existing. Fewer are drawn when the band cannot
  // hold a legible profile, never a smaller one: an unreadable section is
  // worse than an absent one on an instrument.
  if (m.profiles && m.profiles.length) {
    const avail = W - PW * 2 - PAD * 4;
    let n = Math.min(3, m.profiles.length);
    let pw = Math.min(420, (avail - (n - 1) * PAD) / n);
    while (n > 1 && pw < 170) { n--; pw = Math.min(420, (avail - (n - 1) * PAD) / n); }
    if (pw > 160) {
      const total = pw * n + PAD * (n - 1);
      // Centred in the frame, but never under the docked menu.
      const px0 = Math.max(L0, (W - total) / 2), py = sy - PAD - 92;
      for (let i = 0; i < n; i++) {
        const p = m.profiles[i], px = px0 + i * (pw + PAD);
        panel(g, px, py, pw, 92, `SECTION ${p.name}–${p.name}`,
          `${p.profile.length.toFixed(1)} m`, t);
        drawProfile(g, px + 10, py + 24, pw - 20, 58, p.profile, t);
        label(g, "EXISTING ──  PROPOSED ━━", px + 10, py + 90, t, { size: 7 });
        reg(px, py, pw, 92, "sectionscard");
      }
    }
  }

  g.restore();
}
