// @ts-check
// THE ORTHOPHOTO DRAPE — a licence-restricted image, held locally and never
// written out.
//
// ⚠️⚠️ READ THIS BEFORE TOUCHING ANYTHING HERE. The imagery this module is
// built for (Norge i bilder / Kartverket aerial photography) is licensed to
// this project for EDUCATION AND RESEARCH ONLY. It may not be redistributed,
// published, or uploaded anywhere, and no derivative carrying its pixels may
// leave this machine. That is a licence condition, not a preference.
//
// The architecture enforces it rather than trusting anyone to remember:
//
//   1. The drape is NEVER a member of state.panels. Everything the exporters
//      walk — figures, layer GeoTIFFs, the Everything bundle — iterates
//      LIVE_PANELS/HEAVY_PANELS and reads state.panels. A layer that is not in
//      that table cannot be reached by any of them, so no export path has to
//      remember to skip it.
//   2. It is never given a key in LEGEND, RAMPS or the analysis grid, so the
//      figure builder has no entry to build from.
//   3. The app never fetches it: the file arrives by drop, from the user's own
//      disk, and lives in one texture in memory for the session.
//
// If a future change makes the drape exportable, it breaks the licence. Any
// such change needs the rights holder's written permission first.
//
// ⚠️ THE DRAPE IS NOT AN ANALYSIS LAYER, and it must never be read as one. It
// is a photograph: it shows what WAS there when the aircraft flew, not what
// the design does. It is context for the eye, and the tool's readings are
// unaffected by whether it is switched on.

/**
 * Read an RGB(A) GeoTIFF into an image plane plus its georeferencing.
 *
 * Shares no code with geotiff.js on purpose: that reader widens ONE band into
 * a Float32Array of measurements, which is exactly wrong here — a photograph
 * is three or four interleaved 8-bit channels and the whole point is to keep
 * them together. The tag walk is duplicated (~40 lines) rather than making the
 * elevation reader generic, because the elevation path is load-bearing for
 * every measurement the tool makes and is not worth the risk.
 *
 * @param {ArrayBuffer} buf
 * @returns {{width:number, height:number, rgb:Uint8ClampedArray,
 *            cell:number, originX:number, originY:number}}
 */
export function readOrthoTIFF(buf) {
  const dv = new DataView(buf);
  const bom = dv.getUint16(0, false);
  const little = bom === 0x4949;
  if (!little && bom !== 0x4d4d) throw new Error("not a TIFF (bad byte order mark)");
  if (dv.getUint16(2, little) !== 42) throw new Error("not a classic TIFF (BigTIFF is not supported)");

  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  const tags = new Map();
  const ifd = dv.getUint32(4, little);
  const count = dv.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    const tag = dv.getUint16(e, little);
    const type = dv.getUint16(e + 2, little);
    const n = dv.getUint32(e + 4, little);
    const size = (TYPE_SIZE[type] || 1) * n;
    const off = size <= 4 ? e + 8 : dv.getUint32(e + 8, little);
    const vals = [];
    for (let k = 0; k < n; k++) {
      const o = off + k * (TYPE_SIZE[type] || 1);
      if (o + (TYPE_SIZE[type] || 1) > buf.byteLength) break;
      switch (type) {
        case 1: case 7: vals.push(dv.getUint8(o)); break;
        case 3: vals.push(dv.getUint16(o, little)); break;
        case 4: vals.push(dv.getUint32(o, little)); break;
        case 11: vals.push(dv.getFloat32(o, little)); break;
        case 12: vals.push(dv.getFloat64(o, little)); break;
        default: vals.push(0);
      }
    }
    tags.set(tag, vals);
  }
  const one = (t) => (tags.has(t) ? tags.get(t)[0] : undefined);

  const width = one(256), height = one(257);
  if (width === undefined || height === undefined) throw new Error("TIFF missing image size");
  const bits = one(258) ?? 8;
  const compression = one(259) ?? 1;
  const spp = one(277) ?? 1;
  const planar = one(284) ?? 1;
  if (compression !== 1) {
    throw new Error(`the ortho is compressed (TIFF compression ${compression}). `
      + `This reader takes uncompressed only — convert with:  `
      + `gdal_translate -co COMPRESS=NONE in.tif out.tif`);
  }
  if (bits !== 8) throw new Error(`ortho must be 8-bit per channel (found ${bits})`);
  if (spp < 3) throw new Error(`ortho must have at least 3 bands (found ${spp}) — this is an image, not a grid`);
  if (planar !== 1) throw new Error("ortho must be interleaved (PlanarConfiguration 1)");

  const rgb = new Uint8ClampedArray(width * height * 3);
  const bytes = new Uint8Array(buf);
  const tileW = one(322), tileH = one(323);

  if (tileW !== undefined && tileH !== undefined) {
    const offs = tags.get(324) || [];
    const across = Math.ceil(width / tileW);
    const down = Math.ceil(height / tileH);
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        const base = offs[ty * across + tx];
        if (base === undefined) continue;
        const rows = Math.min(tileH, height - ty * tileH);
        const cols = Math.min(tileW, width - tx * tileW);
        for (let r = 0; r < rows; r++) {
          const src = base + r * tileW * spp;
          let dst = ((ty * tileH + r) * width + tx * tileW) * 3;
          for (let c = 0; c < cols; c++) {
            const s = src + c * spp;
            rgb[dst++] = bytes[s]; rgb[dst++] = bytes[s + 1]; rgb[dst++] = bytes[s + 2];
          }
        }
      }
    }
  } else {
    const offs = tags.get(273) || [];
    const rowsPerStrip = one(278) ?? height;
    let row = 0;
    for (let s = 0; s < offs.length && row < height; s++) {
      const rows = Math.min(rowsPerStrip, height - row);
      for (let r = 0; r < rows; r++) {
        const src = offs[s] + r * width * spp;
        let dst = ((row + r) * width) * 3;
        for (let c = 0; c < width; c++) {
          const p = src + c * spp;
          rgb[dst++] = bytes[p]; rgb[dst++] = bytes[p + 1]; rgb[dst++] = bytes[p + 2];
        }
      }
      row += rows;
    }
  }

  // Georeferencing: the same two tags the elevation reader uses.
  const scale = tags.get(33550);
  const tie = tags.get(33922);
  const cell = scale ? scale[0] : 1;
  const originX = tie ? tie[3] - tie[0] * cell : 0;
  const originY = tie ? tie[4] + tie[1] * cell - height * cell : 0;

  return { width, height, rgb, cell, originX, originY };
}

/**
 * Resample the photograph onto the DEM's own grid, as the RGBA buffer the
 * surface already knows how to wear.
 *
 * ⚠️ NEAREST NEIGHBOUR, DELIBERATELY. Interpolating would invent pixel values
 * that were never photographed — harmless on a decorative backdrop, wrong on
 * something a student may be reading ground cover off. Nearest keeps every
 * pixel a measured one.
 *
 * ⚠️ CELLS OUTSIDE THE PHOTOGRAPH GO TRANSPARENT, not black: a drape smaller
 * than the site must read as "no image here", and the terrain's own shading
 * shows through. Returns null when the two do not overlap at all, which is the
 * honest answer for a photograph of somewhere else — see the note in app.js
 * about the POI and the DEM tiles being cut for different centres.
 *
 * @param {{width:number,height:number,rgb:Uint8ClampedArray,cell:number,originX:number,originY:number}} img
 * @param {{nrows:number,ncols:number,cell:number,originX:number,originY:number}} dem
 * @returns {{rgba: Uint8ClampedArray, covered: number}|null}
 */
export function drapeOnto(img, dem) {
  const rgba = new Uint8ClampedArray(dem.ncols * dem.nrows * 4);
  const northY = dem.originY + dem.nrows * dem.cell;
  const imgNorthY = img.originY + img.height * img.cell;
  let covered = 0;

  for (let r = 0; r < dem.nrows; r++) {
    // DEM row 0 is the NORTH edge — the convention every other module here
    // follows — and so is the image's row 0.
    const wy = northY - (r + 0.5) * dem.cell;
    const ir = Math.floor((imgNorthY - wy) / img.cell);
    for (let c = 0; c < dem.ncols; c++) {
      const wx = dem.originX + (c + 0.5) * dem.cell;
      const ic = Math.floor((wx - img.originX) / img.cell);
      const d = (r * dem.ncols + c) * 4;
      if (ir < 0 || ir >= img.height || ic < 0 || ic >= img.width) continue;
      const s = (ir * img.width + ic) * 3;
      rgba[d] = img.rgb[s];
      rgba[d + 1] = img.rgb[s + 1];
      rgba[d + 2] = img.rgb[s + 2];
      rgba[d + 3] = 255;
      covered++;
    }
  }
  if (!covered) return null;
  return { rgba, covered: covered / (dem.ncols * dem.nrows) };
}
