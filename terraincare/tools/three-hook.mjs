// Resolve the bare specifier "three" to the file this project already vendors.
//
// ⚠️ THIS EXISTS SO THE PROJECT CAN STAY node_modules-FREE. The app resolves
// "three" through an importmap in index.html, which Node does not read. Rather
// than install a package or rewrite every import to a relative path, a resolve
// hook maps the one bare specifier for command-line tooling only. Nothing in
// static/ changes, and the browser is unaffected.
import { register } from "node:module";

register("./three-hook-impl.mjs", import.meta.url);
