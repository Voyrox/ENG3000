// test_cursor_status.js
//
// getGameCursorStatus() is what the phone control panel (/control) is sent so
// it can mirror the game's cursor and, in sensor mode, show where the sensors
// put the player. These tests load the REAL browser modules headless in Node,
// as test_position_solver.js does, and check that:
//
//   1. in sensor mode the status carries the player's position in cm, the
//      sensor state and a board position whose hole is the one that scores
//   2. no signal means no board position and no (x, y), rather than a stale one
//   3. remote and mouse mode mirror their cursor but carry no sensor block
//   4. the sensor block carries every position method's fix, with its ring
//      on the board as Compare draws it, the method in use and Compare's
//      switch
//
// Run with:
//
//     node --test Website/tests/test_cursor_status.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const vm = require("vm");

const DISPLAYS = path.join(__dirname, "..", "public", "displays");
const MODULES = ["alert.js", "callibrate_corners.js", "positionSolver.js", "game.js"];

const CANVAS = { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 };
const FRAME_MS = 16;
const SENSOR_X = [25, 75, 125]; // the centre slot is never read: the rig has two nodes

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

// Steps the loop over the same readings for long enough that the median,
// slew gate and Kalman stages have settled and the cursor spring has stopped.
function run(w, nodes, frames = 240) {
  for (let i = 1; i <= frames; i += 1) {
    const t = i * FRAME_MS;
    w.performance.now = () => t;
    w.markSensorFrame();
    w.updateGame(t, CANVAS, nodes);
  }
}

function nodesSeeing(x, y) {
  return [0, 1, 2].map((slot) => ({
    id: slot + 1,
    online: true,
    latest: JSON.stringify({ avg: Math.hypot(x - SENSOR_X[slot], y) }),
  }));
}

// Scanner nodes, as the firmware reports: each one's distance to the player,
// its servo angle pointing at them (90 straight out, more towards screen-left)
// and its scan state (0 found).
function scannersSeeing(x, y) {
  return [0, 1, 2].map((slot) => ({
    id: slot + 1,
    online: true,
    latest: JSON.stringify({
      avg: Math.hypot(x - SENSOR_X[slot], y),
      angle: Math.round(90 + (Math.atan2(SENSOR_X[slot] - x, y) * 180) / Math.PI),
      scanState: 0,
    }),
  }));
}

function holeUnder(w, board) {
  const layout = w.getGameGridLayout(CANVAS);
  const x = layout.gridLeft + board.nx * layout.gridSize;
  const y = layout.gridTop + board.ny * layout.gridSize;
  const hole = layout.holes.find((h) => x >= h.x && x <= h.x + h.size && y >= h.y && y <= h.y + h.size);
  return hole ? hole.index : -1;
}

test("sensor mode reports the player's (x, y) in cm, and the hole under the drawn cursor", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  run(w, nodesSeeing(75, 80));

  const status = w.getGameCursorStatus(CANVAS);
  assert.ok(status.sensor, "sensor mode carries a sensor block");
  assert.strictEqual(status.sensor.status, "ok");
  assert.strictEqual(status.sensor.held, false);
  assert.strictEqual(status.sensor.source, "both", "both nodes see a player in the centre");
  assert.ok(Math.abs(status.sensor.xCm - 75) < 1, `x was ${status.sensor.xCm}`);
  assert.ok(Math.abs(status.sensor.yCm - 80) < 1, `y was ${status.sensor.yCm}`);

  // 80 cm deep is the middle of the middle row with the default 20-140 cm
  // span, so the cursor sits on the centre of hole 4.
  assert.strictEqual(status.sensor.gx, 1);
  assert.strictEqual(status.sensor.gy, 1);
  assert.ok(status.board, "a placed player has a board position");
  assert.ok(Math.abs(status.board.nx - 0.5) < 0.02, `nx was ${status.board.nx}`);
  assert.ok(Math.abs(status.board.ny - 0.5) < 0.02, `ny was ${status.board.ny}`);
  assert.strictEqual(status.hole, 4);
  assert.strictEqual(status.hole, holeUnder(w, status.board), "hole is the one under the board position");

  // It is sent as JSON, so nothing in it may be NaN or undefined.
  const sent = JSON.parse(JSON.stringify(status));
  assert.strictEqual(sent.sensor.xCm, status.sensor.xCm);
  assert.strictEqual(sent.sensor.yCm, status.sensor.yCm);
  assert.strictEqual(sent.board.ny, status.board.ny);
});

test("sensor mode follows the player off-centre, near row at the top of the board", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  // Near the screen, in front of the left node: the top-left hole.
  run(w, nodesSeeing(30, 35));

  const status = w.getGameCursorStatus(CANVAS);
  assert.strictEqual(status.sensor.status, "ok");
  assert.ok(Math.abs(status.sensor.xCm - 30) < 1.5, `x was ${status.sensor.xCm}`);
  assert.ok(Math.abs(status.sensor.yCm - 35) < 1.5, `y was ${status.sensor.yCm}`);
  assert.ok(status.board.nx < 0.34 && status.board.ny < 0.34, JSON.stringify(status.board));
  assert.strictEqual(status.hole, 0);
});

test("no signal: no board position and no (x, y)", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  const silent = [1, 2, 3].map((id) => ({ id, online: true, latest: JSON.stringify({ avg: -1 }) }));
  run(w, silent);

  const status = w.getGameCursorStatus(CANVAS);
  assert.strictEqual(status.sensor.status, "no-signal");
  assert.strictEqual(status.board, null);
  assert.strictEqual(status.hole, -1);
  assert.strictEqual(status.sensor.xCm, null);
  assert.strictEqual(status.sensor.yCm, null);
});

test("remote mode mirrors the finger's cursor and carries no sensor block", () => {
  const w = loadWindow();
  w.setGameInputMode("remote");
  w.resetGame();
  // Compared as JSON: objects made inside the vm context have its prototypes.
  assert.strictEqual(JSON.stringify(w.getGameCursorStatus(CANVAS)),
    JSON.stringify({ board: null, hole: -1, sensor: null }), "no finger, no cursor");

  w.setRemotePoint(0.15, 0.85);
  run(w, [], 30);
  const status = w.getGameCursorStatus(CANVAS);
  assert.strictEqual(status.sensor, null);
  assert.ok(Math.abs(status.board.nx - 0.15) < 1e-6, `nx was ${status.board.nx}`);
  assert.ok(Math.abs(status.board.ny - 0.85) < 1e-6, `ny was ${status.board.ny}`);
  assert.strictEqual(status.hole, 6, "bottom-left hole");
  assert.strictEqual(status.hole, w.getGameState().remoteHole, "agrees with the remote hole");
});

test("mouse mode mirrors the mouse cursor, and switching mode drops it", () => {
  const w = loadWindow();
  w.setGameInputMode("mouse");
  w.resetGame();
  const layout = w.getGameGridLayout(CANVAS);
  w.setGameCursor(CANVAS, layout.gridLeft + layout.gridSize / 2, layout.gridTop + layout.gridSize / 2);

  const status = w.getGameCursorStatus(CANVAS);
  assert.strictEqual(status.sensor, null);
  assert.ok(Math.abs(status.board.nx - 0.5) < 1e-9 && Math.abs(status.board.ny - 0.5) < 1e-9);
  assert.strictEqual(status.hole, 4);

  w.setGameInputMode("sensor");
  const after = w.getGameCursorStatus(CANVAS);
  assert.strictEqual(after.board, null, "a new mode never inherits the old cursor");
  assert.strictEqual(after.sensor.status, "no-signal");
});

test("every method's fix comes with its ring on the board, the method in use and Compare", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  run(w, scannersSeeing(75, 80));

  const sensor = w.getGameCursorStatus(CANVAS).sensor;
  assert.strictEqual(sensor.method, "los", "line of sight is the default");
  assert.strictEqual(sensor.compare, true, "Compare starts on");
  ["los", "tri", "avg"].forEach((method) => {
    const fix = sensor.fixes[method];
    assert.ok(fix, `${method} has a fix`);
    assert.ok(Math.hypot(fix.xCm - 75, fix.yCm - 80) < 3, `${method} at ${fix.xCm}, ${fix.yCm}`);
    // 80 cm deep in the centre column is the centre of the board.
    assert.ok(Math.abs(fix.nx - 0.5) < 0.03 && Math.abs(fix.ny - 0.5) < 0.03, `${method} ${fix.nx}, ${fix.ny}`);
  });
  // The cursor's own (x, y) is the method in use.
  assert.strictEqual(sensor.xCm, sensor.fixes.los.xCm);
  assert.strictEqual(sensor.yCm, sensor.fixes.los.yCm);

  // Switching method and turning Compare off both show up in the status.
  w.setPositionMethod("tri");
  w.applyPositionSwitch({ kind: "compare" });
  run(w, scannersSeeing(75, 80), 2);
  const after = w.getGameCursorStatus(CANVAS).sensor;
  assert.strictEqual(after.method, "tri");
  assert.strictEqual(after.compare, false);
  assert.strictEqual(after.xCm, after.fixes.tri.xCm);

  // Sent as JSON: no NaN or undefined anywhere in it.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(after.fixes)).avg, { ...after.fixes.avg });
});

test("a ring off the side of the board stays at the board's edge; no signal has no fixes", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  // 20 cm off the left edge of the board: the fix keeps the measured x, the
  // ring is drawn from x clamped to the board, as renderPositionMarkers() does.
  run(w, scannersSeeing(-20, 80));
  const fixes = w.getGameCursorStatus(CANVAS).sensor.fixes;
  assert.ok(fixes.los.xCm < -10, `x was ${fixes.los.xCm}`);
  assert.ok(fixes.los.nx > -0.05 && fixes.los.nx < 0.05, `nx was ${fixes.los.nx}`);

  const silent = loadWindow();
  silent.setGameInputMode("sensor");
  silent.resetGame();
  run(silent, [1, 2, 3].map((id) => ({ id, online: true, latest: JSON.stringify({ avg: -1 }) })));
  const none = silent.getGameCursorStatus(CANVAS).sensor.fixes;
  assert.strictEqual(JSON.stringify(none), JSON.stringify({ los: null, tri: null, avg: null }));
});
