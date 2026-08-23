// @ts-check
// THE EXPERIMENT — uniform benching against landform-patch benching, at
// matched volume, as a function instead of a console session.
//
// Phase 8E ran this by hand and it produced the strongest result the project
// has: every one of twenty-five comparisons favoured the patch scheme, and
// uniform benching landed at or BELOW untouched ground's geodiversity in four
// of five runs. A scripted experiment is not reproducible by anyone else —
// re-running it on other ground meant re-writing the script — so this module
// is that script, made a citizen of the kernel: pure functions over a DEM,
// testable headless, callable from a button.
//
// ⚠️ THE PARAMETERS ARE FIXED AND STATED, NOT READ FROM THE PANEL. The point
// of wiring this in is that two workshop groups pressing the button on the
// same ground get the same experiment — the treads, the tread share, the
// bias, the rain event and the patch threshold are all constants of the
// experiment and all appear in its report. A measurement that quietly
// followed the sliders would be a different experiment per person.
//
// ⚠️ NOTHING HERE TOUCHES THE LIVE SURFACE. Both schemes run on clones; the
// caller's DEM is read, never written. The experiment is a READING of the
// ground as it stands — run it before and after an edit and it answers a
// different, equally honest question each time.
//
// ⚠️ THE FIGURES ARE NOT QUOTABLE TO THREE DECIMALS, and the report must say
// so. The volume-matching search converges to slightly different intervals
// from run to run of the EXPERIMENT DESIGN (different ground, different
// tread), and Phase 8E measured the uniform geodiversity at 4 m tread twice
// as 0.6306 and 0.6157. The direction — which scheme wins — is the robust
// result; the third decimal is noise the caveat exists to disclaim.

import { geomorphons, LANDFORMS } from "./analysis/geomorphons.js";
import { computeGradient } from "./analysis/horn.js";
import { tri, findDepressions, geodiversityFromTRI } from "./analysis/indices.js";
import { pondWater } from "./analysis/ponding.js";
import { benchTo } from "./bench.js";
import { landformPatches, benchByPatch } from "./patches.js";

/**
 * The experiment's constants. One object, exported, so the interface and the
 * self-test read the same values the run uses — a second copy in the markup
 * would be the two-vocabularies trap again.
 */
export const EXPERIMENT = {
  /** target treads, metres — the five Phase 8E ran */
  treads: [2, 3, 4, 6, 8],
  /** share of each vertical interval given to the level tread */
  treadShare: 0.7,
  /** volume policy: balanced is the only fair one — cut and fill both count */
  bias: "balanced",
  /** the rain event peak outfall is read at, metres of depth */
  rainM: 0.02,
  /** patches below this take the default system — see benchByPatch */
  minCells: 64,
  /** the interval clamp for the per-patch scheme, metres */
  minInterval: 0.25,
  maxInterval: 6,
  /** volume match tolerance, fraction of the target volume */
  matchTol: 0.01,
};

/**
 * The four readings both schemes are judged on, plus the volume that bought
 * them. Metres cubed, nats, counts — no percentages, no scores.
 *
 * ⚠️ LANDFORM H′ IS RAW SHANNON IN NATS, not the worker's normalised
 * evenness. The Phase 8E table quotes 1.85–2.09 against ln(10) ≈ 2.30, and
 * the raw figure is the right one here because both schemes classify into
 * the same ten classes — normalising would divide both sides by the same
 * constant and pretend the number is a different kind of thing.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {{rainM?: number}} [opts]
 * @returns {{geodiversity:number, landformH:number, hollows:number,
 *            peakOutfall:number}}
 */
export function measureSurface(dem, opts = {}) {
  const rainM = opts.rainM ?? EXPERIMENT.rainM;
  const geodiversity = geodiversityFromTRI(tri(dem));

  const gm = geomorphons(dem);
  let tot = 0;
  for (const c of gm.counts) tot += c;
  let landformH = 0;
  if (tot > 0) {
    for (const c of gm.counts) {
      if (!c) continue;
      const p = c / tot;
      landformH -= p * Math.log(p);
    }
  }

  // The flood is the expensive part and both readings ride on it: the hollow
  // count is the depressions found, and the rain settles into exactly those.
  const dep = findDepressions(dem);
  const pond = pondWater(dem, rainM, { depressions: dep });
  const peakOutfall = pond.outfalls.length ? pond.outfalls[0].volume : 0;

  return { geodiversity, landformH, hollows: dep.depressions.length, peakOutfall };
}

/**
 * Find the uniform interval that moves a stated volume, by binary search.
 *
 * ⚠️ BENCH VOLUME RISES AS THE INTERVAL GROWS — the displacement to a bench
 * level is at most Δ/2, so a coarser system moves MORE earth, not less. The
 * Phase 8E session assumed the opposite sign, walked the search to the top of
 * its range and reported a 369 % volume mismatch as if it were a result. The
 * monotone direction is now asserted by a kernel check, not assumed.
 *
 * Every probe is a dryRun through the SAME benchTo that will cut the result,
 * so the volume the search matches is the volume the scheme actually moves.
 *
 * @param {import("./dem.js").DEM} dem  read only — every probe is a dryRun
 * @param {number} targetVolume  m³ of cut + fill to match
 * @param {{tread?: number, bias?: string, maxSteps?: number}} [opts]
 * @returns {{interval:number, volume:number, matched:boolean}}
 */
export function matchUniformInterval(dem, targetVolume, opts = {}) {
  const tread = opts.tread ?? EXPERIMENT.treadShare;
  const bias = opts.bias ?? EXPERIMENT.bias;
  const mask = new Uint8Array(dem.nrows * dem.ncols).fill(1);
  const volumeAt = (interval) => {
    const r = benchTo(dem, mask, { interval, tread, bias, dryRun: true });
    return r.cut + r.fill;
  };

  if (!(targetVolume > 0)) return { interval: NaN, volume: 0, matched: false };

  // Bracket the target: grow the upper bound until the volume passes it. On
  // ground with any relief the volume keeps rising with Δ; if even a 64 m
  // interval cannot move the target volume the ground cannot host the
  // comparison and the caller is told so rather than handed a wrong match.
  let lo = 0.01, hi = 1;
  let volHi = volumeAt(hi);
  let guard = 0;
  while (volHi < targetVolume && hi < 64 && guard++ < 16) {
    hi *= 2;
    volHi = volumeAt(hi);
  }
  if (volHi < targetVolume) return { interval: hi, volume: volHi, matched: false };

  for (let k = 0; k < (opts.maxSteps ?? 48); k++) {
    const mid = (lo + hi) / 2;
    if (volumeAt(mid) < targetVolume) lo = mid; else hi = mid;
  }
  const interval = (lo + hi) / 2;
  const volume = volumeAt(interval);
  return {
    interval, volume,
    matched: Math.abs(volume - targetVolume) <= targetVolume * EXPERIMENT.matchTol,
  };
}

/**
 * One row of the experiment: both schemes at one target tread, volume-matched.
 *
 * The partition is computed HERE, from the surface as it stands — not passed
 * in — because the experiment's claim is about this ground, and a partition
 * from an earlier surface would bench patches that no longer exist. The cost
 * (one geomorphon pass, one gradient) is the price of the claim being true.
 *
 * @param {import("./dem.js").DEM} dem  read only — both schemes run on clones
 * @param {number} targetTread  metres
 * @param {{rainM?: number}} [opts]
 * @returns {{targetTread:number, volume:number, uniformInterval:number,
 *            matched:boolean, patchCount:number, patchesBenched:number,
 *            uniform:ReturnType<typeof measureSurface>,
 *            patch:ReturnType<typeof measureSurface>} | null}
 *   null when the ground is too level for the comparison to exist — a flat
 *   surface benches to itself and the matched volume is zero.
 */
export function compareAt(dem, targetTread, opts = {}) {
  const gm = geomorphons(dem);
  const grad = computeGradient(dem);
  // ⚠️ Codes 0–9 only: 255 is "no data", and Number.isFinite(255) is true, so
  // without the restriction the holes in a survey would be partitioned and
  // benched as if "unknown" were a landform.
  const only = LANDFORMS.map((_, code) => code);
  const { labels, patches } = landformPatches(dem, gm.codes, {
    slopeDeg: grad.slopeDeg, aspectDeg: grad.aspectDeg, only,
  });

  // The patch scheme first: its volume is the budget the uniform scheme is
  // then given. The other way round would let the uniform Δ decide the
  // experiment's size, which couples the budget to the scheme under test.
  const byPatch = dem.clone();
  const pr = benchByPatch(byPatch, labels, patches, {
    targetTread, tread: EXPERIMENT.treadShare, bias: EXPERIMENT.bias,
    minCells: EXPERIMENT.minCells,
    minInterval: EXPERIMENT.minInterval, maxInterval: EXPERIMENT.maxInterval,
  });
  const volume = pr.cut + pr.fill;
  if (!(volume > 1e-6)) return null;

  const m = matchUniformInterval(dem, volume);
  const uniform = dem.clone();
  benchTo(uniform, new Uint8Array(dem.nrows * dem.ncols).fill(1), {
    interval: m.interval, tread: EXPERIMENT.treadShare, bias: EXPERIMENT.bias,
  });

  return {
    targetTread,
    volume,
    uniformInterval: m.interval,
    matched: m.matched,
    patchCount: patches.length,
    patchesBenched: pr.patchesBenched,
    uniform: measureSurface(uniform, opts),
    patch: measureSurface(byPatch, opts),
  };
}

/**
 * The whole experiment: the untouched baseline and one row per target tread.
 *
 * ⚠️ SYNCHRONOUS AND SLOW — a second or two on a 256² tile — by design: the
 * kernel stays pure and testable in Node. The interface runs the rows one at
 * a time through `compareAt` with a paint between them, so the reader watches
 * the table grow instead of watching the tool hang; this whole-run form
 * exists for the self-test and the console.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {{treads?: number[], rainM?: number}} [opts]
 */
export function compareSchemes(dem, opts = {}) {
  const treads = opts.treads ?? EXPERIMENT.treads;
  const baseline = measureSurface(dem, opts);
  const rows = [];
  for (const t of treads) {
    const row = compareAt(dem, t, opts);
    if (row) rows.push(row);
  }
  return { baseline, rows, params: { ...EXPERIMENT, treads: [...treads] } };
}
