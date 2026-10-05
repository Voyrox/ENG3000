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
// A node that sends nothing this step - the other node's scanning turn. Its
// last reading stays as it was, and is not new.
const SILENT = "silent";

// --- Deterministic noise ------------------------------------------------------

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// --- The scenario ---------------------------------------------------------------
// Each segment exercises a different branch. Values are [left, centre, right];
// the rig has two sensors, so the centre is always NO_ECHO. A simulated player
// at (x, depth) cm is seen by a sensor only inside its beam; outside it the
// sensor sees the back wall. The player is a body: a sensor's echo comes off
// the side of them nearest it, BODY_RADIUS_CM short of their middle (the
// game's tuning.bodyRadiusCm adds it back).

const SENSOR_X_CM = [25, 125];                    // centres of the outer columns
const BODY_RADIUS_CM = 15;
const beamHalfWidthCm = (depth) => 15 + depth * 0.36;
const echoCm = (sensorX, x, depth) => Math.hypot(x - sensorX, depth) - BODY_RADIUS_CM;

function buildStream() {
  const rand = lcg(20260929);
  const jitter = (cm, spread) => round2(cm + (rand() * 2 - 1) * spread);
  const maybe = (value, dropRate) => (rand() < dropRate ? NO_ECHO : value);
  const wall = () => maybe(jitter(235, 6), 0.25);
  const sees = (sensorX, x, depth) =>
    Math.abs(x - sensorX) <= beamHalfWidthCm(depth) ? jitter(echoCm(sensorX, x, depth), 2) : wall();
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

  // From here the nodes are servo scanners: each entry is [distance, angle,
  // scanState], the angle the node's servo was at (90 = straight out, more =
  // screen-right) in whole degrees as the firmware sends it, and the scan state
  // (0 found, 1 half-found, 2 lost and sweeping).
  const aimAt = (nodeX, x, depth) => Math.round(90 + (Math.atan2(x - nodeX, depth) * 180) / Math.PI);
  const scanned = (nodeX, x, depth, state = 0) =>
    [jitter(echoCm(nodeX, x, depth), 2), aimAt(nodeX, x, depth), state];

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
    push([NO_ECHO, sweep, 2], scanned(SENSOR_X_CM[1], 80, 95));
  }

  // 13. Turns: the nodes scan one at a time, 500 ms each, while the player
  //     walks. The silent node's last reading is repeated but is not new, and
  //     each node comes back for its turn after a silence longer than the hold.
  //     Its servo re-aims for the first three readings (half-found), then
  //     holds still on 3-degree steps (found), so the line of sight takes the
  //     distance alone while the angle repeats.
  for (let i = 0; i < 200; i++) {
    const x = 40 + 70 * (i / 199);
    const depth = 60 + 50 * (i / 199);
    const leftTurn = Math.floor(i / 25) % 2 === 0;
    const intoTurn = i % 25;
    const reading = (nodeX) => {
      const [distance, angle] = scanned(nodeX, x, depth);
      return intoTurn < 3 ? [distance, angle + 6, 1] : [distance, Math.round(angle / 3) * 3, 0];
    };
    steps.push(leftTurn ? [reading(SENSOR_X_CM[0]), NO_ECHO, SILENT]
      : [SILENT, NO_ECHO, reading(SENSOR_X_CM[1])]);
  }

  // 14. The left scanner is lost and sweeping, but its beam finds furniture
  //     inside the play area (120 cm): line of sight leaves it out, while
  //     trilateration takes the distance as the player's.
  for (let i = 0; i < 60; i++) {
    const sweep = 40 + ((i * 15) % 120);
    push([jitter(120, 2), sweep, 2], scanned(SENSOR_X_CM[1], 80, 95));
  }

  // 15. The player turns up somewhere else at once, seen by both: the gates
  //     turn the readings away, then give way to them.
  for (let i = 0; i < 40; i++) {
    push(scanned(SENSOR_X_CM[0], 120, 60), scanned(SENSOR_X_CM[1], 120, 60));
  }

  // 16. Both scanners lose the player for 3 s: the cursor rides it out until
  //     each one's last tuning.lostReadings readings add up to 0 or less
  //     (found +1, half 0, lost -1), then out of bounds at once, with no hold
  //     - the only out of bounds there is - and on while, for the second half,
  //     the left one half-finds furniture (one head hears it), which is not
  //     the player. Then both find the player again.
  for (let i = 0; i < 40; i++) push(scanned(SENSOR_X_CM[0], 70, 90), scanned(SENSOR_X_CM[1], 70, 90));
  for (let i = 0; i < 150; i++) {
    const sweep = 40 + ((i * 15) % 120);
    push(i < 75 ? [NO_ECHO, sweep, 2] : [jitter(120, 2), 70, 1], [NO_ECHO, 180 - sweep, 2]);
  }
  for (let i = 0; i < 40; i++) push(scanned(SENSOR_X_CM[0], 70, 90), scanned(SENSOR_X_CM[1], 70, 90));

  // 17. The player steps off the right side of the board and stays there,
  //     both scanners finding them: the cursor stays on the edge square, and
  //     never out of bounds, since the nodes are finding them. Then they step
  //     back on.
  for (let i = 0; i < 140; i++) push(scanned(SENSOR_X_CM[0], 175, 80), scanned(SENSOR_X_CM[1], 175, 80));
  for (let i = 0; i < 40; i++) push(scanned(SENSOR_X_CM[0], 110, 80), scanned(SENSOR_X_CM[1], 110, 80));

  // 18. The left scanner finds the player in play while the right one has
  //     locked on to something past the right edge: never out of bounds.
  for (let i = 0; i < 140; i++) push(scanned(SENSOR_X_CM[0], 60, 90), scanned(SENSOR_X_CM[1], 190, 60));

  // 19. As on the rig on 5 Oct: the nodes take 500 ms turns and are mostly
  //     lost, with the odd found (a stray echo) or half reading - one in ten
  //     of each. Out of bounds once each one's last tuning.lostReadings
  //     readings add up to 0 or less, however the odd found falls. Then both
  //     find the player again, and it clears.
  for (let i = 0; i < 200; i++) {
    const k = i % 10;
    const sweep = 40 + ((i * 15) % 120);
    const reading = (nodeX) =>
      k === 3 ? scanned(nodeX, 75, 80) : k === 7 ? [jitter(120, 2), sweep, 1] : [NO_ECHO, sweep, 2];
    const leftTurn = Math.floor(i / 25) % 2 === 0;
    push(leftTurn ? reading(SENSOR_X_CM[0]) : SILENT, leftTurn ? SILENT : reading(SENSOR_X_CM[1]));
  }
  for (let i = 0; i < 60; i++) push(scanned(SENSOR_X_CM[0], 75, 80), scanned(SENSOR_X_CM[1], 75, 80));

  // 20. A lone confident node (Dynamic's second rule): the left node finds the
  //     player straight in front of it, while the right one half-finds
  //     furniture in the right column. The two servo lines cross in the left
  //     column, so the centre rule stays out of it, and the left node alone
  //     places the player (line of sight, which takes the furniture too, is
  //     pulled towards the centre).
  for (let i = 0; i < 60; i++) push(scanned(SENSOR_X_CM[0], 25, 85), [jitter(150, 2), 60, 1]);

  // 21. The centre rule (Dynamic's first): a player in the centre, 80 cm out,
  //     with both servos turned some 10-20 degrees further in than the
  //     player's middle, the angles the rig read at that spot on 4 Oct (141
  //     and 49; its servo stops where the beam first finds the body). The two
  //     servo lines cross in the centre column, at 84 cm across.
  for (let i = 0; i < 60; i++) {
    push([jitter(echoCm(SENSOR_X_CM[0], 75, 80), 2), 141, 0], [jitter(echoCm(SENSOR_X_CM[1], 75, 80), 2), 49, 0]);
  }

  // 22. The centre hold: the player stays where they were, but the servo
  //     lines stray to cross at 110 cm, in the right column, for 2 s. The
  //     player stays in the centre column for tuning.centreHoldMs (1 s), then
  //     the hold lets go.
  for (let i = 0; i < 100; i++) {
    push([jitter(echoCm(SENSOR_X_CM[0], 75, 80), 2), aimAt(SENSOR_X_CM[0], 110, 80), 0],
      [jitter(echoCm(SENSOR_X_CM[1], 75, 80), 2), aimAt(SENSOR_X_CM[1], 110, 80), 0]);
  }

  // 23. A lone node outside the play area: the left node, turned fully in,
  //     finds something 27 cm away (its own point 14 cm out, in front of the
  //     near edge), as on the rig on 5 Oct, while the right one half-finds
  //     furniture. It is not the player, so it does not place them alone.
  for (let i = 0; i < 60; i++) push([jitter(27, 1), 160, 0], [jitter(150, 2), 60, 1]);

  // 24. The side lock: both scanners find the player deep in the left column
  //     (15 cm across), where the servo lines cross more than
  //     tuning.sideLockDepthCm inside it; then deep in the right column; then
  //     near the left-hand column boundary (40 cm), where there is no lock.
  for (let i = 0; i < 50; i++) push(scanned(SENSOR_X_CM[0], 15, 80), scanned(SENSOR_X_CM[1], 15, 80));
  for (let i = 0; i < 50; i++) push(scanned(SENSOR_X_CM[0], 135, 80), scanned(SENSOR_X_CM[1], 135, 80));
  for (let i = 0; i < 50; i++) push(scanned(SENSOR_X_CM[0], 40, 80), scanned(SENSOR_X_CM[1], 40, 80));

  // 25. The far corners: the left scanner finds the player in A1 (the far-left
  //     square) while the right one is acting up - it finds something in the
  //     centre, near the screen - so the left node alone places the player.
  //     Then the same in A3 with the left scanner acting up.
  for (let i = 0; i < 50; i++) push(scanned(SENSOR_X_CM[0], 25, 125), scanned(SENSOR_X_CM[1], 75, 50));
  for (let i = 0; i < 50; i++) push(scanned(SENSOR_X_CM[0], 75, 50), scanned(SENSOR_X_CM[1], 125, 125));

  return steps;
}

// --- Run the real JS -----------------------------------------------------------

function runJs(stream, calibration, method, kalman = true, dynamicRules = null) {
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

  w.setPositionMethod(method);
  w.setKalman(kalman);
  if (dynamicRules) w.setDynamicRules(dynamicRules);
  w.setGameInputMode("sensor");
  w.resetGame();
  const canvas = { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 };
  const node = (id) => ({ id, online: true, latest: null });
  // [left, centre, right] as the game receives them: no centre sensor.
  const nodes = [node(1), null, node(3)];

  const out = [];
  // The method that placed the player at each step: the run's own, or the one
  // Dynamic followed.
  const placedBy = [];
  let stamp = 0;
  stream.forEach((reading, i) => {
    clock = (i + 1) * STEP_MS;
    reading.forEach((value, s) => {
      if (!nodes[s] || value === SILENT) return;
      // A scanner entry is [distance, angle, scanState]; a plain number has
      // neither. Each message gets a new server stamp, as last_seen does.
      const [distance, angle, state] = Array.isArray(value) ? value : [value, undefined, undefined];
      const payload = { avg: distance === NO_ECHO ? -1 : distance };
      if (angle !== undefined) payload.angle = angle;
      if (state !== undefined) payload.scanState = state;
      nodes[s].latest = JSON.stringify(payload);
      stamp += 1;
      nodes[s].last_seen = stamp;
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
      (s.fresh || [true, true, true]).map((f) => (f ? 1 : 0)),
      s.status === "ok" ? round6(s.xCm) : null,
      s.status === "ok" ? round6(s.yCm) : null,
    ]);
    placedBy.push(s.placedBy ?? null);
  });
  return { calibration: effective, steps: out, placedBy };
}

const FIELDS = ["status", "gx", "gy", "rawGx", "rawGy", "column", "held", "heldFor", "filtered",
  "fresh", "x", "y"];

const stream = buildStream();
const RULES_OFF = { columnLock: false, loneNode: false, cornerNode: false };
// [near, far] per column; the centre entry is ignored (no centre sensor to capture it).
const calibrated = [[28.47, 140.68], [20.44, 138.26], [10.89, 145.81]];

const trace = {
  generatedBy: "Website/tests/generate_parity_trace.js",
  stepMs: STEP_MS,
  fields: FIELDS,
  stream,
  // One run per position method (the game's switch), on the default bounds,
  // plus line of sight and Dynamic on calibrated bounds, and both with the
  // Kalman switch off.
  runs: {
    default: { method: "los", ...runJs(stream, null, "los") },
    calibrated: { method: "los", ...runJs(stream, calibrated, "los") },
    trilateration: { method: "tri", ...runJs(stream, null, "tri") },
    average: { method: "avg", ...runJs(stream, null, "avg") },
    dynamic: { method: "dyn", ...runJs(stream, null, "dyn") },
    dynamicCalibrated: { method: "dyn", ...runJs(stream, calibrated, "dyn") },
    kalmanOff: { method: "los", kalman: false, ...runJs(stream, null, "los", false) },
    kalmanOffDynamic: { method: "dyn", kalman: false, ...runJs(stream, null, "dyn", false) },
    // Dynamic with all three of its rules switched off: the steadiest method only.
    dynamicRulesOff: { method: "dyn", dynamicRules: RULES_OFF, ...runJs(stream, null, "dyn", true, RULES_OFF) },
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
