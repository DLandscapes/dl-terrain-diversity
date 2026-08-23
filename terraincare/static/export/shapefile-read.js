// @ts-check
/**
 * READ polygons out of a shapefile, so a plan can come from GIS instead of
 * being traced by hand.
 *
 * ⚠️ THE MIRROR OF shapefile.js, DELIBERATELY. Everything here is the inverse
 * of a specific line in the writer — the same record layout, the same
 * big-endian header fields against little-endian content, the same parts index.
 * Kept in a separate file rather than bolted onto the writer because the failure
 * modes are opposite: a writer that is wrong produces a file nothing opens,
 * which you find out immediately, while a reader that is wrong produces regions
 * that look plausible and sit in the wrong place.
 *
 * ⚠️ WHAT THIS DOES NOT DO, AND MUST NOT PRETEND TO. It does not reproject. A
 * shapefile carries its CRS in a sidecar .prj as WKT, and this reads that far
 * enough to WARN when it disagrees with the terrain — it does not transform
 * coordinates. Silently reprojecting on a guess would put a designed boundary
 * somewhere it was never drawn, which is worse than refusing, and a real
 * transform needs a projection library this project does not vendor.
 */

/** Shape types that carry polygon rings. Z and M variants differ only in the
 *  trailing arrays, which are past everything we read. */
const POLYGON_TYPES = new Set([5, 15, 25]);
const NULL_SHAPE = 0;

/**
 * Polygon features from a .shp buffer.
 *
 * @param {ArrayBuffer} buf
 * @returns {{rings: number[][][], skipped: number, types: number[],
 *            bbox: number[]}}
 *   `rings` is one entry per FEATURE, each a list of rings, each a list of
 *   [x, y]. Rings arrive closed (first point repeated) as the spec requires and
 *   are returned closed — plan.js's rasteriser treats the ring as a loop either
 *   way, and stripping it here would be a second opinion about the geometry.
 */
export function readShapefile(buf) {
  const v = new DataView(buf);
  if (buf.byteLength < 100) throw new Error("not a shapefile: shorter than its own header");
  // ⚠️ FILE CODE IS BIG-ENDIAN AND THE VERSION IS LITTLE-ENDIAN, in the same
  // header, eight bytes apart. That is the format, not a mistake, and checking
  // both is the cheapest way to catch a file that is not a .shp at all — a .dbf
  // or a .prj dropped by accident sails past a length check.
  if (v.getInt32(0, false) !== 9994) throw new Error("not a shapefile: bad file code");
  if (v.getInt32(28, true) !== 1000) throw new Error("unsupported shapefile version");

  // Length is in 16-BIT WORDS, including the header. A file truncated by a
  // partial download passes every other check and then reads garbage records.
  const declared = v.getInt32(24, false) * 2;
  const end = Math.min(declared, buf.byteLength);
  const bbox = [v.getFloat64(36, true), v.getFloat64(44, true),
    v.getFloat64(52, true), v.getFloat64(60, true)];

  /** @type {number[][][]} */
  const out = [];
  const types = [];
  let skipped = 0;
  let off = 100;
  while (off + 8 <= end) {
    const contentWords = v.getInt32(off + 4, false);
    const content = contentWords * 2;
    const body = off + 8;
    if (content <= 0 || body + content > end) break;   // truncated tail
    const type = v.getInt32(body, true);
    types.push(type);
    if (type === NULL_SHAPE || !POLYGON_TYPES.has(type)) {
      // A null shape is a legitimate record with no geometry, and a point or
      // line layer is a real file that simply is not a plan. Counted and
      // reported rather than thrown on, so one stray record cannot lose the
      // other ninety-nine.
      skipped++;
      off = body + content;
      continue;
    }
    let o = body + 4 + 32;                       // past type and the record box
    const numParts = v.getInt32(o, true); o += 4;
    const numPoints = v.getInt32(o, true); o += 4;
    if (numParts <= 0 || numPoints <= 0) { skipped++; off = body + content; continue; }
    const starts = [];
    for (let i = 0; i < numParts; i++) { starts.push(v.getInt32(o, true)); o += 4; }
    const px = o;
    /** @type {number[][][]} */
    const rings = [];
    for (let p = 0; p < numParts; p++) {
      const s = starts[p];
      const e = p + 1 < numParts ? starts[p + 1] : numPoints;
      const ring = [];
      for (let i = s; i < e; i++) {
        ring.push([v.getFloat64(px + i * 16, true), v.getFloat64(px + i * 16 + 8, true)]);
      }
      if (ring.length >= 4) rings.push(ring);      // a closed ring needs 4 points
    }
    if (rings.length) out.push(rings); else skipped++;
    off = body + content;
  }
  return { rings: out, skipped, types, bbox };
}

/**
 * The EPSG code a .prj names, if it names one recognisably.
 *
 * ⚠️ DELIBERATELY SHALLOW. Parsing WKT properly means implementing a grammar
 * and a datum registry; all this needs to do is answer "is this obviously a
 * different CRS from the terrain's" so the import can say so. It returns null
 * when it cannot tell, and a null must be treated as "unknown", never as
 * "matches".
 * @param {string} wkt
 */
export function prjEpsg(wkt) {
  if (!wkt) return null;
  // The conventional trailing AUTHORITY["EPSG","25833"] on the outermost node.
  const all = [...wkt.matchAll(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d+)"\s*\]/gi)];
  if (all.length) return parseInt(all[all.length - 1][1], 10);
  const m = wkt.match(/"(?:ETRS89|EUREF89)[^"]*UTM[^"]*zone\s*(\d+)N?"/i);
  if (m) return 25800 + parseInt(m[1], 10);
  return null;
}

/**
 * Does this ring set land anywhere near the terrain it is being imported onto?
 *
 * ⚠️ THE CHECK THAT CATCHES A WRONG CRS WITHOUT PARSING ONE. Coordinates in the
 * wrong projection are not subtly wrong — degrees against UTM metres are out by
 * six orders of magnitude, and a different zone by hundreds of kilometres. A
 * polygon that shares no ground at all with the DEM is the symptom, and it is
 * one the tool can state plainly instead of drawing a region nobody can find.
 * @param {number[][][]} featureRings @param {import("../dem.js").DEM} dem
 */
export function overlapsTerrain(featureRings, dem) {
  const x0 = dem.originX, y0 = dem.originY;
  const x1 = x0 + dem.ncols * dem.cell, y1 = y0 + dem.nrows * dem.cell;
  let inside = 0, total = 0;
  for (const rings of featureRings) {
    for (const [x, y] of rings[0] || []) {
      total++;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) inside++;
    }
  }
  return { total, inside, fraction: total ? inside / total : 0 };
}
