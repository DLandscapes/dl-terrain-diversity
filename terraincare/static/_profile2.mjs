// Honest per-stage timing: one stage per process invocation, with optional
// forced GC between iterations, so garbage from one stage cannot be charged
// to the next. Run as:  node --expose-gc _profile2.mjs <stage>
import { readFileSync } from "node:fs";
import { loadGeoTIFF } from "./geotiff.js";
import { DEM } from "./dem.js";
import { computeGradient, computeCurvature } from "./analysis/horn.js";
import { flowAccumulation, orderByElevationDesc } from "./analysis/mfd.js";
import { twi, tri, findDepressions, analyse } from "./analysis/indices.js";

const buf = readFileSync(new URL("../../data/orndalen/orndalen_fill_025m.tif", import.meta.url));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const dem = DEM.fromRaw(loadGeoTIFF(ab));

const g = computeGradient(dem);
const f = flowAccumulation(dem);

const STAGES = {
  gradient: () => computeGradient(dem),
  curvature: () => computeCurvature(dem),
  order: () => orderByElevationDesc(dem.z),
  flow: () => flowAccumulation(dem),
  tri: () => tri(dem),
  depressions: () => findDepressions(dem),
  twi: () => twi(f.specificCatchmentArea, g.slope),
  analyse: () => analyse(dem),
};

const stage = process.argv[2];
if (!STAGES[stage]) {
  console.log("stages:", Object.keys(STAGES).join(" "));
  process.exit(1);
}
const fn = STAGES[stage];

for (let i = 0; i < 5; i++) fn(); // warm up / let JIT settle
const ts = [];
for (let k = 0; k < 25; k++) {
  if (globalThis.gc) globalThis.gc();
  const t = performance.now();
  fn();
  ts.push(performance.now() - t);
}
ts.sort((a, b) => a - b);
const med = ts[Math.floor(ts.length / 2)];
console.log(`${stage.padEnd(14)} median ${med.toFixed(2)} ms   p10 ${ts[2].toFixed(2)}   p90 ${ts[22].toFixed(2)}   max ${ts[24].toFixed(2)}`);
