// @ts-check
// EVERY FIGURE ALSO AS PNG — Marc, 2026-08-19: "besides the .svg also always
// create a .png file".
//
// ⚠️ THE SVG REMAINS THE SOURCE, AND THE PNG IS A COMPANION. The poster
// references the SVG, the SVG is what stays vector into the PDF, and it is what
// can be inspected mark by mark. The PNG exists for the places a vector cannot
// go — a slide, a Word document, a message, a preview that will not render SVG.
// Regenerating a PNG from the SVG is cheap; the reverse is impossible, so the
// PNG must never become the thing that is edited.
//
// ⚠️ THE SHEET COLOUR IS PAINTED IN. An SVG with no background rasterises to
// transparency, and a transparent PNG looks correct on a white slide while the
// same file on a dark one shows the ink floating on nothing. These carry the
// poster's own paper colour so the figure travels as the sheet shows it.
//
// ⚠️ SIZED FROM THE viewBox, NOT FROM THE width ATTRIBUTE. Several of these
// declare a width in MILLIMETRES because they are print figures; reading that as
// pixels would rasterise a 70 mm drawing into a 70 px thumbnail.
//
// Rasterised by resvg — a native library with prebuilt binaries, so this runs
// without a browser, without Inkscape and without a cairo install. It is not
// the engine that will print the poster (Chrome is), which is exactly why the
// PNG is a companion and the PDF is produced from the HTML.
//
// Usage:  node tools/poster-png.mjs [dir] [--min 1400]

import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SHEET = "#fdfcf9";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"))
  || join(process.cwd(), "..", "output", "poster", "figures");
const minIdx = args.indexOf("--min");
const MIN_PX = minIdx >= 0 ? Number(args[minIdx + 1]) : 1400;

const files = readdirSync(dir).filter((f) => f.endsWith(".svg"));
if (!files.length) { console.log("no SVGs in", dir); process.exit(0); }

let total = 0;
for (const f of files) {
  const svg = readFileSync(join(dir, f), "utf8");
  const vb = (svg.match(/viewBox="([^"]+)"/) || [, "0 0 1000 1000"])[1]
    .split(/[\s,]+/).map(Number);
  const [, , vw, vh] = vb;
  // The long side lands on MIN_PX, so a wide figure and a square one arrive at
  // comparable resolution rather than comparable pixel counts.
  const scale = MIN_PX / Math.max(vw, vh);

  const r = new Resvg(svg, {
    background: SHEET,
    fitTo: { mode: "width", value: Math.round(vw * scale) },
  });
  const png = r.render().asPng();
  const out = f.replace(/\.svg$/, ".png");
  writeFileSync(join(dir, out), png);
  total += png.length;
  console.log(`  ${out.padEnd(38)} ${Math.round(vw * scale)}x${Math.round(vh * scale)}`
    + ` · ${(png.length / 1024).toFixed(0)} kB`);
}
console.log(`\n${files.length} figures · ${(total / 1024 / 1024).toFixed(1)} MB total`);
console.log(`source of truth stays the .svg beside each one`);
