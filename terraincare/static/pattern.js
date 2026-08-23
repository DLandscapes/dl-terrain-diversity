// @ts-check
// PATTERN STAMPING — a whole field of relief placed in one operation.
//
// Every other earthwork in this tool is a gesture: a dab, a stroke, a polygon
// levelled to a datum. This one is a SPECIFICATION — a drawing of where to cut
// and where to fill, laid over the ground and applied at once. That is how
// designed micro-relief actually arrives on a site: not brushed on, but set out
// from a drawing and cut by a machine following it.
//
// The precedents are in planning/: Georges Descombes' River Aire in Geneva,
// where a lozenge matrix was cut into the valley floor and the river then
// reworked it, and Girot with Gramazio Kohler's Robotic Landscapes at ETH,
// shaping granular material with an excavator. Both are the same pair of ideas —
// a designed pattern, and ground that will not hold it exactly. This module is
// the first half; the substrate map and the angle of repose are the second.
//
// TWO SOURCES, ONE PIPELINE. A pattern is any field of numbers in 0..1 laid
// over the ground:
//
//   an IMAGE      — a drawing, black to white, resampled onto the grid
//   a GENERATED   — a band-limited random field at a stated wavelength
//     field
//
// The second is not a decoration on the first. It is the microrelief model the
// tolerance sweep was run with (output/FINDING-species-model-limits.md), and
// putting it behind the same amplitude and bias controls is what makes that
// finding something you can DO rather than something you have to be told:
// set a four-metre wavelength, drag the amplitude from 10 mm to 100 mm — a
// tenfold change in grading accuracy — and watch the Shannon index refuse to
// move off 0.44.
//
// ⚠️ A STAMP IS NOT VOLUME-NEUTRAL IN GENERAL, and the ledger says so rather
// than correcting for it. It is neutral exactly when the biased field averages
// zero over the cells it touches, which a symmetric pattern at the default bias
// very nearly is and a hand-drawn one is not. Same honesty as the smooth brush
// (brush.js) and polygon levelling (polygon.js): the asymmetry is the quantity
// earthworks are costed on, and hiding it behind a silent correction would mean
// quietly raising or lowering the whole area to force the books to balance.

/** Mid-grey: the value at which a pattern moves no earth. */
export const NEUTRAL = 0.5;

/**
 * Rec. 709 luma from an RGBA buffer, as a 0..1 field.
 *
 * ⚠️ ABSOLUTE, NOT STRETCHED TO THE IMAGE'S OWN RANGE. A pattern is a drawing,
 * and the grey levels in it ARE the specification: mid-grey means "leave this
 * ground alone". Re-stretching per image would make the same drawing mean
 * different things depending on whether the author happened to include one
 * black pixel somewhere — and would turn a deliberately shallow pattern into a
 * full-amplitude one silently. Contrast is adjusted afterwards, by the handles,
 * where the user can see what they are doing.
 *
 * Alpha is composited over mid-grey rather than ignored, so a PNG with a
 * transparent background leaves that ground untouched instead of stamping it
 * with whatever colour happens to sit in the unused RGB channels.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} w @param {number} h
 * @returns {Float32Array} w*h values in 0..1
 */
export function fieldFromRGBA(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const luma = (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) / 255;
    const a = rgba[p + 3] / 255;
    out[i] = luma * a + NEUTRAL * (1 - a);
  }
  return out;
}

/**
 * Deterministic PRNG. The generated field has to be reproducible from its seed:
 * a figure in the poster or a number in the abstract that cannot be regenerated
 * is not a measurement. Same requirement the clock injection was built for.
 * @param {number} seed
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smoothstep. Cubic, so the interpolated field has a continuous first
 *  derivative and therefore a defined slope everywhere — which matters,
 *  because slope is one of the axes the species model reads. */
const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * A band-limited random field at a stated wavelength, normalised to 0..1.
 *
 * ⚠️ WAVELENGTH IS A REAL LENGTH, AND THIS IS THE WHOLE METHOD. Per-cell white
 * noise would make every 0.25 m cell its own pit and simply recreate the
 * salt-and-pepper artefact in a new place — it is not a model of a graded
 * surface. A grader blade is metres wide, so the relief it leaves is metres
 * across. Random heights are drawn on a coarse lattice at the wavelength and
 * smoothstep-interpolated between them.
 *
 * ⚠️ REPORT THE WAVELENGTH ALONGSIDE ANY AMPLITUDE. It matters more than the
 * amplitude does: at ±25 mm the measured Shannon index runs 0.266 at a 1.5 m
 * wavelength, 0.460 at 4 m and 0.560 at 8 m. An amplitude on its own is not a
 * reproducible statement about a surface.
 *
 * Normalised over the stamped cells rather than the whole grid, so a pattern
 * confined to a small region still reaches the amplitude that was asked for.
 *
 * @param {number} nrows @param {number} ncols
 * @param {number} cell ground units
 * @param {number} wavelength ground units between lattice nodes
 * @param {number} seed
 * @param {{mask?: Uint8Array|null}} [opts]
 * @returns {Float32Array} nrows*ncols values in 0..1
 */
export function generatedField(nrows, ncols, cell, wavelength, seed, opts = {}) {
  const out = new Float32Array(nrows * ncols);
  const step = Math.max(1e-6, wavelength) / cell;          // lattice spacing, in cells
  const gw = Math.max(2, Math.ceil(ncols / step) + 2);
  const gh = Math.max(2, Math.ceil(nrows / step) + 2);
  const rnd = mulberry32(seed);
  const node = new Float32Array(gw * gh);
  for (let i = 0; i < node.length; i++) node[i] = rnd();

  for (let r = 0; r < nrows; r++) {
    const fy = r / step, y0 = Math.floor(fy);
    const ty = smoothstep(fy - y0);
    for (let c = 0; c < ncols; c++) {
      const fx = c / step, x0 = Math.floor(fx);
      const tx = smoothstep(fx - x0);
      const n00 = node[y0 * gw + x0], n10 = node[y0 * gw + x0 + 1];
      const n01 = node[(y0 + 1) * gw + x0], n11 = node[(y0 + 1) * gw + x0 + 1];
      const top = n00 + (n10 - n00) * tx;
      const bot = n01 + (n11 - n01) * tx;
      out[r * ncols + c] = top + (bot - top) * ty;
    }
  }

  // Normalise across exactly the cells that will be stamped.
  const mask = opts.mask || null;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < out.length; i++) {
    if (mask && !mask[i]) continue;
    const v = out[i];
    if (v < lo) lo = v; if (v > hi) hi = v;
  }
  if (!(hi > lo)) { out.fill(NEUTRAL); return out; }
  const span = hi - lo;
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.min(1, Math.max(0, (out[i] - lo) / span));
  }
  return out;
}

/* ------------------------------------------------------------ the library */

/**
 * THE PATTERN LIBRARY.
 *
 * ⚠️ THIS IS NOT A SET OF TEXTURES. The re-measurement of 2026-08-06
 * (output/FINDING-redifferentiation-remeasured.md) found that at IDENTICAL
 * amplitude, wavelength and earthwork volume, a lozenge matrix returns all seven
 * habitat classes and 29 % invasive cover where undirected undulation returns
 * three classes and 75 %. Same material, same relief, same cost — two and a half
 * times the invasive cover, purely from where the material was put. The choice of
 * pattern is therefore the single most consequential decision this tool offers,
 * and a library of them is an argument rather than a convenience.
 *
 * Every entry is PROCEDURAL, not a bitmap: it stays sharp at any cell size, it is
 * reproducible from its parameters, and it can be quoted in a specification as
 * "lozenge matrix, 8 m module, ±0.21 m" — which a raster cannot.
 *
 * Each takes ground coordinates in METRES and the module in metres, and returns
 * 0..1 where 0.5 moves no earth. `seeded` entries also take a PRNG.
 *
 * ⚠️ ORDER IS DISPLAY ORDER ONLY — nothing keys off the index. `id` is the
 * stable name and goes into the provenance record, so APPEND, never insert.
 *
 * @typedef {Object} PatternDef
 * @property {string} id
 * @property {string} name    what the picker shows
 * @property {string} note    the reference, or what it is for
 * @property {boolean} [seeded]
 * @property {(x:number, y:number, m:number, rnd:(gx:number,gy:number)=>number) => number} fn
 */

/** Triangle wave, 0..1 over one period — the shape a blade leaves, not a sine. */
const tri = (t) => { const f = t - Math.floor(t); return f < 0.5 ? 2 * f : 2 - 2 * f; };

/** Value noise on a lattice, smoothstep-interpolated. Shared by the seeded
 *  patterns so they all band-limit at the module rather than per cell. */
function latticeNoise(x, y, m, rnd) {
  const fx = x / m, fy = y / m;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = smoothstep(fx - x0), ty = smoothstep(fy - y0);
  const a = rnd(x0, y0), b = rnd(x0 + 1, y0);
  const c = rnd(x0, y0 + 1), d = rnd(x0 + 1, y0 + 1);
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
}

/** @type {PatternDef[]} */
export const PATTERNS = [
  {
    id: "lozenge",
    name: "Lozenge matrix",
    // ⚠️ NO FIGURES IN THE PROSE. They live in PATTERN_MEASURED, which the picker
    // prints underneath — a number in both places is a number that will disagree
    // with itself the first time either is re-measured.
    note: "Descombes, River Aire — a cut matrix the river then reworked. Exactly "
      + "volume-neutral, and the pattern the abstract's redesign figure was made with.",
    fn: (x, y, m) => 0.5 + 0.5 * Math.sin(2 * Math.PI * x / m) * Math.sin(2 * Math.PI * y / m),
  },
  {
    id: "pitmound",
    name: "Pit and mound",
    note: "Treethrow microrelief: each hollow with its own spoil heaped beside "
      + "it, scattered and paired. The local cut/fill pairing is the point.",
    // ⚠️ THIS WAS FIRST WRITTEN AS A LOZENGE WITH A TONE CURVE — sharp pits and
    // broad mounds off the same product of sines — and self-test group U caught
    // it at 0.989 correlation with the lozenge itself. That is the failure the
    // group exists to prevent: a library of twelve patterns is only an argument
    // if the twelve are actually different. Real treethrow relief is not a
    // regular alternation, it is a PAIR — a pit and the mound that came out of
    // it, adjacent, at a random orientation, scattered rather than tiled.
    seeded: true,
    fn: (x, y, m, rnd) => {
      const gx0 = Math.floor(x / m), gy0 = Math.floor(y / m);
      let v = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = gx0 + dx, gy = gy0 + dy;
          const px = (gx + 0.2 + 0.6 * rnd(gx + 7, gy + 13)) * m;
          const py = (gy + 0.2 + 0.6 * rnd(gx + 41, gy + 59)) * m;
          const rp = Math.hypot(x - px, y - py) / (m * 0.26);
          if (rp < 1) v -= Math.cos(Math.PI * rp * 0.5);
          // The spoil, thrown clear of its own hole in one direction.
          const ang = rnd(gx + 101, gy + 149) * Math.PI * 2;
          const mx = px + Math.cos(ang) * m * 0.34;
          const my = py + Math.sin(ang) * m * 0.34;
          const rm = Math.hypot(x - mx, y - my) / (m * 0.30);
          if (rm < 1) v += 0.75 * Math.cos(Math.PI * rm * 0.5);
        }
      }
      return 0.5 + 0.5 * Math.max(-1, Math.min(1, v));
    },
  },
  {
    id: "hollows",
    name: "Scattered hollows",
    note: "Discrete pits on a jittered lattice. Designed but not regular — the "
      + "case for when a visible grid would read as engineering.",
    seeded: true,
    fn: (x, y, m, rnd) => {
      const gx = Math.floor(x / m), gy = Math.floor(y / m);
      let best = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = (gx + dx + 0.25 + 0.5 * rnd(gx + dx, gy + dy)) * m;
          const cy = (gy + dy + 0.25 + 0.5 * rnd(gx + dx, gy + dy + 977)) * m;
          const r = Math.hypot(x - cx, y - cy) / (m * 0.38);
          if (r < 1) { const w = Math.cos(Math.PI * r * 0.5); if (w > best) best = w; }
        }
      }
      return 0.5 - 0.5 * best;   // hollows only: cut, with the spoil going elsewhere
    },
  },
  {
    id: "hexbasins",
    name: "Hexagonal basins",
    note: "Three sine waves at 60°: close-packed hollows, the most edge per unit "
      + "area of any regular tiling.",
    fn: (x, y, m) => {
      const k = 2 * Math.PI / m;
      const a = Math.sin(k * x);
      const b = Math.sin(k * (x * 0.5 + y * 0.8660254));
      const c = Math.sin(k * (x * 0.5 - y * 0.8660254));
      return 0.5 + 0.5 * ((a + b + c) / 3) * 1.5;
    },
  },
  {
    id: "furrows",
    name: "Ridge and furrow",
    note: "Parallel channels, the oldest earthwork pattern there is. Directional: "
      + "it drains one way and holds nothing across.",
    fn: (x, y, m) => 0.5 + 0.5 * Math.sin(2 * Math.PI * x / m),
  },
  {
    id: "swaleberm",
    name: "Swale and berm",
    note: "The SUDS section: a flat-bottomed infiltration swale with a berm on one "
      + "side. Asymmetric, unlike a sine.",
    fn: (x, y, m) => {
      const t = (x / m) - Math.floor(x / m);
      // flat swale floor over the first third, then a rising berm
      if (t < 0.34) return 0.16;
      const u = (t - 0.34) / 0.66;
      return 0.16 + 0.84 * Math.sin(Math.PI * u);
    },
  },
  {
    id: "terraces",
    name: "Terraces",
    note: "Contour-parallel benches. Quantised, not smooth — the risers are the "
      + "habitat and the treads are the platform.",
    fn: (x, y, m) => {
      const steps = 5;
      const t = (y / (m * steps)) - Math.floor(y / (m * steps));
      return Math.floor(t * steps) / (steps - 1);
    },
  },
  {
    id: "chevron",
    name: "Chevron",
    note: "Zigzag furrows. Lengthens every flow path across the fall line without "
      + "closing it, so water is slowed rather than held.",
    fn: (x, y, m) => 0.5 + 0.5 * Math.sin(2 * Math.PI * (x + m * tri(y / m)) / m),
  },
  {
    id: "braided",
    name: "Braided channels",
    note: "Two channel sets at slightly different periods, anastomosing where they "
      + "cross. The river pattern that makes bars and backwaters.",
    fn: (x, y, m) => {
      const a = Math.sin(2 * Math.PI * (x + 0.35 * m * Math.sin(2 * Math.PI * y / (m * 3))) / m);
      const b = Math.sin(2 * Math.PI * (x * 0.94 - 0.3 * m * Math.sin(2 * Math.PI * y / (m * 2.2))) / m);
      return 0.5 + 0.5 * Math.min(a, b);
    },
  },
  {
    id: "dendritic",
    name: "Dendritic valleys",
    note: "Ridged noise: the branching valley network erosion produces. Irregular "
      + "at every scale, and the closest of these to unworked ground.",
    seeded: true,
    fn: (x, y, m, rnd) => {
      let v = 0, amp = 1, norm = 0, mm = m;
      for (let o = 0; o < 3; o++) {
        v += amp * (1 - Math.abs(2 * latticeNoise(x, y, mm, rnd) - 1));
        norm += amp; amp *= 0.5; mm *= 0.5;
      }
      return v / norm;
    },
  },
  {
    id: "concentric",
    name: "Concentric basins",
    note: "Rings about a centre — the constructed wetland cell, and the one "
      + "pattern here with a single focus rather than a field.",
    fn: (x, y, m) => 0.5 + 0.5 * Math.sin(2 * Math.PI * Math.hypot(x - 32, y - 32) / m),
  },
  {
    id: "undulation",
    name: "Undulation",
    note: "Band-limited random relief — the model a graded surface actually leaves, "
      + "and the CONTROL the designed patterns are read against. Relief without a "
      + "pattern; only terracing does worse.",
    seeded: true,
    fn: (x, y, m, rnd) => latticeNoise(x, y, m, rnd),
  },
  // ══ APPENDED 2026-08-19 ═══════════════════════════════════════════════════
  // ⚠️ APPENDED, NEVER INSERTED. The ids go into the provenance record of every
  // export, so this list may grow at the end and may not be reordered or
  // renamed. The RANGE Marc asked for — from geometric with little consequence
  // up to strongly differentiating — is therefore expressed by PATTERN_RANGE
  // below, which is an ordering OVER this list rather than a reordering OF it.
  {
    id: "grid",
    name: "Orthogonal grid",
    note: "Flat pans inside a rectilinear kerb, one scale and one orientation — "
      + "the most engineered thing that can be drawn on ground, and the low end "
      + "of the range on purpose.",
    fn: (x, y, m) => {
      const dx = Math.abs(((x / m) % 1 + 1) % 1 - 0.5) * 2;
      const dy = Math.abs(((y / m) % 1 + 1) % 1 - 0.5) * 2;
      const e = Math.max(dx, dy);
      return smoothstep(Math.min(1, Math.max(0, (e - 0.55) / 0.35)));
    },
  },
  {
    id: "plateau",
    name: "Plateau and scarp",
    note: "Broad flat tables separated by abrupt faces — almost all of the area "
      + "is level and almost all of the difference is at the edges, which is how "
      + "a cut-and-fill platform scheme actually behaves.",
    seeded: true,
    fn: (x, y, m, rnd) => {
      const v = latticeNoise(x, y, m * 2, rnd);
      return smoothstep(Math.min(1, Math.max(0, (v - 0.42) / 0.16)));
    },
  },
  {
    id: "terracette",
    name: "Terracettes",
    note: "The fine stepping soil creep and stock leave on a grazed slope: many "
      + "small contour steps rather than a few engineered ones. The same "
      + "operation as terracing, at a twentieth of the scale.",
    seeded: true,
    fn: (x, y, m, rnd) => {
      const step = m / 4;
      const jitter = 0.35 * step * (latticeNoise(x, y, m * 3, rnd) - 0.5) * 2;
      const t = (y + jitter) / step;
      const f = ((t % 1) + 1) % 1;
      // A tread that is nearly level, then a short riser — not a sawtooth.
      return f < 0.7 ? smoothstep(f / 0.7) * 0.12 : 0.12 + smoothstep((f - 0.7) / 0.3) * 0.88;
    },
  },
  {
    id: "hummock",
    name: "Hummock and hollow",
    note: "Mire microtopography — rounded peat hummocks standing in saturated "
      + "hollows. Two habitats a hand's breadth apart, and the classic case for "
      + "relief far below the resolution of any terrain survey.",
    seeded: true,
    fn: (x, y, m, rnd) => {
      const gx0 = Math.floor(x / m), gy0 = Math.floor(y / m);
      let v = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = gx0 + dx, gy = gy0 + dy;
          for (let k = 0; k < 2; k++) {
            const cx = (gx + 0.15 + 0.7 * rnd(gx + k * 17, gy + k * 23)) * m;
            const cy = (gy + 0.15 + 0.7 * rnd(gx + k * 31, gy + k * 37)) * m;
            const rr = Math.hypot(x - cx, y - cy) / (m * 0.30);
            if (rr < 1) v += Math.cos(Math.PI * rr * 0.5) ** 2;
          }
        }
      }
      return 0.5 + 0.5 * Math.max(-1, Math.min(1, v * 1.1 - 0.55));
    },
  },
  {
    id: "kettles",
    name: "Kettle holes",
    note: "Sparse, deep, closed hollows in otherwise broad ground — the relict "
      + "of buried ice. Most of the area is untouched and the few that exist "
      + "hold water all season, which is where the differentiation comes from.",
    seeded: true,
    fn: (x, y, m, rnd) => {
      const M = m * 2;
      const gx0 = Math.floor(x / M), gy0 = Math.floor(y / M);
      let v = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = gx0 + dx, gy = gy0 + dy;
          // Only about one lattice cell in three carries one.
          if (rnd(gx + 5, gy + 11) > 0.38) continue;
          const cx = (gx + 0.2 + 0.6 * rnd(gx + 71, gy + 89)) * M;
          const cy = (gy + 0.2 + 0.6 * rnd(gx + 97, gy + 103)) * M;
          const rr = Math.hypot(x - cx, y - cy) / (M * 0.26);
          if (rr < 1) v -= Math.cos(Math.PI * rr * 0.5) ** 0.7;
        }
      }
      return 0.5 + 0.5 * Math.max(-1, Math.min(1, v));
    },
  },
  {
    id: "basinrange",
    name: "Basin and range",
    note: "Long sinuous ridges with broad basins between them, at twice the "
      + "module of everything else here — the coarsest member of the library, "
      + "and the one that differentiates by exposure and sun rather than wetness.",
    fn: (x, y, m) => {
      const M = m * 2;
      const bend = 0.35 * M * Math.sin(2 * Math.PI * y / (M * 3));
      return 0.5 + 0.5 * Math.sin(2 * Math.PI * (x + bend) / M);
    },
  },
];

/** id -> definition. Nothing indexes the array directly. */
export const PATTERN_BY_ID = Object.fromEntries(PATTERNS.map((p) => [p.id, p]));

/**
 * WHAT EACH PATTERN ACTUALLY DID, measured 2026-08-06.
 *
 * ⚠️ ONE TABLE, ONE SET OF CONDITIONS. The figures live here rather than in each
 * pattern's prose so that the conditions are stated once and cannot drift apart
 * from one another — the same reason `ramps.js` holds every colour.
 *
 * CONDITIONS: the 64 m Ørndalen design patch levelled to its own mean (836 m³ cut
 * and 836 m³ fill), then stamped at ±0.21 m on an 8 m module, seed 1, no
 * substrate specified. Measured through the running app on a full settle.
 * Control, as surveyed: H′ 1.721, 7 of 7 classes, 33.2 % invasive.
 *
 * ⚠️ EVERY ONE OF THESE IS EXACTLY VOLUME-NEUTRAL — cut equals fill to the cubic
 * metre — because patterns are centred on their own mean. That is what makes the
 * table a fair comparison rather than a list: same amplitude, same module, same
 * earthwork moved, and the ONLY variable left is where the material was put.
 * (An earlier min-max normalisation broke this; see the note in proceduralField.)
 *
 * ⚠️ THESE ARE ONE SITE AT ONE AMPLITUDE AND ONE MODULE. They rank the patterns
 * against each other under identical conditions, which is what they are for; they
 * are not a general claim that a chevron suppresses lupin. Habitat response is
 * not monotonic in amplitude (see FINDING-redifferentiation-remeasured.md), so
 * these must be re-measured, not interpolated, if the conditions change.
 *
 * THE RESULT WORTH KNOWING: Shannon runs from 0.163 to 1.724 and invasive cover
 * from 4 % to 97 % — a tenfold spread in habitat outcome from the choice of
 * pattern alone, at identical cost. The lozenge matches the SURVEYED ground's
 * diversity (1.724 against 1.721) while moving a fifth of what levelling moved.
 *
 * ⚠️ TERRACES ARE THE WORST OF THE TWELVE, worse even than leaving the surface
 * levelled-to-tolerance. That is not a defect in the pattern, it is the finding:
 * a terrace is a series of small level platforms, so it is levelling repeated at
 * a smaller scale. The most conventionally "designed-looking" option here is the
 * one that reproduces the problem it was meant to solve.
 *
 * @type {Record<string, {H:number, classes:number, invasive:number, cut:number, fill:number}>}
 */
/**
 * The library as a RANGE, from geometric-with-little-consequence up to strongly
 * differentiating (Marc, 2026-08-19).
 *
 * ⚠️ AN ORDERING OVER `PATTERNS`, NOT A REORDERING OF IT. The ids travel in the
 * provenance record of every export, so that list may be appended to and never
 * resorted. This is the axis; that is the registry.
 *
 * ⚠️ EVERY ENTRY IS NOW MEASURED (2026-08-19). The six appended that day went
 * through the same protocol as the twelve, so nothing here is placed by opinion.
 * ⚠️ AND THE MEASUREMENT OVERTURNED HALF THE EXPECTATIONS IT REPLACED. `grid`
 * was declared the bottom of the range — "the most engineered thing that can be
 * drawn on ground" — and measures FIFTEENTH OF EIGHTEEN at H′ 1.521.
 * `terracette` was put mid-range and came out top of the six at 1.546, holding
 * the invasive to 2.1 % — the lowest figure any pattern in this library has
 * produced, at a third of the lozenge's earthwork. Two of six were placed
 * roughly right; four were not. That is the argument for measuring.
 *
 * ⚠️ NOTE WHAT THE MEASURED HALF ACTUALLY SAYS, because it is the interesting
 * part: GEOMETRIC AND LOW-DIFFERENTIATION ARE NOT THE SAME AXIS. The lozenge is
 * a pure product of two sines — as regular as anything here — and it tops the
 * range at H′ 1.724, while terraces, equally regular, sit at the bottom at
 * 0.163. What separates them is not regularity, it is whether the operation
 * holds difference at the scale the landform has. That is the Phase 8E result,
 * and this ordering is where a designer meets it first.
 *
 * @type {{id: string, basis: "measured"|"expected"}[]}
 */
// ⚠️ NOT RE-SORTED AFTER THE 2026-08-20 RE-MEASUREMENT, AND THAT IS A DECISION.
// The single-build run put `concentric` (1.534) a hair above `grid` (1.521),
// inverting the one pair below. It was left alone, for two reasons that both
// have to hold:
//   1. 0.013 is INSIDE the band this table says it cannot resolve. The twelve
//      re-measured rows moved by up to 0.040 with nothing changed but the
//      build, so ordering these two on 0.013 would be acting on noise —
//      precisely the false precision this project refuses everywhere else.
//   2. IT WOULD SILENTLY CHANGE THE OPENING TILE. `demotile.js` samples
//      sixteen of these eighteen evenly, and `concentric` is one of the two it
//      currently drops; swapping the pair would put concentric into the tile
//      and take grid out, moving every published opening figure — relief,
//      geodiversity, Shannon, hollows — for a difference that is not real.
// If a future measurement separates them by more than ~0.05, reorder then, and
// re-measure the opening tile in the same breath.
export const PATTERN_RANGE = [
  { id: "terraces",   basis: "measured" },
  { id: "kettles",    basis: "measured" },
  { id: "plateau",    basis: "measured" },
  { id: "swaleberm",  basis: "measured" },
  { id: "undulation", basis: "measured" },
  { id: "basinrange", basis: "measured" },
  { id: "dendritic",  basis: "measured" },
  { id: "hummock",    basis: "measured" },
  { id: "pitmound",   basis: "measured" },
  { id: "hexbasins",  basis: "measured" },
  { id: "furrows",    basis: "measured" },
  { id: "hollows",    basis: "measured" },
  { id: "chevron",    basis: "measured" },
  { id: "concentric", basis: "measured" },
  { id: "grid",       basis: "measured" },
  { id: "terracette", basis: "measured" },
  { id: "braided",    basis: "measured" },
  { id: "lozenge",    basis: "measured" },
];

/** Where a pattern sits on the range, 0 (least) to 1 (most). -1 if unlisted. */
export function patternRank(id) {
  const i = PATTERN_RANGE.findIndex((e) => e.id === id);
  return i < 0 ? -1 : i / (PATTERN_RANGE.length - 1);
}

export const PATTERN_MEASURED = {
  // ══ ALL EIGHTEEN, RE-MEASURED ON ONE BUILD, 2026-08-20 ════════════════════
  // The owed work from phase 11 §3d. Every figure below comes from a single
  // uninterrupted run on one build, through the running app: the surveyed fill
  // patch → levelled to its own mean via a full-tile region with the batter off
  // → each pattern stamped on that same levelled ground at ±0.2102 m on an 8 m
  // module → settled → the figures the sidebar itself displays.
  //
  // ⚠️ THE HARNESS WAS VALIDATED BEFORE IT WAS TRUSTED, which is the only reason
  // these numbers are worth anything. Four controls, all reproduced:
  //   surveyed control  H′ 1.721 · 7 of 7 · 33.2 % invasive   (exact)
  //   levelling cost    836.1 m³ cut and 836.1 m³ fill        (published 836)
  //   levelled state    H′ 0.000 · 1 class · 100 % invasive   (exact)
  //   lozenge re-run    1.726 · 7 · 24.7 % · 176.7 m³         (phase 11: 177)
  // and two invariants held across all eighteen rows: every reading agreed with
  // the ledger object behind the panel, and every row is volume-neutral to
  // better than 0.15 m³.
  //
  // ⚠️ THE MIXED-VINTAGE CAVEAT IS RETIRED, AND THE RUN MEASURED THE DRIFT IT
  // WARNED ABOUT. The six patterns already measured on this build reproduced to
  // ZERO on every axis — max |ΔH′| 0.000, mean Δinvasive 0.00 pp. The twelve
  // carried over from phase 7 ALL moved, and all in the same direction: mean
  // ΔH′ +0.013 (largest, hexbasins, +0.040), mean invasive −0.63 pp, mean volume
  // +4.3 m³. So the caveat was real, it was correctly characterised, and it is
  // now spent. These figures are one build, one amplitude, one module, one tile.
  //
  // ⚠️ WHAT SURVIVED, WHICH IS EVERYTHING THAT WAS EVER CLAIMED FROM THIS TABLE:
  // terraces still bottom at 0.163 and lozenge still top at 1.726; terracette
  // still holds the invasive to 2.1 %, the lowest in the library, at a third of
  // the lozenge's earthwork; grid still sits high, not at the bottom where
  // intuition put it; and terracette still scores about NINE TIMES terraces
  // (1.546 against 0.163) though they are the same operation at different
  // scales. Only one rank changed and one class count changed — see below.
  //
  // ⚠️ RANKS SEPARATED BY LESS THAN ~0.05 IN H′ ARE STILL NOT DISTINGUISHED, and
  // now there is direct evidence for the band rather than an estimate: the
  // twelve re-measured rows moved by up to 0.040 with nothing changed but the
  // build. `grid` (1.521), `concentric` (1.534), `terracette` (1.546) and
  // `braided` (1.569) are ONE CLUSTER, not four places.
  lozenge:    { H: 1.726, classes: 7, invasive: 24.7, cut: 176.7, fill: 176.7 },
  braided:    { H: 1.569, classes: 7, invasive: 38.8, cut: 152.4, fill: 152.4 },
  terracette: { H: 1.546, classes: 7, invasive: 2.1,  cut: 115.5, fill: 115.5 },
  concentric: { H: 1.534, classes: 7, invasive: 43.6, cut: 270.1, fill: 270.1 },
  grid:       { H: 1.521, classes: 7, invasive: 38.7, cut: 323.4, fill: 323.4 },
  chevron:    { H: 1.409, classes: 7, invasive: 4.2,  cut: 275.8, fill: 275.8 },
  hollows:    { H: 1.228, classes: 7, invasive: 63.7, cut: 138.3, fill: 138.3 },
  furrows:    { H: 1.146, classes: 6, invasive: 55.6, cut: 275.8, fill: 275.8 },
  hexbasins:  { H: 1.016, classes: 7, invasive: 65.8, cut: 157.9, fill: 157.9 },
  pitmound:   { H: 0.993, classes: 7, invasive: 73.7, cut: 72.4,  fill: 72.4 },
  hummock:    { H: 0.969, classes: 7, invasive: 71.6, cut: 77.5,  fill: 77.5 },
  dendritic:  { H: 0.914, classes: 7, invasive: 69.7, cut: 104.3, fill: 104.3 },
  basinrange: { H: 0.779, classes: 7, invasive: 56.7, cut: 274.1, fill: 274.1 },
  undulation: { H: 0.588, classes: 3, invasive: 74.1, cut: 134.1, fill: 134.1 },
  swaleberm:  { H: 0.503, classes: 4, invasive: 85.1, cut: 268.4, fill: 268.4 },
  plateau:    { H: 0.293, classes: 7, invasive: 93.0, cut: 178.2, fill: 178.2 },
  kettles:    { H: 0.274, classes: 7, invasive: 94.8, cut: 36.6,  fill: 36.6 },
  // ⚠️ TERRACES NOW SUPPORTS FIVE CLASSES, NOT FOUR. The one class count that
  // changed, and it is the pattern the strongest finding rests on. It does not
  // soften that finding — H′ is unmoved at 0.163, still the lowest in the
  // library and still below undirected undulation — but a table that quietly
  // kept saying 4 would be wrong about the row it is most often quoted for.
  terraces:   { H: 0.163, classes: 5, invasive: 96.8, cut: 203.9, fill: 203.9 },
};

/**
 * Build a library pattern onto the DEM grid, normalised to 0..1 over the cells
 * that will actually be stamped.
 *
 * Coordinates are in metres from the grid's south-west corner, so the module is
 * a real ground length and a pattern quoted as "8 m" is 8 m on site.
 *
 * @param {string} id
 * @param {number} nrows @param {number} ncols @param {number} cell
 * @param {{module?:number, seed?:number, mask?:Uint8Array|null}} [opts]
 * @returns {Float32Array}
 */
export function proceduralField(id, nrows, ncols, cell, opts = {}) {
  const def = PATTERN_BY_ID[id] || PATTERN_BY_ID.lozenge;
  const m = Math.max(cell, opts.module ?? 8);
  const seed = opts.seed ?? 1;
  const out = new Float32Array(nrows * ncols);

  // A lattice-indexed PRNG rather than a sequential one: a seeded pattern must
  // give the same value for the same lattice node however the grid is scanned,
  // or the field would change when the stamped window does.
  const rnd = (gx, gy) => {
    let h = (gx | 0) * 374761393 + (gy | 0) * 668265263 + seed * 2246822519;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  const northY = nrows * cell;
  for (let r = 0; r < nrows; r++) {
    const y = northY - (r + 0.5) * cell;
    for (let c = 0; c < ncols; c++) {
      out[r * ncols + c] = def.fn((c + 0.5) * cell, y, m, rnd);
    }
  }

  // ⚠️ CENTRED ON THE PATTERN'S OWN MEAN, NOT STRETCHED MIN-TO-MAX — and the
  // difference is not cosmetic. Min-max normalisation maps the LOWEST value to
  // full cut and the highest to full fill, which is right only for a pattern
  // that is symmetric about its middle. "Scattered hollows" is mostly
  // undisturbed ground with occasional pits, so min-max put the undisturbed
  // ground at full FILL: measured, it moved 82 m³ of cut against 571 m³ of fill,
  // i.e. it raised the entire site by half a metre and dimpled it. The picker
  // showed it too — the swatch was solid red with blue dots instead of neutral
  // with blue dots.
  //
  // Centring on the mean makes `amplitude` mean what it says: peak deviation
  // FROM THE UNDISTURBED SURFACE. It also makes every pattern volume-neutral by
  // construction at the default bias, so any net import a stamp reports is a
  // decision the user made with the handles rather than an artefact of how the
  // generator happened to be scaled.
  const mask = opts.mask || null;
  let sum = 0, n = 0;
  for (let i = 0; i < out.length; i++) {
    if (mask && !mask[i]) continue;
    sum += out[i]; n++;
  }
  if (!n) { out.fill(NEUTRAL); return out; }
  const mean = sum / n;
  let dev = 0;
  for (let i = 0; i < out.length; i++) {
    if (mask && !mask[i]) continue;
    const d = Math.abs(out[i] - mean);
    if (d > dev) dev = d;
  }
  if (!(dev > 0)) { out.fill(NEUTRAL); return out; }
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.min(1, Math.max(0, NEUTRAL + 0.5 * (out[i] - mean) / dev));
  }
  return out;
}

/**
 * Put a source field onto the DEM grid, over a target window, by BILINEAR
 * interpolation.
 *
 * ⚠️ BILINEAR, WHERE THE SUBSTRATE LAYER IS NEAREST — and the two are opposite
 * for the same reason. A substrate map holds class codes, so interpolating
 * between 2 and 4 would invent class 3. A pattern holds elevation, which is
 * continuous, and nearest-neighbour would terrace the result at the source
 * image's pixel pitch: a 64-pixel drawing over a 256-cell patch would arrive as
 * 1 m steps, which the analysis would then faithfully report as real
 * micro-relief. The stair edges would be an artefact of the resampler reading
 * as a finding.
 *
 * ⚠️ THE FIT IS COVER, NOT CONTAIN. The source is scaled to fill the window and
 * centre-cropped, preserving aspect. Fitting inside instead would leave bands
 * of ground at exactly the neutral value — untouched, correct, and looking
 * exactly like a bug. Aspect is preserved either way: stretching a pattern to a
 * non-square window would change the wavelength along one axis only, which is
 * the one property of a pattern this tool has measured as decisive.
 *
 * Cells outside the window are left NEUTRAL, so they move no earth.
 *
 * @param {Float32Array} src @param {number} sw @param {number} sh
 * @param {number} nrows @param {number} ncols
 * @param {{r0?:number, c0?:number, r1?:number, c1?:number}} [win] inclusive
 * @returns {Float32Array}
 */
export function resampleField(src, sw, sh, nrows, ncols, win = {}) {
  const out = new Float32Array(nrows * ncols).fill(NEUTRAL);
  if (sw < 1 || sh < 1) return out;
  const r0 = Math.max(0, win.r0 ?? 0), c0 = Math.max(0, win.c0 ?? 0);
  const r1 = Math.min(nrows - 1, win.r1 ?? nrows - 1);
  const c1 = Math.min(ncols - 1, win.c1 ?? ncols - 1);
  if (r1 < r0 || c1 < c0) return out;

  const wCells = c1 - c0 + 1, hCells = r1 - r0 + 1;
  // Cover: the smaller of the two scales would leave a gap, so take the larger.
  const scale = Math.max(sw / wCells, sh / hCells);
  // Centre the crop: the source pixel at the middle of the window is the source
  // image's own middle, whichever axis is being cropped.
  const offX = (sw - wCells * scale) / 2;
  const offY = (sh - hCells * scale) / 2;

  for (let r = r0; r <= r1; r++) {
    const sy = Math.min(sh - 1, Math.max(0, offY + (r - r0 + 0.5) * scale - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
    for (let c = c0; c <= c1; c++) {
      const sx = Math.min(sw - 1, Math.max(0, offX + (c - c0 + 0.5) * scale - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
      const v00 = src[y0 * sw + x0], v10 = src[y0 * sw + x1];
      const v01 = src[y1 * sw + x0], v11 = src[y1 * sw + x1];
      const top = v00 + (v10 - v00) * tx;
      const bot = v01 + (v11 - v01) * tx;
      out[r * ncols + c] = top + (bot - top) * ty;
    }
  }
  return out;
}

/**
 * Map a raw 0..1 field value to signed displacement in −1..+1.
 *
 * `lo` and `hi` are the two triangle handles, and they are an INPUT LEVELS
 * control, exactly like the percentile handles on an analysis legend: the grey
 * at `lo` becomes full cut, the grey at `hi` becomes full fill, and everything
 * between is stretched across the range.
 *
 * That single control does both of the things a stamp needs, which is why it is
 * two handles rather than two separate sliders:
 *
 *   - dragging them APART or TOGETHER changes the contrast of the pattern —
 *     how much of the drawing reads as extreme rather than as neutral ground;
 *   - dragging them BOTH the same way moves the neutral grey, which is what
 *     tips the whole pattern toward cutting into the ground or filling onto it.
 *
 * The neutral point is the midpoint (lo+hi)/2. Slide both handles up and more
 * of the drawing falls below neutral, so the stamp cuts; slide both down and it
 * fills.
 *
 * @param {number} v raw field value, 0..1
 * @param {number} lo @param {number} hi
 * @param {boolean} [invert] swap which end of the drawing cuts
 * @returns {number} −1 = full cut, +1 = full fill
 */
export function signedDisplacement(v, lo, hi, invert = false) {
  const span = hi - lo;
  if (!(span > 0)) return 0;
  const t = Math.min(1, Math.max(0, (v - lo) / span));
  const s = (t - 0.5) * 2;
  return invert ? -s : s;
}

/**
 * @typedef {Object} StampResult
 * @property {number} cut  m³ removed
 * @property {number} fill m³ placed
 * @property {number} net  m³, fill − cut
 * @property {number} cells cells that actually moved
 * @property {{r0:number,c0:number,r1:number,c1:number}} rect dirty region, inclusive
 */

/**
 * Add a pattern to the ground, in place, and bill the ledger for it.
 *
 * @param {import("./dem.js").DEM} dem  modified in place
 * @param {Float32Array} field  one 0..1 value per DEM cell
 * @param {{amplitude:number, lo?:number, hi?:number, invert?:boolean,
 *          mask?:Uint8Array|null, ledger?:import("./brush.js").Ledger}} opts
 * @returns {StampResult}
 */
export function applyPattern(dem, field, opts) {
  const { z, nrows, ncols, cell } = dem;
  const amplitude = opts.amplitude;
  const lo = opts.lo ?? 0, hi = opts.hi ?? 1;
  const invert = !!opts.invert;
  const mask = opts.mask || null;
  const area = cell * cell;

  let cut = 0, fill = 0, cells = 0;
  let r0 = nrows, c0 = ncols, r1 = -1, c1 = -1;

  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const i = r * ncols + c;
      if (mask && !mask[i]) continue;
      const zv = z[i];
      if (!Number.isFinite(zv)) continue;      // a hole in the DEM stays a hole
      const dz = signedDisplacement(field[i], lo, hi, invert) * amplitude;
      if (dz === 0) continue;
      z[i] = zv + dz;
      // ⚠️ BILL FOR WHAT WAS STORED, NOT FOR WHAT WAS INTENDED. `z` is a
      // Float32Array so the write above rounds, and charging `dz` lets the
      // account drift from the ground it describes. This is the same trap
      // brush.js was corrected for, and a stamp writes every cell at once —
      // so the drift here would be the whole grid's worth in one operation.
      const moved = z[i] - zv;
      if (moved === 0) continue;
      if (moved < 0) cut += -moved * area; else fill += moved * area;
      cells++;
      if (r < r0) r0 = r; if (r > r1) r1 = r;
      if (c < c0) c0 = c; if (c > c1) c1 = c;
    }
  }

  if (opts.ledger) { opts.ledger.cut += cut; opts.ledger.fill += fill; }
  if (r1 < r0) { r0 = 0; c0 = 0; r1 = -1; c1 = -1; }
  return { cut, fill, net: fill - cut, cells, rect: { r0, c0, r1, c1 } };
}

/**
 * What a stamp WOULD cost, without touching the terrain.
 *
 * Same arithmetic as applyPattern with the write removed, so the preview and
 * the commit cannot disagree — the trap the figure exporter and the OBJ writer
 * both carry warnings about, which is re-deriving in a second place a quantity
 * the first place already computes.
 *
 * ⚠️ It cannot bill the float32 rounding, because there is nothing to re-read.
 * The preview is therefore exact to the intent and the commit is exact to the
 * ground, and they differ by the rounding — measured well below a millilitre
 * per cell, and always in the direction of the truth.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {Float32Array} field
 * @param {{amplitude:number, lo?:number, hi?:number, invert?:boolean, mask?:Uint8Array|null}} opts
 */
export function patternCost(dem, field, opts) {
  const { z, cell } = dem;
  const lo = opts.lo ?? 0, hi = opts.hi ?? 1;
  const mask = opts.mask || null;
  const area = cell * cell;
  let cut = 0, fill = 0, cells = 0;
  for (let i = 0; i < z.length; i++) {
    if (mask && !mask[i]) continue;
    if (!Number.isFinite(z[i])) continue;
    const dz = signedDisplacement(field[i], lo, hi, !!opts.invert) * opts.amplitude;
    if (dz === 0) continue;
    if (dz < 0) cut += -dz * area; else fill += dz * area;
    cells++;
  }
  return { cut, fill, net: fill - cut, cells };
}
