// Emit each growth form's elevation outline, normalised into a unit box, so the
// photo-annotation script can draw the SAME geometry the scene and plate use.
import { writeFileSync } from "node:fs";
import { PLANT_LIBRARY } from "../static/plantlib.js";
import { cadGeometry, FORMS, MOISTURE_ALPHA, compositeOverStage, PLANT_INK } from "../static/plants.js";
const out = {};
for (const p of PLANT_LIBRARY) {
  const g = cadGeometry(p.form);
  const pos = g.attributes.position.array, ix = g.index ? g.index.array : null;
  const n = ix ? ix.length : pos.length / 3;
  const v = (k) => { const j = (ix ? ix[k] : k) * 3; return [pos[j], pos[j + 1], pos[j + 2]]; };
  const tris = [];
  for (let t = 0; t + 2 < n; t += 3) {
    const a = v(t), b = v(t + 1), c = v(t + 2);
    tris.push({ pts: [a, b, c].map(([x, , z]) => [x, -z]), d: (a[1] + b[1] + c[1]) / 3 });
  }
  tris.sort((a, b) => b.d - a.d);                    // painter's: far first
  const [r, h] = FORMS[p.form];
  const ext = Math.max(2 * r, h);
  out[p.id] = {
    name: p.name, form: p.form, invasive: !!p.invasive,
    fill: compositeOverStage(MOISTURE_ALPHA[p.moisture]), ink: PLANT_INK[0],
    heightM: h, spreadM: 2 * r,
    // x in [-0.5,0.5], y in [-1,0] with 0 at the ground line, scaled by extent.
    tris: tris.map((t) => t.pts.map(([x, y]) => [x / ext, y / ext])),
  };
}
writeFileSync(new URL("../../output/plant library orndalen/_shapes.json", import.meta.url),
  JSON.stringify(out), "utf8");
console.log("shapes written:", Object.keys(out).length);
