// @ts-check
// THE SINGLE POINT OF TRUTH FOR EVERY COLOUR CONVENTION IN THIS TOOL.
//
// Why this file exists: the sibling Morphos project shipped two silent sign
// inversions that still looked completely plausible on screen — an `RdBu_r`
// ramp that made ground GAIN read red and LOSS read blue (the opposite of its
// own legend), and a divergence term where positive was taken as erosion. Both
// produced maps a reader would nod along with.
//
// The defence is structural, not vigilance: every colour in the app is produced
// by sample() below, so there is exactly one place a convention can live and
// exactly one place the self-test has to assert on. Do not colour anything
// anywhere else.
//
// Conventions, stated so the tests can quote them:
//   cutfill  Δz > 0 = FILL  = material added = WARM (red/ochre)
//            Δz < 0 = CUT   = material removed = COOL (blue)
//            Δz = 0 exactly = the neutral paper tone, so untouched ground can
//                             never read as a faint gain or loss.
//   twi      high = WET = blue.  low = DRY = warm/pale.
//            NaN (a levelled surface has no answer) = the nodata tone.
//   slope    0 = pale, steep = dark. Sequential, no hue trickery.
//   aspect   circular hue wheel, N at the top. NaN MUST NOT render as the
//            north colour — flat ground and north-facing ground must look
//            different (see planning/02 §6).
//   tri      low = pale, high = saturated. Sequential.

// SATURATION. The first version of this table used muted paper tones to sit
// quietly inside the sidebar's warm palette. On real data that read as washed
// out — the whole point of an analysis raster is that a reader can see where
// the value changes, and a pastel ramp throws that away. These follow the
// convention of SAGA GIS's own display palettes: strong, committed hues with
// most of the dynamic range spent in the middle of the domain where the terrain
// actually varies. The UI chrome stays muted; the data does not.

/** Theme tones, kept in step with static/style.css. */
export const NODATA_RGB = [214, 210, 202];   // muted paper grey — "no answer"
export const NEUTRAL_RGB = [253, 252, 249];  // --sheet, exact

/**
 * @typedef {Object} Ramp
 * @property {string} id
 * @property {[number, number]} domain     value range mapped onto the stops
 * @property {Array<[number, number[]]>} stops  [position 0..1, [r,g,b]]
 * @property {boolean} [circular]          hue wheel rather than a line
 * @property {boolean} [diverging]         two opposed ends about a meaningful
 *   middle. Load-bearing beyond styling: a diverging ramp cannot be given a
 *   single-hue variant without making its two ends indistinguishable, so
 *   variantsFor() withholds "mono" from these.
 */

/** @type {Record<string, Ramp>} */
export const RAMPS = {
  // Diverging, strong. Deep blue (cut) -> exact neutral (no change) -> deep red
  // (fill). The centre stays bit-exactly --sheet so untouched ground can never
  // read as a faint gain or loss; everything either side is fully committed.
  cutfill: {
    id: "cutfill",
    diverging: true,
    domain: [-1, 1],
    stops: [
      [0.0, [12, 44, 96]],
      [0.22, [30, 96, 178]],
      [0.42, [126, 186, 226]],
      [0.5, NEUTRAL_RGB],
      [0.58, [244, 176, 122]],
      [0.78, [214, 84, 32]],
      [1.0, [122, 16, 12]],
    ],
  },
  // Dry -> wet as RED -> BLUE. The pale-cream-to-navy version was correct but
  // quiet: the dry end simply read as "background", so the map showed where
  // water collects and said nothing about where it does not. Red/blue gives
  // both ends a voice, which matters here because the argument is about the
  // CONTRAST between moist hollows and dry rises — the mossy basin and the
  // poppy-covered gravel mound are two halves of the same claim.
  //
  // Passing through a pale middle rather than straight from red to blue keeps
  // the midrange readable and avoids the muddy purple a direct interpolation
  // would give.
  twi: {
    id: "twi",
    diverging: true,
    domain: [2, 14],
    stops: [
      [0.0, [138, 20, 24]],
      [0.22, [206, 74, 46]],
      [0.42, [238, 168, 116]],
      [0.55, [242, 234, 220]],
      [0.7, [126, 186, 214]],
      [0.85, [40, 110, 184]],
      [1.0, [10, 38, 110]],
    ],
  },
  // Slope: pale -> yellow -> red -> near-black, the classic steepness ramp.
  // ELEVATION — the ground's own height, and the layer this tool went without
  // for eight phases while every derivative of it had one.
  //
  // ⚠️ NOT A HYPSOMETRIC TINT. The green-to-brown convention is instantly read
  // as elevation on a national map, and it is wrong here twice over: at 5.3 m of
  // relief over 64 m there are no altitude zones to tint, and green at the
  // bottom of a closed landfill states vegetation the site does not have. This
  // project spends a great deal of care not implying things; a palette that
  // implies land cover would undo it in one glance.
  //
  // ⚠️ AND IT MUST NOT LOOK LIKE TWI. Wetness already owns red→pale→blue, and
  // low ground is wet ground on this site, so a cool-low ramp would produce two
  // layers that agree by construction and look like confirmation. Sequential and
  // warm instead: deep umber in the hollows, rising through ochre to a pale
  // crest. It reads as height, it prints, and it is nobody else's ramp.
  // ⚠️ PALE LOW, DARK HIGH — MORE INK MEANS MORE OF THE QUANTITY, which is the
  // convention every sequential ramp in this table already follows, and it is
  // not optional. The `mono` variant is POSITION-driven: it mixes from paper at
  // t = 0 toward ink at t = 1, on the assumption that a sequential ramp darkens
  // as its value rises. Built the other way round — deep umber in the hollows
  // rising to a pale crest, which is the hypsometric instinct — the ramp reads
  // correctly in colour and comes out INVERTED in one-colour print, which is
  // the Morphos sign inversion this project tests against. Group M caught both
  // that and an earlier version whose two ends were two points apart in warmth,
  // so which end was "warm" was decided by rounding.
  elevation: {
    id: "elevation",
    domain: [0, 1],       // always percentile-stretched; a site has no fixed range
    stops: [
      [0.0, [250, 248, 244]],
      [0.25, [224, 198, 166]],
      [0.5, [178, 130, 84]],
      [0.75, [116, 72, 40]],
      [1.0, [58, 32, 22]],
    ],
  },
  slope: {
    id: "slope",
    domain: [0, 35],
    stops: [
      [0.0, [250, 250, 244]],
      [0.2, [238, 214, 110]],
      [0.45, [232, 148, 46]],
      [0.7, [196, 52, 34]],
      [1.0, [58, 14, 20]],
    ],
  },
  // Aspect: a full-saturation hue wheel, so opposing slopes are unmistakably
  // opposite. NaN must NOT land on the north hue — sample() guarantees that.
  aspect: {
    id: "aspect",
    domain: [0, 360],
    circular: true,
    stops: [
      [0.0, [226, 74, 60]],     // N
      [0.125, [236, 150, 44]],
      [0.25, [226, 214, 52]],   // E
      [0.375, [128, 202, 66]],
      [0.5, [46, 176, 150]],    // S
      [0.625, [50, 148, 214]],
      [0.75, [96, 84, 200]],    // W
      [0.875, [178, 70, 168]],
      [1.0, [226, 74, 60]],     // back to N
    ],
  },
  // Ruggedness as a heat scale rather than earth tones: smooth ground drops
  // away pale and every break of slope lights up.
  tri: {
    id: "tri",
    domain: [0, 0.25],
    stops: [
      [0.0, [250, 250, 242]],
      [0.2, [166, 214, 150]],
      [0.45, [238, 206, 66]],
      [0.7, [232, 118, 42]],
      [1.0, [136, 18, 60]],
    ],
  },
  // Closed depressions, by depth below their spill point. Zero depth is the
  // neutral paper tone so that "not a depression" is visually absent rather
  // than merely pale — the map should read as a set of discrete basins.
  depression: {
    id: "depression",
    domain: [0, 0.5],
    stops: [
      [0.0, NEUTRAL_RGB],
      [0.12, [176, 226, 232]],
      [0.4, [56, 168, 208]],
      [0.7, [22, 92, 172]],
      [1.0, [10, 30, 96]],
    ],
  },
  // Sky-view factor: how much sky a point can see. 1 = fully open.
  svf: {
    id: "svf",
    domain: [0.55, 1.0],
    stops: [
      [0.0, [24, 16, 60]],
      [0.35, [92, 54, 140]],
      [0.65, [206, 108, 122]],
      [0.85, [246, 190, 120]],
      [1.0, [255, 250, 232]],
    ],
  },
  // Wind exposure, 0 sheltered to 1 exposed toward the prevailing SW. Cool and
  // enclosed at the sheltered end, bleached and bare at the exposed end —
  // deliberately NOT the openness ramp's palette, because the two answer
  // different questions and would otherwise be mistaken for each other.
  wind: {
    id: "wind",
    domain: [0.55, 1.0],
    stops: [
      [0.0, [30, 52, 72]],
      [0.3, [64, 116, 140]],
      [0.6, [146, 178, 186]],
      [0.85, [214, 226, 224]],
      [1.0, [252, 252, 248]],
    ],
  },
  // Positive openness, degrees from zenith. Low = enclosed/sheltered,
  // high = exposed. Shelter is an ecological variable here, not just a
  // rendering aid, so it gets a real hue range rather than the conventional
  // near-greyscale.
  openness: {
    id: "openness",
    domain: [70, 92],
    stops: [
      [0.0, [40, 16, 76]],
      [0.3, [26, 106, 150]],
      [0.58, [60, 176, 152]],
      [0.8, [196, 214, 108]],
      [1.0, [255, 252, 226]],
    ],
  },
  // Total upslope contributing area, m². Sequential blue: the more ground
  // drains through a cell, the deeper it reads, so drainage lines emerge as
  // the branching network they are.
  //
  // Colourised from LOG10 of the area, not the area itself — see worker.js.
  // Contributing area is the most extreme-tailed quantity in the tool: on this
  // patch a ridge cell holds one cell's worth (0.0625 m²) while the outlet
  // collects thousands, so a linear stretch spends the entire ramp on the few
  // channel cells and renders every hillslope identically pale. The domain is
  // therefore in log10(m²) and the legend says so.
  catchment: {
    id: "catchment",
    domain: [-1.2, 3.5],
    stops: [
      [0.0, [250, 250, 244]],
      [0.25, [198, 224, 226]],
      [0.5, [110, 178, 208]],
      [0.75, [36, 106, 176]],
      [1.0, [10, 32, 96]],
    ],
  },
  // Potential incoming solar radiation. The classic insolation ramp: cold dark
  // purple in the shade through to hot white on the sun-facing flanks.
  solar: {
    id: "solar",
    domain: [0, 700],
    stops: [
      [0.0, [16, 12, 48]],
      [0.22, [76, 32, 128]],
      [0.45, [190, 60, 108]],
      [0.68, [244, 136, 52]],
      [0.86, [250, 208, 78]],
      [1.0, [255, 254, 224]],
    ],
  },
};

/**
 * CATEGORICAL ramps. Every ramp above maps a number onto a continuum; a
 * landform class is a NAME, and interpolating between "ridge" and "hollow"
 * would be meaningless. These map an integer class index onto a fixed colour.
 *
 * Geomorphon colours are not an arbitrary qualitative palette. They follow the
 * TWI convention already established in this file — convex, shedding forms
 * warm, concave, collecting forms cool — so the two layers agree by eye: the
 * red ridges in the landform map are the dry red ground in the wetness map,
 * and the blue valleys are where the water goes. Flat and slope sit neutral
 * between them, because neither sheds nor collects by shape alone.
 * @type {Record<string, {id: string, labels: string[], colours: number[][]}>}
 */
export const CATEGORICAL = {
  geomorphon: {
    id: "geomorphon",
    labels: ["flat", "peak", "ridge", "shoulder", "spur",
             "slope", "hollow", "footslope", "valley", "pit"],
    colours: [
      [236, 233, 226], // flat       — neutral paper
      [138, 20, 24],   // peak       — deepest warm, the TWI dry end
      [196, 52, 46],   // ridge
      [226, 116, 62],  // shoulder
      [242, 178, 122], // spur       — palest warm
      [206, 200, 188], // slope      — neutral, neither shedding nor collecting
      [150, 198, 220], // hollow     — palest cool
      [86, 156, 202],  // footslope
      [40, 106, 176],  // valley
      [10, 38, 110],   // pit        — deepest cool, the TWI wet end
    ],
  },

  // The species assemblage. Ordered along the MOISTURE GRADIENT and coloured
  // cool-to-warm to match the geomorphon and TWI convention above, so a reader
  // moving between the three layers sees the same ground reading the same way:
  // the blue-green species are in the blue hollows of the wetness map.
  //
  // ⚠️ THE INVASIVE IS DELIBERATELY OFF THAT GRADIENT. Lupinus gets a magenta
  // that appears nowhere else in the tool, because it must not be readable as a
  // position on the moisture scale — it is a different KIND of fact from the
  // other six, and a reader skimming the map has to be able to see at a glance
  // how much of the ground it holds. See species.js for why it is modelled at
  // all rather than mentioned.
  species: {
    id: "species",
    labels: ["peat moss", "hair-grass", "clover", "sheep's sorrel",
             "grey willow", "reindeer lichen", "Nootka lupine"],
    // Indices follow SPECIES order in species.js, which is the order the codes
    // are written into the exported raster.
    colours: [
      [24, 82, 132],    // sphagnum    — wettest, the TWI blue end
      [86, 150, 92],    // deschampsia — damp
      [156, 184, 96],   // trifolium   — moderate
      [216, 138, 52],   // rumex       — dry, warm
      [38, 118, 112],   // salix       — sheltered moist (teal, out of sequence
                        //               because shelter is its axis, not moisture)
      [226, 210, 176],  // cladonia    — driest, most exposed
      [178, 42, 138],   // lupinus     — INVASIVE, off the gradient
    ],
    /**
     * Codes outside the species list that still mean something. `bare` is an
     * ecological answer — nothing on this list tolerates these conditions — and
     * must not share the nodata tone, which means "the DEM has a hole here".
     */
    extraKeys: [{ code: 254, label: "bare", colour: [170, 166, 158] }],
  },

  // What the ground is MADE OF. The one layer here that is not derived from
  // elevation — it is imported or specified, never computed.
  //
  // Ordered COARSE to FINE, and coloured to follow the same logic the rest of
  // the tool uses: free-draining material reads pale and cool-grey like rock,
  // retentive material reads dark and brown like soil. So a reader moving
  // between this layer and the wetness map sees the two agree — the pale
  // gravels are where water does not stay.
  //
  // Labels are written out here rather than imported from substrate.js, in the
  // same way the species labels are: ramps.js stays the single place a colour
  // convention lives, and the self-test asserts the two lists agree.
  soil: {
    id: "soil",
    labels: ["bedrock", "coarse rock fill", "gravel", "sandy mineral",
             "fine mineral", "organic / peat", "topsoil / growing medium"],
    colours: [
      [118, 122, 130],  // bedrock          — cold grey, nothing roots in it
      [168, 164, 158],  // coarse rock fill
      [212, 196, 166],  // gravel           — the quarry-floor condition
      [226, 182, 116],  // sandy mineral
      [180, 140, 92],   // fine mineral
      [82, 56, 40],     // organic / peat   — darkest, most retentive
      [116, 96, 58],    // topsoil / growing medium
    ],
    // Unknown IS nodata for this layer, unlike the species layer's "bare" which
    // is a positive ecological answer. It takes the nodata tone deliberately —
    // but it is listed in the key, because "we do not know what this is" is
    // something a reader of a substrate map must be told rather than left to
    // infer from an absence of colour.
    extraKeys: [{ code: 255, label: "unknown", colour: [214, 210, 202] }],
  },
};

// Splice the extra codes into the colour lookup. Sparse, so colouriseClasses
// and sampleClass find them by index without either learning a special case.
for (const cat of Object.values(CATEGORICAL)) {
  for (const e of cat.extraKeys || []) cat.colours[e.code] = e.colour;
}

/**
 * Colour for a class index. Out-of-range or non-finite gives the nodata tone,
 * so an unclassified cell can never borrow a landform's colour.
 * @param {string} id @param {number} klass
 * @returns {[number, number, number, number]}
 */
export function sampleClass(id, klass) {
  const cat = CATEGORICAL[id];
  if (!cat) throw new Error(`unknown categorical ramp "${id}"`);
  const c = Number.isFinite(klass) ? cat.colours[klass] : null;
  if (!c) return [NODATA_RGB[0], NODATA_RGB[1], NODATA_RGB[2], 255];
  return [c[0], c[1], c[2], 255];
}

/**
 * Colourise a grid of class indices.
 * @param {string} id @param {Uint8Array|Float32Array} grid
 * @returns {Uint8ClampedArray}
 */
export function colouriseClasses(id, grid) {
  const cat = CATEGORICAL[id];
  if (!cat) throw new Error(`unknown categorical ramp "${id}"`);
  const out = new Uint8ClampedArray(grid.length * 4);
  for (let i = 0; i < grid.length; i++) {
    const c = cat.colours[grid[i]];
    const o = i * 4;
    if (c) { out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; }
    else { out[o] = NODATA_RGB[0]; out[o + 1] = NODATA_RGB[1]; out[o + 2] = NODATA_RGB[2]; }
    out[o + 3] = 255;
  }
  return out;
}

/**
 * ALTERNATIVE PALETTES, derived from the committed ramp rather than authored
 * beside it.
 *
 * The figures leave this tool for posters, slides and a printed exhibition, so
 * being able to restyle a layer is a real need. But a free palette picker is
 * exactly how this file's opening paragraph happens again: the sibling Morphos
 * project shipped two silent sign inversions that still looked plausible, and
 * `ramps.js` exists so a convention has one home.
 *
 * The resolution is that every variant is a PER-STOP TRANSFORM of the
 * committed ramp — a function applied to each colour in place, never a
 * reordering. Warm stays where warm was; the wet end of TWI cannot become the
 * dry end, because nothing here can move a stop. Restyling is therefore free
 * and inversion is unreachable, rather than merely discouraged.
 */
export const RAMP_VARIANTS = ["committed", "muted", "mono", "contrast"];

/**
 * ⚠️ MONO IS NOT AVAILABLE ON EVERY RAMP, and finding out why was worth the
 * detour. A single-hue ramp has to run pale-to-dark to be readable, which means
 * deriving it from each stop's POSITION rather than its colour. On a sequential
 * ramp that is exactly right. On a DIVERGING one it destroys the thing the ramp
 * exists to say: cut and fill would both become "dark", and a wetness map's dry
 * and wet ends would be indistinguishable.
 *
 * The first attempt derived the hue from each stop's own warm/cool bias, which
 * kept both ends distinct but was then not monochrome at all — measured on the
 * TWI panel it still produced 39 000 warm and 23 000 cool pixels. Honest answer:
 * offer mono only where it means something.
 * @param {string} id
 */
export function variantsFor(id) {
  const ramp = RAMPS[id];
  if (!ramp) return ["committed"];
  return (ramp.circular || ramp.diverging)
    ? RAMP_VARIANTS.filter((v) => v !== "mono")
    : RAMP_VARIANTS;
}

/** @param {number[]} rgb @param {number} t stop position, 0..1 @param {string} variant */
function transformStop(rgb, t, variant) {
  const [r, g, b] = rgb;
  // Rec. 709 luma: the perceptual weight that decides how dark a stop reads.
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  switch (variant) {
    case "muted": {
      // Halfway to its own grey, then lifted toward paper. Keeps every hue
      // relationship and simply lowers the voice — for figures that sit beside
      // photographs, where a saturated ramp shouts over the plate.
      const m = (c) => Math.round(c * 0.55 + y * 0.45) * 0.92 + 20;
      return [m(r), m(g), m(b)];
    }
    case "mono": {
      // Sequential ramps only (see variantsFor). Position-driven so the result
      // is monotonically darker, which is what makes one hue legible as a
      // scale — and what makes it survive one-colour print and photocopying.
      const hue = b > r ? [16, 52, 96] : [74, 34, 22]; // follow the ramp's own bias
      const mix = (paper, ink) => Math.round(paper + (ink - paper) * t);
      return [mix(250, hue[0]), mix(250, hue[1]), mix(244, hue[2])];
    }
    case "contrast": {
      // Push each stop away from mid-grey. For projection, where an exhibition
      // beamer eats the middle of the range.
      const c = (v) => Math.round(Math.min(255, Math.max(0, 128 + (v - 128) * 1.35)));
      return [c(r), c(g), c(b)];
    }
    default:
      return [r, g, b];
  }
}

/**
 * A ramp's stops under a variant. The committed ramp is returned untouched, so
 * the default path is bit-identical to having no variants at all. A variant
 * this ramp does not offer falls back to committed rather than throwing — a
 * stale setting should not blank a panel.
 * @param {string} id @param {string} [variant]
 */
export function variantStops(id, variant) {
  const ramp = RAMPS[id];
  if (!ramp) throw new Error(`unknown ramp "${id}"`);
  if (!variant || variant === "committed") return ramp.stops;
  if (!variantsFor(id).includes(variant)) return ramp.stops;
  // The last stop's bias stands for the whole ramp's direction, so a mono
  // version of a sequential ramp keeps the hue its author chose.
  const end = ramp.stops[ramp.stops.length - 1][1];
  return ramp.stops.map(([p, c]) =>
    [p, transformStop(variant === "mono" ? end : c, p, variant)]);
}

/**
 * Sample a ramp. Non-finite input returns the nodata tone — never a colour
 * that could be mistaken for a real value.
 * @param {string} id
 * @param {number} value
 * @param {[number, number]} [domain] override the ramp's default range
 * @param {string} [variant] palette variant, default the committed ramp
 * @returns {[number, number, number, number]} RGBA, 0-255
 */
export function sample(id, value, domain, variant) {
  const ramp = RAMPS[id];
  if (!ramp) throw new Error(`unknown ramp "${id}"`);
  if (!Number.isFinite(value)) {
    return [NODATA_RGB[0], NODATA_RGB[1], NODATA_RGB[2], 255];
  }
  const [lo, hi] = domain ?? ramp.domain;
  let t = hi === lo ? 0 : (value - lo) / (hi - lo);

  // Exact-zero guard for diverging ramps: a cell that did not change must
  // return the neutral tone bit-exactly, not "very nearly neutral".
  if (!ramp.circular && lo < 0 && hi > 0 && value === 0) {
    return [NEUTRAL_RGB[0], NEUTRAL_RGB[1], NEUTRAL_RGB[2], 255];
  }

  if (ramp.circular) t = ((t % 1) + 1) % 1;
  else t = Math.min(1, Math.max(0, t));

  const stops = variantStops(id, variant);
  for (let k = 0; k < stops.length - 1; k++) {
    const [p0, c0] = stops[k];
    const [p1, c1] = stops[k + 1];
    if (t >= p0 && t <= p1) {
      const span = p1 - p0;
      const f = span === 0 ? 0 : (t - p0) / span;
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
        255,
      ];
    }
  }
  const last = stops[stops.length - 1][1];
  return [last[0], last[1], last[2], 255];
}

const LUT_SIZE = 512;

/**
 * Build a lookup table for a ramp over a domain, so colourising a grid is an
 * array index rather than a walk through the stop list for every cell.
 *
 * With nine layers at 65 536 cells each, the stop-walk version was the single
 * most expensive thing in an interactive worker pass. The table is built once
 * per layer per pass (512 samples) and then read 65 536 times.
 *
 * @param {string} id
 * @param {[number, number]} [domain]
 * @param {string} [variant]
 */
export function makeLUT(id, domain, variant) {
  const ramp = RAMPS[id];
  const [lo, hi] = domain ?? ramp.domain;
  const lut = new Uint8ClampedArray(LUT_SIZE * 3);
  for (let k = 0; k < LUT_SIZE; k++) {
    const v = lo + ((hi - lo) * k) / (LUT_SIZE - 1);
    const [r, g, b] = sample(id, v, domain, variant);
    lut[k * 3] = r; lut[k * 3 + 1] = g; lut[k * 3 + 2] = b;
  }
  return { lut, lo, hi, circular: !!ramp.circular, diverging: lo < 0 && hi > 0 };
}

/**
 * Colourise a whole grid into an RGBA buffer ready for putImageData.
 * @param {string} id
 * @param {Float32Array} grid
 * @param {[number, number]} [domain] override the ramp's default range
 * @param {string} [variant] palette variant
 * @returns {Uint8ClampedArray} length grid.length*4
 */
export function colourise(id, grid, domain, variant) {
  const n = grid.length;
  const out = new Uint8ClampedArray(n * 4);
  const { lut, lo, hi, circular, diverging } = makeLUT(id, domain, variant);
  const span = hi - lo;
  const scale = span === 0 ? 0 : (LUT_SIZE - 1) / span;
  const [nr, ng, nb] = NODATA_RGB;
  const [er, eg, eb] = NEUTRAL_RGB;

  for (let i = 0; i < n; i++) {
    const v = grid[i];
    const o = i * 4;
    out[o + 3] = 255;
    if (v !== v || v === Infinity || v === -Infinity) { // NaN or infinite
      out[o] = nr; out[o + 1] = ng; out[o + 2] = nb;
      continue;
    }
    // Exact-zero guard for diverging ramps, kept OUT of the table: a cell that
    // did not change must return the neutral tone bit-exactly, and quantising
    // it through 512 steps would not guarantee that.
    if (diverging && v === 0) {
      out[o] = er; out[o + 1] = eg; out[o + 2] = eb;
      continue;
    }
    let k = (v - lo) * scale;
    if (circular) {
      k = k % (LUT_SIZE - 1);
      if (k < 0) k += LUT_SIZE - 1;
    } else {
      k = k < 0 ? 0 : (k > LUT_SIZE - 1 ? LUT_SIZE - 1 : k);
    }
    const j = (k | 0) * 3;
    out[o] = lut[j]; out[o + 1] = lut[j + 1]; out[o + 2] = lut[j + 2];
  }
  return out;
}

/**
 * Percentile stretch, the way a GIS stretches a raster for display.
 *
 * WHY THIS IS NECESSARY. Fixed domains cannot work here, for two reasons that
 * only showed up against real data. First, several of these measures are
 * SCALE-DEPENDENT: terrain ruggedness on the 0.25 m patch spans 0.005–0.15 m,
 * while the same measure on the 4 m context tile reaches 4.5 m — thirty times
 * larger — and topographic wetness shifts too, because it is computed from
 * catchment area per unit contour width. Second, the tool now accepts any
 * GeoTIFF the user drops on it, so the range of the data is unknown in advance.
 * A guessed domain leaves the ramp either clipped at one end or, as happened
 * here with solar radiation (domain 0–700, data 733–1123), entirely off the end
 * of the scale and reading as flat colour.
 *
 * Sampling rather than a full sort: an exact percentile on 65 536 cells costs a
 * sort per layer per pass, and the stretch only needs to be approximately right.
 *
 * @param {Float32Array} grid
 * @param {number} [loP] lower percentile, 0..1
 * @param {number} [hiP] upper percentile, 0..1
 * @param {{symmetric?: boolean, floorAtZero?: boolean}} [opts]
 *   symmetric   — centre the domain on zero (diverging ramps, so 0 stays neutral)
 *   floorAtZero — pin the lower bound to exactly 0 (depth-like layers)
 * @returns {[number, number] | undefined} undefined if the grid has no spread
 */
export function percentileDomain(grid, loP = 0.02, hiP = 0.98, opts = {}) {
  const n = grid.length;
  const stride = Math.max(1, Math.floor(n / 8192));
  const s = [];
  for (let i = 0; i < n; i += stride) {
    const v = grid[i];
    if (Number.isFinite(v)) s.push(v);
  }
  if (s.length < 8) return undefined;
  s.sort((a, b) => a - b);
  let lo = s[Math.floor((s.length - 1) * loP)];
  let hi = s[Math.floor((s.length - 1) * hiP)];

  if (opts.symmetric) {
    const m = Math.max(Math.abs(lo), Math.abs(hi));
    if (m <= 0) return undefined;
    return [-m, m];
  }
  if (opts.floorAtZero) lo = 0;
  if (!(hi > lo)) return undefined;
  return [lo, hi];
}

/** Is this colour warmer than it is cool? Used by the sign-convention tests. */
export function isWarm(rgba) { return rgba[0] > rgba[2]; }
/** Is this colour cooler than it is warm? */
export function isCool(rgba) { return rgba[2] > rgba[0]; }
