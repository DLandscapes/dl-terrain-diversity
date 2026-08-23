// @ts-check
// Wavefront OBJ + MTL export, for taking the edited terrain into Rhino, Blender
// or any CAD package.
//
// THREE DECISIONS THAT MATTER, and each has bitten somebody:
//
// 1. LOCAL COORDINATES, with the world origin in a header comment. Writing UTM
//    eastings and northings straight into the file hands the receiving
//    application the identical problem that quantised this tool's own terrain
//    for three phases (README §"Float32 vs UTM coordinates"): Rhino warns about
//    geometry far from the origin for exactly this reason, and Blender's
//    viewport is single-precision throughout. The header records
//    `# origin_epsg25833 <X> <Y>` so the model can be placed again exactly.
//
// 2. Z-UP, matching this app, Rhino and QGIS. OBJ has no up-axis convention —
//    the format simply does not say — so Blender's importer assumes Y-up unless
//    told otherwise. The header states the axis, and Blender's import dialog
//    has the setting.
//
// 3. TRUE ELEVATIONS by default, not the display exaggeration. Vertical
//    exaggeration is a claim about legibility, not about the ground; an
//    exported model carrying a silent 2.5x would be measured by someone
//    downstream. Exaggeration is available as an explicit option because
//    physical model-making genuinely wants it, and when used it is written into
//    the header comment too.
//
// The analysis layer travels as a TEXTURE rather than as per-face materials.
// One material per distinct colour would mean hundreds of `usemtl` groups and
// would quantise the ramp; a UV-mapped image reproduces the exact per-cell
// colour the app showed, and both Rhino and Blender read `map_Kd`.

/**
 * @param {import("../dem.js").DEM} dem
 * @param {{
 *   exaggeration?: number,
 *   textureFile?: string|null,
 *   materialName?: string,
 *   layerLabel?: string,
 * }} [opts]
 * @returns {{obj: string, mtl: string|null, triangles: number, vertices: number}}
 */
export function writeOBJ(dem, opts = {}) {
  const { z, nrows, ncols, cell, originX, originY } = dem;
  const ex = opts.exaggeration ?? 1;
  const texture = opts.textureFile ?? null;
  const material = opts.materialName ?? "terrain";

  const out = [];
  out.push("# DL-TerrainDiversity terrain export");
  out.push(`# source ${dem.name || "(unnamed)"}`);
  out.push(`# grid ${ncols} x ${nrows} cells, ${cell} m`);
  out.push("# COORDINATES ARE LOCAL: add the origin below to place this in EPSG:25833.");
  out.push("# Written local because single-precision CAD viewports quantise UTM-scale values.");
  out.push(`# origin_epsg25833 ${originX} ${originY}`);
  out.push("# up_axis Z");
  out.push(ex === 1
    ? "# vertical_exaggeration 1 (true elevations, NN2000)"
    : `# vertical_exaggeration ${ex} — Z IS NOT TRUE ELEVATION, divide by ${ex}`);
  out.push("# Terrain data (c) Kartverket, hoydedata.no, NLOD / CC BY 4.0");
  if (texture) out.push(`mtllib ${material}.mtl`);

  // Vertices. NaN cells still need a vertex so the index arithmetic below stays
  // trivial; the faces that would touch them are dropped instead.
  const northY = nrows * cell;
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const v = z[r * ncols + c];
      const zz = Number.isFinite(v) ? v * ex : 0;
      out.push(`v ${((c + 0.5) * cell).toFixed(4)} ${(northY - (r + 0.5) * cell).toFixed(4)} ${zz.toFixed(4)}`);
    }
  }

  // Texture coordinates, one per vertex, sampling its own cell centre. OBJ's V
  // axis runs upward from the bottom of the image while row 0 is the NORTH
  // edge at the top, hence the flip — get this backwards and the analysis
  // arrives mirrored, which is subtle enough to ship unnoticed.
  if (texture) {
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        out.push(`vt ${((c + 0.5) / ncols).toFixed(6)} ${(1 - (r + 0.5) / nrows).toFixed(6)}`);
      }
    }
    out.push(`usemtl ${material}`);
  }

  // Faces, splitting each quad on its anti-diagonal — the same split surface.js
  // uses, so the exported mesh is the mesh that was on screen.
  let triangles = 0;
  const finite = (i) => Number.isFinite(z[i]);
  for (let r = 0; r < nrows - 1; r++) {
    for (let c = 0; c < ncols - 1; c++) {
      const a = r * ncols + c, b = a + 1, d = a + ncols, e = d + 1;
      const fa = a + 1, fb = b + 1, fd = d + 1, fe = e + 1; // OBJ is 1-based
      if (finite(a) && finite(d) && finite(b)) {
        out.push(texture ? `f ${fa}/${fa} ${fd}/${fd} ${fb}/${fb}` : `f ${fa} ${fd} ${fb}`);
        triangles++;
      }
      if (finite(b) && finite(d) && finite(e)) {
        out.push(texture ? `f ${fb}/${fb} ${fd}/${fd} ${fe}/${fe}` : `f ${fb} ${fd} ${fe}`);
        triangles++;
      }
    }
  }

  return { obj: out.join("\n") + "\n", mtl: buildMTL(texture, opts), triangles, vertices: nrows * ncols };
}

/**
 * The VOXEL representation as solid boxes.
 *
 * Read straight from the field's instance matrices rather than re-deriving the
 * aggregation here, so the exported model is bit-for-bit the one on screen —
 * same block size, same stretch-to-the-lowest-neighbour rule, same perimeter
 * with no skirt. Re-implementing that arithmetic in a second place is exactly
 * how an export and a viewport drift apart.
 *
 * Boxes are written CLOSED — all six faces, including the ones buried between
 * touching neighbours. Culling them would produce a smaller file and an open
 * shell; a closed solid is what Rhino wants for a boolean, and what a physical
 * model needs (this office laser-cuts terrain, see DL-TerrainSlicer). The
 * overlap between neighbouring boxes is harmless: a union resolves it.
 *
 * The matrices are pure scale-then-translate, so the columns can be read
 * directly — m[0], m[5], m[10] are the scales and m[12..14] the centre. That
 * keeps this module free of three.js, as it has always been.
 *
 * @param {{array: Float32Array|number[], count: number}} instances
 * @param {import("../dem.js").DEM} dem
 * @param {{exaggeration?: number, textureFile?: string|null, materialName?: string,
 *          layerLabel?: string, blockWidth?: number}} [opts]
 */
export function writeVoxelOBJ(instances, dem, opts = {}) {
  const { nrows, ncols, cell, originX, originY } = dem;
  const ex = opts.exaggeration ?? 1;
  const texture = opts.textureFile ?? null;
  const material = opts.materialName ?? "terrain";
  const m = instances.array;
  const n = instances.count;

  const out = [];
  out.push("# DL-TerrainDiversity terrain export — VOXEL representation");
  out.push(`# source ${dem.name || "(unnamed)"}`);
  out.push(`# ${n} closed boxes, aggregated from ${ncols} x ${nrows} cells at ${cell} m`);
  if (opts.blockWidth) out.push(`# block footprint ${opts.blockWidth.toFixed(3)} m`);
  out.push("# COORDINATES ARE LOCAL: add the origin below to place this in EPSG:25833.");
  out.push("# Written local because single-precision CAD viewports quantise UTM-scale values.");
  out.push(`# origin_epsg25833 ${originX} ${originY}`);
  out.push("# up_axis Z");
  out.push(ex === 1
    ? "# vertical_exaggeration 1 (true elevations, NN2000)"
    : `# vertical_exaggeration ${ex} — Z IS NOT TRUE ELEVATION, divide by ${ex}`);
  out.push("# Each box is a closed solid; neighbours overlap where they meet. Union to merge.");
  out.push("# Terrain data (c) Kartverket, hoydedata.no, NLOD / CC BY 4.0");
  if (texture) out.push(`mtllib ${material}.mtl`);

  const northY = nrows * cell;
  const f = (v) => v.toFixed(4);

  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const sx = m[o], sy = m[o + 5], sz = m[o + 10];
    const cx = m[o + 12], cy = m[o + 13], cz = m[o + 14];
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const x0 = cx - hx, x1 = cx + hx;
    const y0 = cy - hy, y1 = cy + hy;
    const z0 = cz - hz, z1 = cz + hz;
    // 1-4 bottom (z0), 5-8 top (z1), each counter-clockwise seen from +Z.
    out.push(`v ${f(x0)} ${f(y0)} ${f(z0)}`);
    out.push(`v ${f(x1)} ${f(y0)} ${f(z0)}`);
    out.push(`v ${f(x1)} ${f(y1)} ${f(z0)}`);
    out.push(`v ${f(x0)} ${f(y1)} ${f(z0)}`);
    out.push(`v ${f(x0)} ${f(y0)} ${f(z1)}`);
    out.push(`v ${f(x1)} ${f(y0)} ${f(z1)}`);
    out.push(`v ${f(x1)} ${f(y1)} ${f(z1)}`);
    out.push(`v ${f(x0)} ${f(y1)} ${f(z1)}`);
  }

  // ONE texture coordinate per box, at its own centre, shared by all six of its
  // faces — so a box takes the single flat colour the viewport gives it rather
  // than a gradient across its top. That is the honest reading: a block IS an
  // aggregate, and shading it smoothly would imply detail it does not carry.
  if (texture) {
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      const u = m[o + 12] / (ncols * cell);
      const v = m[o + 13] / (nrows * cell);
      out.push(`vt ${Math.min(1, Math.max(0, u)).toFixed(6)} ${Math.min(1, Math.max(0, v)).toFixed(6)}`);
    }
    out.push(`usemtl ${material}`);
  }

  let triangles = 0;
  for (let i = 0; i < n; i++) {
    const b = i * 8;                     // 0-based vertex block
    const t = i + 1;                     // this box's single texcoord, 1-based
    const V = (k) => (texture ? `${b + k}/${t}` : `${b + k}`);
    // Counter-clockwise from outside, so normals point out of the solid.
    const quad = (a, c, d, e) => {
      out.push(`f ${V(a)} ${V(c)} ${V(d)}`);
      out.push(`f ${V(a)} ${V(d)} ${V(e)}`);
      triangles += 2;
    };
    quad(5, 6, 7, 8);   // top    (+Z)
    quad(4, 3, 2, 1);   // bottom (−Z)
    quad(1, 2, 6, 5);   // south  (−Y)
    quad(3, 4, 8, 7);   // north  (+Y)
    quad(2, 3, 7, 6);   // east   (+X)
    quad(4, 1, 5, 8);   // west   (−X)
  }

  return { obj: out.join("\n") + "\n", mtl: buildMTL(texture, opts), triangles, vertices: n * 8 };
}

/** The material file both writers share. */
function buildMTL(texture, opts) {
  let mtl = null;
  const material = opts.materialName ?? "terrain";
  if (texture) {
    mtl = [
      "# DL-TerrainDiversity material — analysis layer as a texture",
      `# layer: ${opts.layerLabel ?? material}`,
      "# A terrain analysis instrument's reading of measured terrain, not a prediction.",
      `newmtl ${material}`,
      "Ka 0.000 0.000 0.000",
      "Kd 1.000 1.000 1.000",
      "Ks 0.000 0.000 0.000",
      "d 1.0",
      "illum 1", // colour on, specular off: the texture carries the meaning
      `map_Kd ${texture}`,
      "",
    ].join("\n");
  }
  return mtl;
}
