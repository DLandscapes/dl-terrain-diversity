// @ts-check
// The assemblage, as things standing on the ground.
//
// WHY THIS EXISTS AT ALL. The species raster in the sidebar already carries the
// whole argument, and it is the honest artefact — a map of classes with a key.
// But the claim this tool makes is about a PLACE, and a reader looking at a
// 256x256 raster is looking at a diagram. Putting the assemblage into the scene
// is what makes "scoop here and something can live in it" land as a fact about
// ground rather than about a colour table.
//
// ⚠️ A PLANT MAY APPEAR OR DISAPPEAR, BUT IT MUST NEVER MOVE.
//
// This is the single hardest requirement and it dictates the whole design. The
// obvious implementation — scatter n instances across the cells of each species
// every time the assemblage changes — reshuffles every plant on every worker
// pass, so a gesture in one corner makes the vegetation crawl across the entire
// site. On a 45-second screen capture that reads as noise and destroys the
// causal link the video is built to show.
//
// So the scatter is fixed at construction: a seeded RNG lays down candidate
// positions ONCE, each permanently bound to the cell it fell in, with its own
// rotation and size jitter that never change. On each update a candidate simply
// asks its cell which species won and is written into that species' instance
// buffer, or left out entirely. A plant can wink in or out; it cannot slide.
// The seed also means take 7 of a demo recording is identical to take 1.
//
// ⚠️ GEOMETRY IS LOCAL, THE UTM ORIGIN RIDES ON THE OBJECT — the rule from
// surface.js and voxels.js, and the one this project has already been bitten by.
// Instance matrices are float32 on the GPU; at this site's northing a float32's
// ULP is 0.5 m, so baking world coordinates into them would quantise every plant
// onto a half-metre grid and make the scatter visibly rectangular.

import * as THREE from "three";
import { SPECIES } from "./analysis/species.js";
import { CATEGORICAL } from "./analysis/ramps.js";

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3(0, 0, 1);

/**
 * Plants per square metre at the design scale.
 *
 * Not a vegetation density — a SAMPLING density. These are markers for "this
 * cell's conditions suit this species", not individuals, and the tool must not
 * imply it knows how many plants there are. Chosen so the 64 m design patch
 * reads as covered without the instances merging into a mat.
 */
const DENSITY_PER_M2 = 3.0;
/** Cap, because the 1 km context tile would otherwise ask for eight million. */
const MAX_CANDIDATES = 30000;
/** How hard the sky-view factor darkens a plant. Matches voxels.js. */
const AO_STRENGTH = 0.45;
/**
 * Coarsest cell size at which the scatter says anything, in metres.
 *
 * ⚠️ THIS IS THE PROJECT'S OWN FINDING, TURNED INTO A BEHAVIOUR. Measured on the
 * 4 m context tile: the tallest plant here (0.95 m) is 0.09% of the 1 024 m
 * span — about ONE PIXEL — and the cap puts markers 35 m apart, so even if they
 * were visible the scatter would be too sparse to mean anything. Rather than
 * draw 60 000 invisible instances, the layer switches itself off and says why:
 * below the design scale, national terrain data cannot speak about vegetation.
 * Inflating the plants to stay visible would discard exactly that argument.
 */
export const MAX_CELL_M = 1.0;

/**
 * Growth forms, in true metres.
 *
 * ⚠️ THESE ARE REAL SIZES and they are the reason the scatter is a design-scale
 * instrument rather than a context-scale one. A 0.35 m tussock on the 4 m
 * context tile is a tenth of a cell and renders sub-pixel — which is not a bug
 * to be scaled away but the same finding the whole project rests on: the scale
 * at which terrain generates habitat is below the scale at which national data
 * describes it. Inflating them to stay visible at 1 km would quietly discard
 * exactly the argument being made.
 */
export const FORMS = {
  //            radius  height
  // ⚠️ THE GROUND-HUGGING FORMS ARE PATCHES, NOT INDIVIDUALS, and sizing them
  // as individuals was wrong twice over. A Sphagnum "plant" is a few
  // centimetres, so an 0.11 m marker rendered sub-pixel and the moss simply was
  // not visible — but it was also untrue to the species, because Sphagnum,
  // Cladonia and clover all spread as continuous mats and swards rather than as
  // countable individuals. A marker for these is honestly a PATCH, and sizing
  // it as one makes it both visible and more accurate.
  mat: [0.30, 0.06],
  crust: [0.24, 0.035],
  sward: [0.20, 0.07],
  // The upright forms stay individual-sized, but slightly stouter: the first
  // pass drew blades so thin that they were sub-pixel at any distance and
  // dissolved into the background.
  tussock: [0.13, 0.36],
  herb: [0.09, 0.24],
  shrub: [0.45, 0.95],
  "tall-forb": [0.14, 0.80],

  // ⚠️ THE NINE BELOW ARE DRAWINGS ONLY, NOT YET SPECIES. They exist so the
  // plant library and the 4×4 plate can be drawn at sixteen, while `SPECIES` in
  // analysis/species.js stays at seven. That separation is deliberate and
  // temporary: Shannon H′ is bounded by ln(classes), so moving the model from 7
  // to 16 re-baselines every published diversity figure — including the ones in
  // the extended abstract. Forms are geometry; envelopes are the model. Adding
  // geometry changes no number. See SPECIES-RULES.txt before wiring these in.
  "cotton-head": [0.07, 0.34],    // Eriophorum — nodding tuft on a wire stem
  whorl: [0.09, 0.28],            // Equisetum — segmented stem, whorled branches
  rosette: [0.17, 0.11],          // Tussilago — flat round basal leaves
  wand: [0.13, 1.15],             // Chamerion — slender, unlike the lupine cone
  "dwarf-shrub": [0.19, 0.33],    // Calluna — wiry and low
  "prostrate-mat": [0.34, 0.09],  // Empetrum — spreads, a patch not an individual
  tree: [1.30, 4.20],             // Betula czerepanovii — the region's tree
  hummock: [0.28, 0.10],          // Racomitrium — angular, unlike the soft cushion
  umbel: [0.52, 2.35],            // Heracleum persicum — the Tromsø palm, and it towers
};

/**
 * ⚠️ THE SCATTER IS DRAWN IN PLANT COLOURS, NOT IN THE RASTER'S CLASS COLOURS,
 * and desaturated at that.
 *
 * The species raster and its legend use `CATEGORICAL.species` — magenta lupine,
 * teal willow — chosen so the DATA is legible and the invasive is unmistakable.
 * Painting three-dimensional plant shapes in those colours put the scatter in an
 * uncanny middle: plant silhouettes in colours no plant has.
 *
 * The scatter is now GREYSCALE, and that is a project-level decision rather than
 * a taste one: the A1 exhibition poster prints black and white, so the tool, the
 * poster and the video share one drawing language instead of three. The module
 * always said identity is carried by SHAPE first — this removes the support
 * channel it never leaned on. Agreement with the legend is the raster panel's
 * job, and kernel group N asserts it there.
 *
 * ⚠️ THE OLD "≥ 40 APART IN RGB" RULE CANNOT SURVIVE GREYSCALE, and the reason
 * is arithmetic rather than aesthetic. Grey has one axis, not three. Seven tones
 * 40 apart need a span of 240, and the usable span is smaller than that at both
 * ends: a base above ~225 lifts to a fill indistinguishable from the white stage
 * (--stage: #ffffff), and a base below ~55 crushes to black once the contact
 * shading and the sky-view-factor AO have both multiplied into it. The honest
 * span is roughly 96–224, which gives 21 between neighbours for seven species —
 * and NOTHING for sixteen. So tone stops being the identity channel and becomes
 * ordering only; the silhouette check in the RENDER suite (group R4) is what now
 * guarantees the species stay tellable apart. It lives there rather than in the
 * kernel suite because the kernel suite runs in Node, where the bare specifier
 * "three" does not resolve — this project has no node_modules by design.
 */
/**
 * ONE INK FOR EVERY WIREFRAME. In a printed manual every line is the same
 * weight and the same black; only the fills vary. Deriving the edge tone per
 * species meant the palest plant was drawn in mid-grey and stopped reading as
 * line-work at all.
 */
export const PLANT_INK = [26, 26, 26];

/**
 * Face opacity, and it ENCODES MOISTURE PREFERENCE rather than identity.
 *
 * Identity is the silhouette's job — asserted in render group R4 — which frees
 * this channel to carry something. Opacity tracks where on the wetness gradient
 * a plant belongs: the wettest fills are nearly solid, the driest almost empty
 * outlines. So a mire reads dense and a dry exposed ridge reads as pale line
 * work, and the plate's tonal gradient means the same thing the tool's own TWI
 * axis means. Species that share a level share a habitat, which is information
 * rather than a collision.
 */
export const MOISTURE_ALPHA = {
  wet: 0.55,     // standing water or permanently saturated peat
  damp: 0.44,    // moist mineral ground, flushes, lee slopes
  mesic: 0.33,   // freely drained but not droughty — most disturbed ground
  dry: 0.22,     // sharply drained gravel, exposed heath
  xeric: 0.13,   // bare stone and lichen crust
};

/**
 * ⚠️ SPECIFIED AS OPACITY, RENDERED AS ITS COMPOSITE OVER THE STAGE — and that
 * is not a shortcut, it is the only correct implementation of it here.
 *
 * Real per-face alpha breaks hidden-surface removal in BOTH outputs. In the
 * scene, three.js cannot depth-sort within an InstancedMesh, so 12 000
 * transparent plants sort by mesh and shimmer as the camera moves. On the plate
 * the failure is worse and quieter: the SVG relies on a painter's sort with
 * OPAQUE fills to hide back faces, so any real fill-opacity makes every plant
 * show its own interior and go blotchy.
 *
 * Composited over the white stage the two are identical anyway —
 * `alpha·ink + (1−alpha)·white` IS a grey — so the specification stays in
 * opacity, where it is meaningful, and the rendering stays opaque, where it is
 * correct. The one real difference, that overlapping plants would compound,
 * is not wanted: a plant in front should hide the one behind.
 */
const STAGE = 255;
export const compositeOverStage = (alpha) =>
  Math.round(STAGE + (PLANT_INK[0] - STAGE) * alpha);

/** id -> moisture band. The seven modelled species; plantlib.js carries all 16. */
export const PLANT_MOISTURE = {
  sphagnum: "wet",
  deschampsia: "damp",
  salix: "damp",
  trifolium: "mesic",
  rumex: "dry",
  lupinus: "dry",
  cladonia: "xeric",
};

/** Opaque fill actually handed to the material, derived — never hand-tuned. */
export const PLANT_COLOUR = Object.fromEntries(
  Object.entries(PLANT_MOISTURE).map(([id, band]) => {
    const v = compositeOverStage(MOISTURE_ALPHA[band]);
    return [id, [v, v, v]];
  }));

/**
 * Merge simple primitives into one geometry.
 *
 * Written by hand because BufferGeometryUtils lives in three's examples, and
 * this project vendors only the core module — the same reason its GeoTIFF
 * reader and ZIP writer are hand-written. Only what is needed: position,
 * normal, index.
 * @param {Array<{geo: THREE.BufferGeometry, t?: number[], s?: number[]}>} parts
 */
function mergeGeoms(parts) {
  const pos = [], nor = [], idx = [];
  for (const { geo, t = [0, 0, 0], s = [1, 1, 1] } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const base = pos.length / 3;
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i] * s[0] + t[0], p[i + 1] * s[1] + t[1], p[i + 2] * s[2] + t[2]);
      // Non-uniform scale needs the inverse-transpose for normals; these are
      // re-derived by computeVertexNormals below, so just carry them across.
      nor.push(n[i], n[i + 1], n[i + 2]);
    }
    for (let i = 0; i < p.length / 3; i++) idx.push(base + i);
    if (g !== geo) g.dispose();
    geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  out.computeVertexNormals();
  return out;
}

/**
 * A low-poly body per growth form, built Z-up.
 *
 * ⚠️ WHY THIS REPLACED TEXTURED BILLBOARDS. The previous version drew each plant
 * as three intersecting alpha-cut planes. Every defect that followed was an
 * alpha-cutout defect: a dark rim from black RGB in the transparent texels, a
 * white rim from coverage blending against the white sky, coverage drifting
 * with mip level so distant plants changed shape, and one plane lying flat with
 * a side elevation printed on it so every plant looked like it had fallen over.
 *
 * Solid geometry has none of those failure modes, because it has no alpha. It is
 * also correct from EVERY angle including plan, which is what the horizontal
 * plane was a workaround for.
 *
 * And it suits the tool. The terrain is hard-shaded facets with a drawn triangle
 * lattice; the figures carry scale bars and north arrows; the chrome is
 * achromatic. Line-work vegetation reads as deliberate in that company, and — the
 * point that matters most — a drawing cannot be mistaken for a photograph, so
 * the scatter reads as a SPECIFICATION rather than as a prediction of what will
 * grow. That is the same argument the project makes about micro-relief and
 * substrate being designed rather than surveyed.
 *
 * Silhouettes are kept deliberately distinct: cushion, plate, trefoil cluster,
 * upward-spreading fan, slender stem, canopy on a trunk, tall spike.
 *
 * ⚠️ EVERY FORM MUST BE MIRROR-SYMMETRIC ABOUT ITS VERTICAL AXIS, and two
 * specific things break it silently. Both are asserted in render group R4.
 *
 * 1. RADIAL ARRANGEMENTS STARTING AT ANGLE 0 — the loops in this file that
 *    place N parts around an axis. Three leaflets at 0°/120°/240° put one
 *    leaflet at +0.45r and two at −0.225r, because those placements use
 *    `Math.cos(a)` for x. Adding a 90° phase fixes it for ANY count, odd or
 *    even: the angles become π/2 + 2πk/N, whose cosines are −sin(2πk/N), and
 *    that set is closed under negation because k and −k both exist. Hence the
 *    `+ Math.PI / 2` in every radial loop below.
 *
 * 2. A DELIBERATE OFF-AXIS DETAIL — a single nodding seed head, one side umbel.
 *    Where character needs an off-axis part, MIRROR IT rather than drop it.
 *
 * ⚠️ WHAT IS **NOT** A CAUSE, THOUGH IT LOOKS LIKE ONE: odd segment counts on
 * CylinderGeometry and ConeGeometry. I changed several to even on the
 * assumption that a 5-segment ring projects to +1.000 and −0.809, and that is
 * wrong — three.js builds rings as `x = r·sin(θ)`, not `r·cos(θ)`, and
 * {sin(2πk/N)} is closed under negation for EVERY N. Odd rings are already
 * symmetric. The even counts below are harmless and give a slightly calmer
 * facet pattern, but they are not what fixed anything, and an outline-based
 * symmetry test built on that premise passes everything. Render group R4 tests
 * the drawn EDGE SET instead, which is what actually catches cause 1 and 2.
 * @param {string} form
 */
function buildForm(form) {
  const [r, h] = FORMS[form] || FORMS.sward;
  switch (form) {
    case "mat": {
      // Sphagnum: a low rounded cushion.
      const g = new THREE.IcosahedronGeometry(r, 0);
      g.scale(1, 1, h / r);
      g.translate(0, 0, h * 0.5);
      return g;
    }
    case "crust": {
      // Cladonia: a thin angular plate, flatter and more faceted than the
      // cushion so the two ground-huggers do not read alike.
      const g = new THREE.CylinderGeometry(r, r * 0.86, h, 8);
      g.rotateX(Math.PI / 2);
      g.translate(0, 0, h * 0.5);
      return g;
    }
    case "sward": {
      // Trifolium: three small leaflets, a trefoil in plan.
      const parts = [];
      for (let i = 0; i < 3; i++) {
        const a = Math.PI / 2 + (i / 3) * Math.PI * 2;
        parts.push({
          geo: new THREE.OctahedronGeometry(r * 0.5, 0),
          s: [1, 1, h / (r * 0.5) * 0.9],
          t: [Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45, h * 0.5],
        });
      }
      return mergeGeoms(parts);
    }
    case "tussock": {
      // Deschampsia: narrow at the base, spreading upward — the tussock's
      // defining profile, and the inverse of a cone.
      const g = new THREE.CylinderGeometry(r * 1.15, r * 0.22, h, 6, 1, true);
      g.rotateX(Math.PI / 2);
      g.translate(0, 0, h * 0.5);
      return g;
    }
    case "herb": {
      // Rumex: a slender stem carrying a small seed head.
      const stem = new THREE.CylinderGeometry(r * 0.16, r * 0.22, h * 0.78, 6);
      stem.rotateX(Math.PI / 2);
      const head = new THREE.OctahedronGeometry(r * 0.62, 0);
      return mergeGeoms([
        { geo: stem, t: [0, 0, h * 0.39] },
        { geo: head, s: [0.55, 0.55, 1.5], t: [0, 0, h * 0.82] },
      ]);
    }
    case "shrub": {
      // Salix: a rounded canopy on a short trunk.
      const trunk = new THREE.CylinderGeometry(r * 0.11, r * 0.15, h * 0.42, 6);
      trunk.rotateX(Math.PI / 2);
      const canopy = new THREE.IcosahedronGeometry(r, 0);
      return mergeGeoms([
        { geo: trunk, t: [0, 0, h * 0.21] },
        { geo: canopy, s: [1, 1, 0.72], t: [0, 0, h * 0.66] },
      ]);
    }
    case "cotton-head": {
      // Eriophorum: a wire stem carrying a tuft. The nod was drawn first as a
      // single head pushed off-axis, which broke the mirror rule above; it is
      // now a PAIR of heads, which keeps the top-heavy droop of a cottongrass
      // and stays symmetric. Wider and flatter than the sorrel's seed head so
      // the two slender stems do not converge.
      const stem = new THREE.CylinderGeometry(r * 0.10, r * 0.14, h * 0.80, 6);
      stem.rotateX(Math.PI / 2);
      return mergeGeoms([
        { geo: stem, t: [0, 0, h * 0.40] },
        { geo: new THREE.IcosahedronGeometry(r * 0.62, 0), s: [1, 1, 0.62], t: [-r * 0.34, 0, h * 0.88] },
        { geo: new THREE.IcosahedronGeometry(r * 0.62, 0), s: [1, 1, 0.62], t: [r * 0.34, 0, h * 0.88] },
      ]);
    }
    case "whorl": {
      // Equisetum: a straight stem through four tiers of branches that angle
      // upward and shorten with height — a pagoda, not a cone.
      const parts = [];
      const stem = new THREE.CylinderGeometry(r * 0.16, r * 0.20, h, 6);
      stem.rotateX(Math.PI / 2);
      parts.push({ geo: stem, t: [0, 0, h * 0.5] });
      for (const [z, k] of [[0.30, 1.0], [0.52, 0.78], [0.72, 0.54], [0.88, 0.32]]) {
        // Apex DOWN, so the skirt opens upward the way the branches actually go.
        const tier = new THREE.ConeGeometry(r * k, h * 0.15, 6, 1, true);
        tier.rotateX(-Math.PI / 2);
        parts.push({ geo: tier, t: [0, 0, h * z] });
      }
      return mergeGeoms(parts);
    }
    case "rosette": {
      // Tussilago: flat round basal leaves and almost no height. Distinct from
      // the clover trefoil by being five-lobed, wider and flatter.
      const parts = [];
      for (let i = 0; i < 5; i++) {
        const a = Math.PI / 2 + (i / 5) * Math.PI * 2;
        parts.push({
          geo: new THREE.IcosahedronGeometry(r * 0.55, 0),
          s: [1, 1, 0.28],
          t: [Math.cos(a) * r * 0.52, Math.sin(a) * r * 0.52, h * 0.45],
        });
      }
      return mergeGeoms(parts);
    }
    case "wand": {
      // Chamerion: the deliberate contrast with the lupine. Both are tall
      // spikes, which is the one silhouette clash in the set, so this one is
      // slimmer, taller and carries NO basal leaf whorl.
      const stem = new THREE.CylinderGeometry(r * 0.11, r * 0.16, h * 0.72, 6);
      stem.rotateX(Math.PI / 2);
      const spike = new THREE.ConeGeometry(r * 0.34, h * 0.42, 6);
      spike.rotateX(Math.PI / 2);
      return mergeGeoms([
        { geo: stem, t: [0, 0, h * 0.36] },
        { geo: spike, t: [0, 0, h * 0.79] },
      ]);
    }
    case "dwarf-shrub": {
      // Calluna: wiry stems under a low crown. The first version read as a
      // TABLE — five even legs holding up a flat plate — because the crown was
      // both wide and flat while the stems were vertical. Now the stems splay
      // outward and the crown is a squat dome that sits down among them, which
      // reads as a bush rather than furniture.
      const parts = [];
      for (let i = 0; i < 5; i++) {
        const a = Math.PI / 2 + (i / 5) * Math.PI * 2;
        const br = new THREE.CylinderGeometry(r * 0.06, r * 0.11, h * 0.86, 4);
        br.rotateX(Math.PI / 2);
        // Lean each stem out from the base: top displaced further than bottom.
        parts.push({
          geo: br, s: [1, 1, 1],
          t: [Math.cos(a) * r * 0.40, Math.sin(a) * r * 0.40, h * 0.43],
        });
      }
      parts.push({
        geo: new THREE.IcosahedronGeometry(r * 0.92, 0),
        s: [1, 1, 0.60], t: [0, 0, h * 0.70],
      });
      return mergeGeoms(parts);
    }
    case "prostrate-mat": {
      // Empetrum: a spreading patch of overlapping lobes. Kept angular and
      // multi-centred so it does not read as the Sphagnum cushion.
      const parts = [];
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        const lobe = new THREE.CylinderGeometry(r * 0.52, r * 0.46, h * 0.9, 6);
        lobe.rotateX(Math.PI / 2);
        parts.push({ geo: lobe, t: [Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45, h * 0.45] });
      }
      return mergeGeoms(parts);
    }
    case "tree": {
      // Betula pubescens ssp. czerepanovii: multi-stemmed, which is how the
      // mountain birch actually grows this far north — not a single trunk.
      const parts = [];
      for (let i = 0; i < 3; i++) {
        const a = Math.PI / 2 + (i / 3) * Math.PI * 2;
        const tr = new THREE.CylinderGeometry(r * 0.045, r * 0.075, h * 0.62, 6);
        tr.rotateX(Math.PI / 2);
        parts.push({ geo: tr, t: [Math.cos(a) * r * 0.16, Math.sin(a) * r * 0.16, h * 0.31] });
      }
      // ⚠️ NOT the willow's canopy with a longer trunk — measured at 0.166
      // against it, the weakest woody pair in the set. A birch crown is taller
      // than it is wide and breaks into two masses; the willow's is a squat
      // dome. That difference has to be in the geometry, not in the caption.
      parts.push({
        geo: new THREE.IcosahedronGeometry(r * 0.82, 0), s: [1, 1, 1.24], t: [0, 0, h * 0.76],
      });
      parts.push({
        geo: new THREE.IcosahedronGeometry(r * 0.58, 0), s: [1, 1, 0.92], t: [0, 0, h * 0.52],
      });
      return mergeGeoms(parts);
    }
    case "hummock": {
      // Racomitrium: an OCTAHEDRON, where Sphagnum's cushion is an icosahedron.
      // Fewer, sharper facets is the whole difference — the fringe-moss hummock
      // is angular where the bog moss is soft, and at this polygon count that
      // reads immediately.
      const g = new THREE.OctahedronGeometry(r, 0);
      g.scale(1, 1, h / r);
      g.translate(0, 0, h * 0.5);
      return g;
    }
    case "umbel": {
      // Heracleum persicum, the Tromsø palm: a thick stem under a flat plate,
      // with one side umbel. The most distinctive outline in the set, and at
      // 2.35 m it towers over everything else at true proportion.
      const stem = new THREE.CylinderGeometry(r * 0.11, r * 0.17, h * 0.82, 6);
      stem.rotateX(Math.PI / 2);
      const head = new THREE.ConeGeometry(r, h * 0.13, 8, 1, true);
      head.rotateX(-Math.PI / 2);
      // TWO side umbels, not one. A single one was the more natural drawing and
      // it broke the mirror rule; a pair keeps the tiered look and is symmetric.
      const side = () => {
        const c = new THREE.ConeGeometry(r * 0.42, h * 0.07, 6, 1, true);
        c.rotateX(-Math.PI / 2);
        return c;
      };
      return mergeGeoms([
        { geo: stem, t: [0, 0, h * 0.41] },
        { geo: head, t: [0, 0, h * 0.88] },
        { geo: side(), t: [-r * 0.46, 0, h * 0.70] },
        { geo: side(), t: [r * 0.46, 0, h * 0.70] },
      ]);
    }
    case "tall-forb":
    default: {
      // Lupinus: the tall flower spike that makes it recognisable at a
      // hundred metres, over a low whorl of leaves.
      const stem = new THREE.CylinderGeometry(r * 0.13, r * 0.18, h * 0.55, 6);
      stem.rotateX(Math.PI / 2);
      const spike = new THREE.ConeGeometry(r * 0.62, h * 0.5, 6);
      spike.rotateX(Math.PI / 2);
      const leaves = new THREE.CylinderGeometry(r, r * 0.3, h * 0.06, 8);
      leaves.rotateX(Math.PI / 2);
      return mergeGeoms([
        { geo: leaves, t: [0, 0, h * 0.13] },
        { geo: stem, t: [0, 0, h * 0.36] },
        { geo: spike, t: [0, 0, h * 0.75] },
      ]);
    }
  }
}

/**
 * Build a growth form and then SIT IT ON THE GROUND at exactly its declared
 * height.
 *
 * ⚠️ DO NOT HAND-COMPUTE THE OFFSET PER FORM — that is what went wrong first
 * time. Translating by `h * 0.5` assumes the primitive's half-height is `h/2`,
 * which is true for a cylinder and false for a polyhedron: IcosahedronGeometry's
 * parameter is the CIRCUMRADIUS, so the moss cushion and the clover leaflets
 * both ended up buried below z=0. Nothing threw; they were simply half
 * underground. Normalising from the measured bounding box is self-correcting
 * and keeps FORMS as the single source of truth for size, which is what
 * SPECIES-RULES.txt documents.
 * Exported because two things outside the scatter need the REAL geometry rather
 * than a picture of it: the silhouette check in render group R4, and the species
 * plate drawn for the poster. Both would be worthless drawn from a copy that
 * could drift from what the scene actually renders.
 * @param {string} form
 */
export function cadGeometry(form) {
  const [, h] = FORMS[form] || FORMS.sward;
  const g = buildForm(form);
  g.computeBoundingBox();
  const bb = /** @type {THREE.Box3} */ (g.boundingBox);
  const span = bb.max.z - bb.min.z;
  if (span > 1e-6) g.scale(1, 1, h / span);
  g.computeBoundingBox();
  g.translate(0, 0, -(/** @type {THREE.Box3} */ (g.boundingBox).min.z));
  g.computeVertexNormals();

  // CONTACT SHADING, baked into vertex colours: darker where the body meets the
  // ground, lighter at the top. Without it a plant reads as pasted onto the
  // surface rather than standing in it — the base is the one place a viewer
  // looks for the join, and a uniform tint gives them nothing there. Costs one
  // attribute and no shader work; three multiplies vertex colour, instance
  // colour and material colour together.
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = h > 0 ? Math.min(1, Math.max(0, pos.getZ(i) / h)) : 1;
    const v = 0.66 + 0.34 * t;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** Deterministic RNG. The scatter must be identical from run to run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class PlantField {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {{verticalExaggeration?: number, density?: number, seed?: number}} [opts]
   */
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.exaggeration = opts.verticalExaggeration ?? 1;
    this.density = opts.density ?? DENSITY_PER_M2;
    this.seed = opts.seed ?? 20260731;

    const areaM2 = dem.ncols * dem.cell * dem.nrows * dem.cell;
    this.count = Math.max(500, Math.min(MAX_CANDIDATES,
      Math.round(areaM2 * this.density)));

    // The UTM origin lives here and nowhere else. Everything below is local.
    this.group = new THREE.Group();
    this.group.position.set(dem.originX, dem.originY, 0);
    this.group.renderOrder = 1;

    this._buildCandidates();
    this._buildMeshes();
    /** cells per species at the last update, for the caller's readouts */
    this.drawn = new Int32Array(SPECIES.length);
  }

  /**
   * Lay the scatter down once. Each candidate is bound to a cell for the life
   * of the field — this is what makes a plant unable to move.
   */
  _buildCandidates() {
    const { nrows, ncols, cell } = this.dem;
    const rnd = mulberry32(this.seed);
    const n = this.count;
    this.cellOf = new Int32Array(n);
    this.localX = new Float32Array(n);
    this.localY = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.jitter = new Float32Array(n);
    this.aspect = new Float32Array(n);

    const northY = nrows * cell; // LOCAL north edge — see the header
    for (let k = 0; k < n; k++) {
      const r = Math.min(nrows - 1, Math.floor(rnd() * nrows));
      const c = Math.min(ncols - 1, Math.floor(rnd() * ncols));
      this.cellOf[k] = r * ncols + c;
      // Somewhere inside its own cell, so the scatter does not sit on a lattice.
      this.localX[k] = (c + rnd()) * cell;
      this.localY[k] = northY - (r + rnd()) * cell;
      this.rot[k] = rnd() * Math.PI * 2;
      // ⚠️ SIZE VARIES LOG-NORMALLY, ROUGHLY 0.6x TO 1.7x, and the spread is
      // deliberate. The first version used a flat ±25%, which is far too tight
      // to read: every plant of a species came out the same size and the
      // scatter looked stamped rather than grown. Real stands are dominated by
      // a few large individuals among many small ones, which is a log-normal
      // shape, and it is symmetric in log space so the mean size is unchanged.
      this.jitter[k] = Math.exp((rnd() * 2 - 1) * 0.55);
      // A second, independent stretch on height alone. Two plants of the same
      // footprint can be quite different heights, and varying only the overall
      // scale makes every silhouette a copy at a different zoom.
      this.aspect[k] = 0.78 + rnd() * 0.55;
    }
  }

  /**
   * Two instanced meshes per species over ONE shared geometry: a pale flat-
   * shaded solid, and the same solid drawn as wireframe in a darker tone.
   *
   * This is the terrain's own treatment — surface.js hard-shades the ground and
   * lays a triangle lattice over it — applied to the vegetation so the two read
   * as one drawing rather than as a diagram with game assets standing on it.
   *
   * ⚠️ `wireframe: true` ON AN InstancedMesh IS WHAT MAKES THIS AFFORDABLE.
   * three.js core has no instanced line primitive, and building one LineSegments
   * geometry for 12 000 plants would mean rewriting ~4 MB of vertices every time
   * the assemblage changed. A wireframe material draws the triangle edges of
   * geometry that is already instanced, so the edges cost a second draw call per
   * species and nothing else. It also draws the triangulation diagonals — which
   * is the faceted CAD look, not a defect.
   */
  _buildMeshes() {
    /** @type {THREE.InstancedMesh[]} */
    this.meshes = [];
    /** @type {THREE.InstancedMesh[]} */
    this.wires = [];
    for (let s = 0; s < SPECIES.length; s++) {
      const geo = cadGeometry(SPECIES[s].form);
      const [r, g, b] = PLANT_COLOUR[SPECIES[s].id];
      const col = new THREE.Color(r / 255, g / 255, b / 255);

      const solid = new THREE.MeshLambertMaterial({
        // ⚠️ USED AS-IS — no lift toward paper any more. PLANT_COLOUR is now
        // already the composite of the ink over the white stage at this
        // species' moisture opacity, so lifting it again would apply the same
        // lightening twice and flatten the whole gradient.
        color: col.clone(),
        // ⚠️ FLAT SHADING, deliberately — the same reading the terrain gets.
        // Each facet is a visible sample rather than a smooth blob, which is
        // what makes a low-poly body look drawn instead of cheap.
        flatShading: true,
        side: THREE.FrontSide,
        // ⚠️ OPT OUT OF THE SCENE FOG. view.js:87 sets a white fog whose ONLY
        // job is fading the infinite ground grid out to the horizon, with near
        // at the camera distance — so anything that does not opt out washes to
        // white as soon as it is more than a stone's throw away. surface.js and
        // voxels.js both set fog:false for exactly this reason; omitting it here
        // made the whole scatter dissolve into the sky at distance.
        fog: false,
      });
      const edge = new THREE.MeshBasicMaterial({
        // ⚠️ ONE INK FOR EVERY SPECIES — see PLANT_INK. Deriving this per
        // species drew the palest plants in mid-grey, which is not line-work.
        color: new THREE.Color(
          PLANT_INK[0] / 255, PLANT_INK[1] / 255, PLANT_INK[2] / 255),
        wireframe: true,
        fog: false,   // as above — only the ground grid fades
        // Lighting a line adds nothing; MeshBasic keeps the edge tone constant
        // so the drawing does not fade on faces turned from the key light.
      });

      solid.vertexColors = true;
      edge.vertexColors = true;

      const mk = (mat, name) => {
        const m = new THREE.InstancedMesh(geo, mat, this.count);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Per-instance ambient occlusion — see setAO(). Starts at white so a
        // field with no sky-view factor yet simply renders unshaded.
        m.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(this.count * 3).fill(1), 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
        m.count = 0;
        m.frustumCulled = false;    // instances span the whole tile
        m.name = name;
        this.group.add(m);
        return m;
      };
      this.meshes.push(mk(solid, `plants:${SPECIES[s].id}`));
      this.wires.push(mk(edge, `plants:${SPECIES[s].id}:edges`));
    }
  }

  /**
   * Re-assign every candidate to whichever species won its cell.
   *
   * Costs one pass over the candidates plus a partial buffer upload, and runs
   * once per worker result rather than per frame.
   *
   * @param {Uint8Array} codes  the assemblage, one class per cell
   */
  update(codes) {
    if (!codes) return;
    const { z } = this.dem;
    const ex = this.exaggeration;
    const svf = this.ao;
    const nSp = this.meshes.length;
    const used = this.drawn;
    used.fill(0);

    for (let k = 0; k < this.count; k++) {
      const i = this.cellOf[k];
      const s = codes[i];
      // 254 (bare) and 255 (nodata) are answers, not species: nothing is drawn.
      if (s >= nSp) continue;
      const zv = z[i];
      if (!Number.isFinite(zv)) continue;

      const j = this.jitter[k];
      // POSITION still follows the exaggerated surface — a plant has to stand
      // on the ground as drawn, or it floats.
      _p.set(this.localX[k], this.localY[k], zv * ex);
      _q.setFromAxisAngle(_axis, this.rot[k]);
      // ⚠️ BUT SIZE DOES NOT. Stretching plant height by the terrain's
      // exaggeration made every plant spindly: at 2.5x a 0.36 m tussock stood
      // 0.9 m tall and stayed 0.26 m wide. Plants keep their true proportions;
      // only the ground is exaggerated, and the sidebar states the factor.
      _s.set(j, j, j * this.aspect[k]);
      _m.compose(_p, _q, _s);
      const slot = used[s]++;
      this.meshes[s].setMatrixAt(slot, _m);
      // ⚠️ AMBIENT OCCLUSION FROM THE SKY-VIEW FACTOR ALREADY IN MEMORY. The
      // terrain is shaded this way (app.js hands surface.setAO the same grid),
      // and giving the plants nothing was most of why they read as pasted on:
      // a plant in a hollow was lit exactly like one on an open rise. This
      // costs a lookup per instance and no new computation at all.
      if (svf) {
        const a = 1 - AO_STRENGTH * (1 - Math.min(1, Math.max(0, svf[i])));
        this.meshes[s].instanceColor.setXYZ(slot, a, a, a);
        this.wires[s].instanceColor.setXYZ(slot, a, a, a);
      }
    }

    for (let s = 0; s < nSp; s++) {
      const mesh = this.meshes[s], wire = this.wires[s];
      mesh.count = wire.count = used[s];
      if (used[s] > 0) {
        // The edge pass draws the SAME instances, so copy the matrices across
        // rather than composing every transform twice.
        wire.instanceMatrix.array.set(
          mesh.instanceMatrix.array.subarray(0, used[s] * 16));
        // Upload only the slots written. The buffers are sized for the worst
        // case — every candidate one species — and uploading all seven in full
        // on every pass would be ~5 MB a gesture.
        for (const a of [mesh.instanceMatrix, wire.instanceMatrix]) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, used[s] * 16);
          a.needsUpdate = true;
        }
        if (this.ao) {
          mesh.instanceColor.needsUpdate = true;
          wire.instanceColor.needsUpdate = true;
        }
      }
    }
  }

  /**
   * Hand the field the sky-view factor grid — the same one the terrain uses for
   * its own occlusion, so ground and vegetation are shaded by one measure.
   * Arrives only when a gesture settles, because horizon tracing is costly.
   * @param {Float32Array|null} svf
   */
  setAO(svf) {
    this.ao = svf || null;
    if (this._lastCodes) this.update(this._lastCodes);
  }

  /** @param {number} v */
  setExaggeration(v) {
    this.exaggeration = v;
    this._lastCodes && this.update(this._lastCodes);
  }

  /** Keep the codes so an exaggeration change can re-place without the worker. */
  /** @param {Uint8Array} codes */
  setCodes(codes) {
    this._lastCodes = codes;
    this.update(codes);
  }

  /** @param {boolean} v */
  setVisible(v) { this.group.visible = v; }

  /** Total instances currently drawn. */
  get instanceCount() {
    let n = 0;
    for (const m of this.meshes) n += m.count;
    return n;
  }

  dispose() {
    // Solid and edge share one geometry per species, so dispose it once — from
    // the solid pass — and only the materials twice.
    for (const m of this.meshes) m.geometry.dispose();
    for (const m of [...this.meshes, ...this.wires]) {
      /** @type {THREE.Material} */ (m.material).dispose();
      m.dispose();
    }
    this.group.clear();
    this.meshes = [];
    this.wires = [];
  }
}
