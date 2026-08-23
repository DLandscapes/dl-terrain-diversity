// @ts-check
/**
 * SHAPEFILE WRITER — polygons out of Plan mode, hand-written like the GeoTIFF
 * and ZIP writers, for the same reason: this project vendors no dependencies.
 *
 * A "shapefile" is three or four files that must agree with each other, and the
 * format has four traps that all produce a file which opens without complaint
 * and is wrong. Each is marked below.
 *
 *   .shp  the geometry
 *   .shx  an index into it — QGIS will open without this, ArcGIS will not
 *   .dbf  the attribute table, dBASE III
 *   .prj  the CRS as WKT; without it the polygons land wherever the reader guesses
 */

const SHP_POLYGON = 5;

/** ⚠️ TRAP 1: LENGTHS IN A SHAPEFILE HEADER ARE 16-BIT WORDS, NOT BYTES. */
const words = (bytes) => bytes / 2;

/**
 * ⚠️ TRAP 2: THE .SHP HEADER IS MIXED-ENDIAN, and within one 100-byte block.
 * File code and file length are BIG-endian; version, shape type and the
 * bounding box are LITTLE-endian. Writing it all one way gives a file that
 * some readers still partly parse, which is worse than one that fails.
 * @param {DataView} v
 * @param {number} byteLength
 * @param {number[]} bbox  [xmin, ymin, xmax, ymax]
 */
function header(v, byteLength, bbox) {
  v.setInt32(0, 9994, false);              // file code, big-endian
  v.setInt32(24, words(byteLength), false); // file length in WORDS, big-endian
  v.setInt32(28, 1000, true);              // version, little-endian
  v.setInt32(32, SHP_POLYGON, true);       // shape type, little-endian
  v.setFloat64(36, bbox[0], true);
  v.setFloat64(44, bbox[1], true);
  v.setFloat64(52, bbox[2], true);
  v.setFloat64(60, bbox[3], true);
  // z and m ranges stay zero — these are 2D polygons.
}

/** Signed area, positive when the ring is clockwise in screen-down terms. */
function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * ⚠️ TRAP 3: SHAPEFILE OUTER RINGS MUST BE CLOCKWISE — the OPPOSITE of GeoJSON,
 * which wants counter-clockwise outer rings. Get this backwards and every
 * polygon is interpreted as a hole: the file opens, the geometry is "valid",
 * and the map is empty or inverted. Normalised here rather than trusted.
 *
 * ⚠️ TRAP 4: RINGS MUST BE EXPLICITLY CLOSED — first point repeated as last.
 * Readers differ on whether they tolerate an open ring; some silently drop the
 * closing segment, which shifts an area calculation without erroring.
 * @param {number[][]} ring
 */
function normaliseRing(ring, wantClockwise = true) {
  const r = ring.slice();
  const [fx, fy] = r[0], [lx, ly] = r[r.length - 1];
  if (fx !== lx || fy !== ly) r.push([fx, fy]);
  const cw = signedArea(r) < 0;   // y-up world: negative signed area is clockwise
  if (cw !== wantClockwise) r.reverse();
  return r;
}

/**
 * @typedef {object} PolygonFeature
 * @property {number[][][]} rings  [outer, ...holes], each [[x, y], …] in map units
 * @property {Record<string, string|number>} [attributes]
 */

/**
 * @param {PolygonFeature[]} features
 * @param {{fields?: {name: string, type: "C"|"N", size: number, decimals?: number}[],
 *          wkt?: string}} [opts]
 * @returns {{shp: Uint8Array, shx: Uint8Array, dbf: Uint8Array, prj: string}}
 */
export function writeShapefile(features, opts = {}) {
  const fields = opts.fields ?? [{ name: "id", type: "N", size: 10 }];

  const prepared = features.map((f) => {
    const rings = f.rings.map((r, i) => normaliseRing(r, i === 0));
    const pts = rings.reduce((n, r) => n + r.length, 0);
    // 44 fixed bytes + parts index + the points themselves.
    const content = 44 + rings.length * 4 + pts * 16;
    return { rings, pts, content };
  });

  const shpLen = 100 + prepared.reduce((n, p) => n + 8 + p.content, 0);
  const shxLen = 100 + prepared.length * 8;
  const shp = new ArrayBuffer(shpLen), shx = new ArrayBuffer(shxLen);
  const sv = new DataView(shp), xv = new DataView(shx);

  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const p of prepared) {
    for (const r of p.rings) for (const [x, y] of r) {
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
  }
  if (!prepared.length) { xmin = ymin = xmax = ymax = 0; }
  const bbox = [xmin, ymin, xmax, ymax];
  header(sv, shpLen, bbox);
  header(xv, shxLen, bbox);

  let off = 100;
  prepared.forEach((p, i) => {
    // Record header: number (1-based) and content length in WORDS, both BIG-endian.
    sv.setInt32(off, i + 1, false);
    sv.setInt32(off + 4, words(p.content), false);
    let o = off + 8;
    sv.setInt32(o, SHP_POLYGON, true); o += 4;
    let rxmin = Infinity, rymin = Infinity, rxmax = -Infinity, rymax = -Infinity;
    for (const r of p.rings) for (const [x, y] of r) {
      if (x < rxmin) rxmin = x; if (x > rxmax) rxmax = x;
      if (y < rymin) rymin = y; if (y > rymax) rymax = y;
    }
    sv.setFloat64(o, rxmin, true); sv.setFloat64(o + 8, rymin, true);
    sv.setFloat64(o + 16, rxmax, true); sv.setFloat64(o + 24, rymax, true); o += 32;
    sv.setInt32(o, p.rings.length, true); o += 4;
    sv.setInt32(o, p.pts, true); o += 4;
    let start = 0;
    for (const r of p.rings) { sv.setInt32(o, start, true); o += 4; start += r.length; }
    for (const r of p.rings) for (const [x, y] of r) {
      sv.setFloat64(o, x, true); sv.setFloat64(o + 8, y, true); o += 16;
    }
    // .shx: offset and length, both in WORDS, both big-endian.
    xv.setInt32(100 + i * 8, words(off), false);
    xv.setInt32(100 + i * 8 + 4, words(p.content), false);
    off += 8 + p.content;
  });

  return {
    shp: new Uint8Array(shp),
    shx: new Uint8Array(shx),
    dbf: writeDBF(features, fields),
    // ⚠️⚠️ THE .prj IS WRITTEN ONLY WHEN THE CRS IS ACTUALLY KNOWN TO BE THIS
    // ONE (2026-08-23). It used to be an unconditional default, which put
    // ETRS89 / UTM 33N on polygons drawn over terrain from anywhere on Earth —
    // and a .prj is not a label, it is what a reader USES TO PLACE THE
    // GEOMETRY. A wrong one silently lands the drawing in the wrong country.
    //
    // ⚠️ WHEN THE CRS IS UNKNOWN OR DIFFERENT, prj IS null AND THE CALLER MUST
    // OMIT THE FILE. That is not a gap: a shapefile with no .prj means "CRS
    // unstated", which every GIS handles by asking. There is no honest way to
    // synthesise WKT for an arbitrary EPSG without a projection database, and
    // guessing the parameters would be worse than saying nothing.
    prj: opts.wkt ?? (opts.epsg != null && Number(opts.epsg) !== 25833 ? null
      : 'PROJCS["ETRS89 / UTM zone 33N",GEOGCS["ETRS89",'
      + 'DATUM["European_Terrestrial_Reference_System_1989",'
      + 'SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],'
      + 'UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],'
      + 'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",15],'
      + 'PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],'
      + 'PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","25833"]]'),
  };
}

/** dBASE III attribute table. Fixed-width ASCII, space-padded. */
function writeDBF(features, fields) {
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((n, f) => n + f.size, 0);
  const buf = new Uint8Array(headerLen + features.length * recordLen + 1);
  const v = new DataView(buf.buffer);
  buf[0] = 0x03;                       // dBASE III, no memo
  const d = new Date();
  buf[1] = d.getFullYear() - 1900; buf[2] = d.getMonth() + 1; buf[3] = d.getDate();
  v.setInt32(4, features.length, true);
  v.setInt16(8, headerLen, true);
  v.setInt16(10, recordLen, true);

  fields.forEach((f, i) => {
    const o = 32 + i * 32;
    // ⚠️ dBASE III FIELD NAMES ARE 10 BYTES MAX and are NUL-padded. A longer
    // name is silently truncated by readers, which is how two fields end up
    // with the same name and one of them disappears.
    const name = f.name.slice(0, 10);
    for (let c = 0; c < name.length; c++) buf[o + c] = name.charCodeAt(c);
    buf[o + 11] = f.type.charCodeAt(0);
    buf[o + 16] = f.size;
    buf[o + 17] = f.decimals ?? 0;
  });
  buf[32 + fields.length * 32] = 0x0d;  // header terminator

  let o = headerLen;
  for (const f of features) {
    buf[o++] = 0x20;                    // 0x20 = not deleted
    for (const fd of fields) {
      const raw = f.attributes?.[fd.name];
      let s = raw === undefined || raw === null ? "" : String(raw);
      if (fd.type === "N" && typeof raw === "number") s = raw.toFixed(fd.decimals ?? 0);
      s = s.length > fd.size ? s.slice(0, fd.size) : s;
      // Numbers right-aligned, text left-aligned — the dBASE convention.
      const pad = fd.size - s.length;
      const text = fd.type === "N" ? " ".repeat(pad) + s : s + " ".repeat(pad);
      for (let c = 0; c < fd.size; c++) buf[o + c] = text.charCodeAt(c);
      o += fd.size;
    }
  }
  buf[o] = 0x1a;                        // end-of-file marker
  return buf;
}

/**
 * GeoJSON alongside — three lines, and it has none of the traps above.
 * ⚠️ NO DEFAULT CRS. This defaulted to "EPSG:25833" and so stamped this tool's
 * home coordinate system onto geometry from anywhere. Passed nothing, it now
 * names no CRS — which for GeoJSON is the correct reading anyway, since RFC
 * 7946 says an unstated CRS is WGS 84 and inventing a different one in the file
 * is worse than leaving the caller to say what they mean.
 */
export function writeGeoJSON(features, { crs = null } = {}) {
  return JSON.stringify({
    type: "FeatureCollection",
    // ⚠️ GeoJSON WANTS COUNTER-CLOCKWISE OUTER RINGS — the opposite of the
    // shapefile above. Normalised here so the two exports of one drawing agree.
    features: features.map((f) => ({
      type: "Feature",
      properties: f.attributes ?? {},
      geometry: {
        type: "Polygon",
        coordinates: f.rings.map((r, i) => normaliseRing(r, i !== 0)),
      },
    })),
    // ⚠️ THE MEMBER IS OMITTED ENTIRELY WHEN THE CRS IS UNKNOWN, rather than
    // written with a placeholder. `crs.replace` on null would also have thrown.
    ...(crs
      ? { crs: { type: "name", properties: { name: `urn:ogc:def:crs:${crs.replace(":", "::")}` } } }
      : {}),
  });
}
