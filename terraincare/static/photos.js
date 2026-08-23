// @ts-check
// SITE PHOTOGRAPHS ON THE MODEL — where the camera stood, and which way it
// looked.
//
// ⚠️ AN OBSERVATION IS NOT A PREDICTION, AND THIS IS THE FIRST PLACE THE TOOL
// HOLDS BOTH. Everything else in this app is either measured terrain or a
// stated assumption about what could tolerate it; a photograph is neither. It
// is a record that on one date, at one point, someone saw something. That is a
// stronger claim than the species model makes and a narrower one — it says
// nothing about the cell next door — and the two must never be merged into one
// layer. They are drawn differently and read differently: the model is a field
// over the whole surface, an observation is a point with a date on it.
//
// ⚠️ GDPR. Photographs are the one input here that can carry personal data.
// The tool reads them IN THE BROWSER and never uploads them — there is no
// server to upload to — but the standing rules still apply to what is done
// with them afterwards: a photograph showing an identifiable person is not
// annotated, not exported, and not published, and any picture with children in
// it needs Marc's explicit decision before it goes anywhere. See tools/photo-id.py,
// which already keeps such an exclusion list by name for the June visit.

/**
 * WGS84 latitude/longitude to UTM zone 33N (EPSG:25833) easting/northing.
 *
 * The standard Transverse Mercator forward series on the GRS80 ellipsoid,
 * which is what ETRS89 uses — the same datum the DEMs and the ortho are in, so
 * no datum shift is needed and none is applied. Accurate to a few millimetres
 * across a zone, which is far inside a phone GPS's own error.
 *
 * ⚠️ ZONE 33 IS HARD-CODED, deliberately: every tile, shapefile and export in
 * this project is EPSG:25833, and a photo silently reprojected into some other
 * zone would land hundreds of kilometres away while looking like a valid
 * number. A caller outside the zone gets a large easting, which is the correct
 * and visible answer.
 *
 * @param {number} lat @param {number} lon
 * @returns {{x:number, y:number}}
 */
export function toUTM33(lat, lon) {
  const a = 6378137.0, f = 1 / 298.257222101;      // GRS80
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const k0 = 0.9996, lon0 = 15.0;                   // zone 33 central meridian
  const φ = (lat * Math.PI) / 180;
  const dl = ((lon - lon0) * Math.PI) / 180;
  const sin = Math.sin(φ), cos = Math.cos(φ), tan = Math.tan(φ);
  const N = a / Math.sqrt(1 - e2 * sin * sin);
  const T = tan * tan, C = ep2 * cos * cos, A = cos * dl;
  const M = a * ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * φ
    - ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * φ)
    + ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * φ)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * φ));
  const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6
    + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  const y = k0 * (M + N * tan * ((A * A) / 2
    + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return { x, y };
}

/**
 * Pull the GPS block out of a JPEG's EXIF, by hand.
 *
 * No library: EXIF is a TIFF IFD wearing a JPEG APP1 hat, and the tool already
 * contains two TIFF tag walkers. Reading only what is needed — position,
 * altitude, and the compass bearing the camera was pointed along — keeps this
 * to one function that cannot silently pull in a dependency's licence.
 *
 * ⚠️ RETURNS null RATHER THAN GUESSING. A photograph without a geotag has no
 * place on the map at all: dropping it at the site centre would invent a
 * location, and an invented observation is worse than a missing one.
 *
 * @param {ArrayBuffer} buf
 * @returns {{lat:number, lon:number, alt:number|null, bearing:number|null,
 *            when:string|null}|null}
 */
export function readExifGPS(buf) {
  const dv = new DataView(buf);
  if (dv.getUint16(0, false) !== 0xffd8) return null;   // not a JPEG

  // Walk the JPEG segments for APP1/Exif.
  let off = 2, exif = -1;
  while (off + 4 < dv.byteLength) {
    if (dv.getUint8(off) !== 0xff) break;
    const marker = dv.getUint8(off + 1);
    const len = dv.getUint16(off + 2, false);
    if (marker === 0xe1 && dv.getUint32(off + 4, false) === 0x45786966) { exif = off + 10; break; }
    if (marker === 0xda) break;   // start of scan: no EXIF before the pixels
    off += 2 + len;
  }
  if (exif < 0) return null;

  const little = dv.getUint16(exif, false) === 0x4949;
  if (dv.getUint16(exif + 2, little) !== 42) return null;
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };

  /** Read one IFD into a Map of tag -> values. */
  const readIFD = (base) => {
    const out = new Map();
    if (base + 2 > dv.byteLength) return out;
    const n = dv.getUint16(base, little);
    for (let i = 0; i < n; i++) {
      const e = base + 2 + i * 12;
      if (e + 12 > dv.byteLength) break;
      const tag = dv.getUint16(e, little);
      const type = dv.getUint16(e + 2, little);
      const count = dv.getUint32(e + 4, little);
      const unit = SIZE[type] || 1;
      const total = unit * count;
      const vOff = total <= 4 ? e + 8 : exif + dv.getUint32(e + 8, little);
      const vals = [];
      for (let k = 0; k < count && k < 64; k++) {
        const o = vOff + k * unit;
        if (o + unit > dv.byteLength) break;
        switch (type) {
          case 1: case 7: vals.push(dv.getUint8(o)); break;
          case 2: vals.push(String.fromCharCode(dv.getUint8(o))); break;
          case 3: vals.push(dv.getUint16(o, little)); break;
          case 4: vals.push(dv.getUint32(o, little)); break;
          // RATIONALS ARE TWO LONGS, and GPS coordinates are three of them.
          case 5: case 10: {
            const num = type === 5 ? dv.getUint32(o, little) : dv.getInt32(o, little);
            const den = type === 5 ? dv.getUint32(o + 4, little) : dv.getInt32(o + 4, little);
            vals.push(den === 0 ? 0 : num / den);
            break;
          }
          default: vals.push(0);
        }
      }
      out.set(tag, type === 2 ? vals.join("") : vals);
    }
    return out;
  };

  const ifd0 = readIFD(exif + dv.getUint32(exif + 4, little));
  const gpsPtr = ifd0.get(0x8825);
  if (!gpsPtr) return null;
  const gps = readIFD(exif + gpsPtr[0]);

  const dms = (v) => (v && v.length >= 3 ? v[0] + v[1] / 60 + v[2] / 3600 : null);
  let lat = dms(gps.get(2)), lon = dms(gps.get(4));
  if (lat === null || lon === null) return null;
  if ((gps.get(1) || "").toString().startsWith("S")) lat = -lat;
  if ((gps.get(3) || "").toString().startsWith("W")) lon = -lon;

  const altArr = gps.get(6);
  // GPSAltitudeRef 1 means BELOW sea level. Rare, but silently dropping the
  // sign would put a photograph taken in a pit above the hill beside it.
  const belowSea = (gps.get(5) || [0])[0] === 1;
  const alt = altArr && altArr.length ? (belowSea ? -altArr[0] : altArr[0]) : null;
  const dirArr = gps.get(17);
  const bearing = dirArr && dirArr.length ? dirArr[0] : null;

  // DateTimeOriginal (0x9003) lives in the Exif sub-IFD, not IFD0.
  let when = null;
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr) {
    const sub = readIFD(exif + exifPtr[0]);
    const d = sub.get(0x9003);
    if (d) when = String(d).replace(/\0+$/, "");
  }
  return { lat, lon, alt, bearing, when };
}

/**
 * Read a dropped photograph into a placed observation.
 * @param {File} file
 * @returns {Promise<{name:string, x:number, y:number, alt:number|null,
 *                    bearing:number|null, when:string|null, url:string}|null>}
 */
export async function readPhoto(file) {
  const buf = await file.arrayBuffer();
  const g = readExifGPS(buf);
  if (!g) return null;
  const { x, y } = toUTM33(g.lat, g.lon);
  return {
    name: file.name.replace(/\.[^.]+$/, ""),
    x, y, alt: g.alt, bearing: g.bearing, when: g.when,
    // An object URL, not a data URL: the bytes stay where they are and the
    // browser hands out a reference. Revoked when the set is cleared.
    url: URL.createObjectURL(file),
  };
}
