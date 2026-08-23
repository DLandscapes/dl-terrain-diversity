// @ts-check
// CONTOUR BENCHING — terraces that follow the landform, because their
// coordinate is the terrain's own elevation.
//
// The second of the four families in DESIGN-controlled-transformation.md, and
// the one that answers "if the terrain is like that, then do that".
//
// ⚠️ WHY THIS IS NOT A STAMP PATTERN. The twelve procedural patterns are
// functions of world XY: `proceduralField(id, nrows, ncols, cell, {wavelength})`
// cannot see the ground, so a lozenge matrix lands identically on a flat plane
// and on a 20 m slope. A bench is a function of ELEVATION. Snap each cell to
// the nearest bench level and the treads follow every contour automatically,
// close up where the ground steepens, open out where it flattens, and stay
// level along their length — none of which has to be drawn, because all of it
// is implied by the surface. That is the whole difference between a texture
// and a terrain-adaptive design.
//
// ⚠️ AND NOT A DISPLACEMENT EITHER, which is why it does not go through
// applyPattern. A pattern field is 0..1 scaled by an amplitude slider; a bench
// is an ABSOLUTE TARGET ELEVATION per cell. It therefore follows levelTo's
// contract instead — same signature shape, same ledger accumulation, same
// "a hole in the DEM stays a hole" rule.
//
// ⚠️ THE TREAD WIDTH IS AN OUTPUT, NOT AN INPUT, and that is the physically
// honest way round. For a vertical interval Δ on ground of slope β the tread
// comes out at Δ / tanβ — narrow benches on steep ground, wide on gentle —
// which is how contour terracing is actually set out. Asking for a fixed tread
// width instead would force a varying Δ and produce benches that do not line
// up along the slope. The tool reports the tread it achieved.

/**
 * How the bench levels sit against the existing ground.
 *
 * ⚠️ THE ROUNDING IS THE VOLUME POLICY, and it is exact rather than
 * approximate: snapping to the NEAREST level cuts the upper half of each
 * interval and fills the lower half, so `balanced` is very nearly volume-
 * neutral by construction — the residual is only the asymmetry of the ground
 * within each interval. `cut` (floor) never imports material and always
 * removes; `fill` (ceil) never removes and always imports. A designer choosing
 * between them is choosing what the earthwork is FOR, and the ledger shows the
 * consequence immediately.
 */
// ⚠️ `reach` IS NOT DECORATION — it is how far, in interval units, the ground
// lies from its own bench level, and it differs by bias. Rounding to the
// NEAREST level puts the ground within ±0.5 of it, so the tread is centred and
// each side runs 0.5. Flooring puts the ground 0..1 ABOVE its level, so the
// tread is one-sided and runs the full 1. Using 0.5 for all three — which the
// first version did — made the riser formula overshoot past the neighbouring
// level on the one-sided biases, so `cut only` imported 2 987 m³ of fill and
// `fill only` excavated 3 106 m³. Both were exactly the operation they were
// named for, inverted.
export const BENCH_BIAS = {
  balanced: { label: "balanced — cut above, fill below", round: Math.round, reach: 0.5 },
  cut: { label: "cut only — never import material", round: Math.floor, reach: 1 },
  fill: { label: "fill only — never remove material", round: Math.ceil, reach: 1 },
};

/**
 * The target elevation for one cell under a bench system.
 *
 * `tread` is the fraction of each vertical interval given to the level tread;
 * the remainder becomes the riser. At tread = 1 the profile is a pure step —
 * flat treads and vertical risers, which is a drawing rather than a buildable
 * earthwork. At tread = 0 nothing changes. In between, the riser carries the
 * whole interval over the remaining fraction, so its slope is the ground's
 * divided by (1 − tread): the steeper the ground, the steeper the riser, which
 * is why the riser angle must be checked against the material and not assumed.
 *
 * @param {number} z existing elevation
 * @param {number} interval vertical interval, metres
 * @param {number} tread 0..1 share of the interval that is level
 * ⚠️ `datum` ANCHORS THE BENCH SYSTEM, and by default it is zero — which is what
 * makes the levels absolute elevations, so two runs over the same ground put
 * their treads at the same heights and a bench system is reproducible. It exists
 * for ONE case: giving each landform patch its own system, where the point is
 * precisely that neighbouring patches do NOT line up, because a terrace changes
 * where the landform changes. Anywhere else, leaving it at zero is correct.
 *
 * @param {(v:number)=>number} round the bias's rounding, from BENCH_BIAS
 * @param {number} [reach] the bias's reach, from BENCH_BIAS — see the note there
 * @param {number} [datum] the elevation the levels are counted from
 */
export function benchTarget(z, interval, tread, round, reach = 0.5, datum = 0) {
  if (!(interval > 0)) return z;
  const t = Math.min(1, Math.max(0, tread));
  if (t <= 0) return z;
  const u = (z - datum) / interval;
  const k = round(u);
  if (t >= 1) return k * interval + datum;
  // How far this cell sits from its own bench level, in interval units:
  // ±0.5 when rounding to nearest, 0..1 when flooring or ceiling.
  const frac = u - k;
  const a = Math.abs(frac);
  const half = t * reach;                 // the tread's half-width (or width)
  if (a <= half) return k * interval + datum;   // on the tread
  // On the riser: carry the REST of the way to the neighbouring level over the
  // remaining fraction, so at the far end the target meets the ground exactly
  // and the bench system never inverts or overshoots.
  const span = reach - half;
  return (k + Math.sign(frac) * ((a - half) / span) * reach) * interval + datum;
}

/**
 * Cut a bench system into the ground inside a mask.
 *
 * Follows levelTo's contract exactly — same options, same return shape — so
 * everything already built around a levelling (the ledger, undo's dirty rect,
 * the preview's dryRun pricing) works with no change.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {Uint8Array} mask
 * @param {{interval?: number, tread?: number, bias?: string, datum?: number,
 *          dryRun?: boolean, ledger?: import("./brush.js").Ledger}} [opts]
 * @returns {{cut:number, fill:number, net:number, cells:number,
 *            levels:number, treadMean:number}}
 */
export function benchTo(dem, mask, opts = {}) {
  const interval = opts.interval ?? 1.0;
  const tread = opts.tread ?? 0.7;
  const bias = BENCH_BIAS[opts.bias || "balanced"] || BENCH_BIAS.balanced;
  const a = dem.cell * dem.cell;
  let cut = 0, fill = 0, moved = 0;
  const levels = new Set();

  // ⚠️ MEASURED BEFORE THE GROUND MOVES. The tread a system yields is a
  // property of the ground being benched, not of the benched result — and the
  // benched result is exactly the wrong thing to measure, because it is flat
  // treads (excluded as slopeless) and steep risers (tiny treads). Computing
  // it afterwards reported 7.25 m where the 20% test slope must give 5.00 m.
  const treadMean = meanTread(dem, mask, interval);

  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const z = dem.z[i];
    if (!Number.isFinite(z)) continue;      // a hole in the DEM stays a hole
    const datum = opts.datum ?? 0;
    const target = benchTarget(z, interval, tread, bias.round, bias.reach, datum);
    levels.add(Math.round((z - datum) / interval));
    const dz = target - z;
    if (dz === 0) continue;
    if (dz > 0) fill += dz * a; else cut += -dz * a;
    if (!opts.dryRun) dem.z[i] = target;
    moved++;
  }
  // ⚠️ Accumulate, never assign — a bench system is one more earthwork on the
  // same site, not a replacement for everything moved before it.
  if (opts.ledger && !opts.dryRun) { opts.ledger.cut += cut; opts.ledger.fill += fill; }

  // The tread the ground actually produced, reported rather than promised:
  // Δ / tanβ over the mean slope of the selected cells.
  return { cut, fill, net: fill - cut, cells: moved, levels: levels.size, treadMean };
}

/**
 * Mean tread width the interval yields on this ground: Δ / tanβ, averaged over
 * the masked cells, with level cells excluded because a tread has no meaning
 * where there is no fall — Δ/tan(0) is infinite, and averaging that in would
 * report a nonsense number for a nearly flat site.
 * @param {import("./dem.js").DEM} dem
 * @param {Uint8Array} mask
 * @param {number} interval
 */
export function meanTread(dem, mask, interval) {
  const { nrows, ncols, cell, z } = dem;
  let sum = 0, n = 0;
  for (let r = 1; r < nrows - 1; r++) {
    for (let c = 1; c < ncols - 1; c++) {
      const i = r * ncols + c;
      if (!mask[i]) continue;
      // Central differences — the same gradient the rest of the tool uses,
      // at a scale where Horn's 3x3 smoothing would flatten the very breaks
      // the benches are being cut into.
      const zx = (z[i + 1] - z[i - 1]) / (2 * cell);
      const zy = (z[i - ncols] - z[i + ncols]) / (2 * cell);
      if (!Number.isFinite(zx) || !Number.isFinite(zy)) continue;
      const tanb = Math.hypot(zx, zy);
      if (tanb < 0.02) continue;            // under ~1.1°: no meaningful tread
      sum += interval / tanb; n++;
    }
  }
  return n ? sum / n : NaN;
}
