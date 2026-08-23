// @ts-check
// Offline frame rendering for the exhibition loop.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A SCREEN RECORDER.
// The deliverable is a 45.000-second seamless loop. Screen-capturing the live
// tool with OBS ties the master to whatever the compositor managed that day:
// dropped frames when the analysis worker runs long, a capture resolution
// bounded by the monitor, and a 2560x1440 -> 1080p downscale on top. None of
// that is recoverable afterwards.
//
// Instead the tool renders the film frame by frame against FixedStepClock,
// which advances ONLY when tick() is called. Time cannot move until the frame
// is genuinely ready, so a frame that takes two seconds to settle still lands
// at exactly 1/30 s of scene time. The render is then as slow as it needs to be
// and the result is still frame-exact. clock.js was written for this in Phase 2
// and had never been used.
//
// ⚠️ THIS MODULE DOES NOT DECIDE WHERE FRAMES GO. The caller passes `write`.
// 1350 frames at print resolution is several gigabytes, and the right sink
// differs by job — a ZIP for a handful of stills, the File System Access API
// for a full render, an in-memory array for a test. Baking one of those choices
// into the tool would make it wrong for the other two.

/**
 * @typedef {Object} SequenceOpts
 * @property {any} view      the View; only `renderAt` is used
 * @property {any} clock     a FixedStepClock — MUST have a duration set
 * @property {number} width  output pixels
 * @property {number} height
 * @property {(frame: number, canvas: HTMLCanvasElement, t: number) => (void|Promise<void>)} write
 *   called once per frame, in order, with the rendered canvas. Awaited, so a
 *   slow sink throttles the render rather than queueing memory.
 * @property {() => Promise<void>} [settle]
 *   resolves when the scene is ready to be photographed. Defaults to yielding
 *   the task queue twice, which covers a mesh upload but NOT a heavy analysis
 *   pass — pass a real one when the timeline touches terrain.
 * @property {(frame: number, total: number) => void} [onProgress]
 * @property {AbortSignal} [signal]
 */

/**
 * Yield once to the event loop, through a MessageChannel.
 *
 * ⚠️ THE OBVIOUS TWO WAYS TO DO THIS BOTH FAIL IN A BACKGROUND TAB, and a
 * 1350-frame render is precisely the job someone starts and then switches away
 * from. Both were tried here and both hung:
 *
 *   - requestAnimationFrame is SUSPENDED outright for hidden tabs. The render
 *     stopped dead on frame 0. (view.js flags the same hazard for
 *     ResizeObserver, which is what put me onto it.)
 *   - setTimeout is CLAMPED to about one second in a hidden tab. Two yields a
 *     frame turns a thirty-frame test into a minute and a 1350-frame render
 *     into most of an hour of pure waiting.
 *
 * A MessageChannel message is a macrotask and is not throttled, so the event
 * loop still turns — which is what lets a worker reply or a mesh upload land —
 * and it runs at full speed whether the tab is visible or not. This is the same
 * trick React's scheduler uses, for the same reason.
 *
 * A microtask (`await Promise.resolve()`) is NOT a substitute: microtask
 * checkpoints do not let the event loop deliver worker messages, so the frame
 * would be photographed before its analysis arrived.
 */
const yieldTask = () => new Promise((res) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); res(undefined); };
  ch.port2.postMessage(0);
});

/** Default settle: two event-loop turns. Enough for an upload, not for a worker. */
const twoTasks = async () => { await yieldTask(); await yieldTask(); };

/**
 * Render every frame of one loop, in order, starting at frame 0.
 *
 * Returns the frame times actually rendered, so the caller can assert against
 * them rather than trusting that the loop ran. A 45.000 s / 30 fps clock must
 * return exactly 1350 entries, the first 0 and the last 44.9666… — never 45.0,
 * because frame 1350 IS frame 0 of the next lap and rendering both would double
 * the seam.
 *
 * @param {SequenceOpts} opts
 * @returns {Promise<number[]>} scene time of each rendered frame, seconds
 */
export async function renderSequence(opts) {
  const { view, clock, width, height, write } = opts;
  const settle = opts.settle || twoTasks;
  const total = clock.totalFrames;
  if (!total) {
    throw new Error("renderSequence: the clock has no duration, so the loop has no length");
  }

  const times = [];
  clock.reset();
  for (let i = 0; i < total; i++) {
    if (opts.signal?.aborted) throw new DOMException("cancelled", "AbortError");
    // seek, THEN settle, THEN render — settling before the seek would photograph
    // the previous frame's state.
    clock.seek(i);
    await settle();
    const canvas = view.renderAt(width, height);
    times.push(clock.t);
    await write(i, canvas, clock.t);
    if (opts.onProgress) opts.onProgress(i + 1, total);
  }
  return times;
}

/**
 * The two frames that meet at the loop seam: the last one rendered, and the one
 * the film cuts back to.
 *
 * ⚠️ A loop is seamless when the LAST frame flows into the FIRST, which means
 * the pair to compare is (total-1, 0) — not (total, 0), and not (total-1,
 * total). Getting this wrong produces a test that passes on a film that visibly
 * jumps.
 *
 * @param {any} view @param {any} clock
 * @param {number} width @param {number} height
 * @param {() => Promise<void>} [settle]
 * @returns {Promise<{last: HTMLCanvasElement, first: HTMLCanvasElement, lastFrame: number}>}
 */
export async function seamPair(view, clock, width, height, settle = twoTasks) {
  const lastFrame = clock.totalFrames - 1;
  clock.seek(lastFrame);
  await settle();
  const last = view.renderAt(width, height);
  clock.seek(0);
  await settle();
  const first = view.renderAt(width, height);
  return { last, first, lastFrame };
}

/**
 * Mean absolute difference between two same-sized frames, 0..1.
 *
 * Deliberately the same measure the manifesto film used to compare shots, so
 * numbers from the two projects can be read side by side. Luma only: a seam
 * that differs in hue but not in brightness does not read as a jump.
 *
 * @param {HTMLCanvasElement} a @param {HTMLCanvasElement} b
 * @returns {number}
 */
export function frameDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`frameDiff: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const ga = /** @type {CanvasRenderingContext2D} */ (a.getContext("2d"));
  const gb = /** @type {CanvasRenderingContext2D} */ (b.getContext("2d"));
  const pa = ga.getImageData(0, 0, a.width, a.height).data;
  const pb = gb.getImageData(0, 0, b.width, b.height).data;
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < pa.length; i += 4) {
    const la = 0.2126 * pa[i] + 0.7152 * pa[i + 1] + 0.0722 * pa[i + 2];
    const lb = 0.2126 * pb[i] + 0.7152 * pb[i + 1] + 0.0722 * pb[i + 2];
    sum += Math.abs(la - lb);
  }
  return sum / n / 255;
}

/**
 * Frame index -> the filename ffmpeg expects for `-i frame_%05d.png`.
 * Zero-padded to five so 1350 frames sort correctly in any file browser.
 * @param {number} i
 */
export const frameName = (i) => `frame_${String(i).padStart(5, "0")}.png`;
