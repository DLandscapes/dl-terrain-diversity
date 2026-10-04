// @ts-check
/**
 * A band of values on a layer — the thing a reader means by "only the
 * south-facing slopes" or "only what is steeper than 1:4".
 *
 * ⚠️ ONE DEFINITION, USED BY BOTH THE COLOURING AND THE SELECTION. The legend
 * mutes what is outside a band and the Select panel can turn the same band into
 * a mask; if those two carried their own comparison, a map could show one set
 * of cells while the selection operated on another, and nothing would report
 * the disagreement. That is why this is four lines in its own file rather than
 * an inline `v >= lo && v <= hi` in each of them.
 *
 * ⚠️⚠️ ASPECT IS CIRCULAR, AND THAT IS WHY A PLAIN MIN/MAX WAS NEVER ENOUGH.
 * A bearing wraps: north spans 315°–45°, where `lo` is GREATER than `hi` and a
 * linear reading returns the empty set. Every other layer in this tool is
 * linear, so the wrap has to be asked for explicitly rather than assumed, or a
 * slope band of 25°–5° would silently select everything instead of nothing.
 */

/**
 * Is `v` inside the band?
 *
 * For a linear layer this is the obvious interval. For a circular one, a band
 * whose `lo` exceeds its `hi` is the arc THROUGH zero — 315°–45° is north, not
 * nothing.
 *
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @param {boolean} [circular]
 */
export function inBand(v, lo, hi, circular = false) {
  if (!Number.isFinite(v)) return false;   // NaN is "no answer", never a member
  if (circular && lo > hi) return v >= lo || v <= hi;
  return v >= lo && v <= hi;
}

/**
 * A centre bearing and a full width, as the [lo, hi] the rest of the tool uses.
 *
 * This is how a direction band is actually chosen — "south, give or take 45°" —
 * and it is the only form in which the wrap is natural to express. A width of
 * the whole period means everything, and is returned as the full range rather
 * than as a degenerate band that happens to touch itself.
 *
 * @param {number} centre bearing in degrees, any value; wrapped into [0, period)
 * @param {number} width total width in degrees, not the half-width
 * @param {number} [period]
 * @returns {[number, number]}
 */
export function bandFromCentre(centre, width, period = 360) {
  if (width >= period) return [0, period];
  const c = ((centre % period) + period) % period;
  const half = width / 2;
  const lo = ((c - half) % period + period) % period;
  const hi = ((c + half) % period + period) % period;
  return [lo, hi];
}

/**
 * The share of finite cells in `grid` that fall inside the band, as a fraction.
 *
 * ⚠️ THE DENOMINATOR IS THE CELLS THAT HAVE AN ANSWER, not every cell in the
 * raster. A patch half of which is nodata would otherwise report half the
 * south-facing share it actually has, and the number is meant to be read as
 * "of the ground this layer describes".
 *
 * @param {ArrayLike<number>} grid
 * @param {number} lo @param {number} hi @param {boolean} [circular]
 * @param {Uint8Array|null} [within] optional mask to count inside
 */
export function bandShare(grid, lo, hi, circular = false, within = null) {
  let inside = 0, answered = 0;
  for (let i = 0; i < grid.length; i++) {
    if (within && !within[i]) continue;
    const v = grid[i];
    if (!Number.isFinite(v)) continue;
    answered++;
    if (inBand(v, lo, hi, circular)) inside++;
  }
  return { inside, answered, share: answered ? inside / answered : 0 };
}

/** The eight compass points, for naming a bearing band in words. */
export const COMPASS = [
  { label: "N", bearing: 0 }, { label: "NE", bearing: 45 },
  { label: "E", bearing: 90 }, { label: "SE", bearing: 135 },
  { label: "S", bearing: 180 }, { label: "SW", bearing: 225 },
  { label: "W", bearing: 270 }, { label: "NW", bearing: 315 },
];

/**
 * The nearest compass point to a bearing, for a label.
 * @param {number} bearing
 */
export function compassName(bearing) {
  const b = ((bearing % 360) + 360) % 360;
  let best = COMPASS[0], bestD = 360;
  for (const c of COMPASS) {
    const d = Math.min(Math.abs(b - c.bearing), 360 - Math.abs(b - c.bearing));
    if (d < bestD) { bestD = d; best = c; }
  }
  return best.label;
}
