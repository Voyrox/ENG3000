// test_position_solver.js
//
// Exercises the continuous-position work in the REAL browser modules, headless
// in Node: positionSolver.js, callibrate_corners.js and game.js are loaded into
// a vm context exactly as the page loads them, then driven with sensor streams.
//
// The point of these tests is the promise the smooth cursor makes:
//
//   1. a target's position is solved from per-node ranges, to a useful accuracy
//   2. the DRAWN cursor is continuous, not one of nine hole centres
//   3. the drawn cursor and the hit-test grid agree - every hole centre is a
//      fixed point of the cm -> pixel mapping, so the cursor passes through all
//      nine and can never be somewhere the grid does not believe
//   4. a bad geometry produces NO position rather than a wild one
//
// Run with:
//
//     node --test Website/tests/test_position_solver.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const vm = require("vm");

const DISPLAYS = path.join(__dirname, "..", "public", "displays");
const MODULES = ["alert.js", "callibrate_corners.js", "positionSolver.js", "game.js"];

const CANVAS = { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 };
const FRAME_MS = 16;

// The page's clock, shared so helpers that step the loop in sequence carry on
// from where the last one stopped rather than jumping backwards.
let clock = 0;

// Ranges are generated from the three column centres. The rig has two nodes,
// LEFT and RIGHT (25 and 125); the game ignores the centre slot, so the value
// generated for 75 is never read and the tests describe a two-node rig.
const SENSOR_X = [25, 75, 125];
const NEAR_CM = 20;
const FAR_CM = 140;

// Loads the page's modules into a fresh window.
function loadWindow() {
  const context = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    performance: { now: () => 0 },
    Image: class { set src(_) {} },
  };
  context.window = context;
  vm.createContext(context);
  MODULES.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(DISPLAYS, file), "utf8"), context,
      { filename: file });
  });
  return context;
}

// The player is a body: a node's echo comes off the side of them nearest it,
// the game's tuning.bodyRadiusCm short of their middle.
const BODY_RADIUS_CM = loadWindow().tuneSensor({}).bodyRadiusCm;

// Exact ranges from `sensors` at x positions to a player whose middle is at
// (x, y), as game.js is sent them.
function rangesTo(positions, x, y) {
  return positions.map((sx) => Math.hypot(x - sx, y) - BODY_RADIUS_CM);
}

// Feeds one sensor frame per node message and steps the game loop over it.
// `frames` readings per node, the way a rig at ~20 Hz arrives.
function drive(w, framesPerNode, frameFn, { stepMs = FRAME_MS } = {}) {
  const nodes = [1, 2, 3].map((id) => ({ id, online: true, latest: null }));
  let clock = 0;
  const frames = [];

  for (let i = 0; i < framesPerNode; i += 1) {
    const values = frameFn(i);
    nodes.forEach((node, slot) => {
      const value = values[slot];
      node.latest = JSON.stringify({ avg: value === null || value === undefined ? -1 : value });
    });
    // 50 ms of loop per sensor frame, as the real rig reports at ~20 Hz.
    const steps = Math.max(1, Math.round(50 / stepMs));
    for (let s = 0; s < steps; s += 1) {
      clock += stepMs;
      contextNow(w, clock);
      w.markSensorFrame();
      w.updateGame(clock, CANVAS, nodes);
      const cursor = w.getGameState().cursor;
      if (cursor.x !== null && cursor.x !== undefined) {
        frames.push({ t: clock, x: cursor.x, y: cursor.y, ...w.getSensorDebug().world });
      }
    }
  }
  return frames;
}

function contextNow(w, t) {
  w.performance.now = () => t;
}

function startSensorRound(w) {
  w.setGameInputMode("sensor");
  w.resetGame();
}

// Steps the loop until the drawn cursor has converged, so a test can assert on
// the settled position rather than on however far the spring happened to get in
// a fixed number of frames. The spring deliberately eases, so an under-settled
// assertion measures the easing, not the mapping.
//
// The clock is shared with the page, because the spring derives its frame delta
// from performance.now(). A clock that jumps backwards freezes it, so successive
// calls have to carry on from where the last one stopped.
//
// minFrames is not optional politeness. Two separate lags sit between a changed
// target and a moved cursor, and only the first shows up as motion: the median
// window carries a new value through in five readings, and the slew filter will
// not even accept a physically impossible jump until eight consecutive readings
// agree with it. Until then the pipeline reports its previous value, perfectly
// still - so a cursor-only convergence check would happily call the stale
// position "settled". 120 frames clears the worst case (8 + 5) and leaves the
// spring the rest.
function settle(w, nodes, { minFrames = 120, maxFrames = 600, stableFrames = 12, epsilonPx = 0.25 } = {}) {
  let previous = null;
  let lastWorld = null;
  let worldStableFor = 0;
  for (let i = 0; i < maxFrames; i += 1) {
    clock += FRAME_MS;
    contextNow(w, clock);
    w.markSensorFrame();
    w.updateGame(clock, CANVAS, nodes);

    const cursor = w.getGameState().cursor;
    const world = w.getSensorDebug().world;
    const key = world ? `${world.xCm},${world.yCm},${world.resolved}` : "none";
    worldStableFor = key === lastWorld ? worldStableFor + 1 : 0;
    lastWorld = key;

    const cursorStill = previous
      && Math.abs(cursor.x - previous.x) < epsilonPx
      && Math.abs(cursor.y - previous.y) < epsilonPx;
    if (i >= minFrames && cursorStill && worldStableFor >= stableFrames) return cursor;
    previous = { x: cursor.x, y: cursor.y };
  }
  return w.getGameState().cursor;
}

// --- The solver itself -------------------------------------------------------

test("multilateration recovers a known target from two nodes", () => {
  const w = loadWindow();
  // A target at (75, 90): dead ahead of the centre sensor.
  const solution = w.Multilateration.solve(
    [{ x: 25, d: Math.hypot(50, 90) }, { x: 125, d: Math.hypot(50, 90) }]
  );
  assert.ok(solution, "two nodes should be enough");
  assert.ok(Math.abs(solution.x - 75) < 1e-6, `x was ${solution.x}`);
  assert.ok(Math.abs(solution.y - 90) < 1e-6, `y was ${solution.y}`);
  assert.ok(solution.residualCm < 1e-6, "an exact solve has no residual");
});

test("multilateration works off-axis, where the node that owns the cell is the far one", () => {
  const w = loadWindow();
  const target = { x: 52, y: 64 };
  const solution = w.Multilateration.solve(
    [0, 1, 2].map((i) => ({ x: SENSOR_X[i], d: Math.hypot(target.x - SENSOR_X[i], target.y) }))
  );
  assert.ok(solution, "should solve");
  assert.ok(Math.abs(solution.x - target.x) < 1e-6, `x was ${solution.x}`);
  assert.ok(Math.abs(solution.y - target.y) < 1e-6, `y was ${solution.y}`);
});

test("one node is not enough: a single range cannot separate side from depth", () => {
  const w = loadWindow();
  assert.strictEqual(w.Multilateration.solve([{ x: 75, d: 90 }]), null);
});

test("two nodes at the same x are degenerate and refused", () => {
  const w = loadWindow();
  assert.strictEqual(
    w.Multilateration.solve([{ x: 75, d: 90 }, { x: 75, d: 90 }]),
    null,
    "a singular matrix must not produce a position"
  );
});

test("ranges that disagree are refused instead of solved", () => {
  const w = loadWindow();
  // Each node seeing a different target - crosstalk, or two people.
  const solution = w.Multilateration.solve(
    [{ x: 25, d: 60 }, { x: 75, d: 120 }, { x: 125, d: 60 }]
  );
  assert.strictEqual(solution, null, "an inconsistent set of ranges has no player");
});

test("a negative y-squared is refused rather than taking sqrt of a negative", () => {
  const w = loadWindow();
  // Ranges far too short to share any point.
  assert.strictEqual(w.Multilateration.solve([{ x: 25, d: 5 }, { x: 125, d: 5 }]), null);
});

test("no-echo samples are skipped, and a lost node drops out cleanly", () => {
  const w = loadWindow();
  const target = { x: 100, y: 70 };
  const all = [0, 1, 2].map((i) => Math.hypot(target.x - SENSOR_X[i], target.y));
  const withOneDead = [
    { x: 25, d: all[0] },
    { x: 75, d: null },
    { x: 125, d: all[2] },
  ];
  const solution = w.Multilateration.solve(withOneDead);
  assert.ok(solution, "the surviving two nodes still pin the target");
  assert.ok(Math.abs(solution.x - target.x) < 1e-6, `x was ${solution.x}`);
  assert.strictEqual(solution.used, 2);
});

// --- Sensor x offsets --------------------------------------------------------

test("getSensorX reports the column centres the grid mapping already assumes", () => {
  const w = loadWindow();
  // Two nodes, LEFT and RIGHT, at the outer column centres; no centre node.
  assert.deepStrictEqual([0, 1, 2].map((i) => w.getSensorX(i)), [25, null, 125]);
  assert.strictEqual(w.getSensorX(3), null);
  assert.strictEqual(w.getSensorX(-1), null);
  assert.strictEqual(w.getSensorCount(), 2);
});

// --- The mapping agrees with the grid ----------------------------------------

test("every hole centre is a fixed point of the cm -> pixel mapping", () => {
  const w = loadWindow();
  startSensorRound(w);
  // Default (uncalibrated) bounds: rows span NEAR_CM..FAR_CM, so row r's centre
  // depth is NEAR_CM + (r + 0.5) * rowDepth.
  const rowDepth = (FAR_CM - NEAR_CM) / 3;

  for (let gx = 0; gx < 3; gx += 1) {
    for (let gy = 0; gy < 3; gy += 1) {
      const depth = NEAR_CM + (gy + 0.5) * rowDepth;
      const values = rangesTo(SENSOR_X, SENSOR_X[gx], depth);
      const nodes = [0, 1, 2].map((slot) => ({
        id: slot + 1, online: true, latest: JSON.stringify({ avg: values[slot] }),
      }));

      // The cursor is eased in from wherever the previous cell left it, so this
      // has to run to the settled position rather than read a fixed frame count.
      const settled = settle(w, nodes);

      const holeCentre = w.gridToCanvasPoint(CANVAS, gx, gy);
      assert.ok(
        Math.abs(settled.x - holeCentre.x) < 0.5,
        `cell (${gx},${gy}) cursor x ${settled.x} vs hole centre ${holeCentre.x}`
      );
      assert.ok(
        Math.abs(settled.y - holeCentre.y) < 0.5,
        `cell (${gx},${gy}) cursor y ${settled.y} vs hole centre ${holeCentre.y}`
      );
      assert.ok(settled.x !== null, "the cursor should exist for an in-range target");
    }
  }
});

test("browser filter starts a fresh range track after a servo turn", () => {
  const w = loadWindow();
  const nodes = [1, 2, 3].map((id) => ({ id, online: true, latest: null }));
  const read = (distance, angle, time) => {
    nodes[0].latest = JSON.stringify({ avg: distance, angle });
    contextNow(w, time);
    w.markSensorFrame();
    return w.readSensorCoordinate(nodes);
  };
  for (let i = 0; i < 6; i += 1) read(60, 90, 100 + 50 * i);
  const turned = read(120, 110, 400);
  assert.strictEqual(turned.filtered[0], 120, "old bearing must not slew-gate the new range");
  const missed = read(-1, 130, 450);
  assert.strictEqual(missed.filtered[0], null, "old range must not be projected at the new angle");
});

// --- The cursor is actually continuous ---------------------------------------

test("the drawn cursor is continuous, not one of nine hole centres", () => {
  const w = loadWindow();
  startSensorRound(w);

  // Walk straight across the board at a constant depth. Every node sees the
  // player throughout, so the cell is always resolvable.
  const depth = 80;
  const frames = drive(w, 200, (i) => {
    const x = 20 + (i / 199) * 110;
    return rangesTo(SENSOR_X, x, depth);
  });

  assert.ok(frames.length > 50, `only ${frames.length} frames had a cursor`);

  const xs = frames.map((f) => f.x);
  const distinct = new Set(xs.map((x) => Math.round(x * 10))).size;
  assert.ok(distinct > 100, `cursor took only ${distinct} distinct x values - it is snapping`);

  // And it must have covered the whole sweep, ending near where the player is.
  const last = frames[frames.length - 1];
  assert.ok(Math.abs(last.xCm - 130) < 2, `solved x ended at ${last.xCm}, expected ~130`);
  assert.ok(last.x > xs[0] + 200, "the cursor should have travelled right across the board");
});

test("every intermediate position is a real interpolation, not a jump to a hole", () => {
  const w = loadWindow();
  startSensorRound(w);

  const depth = 80;
  const frames = drive(w, 200, (i) => {
    const x = 20 + (i / 199) * 110;
    return rangesTo(SENSOR_X, x, depth);
  });

  // The solved x in centimetres should be monotonic across the walk. If the
  // solver were picking a column centre, this would step in 50 cm jumps.
  const xs = frames.map((f) => f.xCm);
  const steps = xs.slice(1).map((v, i) => v - xs[i]);
  const worst = Math.max(...steps.map(Math.abs));
  assert.ok(worst < 10, `a single step moved the solved position by ${worst} cm`);
});

test("the cursor never overshoots and is bounded by its speed ceiling", () => {
  const w = loadWindow();
  startSensorRound(w);

  // Teleport the target the width of the board between two frames. The cursor
  // must ease across rather than jump, and must never pass where it is headed.
  // The destination is the RIGHT column centre, not the middle of the board -
  // 125 cm maps to the third column.
  const destination = w.gridToCanvasPoint(CANVAS, 2, 1);
  const nodes = [1, 2, 3].map((id) => ({ id, online: true, latest: null }));
  let clock = 0;
  let previous = null;
  let worstStepPx = 0;

  for (let i = 0; i < 120; i += 1) {
    const x = i < 5 ? 25 : 125;
    const values = rangesTo(SENSOR_X, x, 80);
    nodes.forEach((node, slot) => {
      node.latest = JSON.stringify({ avg: values[slot] });
    });
    for (let s = 0; s < 3; s += 1) {
      clock += FRAME_MS;
      contextNow(w, clock);
      w.markSensorFrame();
      w.updateGame(clock, CANVAS, nodes);
      const cursor = w.getGameState().cursor;
      if (cursor.x === null) continue;
      if (previous !== null) {
        worstStepPx = Math.max(worstStepPx, Math.abs(cursor.x - previous));
        // A critically damped spring approaches from one side only, so passing
        // the destination would be a genuine overshoot.
        assert.ok(
          cursor.x <= destination.x + 0.5,
          `cursor overshot the destination at x=${destination.x}, to ${cursor.x}`
        );
      }
      previous = cursor.x;
    }
  }

  // 900 px/s at 16 ms is ~14 px per frame. Allow a little slack for the clamp
  // being applied per axis and per frame.
  assert.ok(worstStepPx < 30, `cursor moved ${worstStepPx}px in one frame`);
  assert.ok(
    Math.abs(previous - destination.x) < 0.5,
    `cursor should have settled on the destination, ended at ${previous} not ${destination.x}`
  );
});

test("a lone node still drives the cursor, at its column centre", () => {
  const w = loadWindow();
  startSensorRound(w);

  // Only the LEFT node hears the player, straight in front of it, and it sends
  // no servo angle - so it cannot tell "to the side" from "further away".
  const frames = drive(w, 60, () => [90, null, null]);

  assert.ok(frames.length > 10, "the cursor should still exist with one node");
  const last = frames[frames.length - 1];
  assert.strictEqual(last.resolved, false, "one node without an angle cannot triangulate");
  assert.ok(Math.abs(last.xCm - 25) < 0.5, `expected the left column, got ${last.xCm}`);
});

test("out-of-bounds readings produce no position, not a guessed one", () => {
  const w = loadWindow();
  startSensorRound(w);

  // Every node reports a wall far behind the board.
  const frames = drive(w, 40, () => [260, 300, 260]);

  assert.ok(frames.length === 0, `a wall should not produce a cursor, got ${frames.length}`);
  assert.strictEqual(w.getSensorDebug().status, "out-of-bounds");
});
