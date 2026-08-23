// @ts-check
/**
 * PLAN MODE — the model behind the drawing surface.
 *
 * polygon.js is the engine: it rasterises a ring onto the DEM and levels what
 * is inside it. This file is everything the ENGINE deliberately does not know
 * about — which rings exist, what they are called, which one is selected, what
 * a click at (x, y) means, and what leaves the tool as a feature. It carries no
 * three.js and no DOM, so it runs in Node and is tested in the kernel suite
 * alongside the engine it wraps. The scene rendering lives in plan-view.js and
 * the wiring in app.js; that split is the same one surface.js / app.js uses.
 *
 * ⚠️ THE HIT TESTS HERE MUST USE THE SAME RULE AS rasterise(). A click that
 * selects a region the leveller would then not touch — or the reverse — is the
 * kind of defect that only shows up as "the volume figure is wrong for that one
 * polygon". So pointInRings() is the even-odd test from polygon.js with the
 * same half-open scanline comparison, evaluated at the point instead of at cell
 * centres. Both are pinned against each other in the kernel suite.
 */

import { rasterise, maskZRange } from "./polygon.js";

/**
 * dBASE fields written for every region.
 *
 * ⚠️ `level_m` IS THE DESIGN INTENT, NOT A MEASUREMENT of the exported surface.
 * It is what the region was told to be; whether the ground actually got there
 * is a question for the exported GeoTIFF. Keeping it in the attribute table is
 * what makes a set of polygons a SPECIFICATION — the thing a contractor is
 * given — rather than a tracing of something that already exists.
 *
 * Sizes are dBASE III field widths in bytes; `name` at 32 is comfortably inside
 * the 254-byte character limit and long enough for "North terrace, upper".
 * @type {{name: string, type: "C"|"N", size: number, decimals?: number}[]}
 */
/**
 * ⚠️ `hidden` IS DELIBERATELY NOT HERE. A region carries two different kinds of
 * property: what it IS — its id, its name, the datum it is to be levelled to —
 * and how it is being LOOKED AT right now. Only the first kind is a
 * specification, and only the first kind belongs in a shapefile. Exporting a
 * visibility flag would hand the next person an attribute that describes the
 * state of somebody else's screen an hour ago, and sooner or later something
 * would filter on it.
 */
export const PLAN_FIELDS = [
  { name: "id", type: "N", size: 10 },
  { name: "name", type: "C", size: 32 },
  // Millimetres of decimals on a levelling datum: 0.001 m is below any survey
  // this would be set out from, so the number never loses to its own rounding.
  { name: "level_m", type: "N", size: 12, decimals: 3 },
];

/**
 * @typedef {object} Region
 * @property {number} id
 * @property {string} name
 * @property {number} level_m   the datum this region is to be levelled to
 * @property {number[][][]} rings  [outer, ...holes], each [[x, y], …] in map units
 * @property {boolean} [hidden] display only — see the note on PLAN_FIELDS
 * @property {boolean} [imported] display only — whether it came from a file
 *   rather than being traced. Not in PLAN_FIELDS for the same reason `hidden`
 *   is not: it describes this session, not the ground.
 */

/**
 * The set of regions drawn on one terrain.
 *
 * IDs are handed out here and never reused, including after a delete. A
 * shapefile's records are identified by their attributes once they leave this
 * tool, and two exports of the same session that both contain an "id 3"
 * describing different ground is a trap for anyone joining a table to them.
 */
export class PlanSet {
  constructor() {
    /** @type {Region[]} */
    this.regions = [];
    this._nextId = 1;
  }

  get length() { return this.regions.length; }

  /**
   * @param {number[][]} ring outer ring, [[x, y], …], not explicitly closed
   * @param {{level_m?: number, name?: string}} [opts]
   * @returns {Region}
   */
  add(ring, opts = {}) {
    const id = this._nextId++;
    const region = {
      id,
      name: opts.name ?? `Region ${id}`,
      level_m: opts.level_m ?? 0,
      rings: [ring.map(([x, y]) => [x, y])],
    };
    this.regions.push(region);
    return region;
  }

  /**
   * Add a hole to an existing region.
   *
   * ⚠️ A HOLE IS A RING IN THE SAME FEATURE, NOT A SECOND FEATURE. rasterise()
   * takes them out by the even-odd rule with no declaration of which is which,
   * so nothing here has to mark it as a hole or check its winding — but it does
   * have to end up in the SAME rings array, because two separate features would
   * simply be two overlapping platforms and the inner one would win.
   * @param {Region} region
   * @param {number[][]} ring
   */
  addHole(region, ring) {
    region.rings.push(ring.map(([x, y]) => [x, y]));
    return region;
  }

  /** @param {number} id */
  byId(id) { return this.regions.find((r) => r.id === id) ?? null; }

  /** @param {number} id @returns {boolean} whether anything was removed */
  remove(id) {
    const i = this.regions.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.regions.splice(i, 1);
    return true;
  }

  clear() { this.regions.length = 0; }
}

/* ------------------------------------------------------------------ geometry */

/**
 * Twice the signed area of a ring, positive counter-clockwise in a y-up world.
 * Halved by the callers that want an area; kept doubled here because the sign
 * is what most callers actually want and the factor cancels.
 * @param {number[][]} ring
 */
export function ringSignedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Ground area of a region in m², outer ring minus its holes.
 *
 * ⚠️ THIS IS THE EXACT POLYGON AREA AND THE LEDGER'S IS NOT. levelTo()
 * integrates whole cells, so its area is the cell count times the cell area and
 * differs from this by up to half a cell all round the boundary. Neither is
 * wrong; they answer different questions, and the sidebar labels them as such
 * rather than showing one number and hoping.
 * @param {Region} region
 */
export function regionArea(region) {
  if (!region.rings.length) return 0;
  let a = Math.abs(ringSignedArea(region.rings[0]));
  for (let i = 1; i < region.rings.length; i++) a -= Math.abs(ringSignedArea(region.rings[i]));
  return Math.max(0, a);
}

/**
 * Is (x, y) inside this set of rings, by the EVEN-ODD rule?
 *
 * The same test rasterise() runs along each scanline, evaluated at one point:
 * count the ring edges crossing the ray running east from (x, y), and call the
 * point inside when that count is odd. Holes therefore subtract without being
 * declared, exactly as they do in the raster.
 *
 * ⚠️ The comparison is HALF-OPEN — `(y1 <= y) !== (y2 <= y)` — for the reason
 * polygon.js records: two closed comparisons count a vertex lying exactly on
 * the ray twice, and the test then reports "outside" for points that are
 * plainly inside. On a hand-drawn ring that is rare and looks random; on a ring
 * whose vertices were snapped to a grid it is systematic.
 * @param {number[][][]} rings
 * @param {number} x @param {number} y
 */
export function pointInRings(rings, x, y) {
  let crossings = 0;
  for (const ring of rings) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
      if ((y1 <= y) !== (y2 <= y)) {
        const xi = x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
        if (xi > x) crossings++;
      }
    }
  }
  return (crossings & 1) === 1;
}

/**
 * A ring the engine can actually rasterise: three or more vertices, and an area
 * that is not zero. Two coincident clicks and a third somewhere else produce a
 * degenerate sliver that rasterises to nothing, and a region that covers no
 * cells has no elevation range, so the slider would have no bounds to take.
 * Refused at the point of drawing instead, where it can be said out loud.
 * @param {number[][]} ring
 */
export function ringIsValid(ring) {
  return ring.length >= 3 && Math.abs(ringSignedArea(ring)) > 1e-9;
}

/**
 * Elevation of the DEM cell containing (x, y), or NaN off the grid.
 *
 * NEAREST CELL, not interpolated. The ring outline is drawn draped on the
 * surface, and the surface is drawn flat-shaded precisely to say the terrain is
 * a discrete measurement at the cell size; a bilinear drape would put the
 * outline on a smooth skin the ground beneath it does not have.
 * @param {import("./dem.js").DEM} dem
 * @param {number} x @param {number} y
 */
export function zAtWorld(dem, x, y) {
  const col = Math.floor((x - dem.originX) / dem.cell);
  const northY = dem.originY + dem.nrows * dem.cell;
  const row = Math.floor((northY - y) / dem.cell);
  if (row < 0 || row >= dem.nrows || col < 0 || col >= dem.ncols) return NaN;
  return dem.z[row * dem.ncols + col];
}

/* ------------------------------------------------------------------- picking */

/**
 * Ground units per CSS pixel in an orthographic view — what turns a grab radius
 * in pixels into one in metres.
 *
 * ⚠️ A CANVAS'S clientWidth IS 0 WHENEVER IT HAS NO LAYOUT: a collapsed pane, a
 * background tab, the frame before the first ResizeObserver callback lands.
 * Divided straight through, that made a 10-pixel grab radius come out at
 * hundreds of metres — and the symptom was not "picking is imprecise", it was
 * that every click landed inside the first vertex's tolerance and CLOSED the
 * ring it had just started, so a four-corner platform came out a triangle. The
 * renderer's backing store is always the real size, so it is the fallback.
 *
 * @param {number} orthoWidth  camera.right − camera.left, in ground units
 * @param {number} cssWidth    canvas.clientWidth, which may be 0
 * @param {number} [backingWidth] canvas.width, in device pixels
 * @param {number} [pixelRatio]
 */
export function groundPerPixel(orthoWidth, cssWidth, backingWidth = 0, pixelRatio = 1) {
  const w = cssWidth || backingWidth / (pixelRatio || 1) || 1;
  return orthoWidth / w;
}

/**
 * The vertex under the cursor, or null.
 *
 * Searched in reverse drawing order so the most recently added region wins an
 * overlap — the one the hand just put there is the one the hand is reaching
 * for. `tol` is in ground units and is set by the caller from the current zoom,
 * so the grab radius is a constant number of PIXELS however far out the view is.
 * @param {Region[]} regions
 * @param {number} x @param {number} y @param {number} tol ground units
 * @returns {{region: Region, ring: number, index: number, d: number}|null}
 */
export function pickVertex(regions, x, y, tol) {
  let best = null;
  for (let i = regions.length - 1; i >= 0; i--) {
    const region = regions[i];
    region.rings.forEach((ring, ringIndex) => {
      ring.forEach(([vx, vy], index) => {
        const d = Math.hypot(vx - x, vy - y);
        if (d <= tol && (!best || d < best.d)) best = { region, ring: ringIndex, index, d };
      });
    });
    if (best) return best; // do not let a farther region's vertex beat this one
  }
  return best;
}

/**
 * The region under the point, topmost first, or null.
 * @param {Region[]} regions
 * @param {number} x @param {number} y
 */
export function pickRegion(regions, x, y) {
  for (let i = regions.length - 1; i >= 0; i--) {
    if (pointInRings(regions[i].rings, x, y)) return regions[i];
  }
  return null;
}

/* ------------------------------------------------------------- the earthwork */

/**
 * Mask and elevation range for a region, in one call — what the slider needs.
 * @param {import("./dem.js").DEM} dem
 * @param {Region} region
 */
export function regionExtent(dem, region) {
  const m = rasterise(dem, region.rings);
  return { ...m, ...maskZRange(dem, m.mask) };
}

/**
 * What levelling to `target` WOULD cost, without moving anything.
 *
 * ⚠️ THIS MUST AGREE WITH levelTo() EXACTLY, not approximately — it is the
 * number on screen while the slider is dragged, and if committing then produced
 * a different figure the ledger would look like it had drifted. It is the same
 * arithmetic with the assignment removed, and the kernel suite pins the two
 * together on the real patch rather than trusting that they were kept in step.
 *
 * The asymmetry the tool exists to show lives in what you pass as `target`:
 * the mask's own mean comes back net ~0, and any other datum does not.
 * @param {import("./dem.js").DEM} dem
 * @param {Uint8Array} mask
 * @param {number} target
 */
export function levelCost(dem, mask, target) {
  let cut = 0, fill = 0, cells = 0;
  const a = dem.cell * dem.cell;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const z = dem.z[i];
    if (!Number.isFinite(z)) continue;
    const dz = target - z;
    if (dz === 0) continue;
    if (dz > 0) fill += dz * a; else cut += -dz * a;
    cells++;
  }
  return { cut, fill, net: fill - cut, cells };
}

/* -------------------------------------------------------------------- export */

/**
 * Regions as shapefile/GeoJSON features.
 *
 * Winding is NOT normalised here: writeShapefile() wants clockwise outer rings
 * and writeGeoJSON() wants counter-clockwise ones, and each normalises its own
 * on the way out. Doing it here as well would be a second opinion about which
 * way round a ring goes, in a file that has no business having one.
 * @param {Region[]} regions
 */
export function toFeatures(regions) {
  return regions.map((r) => ({
    rings: r.rings,
    attributes: { id: r.id, name: r.name, level_m: r.level_m },
  }));
}
