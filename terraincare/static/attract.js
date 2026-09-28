// @ts-check
/**
 * Attractors and repellers — vector geometry that pulls the ground to itself.
 *
 * Marc, 2026-09-27: "if you draw a curve it can be activated as an attractor and
 * then you have a slider where you can adjust if the mesh vertices should be
 * pulled more or less to that curve vertically up or down … 1 could be fully
 * pulled to the curve, 0 is nothing and -1 is pushed the same distance into the
 * other direction … this could work also with points … or perhaps closed
 * polylines — like the same as in GIS vector features points, lines and
 * polygons."
 *
 * ⚠️⚠️ THIS IS NOT A NEW MECHANISM. It is the equation `applyBrush` already uses
 * for its level tool, generalised:
 *
 *     brush:     dz = (target − z) · w · strength        w from the brush centre
 *     attractor: dz = (targetZ  − z) · w · t             w from a GEOMETRY
 *
 * Three differences, and only three: the target is the nearest point ON A
 * GEOMETRY rather than one scalar, `w` falls off with distance to that geometry
 * rather than to a brush centre, and `t` runs −1…+1 instead of 0…1. At t = 1 and
 * w = 1 a cell lands exactly on the geometry; at t = −1 it moves the same
 * distance the other way. That is Marc's slider, stated as arithmetic.
 *
 * ⚠️ AND IT BORROWS RATHER THAN REBUILDS. The hard parts are already written and
 * already tested: `projectToPolyline` gives perpendicular distance AND station
 * for a curve, `centreline` gives the curve its own elevation three ways,
 * `rasterise` + `distanceToMask` give an exact Euclidean field around a polygon,
 * and `groundAt` samples the ground without inventing any. Nothing here
 * reimplements those.
 *
 * Follows `levelTo`'s contract exactly: a hole in the DEM stays a hole, `dryRun`
 * prices without moving, and the ledger ACCUMULATES rather than being assigned.
 */

import { stations, projectToPolyline, centreline, groundAt } from "./guide.js";
import { rasterise, distanceToMask, maskZRange } from "./polygon.js";

/**
 * How influence falls away with distance, 1 on the geometry and 0 at the radius.
 *
 * ⚠️ COSINE IS THE DEFAULT BECAUSE THE BRUSH USES IT. Two different soft edges
 * in one tool would make the same gesture read differently depending on which
 * control produced it. `linear` is here because a constant-slope falloff is what
 * a batter is, and `smooth` because smoothstep leaves no crease at the rim.
 */
export const FALLOFF = {
  cosine: { label: "Cosine — soft, like the brush", w: (d, R) => 0.5 * (1 + Math.cos(Math.PI * d / R)) },
  linear: { label: "Linear — constant slope to the rim", w: (d, R) => 1 - d / R },
  smooth: { label: "Smoothstep — flat at both ends", w: (d, R) => { const u = 1 - d / R; return u * u * (3 - 2 * u); } },
};

const EMPTY = (dem) => ({
  cut: 0, fill: 0, net: 0, cells: 0,
  r0: dem.nrows, c0: dem.ncols, r1: -1, c1: -1,
});

/**
 * Pull the ground toward a point, a curve or a polygon — or push it away.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {{kind: "point"|"line"|"polygon", pts: number[][]}} geom
 *   `pts` is [[x, y], …] in map units. A point geometry may carry several
 *   points; the NEAREST one governs both the distance and the target, which is
 *   the same rule `projectToPolyline` uses for a curve that doubles back.
 * @param {{strength?: number, radius?: number, falloff?: string,
 *          along?: string, gradient?: number, datum?: number, offset?: number,
 *          dryRun?: boolean, ledger?: import("./brush.js").Ledger}} [opts]
 *   `strength` is Marc's slider, −1…+1. `datum` fixes the geometry's elevation;
 *   without one it is read from the ground beneath the geometry, and `offset`
 *   shifts it.
 * @returns {{cut:number, fill:number, net:number, cells:number,
 *            r0:number, c0:number, r1:number, c1:number}}
 */
export function attract(dem, geom, opts = {}) {
  const t = Math.max(-1, Math.min(1, opts.strength ?? 0));
  const R = opts.radius ?? 0;
  if (!geom || !geom.pts || !geom.pts.length || !(R > 0) || t === 0) return EMPTY(dem);

  const F = FALLOFF[opts.falloff ?? "cosine"] ?? FALLOFF.cosine;
  const offset = opts.offset ?? 0;
  const { nrows, ncols, cell, originX, originY, z } = dem;
  const northY = originY + nrows * cell;
  const area = cell * cell;

  /** Cell → {d, zt} or null when the cell is out of reach of this geometry. */
  let reach;
  /** The window worth visiting: the geometry's own extent, grown by the radius. */
  let bbox;

  if (geom.kind === "line" && geom.pts.length >= 2) {
    const { s: cum } = stations(geom.pts);
    const line = centreline(dem, geom.pts, {
      along: opts.along ?? "level", gradient: opts.gradient, datum: opts.datum,
    });
    reach = (x, y) => {
      const pr = projectToPolyline(geom.pts, cum, x, y);
      // ⚠️ SQUARE ENDS, NOT ROUND CAPS — the same rule, and the same reason, as
      // the guide corridor: a cell beyond the last vertex is not beside the line.
      if (pr.end !== 0 || pr.d >= R) return null;
      return { d: pr.d, zt: line.z(pr.s) + offset };
    };
    bbox = bounds(geom.pts);
  } else if (geom.kind === "polygon" && (geom.mask || (geom.pts && geom.pts.length >= 3))) {
    // ⚠️ A READY-MADE MASK WINS OVER THE RING. The plan already rasterises a
    // region — holes and all — so re-rasterising its outer ring here would
    // quietly fill every hole the designer cut in it. The caller passes what it
    // has; only a bare ring is rasterised.
    const { mask, rect } = geom.mask
      ? { mask: geom.mask, rect: geom.rect || null }
      : rasteriseRing(dem, geom.pts);
    if (!mask) return EMPTY(dem);
    // ⚠️ ONE ELEVATION FOR THE WHOLE POLYGON, and that is a real limit rather
    // than an oversight. A distance transform says HOW FAR the nearest mask cell
    // is, not WHICH one it is, so a target that varies around the ring would
    // need a feature transform as well — the same gap `applyGuide` records for
    // `batterTo`. A polygon attractor is therefore a platform with a soft edge.
    const zt = (Number.isFinite(opts.datum) ? opts.datum : maskZRange(dem, mask).mean) + offset;
    const dist = distanceToMask(mask, nrows, ncols);
    reach = (x, y, i) => {
      const d = dist[i] * cell;
      return d < R ? { d, zt } : null;
    };
    // The window comes from the mask's own rectangle when there is one, because
    // a mask with holes has no ring to take bounds from.
    bbox = rect && rect.r1 >= rect.r0
      ? {
        minX: originX + rect.c0 * cell, maxX: originX + (rect.c1 + 1) * cell,
        minY: northY - (rect.r1 + 1) * cell, maxY: northY - rect.r0 * cell,
      }
      : bounds(geom.pts);
  } else if (geom.kind === "point") {
    /**
     * ⚠️⚠️ A POINT CARRIES ITS OWN ELEVATION, AND THAT IS NOT A CONVENIENCE.
     * Read from the ground on every call instead, the target CLIMBS with the
     * ground it just lifted: applying one point attractor twice priced 113.7
     * then 149.3 m³ of fill, rising when it should have been falling toward
     * zero. A third pass would have gone higher again. "You draw points in
     * space" — so a placed point keeps the height it was placed at, and the
     * offset slider moves the target rather than the datum chasing the result.
     *
     * A bare [x, y] still falls back to the ground, which is what the kernel
     * tests use and what an imported point without a Z would give.
     */
    const zs = geom.pts.map(([x, y, z]) =>
      (Number.isFinite(z) ? z
        : Number.isFinite(opts.datum) ? opts.datum : groundAt(dem, x, y)) + offset);
    reach = (x, y) => {
      let d = Infinity, zt = NaN;
      for (let k = 0; k < geom.pts.length; k++) {
        const dk = Math.hypot(x - geom.pts[k][0], y - geom.pts[k][1]);
        if (dk < d) { d = dk; zt = zs[k]; }
      }
      return d < R ? { d, zt } : null;
    };
    bbox = bounds(geom.pts);
  } else {
    return EMPTY(dem);
  }

  const cMin = Math.max(0, Math.floor((bbox.minX - R - originX) / cell));
  const cMax = Math.min(ncols - 1, Math.ceil((bbox.maxX + R - originX) / cell));
  const rMin = Math.max(0, Math.floor((northY - (bbox.maxY + R)) / cell));
  const rMax = Math.min(nrows - 1, Math.ceil((northY - (bbox.minY - R)) / cell));

  let cut = 0, fill = 0, moved = 0;
  let r0 = nrows, c0 = ncols, r1 = -1, c1 = -1;
  for (let r = rMin; r <= rMax; r++) {
    const y = northY - (r + 0.5) * cell;
    for (let c = cMin; c <= cMax; c++) {
      const i = r * ncols + c;
      const zv = z[i];
      if (!Number.isFinite(zv)) continue;        // a hole in the DEM stays a hole
      const x = originX + (c + 0.5) * cell;
      const hit = reach(x, y, i);
      if (!hit || !Number.isFinite(hit.zt)) continue;
      const dz = (hit.zt - zv) * F.w(hit.d, R) * t;
      if (!dz) continue;
      if (dz > 0) fill += dz * area; else cut += -dz * area;
      if (!opts.dryRun) z[i] = zv + dz;
      moved++;
      if (r < r0) r0 = r; if (r > r1) r1 = r;
      if (c < c0) c0 = c; if (c > c1) c1 = c;
    }
  }
  if (opts.ledger && !opts.dryRun) { opts.ledger.cut += cut; opts.ledger.fill += fill; }
  return { cut, fill, net: fill - cut, cells: moved, r0, c0, r1, c1 };
}

/** @param {number[][]} pts */
function bounds(pts) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/** `rasterise` takes rings; a polygon attractor carries one. */
function rasteriseRing(dem, ring) {
  try {
    const out = rasterise(dem, [ring]);
    return { mask: out.mask, rect: out };
  } catch {
    return { mask: null, rect: null };
  }
}
