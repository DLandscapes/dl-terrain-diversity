// @ts-check
// THE DRAINAGE NETWORK AS VECTOR GEOMETRY — channels as connected polylines,
// catchments as polygons.
//
// Marc, 2026-09-02: "the fall lines or the channels — could we also make these
// available for download, along with the watersheds, both as vector data, as
// .dxf and as .shp".
//
// ⚠️⚠️ THE DRAWING AND THE DATA ARE BUILT DIFFERENTLY, ON PURPOSE. `drainageSVG`
// draws the channels as ONE DISCONNECTED SEGMENT PER CELL — centre to receiver
// centre — which is the right thing for a printed sheet, where all that matters
// is the ink. As data it would be worthless: a shapefile of forty thousand
// two-point stubs cannot be selected, measured, ordered or joined. What a GIS
// needs is REACHES — a polyline from a channel head down to the confluence
// where it meets another, carrying its own length and contributing area.
//
// ⚠️ THE THRESHOLDS ARE THE SHEET'S OWN, so the download and the drainage plan
// describe the same network rather than two defensible ones. They are shares of
// the tile, not absolute areas, which is what makes them mean the same thing on
// a 64 m patch and a 1 km context.
//
// ⚠️ D8 FOR THE PATHS, and the reason is watershed.js's, quoted here because it
// is easy to "improve" this to MFD and be wrong: a line has one downstream end.
// MFD splits flow across up to eight neighbours, so "where does this cell drain
// to" has no single answer under it and no polyline can be drawn. Accumulation
// stays MFD — the AREA on each reach is the Freeman figure — while the routing
// that turns it into a line is D8. Two models, each doing what it can do.
//
// ⚠️ AND NOTHING HERE IS A PREDICTION. These are steepest-descent paths over a
// bare surface: no infiltration, no roughness, no culverts, no rainfall event.
// The README written beside the files says so in as many words.

import { flowAccumulation } from "../analysis/mfd.js";
import { watersheds, MICRO, OUTLET, NO_DATA } from "../analysis/watershed.js";
import { traceLabelRings, ringsArea } from "./trace.js";

/**
 * Channel-class thresholds as shares of the tile — identical to drainageSVG's.
 * The width is what the sheet draws; the class is what the data carries.
 */
export const CHANNEL_CLASSES = [
  { cls: 1, share: 0.01, name: "minor" },
  { cls: 2, share: 0.05, name: "collector" },
  { cls: 3, share: 0.15, name: "main" },
];

/**
 * @typedef {object} Reach
 * @property {number[][]} pts     world [x, y], upstream → downstream
 * @property {number} cls         1 minor · 2 collector · 3 main
 * @property {number} areaM2      contributing area at the downstream end
 * @property {number} lengthM
 * @property {number} basin       basin label at the downstream end
 */

/**
 * Trace the channel network as connected reaches.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {{minShare?: number}} [opts]  smallest share of the tile that counts
 *   as a channel; the default is the sheet's own smallest class.
 * @returns {{reaches: Reach[], cellsInNetwork: number, minAreaM2: number}}
 */
export function channelReaches(dem, opts = {}) {
  const { nrows, ncols, cell } = dem;
  const n = nrows * ncols;
  const tile = nrows * cell * ncols * cell;
  const minArea = tile * (opts.minShare ?? CHANNEL_CLASSES[0].share);

  const flow = flowAccumulation(dem);
  const ws = watersheds(dem);
  const area = flow.contributingArea;
  const recv = ws.receiver;

  const isCh = new Uint8Array(n);
  let cellsInNetwork = 0;
  for (let i = 0; i < n; i++) {
    if (area[i] >= minArea) { isCh[i] = 1; cellsInNetwork++; }
  }

  /** The next cell downstream, or -1 where the network ends. */
  const down = (i) => {
    const r = recv[i];
    if (r === OUTLET || r === NO_DATA || r < 0 || r === i) return -1;
    return isCh[r] ? r : -1;
  };

  // How many channel cells drain INTO each cell. A cell with two or more is a
  // confluence, and a confluence is where one reach ends and the next begins —
  // the same rule a stream-order table is built on.
  const upstream = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (!isCh[i]) continue;
    const d = down(i);
    if (d >= 0) upstream[d]++;
  }

  const cx = (i) => dem.originX + ((i % ncols) + 0.5) * cell;
  // ⚠️ ROW 0 IS THE NORTHERNMOST ROW (dem.js), so y counts DOWN from the top.
  const cy = (i) => dem.originY + (nrows - ((i / ncols) | 0) - 0.5) * cell;

  /** @type {Reach[]} */
  const reaches = [];
  // Every reach starts at a head (nothing upstream) or at a confluence. Between
  // them each cell has exactly one channel upstream, so walking downstream from
  // these starts visits every link in the network exactly once.
  for (let s = 0; s < n; s++) {
    if (!isCh[s]) continue;
    if (upstream[s] === 1) continue;
    let cur = s;
    const pts = [[cx(s), cy(s)]];
    let last = s;
    for (let guard = 0; guard < n; guard++) {
      const d = down(cur);
      if (d < 0) break;
      pts.push([cx(d), cy(d)]);
      last = d;
      // The confluence closes this reach and opens the next; it belongs to
      // both, as the shared vertex, so the network stays connected.
      if (upstream[d] >= 2) break;
      cur = d;
    }
    if (pts.length < 2) continue;
    let len = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      len += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
    }
    reaches.push({
      pts,
      cls: classOf(area[last], tile),
      areaM2: area[last],
      lengthM: len,
      basin: ws.basin[last],
    });
  }
  return { reaches, cellsInNetwork, minAreaM2: minArea };
}

/** @param {number} a contributing area, m² @param {number} tile m² */
function classOf(a, tile) {
  let cls = 1;
  for (const c of CHANNEL_CLASSES) if (a >= tile * c.share) cls = c.cls;
  return cls;
}

/**
 * @typedef {object} Catchment
 * @property {number[][][]} rings  [outer, ...holes], world [x, y]
 * @property {number} basin        the pit cell index, or MICRO
 * @property {number} areaM2
 * @property {number} cells
 * @property {boolean} micro       drains to a hollow too small to be a catchment
 */

/**
 * Catchment boundaries as polygons.
 *
 * ⚠️ MICRO BASINS ARE INCLUDED AND LABELLED, not dropped. watershed.js's own
 * note is the reason: on the real 0.25 m patch most of the surface drains to a
 * centimetre-deep hollow, and that is a measurement about the ground rather
 * than a failure of the delineation. Silently filtering them would export a
 * tidier map of a site that does not exist. The attribute is there so a reader
 * can filter them out deliberately, which is a different act.
 *
 * @param {import("../dem.js").DEM} dem
 * @param {{minCells?: number}} [opts]
 * @returns {{catchments: Catchment[], count: number, microCells: number}}
 */
export function catchmentPolygons(dem, opts = {}) {
  const { nrows, ncols, cell, originX, originY } = dem;
  const ws = watersheds(dem, opts);
  const traced = traceLabelRings(/** @type {any} */ (ws.basin), {
    nrows, ncols, cell, originX, originY,
    // NO_DATA is a hole in the survey and must not become a polygon; MICRO is a
    // real class and must.
    keep: (v) => v !== NO_DATA && v !== undefined,
  });
  let microCells = 0;
  for (let i = 0; i < ws.basin.length; i++) if (ws.basin[i] === MICRO) microCells++;
  const catchments = traced.map((f) => ({
    rings: f.rings,
    basin: f.label,
    areaM2: ringsArea(f.rings),
    cells: f.cells,
    micro: f.label === MICRO,
  }));
  return { catchments, count: ws.count, microCells };
}
