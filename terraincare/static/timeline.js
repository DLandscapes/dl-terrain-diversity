// @ts-check
// The authored 45.000-second performance.
//
// ⚠️ EVERYTHING HERE IS A PURE FUNCTION OF TIME. stateAt(t) must return the same
// state for the same t no matter what was rendered before it. That is not a
// stylistic preference: capture.js seeks straight to the last frame and then to
// frame 0 to measure the loop seam, and the kernel suite seeks at random. A
// timeline built by accumulating edits — level a bit more each frame — would
// give a different surface depending on the route taken to t, and the seam
// measurement would be meaningless.
//
// So the terrain is never "edited" here. Two endpoint surfaces exist (the
// surveyed ground, and the ground levelled to a stated tolerance) and the state
// is a mix between them. Any t, any order, same picture.
//
// THE SCRIPT, AND WHY IT CHANGED.
// The original storyboard's central beat was "level it and seven species
// collapse to one — and that one is the invasive". That claim does not survive:
// it is an artefact of levelling to a mathematical plane, which no built surface
// ever is, and ±10 mm of realistic microrelief breaks it (see
// output/FINDING-species-model-limits.md).
//
// What the tolerance sweep found instead is better television and better
// science. Levelling to any ACHIEVABLE construction tolerance costs roughly
// three-quarters of the modelled diversity — and then building the surface ten
// times more accurately changes nothing at all. The film's reversal is that
// second part: the audience expects precision to help, and it does not. Only
// relief an order of magnitude beyond tolerance brings the classes back, and
// that is shaping, not grading.
//
// Every figure quoted in `metrics` below was measured against the live
// instrument on 2026-08-04 at a 4 m field wavelength. They are here so the
// overlay can state real numbers, and so a check can assert that the film still
// agrees with the tool.

/** The exhibition loop, in seconds. Frame count at 30 fps is 1350. */
export const DURATION = 45.0;

/** Smoothstep. Beats ease rather than cut — this is one continuous take. */
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** Linear interpolation. */
const lerp = (a, b, u) => a + (b - a) * u;

/**
 * @typedef {Object} Beat
 * @property {string} id
 * @property {number} from   seconds, inclusive
 * @property {number} to     seconds, exclusive
 * @property {string} title  the on-screen line, or "" for none
 * @property {string} note   what the beat is for; not shown
 * @property {number} mix0   terrain mix at `from` — 0 surveyed, 1 levelled
 * @property {number} mix1   terrain mix at `to`
 * @property {number} tol0   tolerance amplitude at `from`, mm
 * @property {number} tol1   tolerance amplitude at `to`, mm
 * @property {Record<string, string|number>} [metrics] measured, for the overlay
 */

/**
 * ⚠️ THE BEATS MUST TILE [0, DURATION) WITH NO GAP AND NO OVERLAP, and the last
 * one must land back on the first one's state or the loop will jump. Both are
 * asserted in the kernel suite rather than trusted.
 * ⚠️ `zoom0`/`zoom1` DOLLY THE CAMERA, AND THEY EXIST BECAUSE THE MIDDLE OF
 * THE FILM LOOKED STATIC (Marc, 2026-08-20). The tolerance beats change the
 * ground by TWENTYFOLD — relief 0.020 m at ±10 mm to 0.396 m at ±200 mm — but
 * on a 64 m patch at true scale that is centimetres, and the terrain read as
 * frozen while only the shader cut. So the camera comes DOWN into the surface
 * as the relief gets finer and pulls back out as it returns.
 *
 * ⚠️ IT IS A DOLLY, NOT A VERTICAL EXAGGERATION. Stretching z would make the
 * microrelief legible too, and it would be a stated distortion the film has
 * nowhere to declare — the rule the exaggeration slider was removed under.
 * Moving closer shows the same ground at the same 1:1 and invents nothing.
 *
 * ⚠️ THE FIRST AND LAST VALUES MUST MATCH or the loop jumps: `claim` ends at
 * 1.00 because `ground` starts there. A kernel row pins it.
 *
 * @type {Beat[]}
 */
export const SCRIPT = [
  {
    id: "ground", from: 0, to: 6, mix0: 0, mix1: 0, tol0: 25, tol1: 25,
    zoom0: 1.00, zoom1: 1.00,
    layer: "hillshade", glyphs: true,
    title: "Ørndalen, Tromsøya — 64 m at 0.25 m",
    note: "Establish the surveyed ground. Nothing moves but the camera.",
    metrics: { "Shannon H′": "1.721", "species": "7 of 7", "geodiversity": "0.376" },
  },
  {
    id: "level", from: 6, to: 13, mix0: 0, mix1: 1, tol0: 25, tol1: 25,
    zoom0: 1.00, zoom1: 0.62,
    layer: "hillshade", glyphs: true,
    title: "Levelled to ±25 mm — a normal construction tolerance",
    note: "The gesture. Not a plane: no built surface is one.",
    metrics: { "Shannon H′": "0.450", "species": "2 of 7", "geodiversity": "0.000" },
  },
  {
    id: "hold", from: 13, to: 18, mix0: 1, mix1: 1, tol0: 25, tol1: 25,
    zoom0: 0.62, zoom1: 0.42,
    layer: "cutfill", glyphs: false,
    title: "The earthwork balanced. The ecology did not.",
    note: "836.1 m³ cut, 836.1 m³ fill. Shader change: what was moved.",
    metrics: { "cut": "836.1 m³", "fill": "836.1 m³", "net": "0.000 m³" },
  },
  {
    id: "tighter", from: 18, to: 26, mix0: 1, mix1: 1, tol0: 25, tol1: 10,
    zoom0: 0.42, zoom1: 0.30,
    layer: "twi", glyphs: false,
    title: "Build it two and a half times more accurately — ±10 mm",
    note: "THE REVERSAL. The audience expects improvement. There is none.",
    metrics: { "Shannon H′": "0.461", "species": "2 of 7", "geodiversity": "0.000" },
  },
  {
    id: "rougher", from: 26, to: 34, mix0: 1, mix1: 1, tol0: 10, tol1: 100,
    zoom0: 0.30, zoom1: 0.30,
    layer: "twi", glyphs: false,
    title: "Ten times rougher — ±100 mm. Still nothing.",
    note: "The plateau. A tenfold change in grading accuracy buys nothing.",
    metrics: { "Shannon H′": "0.444", "species": "3 of 7", "geodiversity": "0.027" },
  },
  {
    id: "threshold", from: 34, to: 41, mix0: 1, mix1: 1, tol0: 100, tol1: 200,
    zoom0: 0.30, zoom1: 0.55,
    layer: "hillshade", glyphs: true,
    title: "±200 mm — an order of magnitude beyond tolerance",
    note: "Classes return, H′ reaches only 0.765. This is shaping, not grading.",
    metrics: { "Shannon H′": "0.765", "species": "7 of 7", "geodiversity": "0.040" },
  },
  {
    id: "claim", from: 41, to: 45, mix0: 1, mix1: 0, tol0: 200, tol1: 25,
    zoom0: 0.55, zoom1: 1.00,
    layer: "hillshade", glyphs: true,
    title: "Differentiation cannot be bought with precision. It has to be designed.",
    note: "Return to the surveyed ground so the loop closes on frame 0.",
    metrics: { "Shannon H′": "1.721", "species": "7 of 7", "geodiversity": "0.376" },
  },
];

/**
 * The band-limited tolerance field, ±1.
 *
 * ⚠️ THE MODULE DOCUMENTED THIS AS "generated once, outside this function" AND
 * NOTHING GENERATED IT (2026-08-20). The film was dropped before a caller
 * existed, so the one input every figure in SCRIPT depends on was never
 * written down. It is here now, because a script whose numbers cannot be
 * reproduced is a storyboard, not a measurement.
 *
 * ⚠️⚠️ WAVELENGTH IS THE PARAMETER THAT MATTERS, NOT AMPLITUDE, AND IT MUST BE
 * QUOTED WITH EVERY FIGURE. Re-measuring the sweep at 2 m instead of the
 * published 4 m moved H′ at 25 mm from 0.450 to 0.310 and destroyed the
 * plateau entirely — the numbers in SCRIPT are 4 m numbers and are meaningless
 * without that. FINDING-species-model-limits.md measured 0.266 / 0.460 / 0.560
 * at 1.5 / 4 / 8 m on the same amplitude. A tolerance on its own is not
 * reproducible.
 *
 * ⚠️ NOT WHITE NOISE. A grader blade is metres wide, so the microrelief a
 * levelled surface actually carries has a wavelength of metres. Per-cell noise
 * would make every cell its own pit, restore a slope field everywhere and
 * model nothing anyone could build.
 *
 * @param {number} nrows @param {number} ncols @param {number} cell
 * @param {number} [wavelengthM] lattice spacing in METRES — 4 m is published
 * @param {number} [seed]
 * @returns {Float32Array} normalised to exactly ±1
 */
export function toleranceField(nrows, ncols, cell, wavelengthM = WAVELENGTH_M, seed = 1) {
  const rnd = (gx, gy) => {
    let h = (gx | 0) * 374761393 + (gy | 0) * 668265263 + seed * 2246822519;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296 * 2 - 1;
  };
  const S = Math.max(1e-6, wavelengthM / cell);
  const out = new Float32Array(nrows * ncols);
  let mx = 0;
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const x = c / S, y = r / S;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      // Smoothstep, not linear: a linear lattice interpolation creases at every
      // node, and geomorphons would classify the creases as landforms.
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const v = (rnd(x0, y0) * (1 - sx) + rnd(x0 + 1, y0) * sx) * (1 - sy)
              + (rnd(x0, y0 + 1) * (1 - sx) + rnd(x0 + 1, y0 + 1) * sx) * sy;
      out[r * ncols + c] = v;
      const a = v < 0 ? -v : v;
      if (a > mx) mx = a;
    }
  }
  if (mx > 0) for (let i = 0; i < out.length; i++) out[i] /= mx;
  return out;
}

/** The wavelength every figure in SCRIPT was measured at. Metres. */
export const WAVELENGTH_M = 4.0;

/** The beat covering time `t`, wrapped into the loop. */
export function beatAt(t) {
  const u = ((t % DURATION) + DURATION) % DURATION;
  for (const b of SCRIPT) if (u >= b.from && u < b.to) return b;
  return SCRIPT[SCRIPT.length - 1];
}

/**
 * @typedef {Object} TimelineState
 * @property {number} t            wrapped scene time
 * @property {Beat} beat
 * @property {number} beatProgress 0..1 through the beat, eased
 * @property {number} mix          0 surveyed … 1 levelled
 * @property {number} toleranceMM  amplitude of the levelled endpoint
 * @property {{yaw:number, pitch:number, distScale:number}} camera
 * @property {number} titleOpacity 0..1, faded in and out within the beat
 */

/**
 * The complete scene state at time `t`.
 *
 * ⚠️ THE CAMERA IS A FULL TURN OVER THE WHOLE LOOP, deliberately. It guarantees
 * closure — yaw(45) is yaw(0) plus exactly 2π — and it means the loop seam can
 * be measured without the camera being a special case. The pitch breathes on a
 * single sine over the same period, which returns to its start for the same
 * reason. Nothing here may use a term that does not complete a whole number of
 * cycles in DURATION.
 *
 * @param {number} t seconds
 * @returns {TimelineState}
 */
export function stateAt(t) {
  const u = ((t % DURATION) + DURATION) % DURATION;
  const b = beatAt(u);
  const span = b.to - b.from;
  const raw = span > 0 ? (u - b.from) / span : 0;
  const p = ease(raw);

  // Titles fade in over the first 12% of a beat and out over the last 18%, so a
  // caption is never cut off mid-word by a beat boundary.
  const fadeIn = Math.min(1, raw / 0.12);
  const fadeOut = Math.min(1, (1 - raw) / 0.18);
  const titleOpacity = b.title ? Math.max(0, Math.min(fadeIn, fadeOut)) : 0;

  const turn = (u / DURATION) * Math.PI * 2;
  return {
    t: u,
    beat: b,
    beatProgress: p,
    mix: lerp(b.mix0, b.mix1, p),
    toleranceMM: lerp(b.tol0, b.tol1, p),
    camera: {
      yaw: turn,
      pitch: 0.55 + 0.06 * Math.sin(turn),
      // The breathing term keeps the whole-loop sine (it must complete a
      // whole number of cycles); the beat's own dolly multiplies it.
      distScale: (1.15 - 0.05 * Math.sin(turn))
        * lerp(b.zoom0 ?? 1, b.zoom1 ?? 1, p),
    },
    titleOpacity,
  };
}

/**
 * Write the terrain for `state` into `z`, from the two endpoint surfaces.
 *
 * `field` is the band-limited tolerance field, normalised to ±1 — NOT white
 * noise. A grader blade is metres wide, so the microrelief it leaves has a
 * wavelength of metres; per-cell noise would make every cell its own pit and
 * would model nothing. The field is generated once, outside this function, and
 * only its amplitude changes over the film — so the surface morphs smoothly
 * instead of reshuffling every frame.
 *
 * @param {Float32Array} z        destination, modified in place
 * @param {Float32Array} surveyed pristine surface
 * @param {Float32Array} field    ±1 band-limited field, same length
 * @param {number} datum          the levelling datum, metres
 * @param {TimelineState} state
 */
export function applyTerrain(z, surveyed, field, datum, state) {
  const amp = state.toleranceMM / 1000;
  const m = state.mix;
  for (let i = 0; i < z.length; i++) {
    const s = surveyed[i];
    if (!Number.isFinite(s)) { z[i] = s; continue; }
    z[i] = s * (1 - m) + (datum + field[i] * amp) * m;
  }
}

/**
 * Every beat boundary, for the kernel suite and for cutting a contact sheet.
 * @returns {number[]}
 */
export const boundaries = () => SCRIPT.map((b) => b.from).concat([DURATION]);
