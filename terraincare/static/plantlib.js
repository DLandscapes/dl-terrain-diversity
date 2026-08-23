// @ts-check
/**
 * THE PLANT LIBRARY — sixteen drawings, seven of which are also species.
 *
 * ⚠️ THIS IS NOT THE SPECIES MODEL AND MUST NOT BECOME IT BY ACCIDENT.
 * `analysis/species.js` holds seven classes with fitted habitat envelopes, and
 * every published figure in the project — Shannon H′ 1.721 surveyed, 0.000
 * levelled, 1.684 redesigned — is quoted against ln(7) = 1.946. Moving the model
 * to sixteen changes that ceiling to ln(16) = 2.773 and re-baselines all of it,
 * including the numbers in the extended abstract. That is a deliberate decision
 * to take on its own, not a side effect of wanting more drawings.
 *
 * So this file carries what a drawing needs — a name, a growth form, a tone —
 * and nothing a model needs. There are no envelopes here. Nine of the sixteen
 * have no ecological behaviour in the tool at all yet; they exist so the plant
 * library and the 4×4 plate can be produced for the A1 poster now.
 *
 * WHEN THESE ARE PROMOTED TO SPECIES:
 *   1. ⚠️ CODES ARE APPEND-ONLY. Codes 0–6 are already written into exported
 *      rasters and must not move. `code` below reserves 7–15 in this order.
 *   2. Each needs five envelopes (moisture, substrate, energy, shelter,
 *      landform) and a peak, authored the way SPECIES-RULES.txt describes.
 *   3. ⚠️ A species whose envelope is strictly contained by another's with a
 *      lower peak can never win a cell — clover measured 0.0% until it was
 *      rewritten as a specialist. Check every new one against that.
 *   4. Re-baseline every published number and every document that quotes one.
 *
 * The first seven entries mirror `SPECIES` exactly. `checkAgainstSpecies()`
 * asserts that rather than trusting it, because a silent divergence between the
 * drawing and the model is exactly the kind of thing that survives to print.
 */

/**
 * @typedef {object} LibraryPlant
 * @property {string} id        matches SPECIES[].id for the first seven
 * @property {number} code      the class code this holds, or would hold
 * @property {string} name      the name as it is printed under the drawing
 * @property {string} form      key into FORMS in plants.js
 * @property {"wet"|"damp"|"mesic"|"dry"|"xeric"} moisture  drives face opacity
 * @property {"project"|"proposed"} source  see the provenance note below
 * @property {boolean} [invasive]  on Norway's Fremmedartslista
 * @property {boolean} [modelled]  true if it is a real class in species.js today
 * @property {string} habit     one line, printed small under the name
 */

/**
 * ⚠️ PROVENANCE IS RECORDED PER ENTRY AND IS NOT THE SAME FOR ALL SIXTEEN.
 *
 *   source: "project"  — one of the seven already in analysis/species.js. These
 *     were chosen by the author for this site. The species are real and
 *     defensible; the fitted envelopes are the author's own and an envelope
 *     review with someone who knows Troms flora is still outstanding.
 *
 *   source: "proposed" — NOT SURVEYED, NOT SOURCED FROM A DATABASE. These nine
 *     were suggested from general knowledge of subarctic oceanic flora on
 *     disturbed ground, as plausible candidates to draw. Plausible is not the
 *     same as present. NOTHING HERE IS EVIDENCE THAT THE PLANT GROWS AT
 *     ØRNDALEN, and no entry should be promoted to a species, printed on the
 *     A1, or named in the abstract on the strength of this file alone.
 *
 * The evidence that would settle it, in order of how directly it bears:
 *   1. `input/images/2026-06-06 Site visit Orndalen/` — 46 photographs taken on
 *      the site, of which only 5 have been reviewed. This is first-hand
 *      evidence already in the project and largely unexamined.
 *   2. Artskart / Artsdatabanken observation records within a radius of
 *      E 654 862, N 7 737 588 (EPSG:25833).
 *   3. Norway's Fremmedartslista for the two invasive claims.
 */

/** @type {LibraryPlant[]} */
export const PLANT_LIBRARY = [
  // ── the seven that are modelled today ────────────────────────────────────
  { id: "sphagnum", code: 0, name: "Sphagnum spp.", form: "mat", moisture: "wet",
    modelled: true, source: "project", habit: "bog moss · wettest hollows" },
  { id: "deschampsia", code: 1, name: "Deschampsia cespitosa", form: "tussock", moisture: "damp",
    modelled: true, source: "project", habit: "tufted hair-grass · damp mineral ground" },
  { id: "trifolium", code: 2, name: "Trifolium repens", form: "sward", moisture: "mesic",
    modelled: true, source: "project", habit: "white clover · the sown reclamation sward" },
  { id: "rumex", code: 3, name: "Rumex acetosella", form: "herb", moisture: "dry",
    modelled: true, source: "project", habit: "sheep's sorrel · dry acid gravel" },
  { id: "salix", code: 4, name: "Salix glauca", form: "shrub", moisture: "damp",
    modelled: true, source: "project", habit: "grey-leaf willow · sheltered lee slopes" },
  { id: "cladonia", code: 5, name: "Cladonia spp.", form: "crust", moisture: "xeric",
    modelled: true, source: "project", habit: "reindeer lichen · dry exposed stone" },
  { id: "lupinus", code: 6, name: "Lupinus nootkatensis", form: "tall-forb", moisture: "dry",
    modelled: true, source: "project", invasive: true,
    habit: "Nootka lupin · INVASIVE · open drained ground" },

  // ── nine drawn but not modelled, and NOT yet verified as present ─────────
  { id: "eriophorum", code: 7, name: "Eriophorum angustifolium", form: "cotton-head",
    moisture: "wet", source: "proposed", habit: "common cottongrass · wet peat" },
  { id: "equisetum", code: 8, name: "Equisetum arvense", form: "whorl",
    moisture: "damp", source: "proposed", habit: "field horsetail · wet disturbed mineral" },
  { id: "tussilago", code: 9, name: "Tussilago farfara", form: "rosette",
    moisture: "mesic", source: "proposed", habit: "colt's-foot · pioneer of bare ground" },
  { id: "chamerion", code: 10, name: "Chamerion angustifolium", form: "wand",
    moisture: "mesic", source: "proposed", habit: "rosebay willowherb · disturbed, well-lit" },
  { id: "calluna", code: 11, name: "Calluna vulgaris", form: "dwarf-shrub",
    moisture: "dry", source: "proposed", habit: "heather · dry acid oceanic heath" },
  { id: "empetrum", code: 12, name: "Empetrum nigrum", form: "prostrate-mat",
    moisture: "dry", source: "proposed", habit: "crowberry · dry exposed heath" },
  { id: "betula", code: 13, name: "Betula pubescens ssp. czerepanovii", form: "tree",
    moisture: "mesic", source: "proposed", habit: "mountain birch · the region's tree" },
  { id: "racomitrium", code: 14, name: "Racomitrium lanuginosum", form: "hummock",
    moisture: "xeric", source: "proposed", habit: "woolly fringe-moss · exposed stone" },
  { id: "heracleum", code: 15, name: "Heracleum persicum", form: "umbel",
    moisture: "mesic", source: "proposed", invasive: true,
    habit: "Tromsø palm · INVASIVE · nutrient-rich disturbed ground" },
];

/**
 * Assert the library has not drifted from the model it claims to extend.
 * @param {{id: string, form: string}[]} species the SPECIES array
 * @returns {string[]} problems found, empty when consistent
 */
export function checkAgainstSpecies(species) {
  const bad = [];
  for (let i = 0; i < species.length; i++) {
    const lib = PLANT_LIBRARY[i];
    if (!lib) { bad.push(`library is shorter than SPECIES at index ${i}`); continue; }
    if (lib.id !== species[i].id) bad.push(`index ${i}: id ${lib.id} vs species ${species[i].id}`);
    if (lib.form !== species[i].form) bad.push(`${lib.id}: form ${lib.form} vs species ${species[i].form}`);
    if (lib.code !== i) bad.push(`${lib.id}: code ${lib.code} should be ${i}`);
  }
  const seen = new Set();
  for (const p of PLANT_LIBRARY) {
    if (seen.has(p.code)) bad.push(`duplicate code ${p.code}`);
    seen.add(p.code);
  }
  return bad;
}
