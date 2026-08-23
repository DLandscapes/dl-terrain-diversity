// @ts-check
// The RENDER self-test: assertions about pixels and GPU-side geometry.
//
// WHY THIS EXISTS. The kernel suite (selftest.js, 82 checks) runs headless and
// tests mathematics. Every rendering defect this project has shipped was
// invisible to it and was found by eye, days later:
//
//   - the worker aliasing its baseline onto the live surface (uniform cut/fill)
//   - a wireframe chorded across 4 cells, buried by up to 0.39 m of terrain
//   - polygon offset on the faces, whose slope-dependent term made the lattice
//     flicker during orbit
//   - and the one that hid inside all of them: world UTM coordinates baked
//     into float32 vertex buffers, which at northing 7.7e6 quantises to 0.5 m
//     and collapsed PAIRS of the surface's 0.25 m rows onto one coordinate.
//
// The last one is the reason this file exists rather than a paragraph in the
// README. It degraded every rendered frame for three phases, it invalidated
// every pixel measurement taken in that time, and a single assertion — "the
// surface has as many distinct row coordinates as the DEM has rows" — would
// have caught it the day it appeared.
//
// This suite drives renders MANUALLY rather than waiting on requestAnimationFrame,
// so it produces the same numbers in a background tab as in a visible one.

import * as THREE from "three";
import { DEM } from "./dem.js";
import { loadGeoTIFF } from "./geotiff.js";
import { Surface } from "./surface.js";
import { VoxelField } from "./voxels.js";
import { GlyphField } from "./glyph-view.js";
import { WaterField } from "./water.js";
import { pondWater } from "./analysis/ponding.js";
import { View } from "./view.js";
import { RealtimeClock, FixedStepClock } from "./clock.js";
import { renderSequence, seamPair, frameDiff } from "./capture.js";
import {
  PlantField, PLANT_COLOUR, FORMS, cadGeometry,
  PLANT_INK, MOISTURE_ALPHA, compositeOverStage, PLANT_MOISTURE,
} from "./plants.js";
import { StemField, STRATA, STEM_INK, STRATUM_OF_SPECIES } from "./stems.js";
import { Apron, surfaceZ } from "./apron.js";
import { apronFit } from "./dive.js";
import { PlanOverlay } from "./plan-view.js";
import { PlanSet } from "./plan.js";
import { assemble, SPECIES, CODE } from "./analysis/species.js";
import { CATEGORICAL } from "./analysis/ramps.js";
import { computeGradient } from "./analysis/horn.js";
import { flowAccumulation } from "./analysis/mfd.js";
import { twi } from "./analysis/indices.js";

/** @typedef {{group:string, check:string, expected:string, measured:string, pass:boolean}} Row */

/** Oblique working view, and a grazing one where gaps and shimmer show. */
const CAM_MID = { yaw: 0.7, pitch: 0.5, dist: 95, target: [0, 0, 0] };
const CAM_LOW = { yaw: 0.8, pitch: 0.16, dist: 45, target: [0, 0, 0] };

/**
 * @param {(rel:string)=>Promise<ArrayBuffer>} fetchTile
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} overlay
 * @returns {Promise<Row[]>}
 */
export async function runRenderSuite(fetchTile, canvas, overlay) {
  /** @type {Row[]} */
  const rows = [];
  const add = (group, check, expected, measured, pass) =>
    rows.push({ group, check, expected: String(expected), measured: String(measured), pass });

  const dem = DEM.fromRaw(loadGeoTIFF(await fetchTile("orndalen_fill_025m.tif"), { name: "render" }));
  const view = new View(canvas, overlay, new RealtimeClock());
  view.renderer.setSize(900, 600, false);
  view.camera.aspect = 1.5;
  view.camera.updateProjectionMatrix();

  const gl = view.renderer.getContext();
  /** Render one frame and return its luminance plane. */
  const lum = () => {
    view.renderer.render(view.scene, view.activeCamera);
    const w = canvas.width, h = canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const L = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      L[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
    }
    return { L, w, h };
  };
  const SKY = 250; // above this luminance a pixel is the white stage

  /**
   * The habitat axes for a DEM — the light set, without the horizon-traced
   * layers. Enough for `assemble` to name a winner per cell, which is all any
   * check here needs; tracing sky-view for 65 536 cells twice per group would
   * dominate the suite's runtime and change no assertion.
   */
  const speciesAxes = (d) => {
    const g = computeGradient(d);
    const fl = flowAccumulation(d);
    return {
      twi: twi(fl.specificCatchmentArea, g.slope), slope: g.slopeDeg,
      cell: d.cell, elevation: d.z,
    };
  };

  /** Camera aimed at a representation's own centre, in world coordinates. */
  const aim = (rep, cam) => {
    const box = rep.boundingBox();
    const c = box.getCenter(new THREE.Vector3());
    view.setCameraState({ ...cam, target: c.toArray() }, 0);
  };

  /**
   * Sky-coloured pixels BELOW the terrain's silhouette — i.e. holes you can see
   * through, as distinct from the sky above the horizon.
   */
  const holesPct = () => {
    const { L, w, h } = lum();
    let white = 0, tot = 0;
    for (let x = Math.floor(w * 0.15); x < w * 0.85; x++) {
      let top = -1;
      for (let y = h - 1; y >= 0; y--) if (L[y * w + x] <= SKY) { top = y; break; }
      if (top < 0) continue;
      for (let y = 0; y < top; y++) { tot++; if (L[y * w + x] > SKY) white++; }
    }
    return tot ? (100 * white) / tot : 0;
  };

  /** Median luminance over terrain pixels. */
  const medianLuma = () => {
    const { L } = lum();
    const vals = [];
    for (let i = 0; i < L.length; i += 3) if (L[i] <= SKY) vals.push(L[i]);
    if (!vals.length) return NaN;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  };

  /** Share of pixels whose tone moves more than 25/255 across a tiny orbit step. */
  const shimmerPct = (rep) => {
    const box = rep.boundingBox();
    const c = box.getCenter(new THREE.Vector3());
    view.setCameraState({ ...CAM_LOW, target: c.toArray() }, 0);
    const a = lum();
    view.setCameraState({ ...CAM_LOW, yaw: CAM_LOW.yaw + 0.004, target: c.toArray() }, 0);
    const b = lum();
    let n = 0, strong = 0;
    for (let i = 0; i < a.L.length; i++) {
      if (a.L[i] > 251 && b.L[i] > 251) continue;
      n++;
      if (Math.abs(a.L[i] - b.L[i]) > 25) strong++;
    }
    return n ? (100 * strong) / n : 0;
  };

  // ============================================================== GROUP R1
  // The float32 trap. These are cheap, they are structural, and either one of
  // them fails the instant someone reintroduces world coordinates into a
  // vertex or instance buffer.
  const R1 = "R1 · coordinates never reach a float32 buffer as world values";
  const surface = new Surface(dem, { verticalExaggeration: 2.5 });
  view.scene.add(surface.mesh);
  view.pickTarget = surface.mesh;
  {
    const pos = surface.geometry.getAttribute("position").array;
    const { nrows, ncols } = dem;

    const ys = new Set();
    for (let r = 0; r < nrows; r++) ys.add(pos[(r * ncols + 10) * 3 + 1]);
    add(R1, "the surface keeps one distinct northing per DEM row — float32 at " +
      "UTM northings resolves only 0.5 m and silently merges 0.25 m rows in pairs",
      `${nrows} distinct`, `${ys.size} distinct`, ys.size === nrows);

    const xs = new Set();
    for (let c = 0; c < ncols; c++) xs.add(pos[(10 * ncols + c) * 3]);
    add(R1, "…and one distinct easting per DEM column",
      `${ncols} distinct`, `${xs.size} distinct`, xs.size === ncols);

    // The mechanism, not just the symptom: geometry local, origin on the mesh.
    surface.geometry.computeBoundingBox();
    const bb = /** @type {THREE.Box3} */ (surface.geometry.boundingBox);
    add(R1, "geometry is LOCAL: its bounding box starts at the origin",
      "x,y ≥ 0 and < tile span", `${bb.min.x.toFixed(2)}, ${bb.min.y.toFixed(2)}`,
      bb.min.x >= 0 && bb.min.y >= 0 && bb.max.x <= dem.ncols * dem.cell + 1);
    add(R1, "…and the UTM origin rides on mesh.position, where matrix maths is float64",
      `${dem.originX} / ${dem.originY}`,
      `${surface.mesh.position.x} / ${surface.mesh.position.y}`,
      surface.mesh.position.x === dem.originX && surface.mesh.position.y === dem.originY);

    // Framing and picking must still speak world coordinates.
    const box = surface.boundingBox();
    add(R1, "boundingBox() still reports WORLD coordinates, so framing is unaffected",
      `x ≈ ${dem.originX}`, `x = ${box.min.x.toFixed(0)}`,
      Math.abs(box.min.x - dem.originX) < 1.5);
  }

  // ============================================================== GROUP R2
  const R2 = "R2 · the surface renders legibly";
  {
    aim(surface, CAM_MID);
    const med = medianLuma();
    // The r155 physically-correct-lighting trap: intensities tuned against the
    // old behaviour render ~3x too dark. That shipped once, at median 142.
    add(R2, "terrain sits in the intended tonal band, not the 3x-too-dark " +
      "range that pre-r155 light intensities produce",
      "180–235", med.toFixed(0), med >= 180 && med <= 235);

    // The lattice must be present and must not paint the terrain black.
    const withWire = (() => { const { L } = lum(); return L; })();
    surface.setWireframe(false);
    const noWire = (() => { const { L } = lum(); return L; })();
    surface.setWireframe(true);
    let darkened = 0, terrain = 0;
    for (let i = 0; i < withWire.length; i++) {
      if (noWire[i] > SKY) continue;
      terrain++;
      if (noWire[i] - withWire[i] > 1) darkened++;
    }
    const cover = (100 * darkened) / terrain;
    add(R2, "the wireframe is visible but does not cover the surface it describes",
      "5–60% of terrain pixels", `${cover.toFixed(1)}%`, cover >= 5 && cover <= 60);

    const sh = shimmerPct(surface);
    add(R2, "a small orbit step does not boil the image — the symptom of " +
      "degenerate geometry, which is how the float32 bug presented",
      "<12% of pixels", `${sh.toFixed(1)}%`, sh < 12);

    // ── CONTOURS ────────────────────────────────────────────────────────────
    // The kernel suite (group S) proves the segments lie in the triangulation.
    // What only a renderer can show is that this SECOND vertex buffer obeys the
    // same rule R1 exists for — a contour vertex is interpolated and written
    // fresh, so it is exactly the kind of buffer that world coordinates creep
    // back into — and that the lines read as line work rather than painting
    // over the surface, which is how the voxel outlines failed.
    {
      const noContours = (() => { const { L } = lum(); return L; })();
      surface.setContourInterval(0.5);
      const withContours = (() => { const { L } = lum(); return L; })();

      const cpos = surface.contours.geometry.getAttribute("position").array;
      let maxX = 0, maxY = 0;
      for (let i = 0; i < cpos.length; i += 3) {
        if (cpos[i] > maxX) maxX = cpos[i];
        if (cpos[i + 1] > maxY) maxY = cpos[i + 1];
      }
      const span = dem.ncols * dem.cell;
      add(R2, "contour geometry is LOCAL like the surface's — a fresh vertex " +
        "buffer is exactly where world coordinates creep back in, and at this " +
        "site float32 would quantise them to half a metre",
        `x,y ≤ ${span} m`, `${maxX.toFixed(2)}, ${maxY.toFixed(2)}`,
        maxX > 0 && maxX <= span + 1 && maxY <= span + 1);
      add(R2, "…so they hang off the terrain mesh and inherit the UTM origin " +
        "from its transform rather than carrying it themselves",
        "parent is the terrain mesh",
        surface.contours.parent === surface.mesh ? "parent is the terrain mesh" : "detached",
        surface.contours.parent === surface.mesh);

      let cDark = 0, cTerrain = 0;
      for (let i = 0; i < withContours.length; i++) {
        if (noContours[i] > SKY) continue;
        cTerrain++;
        if (noContours[i] - withContours[i] > 1) cDark++;
      }
      const cCover = (100 * cDark) / cTerrain;
      // ⚠️ The band is 1–50%, not 2–50%, and the difference is the point. At a
      // 0.5 m interval on 5.3 m of relief this is about eleven thin lines
      // across the frame, and it measures 2.0% — so a 2% floor passes by luck
      // and would fail on the next tile or a coarser interval. Coverage here is
      // bounded by line LENGTH, not by opacity: a 1 px line darkens the pixels
      // it crosses and no others, so drawing the contours stronger would not
      // move this number. The ceiling is the one doing real work — it is the
      // failure the voxel outlines hit, where 65 536 lines went solid black.
      add(R2, "contours are visible on the terrain without painting over it",
        "1–50% of terrain pixels (2.0% at 0.5 m here)", `${cCover.toFixed(1)}%`,
        cCover >= 1 && cCover <= 50);

      // The lines lie exactly IN the facets, so line-versus-face is a depth tie
      // at every pixel. A constant NDC bias settles every tie the same way; a
      // slope-scaled one (polygon offset) would flip winners per facet and per
      // frame, which is what the lattice shimmer was.
      const shC = shimmerPct(surface);
      add(R2, "…and they do not shimmer during orbit, which is what a depth tie " +
        "settled by anything view-dependent would produce",
        "<12% of pixels", `${shC.toFixed(1)}%`, shC < 12);

      add(R2, "…and opt out of the grid's fog, as the surface and lattice do",
        "contour fog: false",
        String(/** @type {any} */ (surface.contours.material).fog),
        /** @type {any} */ (surface.contours.material).fog === false);

      surface.setContourInterval(0);
      add(R2, "switching contours off hides them rather than leaving stale line " +
        "work on a surface that has since been edited",
        "hidden", surface.contours.visible ? "visible" : "hidden",
        surface.contours.visible === false);
    }

    // The scene fog exists ONLY to fade the ground grid out to infinity. If
    // terrain ever opts back in, the far half of the tile washes to white and
    // reads as missing data rather than as distance. (This suite builds no
    // grid of its own — View makes one in frame(), which it never calls — so
    // the fog is asserted by contract here rather than by pixels.)
    add(R2, "the scene carries fog for the infinite ground grid",
      "fog present", view.scene.fog ? "yes" : "no", !!view.scene.fog);
    add(R2, "…and the terrain opts out of it, so distance never eats the tile",
      "surface fog: false", String(surface.material.fog), surface.material.fog === false);
    add(R2, "…as does the lattice drawn on it",
      "wire fog: false",
      String(/** @type {any} */ (surface.wire.material).fog),
      /** @type {any} */ (surface.wire.material).fog === false);
  }

  view.scene.remove(surface.mesh);
  surface.dispose();

  // ============================================================== GROUP R3
  const R3 = "R3 · the voxel field is solid at every block size";
  for (const blockCells of [1, 2, 4, 8]) {
    const vox = new VoxelField(dem, { verticalExaggeration: 2.5, blockCells });
    view.scene.add(vox.mesh);
    if (blockCells === 1) {
      add(R3, "the block field opts out of the grid's fog as well",
        "fog: false", String(vox.material.fog), vox.material.fog === false);
    }

    const blocks = vox.blockRows * vox.blockCols;
    if (blockCells === 4) {
      add(R3, "one box per column — a stack of cubes is what read as a plinth " +
        "rather than as voxels", `${blocks}`, `${vox.cubeCount}`, vox.cubeCount === blocks);
    }

    // Instance translations are float32 too, and were quantised by the same bug.
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const ys = new Set();
    let minH = Infinity;
    const cubeH = vox.voxelHeight * vox.exaggeration;
    for (let i = 0; i < vox.cubeCount; i++) {
      vox.mesh.getMatrixAt(i, m); m.decompose(p, q, sc);
      ys.add(p.y);
      if (sc.z < minH) minH = sc.z;
    }
    add(R3, `${blockCells} cell(s) per block: one distinct northing per block row`,
      `${vox.blockRows}`, `${ys.size}`, ys.size === vox.blockRows);
    add(R3, "…every box is at least a full cube tall, so none can leave a slot",
      `≥ ${cubeH.toFixed(3)}`, minH.toFixed(3), minH >= cubeH - 1e-6);

    aim(vox, CAM_LOW);
    const h = holesPct();
    add(R3, "…and nothing shows through the field from a grazing angle",
      "<1% of pixels below the silhouette", `${h.toFixed(2)}%`, h < 1);

    view.scene.remove(vox.mesh);
    vox.dispose();
  }

  // ── R3b ────────────────────────────────────────────────────────────────
  // A LAYER READ AS SIZE, on the blocks (2026-08-19, Marc). The viewport's
  // version of the proportional-symbol technique the grading sheet already
  // uses. What has to hold: the size really tracks the value, an unmeasured
  // cell draws NOTHING rather than a small block, and the TOP of every block
  // stays where the solid field put it — because size may not quietly move the
  // ground surface.
  const R3B = "R3b · blocks sized by an analysis layer — a second channel, not a second guess";
  {
    const k = 8;
    const vox = new VoxelField(dem, { verticalExaggeration: 2.5, blockCells: k });
    view.scene.add(vox.mesh);
    const n = dem.nrows * dem.ncols;
    const m = new THREE.Matrix4(), p = new THREE.Vector3();
    const q = new THREE.Quaternion(), sc = new THREE.Vector3();
    /** every live box as {x, y, top, w} */
    const boxes = () => {
      const out = [];
      for (let i = 0; i < vox.cubeCount; i++) {
        vox.mesh.getMatrixAt(i, m); m.decompose(p, q, sc);
        out.push({ x: p.x, y: p.y, top: p.z + sc.z / 2, w: sc.x });
      }
      return out;
    };

    const solid = boxes();
    const solidW = new Set(solid.map((b) => b.w.toFixed(4)));
    add(R3B, "with no layer chosen every block is the same footprint — the "
      + "solid field is unchanged by the feature existing",
      "1 distinct width", `${solidW.size}`, solidW.size === 1);

    // A ramp west→east, fully defined: size must follow it monotonically.
    const ramp = new Float32Array(n);
    for (let r = 0; r < dem.nrows; r++) {
      for (let c = 0; c < dem.ncols; c++) ramp[r * dem.ncols + c] = c / (dem.ncols - 1);
    }
    vox.setScaleField(ramp, { minFraction: 0.2 });
    const scaled = boxes();
    add(R3B, "a fully defined layer keeps every block — scaling changes how big "
      + "they are, never how many",
      `${solid.length}`, `${scaled.length}`, scaled.length === solid.length);

    // Widths against easting, along one row.
    const row = scaled.filter((b) => Math.abs(b.y - scaled[0].y) < 1e-6)
      .sort((a, b) => a.x - b.x);
    let monotone = true;
    for (let i = 1; i < row.length; i++) if (row[i].w < row[i - 1].w - 1e-6) monotone = false;
    add(R3B, "…and the footprint follows the VALUE, rising monotonically across "
      + "a west-to-east ramp — size is the reading, not a decoration",
      "monotone increasing across the row",
      `${row.length} blocks, ${row[0].w.toFixed(3)} → ${row[row.length - 1].w.toFixed(3)}`,
      monotone && row.length > 2 && row[row.length - 1].w > row[0].w * 2);

    // ⚠️ THE SMALLEST BLOCK IS THE STATED FRACTION, NOT ZERO. A real measurement
    // of a low value must stay visible; vanishing is reserved for "no answer".
    const minW = Math.min(...scaled.map((b) => b.w));
    const maxW = Math.max(...scaled.map((b) => b.w));
    add(R3B, "the smallest block is the stated fraction of the largest, never "
      + "zero — a low value is a measurement and has to stay visible, because "
      + "vanishing already means something else here",
      "min/max ≈ 0.20", (minW / maxW).toFixed(3),
      Math.abs(minW / maxW - 0.2) < 0.03);

    // ⚠️ THE TOP DOES NOT MOVE. Shrinking about the centre would drop the
    // surface by half a block wherever the attribute is low, so the field would
    // be reporting a different elevation for the same ground.
    const topBefore = new Map(solid.map((b) => [`${b.x.toFixed(3)},${b.y.toFixed(3)}`, b.top]));
    let worstTop = 0;
    for (const b of scaled) {
      const t = topBefore.get(`${b.x.toFixed(3)},${b.y.toFixed(3)}`);
      if (t !== undefined) worstTop = Math.max(worstTop, Math.abs(t - b.top));
    }
    // ⚠️ THE TOLERANCE IS THE BUFFER'S OWN PRECISION, NOT SLACK. These tops are
    // read back out of a float32 instance matrix at an exaggerated elevation
    // around 190, where one float32 step is 1.1e-5 — so a "0 m" assertion at
    // 1e-6 was asking the storage for four times the precision it has, and
    // failed at 1.4e-5, or 1.25 steps. Measured against 2 m blocks that is
    // seven parts in a million of a block. The threshold is set to a few
    // storage steps: tight enough that half a level (about 1 m) could never
    // pass, loose enough that the check is testing the geometry rather than
    // IEEE 754. Same family of reasoning as R1, one direction over.
    const F32_STEP = 187.5 * Math.pow(2, -24);
    add(R3B, "…and the TOP of every block stays exactly where the solid field "
      + "put it, so sizing by an attribute cannot quietly restate the elevation",
      `no movement beyond float32 storage (${(F32_STEP * 4).toExponential(1)} m)`,
      `${worstTop.toExponential(1)} m`, worstTop < F32_STEP * 4);

    // ⚠️ NO ANSWER, NO BLOCK — the rule symbols.js keeps.
    const half = new Float32Array(n);
    for (let r = 0; r < dem.nrows; r++) {
      for (let c = 0; c < dem.ncols; c++) {
        half[r * dem.ncols + c] = r < dem.nrows / 2 ? NaN : 0.7;
      }
    }
    vox.setScaleField(half, { minFraction: 0.2 });
    const halfN = vox.cubeCount;
    const allNaN = new Float32Array(n).fill(NaN);
    vox.setScaleField(allNaN, { minFraction: 0.2 });
    const noneN = vox.cubeCount;
    add(R3B, "a cell with no answer carries NO block — not a small one. A "
      + "minimum-size block there would read as 'measured, and very low' where "
      + "the truth is 'not measured at all', and on TWI that is most of a "
      + "levelled surface: the tool would draw its own central finding as a low "
      + "value instead of as an absence",
      `half the field ≈ ${Math.round(solid.length / 2)}, all-NaN 0`,
      `${halfN}, ${noneN}`,
      Math.abs(halfN - solid.length / 2) <= solid.length * 0.02 && noneN === 0);

    // And it is reversible: back to null is the solid field again.
    vox.setScaleField(null);
    add(R3B, "…and clearing the layer restores the solid field exactly, so the "
      + "channel can be switched off as cleanly as it was switched on",
      `${solid.length} blocks, 1 width`,
      `${vox.cubeCount} blocks, ${new Set(boxes().map((b) => b.w.toFixed(4))).size} width(s)`,
      vox.cubeCount === solid.length
      && new Set(boxes().map((b) => b.w.toFixed(4))).size === 1);

    view.scene.remove(vox.mesh);
    vox.dispose();
  }

  // ── R3c ────────────────────────────────────────────────────────────────
  // THE GLYPH FIELD's buffer. glyphs.js is checked in the kernel suite (Y2);
  // what can only be checked here is that a polyline of k points becomes k−1
  // drawn segments in ONE buffer, and that the field's geometry is LOCAL — the
  // float32 trap R1 exists for applies to every buffer, and a field of thin
  // lines quantised to half a metre would read as a shimmering mess.
  const R3C = "R3c · the glyph field draws every segment, from local coordinates";
  {
    const gf = new GlyphField(dem, { verticalExaggeration: 2.5 });
    view.scene.add(gf.group);
    // Two glyphs: one of 4 points, one of 7.
    const g1 = { pts: [0, 0, 0, 1, 0, 1, 2, 0, 2, 3, 0, 3] };
    const g2 = { pts: [] };
    for (let i = 0; i < 7; i++) g2.pts.push(i, i, i);
    gf.setGlyphs([g1, g2]);
    add(R3C, "a polyline of k points becomes k−1 drawn segments, and the whole "
      + "field is ONE buffer — a Line per glyph would be a draw call per glyph "
      + "and the tool would stall while a hand was still on the brush",
      "3 + 6 = 9 segments, 2 glyphs, 1 object",
      `${gf.segments} segments, ${gf.count} glyphs, `
      + `${gf.group.children.length} object(s)`,
      gf.segments === 9 && gf.count === 2 && gf.group.children.length === 1);

    const attr = /** @type {any} */ (gf.group.children[0]).geometry
      .getAttribute("position");
    add(R3C, "…with two vertices per segment, so nothing is dropped off the end "
      + "of the buffer",
      "18 vertices", `${attr.count}`, attr.count === 18);

    // ⚠️ LOCAL, with the UTM origin on the group — R1's lesson, applied to the
    // one buffer that did not exist when R1 was written.
    let maxAbs = 0;
    for (let i = 0; i < attr.count; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(attr.getX(i)), Math.abs(attr.getY(i)));
    }
    add(R3C, "…and its vertices are LOCAL — the UTM origin rides on the group, "
      + "never in the buffer, or float32 would quantise a field of thin lines "
      + "to half a metre at this site's northing",
      "no coordinate near a UTM magnitude; origin on the group",
      `max |xy| ${maxAbs.toFixed(1)}, group at ${gf.group.position.x.toFixed(0)}`,
      maxAbs < 1000 && gf.group.position.x > 100000);

    gf.setGlyphs([]);
    add(R3C, "…and an empty field draws nothing at all rather than an empty "
      + "object, so 'no glyph anywhere' costs no draw call",
      "0 objects", `${gf.group.children.length}`, gf.group.children.length === 0);

    view.scene.remove(gf.group);
    gf.dispose();
  }

  // ⚠️ THIS GROUP NO LONGER TESTS WHAT THE SCENE DRAWS. The scene's vegetation
  // is stems.js — see R9. What is tested here is plants.js: the seven growth-form
  // DRAWINGS and their palette, which are the source of the species plate and
  // the printed legend for the A1 poster, and are still shipped for that.
  // The distinction matters because a suite that quietly went on testing the
  // replaced class would stay green while the thing on screen was unchecked.
  const R4 = "R4 · the growth-form drawings behind the species plate";
  {
    // Codes for the real surface, and for an exactly levelled one.
    const axesOf = (d) => {
      const g = computeGradient(d);
      const fl = flowAccumulation(d);
      return { twi: twi(fl.specificCatchmentArea, g.slope), slope: g.slopeDeg,
        cell: d.cell, elevation: d.z };
    };
    const realCodes = assemble(axesOf(dem)).codes;
    const plane = dem.clone();
    let sum = 0, cnt = 0;
    for (const v of plane.z) if (Number.isFinite(v)) { sum += v; cnt++; }
    plane.z.fill(sum / cnt);
    const flatCodes = assemble(axesOf(plane)).codes;

    const EX = 2.5;
    const plants = new PlantField(dem, { verticalExaggeration: EX });
    view.scene.add(plants.group);
    plants.setCodes(realCodes);

    add(R4, "the UTM origin rides on the group, exactly as it does for the " +
      "surface and the voxel field",
      `${dem.originX}, ${dem.originY}`,
      `${plants.group.position.x}, ${plants.group.position.y}`,
      plants.group.position.x === dem.originX && plants.group.position.y === dem.originY);

    // ⚠️ The float32 defence, for instance matrices this time. World northings
    // baked in here would quantise the scatter onto a half-metre lattice and it
    // would render as rows rather than as a scatter.
    const m = new THREE.Matrix4(), p = new THREE.Vector3();
    const q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const span = dem.ncols * dem.cell;
    /** Every drawn instance's translation, keyed, with its species. */
    const positions = (field) => {
      const out = new Map();
      for (let s = 0; s < field.meshes.length; s++) {
        const mesh = field.meshes[s];
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, m); m.decompose(p, q, sc);
          out.set(`${p.x.toFixed(4)},${p.y.toFixed(4)}`, s);
        }
      }
      return out;
    };
    const posReal = positions(plants);
    let outside = 0;
    for (const k of posReal.keys()) {
      const [x, y] = k.split(",").map(Number);
      if (x < 0 || x > span || y < 0 || y > span) outside++;
    }
    add(R4, "instance translations are LOCAL to the tile — world coordinates in " +
      "a float32 instance buffer would quantise the scatter onto a 0.5 m lattice",
      `0 outside 0–${span} m`, `${outside} outside`, outside === 0);
    add(R4, "…and they are genuinely distinct, not collapsed onto that lattice",
      "> 99% distinct", `${posReal.size} of ${plants.instanceCount}`,
      posReal.size > plants.instanceCount * 0.99);

    // ⚠️ PLANTS ARE NOT STRETCHED BY THE TERRAIN'S EXAGGERATION, and this is the
    // reverse of what the first version did. Scaling plant height by the
    // exaggeration made everything spindly — at 2.5x a 0.36 m tussock stood
    // 0.9 m tall and stayed 0.26 m wide. Only the ground is exaggerated now.
    const flat = new PlantField(dem, { verticalExaggeration: 1 });
    flat.setCodes(realCodes);
    const mFlat = new THREE.Matrix4(), sFlat = new THREE.Vector3();
    flat.meshes[0].getMatrixAt(0, mFlat);
    mFlat.decompose(new THREE.Vector3(), new THREE.Quaternion(), sFlat);
    plants.meshes[0].getMatrixAt(0, m); m.decompose(p, q, sc);
    add(R4, "plant SIZE ignores the terrain's vertical exaggeration, so plants " +
      "keep their true proportions however much the ground is stretched",
      `identical at 1× and ${EX}×`,
      `${sFlat.z.toFixed(4)} vs ${sc.z.toFixed(4)}`,
      Math.abs(sFlat.z - sc.z) < 1e-6 && Math.abs(sFlat.x - sc.x) < 1e-6);
    // …but their POSITION must still follow it, or they float above the ground.
    const pFlat = new THREE.Vector3();
    flat.meshes[0].getMatrixAt(0, mFlat);
    mFlat.decompose(pFlat, new THREE.Quaternion(), new THREE.Vector3());
    add(R4, "…while plant POSITION does follow it, so they stand on the surface " +
      "as drawn rather than floating above or sinking into it",
      `z scales with ${EX}×`, `${pFlat.z.toFixed(2)} → ${p.z.toFixed(2)}`,
      Math.abs(p.z - pFlat.z * EX) < 0.02);
    flat.dispose();

    // ⚠️ THE CENTRAL REQUIREMENT. Re-seat the scatter on a completely different
    // assemblage: a plant may appear or vanish, but no plant may MOVE. Without
    // this the vegetation crawls across the whole site whenever a gesture is
    // made in one corner, and a 45-second capture reads as noise.
    plants.setCodes(flatCodes);
    const posFlat = positions(plants);
    let moved = 0;
    for (const k of posFlat.keys()) if (!posReal.has(k)) moved++;
    add(R4, "re-seating on a completely different assemblage moves NO plant — " +
      "every drawn position was already a drawn position before",
      "0 new positions", `${moved} new`, moved === 0);
    let reassigned = 0;
    for (const [k, s] of posFlat) if (posReal.get(k) !== s) reassigned++;
    add(R4, "…while the species at those positions really did change, so the " +
      "check above is not passing by the scatter simply ignoring its input",
      "> 50% reassigned",
      `${((100 * reassigned) / posFlat.size).toFixed(0)}%`,
      reassigned > posFlat.size * 0.5);

    // The levelled plane is a lupine monoculture, and the scene must say so.
    const drawn = plants.meshes.map((x) => x.count);
    add(R4, "a levelled surface leaves only the invasive standing on it — the " +
      "3D view tells the same story as the raster and the readout",
      `only mesh ${CODE.lupinus} populated`,
      drawn.map((n, i) => (n ? `${SPECIES[i].id}:${n}` : null)).filter(Boolean).join(" "),
      drawn.every((n, i) => (i === CODE.lupinus ? n > 0 : n === 0)));

    // ⚠️ THE SCENE USES A PLANT PALETTE, NOT THE RASTER'S CLASS PALETTE, and the
    // divergence is deliberate — see PLANT_COLOUR in plants.js. Painting plant
    // shapes in the raster's magenta and teal put the scatter in an uncanny
    // middle. Legend agreement is the RASTER's job and kernel group N asserts it
    // there; what has to hold here is that the scene uses the plant palette and
    // that the species remain tellable apart.
    // The solid is lifted toward paper and the edge darkened, both derived from
    // the one plant colour — so check the relationship rather than the literal
    // value: the edge must be the darker of the two, and both must sit on the
    // species' own hue.
    let wrongColour = 0;
    for (let s = 0; s < plants.meshes.length; s++) {
      const solid = /** @type {any} */ (plants.meshes[s].material).color;
      const edge = /** @type {any} */ (plants.wires[s].material).color;
      const [r0, g0, b0] = PLANT_COLOUR[SPECIES[s].id];
      const base = new THREE.Color(r0 / 255, g0 / 255, b0 / 255);
      const wantSolid = base.clone();
      const wantEdge = new THREE.Color(
        PLANT_INK[0] / 255, PLANT_INK[1] / 255, PLANT_INK[2] / 255);
      const near = (a, b) => Math.abs(a.r - b.r) < 0.01
        && Math.abs(a.g - b.g) < 0.01 && Math.abs(a.b - b.b) < 0.01;
      if (!near(solid, wantSolid) || !near(edge, wantEdge)) wrongColour++;
    }
    add(R4, "every species is drawn in its own naturalistic colour, not the " +
      "raster's class colour — nothing plant-shaped reads right in magenta",
      "0 mismatches", `${wrongColour} mismatched`, wrongColour === 0);

    // ⚠️ PLANTS MUST STAND ON THE GROUND, THE RIGHT WAY UP. This needs a test
    // because the failure is silent: the previous version inverted every plant
    // when it moved to a DataTexture, since DataTexture defaults to
    // flipY=false and WebGL ignores UNPACK_FLIP_Y_WEBGL for data textures.
    // Nothing threw. With solid geometry the equivalent slip is a body built
    // around the origin instead of on top of it, so it sinks half underground.
    let sunk = 0, wrongHeight = 0;
    for (let s = 0; s < SPECIES.length; s++) {
      const g = plants.meshes[s].geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox;
      if (bb.min.z < -0.005) sunk++;
      // Height should match the form table, not some accident of the primitive.
      const want = FORMS[SPECIES[s].form][1];
      if (Math.abs(bb.max.z - want) > want * 0.35) wrongHeight++;
    }
    add(R4, "every plant sits ON the ground rather than half through it — a body " +
      "built around the origin instead of on top of it sinks, silently",
      "0 below z=0", `${sunk} sunk`, sunk === 0);
    add(R4, "…and stands the height its growth form declares, so the sizes in " +
      "SPECIES-RULES.txt describe what is actually drawn",
      "0 mismatched", `${wrongHeight} mismatched`, wrongHeight === 0);

    // ⚠️ THE PALETTE IS GREYSCALE NOW, so the old "≥ 40 apart in RGB" check is
    // gone — see PLANT_COLOUR in plants.js for why it is arithmetically
    // impossible on one axis. Three checks replace it: the palette really is
    // grey, the tones still order cleanly, and — the one that actually matters —
    // the SILHOUETTES are distinguishable, because shape is now the only
    // identity channel the scatter has.
    const ids = SPECIES.map((s) => s.id);

    let nonGrey = 0;
    for (const id of ids) {
      const [r, g, b] = PLANT_COLOUR[id];
      if (r !== g || g !== b) nonGrey++;
    }
    add(R4, "the plant palette is greyscale, so the scene, the printed A1 poster " +
      "and the video share one drawing language",
      "0 chromatic entries", `${nonGrey} chromatic`, nonGrey === 0);

    // ⚠️ THE SEPARATION THAT MATTERS IS BETWEEN MOISTURE BANDS, NOT BETWEEN
    // SPECIES. Face opacity encodes the wetness gradient, so two species in the
    // same band SHARE a tone deliberately — that is information, not a
    // collision, and a per-species check here would forbid it.
    const bands = Object.keys(MOISTURE_ALPHA);
    let minBand = Infinity, closestBand = "";
    for (let a = 0; a < bands.length; a++) {
      for (let b = a + 1; b < bands.length; b++) {
        const d = Math.abs(compositeOverStage(MOISTURE_ALPHA[bands[a]])
          - compositeOverStage(MOISTURE_ALPHA[bands[b]]));
        if (d < minBand) { minBand = d; closestBand = `${bands[a]}/${bands[b]}`; }
      }
    }
    add(R4, "…and the five moisture bands stay far enough apart in tone to read " +
      "as a gradient, since face opacity is what carries wetness",
      "≥ 18 apart in grey", `${minBand} (${closestBand})`, minBand >= 18);

    let wrongBand = 0;
    for (const id of ids) {
      const want = compositeOverStage(MOISTURE_ALPHA[PLANT_MOISTURE[id]]);
      if (PLANT_COLOUR[id][0] !== want) wrongBand++;
    }
    add(R4, "…and every species' fill is DERIVED from its moisture band rather " +
      "than hand-tuned, so the encoding cannot drift from what it claims",
      "0 hand-tuned", `${wrongBand} off-band`, wrongBand === 0);

    /**
     * ⚠️ EVERY FORM MUST BE MIRROR-SYMMETRIC ABOUT ITS VERTICAL AXIS, and the
     * test has to look at the DRAWN EDGE SET, not at the outline.
     *
     * An outline test is vacuous here, which I found only by trying to break it:
     * three.js builds cylinder rings as `x = r·sin(θ)`, and {sin(2πk/N)} is
     * closed under negation for every N — so a 5-segment cylinder has a
     * perfectly symmetric silhouette, and an envelope-based check passes
     * everything it is shown. What actually goes wrong is a part placed off the
     * axis: a single nodding seed head, one side umbel, or a radial arrangement
     * whose phase puts one arm at +0.45r and two at −0.225r.
     *
     * So: project every triangle edge to elevation, quantise, and require the
     * set to map onto itself under x → −x. Verified to bite — displacing a form
     * by 2 cm scores 100% unmatched — and verified not to fire on a rotation
     * about the vertical axis, which is a genuine symmetry rather than a defect.
     */
    const edgeAsymmetry = (geo) => {
      const p = geo.attributes.position.array;
      const index = geo.index ? geo.index.array : null;
      const n = index ? index.length : p.length / 3;
      const Q = (v) => Math.round(v * 1e4);
      const xz = (k) => { const j = (index ? index[k] : k) * 3; return [p[j], p[j + 2]]; };
      const key = (a, b) => {
        const A = [Q(a[0]), Q(a[1])], B = [Q(b[0]), Q(b[1])];
        return (A[0] < B[0] || (A[0] === B[0] && A[1] <= B[1]))
          ? `${A}|${B}` : `${B}|${A}`;
      };
      const set = new Set();
      for (let t = 0; t + 2 < n; t += 3) {
        const a = xz(t), b = xz(t + 1), c = xz(t + 2);
        set.add(key(a, b)); set.add(key(b, c)); set.add(key(c, a));
      }
      let unmatched = 0;
      for (const k of set) {
        const [A, B] = k.split("|").map((s) => s.split(",").map(Number));
        if (!set.has(key([-A[0] / 1e4, A[1] / 1e4], [-B[0] / 1e4, B[1] / 1e4]))) unmatched++;
      }
      return unmatched / set.size;
    };

    let worstSym = 0, worstForm = "none";
    for (const key of Object.keys(FORMS)) {
      const a = edgeAsymmetry(cadGeometry(key));
      if (a > worstSym) { worstSym = a; worstForm = key; }
    }
    add(R4, "…and every growth form is mirror-symmetric about its vertical axis, " +
      "including its internal line-work — an off-axis part reads as a drawing error",
      "0% unmatched edges",
      `${(100 * worstSym).toFixed(1)}% (${worstForm})`, worstSym === 0);

    /**
     * A growth form's silhouette as a width profile: for each horizontal band,
     * how far the form reaches from its axis.
     *
     * ⚠️ SAMPLE ALONG THE TRIANGLE EDGES, NOT JUST THE VERTICES. A cylinder
     * carries vertices only on its top and bottom rings, so a vertex-only
     * profile leaves every band between them empty and two completely different
     * forms compare as equal.
     *
     * Both axes are normalised — height to the form's own height, reach to its
     * own widest point — so this measures PROPORTION rather than size. That is
     * deliberate: a mountain birch and a lichen crust are trivially different in
     * metres, and a test that leaned on that would pass while two same-sized
     * forms quietly converged. It also matches how the species plate draws them,
     * each at a comparable size in its own cell.
     */
    const silhouette = (geo, BANDS = 24, STEPS = 8) => {
      const p = geo.attributes.position.array;
      const index = geo.index ? geo.index.array : null;
      const n = index ? index.length : p.length / 3;
      let zmin = Infinity, zmax = -Infinity;
      for (let i = 2; i < p.length; i += 3) {
        if (p[i] < zmin) zmin = p[i];
        if (p[i] > zmax) zmax = p[i];
      }
      const hz = Math.max(zmax - zmin, 1e-9);
      const prof = new Float32Array(BANDS);
      const put = (x, y, z) => {
        const band = Math.min(BANDS - 1,
          Math.max(0, Math.floor(((z - zmin) / hz) * BANDS)));
        const r = Math.hypot(x, y);
        if (r > prof[band]) prof[band] = r;
      };
      const vert = (k) => { const j = (index ? index[k] : k) * 3; return [p[j], p[j + 1], p[j + 2]]; };
      for (let t = 0; t + 2 < n; t += 3) {
        const a = vert(t), b = vert(t + 1), c = vert(t + 2);
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
          for (let s = 0; s <= STEPS; s++) {
            const f = s / STEPS;
            put(u[0] + (v[0] - u[0]) * f, u[1] + (v[1] - u[1]) * f, u[2] + (v[2] - u[2]) * f);
          }
        }
      }
      let rmax = 0;
      for (const r of prof) if (r > rmax) rmax = r;
      if (rmax > 0) for (let i = 0; i < BANDS; i++) prof[i] /= rmax;
      return prof;
    };

    const profiles = SPECIES.map((s) => silhouette(cadGeometry(s.form)));
    let minShape = Infinity, closestShape = "";
    for (let a = 0; a < profiles.length; a++) {
      for (let b = a + 1; b < profiles.length; b++) {
        let sum = 0;
        for (let i = 0; i < profiles[a].length; i++) {
          sum += Math.abs(profiles[a][i] - profiles[b][i]);
        }
        const d = sum / profiles[a].length;
        if (d < minShape) { minShape = d; closestShape = `${ids[a]}/${ids[b]}`; }
      }
    }
    add(R4, "…and no two growth forms share a silhouette, which is what carries " +
      "identity once colour no longer can",
      "> 0.08 mean profile difference",
      `${minShape.toFixed(3)} (${closestShape})`, minShape > 0.08);

    // And it actually reaches the framebuffer.
    plants.setCodes(realCodes);
    const surf = new Surface(dem, { verticalExaggeration: EX });
    view.scene.add(surf.mesh);
    aim(surf, CAM_LOW);
    plants.setVisible(false);
    const off = lum();
    plants.setVisible(true);
    const on = lum();
    let differing = 0;
    for (let i = 0; i < on.L.length; i++) if (Math.abs(on.L[i] - off.L[i]) > 8) differing++;
    const pct = (100 * differing) / on.L.length;
    add(R4, "…and showing the assemblage actually changes the frame, so the " +
      "layer is reaching the framebuffer rather than being culled away",
      "> 2% of pixels change", `${pct.toFixed(1)}%`, pct > 2);

    // ⚠️ SOLID BODIES, NOT TEXTURED CUTOUTS. Every defect the billboard version
    // shipped was an alpha-cutout defect — a dark rim from black RGB in the
    // transparent texels, a white rim from coverage blending against the white
    // sky, coverage drifting with mip level, and a side elevation lying flat on
    // the ground. Geometry with no alpha cannot reproduce any of them.
    const noAlpha = plants.meshes.every((m) => {
      const mm = /** @type {any} */ (m.material);
      return !mm.map && !mm.alphaToCoverage && !(mm.alphaTest > 0);
    });
    add(R4, "a plant is a solid low-poly body with no alpha anywhere — which is " +
      "what makes the whole class of cutout artefacts unreachable",
      "no map, no alphaTest, no alphaToCoverage",
      noAlpha ? "none present" : "alpha still in use", noAlpha);

    // ⚠️ Not every three.js primitive is indexed — Icosahedron, Octahedron and
    // anything else built on PolyhedronGeometry come back non-indexed, so
    // reading `index.count` blindly throws on half the growth forms.
    const triCounts = plants.meshes.map((m) => (m.geometry.index
      ? m.geometry.index.count : m.geometry.attributes.position.count) / 3);
    add(R4, "…kept low-poly, so the facets read as facets and the scatter stays " +
      "affordable at this density",
      "8–80 triangles each", triCounts.join(","),
      triCounts.every((t) => t >= 8 && t <= 80));

    // The edge pass is what gives it the drafting look, and it must ride on the
    // same geometry and the same instances as the solid or the two drift apart.
    const edgesOk = plants.wires.length === plants.meshes.length
      && plants.wires.every((w, i) => w.geometry === plants.meshes[i].geometry
        && /** @type {any} */ (w.material).wireframe === true
        && w.count === plants.meshes[i].count);
    add(R4, "…with drawn edges over it, sharing one geometry and one instance " +
      "set with the solid, the same treatment the terrain gets from its lattice",
      "shared geometry, wireframe on, counts equal",
      edgesOk ? "yes" : "no", edgesOk);

    // ⚠️ THE CHECK THAT PINS THE THIRD PLANE. Landscape architects work in plan,
    // and this tool has an orthographic Top view. Two crossed VERTICAL quads go
    // edge-on from directly overhead and all but disappear; the horizontal quad
    // is the only reason the layer survives being looked at from above. If
    // someone ever "simplifies" this back to two planes, this is what fails.
    aim(surf, { yaw: 0.3, pitch: 1.45, dist: 60, target: [0, 0, 0] });
    plants.setVisible(false);
    const topOff = lum();
    plants.setVisible(true);
    const topOn = lum();
    let topDiff = 0;
    for (let i = 0; i < topOn.L.length; i++) {
      if (Math.abs(topOn.L[i] - topOff.L[i]) > 8) topDiff++;
    }
    const topPct = (100 * topDiff) / topOn.L.length;
    add(R4, "…and the plants are still there SEEN FROM DIRECTLY ABOVE, which is " +
      "what the third, horizontal plane exists for — two crossed verticals go " +
      "edge-on in plan and vanish",
      "> 2% of pixels change in top view", `${topPct.toFixed(1)}%`, topPct > 2);

    view.scene.remove(surf.mesh); surf.dispose();
    view.scene.remove(plants.group); plants.dispose();
  }

  // ============================================================== GROUP R5
  // Plan mode's overlay walks straight into the float32 trap R1 is about, and
  // in a form that is HARDER to see: a quantised terrain mesh looks like coarse
  // ground, but a quantised ring looks like a ring. It would still be selectable,
  // still exportable, and its rendered outline would simply stop describing the
  // cells the leveller was about to move.
  const R5 = "R5 · the plan overlay draws rings without world coordinates in a buffer";
  {
    const surf = new Surface(dem, { verticalExaggeration: 2.5 });
    view.scene.add(surf.mesh);
    view.pickTarget = surf.mesh;

    const overlay = new PlanOverlay(dem, { verticalExaggeration: 2.5, pixelRatio: 2 });
    view.scene.add(overlay.group);

    // A ring whose vertices are a QUARTER of a metre apart in northing — the
    // spacing float32 at 7.74e6 cannot hold, since its ULP there is 0.5 m.
    const x0 = dem.originX + 20, y0 = dem.originY + 20;
    const ring = [];
    for (let i = 0; i < 16; i++) ring.push([x0 + i * 0.25, y0 + i * 0.25]);
    for (let i = 15; i >= 0; i--) ring.push([x0 + i * 0.25 + 4, y0 + i * 0.25 + 8]);
    const set = new PlanSet();
    const region = set.add(ring, { level_m: 78 });
    overlay.setRegions(set.regions, region.id);

    add(R5, "the UTM origin rides on the overlay GROUP, exactly as it does on the " +
      "terrain mesh — not on any vertex",
      `${dem.originX} / ${dem.originY}`,
      `${overlay.group.position.x} / ${overlay.group.position.y}`,
      overlay.group.position.x === dem.originX && overlay.group.position.y === dem.originY);

    {
      // Every buffer the overlay produced, checked as one.
      let maxAbs = 0, vertices = 0;
      overlay.group.traverse((o) => {
        const g = /** @type {any} */ (o).geometry;
        if (!g || !g.getAttribute) return;
        const a = g.getAttribute("position");
        if (!a) return;
        for (let i = 0; i < a.count; i++) {
          maxAbs = Math.max(maxAbs, Math.abs(a.getX(i)), Math.abs(a.getY(i)));
          vertices++;
        }
      });
      const span = Math.max(dem.ncols, dem.nrows) * dem.cell;
      add(R5, "…so every X and Y in every buffer it built — outlines, handles and " +
        "the design plate — is LOCAL, inside the tile's own span",
        `< ${span} m across ${vertices} vertices`, `max |xy| = ${maxAbs.toFixed(2)} m`,
        vertices > 0 && maxAbs < span);
    }

    {
      // The symptom R1 measures, on the overlay's own geometry: 0.25 m steps
      // survive as 0.25 m steps.
      let line = null;
      overlay.group.traverse((o) => {
        if (!line && o.type === "LineLoop") line = /** @type {any} */ (o);
      });
      const a = line.geometry.getAttribute("position");
      const ys = new Set();
      for (let i = 0; i < a.count; i++) ys.add(a.getY(i));
      add(R5, "…and a ring traced at the DEM's own 0.25 m keeps every vertex " +
        "distinct, where a world-baked buffer would collapse them in pairs onto " +
        "a half-metre grid",
        `${ring.length} distinct northings`, `${ys.size} distinct`,
        ys.size === ring.length);
    }

    add(R5, "vertical exaggeration rides on the group as scale.z, so the geometry " +
      "always holds true metres and nothing is rebuilt when the slider moves",
      "scale.z = 2.5, then 5", `${overlay.group.scale.z}, then ` +
      `${(overlay.setExaggeration(5), overlay.group.scale.z)}`,
      overlay.group.scale.z === 5);
    overlay.setExaggeration(2.5);

    {
      // The plate sits at the DESIGN level and the outline is DRAPED on the
      // ground, and the gap between them is the earthwork. If the plate were
      // draped too, the whole cut/fill reading in the viewport would vanish.
      let plate = null;
      overlay.group.traverse((o) => { if (!plate && o.type === "Mesh") plate = /** @type {any} */ (o); });
      add(R5, "the design plate sits at the region's level_m while the outline is " +
        "draped on the ground — the gap between them is the cut or the fill, " +
        "standing in the viewport before any earth moves",
        "plate z ≈ 78 m", `${plate.position.z.toFixed(2)} m`,
        Math.abs(plate.position.z - 78) < 0.1);
    }

    {
      // Drawn over the terrain rather than into it: a depth tie at every pixel
      // is the shimmer this project already fixed once on the wireframe.
      let all = true, n = 0;
      overlay.group.traverse((o) => {
        const m = /** @type {any} */ (o).material;
        if (!m) return;
        n++;
        if (m.depthTest !== false || m.depthWrite !== false) all = false;
      });
      add(R5, "…and every overlay material has depth testing OFF, so a ring lying " +
        "exactly in the surface cannot tie with it per fragment and shimmer",
        `${n} materials, all depthTest off`, all ? `${n} of ${n}` : "at least one on",
        n > 0 && all);
    }

    {
      // ⚠️ THE LOCK ITSELF. Plan mode's whole claim is that a click on the
      // terrain means a point on the map, and that holds only while the camera
      // cannot be tilted or un-parallel-projected. Asserted structurally, so
      // nothing can quietly re-enable either route later.
      // seconds: 0 so the move is a snap — this suite drives renders by hand and
      // never ticks the eased camera animation the app gets from its rAF loop.
      view.setOrbitLocked(true, { seconds: 0 });
      const lockedOrtho = view.orthographic;
      const pitchAfter = view._cam.pitch;
      view.setOrthographic(false);
      const stillOrtho = view.orthographic;
      const refusedAxis = view.setAxisView("front") === false;
      add(R5, "locking the camera to plan takes it to top, forces orthographic, " +
        "REFUSES perspective, and refuses every axis view but Top — a converging " +
        "plan is not a plan",
        "pitch ≈ 90°, ortho, ortho after refusal, front refused",
        `pitch ${((pitchAfter * 180) / Math.PI).toFixed(1)}°, ` +
        `${lockedOrtho ? "ortho" : "persp"}, ${stillOrtho ? "ortho" : "persp"}, ` +
        `${refusedAxis ? "front refused" : "front taken"}`,
        lockedOrtho && stillOrtho && refusedAxis && pitchAfter > 1.55);
    }

    {
      // Finally: the rings actually reach the framebuffer in the view the mode
      // locks to. Everything above could hold with the overlay invisible.
      aim(surf, { yaw: 0, pitch: 1.5533, dist: 22 });
      const st = view.getCameraState();
      st.target[0] = x0 + 2;      // the region's own centre, at the surface's z
      st.target[1] = y0 + 14;
      view.setCameraState(st, 0);

      overlay.setVisible(false);
      const off = lum();
      overlay.setVisible(true);
      const on = lum();
      // Counted on the OUTLINE, not the plate: the fill is deliberately faint
      // (annotation, not data), while the ink lines and handles are a signal
      // nothing else in the frame produces.
      let darkened = 0;
      for (let i = 0; i < on.L.length; i++) if (off.L[i] - on.L[i] > 30) darkened++;
      add(R5, "…and in the top orthographic view Plan mode locks to, the ring is " +
        "actually ON SCREEN — the drawing surface shows the drawing",
        "> 2 000 pixels of ink", `${darkened} pixels`, darkened > 2000);
    }

    view.setOrbitLocked(false);
    view.setOrthographic(false);
    view.scene.remove(overlay.group); overlay.dispose();
    view.scene.remove(surf.mesh); surf.dispose();
  }

  // ============================================================== GROUP R6
  // renderAt and the offline capture path.
  //
  // WHY THESE ARE HERE. Every figure on the A1 poster and every frame of the
  // 45 s master now comes out of renderAt, and its two failure modes are both
  // silent: a stretched image still looks like terrain, and a frame sequence
  // that quietly renders 1351 frames still plays — it just stutters once per
  // lap. Neither is visible in a screenshot. Both are one assertion away.
  {
    const R6 = "R6 · renderAt and the offline capture path";
    const surf = new Surface(dem, { verticalExaggeration: 2.5 });
    view.scene.add(surf.mesh);
    aim(surf, CAM_MID);

    const before = { dpr: view.renderer.getPixelRatio(), aspect: view.camera.aspect };
    const beforeSize = new THREE.Vector2();
    view.renderer.getSize(beforeSize);

    /** Bounding box of everything that is not the white stage, normalised 0..1. */
    const silhouette = (cv) => {
      const g = /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d"));
      const p = g.getImageData(0, 0, cv.width, cv.height).data;
      let x0 = cv.width, x1 = -1, y0 = cv.height, y1 = -1;
      for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
          const i = (y * cv.width + x) * 4;
          const L = 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
          if (L > SKY) continue;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      return x1 < 0 ? null : { w: (x1 - x0 + 1) / cv.width, h: (y1 - y0 + 1) / cv.height };
    };

    const a = view.renderAt(400, 400);
    const b = view.renderAt(800, 400);

    add(R6, "renderAt returns exactly the pixel size it was asked for",
      "400x400 and 800x400", `${a.width}x${a.height} and ${b.width}x${b.height}`,
      a.width === 400 && a.height === 400 && b.width === 800 && b.height === 400);

    const afterSize = new THREE.Vector2();
    view.renderer.getSize(afterSize);
    add(R6, "…and puts the live view back exactly as it found it, so a capture " +
      "cannot leave the interface at figure size",
      `${beforeSize.x}x${beforeSize.y}, dpr ${before.dpr}, aspect ${before.aspect}`,
      `${afterSize.x}x${afterSize.y}, dpr ${view.renderer.getPixelRatio()}, aspect ${view.camera.aspect}`,
      afterSize.x === beforeSize.x && afterSize.y === beforeSize.y &&
      view.renderer.getPixelRatio() === before.dpr && view.camera.aspect === before.aspect);

    // ⚠️ THE STRETCH TEST, and the reason this group exists. The orthographic
    // frustum is halfW = halfH * aspect, so doubling the frame's width must show
    // MORE WORLD, not the same world made wider. A fixed object therefore keeps
    // its normalised HEIGHT and halves its normalised WIDTH. The failure mode —
    // growing the buffer without updating the aspect — keeps the normalised
    // width the same instead, and produces exactly the distorted axonometric
    // that reached the poster before this existed.
    const sa = silhouette(a), sb = silhouette(b);
    if (sa && sb) {
      add(R6, "doubling the frame width shows more world rather than stretching " +
        "it — the terrain keeps its height in the frame",
        "height ratio 1.00 ±0.02", (sb.h / sa.h).toFixed(3),
        Math.abs(sb.h / sa.h - 1) < 0.02);
      add(R6, "…and takes half the width, because the frustum followed the aspect",
        "width ratio 0.50 ±0.03", (sb.w / sa.w).toFixed(3),
        Math.abs(sb.w / sa.w - 0.5) < 0.03);
    } else {
      add(R6, "the terrain is visible in the captured frame", "a silhouette",
        "nothing but stage", false);
    }

    let threw = false;
    try { view.renderAt(view.renderer.capabilities.maxTextureSize + 1, 64); }
    catch { threw = true; }
    add(R6, "…and refuses a size the GPU cannot allocate, rather than returning " +
      "an empty frame that looks like a render",
      "throws", threw ? "throws" : "returned something", threw);

    // ---- the capture loop -------------------------------------------------
    const film = new FixedStepClock({ fps: 30, duration: 45 });
    add(R6, "45.000 s at 30 fps is 1350 frames — the number the whole master " +
      "rests on", 1350, film.totalFrames, film.totalFrames === 1350);

    const clk = new FixedStepClock({ fps: 30, duration: 0.5 });
    const seen = [];
    const times = await renderSequence({
      view, clock: clk, width: 120, height: 80,
      write: (i, cv) => { seen.push({ i, w: cv.width, h: cv.height }); },
    });

    add(R6, "renderSequence renders one frame per frame of the loop, in order",
      `${clk.totalFrames} frames, in order`,
      `${seen.length} frames, ${seen.every((s, i) => s.i === i) ? "in order" : "OUT OF ORDER"}`,
      seen.length === clk.totalFrames && seen.every((s, i) => s.i === i));

    // ⚠️ Frame `total` IS frame 0 of the next lap. Rendering both doubles the
    // seam and the film hitches once every 45 seconds — visible, and maddening
    // to diagnose from the finished file.
    const lastExpected = (clk.totalFrames - 1) / 30;
    add(R6, "…ending one frame BEFORE the duration, because the last frame and " +
      "frame 0 are neighbours in the loop, not the same instant",
      lastExpected.toFixed(5), times[times.length - 1].toFixed(5),
      Math.abs(times[times.length - 1] - lastExpected) < 1e-9);

    let maxGap = 0;
    for (let i = 1; i < times.length; i++) {
      maxGap = Math.max(maxGap, Math.abs(times[i] - times[i - 1] - 1 / 30));
    }
    const unique = new Set(times.map((t) => t.toFixed(9))).size;
    add(R6, "…at an exactly even 1/30 s, with no repeated or skipped instant",
      "spacing error < 1e-9 s, no duplicates",
      `${maxGap.toExponential(1)} s, ${unique}/${times.length} distinct`,
      maxGap < 1e-9 && unique === times.length);

    const seam = await seamPair(view, clk, 120, 80);
    add(R6, "the seam pair is the LAST rendered frame against frame 0 — the two " +
      "the loop actually joins",
      `frame ${clk.totalFrames - 1} and frame 0`, `frame ${seam.lastFrame} and frame 0`,
      seam.lastFrame === clk.totalFrames - 1);

    const self = frameDiff(seam.first, seam.first);
    add(R6, "…and frameDiff reports 0 for a frame against itself, so a seam " +
      "measurement of 0 means identical rather than broken",
      "0", self.toFixed(8), self === 0);

    let guard = "";
    try {
      await renderSequence({ view, clock: new FixedStepClock({ fps: 30 }), width: 8, height: 8, write: () => {} });
    } catch (e) { guard = String(e.message || e); }
    add(R6, "…and a clock with no duration is refused rather than looping forever",
      "throws", guard || "returned", /no duration/.test(guard));

    view.scene.remove(surf.mesh); surf.dispose();
  }

  // ============================================================== GROUP R7
  // Standing water. A second InstancedMesh built from scratch every time the
  // ground or the rainfall changes, which makes it exactly the kind of buffer
  // that world coordinates creep back into — the failure R1 exists for.
  {
    const R7 = "R7 · standing water is drawn where the analysis says it stands";
    const surf = new Surface(dem, { verticalExaggeration: 2.5 });
    view.scene.add(surf.mesh);
    aim(surf, CAM_MID);
    const dry = (() => { const { L } = lum(); return L; })();

    const field = new WaterField(dem, { verticalExaggeration: 2.5 });
    view.scene.add(field.group);
    const res = pondWater(dem, 0.002);
    field.setPonding(res);

    add(R7, "the UTM origin rides on the water group's transform, never in the "
      + "instance buffer — the rule that cost this project three phases",
      `${dem.originX} / ${dem.originY}`,
      `${field.group.position.x} / ${field.group.position.y}`,
      field.group.position.x === dem.originX && field.group.position.y === dem.originY);

    const arr = /** @type {THREE.InstancedMesh} */ (field.mesh).instanceMatrix.array;
    let maxT = 0;
    for (let k = 0; k < field.count; k++) {
      maxT = Math.max(maxT, arr[k * 16 + 12], arr[k * 16 + 13]);
    }
    const span = dem.ncols * dem.cell;
    add(R7, "…so every instance translation is a LOCAL coordinate inside the tile",
      `≤ ${span} m`, `${maxT.toFixed(2)} m`, maxT > 0 && maxT <= span + 1);

    // The blocks must correspond to the analysis, not to a redrawing of it.
    let wet = 0;
    for (let i = 0; i < res.depth.length; i++) if (res.depth[i] > 0.001) wet++;
    add(R7, "one block per cell the ponding layer says is wet — the picture is "
      + "the analysis, not a second opinion about it",
      `${wet} blocks`, `${field.count} blocks`, field.count === wet && wet > 0);

    const wetPix = (() => { const { L } = lum(); return L; })();
    let changed = 0, terrain = 0;
    for (let i = 0; i < wetPix.length; i++) {
      if (dry[i] > SKY) continue;
      terrain++;
      if (Math.abs(dry[i] - wetPix[i]) > 2) changed++;
    }
    add(R7, "…and they are actually visible on the terrain rather than hidden "
      + "inside it, which a depth-tested translucent block would be",
      "> 0.5% of terrain pixels", `${(100 * changed / terrain).toFixed(1)}%`,
      changed / terrain > 0.005);

    add(R7, "water opts out of the grid's fog, as the terrain and its line work do",
      "fog: false", String(field.material.fog), field.material.fog === false);

    // ⚠️ THE CASE THE WHOLE LAYER IS FOR. Level the ground and the water has
    // nowhere to stand — the blocks must go, not merely thin out.
    const flat = dem.clone();
    let s = 0, k = 0;
    for (const v of flat.z) if (Number.isFinite(v)) { s += v; k++; }
    flat.z.fill(s / k);
    const flatField = new WaterField(flat, { verticalExaggeration: 2.5 });
    flatField.setPonding(pondWater(flat, 0.002));
    add(R7, "a surface levelled to a datum draws NO water at all — there is "
      + "nowhere for a block to stand, which is the argument in one frame",
      "0 blocks", `${flatField.count} blocks`, flatField.count === 0);
    flatField.dispose();

    field.setPonding(null);
    add(R7, "…and clearing the layer removes the blocks rather than leaving "
      + "stale water on ground that has since been reshaped",
      "0 blocks", `${field.count} blocks`, field.count === 0);

    {
      // ⚠️ THE WATER MUST STAND ON THE GROUND AS DRAWN, NOT ON THE DEM. Drawn
      // per cell while the terrain stands in blocks, the ponds were a fine
      // mosaic over a coarse one — sunk into every rising step and hanging off
      // every falling one.
      const ponding = pondWater(dem, 0.005);
      const w2 = new WaterField(dem, { verticalExaggeration: 2.5 });
      w2.setPonding(ponding);
      const widths = [];
      for (const k of [1, 2, 4, 8]) {
        const vox = new VoxelField(dem, { verticalExaggeration: 2.5, blockCells: k });
        w2.setBlocks({ cells: k, baseZ: vox.baseZ, quantum: vox.voxelHeight });
        const mm2 = new THREE.Matrix4(), pp = new THREE.Vector3();
        const qq = new THREE.Quaternion(), ss = new THREE.Vector3();
        let footprint = 0, sunk = 0, floating = 0;
        // Terrain tops, keyed by centre. voxels.js writes a CENTRED box, so its
        // top is position.z + scale.z / 2 — reading it as base-at-zero (which is
        // water.js's convention, not voxels') reports every block a whole cube
        // out and looks exactly like a real bug.
        const tops = new Map();
        for (let i = 0; i < vox.mesh.count; i++) {
          vox.mesh.getMatrixAt(i, mm2); mm2.decompose(pp, qq, ss);
          tops.set(`${pp.x.toFixed(2)},${pp.y.toFixed(2)}`, pp.z + ss.z / 2);
        }
        for (let i = 0; i < (w2.mesh ? w2.mesh.count : 0); i++) {
          w2.mesh.getMatrixAt(i, mm2); mm2.decompose(pp, qq, ss);
          footprint = ss.x;
          const top = tops.get(`${pp.x.toFixed(2)},${pp.y.toFixed(2)}`);
          if (top === undefined) continue;
          if (pp.z - top < -1e-3) sunk++;
          if (pp.z - top > 1e-3) floating++;
        }
        widths.push({ k, footprint, blockWidth: vox.blockWidth, sunk, floating,
          blocks: w2.mesh ? w2.mesh.count : 0 });
        vox.dispose?.();
      }
      add(R7, "the water follows the terrain's own block size — a pond drawn per "
        + "DEM cell over ground standing in 2 m blocks is two drawings of one "
        + "place at two resolutions",
        "footprint === block width at 1, 2, 4 and 8 cells",
        widths.map((x) => `${x.footprint}/${x.blockWidth}`).join(" "),
        widths.every((x) => Math.abs(x.footprint - x.blockWidth) < 1e-6));
      add(R7, "…and every block of it rests exactly ON the terrain block it "
        + "stands on, because voxels.js QUANTISES a block's top and water put at "
        + "the block's mean elevation is inside the solid",
        "0 sunk, 0 floating at every block size",
        widths.map((x) => `${x.sunk}/${x.floating}`).join(" "),
        widths.every((x) => x.sunk === 0 && x.floating === 0));
      add(R7, "…and coarsening the blocks really does redraw it, so the check "
        + "above is not passing on an unchanged field",
        "fewer blocks as they coarsen",
        widths.map((x) => x.blocks).join(" → "),
        widths[0].blocks > widths[3].blocks && widths[3].blocks > 0);
      w2.dispose();
    }

    view.scene.remove(field.group); field.dispose();
    view.scene.remove(surf.mesh); surf.dispose();
  }

  // ══ R8 ═══════════════════════════════════════════════════════════════════
  // The two scales must not draw the same ground twice. Group Z pins the cell
  // arithmetic headless; this is the part only pixels can answer — whether the
  // opening is actually open, and whether the patch actually fills it.
  const R8 = "R8 · THE CONTEXT TILE STOPS WHERE THE PATCH BEGINS";
  {
    const ctxDem = DEM.fromRaw(loadGeoTIFF(await fetchTile("orndalen_2024_4m.tif"), { name: "ctx" }));
    const EX = 2.5;
    const ctx = new Surface(ctxDem, { verticalExaggeration: EX });
    const patch = new Surface(dem, { verticalExaggeration: EX });
    view.scene.add(ctx.mesh); view.scene.add(patch.mesh);

    const before = ctx.geometry.getIndex().count / 3;
    ctx.setHole(DEM.nestHole(ctxDem, dem));
    const after = ctx.geometry.getIndex().count / 3;
    add(R8, "cutting the opening removes exactly the quads that touch it — the " +
      "16 × 16 nest plus the half-cell rim, because the patch edge runs along " +
      "context CELL EDGES while the context's vertices sit at cell CENTRES",
      `${17 * 17 * 2} triangles`, `${before - after}`, before - after === 17 * 17 * 2);

    {
      const ix = ctx.geometry.getIndex().array, nc = ctxDem.ncols, h = ctx.hole;
      let intruding = 0;
      for (let i = 0; i < ix.length; i++) {
        const r = Math.trunc(ix[i] / nc), c = ix[i] % nc;
        if (r >= h.r0 && r <= h.r1 && c >= h.c0 && c <= h.c1) intruding++;
      }
      const wx = ctx.wire.geometry.getIndex().array;
      let wireIn = 0;
      for (let i = 0; i < wx.length; i++) {
        const r = Math.trunc(wx[i] / nc), c = wx[i] % nc;
        if (r >= h.r0 && r <= h.r1 && c >= h.c0 && c <= h.c1) wireIn++;
      }
      add(R8, "…and NEITHER the mesh nor the lattice reaches into it — the " +
        "lattice keeps its own index over the shared vertices, so cutting only " +
        "the triangles would leave a wireframe grid hanging in the opening",
        "0 mesh and 0 lattice vertices inside",
        `${intruding} mesh, ${wireIn} lattice`, intruding === 0 && wireIn === 0);
    }

    // Looking straight down at the patch: with the patch hidden the opening must
    // show sky, and with it drawn the sky must be gone. One without the other
    // proves nothing — a hole nothing fills, or a fill over an uncut context.
    aim(patch, { yaw: 0, pitch: 89, dist: 140 });
    const middleSky = () => {
      const { L, w, h } = lum();
      let sky = 0, tot = 0;
      for (let y = Math.floor(h * 0.35); y < h * 0.65; y++) {
        for (let x = Math.floor(w * 0.35); x < w * 0.65; x++) { tot++; if (L[y * w + x] > SKY) sky++; }
      }
      return (100 * sky) / tot;
    };
    patch.mesh.visible = false; patch.wire.visible = false;
    const open = middleSky();
    patch.mesh.visible = true; patch.wire.visible = true;
    const filled = middleSky();
    add(R8, "the opening is really open — with the patch hidden, the context " +
      "draws nothing over the footprint",
      "> 50% sky", `${open.toFixed(1)}%`, open > 50);
    add(R8, "…and drawing the patch closes it again, so the cut traded the " +
      "overlap for a fill rather than for a hole",
      "< 5% sky, and far below the open case",
      `${filled.toFixed(2)}%`, filled < 5 && filled < open / 10);

    {
      // ⚠️ THE ABUTMENT IS NOT EXACT, AND IT CANNOT BE. The patch boundary runs
      // along context CELL EDGES; the context surface's vertices are at cell
      // CENTRES. So the two can meet either with the coarse mesh overlapping the
      // patch rim by half a cell, or stopping half a cell short of it — there is
      // no third option without shearing the coarse grid. Stopping short is the
      // right side to err on: the complaint being fixed is coarse ground drawn
      // OVER ground the patch resolves, and half a context cell here is 2 m on a
      // 1 024 m backdrop, 0.2% of the frame at the scale it is ever seen.
      // Asserted geometrically because the pixel figure above moves with framing.
      const x0 = dem.originX, y0 = dem.originY;
      const x1 = x0 + dem.ncols * dem.cell, y1 = y0 + dem.nrows * dem.cell;
      const ix = ctx.geometry.getIndex().array, nc = ctxDem.ncols;
      let over = 0, gap = 0;
      for (let i = 0; i < ix.length; i++) {
        const [x, y] = ctxDem.xy(Math.trunc(ix[i] / nc), ix[i] % nc);
        if (x > x0 && x < x1 && y > y0 && y < y1) over++;
        else if (x > x0 - ctxDem.cell && x < x1 + ctxDem.cell
              && y > y0 - ctxDem.cell && y < y1 + ctxDem.cell) {
          gap = Math.max(gap, Math.min(
            Math.min(Math.abs(x - x0), Math.abs(x - x1)),
            Math.min(Math.abs(y - y0), Math.abs(y - y1))));
        }
      }
      add(R8, "no context vertex survives INSIDE the patch footprint — the coarse " +
        "tile never again draws ground the fine one resolves, which was the whole " +
        "complaint",
        "0 vertices over the patch", `${over}`, over === 0);
      add(R8, "…and it stops at most half a context cell short of the edge, which " +
        "is the closest a centre-sampled grid can abut a boundary drawn on its " +
        "cell edges — 2 m on a 1 024 m backdrop",
        `≤ ${(ctxDem.cell / 2).toFixed(1)} m`, `${gap.toFixed(2)} m`,
        gap <= ctxDem.cell / 2 + 1e-6);
    }

    view.scene.remove(ctx.mesh); ctx.dispose();
    view.scene.remove(patch.mesh); patch.dispose();
  }

  // ══ R9 ═══════════════════════════════════════════════════════════════════
  // What the scene actually draws for vegetation: stems.js.
  const R9 = "R9 · VEGETATION AS STEMS — structure, and what it must not claim";
  {
    const surf = new Surface(dem, { verticalExaggeration: 2.5 });
    view.scene.add(surf.mesh);
    const field = new StemField(dem, { verticalExaggeration: 2.5 });
    view.scene.add(field.group);

    const axes = speciesAxes(dem);
    const A = assemble(axes);
    field.update(A.codes);

    add(R9, "the UTM origin rides on the GROUP, never in an instance buffer — " +
      "the rule that cost this project three phases, and a fresh instance set " +
      "is exactly where world coordinates creep back in",
      `${dem.originX} / ${dem.originY}`,
      `${field.group.position.x} / ${field.group.position.y}`,
      field.group.position.x === dem.originX && field.group.position.y === dem.originY);

    {
      const span = dem.ncols * dem.cell;
      let outside = 0;
      const mm = new THREE.Matrix4(), v = new THREE.Vector3();
      for (const m of field.meshes) {
        for (let i = 0; i < m.count; i++) {
          m.getMatrixAt(i, mm);
          v.setFromMatrixPosition(mm);
          if (v.x < -1 || v.x > span + 1 || v.y < -1 || v.y > span + 1) outside++;
        }
      }
      add(R9, "…so every stem's translation is LOCAL to the tile, inside its " +
        "own span, where float32 still resolves a quarter of a metre",
        "0 outside 0–64 m", `${outside} outside`, outside === 0);
    }

    {
      // ⚠️ THE RULE plants.js ESTABLISHED, CARRIED OVER: a stem may appear or
      // vanish, never move. It is what makes the density difference between
      // strata possible — a sparse stratum draws a stable SUBSET of the same
      // candidates rather than a fresh scatter, so switching species pulls
      // stems out of the drawing without sliding the ones that stay.
      // ⚠️ THE SET TO TEST AGAINST IS THE CANDIDATE POOL, NOT THE STEMS DRAWN
      // A MOMENT AGO. Thinning means a stem legitimately APPEARS when its cell
      // moves to a denser stratum — that is the "may appear or vanish" half of
      // the rule, and comparing against the previous frame's drawn set counts
      // every legal appearance as a violation. It measured 1 194 of 8 176 and
      // the code was right. What must never happen is a drawn position that is
      // not one of the seeded candidates' own positions.
      const pool = new Set();
      for (let k = 0; k < field.count; k++) {
        pool.add(`${field.localX[k].toFixed(4)},${field.localY[k].toFixed(4)}`);
      }
      const mm = new THREE.Matrix4(), v = new THREE.Vector3();
      const strayCount = () => {
        let stray = 0, seen = 0;
        for (const m of field.meshes) {
          for (let i = 0; i < m.count; i++) {
            m.getMatrixAt(i, mm); v.setFromMatrixPosition(mm);
            seen++;
            if (!pool.has(`${v.x.toFixed(4)},${v.y.toFixed(4)}`)) stray++;
          }
        }
        return { stray, seen };
      };
      const surveyed = strayCount();
      const flat = dem.clone();
      let s = 0, k = 0;
      for (const q of flat.z) if (Number.isFinite(q)) { s += q; k++; }
      flat.z.fill(s / k);
      const flatA = assemble(speciesAxes(flat));
      field.update(flatA.codes);
      const levelled = strayCount();
      add(R9, "every stem drawn stands on a position seeded once at build time, " +
        "on the surveyed ground and on a completely different assemblage alike — " +
        "a stem may appear or vanish, never slide",
        "0 positions off the candidate pool",
        `${surveyed.stray} of ${surveyed.seen} surveyed, ` +
        `${levelled.stray} of ${levelled.seen} levelled`,
        surveyed.stray === 0 && levelled.stray === 0);
      add(R9, "…and the two states really are different, so the check above is " +
        "not passing by the layer quietly ignoring what it was given",
        "counts differ", `${surveyed.seen} vs ${levelled.seen}`,
        surveyed.seen !== levelled.seen);

      // The argument, in the new vocabulary: levelling leaves one stratum.
      const drawn = Array.from(field.drawn);
      add(R9, "…and a levelled surface leaves only the TALL HERB stratum " +
        "standing, because the lupine is what wins a plane — the collapse reads " +
        "as the drawing losing its ground layer, not as a change of icon",
        "only stratum 2 populated", `[${drawn.join(", ")}]`,
        drawn[2] > 0 && drawn[0] === 0 && drawn[1] === 0 && drawn[3] === 0);

      field.update(A.codes);
    }

    {
      const drawn = Array.from(field.drawn);
      add(R9, "on the surveyed patch all four strata stand, so the layer is a " +
        "gradient of structure rather than one mark repeated",
        "4 of 4 populated", `[${drawn.join(", ")}]`, drawn.every((v) => v > 0));
      add(R9, "…and the ground layer outnumbers the shrub layer by an order of " +
        "magnitude, which is the claim the densities encode: continuous cover " +
        "draws as many short strokes, an individual as one tall one",
        "ground > 10 × shrub", `${drawn[0]} vs ${drawn[3]}`, drawn[0] > 10 * drawn[3]);
    }

    {
      // Stature is a stated quantity in metres and must not ride the terrain's
      // exaggeration — the trap plants.js records, where a 0.36 m tussock stood
      // 0.9 m tall at 2.5× and stayed the same width.
      const h = (f) => {
        f.meshes[3].geometry.computeBoundingBox();
        const bb = f.meshes[3].geometry.boundingBox;
        return bb.max.z - bb.min.z;
      };
      const at1 = h(field);
      field.setExaggeration(5);
      const at5 = h(field);
      field.setExaggeration(2.5);
      add(R9, "stem HEIGHT ignores the terrain's vertical exaggeration, so the " +
        "stature stays the metres it claims however much the ground is stretched",
        "identical at 2.5× and 5×", `${at1.toFixed(4)} vs ${at5.toFixed(4)}`,
        Math.abs(at1 - at5) < 1e-6);
    }

    {
      // ⚠️ THE CHECK THE WHOLE GROUND-TICK DECISION EXISTS FOR. A vertical line
      // seen from directly above is a point, and plan mode LOCKS the camera to
      // top orthographic. Without a mark lying flat on the ground the layer
      // would be invisible in the one view the tool forces — which is how the
      // old billboard scatter failed, one representation earlier.
      aim(surf, { yaw: 0, pitch: 89.9, dist: 90 });
      field.group.visible = false;
      const off = lum();
      field.group.visible = true;
      const on = lum();
      let diff = 0;
      for (let i = 0; i < on.L.length; i++) if (Math.abs(on.L[i] - off.L[i]) > 8) diff++;
      const pct = (100 * diff) / on.L.length;
      add(R9, "the layer is still there SEEN FROM DIRECTLY ABOVE — the ground " +
        "tick at each stem turns the plan into a stem-density map, where the " +
        "stems alone would go edge-on and vanish",
        "> 2% of pixels change in top view", `${pct.toFixed(1)}%`, pct > 2);
    }

    {
      // ⚠️ THE CROWN MUST HAVE AREA IN THE PLANE IT IS READ IN, and this is the
      // check for a bug that cost nothing and drew nothing. The canopy circles
      // were built as open-ended cylinders — a wall with no thickness — which
      // draws a perfect circle in ELEVATION and presents its edge from directly
      // overhead: zero pixels, at every zoom, in the one view plan mode locks
      // the camera to. Nothing threw, the geometry was there, the instance count
      // was right, and the circles were simply invisible.
      //
      // Projected area onto XY is what distinguishes the two. An annulus has it;
      // a vertical wall has none.
      const g = field.meshes[3].geometry;
      const pos = g.getAttribute("position");
      const idx = g.getIndex();
      const hCrown = STRATA[3].h * 0.45;
      let area = 0;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c2 = new THREE.Vector3();
      for (let i = 0; i < idx.count; i += 3) {
        a.fromBufferAttribute(pos, idx.getX(i));
        b.fromBufferAttribute(pos, idx.getX(i + 1));
        c2.fromBufferAttribute(pos, idx.getX(i + 2));
        if (a.z < hCrown && b.z < hCrown && c2.z < hCrown) continue;   // not crown
        // Twice the signed area of the triangle projected onto XY.
        area += Math.abs((b.x - a.x) * (c2.y - a.y) - (c2.x - a.x) * (b.y - a.y)) / 2;
      }
      const disc = Math.PI * Math.pow(STRATA[3].h * STRATA[3].canopy, 2);
      add(R9, "the crown has real AREA seen from above — the canopy circles are " +
        "annuli lying in the ground plane, not cylinder walls standing on end, " +
        "which draw a perfect circle in elevation and nothing at all in plan",
        "> 4% of the crown disc", `${(100 * area / disc).toFixed(1)}%`,
        area / disc > 0.04);
    }

    {
      // ⚠️ MONO IS THE COMMITTED DEFAULT and the printed poster depends on it:
      // a field that came up coloured would put the tool, the A1 sheet and the
      // video in three different drawing languages.
      const chroma = (m, n) => {
        let c = 0;
        for (let i = 0; i < Math.min(m.count, n); i++) {
          const a = m.instanceColor;
          const r = a.getX(i), g = a.getY(i), b = a.getZ(i);
          if (Math.max(r, g, b) - Math.min(r, g, b) > 0.05) c++;
        }
        return c;
      };
      const monoInk = field.meshes.every((m) =>
        /** @type {any} */ (m.material).color.getHex() === STEM_INK);
      const monoChroma = field.meshes.reduce((s, m) => s + chroma(m, 300), 0);
      add(R9, "the drawing comes up in ONE INK, not in colour — the exhibition " +
        "poster prints black and white, and a default that had to be switched " +
        "back would put the tool, the sheet and the video in three languages",
        "ink material, 0 chromatic instances",
        `${monoInk ? "ink" : "not ink"}, ${monoChroma} chromatic`,
        monoInk && monoChroma === 0);

      field.setPalette("species");
      const colourChroma = field.meshes.reduce((s, m) => s + chroma(m, 300), 0);
      const whiteMat = field.meshes.every((m) =>
        /** @type {any} */ (m.material).color.getHex() === 0xffffff);
      add(R9, "…and switching to the species palette turns the material WHITE as " +
        "well as writing colours per instance — three multiplies the two, so " +
        "leaving the ink in place yields seven barely-separable darks, which " +
        "reads as the palette not working rather than as two colours multiplied",
        "white material, all sampled instances chromatic",
        `${whiteMat ? "white" : "not white"}, ${colourChroma} chromatic`,
        whiteMat && colourChroma > 0);

      {
        // The colours must be the RASTER'S, and must land on a species that
        // actually belongs to the stratum drawing them — otherwise the scatter
        // and the map of it disagree about the same seven classes.
        const PAL = CATEGORICAL.species.colours;
        const allowed = STRATUM_OF_SPECIES.reduce((m, st, code) => {
          (m[st] = m[st] || []).push(code); return m;
        }, /** @type {Record<number, number[]>} */ ({}));
        const unit = (v) => {
          const L = Math.hypot(v[0], v[1], v[2]) || 1;
          return [v[0] / L, v[1] / L, v[2] / L];
        };
        let wrong = 0, seen = 0;
        for (let st = 0; st < field.meshes.length; st++) {
          const m = field.meshes[st];
          for (let i = 0; i < Math.min(m.count, 300); i++) {
            const a = m.instanceColor;
            // Tone scales magnitude, so compare DIRECTION in rgb space.
            const q = unit([a.getX(i), a.getY(i), a.getZ(i)]);
            let best = -1, bd = Infinity;
            PAL.forEach((pc, ci) => {
              const t = unit(pc);
              const dd = (q[0] - t[0]) ** 2 + (q[1] - t[1]) ** 2 + (q[2] - t[2]) ** 2;
              if (dd < bd) { bd = dd; best = ci; }
            });
            seen++;
            if (!allowed[st] || !allowed[st].includes(best)) wrong++;
          }
        }
        add(R9, "…and every stem's colour is one of the species panel's own, on " +
          "a species that really belongs to the stratum drawing it — so the " +
          "scatter and the map of it cannot disagree about the same seven classes",
          "0 off-palette or out-of-stratum", `${wrong} of ${seen}`, wrong === 0);
      }

      {
        // Colour must not quietly replace the shading: a plant in a hollow is
        // still in a hollow.
        const spread = new Set();
        const m = field.meshes[2];
        for (let i = 0; i < Math.min(m.count, 400); i++) {
          const a = m.instanceColor;
          spread.add((a.getX(i) + a.getY(i) + a.getZ(i)).toFixed(2));
        }
        add(R9, "…and the sky-view occlusion survives into colour, so a stem in " +
          "a hollow is still drawn darker than one on an open rise — colour is " +
          "not a licence to stop drawing the ground it stands in",
          "> 8 distinct luminances in one species", `${spread.size}`,
          spread.size > 8);
      }
      field.setPalette("mono");
    }

    {
      // No alpha anywhere: the property that makes the whole class of cutout
      // defects unreachable, kept from the growth forms.
      let bad = 0;
      for (const m of field.meshes) {
        const mat = /** @type {any} */ (m.material);
        if (mat.map || mat.alphaTest > 0 || mat.transparent || mat.alphaToCoverage) bad++;
      }
      add(R9, "a stem is solid geometry with no alpha anywhere — no map, no " +
        "alphaTest, no transparency — so none of the cutout defects the " +
        "billboard scatter died of can reach this drawing",
        "0 of 4 materials", `${bad} of ${field.meshes.length}`, bad === 0);
    }

    view.scene.remove(field.group); field.dispose();
    view.scene.remove(surf.mesh); surf.dispose();
  }

  {
    // ⚠️ THE PLAN MUST BE NORTH-UP, and it was 180° out. With the camera on the
    // +Y side looking down and southward, screen "up" derives from world +Z
    // against that view direction and resolves to SOUTH, with east on the left.
    // Correct for an oblique view — the far distance belongs at the top of the
    // frame — and wrong for a plan, which disagreed with the pattern preview
    // beside it, with every exported figure, and with every plan drawing ever
    // made. Nothing threw and nothing looked broken; it was simply upside down.
    const surf = new Surface(dem, { verticalExaggeration: 1 });
    view.scene.add(surf.mesh);
    aim(surf, { yaw: 0, pitch: 0.6, dist: 120 });
    // ⚠️ seconds: 0. setAxisView EASES over 0.45 s by default, and projecting
    // straight afterwards measures the camera it was leaving rather than the one
    // it is going to — which reports the oblique view's quadrants and looks
    // exactly like the bug this checks for.
    view.setAxisView("top", { seconds: 0 });
    const box = surf.boundingBox();
    const c = box.getCenter(new THREE.Vector3());
    const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) / 4;
    /** Project a world point and say which screen quadrant it lands in. */
    const quad = (dx, dy) => {
      view.activeCamera.updateMatrixWorld();
      const p = new THREE.Vector3(c.x + dx, c.y + dy, c.z).project(view.activeCamera);
      return `${p.y > 0 ? "upper" : "lower"}-${p.x < 0 ? "left" : "right"}`;
    };
    const northWest = quad(-span, span);
    const northEast = quad(span, span);
    const southWest = quad(-span, -span);
    add("R2 · the surface renders legibly",
      "the Top view is NORTH-UP and EAST-RIGHT — a plan that is 180° out " +
      "disagrees with the pattern preview, every exported figure and every " +
      "plan drawing, while looking perfectly plausible",
      "NW upper-left, NE upper-right, SW lower-left",
      `NW ${northWest}, NE ${northEast}, SW ${southWest}`,
      northWest === "upper-left" && northEast === "upper-right"
        && southWest === "lower-left");
    view.scene.remove(surf.mesh); surf.dispose();
    view.orthographic = false;
  }

  // ══ R10 ══════════════════════════════════════════════════════════════════
  // The apron: the graded ring that carries the design patch out into the
  // context tile. Its whole job is that neither seam exists, which is precisely
  // the kind of property a render cannot show you — a crack of a few
  // centimetres at 1 km is sub-pixel until the camera drops to the ground.
  const R10 = "R10 · THE APRON — two surveys, two resolutions, no seam";
  {
    const ctxDem = DEM.fromRaw(loadGeoTIFF(await fetchTile("orndalen_2024_4m.tif"), { name: "ctx-ap" }));
    const EX = 2.5;
    const fit = apronFit(ctxDem, dem, 10);
    add(R10, "the buffer snaps to a width whose rim lands ON the context's " +
      "vertex lattice — the patch edge sits on a cell BOUNDARY and vertices sit " +
      "at cell CENTRES, so 8 or 16 m would leave the rim half a cell out with " +
      "nothing to meet",
      "10 m, on the lattice", `${fit.buffer} m, ok=${fit.ok}`,
      fit.ok && Math.abs(fit.buffer - 10) < 1e-9);

    const ctx = new Surface(ctxDem, { verticalExaggeration: EX });
    ctx.setHole(fit.hole);
    const patch = new Surface(dem, { verticalExaggeration: EX });
    const ap = new Apron(dem, ctxDem, { buffer: fit.buffer, verticalExaggeration: EX });

    {
      // ⚠️ THE INNER SEAM MUST BE EXACT, NOT CLOSE. The apron's boundary
      // vertices are the design surface's own, so any mismatch at all means the
      // lattice was regenerated rather than copied — which lands within a
      // rounding and opens a hairline crack all the way round.
      const A = ap.geometry.getAttribute("position");
      const P = patch.geometry.getAttribute("position");
      const nx = ap.xs.length, i0 = ap.i0, i1 = ap.i1, N = dem.nrows;
      let worst = 0, n = 0, posWorst = 0;
      const cmp = (i, j, r, c) => {
        worst = Math.max(worst, Math.abs(A.getZ(j * nx + i) - P.getZ(r * dem.ncols + c)));
        n++;
      };
      for (let k = 0; k < dem.ncols; k++) {
        // ⚠️ The apron's y INCREASES northward; a DEM's rows count SOUTHWARD
        // from the north edge. Comparing them index-for-index reports the whole
        // relief as a mismatch and looks exactly like a broken seam.
        cmp(i0 + k, i1, 0, k);
        cmp(i0 + k, i0, N - 1, k);
        cmp(i0, i0 + k, N - 1 - k, 0);
        cmp(i1, i0 + k, N - 1 - k, dem.ncols - 1);
        posWorst = Math.max(posWorst, Math.abs(ap.xs[i0 + k] - (k + 0.5) * dem.cell));
      }
      add(R10, "…so the inner seam is EXACT: every apron vertex on the patch " +
        "boundary carries the design surface's own height, to the bit",
        "0 m over 1 024 vertices", `${worst} m over ${n}`, worst === 0);
      add(R10, "…and sits at its own position too, because the middle of the " +
        "apron's axis is COPIED from the design lattice rather than recomputed",
        "0 m", `${posWorst} m`, posWorst === 0);
    }

    {
      // The outer seam is a T-junction by construction — the apron has far more
      // vertices along the rim than the context does — and is safe only because
      // each extra one lies ON the straight segment between two context
      // vertices. Sampling with the same triangle interpolation the surface
      // draws is what proves it.
      const A = ap.geometry.getAttribute("position");
      const nx = ap.xs.length, ny = ap.ys.length;
      const ox = dem.originX - ctxDem.originX, oy = dem.originY - ctxDem.originY;
      let worst = 0, n = 0;
      const rim = (i, j) => {
        const z = surfaceZ(ctxDem, ox + ap.xs[i], oy + ap.ys[j]) * EX;
        if (!Number.isFinite(z)) return;
        worst = Math.max(worst, Math.abs(A.getZ(j * nx + i) - z)); n++;
      };
      for (let i = 0; i < nx; i++) { rim(i, 0); rim(i, ny - 1); }
      for (let j = 0; j < ny; j++) { rim(0, j); rim(nx - 1, j); }
      add(R10, "…and the outer rim lies on the context surface to within a " +
        "hundredth of a millimetre, though it has sixteen times the vertices — " +
        "each extra one sits ON the segment between two context vertices",
        "< 1e-4 m", `${worst.toExponential(1)} m over ${n}`, worst < 1e-4);
    }

    {
      // ⚠️ THE CHECK THE SEAM MEASUREMENTS CANNOT MAKE. Orientation is not a
      // property any of them look at: the apron shipped with every one of its
      // normals pointing at the ground, FrontSide culled the whole ring from any
      // camera above it, and the inner seam still measured 0 m to the bit while
      // the thing was invisible. It was wound by copying surface.js, whose rows
      // run SOUTHWARD while this grid's run northward — the same indices over
      // mirrored geometry.
      const P = ap.geometry.getAttribute("position");
      const I = ap.geometry.getIndex();
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c2 = new THREE.Vector3();
      const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nrm = new THREE.Vector3();
      let up = 0, down = 0;
      for (let t = 0; t < I.count; t += 3) {
        a.fromBufferAttribute(P, I.getX(t));
        b.fromBufferAttribute(P, I.getX(t + 1));
        c2.fromBufferAttribute(P, I.getX(t + 2));
        ab.subVectors(b, a); ac.subVectors(c2, a); nrm.crossVectors(ab, ac);
        if (nrm.z > 0) up++; else down++;
      }
      add(R10, "every apron triangle faces the SKY, like the surfaces it joins — " +
        "wound the other way it is culled entirely and reads as simply absent, " +
        "which no seam measurement can detect",
        `${I.count / 3} up, 0 down`, `${up} up, ${down} down`, down === 0 && up > 0);
    }

    {
      // ⚠️ THE GROUND THE APRON IS STITCHED TO MOVES. Editing the edge of the
      // patch tears the seam and opens a hole in the one place the feature
      // exists to have none — silently, because the apron goes on being a
      // perfectly good description of where the boundary used to be.
      const A = ap.geometry.getAttribute("position");
      const P = patch.geometry.getAttribute("position");
      const nx = ap.xs.length, i0 = ap.i0, i1 = ap.i1, N = dem.nrows;
      const seam = () => {
        let worst = 0;
        const cmp = (i, j, r, c) =>
          { worst = Math.max(worst, Math.abs(A.getZ(j * nx + i) - P.getZ(r * dem.ncols + c))); };
        for (let k = 0; k < dem.ncols; k++) {
          cmp(i0 + k, i1, 0, k); cmp(i0 + k, i0, N - 1, k);
          cmp(i0, i0 + k, N - 1 - k, 0); cmp(i1, i0 + k, N - 1 - k, dem.ncols - 1);
        }
        return worst;
      };
      // Drop the whole western edge by a metre — the crudest possible version
      // of "the user painted near the boundary".
      for (let r = 0; r < dem.nrows; r++) {
        for (let c = 0; c < 6; c++) dem.z[r * dem.ncols + c] -= 1;
      }
      patch.updateAll();
      const torn = seam();
      ap.refresh();
      const healed = seam();
      for (let r = 0; r < dem.nrows; r++) {
        for (let c = 0; c < 6; c++) dem.z[r * dem.ncols + c] += 1;
      }
      patch.updateAll();
      ap.refresh();

      add(R10, "moving the patch's edge really does tear the seam, so the check " +
        "below is not passing on ground that never changed",
        "≈ 1 m step", `${torn.toFixed(3)} m`, torn > 0.9);
      add(R10, "…and refreshing the apron closes it EXACTLY, by re-solving the " +
        "blend against the ground as it now stands — rather than capping the " +
        "hole with a vertical skirt, which would put a cliff at the seam",
        "0 m", `${seam()} m`, healed === 0);
    }

    {
      // The point of the thing: it is a TRANSITION, not a flat collar.
      const steps = [];
      for (let i = 1; i <= ap.i0; i++) steps.push(ap.xs[i] - ap.xs[i - 1]);
      const monotone = steps.every((v, i) => i === 0 || v <= steps[i - 1] + 1e-9);
      add(R10, "the apron's rows grade from roughly the context's own cell size " +
        "at the rim down to the design's at the patch, so the mesh thins out the " +
        "way the data does rather than changing in one step",
        "monotonically finer inward, ending at 0.25 m",
        `${steps[0].toFixed(2)} m → ${steps[steps.length - 1].toFixed(2)} m`,
        monotone && steps[0] > 1 && steps[steps.length - 1] < 0.3);
      add(R10, "…and it stays cheap: a graded ring rather than a fine grid over " +
        "the whole buffer, which at 0.25 m would be 164 000 triangles",
        "< 40 000 triangles", `${ap.triangles.toLocaleString()}`,
        ap.triangles < 40000);
    }

    view.scene.remove(ctx.mesh); ctx.dispose();
    view.scene.remove(patch.mesh); patch.dispose();
    ap.dispose();
  }

  // ══ R11 ══════════════════════════════════════════════════════════════════
  // The selection outline. Phase 8C named this the render check worth writing
  // first and it was still unwritten when BOTH of its defects were reported by
  // eye on 2026-08-12 — the second time on this project that "not folded in"
  // turned out to mean "untested". Neither defect is visible to the kernel
  // suite: both are properties of a vertex buffer, and both look like a
  // perfectly good drawing.
  const R11 = "R11 · THE SELECTION OUTLINE — a boundary that closes, and stays on the ground";
  {
    const { SelectionOverlay } = await import("./selection-view.js");
    // A DEM that SLOPES in both axes. The flat teaching plane the tool opens on
    // hides every one of these checks, because on constant ground a staircase
    // and a drape are the same picture.
    const N = 16, CELL = 0.25;
    const sd = {
      nrows: N, ncols: N, cell: CELL, z: new Float32Array(N * N),
      // A real northing, so the origin-on-the-transform rule is exercised at the
      // magnitude where float32 actually bites — see R1.
      originX: 654942, originY: 7737700,
    };
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) sd.z[r * N + c] = 75 + c * 0.12 + r * 0.05;  // ≈ 26°
    }
    const block = new Uint8Array(N * N);
    for (let r = 4; r < 11; r++) for (let c = 4; c < 11; c++) block[r * N + c] = 1;

    const ov = new SelectionOverlay(sd);
    ov.setMask(block);
    const pos = () => ov._line.geometry.getAttribute("position").array;

    {
      // A 7×7 block has 28 boundary sides and 196 cell sides. Drawing them all
      // fills the selection with ink and hides the ground being judged.
      add(R11, "only the BOUNDARY is drawn — the sides of a selected cell whose " +
        "neighbour is not selected — not every edge of every selected cell, " +
        "which on a real rule is ~52 000 segments a quarter-metre apart and " +
        "reads as a solid fill over the very ground being judged",
        "28 segments for a 7×7 block", `${ov.count}`, ov.count === 28);
    }

    {
      // ⚠️⚠️ THE ONE THAT WAS SHIPPED. Every side used to be drawn at its own
      // cell's centre height, making each segment horizontal; neighbouring cells
      // sit at different heights, so the boundary met in plan and not in z and
      // broke into a floating staircase. Measured before the fix: 24 of 28
      // corners carried more than one z, with a 0.12 m break at each.
      const p = pos();
      const byXY = new Map();
      for (let i = 0; i < p.length; i += 3) {
        const k = `${p[i].toFixed(4)},${p[i + 1].toFixed(4)}`;
        if (!byXY.has(k)) byXY.set(k, new Set());
        byXY.get(k).add(p[i + 2].toFixed(6));
      }
      let split = 0, worst = 0;
      for (const zs of byXY.values()) {
        if (zs.size > 1) {
          split++;
          const a = [...zs].map(Number);
          worst = Math.max(worst, Math.max(...a) - Math.min(...a));
        }
      }
      add(R11, "every corner where two boundary sides meet carries exactly ONE " +
        "height, so the outline closes — sides drawn at their own cell's centre " +
        "height are each horizontal, meet in plan and not in z, and break the " +
        "boundary into a floating staircase on any sloping ground",
        "0 corners with two heights", `${split} of ${byXY.size}, worst ${worst.toFixed(3)} m`,
        split === 0);

      let sloped = 0, axis = 0, oneCell = 0;
      for (let s = 0; s < p.length / 6; s++) {
        const o = s * 6;
        if (Math.abs(p[o + 2] - p[o + 5]) > 1e-9) sloped++;
        const dx = Math.abs(p[o] - p[o + 3]), dy = Math.abs(p[o + 1] - p[o + 4]);
        if (dx < 1e-9 || dy < 1e-9) axis++;
        if (Math.abs(Math.max(dx, dy) - CELL) < 1e-6) oneCell++;
      }
      add(R11, "…and on sloping ground every segment SLOPES with it rather than " +
        "lying flat, which is the same property stated the other way round",
        "28 of 28 sloped", `${sloped} of ${p.length / 6}`, sloped === p.length / 6);
      add(R11, "…while staying axis-aligned in PLAN and exactly one cell long, so " +
        "draping the line did not quietly move it sideways",
        "28 axis-aligned, 28 one cell", `${axis} axis, ${oneCell} one-cell`,
        axis === p.length / 6 && oneCell === p.length / 6);
    }

    {
      // ⚠️ PER VERTEX, NOT PER FACE. rasterise() and maskFromRule() index like
      // dem.z — one entry per GRID POINT — so a cell is the square CENTRED on a
      // vertex. Outlining face corners instead lands the boundary half a cell
      // off, consistently, which looks like a rounding bug and is really a
      // confusion of two grids.
      const p = pos();
      let minX = Infinity;
      for (let i = 0; i < p.length; i += 3) minX = Math.min(minX, p[i]);
      // Column 4 is the westmost selected cell. surface.js centres vertex
      // (r,c) at ((c+0.5)·cell, …), so the cell centred on it spans
      // [4·cell, 5·cell] and its WEST side is at 4·cell. This row first
      // pinned 4·cell − half — the lattice selection-view.js itself assumed
      // until 2026-08-13, which drew the whole outline half a cell
      // north-west of the terrain — so the test agreed with the module and
      // both disagreed with the mesh. The pin is now the surface's lattice,
      // the one patch-view.js used from the start.
      const want = 4 * CELL;
      add(R11, "the boundary runs on cell EDGES, half a cell out from the vertex " +
        "lattice the mask is indexed on — outlining face corners instead puts " +
        "the whole selection half a cell off in a way that reads as a rounding bug",
        `${want.toFixed(3)} m`, `${minX.toFixed(3)} m`, Math.abs(minX - want) < 1e-6);
    }

    {
      // A hole's rim is a boundary by exactly the same test, and a selection
      // that draws its outer edge but not its holes is a lie about where the
      // modifier will act.
      const holed = Uint8Array.from(block);
      holed[7 * N + 7] = 0;
      const solid = ov.count;
      ov.setMask(holed);
      add(R11, "a hole inside the selection is outlined too — its rim is a " +
        "boundary by the same test, and a modifier will not act there",
        `${solid} + 4 = ${solid + 4}`, `${ov.count}`, ov.count === solid + 4);
      ov.setMask(block);
    }

    {
      // ⚠️⚠️ THE SECOND ONE THAT WAS SHIPPED, and the same shape as the apron's
      // torn seam above: geometry DERIVED from the surface, unable to ride the
      // dirty rect, and left out of refreshSurfaceOverlays(). Every modifier
      // moves ground under the outline, so after one use it described heights
      // that no longer existed — measured on the POI patch as 0.768 m of float
      // after a single bench, and reported as "the selection only works once".
      const onGround = () => {
        const p = pos();
        const northY = N * CELL;
        const cz = (R, C) => {
          let s = 0, n = 0;
          for (let r = R - 1; r <= R; r++) {
            if (r < 0 || r >= N) continue;
            for (let c = C - 1; c <= C; c++) {
              if (c < 0 || c >= N) continue;
              const v = sd.z[r * N + c];
              if (Number.isFinite(v)) { s += v; n++; }
            }
          }
          return n ? s / n : NaN;
        };
        let worst = 0;
        for (let i = 0; i < p.length; i += 3) {
          // Invert px = C·cell, py = northY − R·cell — the surface's lattice,
          // same as the pin above since the 2026-08-13 registration fix.
          const C = Math.round(p[i] / CELL);
          const R = Math.round((northY - p[i + 1]) / CELL);
          const zc = cz(R, C);
          if (Number.isFinite(zc)) worst = Math.max(worst, Math.abs(p[i + 2] - zc));
        }
        return worst;
      };
      const lift = Math.max(CELL * 0.02, 0.005);
      const fresh = onGround();
      // Drop the ground under the whole selection by a metre — the crudest
      // version of "a modifier ran while the selection was showing".
      for (let r = 4; r < 11; r++) for (let c = 4; c < 11; c++) sd.z[r * N + c] -= 1;
      const stale = onGround();
      ov.refresh();
      const healed = onGround();
      for (let r = 4; r < 11; r++) for (let c = 4; c < 11; c++) sd.z[r * N + c] += 1;
      ov.refresh();

      // ⚠️ THE DRIFT IS HALF THE EDIT, AND THAT IS THE RIGHT ANSWER. This row
      // was first written as "≈ 1 m adrift" and failed at 0.505 m — the test was
      // wrong, not the module. A boundary corner averages the cells on BOTH
      // sides of the line, so dropping 1 m inside the selection moves the corner
      // it sits on by 0.5 m. Guessing the threshold would have buried that.
      add(R11, "the outline really is left behind when the ground moves under " +
        "it, so the check below is not passing on terrain that never changed — " +
        "and it drifts by HALF the edit, because a boundary corner averages the " +
        "cells on both sides of the line",
        "≈ 0.5 m adrift", `${stale.toFixed(3)} m`, stale > 0.4 && stale < 0.6);
      // ⚠️ THE TOLERANCE IS SET BY float32, NOT BY TIDINESS. The positions land
      // in a float32 vertex buffer, and at a 75 m elevation the gap between
      // representable values is ~4.6e-6 m — so a 1e-6 tolerance fails on correct
      // geometry. R1's lesson at a smaller magnitude.
      const F32 = 1e-5;
      add(R11, "…and refreshing re-drapes it onto the surface as it now stands, " +
        "to the deliberate hair-lift and no further — every modifier in the tool " +
        "moves ground under a showing selection, so without this it describes a " +
        "surface that no longer exists and looks like a correct drawing",
        `${lift} m (the lift), ±1e-5 for float32`, `${healed.toFixed(6)} m`,
        Math.abs(healed - lift) < F32 && Math.abs(fresh - lift) < F32);

      // ⚠️ REFRESH RE-DRAPES, IT DOES NOT RE-SELECT. A rule reads the current
      // surface, so re-running it after an edit would pick different cells —
      // correct about the ground, and wrong to do unasked, because it silently
      // changes what the next modifier acts on.
      add(R11, "…and re-draping does NOT re-evaluate the rule: the same cells " +
        "stay selected after the ground moves, because what changed is the " +
        "height under the boundary, not the boundary",
        "28 segments still", `${ov.count}`, ov.count === 28);
    }

    {
      const empty = new Uint8Array(N * N);
      ov.setMask(empty);
      const none = ov.count;
      ov.setMask(null);
      add(R11, "an empty selection draws nothing and a null one clears — an " +
        "unusable rule must never leave the last answer on screen",
        "0 and 0", `${none} and ${ov.count}`, none === 0 && ov.count === 0);
    }

    ov.dispose();
  }

  // ══ R12 ══════════════════════════════════════════════════════════════════
  // The volume pins. Same family as the photo pins and the selection outline —
  // scene furniture placed against a DEM — so the same three properties have to
  // hold, and one more that is specific to labelling water.
  const R12 = "R12 · WATER-BODY PINS — what each hollow holds, on the hollow";
  {
    const { PondPins } = await import("./pond-view.js");
    const { fmtVolume } = await import("./hud.js");

    const bodies = [];
    for (let i = 0; i < 30; i++) {
      bodies.push({
        volume: 10 / (i + 1), area: 1 + i, full: i % 3 === 0,
        level: 40 + i * 0.1, z: 39.5 + i * 0.1,
        x: dem.originX + 5 + i, y: dem.originY + 5 + i,
      });
    }
    const pins = new PondPins(dem, { verticalExaggeration: 1 });

    {
      // ⚠️ NOT EVERY BODY GETS A PIN. A 2 mm event on the POI patch settles into
      // 235 bodies whose median is half a litre; a label on each is a wall of
      // text over the model that hides the four the design is about.
      pins.setBodies(bodies, { max: 12 });
      add(R12, "only the largest few are labelled, and the number left " +
        "unlabelled is REPORTED rather than dropped — a reader who has just " +
        "counted 235 bodies needs to know why the model carries twelve labels",
        "12 shown, 18 omitted", `${pins.count} shown, ${pins.omitted} omitted`,
        pins.count === 12 && pins.omitted === 18);
    }

    {
      // ⚠️ WORLD COORDINATES NEVER REACH A float32 BUFFER — R1's rule, which at
      // this site's northing quantises to 0.5 m and would move a pin half a
      // metre off the pond it names.
      let worst = 0;
      pins.group.traverse((o) => {
        const geo = /** @type {any} */ (o).geometry;
        if (!geo || !geo.getAttribute) return;
        const p = geo.getAttribute("position");
        if (!p) return;
        for (let i = 0; i < p.count; i++) {
          worst = Math.max(worst, Math.abs(p.getX(i)), Math.abs(p.getY(i)));
        }
      });
      const span = Math.max(dem.nrows, dem.ncols) * dem.cell;
      add(R12, "pin geometry is LOCAL — the UTM origin rides on the group " +
        "transform, where matrix maths is float64, rather than in a vertex buffer " +
        "that quantises to half a metre at this northing",
        `≤ ${span} m from the origin`, `${worst.toFixed(1)} m`, worst <= span);
      add(R12, "…and the origin is on the group, so the pins land on the tile",
        `${dem.originX} / ${dem.originY}`,
        `${pins.group.position.x} / ${pins.group.position.y}`,
        pins.group.position.x === dem.originX && pins.group.position.y === dem.originY);
    }

    {
      // ⚠️ A PIN KEEPS ONE HEIGHT AT EVERY EXAGGERATION. The stem divides by it
      // and the label does not scale, so stretching the drawing must not read as
      // the water getting deeper. Same invariant the photo pins hold, and the
      // one whose first test failed against the wrong baseline.
      const stemLen = () => {
        let len = 0;
        pins.group.traverse((o) => {
          if (o.type !== "LineSegments") return;
          const p = /** @type {any} */ (o).geometry.getAttribute("position");
          len = Math.max(len, Math.abs(p.getZ(1) - p.getZ(0)));
        });
        return len;
      };
      const at1 = stemLen();
      pins.setExaggeration(4);
      pins.setBodies(bodies, { max: 12 });
      const at4 = stemLen();
      pins.setExaggeration(1);
      pins.setBodies(bodies, { max: 12 });
      add(R12, "the stem divides by the exaggeration, so stem × exaggeration is " +
        "constant and a pin is the same height on screen at 1× and 4× — a stem " +
        "that grew with it would read as the pond getting deeper when only the " +
        "drawing was stretched",
        `${(at1 * 1).toFixed(4)} at both`, `${(at1 * 1).toFixed(4)} / ${(at4 * 4).toFixed(4)}`,
        Math.abs(at1 * 1 - at4 * 4) < 1e-4);
    }

    {
      // ⚠️ THE LEADER RISES FROM THE WATER SURFACE, NOT THE BED. A stem starting
      // at the bottom passes up THROUGH the water it is measuring and reads as
      // taller than the pond is deep — the exact misreading the label exists to
      // prevent.
      let base = null;
      pins.group.traverse((o) => {
        if (base !== null || o.type !== "LineSegments") return;
        const p = /** @type {any} */ (o).geometry.getAttribute("position");
        base = Math.min(p.getZ(0), p.getZ(1));
      });
      add(R12, "the leader starts at the body's WATER SURFACE, not at its bed — " +
        "a stem from the bottom passes up through the water it is measuring",
        `${bodies[0].level} (level), not ${bodies[0].z} (bed)`,
        `${base}`, Math.abs(base - bodies[0].level) < 1e-6);
    }

    {
      pins.setBodies(null);
      const cleared = pins.count;
      pins.setBodies([]);
      add(R12, "no bodies means no pins — rainfall switched off must not leave " +
        "the last event's labels standing on the model, where they read as current",
        "0 and 0", `${cleared} and ${pins.count}`, cleared === 0 && pins.count === 0);
    }

    {
      // ⚠️ THE UNIT IS THE FINDING. The patch's hollows are tiny; rounded to
      // whole litres the median body printed "0 L" — a real half-litre of
      // standing water reported as nothing at all.
      const cases = [[3.1218, "3.12 m³"], [0.0345, "35 L"], [0.0007, "0.7 L"],
        [0.00049, "0.49 L"], [173, "173.0 m³"]];
      const got = cases.map(([v]) => fmtVolume(/** @type {number} */(v)));
      const want = cases.map(([, s]) => s);
      add(R12, "a volume is printed in the unit a person would say it in, down " +
        "to fractions of a litre — the patch's hollows are small enough that " +
        "rounding to whole litres reports the median body as nothing at all",
        want.join(" · "), got.join(" · "), got.every((s, i) => s === want[i]));
    }

    pins.dispose();
  }

  // ══ R13 ══════════════════════════════════════════════════════════════════
  // The photo pin's screen-space hit test — the OTHER check Phase 8C named as
  // worth writing first, and the other one that was still unwritten when its
  // defect was reported by eye. A pin that cannot be clicked does not fail
  // safely: the miss falls straight through to the brush, so aiming at a
  // photograph MOVES GROUND.
  const R13 = "R13 · CLICKING A PHOTO PIN — the target is the pin as drawn";
  {
    const { nearestPin } = await import("./photo-view.js");
    // A stub projector: a pin standing at (100, 100), its head `stem` pixels
    // above its foot, and a ground ring of `ring` pixels. Pixels directly,
    // because what is being tested is the rule and not the camera.
    const pinAt = (stem, ring) => ({
      marks: [{ x: 0, y: 0, z: 0, zTop: 1, r: ring > 0 ? 1 : 0 }],
      project: (x, y, z) => {
        if (x > 0) return [100 + ring, 100];       // the ring's rim
        return [100, z > 0 ? 100 - stem : 100];    // head : foot
      },
    });
    const hits = (stem, ring, samples = 21) => {
      const { marks, project } = pinAt(stem, ring);
      let n = 0;
      for (let k = 0; k < samples; k++) {
        const t = k / (samples - 1);
        if (nearestPin(marks, 100, 100 - stem * t, project)) n++;
      }
      return n / samples;
    };

    {
      // ⚠️⚠️ THE ONE THAT WAS SHIPPED. Sampling along the pin as drawn, a rule
      // that tests only the two ends leaves the middle of a tall stem dead.
      add(R13, "every point along the stem hits the pin, at a stem height where " +
        "a two-disc test leaves the middle dead — the miss does not fail safely, " +
        "it falls through to the brush and moves ground",
        "100% of a 192 px stem", `${(hits(192, 0) * 100).toFixed(1)}%`,
        hits(192, 0) === 1);
      add(R13, "…and at 692 px, the tallest measured on the real walk when zoomed " +
        "in to read a photograph",
        "100%", `${(hits(692, 0) * 100).toFixed(1)}%`, hits(692, 0) === 1);
      add(R13, "…and a short pin still works, so the fix did not trade the near " +
        "case for the far one",
        "100% of a 27 px stem", `${(hits(27, 0) * 100).toFixed(1)}%`, hits(27, 0) === 1);
    }

    {
      // ⚠️ THE RING IS DRAWN IN METRES AND GROWS ON SCREEN — measured up to 93 px
      // of radius. A click plainly inside it must select.
      const { marks, project } = pinAt(40, 93);
      const inside = nearestPin(marks, 100 + 70, 100, project);
      const outside = nearestPin(marks, 100 + 200, 100, project);
      add(R13, "a click well inside a ground ring that has grown to 93 px on " +
        "screen selects the pin — a fixed 24 px tolerance rejects it while the " +
        "pointer is plainly on the mark",
        "inside hits, far outside misses",
        `${inside ? "hit" : "miss"}, ${outside ? "hit" : "miss"}`,
        !!inside && !outside);
    }

    {
      // Ordinary correctness, so the generous target does not become a greedy one.
      const { marks, project } = pinAt(100, 0);
      add(R13, "…but a click well away from the pin still misses, so a more " +
        "generous target has not become one that swallows the whole viewport",
        "miss at 200 px sideways",
        nearestPin(marks, 300, 100, project) ? "hit" : "miss",
        !nearestPin(marks, 300, 100, project));
      add(R13, "a pin entirely behind the camera is not selectable",
        "miss", nearestPin([{ x: 0, y: 0, z: 0, zTop: 1 }], 100, 100, () => null)
          ? "hit" : "miss",
        !nearestPin([{ x: 0, y: 0, z: 0, zTop: 1 }], 100, 100, () => null));
    }

    {
      // With pins crowded together the NEAREST must win, or clicking one opens
      // its neighbour — which on a 41-photograph walk is most of them.
      const marks = [
        { x: 0, y: 0, z: 0, zTop: 0, r: 0 },
        { x: 1, y: 0, z: 0, zTop: 0, r: 0 },
      ];
      const project = (x) => [x === 0 ? 100 : 130, 100];
      const near = nearestPin(marks, 126, 100, project);
      add(R13, "where pins crowd, the NEAREST wins — otherwise clicking one " +
        "photograph opens another, and on a 41-shot walk they overlap constantly",
        "the pin at 130", `the pin at ${near ? project(near.x)[0] : "none"}`,
        !!near && near.x === 1);
    }
  }

  // ══ R14 ══════════════════════════════════════════════════════════════════
  // The patchwork overlay. Written WITH the module rather than after its first
  // defect — the lesson R11 and R13 each taught the hard way.
  const R14 = "R14 · THE PATCHWORK — seams between workable patches, ticks along the terrace";
  {
    const { PatchOverlay } = await import("./patch-view.js");
    const N = 16, CELL = 0.25;
    const sd = {
      nrows: N, ncols: N, cell: CELL, z: new Float32Array(N * N),
      originX: 654942, originY: 7737700,
    };
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) sd.z[r * N + c] = 75 + c * 0.12 + r * 0.05;
    }
    // Two workable patches split down the middle, and a 2×2 speck inside the
    // left one — the same shape a real geomorphon map has, at toy scale.
    const labels = new Int32Array(N * N);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) labels[r * N + c] = c < 8 ? 1 : 2;
    }
    const speckled = Int32Array.from(labels);
    for (let r = 3; r < 5; r++) for (let c = 3; c < 5; c++) speckled[r * N + c] = 3;
    const patch = (id, cells, extra = {}) => ({
      id, klass: 5, cells, area: cells * CELL * CELL,
      x: 3.5 * CELL, y: (N - 7.5) * CELL, zlo: 75, zhi: 77,
      meanSlopeDeg: 20, bearingDeg: NaN, bearingConcentration: 0, ...extra,
    });

    const ov = new PatchOverlay(sd);
    ov.setPartition(labels, [patch(1, 128), patch(2, 128)]);
    const pos = (line) => line.geometry.getAttribute("position").array;

    {
      // Two workable halves of a 16x16 tile: the shared seam is 16 sides, the
      // tile perimeter is 64, and every side is drawn ONCE — 80 in total.
      // ⚠️ TOPOLOGY IS ASSERTED ON `sideCount`, THE TRACED CELL SIDES, not on
      // the drawn segment count — the boundary is corner-cut before it is
      // drawn, so `count` is a function of the smoothing passes and would have
      // to be re-baselined every time they changed. `sideCount` is the shape.
      add(R14, "every workable patch is outlined COMPLETELY — the shared seam "
        + "(16 sides) plus the tile perimeter (64), each side traced once, 80 "
        + "in total; drawing only the seam between two workable patches leaves "
        + "every outline open and lays ticks on ground with no shape around them",
        "80 cell sides", `${ov.sideCount}`, ov.sideCount === 80);

      // ⚠️ AND THE DRAWN LINE IS SMOOTHED, not the staircase those sides make.
      // A raw cell boundary turns 90° at every corner; corner-cutting has to
      // take that down by an order of magnitude or the "jaggery" complaint
      // this answers is not answered.
      {
        const chain = ov._outline.reduce((a, b) => (b.pts.length > a.pts.length ? b : a));
        let sum = 0, n = 0;
        for (let i = 1; i + 1 < chain.pts.length; i++) {
          const [ax, ay] = chain.pts[i - 1], [bx, by] = chain.pts[i], [cx, cy] = chain.pts[i + 1];
          const a1 = Math.atan2(by - ay, bx - ax), a2 = Math.atan2(cy - by, cx - bx);
          sum += Math.abs((((a2 - a1) * 180) / Math.PI + 540) % 360 - 180); n++;
        }
        const mean = n ? sum / n : 90;
        add(R14, "…and the drawn boundary is CORNER-CUT, so it turns a few "
          + "degrees per vertex where the cell staircase it was traced from "
          + "turns ninety",
          "mean turn < 30°", `${mean.toFixed(1)}°`, mean < 30);
        add(R14, "…and smoothing SUBDIVIDES rather than decimates — more drawn "
          + "segments than traced sides, so no corner of the shape is lost",
          "> 80 drawn", `${ov.count} drawn from ${ov.sideCount} sides`,
          ov.count > ov.sideCount);
      }

      const p = pos(ov._seam);
      // ⚠️ AN EVEN-DEGREE TEST WOULD BE WRONG HERE, and it was written first.
      // Where three regions meet — two patches and the world outside — the
      // corner legitimately carries THREE segment ends. Closure is a property
      // of each region's own boundary, not of the corner degrees of the union,
      // so it is tested per patch below instead.

      // ⚠️ Registration: the surface places cell (r,c)'s centre at
      // ((c+0.5)·cell, northY−(r+0.5)·cell), so the boundary between columns
      // 7 and 8 is the line x = 8·cell. An overlay on the c·cell lattice
      // instead would sit half a cell north-west of the ground it partitions.
      // ⚠️ Counted as "is the line there", not "how many segments" — corner
      // cutting subdivides a straight run without moving it, so the count is a
      // function of the smoothing and the POSITION is the invariant.
      let onEdge = 0, onOldLattice = 0;
      for (let i = 0; i < p.length; i += 3) {
        if (Math.abs(p[i] - 8 * CELL) < 1e-6) onEdge++;
        if (Math.abs(p[i] - (8 * CELL - CELL / 2)) < 1e-6) onOldLattice++;
      }
      add(R14, "…and the shared seam sits on the SURFACE's cell edge — "
        + "x = 8·cell under the (c+0.5)·cell convention surface.js, brush.js "
        + "and the exporters share — not half a cell off on the bare lattice",
        `points at x = ${(8 * CELL).toFixed(3)}, none at ${(8 * CELL - CELL / 2).toFixed(3)}`,
        `${onEdge} on the edge, ${onOldLattice} half a cell off`,
        onEdge > 0 && onOldLattice === 0);
    }

    {
      // The drape: same properties R11 pins for the selection outline, because
      // the failure mode is identical and was shipped once already.
      const p = pos(ov._seam);
      const byXY = new Map();
      for (let i = 0; i < p.length; i += 3) {
        const k = `${p[i].toFixed(4)},${p[i + 1].toFixed(4)}`;
        if (!byXY.has(k)) byXY.set(k, new Set());
        byXY.get(k).add(p[i + 2].toFixed(6));
      }
      let split = 0;
      for (const zs of byXY.values()) if (zs.size > 1) split++;
      add(R14, "every corner where two seam segments meet carries exactly one "
        + "height, so the patchwork closes instead of breaking into the "
        + "floating staircase the selection outline once shipped",
        "0 split corners", `${split} of ${byXY.size}`, split === 0);
      let sloped = 0;
      for (let s = 0; s < p.length / 6; s++) {
        if (Math.abs(p[s * 6 + 2] - p[s * 6 + 5]) > 1e-9) sloped++;
      }
      // ⚠️ A PROPORTION, NOT ALL OF THEM, and the difference is real rather
      // than slack: on a plane tilted in both axes a smoothed boundary runs
      // along the CONTOUR direction here and there, and those segments are
      // level because the ground is. The defect this guards against — the
      // floating staircase, every segment horizontal — would read as 0%.
      const frac = sloped / (p.length / 6);
      add(R14, "…and on sloping ground the boundary slopes with it, save for "
        + "the few spans that happen to run along the contour",
        "> 90% sloped", `${(frac * 100).toFixed(1)}% of ${p.length / 6}`, frac > 0.9);
    }

    {
      // ⚠️ SPECKLE DRAWS NOTHING. 4 768 of the POI's 4 870 patches are under
      // the size threshold; a rim around each would bury the patchwork in
      // exactly the ink the boundary-only rule exists to avoid. The partition
      // itself is untouched — the threshold decides what is DRAWN, not what
      // is measured or benched.
      ov.setPartition(speckled, [patch(1, 124), patch(2, 128), patch(3, 4)]);
      add(R14, "a patch under the size threshold is not inked as a patch — it "
        + "becomes a HOLE in the one around it, and the hole's rim is outlined "
        + "by the same test, exactly as a hole in a selection is",
        "80 + 8 = 88 cell sides", `${ov.sideCount}`, ov.sideCount === 88);
    }

    {
      // ⚠️⚠️ THE ROW THAT WOULD HAVE CAUGHT THE SHIPPED DEFECT, and it is the
      // case Marc found by eye: a workable patch surrounded ENTIRELY by
      // speckle. Under the old rule — draw a side only where two WORKABLE
      // patches meet — such a patch got no outline at all while still getting
      // its tick, so the tick lay on bare ground as a stray mark with no shape
      // around it. Its full perimeter must be drawn: 4 × 9 = 36 sides for a
      // 9×9 block.
      const lab = new Int32Array(N * N).fill(3);          // 3 = the speckle
      for (let r = 4; r < 13; r++) for (let c = 4; c < 13; c++) lab[r * N + c] = 1;
      ov.setPartition(lab, [
        patch(1, 81, { bearingDeg: 90, bearingConcentration: 1,
          x: 8.5 * CELL, y: (N - 8.5) * CELL }),
        patch(3, 4),                                       // below the threshold
      ]);
      add(R14, "a workable patch surrounded entirely by SPECKLE is still "
        + "outlined in full — under the old rule it got no outline at all and "
        + "its tick lay on bare ground, which is exactly how the defect was "
        + "spotted",
        "36 cell sides (4 × 9)", `${ov.sideCount}`, ov.sideCount === 36);
      add(R14, "…and its tick is drawn inside that outline, never alone",
        "1 tick with 36 sides around it",
        `${ov.tickCount} tick, ${ov.sideCount} sides`,
        ov.tickCount === 1 && ov.sideCount === 36);

      // ⚠️⚠️ THE OTHER HALF OF THE STRAY-MARK DEFECT: a tick anchored on the
      // CENTROID, which for a crescent, a ring or an L lies OUTSIDE the shape.
      // A C-shaped patch is the cheapest fixture that proves it — its centroid
      // sits in the opening, on cells belonging to no patch at all.
      // ⚠️ THE ARMS HAVE TO BE LONGER THAN THE SPINE IS THICK, or the centroid
      // stays inside the spine and the fixture proves nothing — the first
      // version had a three-cell spine and its centroid landed on the patch.
      const cShape = new Int32Array(N * N).fill(3);
      for (let r = 3; r < 13; r++) for (let c = 3; c < 5; c++) cShape[r * N + c] = 1;
      for (let c = 3; c < 14; c++) { cShape[3 * N + c] = 1; cShape[12 * N + c] = 1; }
      let cells = 0, sx = 0, sy = 0;
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (cShape[r * N + c] === 1) { cells++; sx += c; sy += r; }
      }
      const midR = Math.round(sy / cells), midC = Math.round(sx / cells);
      ov.setPartition(cShape, [
        // `cells` declared above the threshold so the patch is drawn; the
        // anchor search reads the LABELS, which carry the true C.
        patch(1, 100, { bearingDeg: 90, bearingConcentration: 1,
          x: (sx / cells) * CELL, y: (N - sy / cells) * CELL,
          r0: 3, r1: 12, c0: 3, c1: 13 }),
        patch(3, 4),
      ]);
      add(R14, "on a C-shaped patch — whose centroid falls in its own opening, "
        + "on ground belonging to no patch — the tick is anchored on a cell "
        + "that IS the patch; anchoring on the centroid is what put stray "
        + "marks on bare ground",
        `a cell of the patch, not (${midR},${midC})`,
        ov._ticks.length === 1
          ? `(${ov._ticks[0].r},${ov._ticks[0].c}) = ${cShape[ov._ticks[0].r * N + ov._ticks[0].c]}`
          : "no tick",
        ov._ticks.length === 1
        && cShape[ov._ticks[0].r * N + ov._ticks[0].c] === 1
        && cShape[midR * N + midC] !== 1);
    }

    {
      // The ticks. Patch 1 faces due east (aspect 90°) with full concentration;
      // patch 2 is flat and has no bearing at all.
      ov.setPartition(labels, [
        patch(1, 128, { bearingDeg: 90, bearingConcentration: 1 }),
        patch(2, 128),
      ]);
      add(R14, "a patch with a bearing gets one tick, and a flat patch gets "
        + "NONE — no direction exists there, and the statistics already say "
        + "so with a NaN this drawing must not contradict",
        "1 tick", `${ov.tickCount}`, ov.tickCount === 1);
      const t = pos(ov._tickLine);
      const dx = Math.abs(t[0] - t[3]), dy = Math.abs(t[1] - t[4]);
      // ⚠️ The tick is the TERRACE line — perpendicular to the stored bearing,
      // which is the mean downslope aspect. East-facing ground terraces
      // north–south.
      add(R14, "…and the tick runs along the CONTOUR, perpendicular to the "
        + "stored bearing — east-facing ground terraces north–south, and a "
        + "tick along the aspect itself would draw the fall line instead",
        "dx ≈ 0, dy > 0", `dx ${dx.toFixed(4)}, dy ${dy.toFixed(4)}`,
        dx < 1e-6 && dy > 0);

      // Concentration carries into length: a patch that wraps a nose has no
      // single bearing, and its tick must not claim one at full length.
      ov.setPartition(labels, [
        patch(1, 128, { bearingDeg: 90, bearingConcentration: 1 }),
        patch(2, 128, { bearingDeg: 90, bearingConcentration: 0.2,
          x: 11.5 * CELL, y: (N - 7.5) * CELL }),
      ]);
      const t2 = pos(ov._tickLine);
      const len = (o) => Math.hypot(t2[o] - t2[o + 3], t2[o + 1] - t2[o + 4]);
      add(R14, "…and a low bearing concentration SHORTENS the tick — a patch "
        + "that wraps a nose shrinks toward a dot rather than confidently "
        + "pointing somewhere the ground disagrees with",
        "concentrated tick longer", `${len(0).toFixed(2)} m vs ${len(6).toFixed(2)} m`,
        ov.tickCount === 2 && len(0) > len(6) * 2);
    }

    {
      // Same contract as the selection outline: the ground moves, the drape
      // follows, the PARTITION does not.
      ov.setPartition(labels, [patch(1, 128), patch(2, 128)]);
      const before = pos(ov._seam).slice();
      for (let i = 0; i < sd.z.length; i++) sd.z[i] += 1;
      ov.refresh();
      const after = pos(ov._seam);
      let planSame = true, zMoved = true;
      for (let i = 0; i < before.length; i += 3) {
        if (Math.abs(after[i] - before[i]) > 1e-9
          || Math.abs(after[i + 1] - before[i + 1]) > 1e-9) planSame = false;
        if (Math.abs((after[i + 2] - before[i + 2]) - 1) > 1e-4) zMoved = false;
      }
      add(R14, "after the ground moves, refresh() re-drapes the SAME partition "
        + "— every endpoint rises with the surface while the plan geometry and "
        + "the seam count stay byte-identical, because a landform map "
        + "recomputed unasked would redraw the patchwork behind the designer's "
        + "back",
        "plan identical, z +1.000 m",
        `plan ${planSame ? "identical" : "MOVED"}, z ${zMoved ? "+1 m" : "wrong"}`,
        planSame && zMoved && ov.sideCount === 80);
      for (let i = 0; i < sd.z.length; i++) sd.z[i] -= 1;
    }

    ov.dispose();
  }

  view.renderer.dispose();
  return rows;
}
