// @ts-check
// THE OFFLINE RENDER — the authored 45 s loop, one frame at a time.
//
// ⚠️ IT RENDERS ON DEMAND AND NEVER WAITS FOR requestAnimationFrame. rAF is
// paused whenever the pane is not displayed, which is the trap every phase of
// this project has recorded; a capture loop built on it stalls forever and
// looks exactly like a hung renderer.
//
// ⚠️ EVERY FRAME GOES THROUGH `view.renderAt()`, WHICH ALREADY EXISTS. The
// first version of this file sized the canvas itself and read the pixels back
// afterwards, and got two things wrong that renderAt was written to solve:
// `_resize()` runs on every rAF and undoes any external size (asking for
// 960x540 produced 1280x720, because the renderer's pixel ratio is pinned to 2
// for supersampling), and the WebGL drawing buffer is discarded once the tick
// ends, so a readback taken later returns pure black. renderAt sets the ratio
// to 1, sizes directly so width x height means what it says, copies the frame
// out through drawImage IN THE SAME TICK as the render, and restores the live
// view in a `finally`. Render group R6 covers it. Look for the machinery before
// building it again.
//
// ⚠️ THE ANALYSIS RUNS ON THE MAIN THREAD HERE, NOT IN THE WORKER. The worker
// exists to keep a HAND responsive; nothing is holding a brush during an
// offline render, and a per-frame round trip with latest-wins coalescing would
// drop most of the frames it was asked for. Horn + MFD + TWI over 65 536 cells
// is tens of milliseconds, so 1 125 frames is a minute of arithmetic in total.
//
// ⚠️ THE FIGURES ON SCREEN ARE THE MEASURED ONES FROM `SCRIPT`, not a live
// recomputation. They were measured through the running app and re-validated on
// this build (proof/tolerance-sweep-revalidated-2026-08-20.txt). A caption that
// recomputed its own number every frame would drift against the record the
// abstract quotes, and the difference would be invisible.

import * as THREE from "three";
import { DEM } from "./dem.js";
import { loadGeoTIFF } from "./geotiff.js";
import { Surface } from "./surface.js";
import { View } from "./view.js";
import { FixedStepClock } from "./clock.js";
import { GlyphField } from "./glyph-view.js";
import { buildGlyphs } from "./glyphs.js";
import { computeGradient } from "./analysis/horn.js";
import { horizonMap, skyViewFactor } from "./analysis/horizon.js";
import { flowAccumulation } from "./analysis/mfd.js";
import { twi as twiOf } from "./analysis/indices.js";
import { colourise, percentileDomain } from "./analysis/ramps.js";
import {
  SCRIPT, DURATION, stateAt, applyTerrain, toleranceField, WAVELENGTH_M,
} from "./timeline.js";

/** Seconds a shader change takes to arrive. Long enough to read as a
 *  transition, short enough not to blur the beat it belongs to. */
const FADE = 0.9;

const FPS = 25;

/** @param {string} rel */
async function fetchTile(rel) {
  const r = await fetch(`/data/${rel}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${rel}: ${r.status}`);
  return r.arrayBuffer();
}

/**
 * Colour a float grid through the app's OWN ramp, on a domain fixed for the
 * whole film.
 *
 * ⚠️⚠️ THE DOMAIN IS HELD, NOT RE-STRETCHED PER FRAME, AND THAT IS THE WHOLE
 * REASON BEATS 4 AND 5 WERE INDISTINGUISHABLE. The app percentile-stretches
 * every layer per dataset, which is right for reading ONE surface: TWI and TRI
 * are scale dependent and no fixed domain serves both scales. But a film whose
 * argument is a COMPARISON across states cannot renormalise between them. The
 * ±10 mm and ±100 mm surfaces differ tenfold in amplitude, and re-stretching
 * each frame mapped both onto the same colours — so a tenfold change in the
 * ground rendered as no change at all, and the beat that carries the finding
 * looked like a still frame.
 *
 * The domain is taken once, from the SURVEYED ground, and every later state is
 * shown against it. So the levelled states read as degraded against the real
 * ground rather than each being re-normalised to look full-range.
 * @param {Float32Array} grid @param {string} key @param {[number,number]} domain
 */
function panel(grid, key, domain) {
  return colourise(key, grid, domain);
}

export async function renderFilm(opts = {}) {
  const width = opts.width ?? 1920, height = opts.height ?? 1080;
  const fps = opts.fps ?? FPS;
  const full = Math.round(DURATION * fps);
  // ⚠️ SEEK, DON'T SPOOL. `stateAt(t)` is a pure function of time and the
  // terrain is rebuilt from the two endpoint surfaces every frame, so any
  // moment can be rendered directly — that is the property the module was
  // written for. Rendering 1,075 frames to reach one at t=43 s would also
  // measure nothing the seek does not.
  const seek = Array.isArray(opts.at) ? opts.at : null;
  // ⚠️ RESUMABLE. A single dropped POST used to abandon the whole pass — 995
  // good frames on disk and no way to continue but to render all of them
  // again. `from` restarts at a frame index; the names are derived from the
  // index, so a resumed run fills the gap exactly.
  const from = opts.from ?? 0;
  /** Exclusive end frame — lets a fix re-render only the frames it changed. */
  const to = opts.to ?? null;
  /** Subdirectory under output/video/frames — one per pass. */
  const dir = opts.dir ?? "";
  // A probe renders the first N frames without writing any, so the whole
  // path can be proved before committing to a full pass.
  const total = seek ? seek.length
    : (opts.frames ? Math.min(opts.frames, full) : full);
  const post = opts.post !== false;
  // ⚠️ FRAMING IS A RENDER DECISION, NOT A TIMELINE ONE. `view.frame()` fits the
  // whole patch with headroom for interactive orbiting; on a 16:9 film that
  // leaves the subject about a third of frame width. The timeline's distScale
  // must stay as it is — it breathes on a single sine so the loop closes — so
  // the tightening belongs here, applied once to the fitted distance.
  const fit = opts.fit ?? 0.58;
  const log = opts.log || (() => {});

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("stage"));
  const overlay = /** @type {HTMLElement} */ (document.getElementById("overlay"));

  const raw = loadGeoTIFF(await fetchTile("orndalen/orndalen_fill_025m.tif"),
    { name: "/data/orndalen/orndalen_fill_025m.tif" });
  const dem = DEM.fromRaw(raw);
  const n = dem.nrows * dem.ncols;

  const view = new View(canvas, overlay, new FixedStepClock({ fps }));

  // ⚠️ aoStrength ABOVE THE APP'S 0.5. The interactive default is tuned for a
  // lit screen with a hand on the model; on video the same surface reads as a
  // pale sheet. This is the existing knob, not a new one.
  const surface = new Surface(dem, {
    verticalExaggeration: 1, aoStrength: opts.ao ?? 0.85,
  });
  view.scene.add(surface.mesh);

  const glyphs = new GlyphField(dem, { verticalExaggeration: 1 });
  view.scene.add(glyphs.group);

  const surveyed = dem.z.slice();
  let s = 0, cnt = 0;
  for (const v of surveyed) if (Number.isFinite(v)) { s += v; cnt++; }
  const datum = s / cnt;
  const field = toleranceField(dem.nrows, dem.ncols, dem.cell, WAVELENGTH_M, 1);

  // Baseline for the cut/fill shader: the surveyed ground, fixed for the film.
  const baseline = surveyed.slice();
  const delta = new Float32Array(n);

  // The held domains — measured once, on the ground as surveyed.
  const g0 = computeGradient(dem);
  const flow0 = flowAccumulation(dem);
  const TWI_DOMAIN = percentileDomain(twiOf(flow0.specificCatchmentArea, g0.slope))
    || [0, 10];
  // Cut/fill is symmetric so that zero stays exactly neutral — the tool's own
  // rule for this ramp, and the reason the levelled plate reads as balanced.
  const CUTFILL_DOMAIN = [-1.2, 1.2];
  log(`held TWI domain ${TWI_DOMAIN[0].toFixed(2)}..${TWI_DOMAIN[1].toFixed(2)}`);

  // ⚠️ `surface.boundingBox()` — THE REPRESENTATION'S OWN, ALREADY IN WORLD
  // COORDINATES. Rolling this by hand from geometry.boundingBox and
  // mesh.matrixWorld aimed the camera at the scene origin instead: matrixWorld
  // is only refreshed during a render, so before the first frame it is still
  // identity, and the terrain sits 654 km away at its UTM position. The frame
  // came back showing nothing but the ground grid.
  const box = surface.boundingBox();
  view.frame(box);

  // ⚠️ THE OCCLUSION WAS NEVER FED TO THE SURFACE, WHICH IS WHY EVERY HILLSHADE
  // BEAT READ PALE. Without setAO the only shading is the steepness term, which
  // darkens by at most 18 %; sky-view is what gives micro-relief its
  // plasticity, and it is the whole reason hollows look like hollows. The app
  // gets it from the worker on settle; an offline render has to compute it.
  const svfOf = (d) => skyViewFactor(horizonMap(d, { directions: 16 }));

  // ⚠️⚠️ PRIME THE OCCLUSION AND PIN ITS FADE. `setAO` treats the FIRST
  // occlusion for a surface as an arrival and eases it in over time — right for
  // a hand on the model, where sky-view lands seconds after a tile is adopted
  // and a full-strength recolour reads as the shader jumping. In an offline
  // render it is a defect: the fade is driven by the animation clock, so frame 0
  // renders with NO occlusion and the film brightens over its first second —
  // and, worse, frame 0 then no longer matches frame 1124, so the loop seam
  // opens. Caught on a contact sheet, where beat 1 came out visibly paler than
  // every other beat. Primed once here and pinned to full, after which every
  // per-frame setAO takes the non-first path and stays at full strength.
  // ⚠️ CANCEL THE ANIMATION, DO NOT JUST DROP ITS HANDLE. Setting _aoAnim to
  // null loses the rAF id without cancelling it, so the fade kept stepping and
  // overwrote the pin on whichever frames it happened to land — measured as
  // frame 0 rendering 3.7 luminance darker than the SAME time rendered later
  // in the pass. Cancel first, then pin, then rebuild the colours once.
  surface.setAO(svfOf(dem));
  if (surface._aoAnim) cancelAnimationFrame(surface._aoAnim);
  surface._aoAnim = 0;
  surface._aoFade = 1;
  surface.updateAll();
  const centre = new THREE.Vector3();
  box.getCenter(centre);
  const home = { yaw: view._cam.yaw, pitch: view._cam.pitch,
    dist: view._cam.dist * fit };

  const frames = [];
  let lastShot = null;
  const shots = [];
  for (let i = from; i < (to === null ? total : Math.min(to, total)); i++) {
    const t = seek ? seek[i] : i / fps;
    const st = stateAt(t);
    const beat = st.beat;

    applyTerrain(dem.z, surveyed, field, datum, st);
    surface.setAO(svfOf(dem));
    surface.updateAll();

    // ── the shader for this beat, CROSS-FADED across every cut ────────────
    // ⚠️ THE LAYER USED TO SWITCH ON THE FRAME, AND IT READ AS A CUT (Marc,
    // 2026-08-20: "the video just flips the frame from one to the other").
    // Sitting on top of terrain that barely moves through the middle of the
    // film, an instant recolour is the only thing that happens, so the whole
    // beat change lands as an edit rather than as a consequence. The panels are
    // ordinary RGBA buffers, so the fix is to build BOTH across the boundary
    // and blend — the ground keeps moving underneath and the treatment arrives
    // with it.
    const g = computeGradient(dem);
    const layerOf = (which) => {
      if (which === "twi") {
        const flow = flowAccumulation(dem);
        return panel(twiOf(flow.specificCatchmentArea, g.slope), "twi", TWI_DOMAIN);
      }
      if (which === "cutfill") {
        for (let k = 0; k < n; k++) delta[k] = dem.z[k] - baseline[k];
        return panel(delta, "cutfill", CUTFILL_DOMAIN);
      }
      return null;                                 // plain hillshade + SVF
    };

    // How far into the fade this frame sits, and what it is coming FROM.
    // ⚠️⚠️ THE SURFACE IGNORES A LAYER'S ALPHA. Its layer branch is
    // `colors = (layer[q] / 255) * lit` — the fourth byte is never read. The
    // first cross-fade faded to alpha 0 and measured a 28/255 jump at the 13 s
    // cut, eight times normal frame-to-frame motion, because a zero-alpha
    // buffer still paints its RGB at full strength. Fading to or from the plain
    // hillshade therefore means fading toward the NEUTRAL GREY that branch
    // paints (`0.95 * shade`), not toward transparency.
    const prev = SCRIPT[(SCRIPT.indexOf(beat) - 1 + SCRIPT.length) % SCRIPT.length];
    const into = t - beat.from;
    const fading = into < FADE && prev.layer !== beat.layer;
    let layer = layerOf(beat.layer);
    if (fading) {
      const w = into / FADE;                       // 0 at the cut, 1 when done
      const size = (layer || layerOf(prev.layer)).length;
      // The stand-in for "no layer": flat 242, which through `lit` lands within
      // a few percent of the base branch's own grey across the shade range.
      const neutral = () => {
        const b = new Uint8ClampedArray(size);
        for (let k = 0; k < size; k += 4) {
          b[k] = 242; b[k + 1] = 242; b[k + 2] = 242; b[k + 3] = 255;
        }
        return b;
      };
      const from = layerOf(prev.layer) || neutral();
      const to = layer || neutral();
      const out = new Uint8ClampedArray(size);
      for (let k = 0; k < size; k++) out[k] = from[k] + (to[k] - from[k]) * w;
      layer = out;
    }
    surface.setLayer(layer);

    // ── the glyph field: the attribute terrain, where the beat asks for it ──
    // ⚠️ THIS IS WHAT MAKES THE TOLERANCE BEATS LEGIBLE. The terrain barely
    // changes between ±10 mm and ±100 mm — that is the finding — but a field
    // built from aspect DISAPPEARS on levelled ground, because aspect has no
    // answer where there is no slope. The invisible change becomes visible.
    if (beat.glyphs) {
      const built = buildGlyphs(dem, {
        aspect: { grid: g.aspectDeg, lo: 0, hi: 360 },
        slope: { grid: g.slopeDeg, lo: 0, hi: 90 },
        elevation: { grid: dem.z, lo: datum - 3, hi: datum + 3 },
      }, [
        { key: "aspect", op: "turn" },
        { key: "slope", op: "tilt" },
        { key: "elevation", op: "extend", invert: true },
      ], { stride: 6, lengthFraction: 1.1 });
      glyphs.setGlyphs(built.glyphs);
      glyphs.setVisible(true);
    } else {
      glyphs.setVisible(false);
    }

    // ── camera: one full turn over the loop, so frame N lands on frame 0 ──
    // ⚠️ setCameraState WITH ZERO EASING, not a nudge of the private _cam.
    // setAxisView and friends ease over 0.45 s; an offline render must land on
    // the exact pose for the frame it is writing, or the loop seam drifts.
    view.setCameraState({
      yaw: home.yaw + st.camera.yaw,
      pitch: st.camera.pitch,
      dist: home.dist * st.camera.distScale,
      target: centre.toArray(),
    }, 0);

    // One synchronous call: size, render, copy out, restore. Nothing may await
    // between the render and the read, and renderAt guarantees that internally.
    const shot = view.renderAt(width, height);

    if (post) {
      const name = seek ? `seek_${String(i).padStart(3, "0")}.png`
        : `frame_${String(i).padStart(5, "0")}.png`;
      const png = shot.toDataURL("image/png");
      // ⚠️ RETRY, DON'T ABANDON. The first full pass died on frame 995 with a
      // bare "Failed to fetch" while the server was demonstrably still up —
      // a transient socket failure, not a real one. Three attempts with a
      // short backoff; only a genuinely dead sink stops the render.
      let posted = false;
      for (let a = 0; a < 3 && !posted; a++) {
        try {
          const res = await fetch("/frame", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, png, dir }),
          });
          posted = res.ok;
        } catch { /* fall through to the backoff */ }
        if (!posted) await new Promise((r) => setTimeout(r, 150 * (a + 1)));
      }
      if (!posted) throw new Error(`frame ${i}: capture sink did not accept 3 attempts`);
      frames.push(name);
    }
    lastShot = shot;
    if (seek) shots.push(shot);
    if (i % 25 === 0) log(`${i}/${total}  t=${t.toFixed(1)}s  ${beat.id}  ${beat.layer}`);
    // Yield so the tab stays answerable and the POST actually flushes.
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  log(`done — ${total} of ${full} frames at ${width}x${height}, ${fps} fps`);
  // The last frame is handed back so a caller can prove the pixels are real
  // without a screenshot — the pane may not be compositing at all.
  return { rendered: total, ofFull: full, width, height, fps,
    written: frames.length, lastShot, shots };
}

window.dlvideo = { renderFilm, SCRIPT, DURATION, stateAt };
