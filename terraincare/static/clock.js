// @ts-check
// Time, owned in one place.
//
// WHY THIS EXISTS AND WHY IT IS HERE IN PHASE 2 RATHER THAN PHASE 6:
// The exhibition deliverable is a 45.000-second seamless loop. Producing that
// by hand-recording a live drag means many takes and a compromise, so the tool
// plays an authored gesture timeline against a deterministic clock instead —
// the interface still looks live because it *is* the real tool running.
//
// That only works if NOTHING anywhere reads performance.now() or Date.now()
// directly. Every eased camera move, every scatter growth animation, every
// water ripple and cursor position must take its time from a Clock. Retrofitting
// that into a codebase which has grown a dozen scattered time reads is a
// rewrite, so the discipline starts before there is anything to retrofit.
//
// Rule for all later phases: if you need the time, take it from the clock you
// were handed. Never call performance.now().

/**
 * @typedef {Object} Clock
 * @property {number} t        seconds since start (loops within `duration` if set)
 * @property {number} dt       seconds since the previous tick
 * @property {number} frame    frames advanced so far
 * @property {() => void} tick advance one step
 * @property {() => void} reset
 */

/**
 * Wall-clock time, for interactive use: studio, teaching, kiosk, and OBS
 * screen capture. Wraps at `duration` if one is given, so a looping demo can
 * run indefinitely.
 */
export class RealtimeClock {
  /** @param {{duration?: number}} [opts] duration in seconds; 0/undefined = never wrap */
  constructor(opts = {}) {
    this.duration = opts.duration ?? 0;
    this._now = () => performance.now() / 1000; // the ONE legitimate call site
    this.reset();
  }

  reset() {
    this._start = this._now();
    this._last = this._start;
    this.t = 0;
    this.dt = 0;
    this.frame = 0;
    /** true on the tick where t wrapped back past 0 */
    this.looped = false;
  }

  tick() {
    const now = this._now();
    this.dt = now - this._last;
    this._last = now;
    let elapsed = now - this._start;
    this.looped = false;
    if (this.duration > 0 && elapsed >= this.duration) {
      // Re-anchor rather than modulo, so `dt` stays sane across the seam.
      const laps = Math.floor(elapsed / this.duration);
      this._start += laps * this.duration;
      elapsed -= laps * this.duration;
      this.looped = true;
    }
    this.t = elapsed;
    this.frame++;
  }
}

/**
 * Fixed-step time, for deterministic capture and for the determinism
 * assertions in the self-test. Advances only when tick() is called, so the
 * caller can wait for the mesh upload, the worker result and the scatter write
 * to settle before letting time move — which is what makes a frame-accurate
 * 30 fps master possible even if rendering runs slower than real time.
 */
export class FixedStepClock {
  /** @param {{fps?: number, duration?: number}} [opts] */
  constructor(opts = {}) {
    this.fps = opts.fps ?? 30;
    this.duration = opts.duration ?? 0;
    this.reset();
  }

  reset() {
    this.frame = 0;
    this.t = 0;
    this.dt = 0;
    this.looped = false;
  }

  /** Total frames in one loop, or 0 if unbounded. */
  get totalFrames() {
    return this.duration > 0 ? Math.round(this.duration * this.fps) : 0;
  }

  tick() {
    this.dt = 1 / this.fps;
    this.frame++;
    this.looped = false;
    const total = this.totalFrames;
    if (total > 0 && this.frame >= total) {
      this.frame = 0;
      this.looped = true;
    }
    this.t = this.frame / this.fps;
  }

  /** Jump to an exact frame — used by the loop-seam pixel comparison. */
  seek(frame) {
    this.frame = frame;
    this.t = frame / this.fps;
    this.dt = 1 / this.fps;
    this.looped = false;
  }
}

/** Easings for authored camera moves and slider ramps. */
export const EASE = {
  linear: (x) => x,
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
};

/**
 * @param {keyof typeof EASE | undefined} name
 * @returns {(x:number)=>number}
 */
export function ease(name) {
  return EASE[name ?? "linear"] ?? EASE.linear;
}
