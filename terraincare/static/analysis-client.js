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

export class AnalysisClient {
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {(result: any) => void} onResult
   */
  /**
   * @param {import("./dem.js").DEM} dem
   * @param {(result: any) => void} onResult
   * @param {(err: string) => void} [onError]
   */
  constructor(dem, onResult, onError) {
    this.dem = dem;
    this.onResult = onResult;
    this.onError = onError;
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => this._onMessage(e.data);

    // A worker that throws during import or in a handler is otherwise COMPLETELY
    // SILENT: the page keeps running, the panels simply never update, and there
    // is nothing in the console. That cost real debugging time on this file
    // (`gradient.aspect` instead of `gradient.aspectDeg` — undefined index read).
    // Never leave a worker without these two handlers.
    this.worker.onerror = (e) => {
      this.inFlight = false;
      const where = e.filename ? ` @ ${e.filename.split("/").pop()}:${e.lineno}` : "";
      const msg = `worker error: ${e.message || "unknown"}${where}`;
      console.error(msg, e);
      this.lastError = msg;
      if (this.onError) this.onError(msg);
    };
    this.worker.onmessageerror = () => {
      this.inFlight = false;
      const msg = "worker could not deserialise a message";
      console.error(msg);
      this.lastError = msg;
      if (this.onError) this.onError(msg);
    };
    this.lastError = null;

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

    this.worker.postMessage({
      type: "init",
      z: dem.z.slice().buffer,
      nrows: dem.nrows, ncols: dem.ncols, cell: dem.cell,
      originX: dem.originX, originY: dem.originY, name: dem.name,
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
    this.worker.postMessage({ type: "reset", seq: ++this.seq });
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

    this.worker.postMessage(
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
    this.worker.postMessage({ type: "view", seq: ++this.seq, ...v });
  }

  /**
   * Set the period solar radiation integrates over, as [dayStart, dayEnd].
   * Recomputes rather than re-colours — the values themselves change.
   * @param {number[]} period
   */
  setSolarPeriod(period) {
    this.worker.postMessage({ type: "solar", seq: ++this.seq, period });
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
    this.worker.postMessage(
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
      this.worker.postMessage({ type: "grids", seq: ++this.seq });
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
    this.worker.terminate();
  }
}

/** @param {any} a @param {any} b */
function unionRect(a, b) {
  return {
    r0: Math.min(a.r0, b.r0), c0: Math.min(a.c0, b.c0),
    r1: Math.max(a.r1, b.r1), c1: Math.max(a.c1, b.c1),
  };
}
