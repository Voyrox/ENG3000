// generate_parity_trace.js
//
// Runs the REAL browser filtering code (alert.js, callibrate_corners.js and
// game.js) headless in Node, feeds it a deterministic stream of sensor
// readings, and records what it produces at every step. test_filterRules.py
// replays the same stream through filterRules.py and requires identical
// output, which is what makes the Python pipeline a port rather than a
// reimplementation.
//
// Regenerate after changing any filtering rule in the JS:
//
//     node Website/tests/generate_parity_trace.js
//
// Writes Website/tests/fixtures/js_parity_trace.json.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DISPLAYS = path.join(__dirname, "..", "public", "displays");
const OUT = path.join(__dirname, "fixtures", "js_parity_trace.json");

const STEP_MS = 20;          // one reading every 20 ms
const NO_ECHO = null;

// --- Deterministic noise ------------------------------------------------------

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

// --- The scenario ---------------------------------------------------------------
// Each segment exercises a different branch. Values are [left, centre, right];
// the rig has two sensors, so the centre is always NO_ECHO. A simulated player
// at (x, depth) cm is seen by a sensor only inside its beam; outside it the
// sensor sees the back wall.

const SENSOR_X_CM = [25, 125];                    // centres of the outer columns
const beamHalfWidthCm = (depth) => 15 + depth * 0.36;

function buildStream() {
  const rand = lcg(20260929);
  const jitter = (cm, spread) => round2(cm + (rand() * 2 - 1) * spread);
  const maybe = (value, dropRate) => (rand() < dropRate ? NO_ECHO : value);
  const wall = () => maybe(jitter(235, 6), 0.25);
  const sees = (sensorX, x, depth) =>
    Math.abs(x - sensorX) <= beamHalfWidthCm(depth) ? jitter(Math.hypot(x - sensorX, depth), 2) : wall();
  const steps = [];
  const push = (l, r) => steps.push([l, NO_ECHO, r]);
  const at = (x, depth) => push(sees(SENSOR_X_CM[0], x, depth), sees(SENSOR_X_CM[1], x, depth));

  // 1. Standing in the centre column, seen by both: trilaterated lock-on.
  for (let i = 0; i < 120; i++) at(75, 100);

  // 2. Same spot with spikes and dropouts on the left: slew gate and hold.
  for (let i = 0; i < 70; i++) {
    const roll = rand();
    const left = roll < 0.12 ? round2(190 + rand() * 20)
      : roll < 0.22 ? NO_ECHO : sees(SENSOR_X_CM[0], 75, 100);
    push(left, sees(SENSOR_X_CM[1], 75, 100));
  }

  // 3. Drift into the left column: the right sensor loses the player, and x
  //    crosses a column boundary (column hysteresis).
  for (let i = 0; i < 120; i++) at(75 - 50 * (i / 119), 100);

  // 4. Walk toward the screen in the left column: too-close on raw readings.
  for (let i = 0; i < 80; i++) push(jitter(60 - 57 * (i / 79), 1.5), wall());

  // 5. Back out.
  for (let i = 0; i < 40; i++) at(25, 90);

  // 6. Nobody there: exceed the hold budget.
  for (let i = 0; i < 130; i++) push(maybe(jitter(260, 5), 0.5), maybe(jitter(260, 5), 0.5));

  // 7. Reappear in the right column: relock after the anchor has expired.
  for (let i = 0; i < 90; i++) at(125, 120);

  // 8. Dither across a row boundary: band hysteresis.
  for (let i = 0; i < 100; i++) at(125, 100 + (rand() * 2 - 1) * 5);

  // 9. Walk from the right column into the centre, both sensors seeing the
  //    player for most of it: x crosses the right-hand column boundary.
  for (let i = 0; i < 120; i++) at(125 - 50 * (i / 119), 110);

  // 10. Intermittent fault, good and bad alternating: the streak policy's
  //     known blind spot, recorded so the Python port reproduces it exactly.
  for (let i = 0; i < 140; i++) push(wall(), i % 2 ? jitter(118, 2) : NO_ECHO);

  // From here the nodes are servo scanners: each entry is [distance, angle],
  // the angle the node's servo was at (90 = straight out, more = screen-left),
  // in whole degrees as the firmware sends it.
  const aimAt = (nodeX, x, depth) => Math.round(90 + (Math.atan2(nodeX - x, depth) * 180) / Math.PI);
  const scanned = (nodeX, x, depth) => [jitter(Math.hypot(x - nodeX, depth), 2), aimAt(nodeX, x, depth)];

  // 11. Both scanners track a player walking diagonally across the board.
  for (let i = 0; i < 150; i++) {
    const x = 40 + 70 * (i / 149);
    const depth = 60 + 60 * (i / 149);
    push(scanned(SENSOR_X_CM[0], x, depth), scanned(SENSOR_X_CM[1], x, depth));
  }

  // 12. The left scanner loses the player and sweeps (no echo); the right one
  //     keeps tracking them in the centre column.
  for (let i = 0; i < 90; i++) {
    const sweep = 40 + ((i * 15) % 120);
    push([NO_ECHO, sweep], scanned(SENSOR_X_CM[1], 80, 95));
  }

  return steps;
}

// --- Run the real JS -----------------------------------------------------------

function runJs(stream, calibration) {
  let clock = 0;
  const context = {
    console,
    performance: { now: () => clock },
    Image: class { set src(_) {} },
  };
  context.window = context;
  vm.createContext(context);

  for (const file of ["alert.js", "callibrate_corners.js", "positionSolver.js", "game.js"]) {
    vm.runInContext(fs.readFileSync(path.join(DISPLAYS, file), "utf8"), context,
      { filename: file });
  }
  const w = context;

  // What the JS ended up calibrated with, per column [near, far]: the two sensor
  // columns as captured, the centre (no sensor) derived from them. The Python
  // side is built from this, so both calibrate identically.
  let effective = null;
  if (calibration) {
    // Two sensors, LEFT and RIGHT: capture order is BL, BR, TR, TL; each reads
    // filtered[column]. The centre column has no sensor and is not captured.
    const order = [[0, "near"], [2, "near"], [2, "far"], [0, "far"]];
    for (const [column, edge] of order) {
      const filtered = [null, null, null];
      filtered[column] = calibration[column][edge === "near" ? 0 : 1];
      if (!w.captureCorner({ filtered })) throw new Error(`capture failed ${column} ${edge}`);
    }
    const bounds = w.getCalibrationBounds();
    if (!bounds.calibrated) throw new Error("calibration did not take");
    effective = bounds.perColumn.map((col) => [col.near, col.far]);
  }

  w.setGameInputMode("sensor");
  w.resetGame();
  const canvas = { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 };
  const node = (id) => ({ id, online: true, latest: null });
  // [left, centre, right] as the game receives them: no centre sensor.
  const nodes = [node(1), null, node(3)];

  const out = [];
  stream.forEach((reading, i) => {
    clock = (i + 1) * STEP_MS;
    reading.forEach((value, s) => {
      if (!nodes[s]) return;
      // A scanner entry is [distance, angle]; a plain number has no angle.
      const [distance, angle] = Array.isArray(value) ? value : [value, undefined];
      const payload = { avg: distance === NO_ECHO ? -1 : distance };
      if (angle !== undefined) payload.angle = angle;
      nodes[s].latest = JSON.stringify(payload);
    });
    w.markSensorFrame();
    w.updateGame(clock, canvas, nodes);
    const s = w.getGameState().sensor;
    // Positional, in the order of FIELDS, to keep the fixture small.
    out.push([
      s.status,
      s.gx ?? null,
      s.gy ?? null,
      s.rawGx ?? null,
      s.rawGy ?? null,
      s.column ?? null,
      s.held ? 1 : 0,
      s.heldFor ?? 0,
      s.filtered || [null, null, null],
    ]);
  });
  return { calibration: effective, steps: out };
}

const FIELDS = ["status", "gx", "gy", "rawGx", "rawGy", "column", "held", "heldFor", "filtered"];

const stream = buildStream();
// [near, far] per column; the centre entry is ignored (no centre sensor to capture it).
const calibrated = [[28.47, 140.68], [20.44, 138.26], [10.89, 145.81]];

const trace = {
  generatedBy: "Website/tests/generate_parity_trace.js",
  stepMs: STEP_MS,
  fields: FIELDS,
  stream,
  runs: {
    default: runJs(stream, null),
    calibrated: runJs(stream, calibrated),
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(trace));

for (const [name, run] of Object.entries(trace.runs)) {
  const tally = {};
  run.steps.forEach((s) => {
    const key = s[0] + (s[6] ? " (held)" : "");
    tally[key] = (tally[key] || 0) + 1;
  });
  console.log(`${name}: ${run.steps.length} steps`, tally);
}
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${fs.statSync(OUT).size} bytes)`);
