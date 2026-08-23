// @ts-check
// Minimal ZIP writer, store-only (no compression).
//
// The OBJ, its MTL and the texture are useless apart — an OBJ whose material
// file went to the downloads folder separately, or whose texture the user has
// to re-link by hand, is not really an export. They ship as one archive.
//
// Written here rather than pulled in, for the same reason three.js is vendored:
// this project has no build step and no node_modules. Store-only keeps it to
// one CRC table and no encoder — the payload is already-compressed PNG plus
// text that the user opens once, so deflate would buy little.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {Uint8Array} a .zip
 */
export function makeZip(files) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);  // local file header signature
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // UTF-8 filenames
    lv.setUint16(8, 0, true);           // method 0 = stored
    lv.setUint16(10, 0, true);          // mod time — left zero, see note below
    lv.setUint16(12, 0, true);          // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);       // compressed size == size when stored
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);          // no extra field
    lh.set(name, 30);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);  // central directory signature
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);     // offset of the local header
    ch.set(name, 46);

    local.push(lh, f.data);
    central.push(ch);
    offset += lh.length + size;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);    // end of central directory
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...local, ...central, end]) { out.set(part, at); at += part.length; }
  return out;
}
