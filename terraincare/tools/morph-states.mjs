// @ts-check
// THE SEVEN GROUNDS THE FILM MORPHS THROUGH — built headless, and checked
// against the matrix sheet's own published figures before anything is drawn.
//
// Marc, 2026-09-08: "use the terrain transformations from the A1 poster and
// blend from one state to another ... as surveyed -> terraced uniform ->
// terraced by landform -> steep ground only -> pit and mound -> the levelled
// platform - or better to a very smoothed version - where the water flows very
// fast -> and then back to the original state."
//
// ⚠️⚠️ "OR BETTER A VERY SMOOTHED VERSION" SOLVES A PROBLEM, IT IS NOT A
// SUBSTITUTION. Case 2, the levelled platform, is the ONE state on the sheet
// that cannot be rebuilt from what the sheet publishes: its region was DRAWN,
// 6,144 cells at mean 65.53 m matches 123 different rectangles, and levelling to
// a region's own mean is net-zero by construction while the sheet reports net
// +1,518 m3 — implying a batter whose angle is nowhere stated. A morph needs the
// actual surface, not a picture of one, so case 2 could not have been in this
// film at all. A smoothed ground is fully reproducible from one number, and it
// makes the hydrological point BETTER: it is the state where storage is gone and
// water leaves fastest, which is exactly what the sequence is arguing.
//
// ⚠️⚠️ THE SMOOTHED STATE MUST NOT CLAIM ITS POINT FROM PEAK OUTFALL.
// The obvious caption is "the water leaves fast" and the obvious number to hang
// it on is peak outfall. Swept, that number is NOISE: 68.80, 52.36, 73.49, 53.46,
// 59.86, 45.26, 40.39 m3 at sigma 5, 5.5, 6, 6.5, 7, 8, 10. It is a MAXIMUM over
// outlets, so it jumps whenever smoothing reorganises which outlet is the
// largest, and any sigma picked by it is picked out of a +/-20 m3 scatter. The
// first guess here, 3.0 m, measured 31.09 m3 against the surveyed 29.67 - it
// would have shipped a state asserting fast water while measuring almost none.
//
// What IS stable and monotonic is the thing the state is actually for: STORAGE.
// Closed depressions collapse 235 -> 4 and geodiversity falls to 0.6144, the
// lowest of all seven grounds. The film says the storage is gone. It does not
// put a number on the speed.
//
// ⚠️ EVERY STATE IS A SURFACE ON THE SAME GRID. The morph is a per-cell mix
// between two of them, so all seven must share nrows/ncols/cell and must be
// built ONCE at load. Rebuilding per frame would make stateAt(t) impure and both
// the loop-seam and random-seek checks meaningless — the trap timeline.js
// carries a warning about.
//
// Usage:
//   node tools/morph-states.mjs --verify      build all seven, check the sheet
//   node tools/morph-states.mjs --sweep       find the pitmound + smoothing values
//
import { measureSurface } from "../static/compare.js";
import { pathToFileURL } from "node:url";
import {
  buildStatesFrom, smoothInPlace, stamp, C6, SMOOTH_SIGMA_M,
} from "../static/morphstates.js";
import { poiPatch, PUBLISHED as CASE_PUBLISHED } from "./poster-cases.mjs";

export { smoothInPlace, stamp, C6, SMOOTH_SIGMA_M };

/**
 * What the 2026-08-27 matrix sheet publishes, quoted so the build has something
 * to FAIL against rather than targets to tune toward.
 */
export const PUBLISHED = {
  ...CASE_PUBLISHED,
  "c6-pattern": { geodiversity: 0.6996, hollows: 194, outfall: 16.65, volume: 145 },
};

/** The seven stops of the morph, on the surveyed tile. */
export function buildStates() {
  return buildStatesFrom(poiPatch());
}

// ── the sweeps ──────────────────────────────────────────────────────────────
function sweep() {
  const base = poiPatch();
  console.log("CASE 6 — the sheet states 194 hollows, 145 m3 moved, "
    + "geodiversity 0.6996, peak outfall 16.65\n");
  console.log("  seed  amp    hollows  volume   geodiv   outfall");
  for (const seed of [1, 2, 3]) {
    for (const amplitude of [0.18, 0.19, 0.20, 0.21, 0.22, 0.24]) {
      const s = stamp(base, { ...C6, seed, amplitude });
      const m = measureSurface(s.dem);
      const vol = s.cut + s.fill;
      const hit = m.hollows === 194 && Math.abs(vol - 145) <= 2;
      console.log("  " + String(seed).padStart(4) + "  " + amplitude.toFixed(2)
        + "   " + String(m.hollows).padStart(6)
        + "   " + vol.toFixed(0).padStart(5) + " m3"
        + "  " + m.geodiversity.toFixed(4)
        + "   " + m.peakOutfall.toFixed(2) + (hit ? "   <<< MATCHES" : ""));
    }
  }

  console.log("\nSMOOTHING - read HOLLOWS and GEODIVERSITY, not peak outfall.");
  console.log("Outfall is a maximum over outlets and jumps by +/-20 m3 between");
  console.log("adjacent sigmas; a radius chosen by it is chosen out of scatter.\n");
  const b = measureSurface(base);
  console.log("  sigma      hollows   geodiv   peak outfall");
  console.log("  surveyed   " + String(b.hollows).padStart(6) + "   "
    + b.geodiversity.toFixed(4) + "   " + b.peakOutfall.toFixed(2) + " m3");
  for (const sig of [0.5, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 10.0]) {
    const d = base.clone();
    smoothInPlace(d, sig);
    const m = measureSurface(d);
    console.log("  " + (sig.toFixed(1) + " m").padStart(8) + "   "
      + String(m.hollows).padStart(6) + "   " + m.geodiversity.toFixed(4)
      + "   " + m.peakOutfall.toFixed(2) + " m3");
  }
}

function verify() {
  const states = buildStates();
  console.log("THE SEVEN GROUNDS — 64 x 64 m at 0.25 m\n");
  let bad = 0;
  for (const s of states) {
    const m = measureSurface(s.dem);
    const p = PUBLISHED[s.id];
    console.log("  " + s.id.padEnd(14)
      + " geodiv " + m.geodiversity.toFixed(4)
      + "  hollows " + String(m.hollows).padStart(4)
      + "  outfall " + m.peakOutfall.toFixed(2).padStart(6)
      + (s.volume != null ? "  vol " + s.volume.toFixed(0).padStart(5) + " m3" : ""));
    if (!p) { console.log("                 (no published figure — new state)"); continue; }
    const n = [];
    const chk = (ok, name, want) => {
      n.push(ok ? name + " OK" : name + " MISMATCH want " + want); if (!ok) bad++;
    };
    if (p.geodiversity != null)
      chk(Math.abs(m.geodiversity - p.geodiversity) <= 0.0005, "geodiv", p.geodiversity);
    if (p.hollows != null) chk(m.hollows === p.hollows, "hollows", p.hollows);
    if (p.volume != null && s.volume != null)
      chk(Math.abs(s.volume - p.volume) <= 2, "volume", p.volume);
    if (p.outfall != null)
      chk(Math.abs(m.peakOutfall - p.outfall) <= 0.02, "outfall", p.outfall);
    console.log("                 " + n.join(" · "));
  }
  console.log("\n" + (bad === 0
    ? "EVERY PUBLISHED FIGURE REPRODUCES — the morph runs on the sheet's own grounds."
    : bad + " MISMATCH(ES) — do NOT morph between these."));
  return bad;
}

const IS_MAIN = !!process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN && process.argv.includes("--sweep")) sweep();
else if (IS_MAIN && process.argv.includes("--verify")) process.exit(verify() === 0 ? 0 : 1);
