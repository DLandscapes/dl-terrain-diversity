// @ts-check
// The analysis in a Web Worker, off the render thread — the normal route.
//
// ⚠️ ALL OF THE ANALYSIS IS IN analysis-core.js. This file only hosts it, so the
// page can run the very same code itself when a browser will not start this
// worker (analysis-client.js decides). See that file's header for why.
import { createCore } from "./analysis-core.js";

// @ts-ignore - worker global
const core = createCore((msg, transfer) => self.postMessage(msg, transfer ?? []));
// @ts-ignore - worker global
self.onmessage = (e) => core.handle(e.data);

// ⚠️ "I AM ALIVE" — sent only once every module above has loaded. Until it
// arrives the page holds its messages; if it never arrives, the page runs the
// analysis itself instead of waiting for ever on a worker that will not answer.
// @ts-ignore - worker global
self.postMessage({ type: "ready" });
