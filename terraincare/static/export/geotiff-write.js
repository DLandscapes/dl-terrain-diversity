// @ts-check
// Single-band float32 GeoTIFF writer — the counterpart to geotiff.js.
//
// The tool now edits real national terrain data, so the edited surface has to
// be able to leave: into QGIS or SAGA as a georeferenced raster, and back into
// the same reader here. An export that loses the CRS would turn measured
// terrain into an unplaceable picture of terrain.
//
// STRIPPED, not tiled. Kartverket's ImageServer returns tiled TIFFs and
// geotiff.js had to learn to read them, but writing one strip per image is
// simpler, is what GDAL produces by default for small rasters, and is read by
// everything. Uncompressed, because the reader here only supports
// compression 1 and a file this tool cannot re-open would be a poor export.
//
// Verified two ways, deliberately: a round trip through our own reader
// (self-test group K), and independently by rasterio/GDAL, which checks the
// CRS and the affine transform we claim rather than the ones we assume.

/** TIFF tag value types. */
const T_SHORT = 3, T_LONG = 4, T_DOUBLE = 12, T_ASCII = 2;

/**
 * Write a single-band float32 GeoTIFF.
 *
 * @param {Float32Array} z        row-major, row 0 = NORTH edge (house convention)
 * @param {number} nrows @param {number} ncols
 * @param {number} cell           ground units per pixel, square
 * @param {number} originX        world X of the WEST edge
 * @param {number} originY        world Y of the SOUTH edge
 * @param {{epsg?: number}} [opts]
 * @returns {Uint8Array}
 */
export function writeGeoTIFF(z, nrows, ncols, cell, originX, originY, opts = {}) {
  if (z.length !== nrows * ncols) {
    throw new Error(`writeGeoTIFF: z.length ${z.length} !== ${nrows}*${ncols}`);
  }
  // ⚠️⚠️ NO DEFAULT EPSG. This read `opts.epsg ?? 25833` until 2026-08-23, so a
  // raster imported from anywhere on Earth was written back out declaring
  // ETRS89 / UTM 33N in its own GeoKeys. Not a mislabel in the interface — a
  // corrupt georeference in the FILE, which every downstream GIS would then
  // believe. A tool that claims GIS-grade output must never invent a datum.
  // When the CRS is unknown the file says so, per the GeoTIFF spec, rather than
  // guessing: GTModelType and ProjectedCSType both become 32767 (user-defined),
  // which is the standard way to state "not a registered code".
  const epsg = Number.isFinite(opts.epsg) ? Number(opts.epsg) : null;

  // ⚠️ The tiepoint is the NORTH-west corner; dem.js stores the SOUTH-west one.
  // geotiff.js inverts this on the way in (originY = tie.y + tie.j*cell -
  // height*cell); getting the sign wrong here would flip the raster north-south
  // on every round trip, which the self-test's origin check would catch but a
  // glance at the image would not.
  const tieX = originX;
  const tieY = originY + nrows * cell;

  // GeoKeyDirectory: version 1.1.0, three keys, ascending by key ID.
  //   1024 GTModelType     = 1  (projected)
  //   1025 GTRasterType    = 1  (PixelIsArea — the pixel covers its cell, which
  //                              is what a DEM cell is; PixelIsPoint would shift
  //                              everything by half a cell)
  //   3072 ProjectedCSType = EPSG code
  const geoKeys = [
    1, 1, 0, 3,
    1024, 0, 1, epsg === null ? 32767 : 1,
    1025, 0, 1, 1,
    3072, 0, 1, epsg === null ? 32767 : epsg,
  ];
  const nodataText = "nan\0";

  /** @type {{tag:number, type:number, count:number, values:number[]|string}[]} */
  const entries = [
    { tag: 256, type: T_LONG, count: 1, values: [ncols] },        // ImageWidth
    { tag: 257, type: T_LONG, count: 1, values: [nrows] },        // ImageLength
    { tag: 258, type: T_SHORT, count: 1, values: [32] },          // BitsPerSample
    { tag: 259, type: T_SHORT, count: 1, values: [1] },           // Compression: none
    { tag: 262, type: T_SHORT, count: 1, values: [1] },           // Photometric: BlackIsZero
    { tag: 273, type: T_LONG, count: 1, values: [0] },            // StripOffsets — patched below
    { tag: 277, type: T_SHORT, count: 1, values: [1] },           // SamplesPerPixel
    { tag: 278, type: T_LONG, count: 1, values: [nrows] },        // RowsPerStrip: one strip
    { tag: 279, type: T_LONG, count: 1, values: [nrows * ncols * 4] }, // StripByteCounts
    { tag: 284, type: T_SHORT, count: 1, values: [1] },           // PlanarConfig: chunky
    { tag: 339, type: T_SHORT, count: 1, values: [3] },           // SampleFormat: IEEE float
    { tag: 33550, type: T_DOUBLE, count: 3, values: [cell, cell, 0] },      // ModelPixelScale
    { tag: 33922, type: T_DOUBLE, count: 6, values: [0, 0, 0, tieX, tieY, 0] }, // ModelTiepoint
    { tag: 34735, type: T_SHORT, count: geoKeys.length, values: geoKeys },  // GeoKeyDirectory
    { tag: 42113, type: T_ASCII, count: nodataText.length, values: nodataText }, // GDAL_NODATA
  ];
  entries.sort((a, b) => a.tag - b.tag); // TIFF requires ascending tag order

  const typeSize = { [T_SHORT]: 2, [T_LONG]: 4, [T_DOUBLE]: 8, [T_ASCII]: 1 };
  const ifdBytes = 2 + entries.length * 12 + 4;
  const ifdOffset = 8;

  // Values longer than 4 bytes live outside the entry, after the IFD.
  let extOffset = ifdOffset + ifdBytes;
  const extPlan = entries.map((e) => {
    const size = typeSize[e.type] * e.count;
    if (size <= 4) return { inline: true, offset: 0, size };
    const at = extOffset;
    extOffset += size + (size % 2); // keep the next value word-aligned
    return { inline: false, offset: at, size };
  });

  const pixelOffset = extOffset;
  const total = pixelOffset + nrows * ncols * 4;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const LE = true;

  // Header
  u8[0] = 0x49; u8[1] = 0x49;          // "II" little-endian
  dv.setUint16(2, 42, LE);             // classic TIFF magic
  dv.setUint32(4, ifdOffset, LE);

  // The strip offset is only known once the layout is fixed.
  const strip = entries.find((e) => e.tag === 273);
  /** @type {number[]} */ (strip.values)[0] = pixelOffset;

  const writeValues = (e, at) => {
    if (e.type === T_ASCII) {
      const s = /** @type {string} */ (e.values);
      for (let k = 0; k < s.length; k++) u8[at + k] = s.charCodeAt(k) & 0xff;
      return;
    }
    const vals = /** @type {number[]} */ (e.values);
    for (let k = 0; k < vals.length; k++) {
      if (e.type === T_SHORT) dv.setUint16(at + k * 2, vals[k], LE);
      else if (e.type === T_LONG) dv.setUint32(at + k * 4, vals[k], LE);
      else dv.setFloat64(at + k * 8, vals[k], LE);
    }
  };

  dv.setUint16(ifdOffset, entries.length, LE);
  entries.forEach((e, i) => {
    const at = ifdOffset + 2 + i * 12;
    dv.setUint16(at, e.tag, LE);
    dv.setUint16(at + 2, e.type, LE);
    dv.setUint32(at + 4, e.count, LE);
    const plan = extPlan[i];
    if (plan.inline) writeValues(e, at + 8);
    else { dv.setUint32(at + 8, plan.offset, LE); writeValues(e, plan.offset); }
  });
  dv.setUint32(ifdOffset + 2 + entries.length * 12, 0, LE); // no next IFD

  for (let i = 0; i < z.length; i++) dv.setFloat32(pixelOffset + i * 4, z[i], LE);

  return u8;
}
