// @ts-check
/**
 * THE TWO-SCALE DIVE — the context tile, the design patch, and the exact 16×
 * relationship between them, in one scene.
 *
 * This is finding 1 made visible rather than asserted. The national terrain
 * model resolves 4 m; the relief that differentiates habitat is a tenth of that.
 * Saying so is a sentence. Showing a 64 m square sitting inside a 1 024 m tile,
 * as 1/256 of its area, and then diving into it until the cell size label reads
 * 0.25 m, is the argument.
 *
 * ⚠️ THE NESTING IS EXACT, AND THAT IS NOT LUCK — the design patch was chosen to
 * land on the context grid. Measured from the two tiles' own headers:
 *
 *     context   E 654350–655374   N 7737076–7738100   256² @ 4.00 m
 *     design    E 654942–655006   N 7737700–7737764   256² @ 0.25 m
 *
 *     offset E  654942 − 654350 = 592 m = 148 context cells   (integer)
 *     offset N  7737700 − 7737076 = 624 m = 156 context cells (integer)
 *     span      64 m = 16 context cells;  4.00 / 0.25 = 16
 *
 * So the patch is exactly 16×16 context cells and exactly 256×256 design cells,
 * with no fractional offset anywhere. The dive therefore needs no resampling and
 * no fudged alignment, and `nestCells()` below asserts it at runtime rather than
 * trusting this comment.
 *
 * ⚠️ BOTH SURFACES MUST SHARE ONE VERTICAL EXAGGERATION. They are drawn in the
 * same world space, so two different factors would put the patch at a different
 * height from the ground it is supposed to be sitting in — a seam that looks
 * like a data error. `setExaggeration()` drives both.
 *
 * The float32/UTM rule from Phase 3 applies and is already satisfied: `Surface`
 * keeps geometry local from (0,0) and puts the UTM origin on `mesh.position`,
 * where three.js matrix maths is CPU float64. Two tiles 592 m apart is exactly
 * the case that would have quantised had the world coordinates been baked in.
 */
import * as THREE from "three";
import { Surface } from "./surface.js";
import { DEM } from "./dem.js";
import { Apron } from "./apron.js";

/**
 * The buffer the apron would like, and the one it can actually have.
 *
 * ⚠️ THE RIM MUST LAND ON A CONTEXT VERTEX or the apron has nothing to meet.
 * The design tile's edge sits on a context CELL BOUNDARY while vertices sit at
 * cell CENTRES, so the usable widths are offset by half a cell: with a 4 m
 * context those are 2, 6, 10, 14 m and nothing between. Asking for 8 or 16 puts
 * the rim half a cell out, which looks like an arbitrary hairline gap.
 *
 * Rather than refuse an awkward number, snap to the nearest width that works
 * and report it — a dropped context of any cell size then gets the best buffer
 * its own lattice allows instead of no apron at all.
 * @param {DEM} outer @param {DEM} inner @param {number} wanted metres
 */
export function apronFit(outer, inner, wanted = 10) {
  const ox = inner.originX - outer.originX;
  const oy = inner.originY - outer.originY;
  const W = inner.ncols * inner.cell, H = inner.nrows * inner.cell;
  // Context vertex index whose centre sits `wanted` metres outside the patch.
  const cLo = Math.round((ox - wanted) / outer.cell - 0.5);
  const rLoS = Math.round((oy - wanted) / outer.cell - 0.5);
  const buffer = ox - (cLo + 0.5) * outer.cell;
  const bufferY = oy - (rLoS + 0.5) * outer.cell;
  const cHi = Math.round((ox + W + buffer) / outer.cell - 0.5);
  const rHiS = Math.round((oy + H + bufferY) / outer.cell - 0.5);
  // Rows are reported from the SOUTH here, as DEM.nest does; the surface counts
  // from the north. Flip once, at the end — the trap DEM.nestHole records.
  const r0 = outer.nrows - 1 - rHiS, r1 = outer.nrows - 1 - rLoS;
  return {
    buffer, bufferY,
    ok: buffer > 0 && bufferY > 0
      && cLo >= 0 && rLoS >= 0 && cHi < outer.ncols && rHiS < outer.nrows,
    // The opening: every quad strictly inside the rim ring. Leaving the rim
    // vertices themselves is what the apron abuts.
    hole: { r0: r0 + 1, c0: cLo + 1, r1: r1 - 1, c1: cHi - 1 },
  };
}

// Folder-qualified, because there is more than one tile set now: the surveyed
// Ørndalen data and the synthetic flat plane the workshop starts on. See
// TILE_SETS in app.js for which context belongs to which patch.
export const CONTEXT_TILE = "orndalen/orndalen_2024_4m.tif";
export const DESIGN_TILE = "orndalen/orndalen_fill_025m.tif";

/**
 * Where one DEM sits inside another, in the coarser one's cells.
 *
 * Returns integer cell offsets when the two grids are aligned, and reports the
 * fractional error when they are not — a caller should refuse to draw a nest
 * rectangle that is off-grid rather than draw it half a cell out.
 * @param {import("./dem.js").DEM} outer
 * @param {import("./dem.js").DEM} inner
 */
export const nestCells = (outer, inner) => DEM.nest(outer, inner);

/** Elevation sampled from a DEM at a world point, or NaN outside it. */
function sampleZ(dem, x, y) {
  const col = Math.floor((x - dem.originX) / dem.cell);
  const rowFromNorth = Math.floor(
    (dem.originY + dem.nrows * dem.cell - y) / dem.cell);
  if (col < 0 || rowFromNorth < 0 || col >= dem.ncols || rowFromNorth >= dem.nrows) return NaN;
  return dem.z[dem.idx(rowFromNorth, col)];
}

export class Dive {
  /**
   * @param {import("./view.js").View} view
   * @param {import("./dem.js").DEM} contextDem
   * @param {{verticalExaggeration?: number}} [opts]
   */
  constructor(view, contextDem, opts = {}) {
    this.view = view;
    this.dem = contextDem;
    this.exaggeration = opts.verticalExaggeration ?? 1.5;
    /** Buffer the apron asks for; snapped to the context's lattice by apronFit. */
    this.wantBuffer = opts.buffer ?? 10;

    this.surface = new Surface(contextDem, { verticalExaggeration: this.exaggeration });
    // ⚠️ The context is a BACKDROP, not the subject. It carries no analysis
    // panels and must never be mistaken for the surface being edited, so it is
    // pushed back visually rather than drawn at full strength.
    this.surface.mesh.renderOrder = -1;
    view.scene.add(this.surface.mesh);

    /** @type {Apron|null} the graded ring between the two scales */
    this.apron = null;
    this.visible = true;
  }

  /**
   * Draw the design patch's footprint on the context surface.
   *
   * The outline follows the ground rather than floating: each corner and each
   * point along the edges is lifted to the CONTEXT tile's own elevation there,
   * so the rectangle reads as painted on the coarse surface — which is the
   * point, since what it marks is a region the coarse surface cannot describe.
   * @param {import("./dem.js").DEM} designDem
   */
  markNest(designDem, { segments = 24 } = {}) {
    const nest = nestCells(this.dem, designDem);
    if (!nest.aligned || !nest.contained) {
      // ⚠️ CLOSE ANY OPENING CUT FOR A PREVIOUS PATCH. Returning early without
      // this leaves the last patch's hole in the context — a rectangular void
      // in the backdrop, in a place now unrelated to anything on screen.
      this.surface.setHole(null);
      this._dropApron();
      return nest;
    }

    // ⚠️ CUT THE CONTEXT OPEN WHERE THE PATCH ALREADY DRAWS THE GROUND, AND
    // WIDER THAN THE PATCH. Both surfaces describe the same 64 m of Ørndalen,
    // so over the footprint they were two depth-competing sheets a few
    // centimetres apart, and it is the coarse tile — the one that CANNOT
    // describe this ground — that won those pixels, inverting the argument the
    // dive exists to make. The opening now runs a buffer wider so the apron has
    // room to reconcile the two surveys; see apron.js.
    const fit = apronFit(this.dem, designDem, this.wantBuffer);
    this._dropApron();
    if (!fit.ok) {
      this.surface.setHole(DEM.nestHole(this.dem, designDem));
      return nest;
    }
    this.surface.setHole(fit.hole);
    this.apron = new Apron(designDem, this.dem, {
      buffer: fit.buffer,
      verticalExaggeration: this.exaggeration,
      // The backdrop's own tone, read off the surface that carries it.
      contextColors: this.surface.geometry.getAttribute("color"),
    });
    this.apron.setVisible(this.visible);
    this.view.scene.add(this.apron.mesh);
    nest.apronBuffer = fit.buffer;

    // ⚠️ THE FOOTPRINT OUTLINE IS GONE, AND ON PURPOSE. It was a heavy line
    // drawn 1.5 m ABOVE the context surface with depthTest off, so it floated
    // over the ground it was supposed to be painted on and read as a hovering
    // frame. It existed to say "the patch is here" back when the patch sat in a
    // hole with a visible gap round it. The apron says that far better, by
    // being continuous ground that gets finer as it goes in — which is the
    // thing itself rather than a label for it.
    return nest;
  }

  /** Remove the apron, if there is one. Safe to call when there is not. */
  _dropApron() {
    if (!this.apron) return;
    this.view.scene.remove(this.apron.mesh);
    this.apron.dispose();
    this.apron = null;
  }

  /**
   * ⚠️ ALL THREE SCALES MUST MOVE TOGETHER, not two. The apron is stitched to
   * both surfaces by exact vertex heights, so leaving it at the old factor
   * tears both seams at once — and it tears them by MORE the further the slider
   * goes, which reads as the transition failing at high exaggeration rather
   * than as one object being left behind.
   */
  setExaggeration(k) {
    this.exaggeration = k;
    this.surface.setVerticalExaggeration?.(k);
    this.apron?.setExaggeration(k);
  }

  setVisible(on) {
    this.visible = on;
    this.surface.mesh.visible = on;
    this.apron?.setVisible(on);
  }

  /** World-space box of the context tile, for framing. */
  boundingBox() { return this.surface.boundingBox(); }

  dispose_(obj) {
    this.view.scene.remove(obj);
    obj.geometry?.dispose();
    obj.material?.dispose();
  }

  dispose() {
    this._dropApron();
    this.view.scene.remove(this.surface.mesh);
    this.surface.dispose?.();
  }
}
