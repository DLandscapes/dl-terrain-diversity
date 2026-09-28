// @ts-check
// DXF — polylines on named layers, for CAD.
//
// ⚠️ R12 (AC1009), AND THAT IS A DECISION RATHER THAN LAZINESS. R12 is the last
// DXF revision that every reader in this field agrees on: QGIS, AutoCAD, Rhino,
// BricsCAD, Illustrator, and the laser-cutter software that will not open
// anything newer. The cost is that a polyline is a POLYLINE with a VERTEX per
// point and a SEQEND, rather than the far more compact LWPOLYLINE that arrived
// with R13 — roughly six times the bytes for the same geometry. For a channel
// network that is a few hundred kilobytes, and a file that opens everywhere
// beats a file that is small.
//
// ⚠️ WORLD COORDINATES, UNPROJECTED AND UNSHIFTED. The geometry carries full
// EPSG:25833 eastings and northings, so a drawing opened in CAD sits hundreds
// of kilometres from the origin. That is correct and it is what a surveyor
// expects — the alternative, helpfully subtracting an origin, produces a file
// that lines up with nothing and whose offset is recorded nowhere. The README
// beside the file states the CRS; a DXF has nowhere to put one.
//
// ⚠️ AND DXF CARRIES NO ATTRIBUTES. There is no table in this format — a
// polyline has a layer and nothing else. The classes are therefore expressed AS
// LAYERS, which is how CAD has always done it, and the shapefile beside it
// carries the numbers. Anyone wanting the contributing area of a reach wants
// the .shp; anyone wanting to trace over it in CAD wants this.

/** ACI colour indices — CAD's own 1-255 palette, not RGB. */
export const ACI = { red: 1, yellow: 2, green: 3, cyan: 4, blue: 5, magenta: 6, white: 7, grey: 8 };

/**
 * @typedef {object} DxfLayer
 * @property {string} name    layer name; CAD dislikes spaces, so use - or _
 * @property {number} [colour] ACI index, default 7
 * @property {{pts:number[][], closed?:boolean, z?:number}[]} polylines
 */

/**
 * @param {DxfLayer[]} layers
 * @returns {string} the complete DXF text
 */
export function writeDXF(layers) {
  const L = [];
  /** group code + value, the only way anything is written in this format */
  const g = (code, value) => { L.push(String(code)); L.push(String(value)); };
  // ⚠️ SIX DECIMALS, FIXED. A UTM northing is eight digits before the point, and
  // JavaScript's default toString gives exponent notation for some values —
  // "7.7381e+6" in a DXF is not a number to most readers, it is a parse error.
  const num = (v) => (Number.isFinite(v) ? v : 0).toFixed(6);

  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$ACADVER"); g(1, "AC1009");
  // The extents, so a reader can zoom to the drawing instead of to infinity.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const la of layers) for (const p of la.polylines) for (const [x, y] of p.pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0)) { x0 = y0 = x1 = y1 = 0; }
  g(9, "$EXTMIN"); g(10, num(x0)); g(20, num(y0)); g(30, num(0));
  g(9, "$EXTMAX"); g(10, num(x1)); g(20, num(y1)); g(30, num(0));
  g(0, "ENDSEC");

  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LAYER"); g(70, layers.length);
  for (const la of layers) {
    g(0, "LAYER"); g(2, la.name); g(70, 0); g(62, la.colour ?? ACI.white);
    g(6, "CONTINUOUS");
  }
  g(0, "ENDTAB"); g(0, "ENDSEC");

  g(0, "SECTION"); g(2, "ENTITIES");
  for (const la of layers) {
    for (const p of la.polylines) {
      if (!p.pts || p.pts.length < 2) continue;
      const z = p.z ?? 0;
      g(0, "POLYLINE"); g(8, la.name);
      // 66 = "vertices follow", which R12 requires and R13+ ignores.
      g(66, 1); g(70, p.closed ? 1 : 0);
      g(10, num(0)); g(20, num(0)); g(30, num(z));
      for (const pt of p.pts) {
        g(0, "VERTEX"); g(8, la.name);
        g(10, num(pt[0])); g(20, num(pt[1])); g(30, num(pt[2] ?? z));
      }
      g(0, "SEQEND"); g(8, la.name);
    }
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return L.join("\r\n") + "\r\n";
}
