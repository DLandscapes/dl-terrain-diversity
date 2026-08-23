// @ts-check
// Minimal GeoTIFF reader for single-band float32 elevation rasters.
//
// Port of DL-TerrainSlicer (slicer/dtm.py), which reads
// the same class of file via tifffile. Two things that file never had to deal
// with, because tifffile handled them internally, are handled here explicitly:
//
//   1. Kartverket's hoydedata.no ImageServer returns TILED TIFFs (TileWidth/
//      TileLength + TileOffsets/TileByteCounts), not stripped ones. A reader
//      that only understands RowsPerStrip/StripOffsets will silently produce
//      garbage on these files rather than failing loudly.
//   2. Neither of the two real Ørndalen tiles carries a GDAL_NODATA (42113)
//      tag, so the sentinel sweep below is the ONLY nodata path in practice,
//      not a belt-and-braces extra. Do not delete it as dead code.

/** @typedef {{type:number, count:number, value:number[]|string}} TiffTagValue */

const TYPE_SIZE = /** @type {Record<number, number>} */ ({
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL (2x LONG)
  11: 4, // FLOAT
  12: 8, // DOUBLE
});

/**
 * Parse a classic (non-Big) TIFF's first IFD into a tag map.
 * @param {ArrayBuffer} buf
 * @returns {{tags: Map<number, TiffTagValue>, little: boolean}}
 */
function readIFD(buf) {
  const dv = new DataView(buf);
  const bo = String.fromCharCode(dv.getUint8(0), dv.getUint8(1));
  if (bo !== "II" && bo !== "MM") {
    throw new Error(`not a TIFF (bad byte-order marker ${JSON.stringify(bo)})`);
  }
  const little = bo === "II";
  const magic = dv.getUint16(2, little);
  if (magic !== 42) {
    throw new Error(`not a classic TIFF (magic ${magic}); BigTIFF is not supported`);
  }
  const ifdOffset = dv.getUint32(4, little);
  const n = dv.getUint16(ifdOffset, little);

  /** @param {number} type @param {number} count @param {number} off */
  function readValues(type, count, off) {
    if (type === 2) {
      // ASCII, NUL-terminated
      const bytes = new Uint8Array(buf, off, count);
      let s = "";
      for (let i = 0; i < count && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
    const out = /** @type {number[]} */ ([]);
    for (let i = 0; i < count; i++) {
      switch (type) {
        case 1: out.push(dv.getUint8(off + i)); break;
        case 3: out.push(dv.getUint16(off + i * 2, little)); break;
        case 4: out.push(dv.getUint32(off + i * 4, little)); break;
        case 5: {
          const num = dv.getUint32(off + i * 8, little);
          const den = dv.getUint32(off + i * 8 + 4, little);
          out.push(den === 0 ? NaN : num / den);
          break;
        }
        case 11: out.push(dv.getFloat32(off + i * 4, little)); break;
        case 12: out.push(dv.getFloat64(off + i * 8, little)); break;
        default: throw new Error(`unsupported TIFF tag value type ${type}`);
      }
    }
    return out;
  }

  const tags = new Map();
  for (let i = 0; i < n; i++) {
    const entryOff = ifdOffset + 2 + i * 12;
    const tag = dv.getUint16(entryOff, little);
    const type = dv.getUint16(entryOff + 2, little);
    const count = dv.getUint32(entryOff + 4, little);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const valueOff = size <= 4 ? entryOff + 8 : dv.getUint32(entryOff + 8, little);
    const value = readValues(type, count, valueOff);
    tags.set(tag, { type, count, value });
  }
  return { tags, little };
}

/** @param {Map<number, TiffTagValue>} tags @param {number} tag */
function num(tags, tag) {
  const v = tags.get(tag)?.value;
  return Array.isArray(v) ? v[0] : undefined;
}
/** @param {Map<number, TiffTagValue>} tags @param {number} tag */
function arr(tags, tag) {
  const v = tags.get(tag)?.value;
  return Array.isArray(v) ? v : undefined;
}

/**
 * Cell size in ground units, from ModelPixelScale (33550) or, failing that,
 * from ModelTransformation (34264). Non-square cells THROW rather than being
 * silently averaged — a deliberate house convention (see planning/02 §6):
 * an anisotropic grid would bias every slope and flow-accumulation result.
 * @param {Map<number, TiffTagValue>} tags
 */
function pixelScale(tags) {
  const ps = arr(tags, 33550); // ModelPixelScaleTag: sx, sy, sz
  if (ps && ps[0] > 0 && ps[1] > 0) {
    const [sx, sy] = ps;
    if (Math.abs(sx - sy) > 1e-6 * Math.max(sx, sy)) {
      throw new Error(`non-square pixels (sx=${sx}, sy=${sy}); refusing to average`);
    }
    return sx;
  }
  const mt = arr(tags, 34264); // ModelTransformationTag: 4x4 affine, row-major
  if (mt && mt.length >= 16) {
    const sx = Math.hypot(mt[0], mt[4]);
    const sy = Math.hypot(mt[1], mt[5]);
    if (sx > 0 && sy > 0) {
      if (Math.abs(sx - sy) > 1e-6 * Math.max(sx, sy)) {
        throw new Error(`non-square pixels via ModelTransformation (sx=${sx}, sy=${sy})`);
      }
      return sx;
    }
  }
  return null;
}

/**
 * Raw ModelTiepoint (33922): raster point (i,j) sits at world (X,Y).
 * @param {Map<number, TiffTagValue>} tags
 */
function tiepoint(tags) {
  const tp = arr(tags, 33922);
  if (tp && tp.length >= 6) {
    return { i: tp[0], j: tp[1], x: tp[3], y: tp[4] };
  }
  return null;
}

/** @param {Map<number, TiffTagValue>} tags */
function gdalNodata(tags) {
  const v = tags.get(42113)?.value;
  if (typeof v === "string") {
    const f = parseFloat(v.trim());
    return Number.isFinite(f) ? f : null;
  }
  return null;
}

const NODATA_SENTINELS = [-9999.0, -32767.0, -32768.0, 3.4028235e38, -3.4028235e38].map(
  (x) => Math.fround(x)
);

/**
 * Every (bitsPerSample, sampleFormat) combination this reader understands, and
 * the DataView method that reads it. TIFF sampleFormat: 1 = unsigned int,
 * 2 = signed int, 3 = IEEE float.
 *
 * WHY THIS TABLE EXISTS. Elevation is float32 and nothing else, so the reader
 * originally hard-rejected everything else. But a CLASS raster — a soil map, a
 * land-cover map, anything whose pixels are codes rather than measurements — is
 * normally written as Byte or Int16, because writing a 7-value class list as
 * float32 wastes four bytes a pixel. Rejecting integers meant the tool could not
 * read the one kind of raster a substrate layer arrives in.
 *
 * Values are still widened into a Float32Array on the way out, so every consumer
 * downstream is unchanged and NaN remains the nodata marker.
 * @type {Record<string, {bytes: number, read: (dv: DataView, off: number, le: boolean) => number}>}
 */
const SAMPLE_READERS = {
  "8:1": { bytes: 1, read: (dv, o) => dv.getUint8(o) },
  "8:2": { bytes: 1, read: (dv, o) => dv.getInt8(o) },
  "16:1": { bytes: 2, read: (dv, o, le) => dv.getUint16(o, le) },
  "16:2": { bytes: 2, read: (dv, o, le) => dv.getInt16(o, le) },
  "32:1": { bytes: 4, read: (dv, o, le) => dv.getUint32(o, le) },
  "32:2": { bytes: 4, read: (dv, o, le) => dv.getInt32(o, le) },
  "32:3": { bytes: 4, read: (dv, o, le) => dv.getFloat32(o, le) },
  "64:3": { bytes: 8, read: (dv, o, le) => dv.getFloat64(o, le) },
};

/**
 * Read the single-band pixel plane, handling both tiled and (as a fallback)
 * simple single-strip layouts.
 *
 * Compression must still be `none` (1). Both real Ørndalen tiles are
 * uncompressed, and adding LZW or Deflate would mean either hand-writing a
 * decompressor or going async for DecompressionStream — neither worth it when
 * `gdal_translate` fixes it in one line. The error message says so.
 * @param {ArrayBuffer} buf
 * @param {Map<number, TiffTagValue>} tags
 * @param {boolean} little
 */
function readPixels(buf, tags, little) {
  const width = num(tags, 256);
  const height = num(tags, 257);
  const bitsPerSample = num(tags, 258);
  const compression = num(tags, 259) ?? 1;
  const samplesPerPixel = num(tags, 277) ?? 1;
  const sampleFormat = num(tags, 339) ?? 1; // 1=uint, 2=int, 3=float
  const planarConfig = num(tags, 284) ?? 1;

  if (width === undefined || height === undefined) {
    throw new Error("TIFF missing ImageWidth/ImageLength");
  }
  if (compression !== 1) {
    throw new Error(
      `unsupported TIFF compression ${compression} — this reader handles uncompressed rasters only. ` +
      `Convert with:  gdal_translate -co COMPRESS=NONE in.tif out.tif`
    );
  }
  const fmt = SAMPLE_READERS[`${bitsPerSample}:${sampleFormat}`];
  if (!fmt) {
    throw new Error(
      `unsupported sample format (bitsPerSample=${bitsPerSample}, sampleFormat=${sampleFormat}). ` +
      `Supported: 8/16/32-bit integer and 32/64-bit float. ` +
      `Convert with:  gdal_translate -ot Float32 -co COMPRESS=NONE in.tif out.tif`
    );
  }
  if (planarConfig !== 1) {
    throw new Error(`unsupported PlanarConfiguration ${planarConfig} (only chunky/interleaved is supported)`);
  }

  const out = new Float32Array(width * height);
  const dv = new DataView(buf);
  const bps = fmt.bytes;
  const readSample = fmt.read;

  const tileWidth = num(tags, 322);
  const tileLength = num(tags, 323);

  if (tileWidth !== undefined && tileLength !== undefined) {
    // --- Tiled layout ---
    const tileOffsets = arr(tags, 324);
    const tileByteCounts = arr(tags, 325);
    if (!tileOffsets || !tileByteCounts) {
      throw new Error("tiled TIFF missing TileOffsets/TileByteCounts");
    }
    const tilesAcross = Math.ceil(width / tileWidth);
    const tilesDown = Math.ceil(height / tileLength);
    const expectedTiles = tilesAcross * tilesDown;
    if (tileOffsets.length !== expectedTiles) {
      throw new Error(
        `tile count mismatch: expected ${expectedTiles} (${tilesAcross}x${tilesDown}), got ${tileOffsets.length}`
      );
    }
    const pixelsPerTile = tileWidth * tileLength * samplesPerPixel;
    for (let ty = 0; ty < tilesDown; ty++) {
      for (let tx = 0; tx < tilesAcross; tx++) {
        const tileIdx = ty * tilesAcross + tx;
        const byteOff = tileOffsets[tileIdx];
        const byteCount = tileByteCounts[tileIdx];
        if (byteCount < pixelsPerTile * bps) {
          throw new Error(
            `tile ${tileIdx} byte count ${byteCount} smaller than expected ${pixelsPerTile * bps} ` +
            `(compressed tiles are not supported)`
          );
        }
        const originRow = ty * tileLength;
        const originCol = tx * tileWidth;
        const rowsInTile = Math.min(tileLength, height - originRow);
        const colsInTile = Math.min(tileWidth, width - originCol);
        for (let r = 0; r < rowsInTile; r++) {
          const destRowBase = (originRow + r) * width + originCol;
          const srcBase = byteOff + (r * tileWidth) * samplesPerPixel * bps;
          for (let c = 0; c < colsInTile; c++) {
            // band 0 only, matching dtm.py's "multi-band: take the first band"
            out[destRowBase + c] = readSample(dv, srcBase + c * samplesPerPixel * bps, little);
          }
        }
      }
    }
  } else {
    // --- Stripped layout fallback (single strip covering the whole image) ---
    const stripOffsets = arr(tags, 273);
    const stripByteCounts = arr(tags, 279);
    const rowsPerStrip = num(tags, 278) ?? height;
    if (!stripOffsets || !stripByteCounts) {
      throw new Error("TIFF has neither tile tags nor strip tags — cannot read pixels");
    }
    let row = 0;
    for (let s = 0; s < stripOffsets.length; s++) {
      const rows = Math.min(rowsPerStrip, height - row);
      const off = stripOffsets[s];
      for (let r = 0; r < rows; r++) {
        const destBase = (row + r) * width;
        const srcBase = off + r * width * samplesPerPixel * bps;
        for (let c = 0; c < width; c++) {
          out[destBase + c] = readSample(dv, srcBase + c * samplesPerPixel * bps, little);
        }
      }
      row += rows;
    }
  }

  return { width, height, data: out };
}

/**
 * @typedef {Object} DEM
 * @property {Float32Array} z        NaN = nodata, row 0 = north edge
 * @property {number} nrows
 * @property {number} ncols
 * @property {number} cell           ground units per pixel
 * @property {number} originX        world X of the grid's west edge
 * @property {number} originY        world Y of the grid's south edge
 * @property {string} name
 * @property {number} downsampledBy
 * @property {string[]} warnings
 */

/**
 * Load a single-band GeoTIFF as a float32 grid.
 *
 * @param {ArrayBuffer} buf
 * @param {{name?: string, maxDim?: number, classes?: boolean}} [opts]
 *   classes — the raster holds CLASS CODES, not measurements. Suppresses the
 *   unflagged-sentinel sweep below, because a class raster may legitimately use
 *   a code this reader would otherwise silently rewrite to NaN.
 * @returns {DEM}
 */
export function loadGeoTIFF(buf, opts = {}) {
  const name = opts.name ?? "";
  const maxDim = opts.maxDim ?? 2000;
  const classes = opts.classes === true;
  const warnings = /** @type {string[]} */ ([]);

  const { tags, little } = readIFD(buf);
  const { width, height, data } = readPixels(buf, tags, little);

  let cell = pixelScale(tags);
  if (cell === null) {
    cell = 1.0;
    warnings.push("no georeferencing tags found; assuming cell size of 1.0 ground unit per pixel");
  }

  let originX = 0, originY = 0;
  const tie = tiepoint(tags);
  if (tie) {
    // west edge (col 0); south edge (below the last row) — same formula as dtm.py
    originX = tie.x - tie.i * cell;
    originY = tie.y + tie.j * cell - height * cell;
  }

  const nodata = gdalNodata(tags);
  if (nodata !== null) {
    const nd32 = Math.fround(nodata);
    for (let i = 0; i < data.length; i++) if (data[i] === nd32) data[i] = NaN;
  }
  // Common unflagged nodata sentinels. On real Kartverket tiles there is no
  // GDAL_NODATA tag at all, so this sweep is not a fallback — it is the path.
  //
  // ⚠️ SKIPPED FOR CLASS RASTERS. These sentinels are elevation conventions. A
  // class raster is entitled to use -9999 or 32767 as an ordinary code, and
  // silently rewriting it to NaN would delete a category rather than a gap. A
  // caller that knows it is reading codes says so.
  if (!classes) {
    for (const sentinel of NODATA_SENTINELS) {
      let hit = false;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === sentinel) { data[i] = NaN; hit = true; }
      }
      if (hit) warnings.push(`treated raw value ${sentinel} as nodata`);
    }
  }

  let anyFinite = false;
  for (let i = 0; i < data.length; i++) if (Number.isFinite(data[i])) { anyFinite = true; break; }
  if (!anyFinite) {
    throw new Error(classes
      ? "raster contains no valid values"
      : "raster contains no valid elevation values");
  }

  // Decimation for interactive use — ported from dtm.py's max_dim rule.
  // Not exercised by the 256x256 Ørndalen tiles (well under maxDim=2000).
  let step = 1;
  while (Math.max(width, height) / step > maxDim) step += 1;
  let z = data, nrows = height, ncols = width;
  if (step > 1) {
    nrows = Math.ceil(height / step);
    ncols = Math.ceil(width / step);
    const decimated = new Float32Array(nrows * ncols);
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        decimated[r * ncols + c] = data[(r * step) * width + (c * step)];
      }
    }
    z = decimated;
    cell *= step;
    warnings.push(`raster downsampled by factor ${step} for interactive use (cell size now ${cell})`);
  }

  return {
    z, nrows, ncols, cell, originX, originY,
    name, downsampledBy: step, warnings,
  };
}

/**
 * Fetch and load a GeoTIFF DEM from a URL.
 * @param {string} url
 * @param {{maxDim?: number}} [opts]
 * @returns {Promise<DEM>}
 */
export async function loadGeoTIFFFromURL(url, opts = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  return loadGeoTIFF(buf, { name: url, ...opts });
}
