// positionSolver.js - continuous player position for the game cursor.
//
// The 3x3 grid is still the thing you whack, but the CURSOR no longer has to
// live on it. game.js already derives a discrete cell (gx, gy) from the column
// a sensor owns and the distance band the reading falls in; that cell can only
// ever be one of nine positions, which is why the cursor used to snap.
//
// This module supplies the two missing pieces:
//
//   window.Multilateration.solve(samples, options)
//       Turns per-node echo distances into ONE continuous (x, y) in
//       centimetres. Every node sits on the baseline at y = 0 at a known x, so
//       two nodes already pin the player down and a third only sharpens it.
//       Derivation, for a node at (xi, 0) reporting distance di:
//
//           di^2 = (x - xi)^2 + y^2 = x^2 - 2*x*xi + xi^2 + y^2
//
//       With S = x^2 + y^2, that rearranges to a LINEAR equation in the two
//       unknowns a = 2x and b = -S:
//
//           a*xi + b = xi^2 - di^2
//
//       Every node gives one line, so N nodes give an over-determined system
//       solved by least squares - a 2x2 normal-equation solve, no library.
//
//   window.CursorSmoother
//       A critically damped spring between the solved position and the drawn
//       cursor, so the cursor glides rather than teleports. Critically damped
//       means it never overshoots, and a max speed stops a single bad reading
//       from flinging the cursor across the board.
//
// Both are deliberately free of game rules, sensors and the DOM: the solver
// takes plain numbers and the smoother takes canvas pixels. Everything about
// the rig - how many nodes there are, where they sit, how deep the play area
// is - is passed in, so the servo rig can reuse both unchanged once it reports
// a pose of its own.
//
// API on `window`:
//   window.Multilateration.solve(samples, options) -> { x, y, residualCm, used } | null
//   new window.CursorSmoother({ smoothTime, maxSpeed })
//   smoother.reset()
//   smoother.step(target, dt) -> { x, y }
//   smoother.snapTo(target)
//   smoother.get() -> { x, y } | null

(function () {
  // --- Multilateration -----------------------------------------------------

  // Guards the 2x2 solve. A single sensor, or several at the same x, leaves the
  // matrix singular: there is no way to separate "close" from "to the side".
  const DETERMINANT_EPSILON = 1e-6;

  // A solution that does not reproduce the measured ranges is not a player, it
  // is a coincidence - two sensors each seeing something different. Ranges this
  // far apart on a coherent target do not happen, so refuse rather than draw
  // the cursor somewhere nobody is standing. 12 cm is roughly the spread a
  // single unfiltered ultrasonic frame pair produces on a real target.
  const MAX_RESIDUAL_CM = 12;

  // Below this the ranges are all but identical and the lateral solution is
  // numerically unreliable. (x^2 + y^2) is the squared range, so the floor is
  // applied in squared centimetres to keep the comparison scale-free.
  const MIN_RADIUS_SQUARED_CM = 1;

  function solveTwoByTwo(a11, a12, a21, a22, r1, r2) {
    const det = a11 * a22 - a12 * a21;
    if (!Number.isFinite(det) || Math.abs(det) < DETERMINANT_EPSILON) return null;
    return {
      x: (r1 * a22 - a12 * r2) / det,
      y: (a11 * r2 - r1 * a21) / det,
    };
  }

  /**
   * @param {Array<{x: number, d: number}>} samples  node x in cm, echo distance
   *   in cm. Nodes with no usable echo must be omitted, not passed as null.
   * @param {{maxResidualCm?: number, minSensors?: number}} [options]
   * @returns {{x: number, y: number, residualCm: number, used: number}|null}
   *   null when there is not enough geometry to solve, when the solution puts
   *   the player behind the baseline, or when the ranges disagree.
   */
  function solve(samples, options = {}) {
    const maxResidualCm = Number.isFinite(options.maxResidualCm)
      ? options.maxResidualCm
      : MAX_RESIDUAL_CM;
    const minSensors = Number.isFinite(options.minSensors) ? options.minSensors : 2;

    const points = (Array.isArray(samples) ? samples : []).filter(
      (s) => s && Number.isFinite(s.x) && Number.isFinite(s.d) && s.d >= 0
    );

    if (points.length < minSensors) return null;

    // Normal equations for a*xi + b = xi^2 - di^2, least squares over all nodes.
    let sxx = 0;
    let sx = 0;
    let rhsA = 0;
    let rhsB = 0;
    points.forEach((p) => {
      const target = p.x * p.x - p.d * p.d;
      sxx += p.x * p.x;
      sx += p.x;
      rhsA += p.x * target;
      rhsB += target;
    });

    const solution = solveTwoByTwo(sxx, sx, sx, points.length, rhsA, rhsB);
    if (!solution) return null;

    const x = solution.x / 2;
    const radiusSquared = -solution.y; // b = -(x^2 + y^2)

    if (!Number.isFinite(x) || !Number.isFinite(radiusSquared)) return null;
    if (radiusSquared < MIN_RADIUS_SQUARED_CM) return null;

    const ySquared = radiusSquared - x * x;

    // A negative y^2 means the ranges are too short to reach a common point -
    // the classic symptom of crosstalk between two live sensors. Rather than
    // take sqrt of a negative, report no position and let the hold policy ride
    // out the dropout the same way it rides out a missing echo.
    if (ySquared < 0) return null;

    const y = Math.sqrt(ySquared);

    // Do the ranges actually agree? Each node's own distance is the most
    // trustworthy thing in the set, so disagreement means at least one node is
    // not looking at the player.
    let squaredError = 0;
    points.forEach((p) => {
      const predicted = Math.hypot(x - p.x, y);
      const error = predicted - p.d;
      squaredError += error * error;
    });
    const residualCm = Math.sqrt(squaredError / points.length);
    if (residualCm > maxResidualCm) return null;

    return { x, y, residualCm, used: points.length };
  }

  // --- Cursor smoothing ----------------------------------------------------

  /**
   * Critically damped spring, with a speed ceiling.
   *
   * Plain exponential smoothing is the obvious choice and the wrong one: it is
   * asymptotic, so the cursor is always still creeping when the round ends, and
   * a 100 cm jump at the smoothing time constant still reads as a leap. A
   * critically damped spring arrives at the target and stops, and clamping the
   * per-step speed bounds how fast a bad frame can move the cursor regardless
   * of how far away the target is.
   */
  class CursorSmoother {
    constructor(options = {}) {
      // Time to close most of the gap. Long enough that ordinary sensor noise
      // does not read as movement, short enough that a deliberate step across
      // the board still feels responsive.
      this.smoothTime = Number.isFinite(options.smoothTime) ? options.smoothTime : 0.14;
      // Pixels per second. Sized so crossing the whole board takes about a
      // second - faster than a person can actually walk, so the cursor still
      // leads them slightly rather than trailing.
      this.maxSpeed = Number.isFinite(options.maxSpeed) ? options.maxSpeed : 900;
      this.x = null;
      this.y = null;
      this.vx = 0;
      this.vy = 0;
    }

    reset() {
      this.x = null;
      this.y = null;
      this.vx = 0;
      this.vy = 0;
    }

    // Jump straight to a position, discarding velocity. Used on the first
    // fix of a round so the cursor appears where the player is instead of
    // sliding in from wherever it last was.
    snapTo(target) {
      if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return this.get();
      this.x = target.x;
      this.y = target.y;
      this.vx = 0;
      this.vy = 0;
      return this.get();
    }

    get() {
      if (this.x === null || this.y === null) return null;
      return { x: this.x, y: this.y };
    }

    /**
     * Advance the spring toward `target` over `dt` milliseconds.
     * @param {{x: number, y: number}} target  canvas pixels
     * @param {number} dt  milliseconds since the last step
     */
    step(target, dt) {
      if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
        return this.get();
      }

      // First fix, or a reset: adopt it outright. Smoothing toward a target
      // from nowhere would sweep the cursor in from the last known spot, which
      // is exactly the artefact this module exists to remove.
      if (this.x === null || this.y === null) return this.snapTo(target);

      const seconds = Math.min(Math.max(dt, 0) / 1000, 0.1);
      if (seconds <= 0) return this.get();

      const alongX = stepAxis(this.x, target.x, this.vx, this.maxSpeed, this.smoothTime, seconds);
      const alongY = stepAxis(this.y, target.y, this.vy, this.maxSpeed, this.smoothTime, seconds);
      this.x = alongX.value;
      this.vx = alongX.velocity;
      this.y = alongY.value;
      this.vy = alongY.velocity;
      return { x: this.x, y: this.y };
    }
  }

  // One axis of the spring. Returns the new position AND the new velocity,
  // because the velocity is carried into the next frame - a half-finished
  // spring that forgets it is what makes cursor smoothing feel like lag.
  function stepAxis(current, target, velocity, maxSpeed, smoothTime, dt) {
    const omega = 2 / Math.max(1e-4, smoothTime);
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

    // How far the target is, clamped to what the speed ceiling allows in one
    // smoothTime. Beyond that the target is effectively "as far as I may go
    // this frame", which is what stops a bad frame flinging the cursor.
    const maxStep = maxSpeed * smoothTime;
    const change = clamp(current - target, -maxStep, maxStep);
    const limitedTarget = current - change;

    const temp = (velocity + omega * change) * dt;
    const nextVelocity = (velocity - omega * temp) * exp;
    const output = limitedTarget + (change + temp) * exp;

    // Overshoot guard. A critically damped spring only ever approaches from one
    // side, but the speed clamp moves the target out from under it, which can
    // push the output past the ORIGINAL target. Snap it and drop the velocity
    // rather than let the cursor sail past the player and come back.
    const overshot = (target - current > 0 && output > target) ||
                     (target - current < 0 && output < target);
    if (overshot) return { value: target, velocity: 0 };

    return { value: output, velocity: nextVelocity };
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  window.Multilateration = { solve, MAX_RESIDUAL_CM };
  window.CursorSmoother = CursorSmoother;
})();
