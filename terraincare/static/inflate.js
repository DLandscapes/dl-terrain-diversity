// @ts-check
/**
 * DEFLATE (RFC 1951) and zlib (RFC 1950), decoded SYNCHRONOUSLY.
 *
 * Written because a student's 1 m DTM would not open. GDAL writes
 * `COMPRESS=DEFLATE` by default in many workflows, and the GeoTIFF reader
 * handled uncompressed rasters only — so the tool told the user to run
 * `gdal_translate`, which is a reasonable thing to say to someone who has GDAL
 * and an unreasonable thing to say to a student who has a browser.
 *
 * ⚠️ WHY NOT `DecompressionStream`, WHICH THE BROWSER ALREADY HAS: it is
 * asynchronous. `readPixels` is synchronous and is called from synchronous
 * code, and the kernel self-test suite runs the SAME modules in Node and in the
 * browser. Going async would have rippled through both. This is ~150 lines,
 * has no dependency, and runs identically in both places — which is the whole
 * posture of this tool.
 *
 * The decoder is the "puff" shape: canonical Huffman held as a count-per-length
 * array plus symbols in code order, walked one bit at a time. It is slower than
 * a table-driven inflater and it is obviously correct, which is the right trade
 * for something that must not silently return plausible wrong numbers.
 */

/** Lengths 257–285: base value and extra bits. RFC 1951 §3.2.5. */
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35,
  43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 4, 5, 5, 5, 5, 0];
/** Distance codes 0–29. */
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385,
  24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
  9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** The order code lengths are themselves written in. RFC 1951 §3.2.7. */
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14,
  1, 15];

/**
 * A canonical Huffman table: how many codes of each length, and the symbols in
 * code order.
 * @param {ArrayLike<number>} lengths code length per symbol, 0 = unused
 */
function huffman(lengths) {
  const count = new Int32Array(16);
  for (let i = 0; i < lengths.length; i++) count[lengths[i]]++;
  count[0] = 0;
  const offs = new Int32Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  const symbol = new Int32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  }
  return { count, symbol };
}

class BitReader {
  /** @param {Uint8Array} src */
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  /** One bit, least-significant first — the order DEFLATE packs them in. */
  bit() {
    if (this.bitCnt === 0) {
      if (this.pos >= this.src.length) throw new Error("deflate: out of input");
      this.bitBuf = this.src[this.pos++];
      this.bitCnt = 8;
    }
    const b = this.bitBuf & 1;
    this.bitBuf >>= 1;
    this.bitCnt--;
    return b;
  }
  /** @param {number} n */
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v;
  }
  align() { this.bitCnt = 0; }
}

/**
 * Walk the bit stream until the accumulated code matches one in the table.
 *
 * ⚠️ THE CODE IS BUILT MOST-SIGNIFICANT-BIT FIRST while the stream delivers
 * bits least-significant first. That inversion is in the format, not a bug
 * here, and getting it backwards produces a decoder that works on some streams
 * and not others.
 * @param {BitReader} br
 * @param {{count: Int32Array, symbol: Int32Array}} h
 */
function decodeSym(br, h) {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len < 16; len++) {
    code |= br.bit();
    const count = h.count[len];
    if (code - first < count) return h.symbol[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("deflate: invalid Huffman code");
}

/** The fixed tables of RFC 1951 §3.2.6, built once. */
const FIXED_LIT = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return huffman(l);
})();
const FIXED_DIST = huffman(new Uint8Array(30).fill(5));

/**
 * Inflate a raw DEFLATE stream.
 * @param {Uint8Array} src
 * @param {number} [sizeHint] expected output size, to size the buffer once
 * @returns {Uint8Array}
 */
export function inflateRaw(src, sizeHint) {
  const br = new BitReader(src);
  let out = new Uint8Array(Math.max(sizeHint || 0, 1024));
  let len = 0;
  const need = (n) => {
    if (len + n <= out.length) return;
    let cap = out.length * 2;
    while (cap < len + n) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(out.subarray(0, len));
    out = bigger;
  };

  for (;;) {
    const last = br.bit();
    const type = br.bits(2);

    if (type === 0) {
      // Stored: byte-aligned, with a length and its one's complement.
      br.align();
      if (br.pos + 4 > src.length) throw new Error("deflate: truncated stored block");
      const n = src[br.pos] | (src[br.pos + 1] << 8);
      const nn = src[br.pos + 2] | (src[br.pos + 3] << 8);
      if ((n ^ 0xffff) !== nn) throw new Error("deflate: stored block length mismatch");
      br.pos += 4;
      if (br.pos + n > src.length) throw new Error("deflate: truncated stored data");
      need(n);
      out.set(src.subarray(br.pos, br.pos + n), len);
      len += n;
      br.pos += n;
    } else if (type === 1 || type === 2) {
      let lit = FIXED_LIT, dist = FIXED_DIST;
      if (type === 2) {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        const clen = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = br.bits(3);
        const clh = huffman(clen);
        const lengths = new Uint8Array(hlit + hdist);
        let i = 0;
        while (i < lengths.length) {
          const sym = decodeSym(br, clh);
          if (sym < 16) {
            lengths[i++] = sym;
          } else if (sym === 16) {
            if (i === 0) throw new Error("deflate: repeat with no previous length");
            const prev = lengths[i - 1];
            let r = 3 + br.bits(2);
            while (r-- > 0 && i < lengths.length) lengths[i++] = prev;
          } else if (sym === 17) {
            let r = 3 + br.bits(3);
            while (r-- > 0 && i < lengths.length) lengths[i++] = 0;
          } else {
            let r = 11 + br.bits(7);
            while (r-- > 0 && i < lengths.length) lengths[i++] = 0;
          }
        }
        lit = huffman(lengths.subarray(0, hlit));
        dist = huffman(lengths.subarray(hlit));
      }

      for (;;) {
        const sym = decodeSym(br, lit);
        if (sym < 256) {
          need(1);
          out[len++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= LEN_BASE.length) throw new Error("deflate: invalid length code");
          const length = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
          const ds = decodeSym(br, dist);
          if (ds >= DIST_BASE.length) throw new Error("deflate: invalid distance code");
          const distance = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds]);
          if (distance > len) throw new Error("deflate: distance before start of output");
          need(length);
          // ⚠️ BYTE BY BYTE ON PURPOSE. Overlapping copies are legal and common
          // (that is how a run is encoded), so copyWithin / set on a subarray
          // would read bytes this very loop is still writing.
          let from = len - distance;
          for (let k = 0; k < length; k++) out[len++] = out[from++];
        }
      }
    } else {
      throw new Error("deflate: invalid block type 3");
    }
    if (last) break;
  }
  return out.subarray(0, len);
}

/**
 * Inflate a zlib stream (RFC 1950): a two-byte header, the DEFLATE data, and an
 * Adler-32 this does not check — the caller is reading a raster whose size it
 * already knows, and a short read is caught there.
 *
 * A raw DEFLATE stream is accepted too: TIFF compression 8 and 32946 are both
 * meant to be zlib-wrapped, but the header is cheap to test for and some
 * writers have omitted it.
 * @param {Uint8Array} src
 * @param {number} [sizeHint]
 * @returns {Uint8Array}
 */
export function inflate(src, sizeHint) {
  if (src.length < 2) throw new Error("deflate: stream too short");
  const cmf = src[0], flg = src[1];
  const looksZlib = (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0;
  if (!looksZlib) return inflateRaw(src, sizeHint);
  if (flg & 0x20) throw new Error("zlib: preset dictionaries are not supported");
  return inflateRaw(src.subarray(2), sizeHint);
}
