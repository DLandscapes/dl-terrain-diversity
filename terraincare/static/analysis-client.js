// @ts-check
// Main-thread side of the worker protocol.
//
// SINGLE-SLOT LATEST-WINS. While a pass is in flight, further edits are not
// queued — their dirty rects are merged into one pending union and sent as a
// single patch when the reply lands. A queue would build unbounded latency
// during a drag and then replay stale states; this always computes the most
// recent surface and nothing else.
//
// DEGRADE AND SETTLE. If passes get slow (a weak exhibition or teaching
// laptop), panels drop to every-other-pass and the UI shows it, rather than the
// hand starting to stutter. On pointer-up a full pass is always forced, so the
// numbers finally read exact — the demo timeline depends on that, because the
// figures it reveals on cue must come from a complete recompute rather than a
// coalesced one.

// Above this, start skipping panel work to protect interactivity.
//
// CALIBRATION, and why this is not 25 ms. The isolated benchmark in the
// self-test measures the algorithm alone and gets ~26 ms in Chromium. But in the
// running app the same pass shares the machine with the render loop, the
// three.js scene and the panel colourisation, and measures a healthy
// steady-state median of ~40 ms on this hardware (min 35).
//
// Those are two different numbers measuring two different things, and conflating
// them is how a threshold ends up firing on healthy hardware: at 25 ms the tool
// sat permanently in degraded mode, halving panel updates for no reason. This
// guard exists for machines genuinely slower than the development one, so it is
// set comfortably above the measured healthy figure.
// ⚠️ MEASURED ON TWO MACHINES, NOT ONE, AND DECIDED ON A MEDIAN RATHER THAN A
// SAMPLE. The development machine runs a healthy interactive pass at ~40 ms
// median. A second machine measured 63.8, 64.5, 76.3, 76.6, 96.7 ms — median
// 76 — with panels updating perfectly well by eye. Against the old single-sample
// 60 ms test, EVERY pass on that machine tripped the flag, so it latched on the
// first edit and never cleared: `degraded` is only re-evaluated on non-heavy
// passes, and after a level the last pass is the heavy settle. The result was
// nine of sixteen panels dimmed to 75 % and labelled "·settling" permanently,
// which reads as the tool having broken.
//
// Two thresholds, not one: enter degraded above ENTER, leave below LEAVE. A
// machine sitting near a single boundary otherwise flaps between dimmed and
// undimmed every few frames, which is worse than either state.
const SLOW_PASS_ENTER_MS = 90;
const SLOW_PASS_LEAVE_MS = 70;
/** How many interactive passes the median is taken over. */
const PASS_WINDOW = 5;

// ⚠️⚠️ A WORKER THAT NEVER STARTS MUST NOT MEAN A TOOL THAT NEVER ANSWERS
// (2026-10-28). One Chrome profile, on two PCs, ran the page but not its
// worker: every shader stayed blank, the elevation legend read 0-1 m, and
// nothing on screen said why. The same Chrome 156 with a fresh profile, Edge
// and the built-in browser were all fine, so the cause sat in that profile
// (an extension or a policy) — which is exactly why the tool cannot rely on
// every visitor's browser starting a worker. Marc: "it should work on
// chrome, firefox, and other standard browsers" — "also safari".
//
// So the worker must SAY it is alive (worker.js posts "ready" once its
// modules have loaded). Until then messages are held; if the worker cannot
// be created, fails before "ready", or stays silent for this long, the page
// runs the very same analysis-core.js itself. Ten seconds is generous on
// purpose: on a slow connection the worker has a dozen modules to fetch, and
// falling back too early would put a healthy machine's analysis on the
// render thread for nothing.
const WORKER_READY_MS = 10000;

/** @param {any} e */
const errText = (e) => (e && e.message) || String(e);

export class AnalysisClient {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {(result: any) => void} onResult
   */
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {(result: any) => void} onResult
   * @param {(err: string) => void} [onError]
   * @param {{inPage?: boolean}} [opts] inPage = skip the worker and run on the page
   */
  constructor(dem, onResult, onError, opts = {}) {
    this.dem = dem;
    this.onResult = onResult;
    this.onError = onError;
    this.lastError = null;
    /** "starting" until a host says it is alive; then "worker" or "page"; "failed" if neither */
    this.mode = "starting";
    /** why the page runs the analysis itself, when it does */
    /** @type {string|null} */ this.fallbackReason = null;
    /** messages held until a host is alive, in order, with their transfer lists */
    /** @type {Array<[any, Transferable[]]>} */ this._outbox = [];
    /** called once if the analysis moves to the page: (mode, reason) */
    /** @type {((mode: string, reason: string) => void) | null} */ this.onModeChange = null;
    if (opts.inPage) this._fallBack("the page was asked to (?analysis=page)");
    else this._startWorker();

    this.seq = 0;
    this.inFlight = false;
    /** @type {{r0:number,c0:number,r1:number,c1:number} | null} */
    this.pending = null;
    /** force a full-quality pass even in degraded mode */
    this.pendingForce = false;

    this.lastMs = 0;
    this.degraded = false;
    this._passCount = 0;
    /** recent INTERACTIVE pass times, newest last — the degraded decision's input */
    /** @type {number[]} */ this._recentMs = [];
    /** did the last dispatched pass ask for panels? see _flush() */
    this.lastGavePanels = true;

    this._send({
      type: "init",
      z: dem.z.slice().buffer,
      nrows: dem.nrows, ncols: dem.ncols, cell: dem.cell,
      originX: dem.originX, originY: dem.originY, name: dem.name,
      // The CRS travels with the raster: the worker derives the SUN's
      // latitude from it. Without this the sun was fixed at the
      // development site's 69.7 N for every raster on Earth.
      epsg: dem.epsg ?? null,
      seq: ++this.seq,
    });
    this.inFlight = true;
  }

  /**
   * Note that a cell rectangle changed. Safe to call every frame.
   * @param {{r0:number,c0:number,r1:number,c1:number}} rect
   * @param {{force?: boolean}} [opts] force = settle now, full quality
   */
  invalidate(rect, opts = {}) {
    this.pending = this.pending ? unionRect(this.pending, rect) : { ...rect };
    if (opts.force) this.pendingForce = true;
    if (!this.inFlight) this._flush();
  }

  /**
   * Force a complete settled pass (called on pointer-up), including the
   * expensive layers — sky-view factor, openness and solar radiation. Those
   * involve horizon tracing in every compass direction from every cell, which
   * is far too costly to run while the hand is moving, so they are deliberately
   * a settle-time product: the surface keeps its previous ambient occlusion
   * during a drag and refreshes the moment you let go.
   */
  settle() {
    const whole = { r0: 0, c0: 0, r1: this.dem.nrows - 1, c1: this.dem.ncols - 1 };
    this.pendingHeavy = true;
    this.invalidate(this.pending ?? whole, { force: true });
  }

  /** Restore the pristine surface in the worker, without refetching. */
  reset() {
    this.pending = null;
    this.pendingForce = false;
    // A settle requested before the reset refers to a surface that no longer
    // exists; the reset pass below recomputes the heavy layers itself.
    this.pendingHeavy = false;
    this._send({ type: "reset", seq: ++this.seq });
    this.inFlight = true;
  }

  _flush() {
    const rect = this.pending;
    if (!rect) return;
    this.pending = null;
    const force = this.pendingForce;
    this.pendingForce = false;
    const heavy = this.pendingHeavy === true;
    this.pendingHeavy = false;

    // Copy just the changed rectangle out of the live DEM.
    const { r0, c0, r1, c1 } = rect;
    const w = c1 - c0 + 1, h = r1 - r0 + 1;
    const vals = new Float32Array(w * h);
    for (let r = r0; r <= r1; r++) {
      const src = r * this.dem.ncols + c0;
      vals.set(this.dem.z.subarray(src, src + w), (r - r0) * w);
    }

    // In degraded mode, colourise only every other pass — the metrics still
    // update every pass, because they are cheap and they are what the video
    // reads out. A forced settle always gets panels.
    this._passCount++;
    const wantPanels = force || !this.degraded || this._passCount % 2 === 0;
    // What the app needs to know is not "is this machine slow" but "are the
    // panels on screen the current numbers". Only a pass that carries panels
    // makes them current again.
    this.lastGavePanels = wantPanels;

    this._send(
      { type: "patch", seq: ++this.seq, rect, values: vals.buffer, wantPanels, heavy },
      [vals.buffer],
    );
    this.inFlight = true;
  }

  /**
   * Change how layers are COLOURED — percentile cuts and palette variant —
   * without recomputing any analysis.
   *
   * Latest-wins like the analysis passes, and for the same reason: a stretch
   * handle emits a change per pointer move, and queueing them would leave the
   * ramp lagging behind the hand.
   * @param {{stretch?: Record<string, number[]>, variant?: Record<string, string>}} v
   */
  setView(v) {
    this._view = v;
    if (this._viewInFlight) { this._viewPending = true; return; }
    this._viewInFlight = true;
    this._send({ type: "view", seq: ++this.seq, ...v });
  }

  /**
   * Set the period solar radiation integrates over, as [dayStart, dayEnd].
   * Recomputes rather than re-colours — the values themselves change.
   * @param {number[]} period
   */
  setSolarPeriod(period) {
    this._send({ type: "solar", seq: ++this.seq, period });
    this.inFlight = true;
  }

  /**
   * Hand the worker a copy of the substrate map.
   *
   * The main thread owns this grid — the brush edits it and the panel is
   * colourised there for immediate feedback. The worker gets a copy purely so
   * the export path finds it in `lastGrids` alongside every computed layer.
   *
   * Sent as a COPY, not a transfer: the caller keeps painting on the original.
   * Deliberately not gated on `inFlight` — it is a side channel and must not
   * disturb the latest-wins pass bookkeeping.
   * @param {Uint8Array|null} codes  one class code per cell, or null to clear
   */
  setSubstrate(codes) {
    if (this.disposed) return;
    const copy = codes ? codes.slice() : null;
    this._send(
      { type: "substrate", seq: ++this.seq, codes: copy ? copy.buffer : null },
      copy ? [copy.buffer] : []);
  }

  /**
   * The float grids behind the last pass, for export. Requested on demand
   * because nine grids is 2.4 MB that nothing reads during normal use.
   * @returns {Promise<Record<string, Float32Array>>}
   */
  grids() {
    return new Promise((resolve, reject) => {
      if (this.disposed) { reject(new Error("analysis worker disposed")); return; }
      // ⚠️⚠️ EVERY WAITER IS KEPT, NOT JUST THE LAST ONE (2026-08-12). This was a
      // single slot, so a second request while one was in flight simply
      // OVERWROTE the first one's resolver. The orphaned promise then sat until
      // its 10 s timer fired and rejected — and the rule panel, whose sliders
      // call this on every `input` event while a hand is dragging, issues these
      // several a second. One drag was enough to strand a request and reject it.
      // A list costs nothing and makes the caller's concurrency its own business.
      const timer = setTimeout(() => {
        this._gridsPending = (this._gridsPending || []).filter((w) => w.resolve !== resolve);
        reject(new Error("analysis worker did not return grids"));
      }, 10000);
      if (!this._gridsPending) this._gridsPending = [];
      this._gridsPending.push({ resolve, timer });
      this._send({ type: "grids", seq: ++this.seq });
    });
  }

  _onMessage(m) {
    // terminate() does not recall a result already queued on the main thread's
    // event loop. After a tile switch that stale result describes the PREVIOUS
    // terrain — for a different grid size, putImageData would throw on the
    // mismatched buffer, and either way the new tile's panels would flash the
    // old tile's data. Disposed means disposed.
    if (this.disposed) return;
    if (m.type === "recolour") {
      this._viewInFlight = false;
      if (this.onRecolour) this.onRecolour(m);
      if (this._viewPending) {
        this._viewPending = false;
        this.setView(this._view);
      }
      return;
    }
    if (m.type === "grids") {
      // Deliberately NOT gated on inFlight: a grids request is a side question
      // and must not disturb the latest-wins pass bookkeeping.
      //
      // One reply satisfies every waiter: the grids describe the surface as it
      // stands, so a caller that asked a moment earlier wanted exactly this.
      const waiting = this._gridsPending || [];
      this._gridsPending = [];
      for (const w of waiting) { clearTimeout(w.timer); w.resolve(m.grids); }
      return;
    }
    if (m.type !== "result") return;
    this.inFlight = false;
    this.lastMs = m.ms;
    this.lastHeavy = !!m.heavy;
    // Judge interactivity ONLY on interactive passes. A settle pass also traces
    // the horizon and integrates solar radiation, which legitimately takes
    // several hundred milliseconds — counting that as evidence of a slow
    // machine flagged every live panel as "settling" immediately after every
    // settle, which is precisely backwards.
    if (!m.heavy) {
      this._recentMs.push(m.ms);
      if (this._recentMs.length > PASS_WINDOW) this._recentMs.shift();
      // Median, not mean: one 300 ms hitch from a background tab or a GC pause
      // must not decide how the tool behaves for the rest of the session, and
      // the mean is exactly the statistic that lets it.
      const sorted = [...this._recentMs].sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1];
      // Wait for a full window before judging. Judging on the first pass is how
      // the single-sample version latched, and the first pass after a tile load
      // is the least representative one there is.
      if (this._recentMs.length >= PASS_WINDOW) {
        this.degraded = this.degraded ? med > SLOW_PASS_LEAVE_MS : med > SLOW_PASS_ENTER_MS;
      }
    }
    this.onResult(m);
    if (this.pending) this._flush();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this._readyTimer);
    if (this.worker) this.worker.terminate();
  }

  /**
   * Send to whichever host is running — or hold the message until one is.
   * @param {any} msg @param {Transferable[]} [transfer]
   */
  _send(msg, transfer = []) {
    if (this.mode === "worker" || this.mode === "page") this.worker.postMessage(msg, transfer);
    else if (this.mode === "starting") this._outbox.push([msg, transfer]);
    // "failed": nothing can answer; the error is already on screen.
  }

  /** The normal route: the analysis in a module worker, off the render thread. */
  _startWorker() {
    let w;
    try {
      w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    } catch (err) {
      this._fallBack(`the browser would not create it (${errText(err)})`);
      return;
    }
    this.worker = w;
    w.onmessage = (e) => {
      if (this.mode === "starting") {
        if (e.data && e.data.type === "ready") this._adopt("worker");
        return;
      }
      this._onMessage(e.data);
    };

    // A worker that throws during import or in a handler is otherwise COMPLETELY
    // SILENT: the page keeps running, the panels simply never update, and there
    // is nothing in the console. That cost real debugging time on this file
    // (`gradient.aspect` instead of `gradient.aspectDeg` — undefined index read).
    // Never leave a worker without these two handlers.
    //
    // ⚠️ BEFORE "ready" AN ERROR MEANS THE WORKER NEVER STARTED — a script it
    // needs was blocked or would not load — and that is the one case the page
    // can rescue by running the analysis itself. AFTER "ready" an error is a
    // fault in the analysis, which the page would hit too, so it is reported.
    w.onerror = (e) => {
      if (this.mode === "starting") {
        if (e.preventDefault) e.preventDefault();
        this._fallBack(`it did not start (${e.message || "the browser gave no reason"})`);
        return;
      }
      this._fail(`worker error: ${e.message || "unknown"}${e.filename ? ` @ ${e.filename.split("/").pop()}:${e.lineno}` : ""}`, e);
    };
    w.onmessageerror = () => this._fail("worker could not deserialise a message");

    this._readyTimer = setTimeout(() => {
      if (this.mode === "starting") this._fallBack(`it did not answer within ${WORKER_READY_MS / 1000} s`);
    }, WORKER_READY_MS);
  }

  /**
   * A host said it is alive: hand it everything held, in order.
   * @param {"worker"|"page"} mode
   */
  _adopt(mode) {
    clearTimeout(this._readyTimer);
    this.mode = mode;
    const held = this._outbox;
    this._outbox = [];
    for (const [msg, transfer] of held) this.worker.postMessage(msg, transfer);
  }

  /**
   * The worker is not coming: run the same analysis on the page.
   *
   * ⚠️ THE SAME CODE, NOT A SECOND IMPLEMENTATION. analysis-core.js is what the
   * worker runs; here it runs on the render thread instead. The numbers are
   * identical; only the hand pays, because a pass now shares the thread with
   * the drawing — which is why the status line says so rather than hiding it.
   * @param {string} reason
   */
  async _fallBack(reason) {
    if (this.mode !== "starting" || this._fallingBack) return;
    this._fallingBack = true;
    clearTimeout(this._readyTimer);
    if (this.worker) { try { this.worker.terminate(); } catch { /* already gone */ } }
    this.worker = null;
    this.fallbackReason = reason;
    console.warn(`analysis: the background worker is not available — ${reason}. Running it on the page instead.`);
    let core;
    try {
      core = await import("./analysis-core.js");
    } catch (err) {
      // Not even the page could load the analysis: say so plainly, because a
      // blank map otherwise reads as "this terrain has nothing in it".
      this.mode = "failed";
      this._fail(`the analysis scripts would not load in this browser (${errText(err)})`, err);
      return;
    }
    if (this.disposed) return;
    this.worker = new InPageAnalysis(core.createCore,
      (m) => this._onMessage(m),
      (msg, err) => this._fail(msg, err));
    this._adopt("page");
    if (this.onModeChange) this.onModeChange("page", reason);
  }

  /** @param {string} msg @param {any} [err] */
  _fail(msg, err) {
    this.inFlight = false;
    console.error(msg, err ?? "");
    this.lastError = msg;
    if (this.onError) this.onError(msg);
  }
}

/**
 * The analysis on the page, wearing a worker's interface.
 *
 * ⚠️ IT KEEPS postMessage'S CONTRACT EXACTLY, because the code on both sides was
 * written against it: each side receives its OWN copy (structuredClone), and a
 * transferred buffer LEAVES the sender. Handing objects across by reference
 * instead would let the core's next pass overwrite a panel the page is still
 * drawing — a bug that could only ever appear in this fallback, which is the
 * path nobody tests by accident. Delivery is asynchronous for the same reason.
 */
class InPageAnalysis {
  /**
   * @param {(post: (msg: any, transfer?: Transferable[]) => void) => {handle: (m: any) => void}} createCore
   * @param {(m: any) => void} deliver
   * @param {(msg: string, err?: any) => void} fail
   */
  constructor(createCore, deliver, fail) {
    this.closed = false;
    this.fail = fail;
    this.core = createCore((msg, transfer = []) => {
      const copy = structuredClone(msg, { transfer });
      setTimeout(() => { if (!this.closed) deliver(copy); }, 0);
    });
  }

  /** @param {any} msg @param {Transferable[]} [transfer] */
  postMessage(msg, transfer = []) {
    const copy = structuredClone(msg, { transfer });
    setTimeout(() => {
      if (this.closed) return;
      try { this.core.handle(copy); } catch (err) { this.fail(`analysis error: ${errText(err)}`, err); }
    }, 0);
  }

  terminate() { this.closed = true; }
}

/** @param {any} a @param {any} b */
function unionRect(a, b) {
  return {
    r0: Math.min(a.r0, b.r0), c0: Math.min(a.c0, b.c0),
    r1: Math.max(a.r1, b.r1), c1: Math.max(a.c1, b.c1),
  };
}
