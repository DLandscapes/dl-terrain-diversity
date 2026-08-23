// Node runner for the same suite the browser page runs (selftest.js).
import { readFileSync } from "node:fs";
import { runSuite } from "./selftest.js";

const fetchTile = async (name) => {
  const buf = readFileSync(new URL(`../../data/orndalen/${name}`, import.meta.url));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

const rows = await runSuite(fetchTile);

let group = "";
let failed = 0;
for (const r of rows) {
  if (r.group !== group) { group = r.group; console.log(`\n${group}`); }
  if (!r.pass) failed++;
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  ${tag}  ${r.check}`);
  console.log(`        expected ${r.expected}   measured ${r.measured}`);
}
console.log(`\n${rows.length - failed} passed, ${failed} failed, ${rows.length} total\n`);
process.exit(failed > 0 ? 1 : 0);
