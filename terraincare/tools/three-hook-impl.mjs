// The resolve hook itself. Runs on the module loader thread.
const VENDORED = new URL("../static/vendor/three/three.module.min.js", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "three") return { url: VENDORED, shortCircuit: true };
  return next(specifier, context);
}
