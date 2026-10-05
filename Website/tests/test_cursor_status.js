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
//   3. mouse mode mirrors its cursor but carries no sensor block
//   4. the phone pad overrides either mode's cursor and nothing else: the
//      sensors carry on underneath (their own cursor, the sensor panel), but
//      cannot hold the round or put up an overlay, and lifting the finger
//      hands the cursor straight back
//   5. the sensor block carries every position method's fix, with its ring
//      on the control panel's pad, the method in use and Compare's switch;
//      the game board itself draws no switch and no rings
//   6. Dynamic's rules: servo lines crossing in the centre column put the
//      player there, and a lone confident node places them by itself, as
//      placedBy and the control panel's Dynamic button say
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

// The player is a body: a node's echo comes off the side of them nearest it,
// the game's tuning.bodyRadiusCm short of their middle, which (x, y) is.
const BODY_RADIUS_CM = loadWindow().tuneSensor({}).bodyRadiusCm;
const echoCm = (slot, x, y) => Math.hypot(x - SENSOR_X[slot], y) - BODY_RADIUS_CM;

function nodesSeeing(x, y) {
  return [0, 1, 2].map((slot) => ({
    id: slot + 1,
    online: true,
    latest: JSON.stringify({ avg: echoCm(slot, x, y) }),
  }));
}

// Scanner nodes, as the firmware reports: each one's distance to the player,
// its servo angle pointing at them (90 straight out, more towards
// screen-right) and its scan state (0 found).
function scannersSeeing(x, y) {
  return [0, 1, 2].map((slot) => ({
    id: slot + 1,
    online: true,
    latest: JSON.stringify({
      avg: echoCm(slot, x, y),
      angle: Math.round(90 + (Math.atan2(x - SENSOR_X[slot], y) * 180) / Math.PI),
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

// Draws the game screen into a canvas that only records the text drawn on it.
function textsDrawn(w) {
  const texts = [];
  const handler = {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "fillText") return (text) => texts.push(String(text));
      if (prop === "measureText") return (text) => ({ width: String(text).length * 7 });
      return () => new Proxy({}, handler);
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  };
  w.renderGame(new Proxy({}, handler), CANVAS);
  return texts;
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

test("the phone pad takes the cursor from the sensors; they carry on underneath, and get it straight back", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  run(w, scannersSeeing(75, 80));
  const before = w.getGameCursorStatus(CANVAS);
  assert.strictEqual(before.remote, false);
  assert.strictEqual(before.hole, 4);
  assert.strictEqual(JSON.stringify(before.sensor.board), JSON.stringify(before.board), "the sensors' cursor is the drawn one");

  // A mole up under the sensors' cursor, which the sensors would score.
  const state = w.getGameState();
  Object.assign(state, { activeHole: 4, moleType: "mole", moleSpawnedAt: 0 });

  w.setRemotePoint(0.15, 0.85);
  run(w, scannersSeeing(75, 80), 30);
  const status = w.getGameCursorStatus(CANVAS);
  assert.strictEqual(w.getGameInputMode(), "sensor", "the pad is not a mode");
  assert.strictEqual(status.remote, true);
  assert.ok(Math.abs(status.board.nx - 0.15) < 1e-6, `nx was ${status.board.nx}`);
  assert.ok(Math.abs(status.board.ny - 0.85) < 1e-6, `ny was ${status.board.ny}`);
  assert.strictEqual(status.hole, 6, "bottom-left hole");
  assert.strictEqual(status.hole, state.remoteHole, "agrees with the remote hole");
  assert.strictEqual(state.score, 0, "only the pad's cursor scores");
  assert.strictEqual(state.activeHole, 4);

  // The sensors still place the player, on their own cursor, and the sensor
  // panel stays up.
  assert.strictEqual(status.sensor.status, "ok");
  assert.ok(Math.hypot(status.sensor.xCm - 75, status.sensor.yCm - 80) < 3, `(${status.sensor.xCm}, ${status.sensor.yCm})`);
  assert.ok(Math.abs(status.sensor.board.nx - 0.5) < 0.03 && Math.abs(status.sensor.board.ny - 0.5) < 0.03,
    JSON.stringify(status.sensor.board));
  assert.ok(textsDrawn(w).includes("NODE"), "the sensor panel is drawn");

  w.releaseRemotePoint();
  const after = w.getGameCursorStatus(CANVAS);
  assert.strictEqual(after.remote, false);
  assert.strictEqual(after.hole, 4, "the sensors' cursor, without waiting for a frame");
  run(w, scannersSeeing(75, 80), 2);
  assert.strictEqual(state.score, 1, "and the sensors score again");
});

test("while the pad has the cursor the sensors cannot hold the round or put up an overlay", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  const offline = [1, 2, 3].map((id) => ({ id, online: false, latest: null }));
  // One clock across every step (run() starts its own again at 0), so the
  // round clock only ever moves forward.
  let t = 0;
  const step = (frames) => {
    for (let i = 0; i < frames; i += 1) {
      t += FRAME_MS;
      w.performance.now = () => t;
      w.markSensorFrame();
      w.updateGame(t, CANVAS, offline);
    }
  };
  step(30);
  const state = w.getGameState();
  const held = state.remainingMs;
  step(30);
  assert.strictEqual(state.remainingMs, held, "Sensors offline holds the round");
  assert.ok(textsDrawn(w).includes("Sensors offline"));

  w.setRemotePoint(0.5, 0.5);
  step(30);
  assert.strictEqual(state.remainingMs, held - 30 * FRAME_MS, "the round runs while the phone places the player");
  assert.strictEqual(state.sensor.status, "offline", "the sensors still say so");
  assert.ok(!textsDrawn(w).includes("Sensors offline"), "but the overlay is not drawn");
  assert.ok(textsDrawn(w).includes("OFFLINE"), "the sensor panel shows it instead");
  assert.strictEqual(w.isGameAlertActive(), false);

  w.releaseRemotePoint();
  assert.ok(textsDrawn(w).includes("Sensors offline"));
});

test("the pad over a mouse round hands the mouse's cursor back, and the old Remote mode is the sensors", () => {
  const w = loadWindow();
  w.setGameInputMode("mouse");
  w.resetGame();
  const layout = w.getGameGridLayout(CANVAS);
  w.setGameCursor(CANVAS, layout.gridLeft + layout.gridSize / 2, layout.gridTop + layout.gridSize / 2);

  w.setRemotePoint(0.15, 0.85);
  run(w, [], 30);
  // The mouse moving while the finger is down is remembered, not drawn.
  w.setGameCursor(CANVAS, layout.gridLeft + 1, layout.gridTop + 1);
  const status = w.getGameCursorStatus(CANVAS);
  assert.strictEqual(status.remote, true);
  assert.strictEqual(status.sensor, null);
  assert.strictEqual(status.hole, 6);

  w.releaseRemotePoint();
  assert.strictEqual(w.getGameInputMode(), "mouse", "lifting the finger never switches mode");
  assert.strictEqual(w.getGameCursorStatus(CANVAS).hole, 0, "the mouse where it was left");

  // A /control page from before the pad became an override still asks for "remote".
  w.setGameInputMode("remote");
  assert.strictEqual(w.getGameInputMode(), "sensor");
  assert.strictEqual(w.getGameCursorStatus(CANVAS).remote, false);
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

test("every method's fix comes with its ring on the pad, the method in use and Compare", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  run(w, scannersSeeing(75, 80));

  const sensor = w.getGameCursorStatus(CANVAS).sensor;
  assert.strictEqual(sensor.method, "dyn", "Dynamic is the default");
  // Both servos point at a player in the centre column: Dynamic's centre rule.
  assert.strictEqual(sensor.placedBy, "centre", `Dynamic follows ${sensor.placedBy}`);
  assert.strictEqual(sensor.compare, true, "Compare starts on");
  ["dyn", "los", "tri", "avg"].forEach((method) => {
    const fix = sensor.fixes[method];
    assert.ok(fix, `${method} has a fix`);
    assert.ok(Math.hypot(fix.xCm - 75, fix.yCm - 80) < 3, `${method} at ${fix.xCm}, ${fix.yCm}`);
    // 80 cm deep in the centre column is the centre of the board.
    assert.ok(Math.abs(fix.nx - 0.5) < 0.03 && Math.abs(fix.ny - 0.5) < 0.03, `${method} ${fix.nx}, ${fix.ny}`);
  });
  // The cursor's own (x, y) is Dynamic's.
  assert.strictEqual(sensor.xCm, sensor.fixes.dyn.xCm);
  assert.strictEqual(sensor.yCm, sensor.fixes.dyn.yCm);

  // Switching method and turning Compare off both show up in the status.
  w.setPositionMethod("tri");
  assert.strictEqual(w.setPositionCompare(false), false);
  assert.strictEqual(w.getPositionCompare(), false);
  run(w, scannersSeeing(75, 80), 2);
  const after = w.getGameCursorStatus(CANVAS).sensor;
  assert.strictEqual(after.method, "tri");
  assert.strictEqual(after.placedBy, "tri");
  assert.strictEqual(after.compare, false);
  assert.strictEqual(after.xCm, after.fixes.tri.xCm);

  // Sent as JSON: no NaN or undefined anywhere in it.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(after.fixes)).avg, { ...after.fixes.avg });
});

test("both nodes mostly lost: Out of bounds, despite the odd found or half reading", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  // Of every ten readings, one found (the player) and one half (furniture).
  let k = 0;
  const mostlyLost = () => {
    k += 1;
    const state = k % 10 === 3 ? 0 : k % 10 === 7 ? 1 : 2;
    return [0, 1, 2].map((slot) => ({
      id: slot + 1,
      online: true,
      latest: JSON.stringify(state === 0 ? JSON.parse(scannersSeeing(75, 80)[slot].latest)
        : { avg: state === 1 ? 120 : -1, angle: slot === 0 ? 60 : 120, scanState: state }),
    }));
  };
  let t = 0;
  const step = (nodesFor, ms) => {
    for (const end = t + ms; t < end;) {
      t += FRAME_MS;
      w.performance.now = () => t;
      w.markSensorFrame();
      w.updateGame(t, CANVAS, nodesFor());
    }
    return w.getGameState().sensor;
  };
  assert.strictEqual(step(() => scannersSeeing(75, 80), 2000).status, "ok");
  // One new reading per frame: the found ones still outweigh the rest.
  assert.strictEqual(step(mostlyLost, 2 * FRAME_MS).status, "ok", "not at once");
  const gone = step(mostlyLost, 300);
  assert.strictEqual(gone.status, "out-of-bounds");
  assert.strictEqual(gone.nobodyFound, true);
  assert.strictEqual(gone.held, false, "not ridden out on the last square");
  assert.strictEqual(w.getGameCursorStatus(CANVAS).board, null);
  assert.strictEqual(step(mostlyLost, 1000).status, "out-of-bounds", "the odd found does not stop it");
  assert.strictEqual(step(() => scannersSeeing(75, 80), 300).status, "ok",
    "back once the nodes mostly find the player");
});

test("the lost readings are set from the control panel, and each node's score is shown", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  assert.strictEqual(w.getLostReadings(), 8, "the default");
  assert.strictEqual(w.setLostReadings(5), 5);
  assert.strictEqual(w.setLostReadings(0), 1, "at least one");
  assert.strictEqual(w.setLostReadings(99), 50, "at most fifty");
  assert.strictEqual(w.setLostReadings("many"), 50, "not a number: unchanged");
  w.setLostReadings(4);
  assert.strictEqual(JSON.stringify(w.getLostScores()),
    JSON.stringify([{ score: null, readings: 0 }, { score: null, readings: 0 }]));
  run(w, scannersSeeing(75, 80), 10);
  assert.strictEqual(JSON.stringify(w.getLostScores()),
    JSON.stringify([{ score: 4, readings: 4 }, { score: 4, readings: 4 }]));
});

test("off the side of the board, found: the edge square, never Out of bounds", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  const nodes = scannersSeeing(-30, 80);
  let t = 0;
  const until = (end) => {
    while (t < end) {
      t += FRAME_MS;
      w.performance.now = () => t;
      w.markSensorFrame();
      w.updateGame(t, CANVAS, nodes);
    }
  };
  // Both nodes find the player, off the left side: kept on the edge square.
  until(1700);
  const status = w.getGameCursorStatus(CANVAS);
  assert.strictEqual(status.sensor.status, "ok");
  assert.strictEqual(status.sensor.xCm, 5, "a tenth of a column inside the left edge");
  // 80 cm deep is the middle row: the hole under the cursor is the middle-left one.
  assert.strictEqual(status.hole, 3);
  assert.strictEqual(w.getGameState().sensor.offBoard, true);
  // The nodes are finding the player: never out of bounds, however long.
  until(6000);
  assert.strictEqual(w.getGameState().sensor.status, "ok");
});

test("Sensors offline when neither node sends anything, never Out of bounds", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  const offlineMs = w.tuneSensor({}).offlineMs;
  let t = 0;
  let stamp = 0;
  // Live nodes: each frame a new server stamp. Frozen: the same stamp again.
  const step = (nodes, ms, live) => {
    for (const end = t + ms; t < end;) {
      t += FRAME_MS;
      if (live) {
        stamp += 1;
        nodes.forEach((node) => { node.last_seen = stamp; });
      }
      w.performance.now = () => t;
      w.markSensorFrame();
      w.updateGame(t, CANVAS, nodes);
    }
    return w.getGameState().sensor;
  };
  const nodes = scannersSeeing(75, 80);
  assert.strictEqual(step(nodes, 1000, true).status, "ok");
  // Quiet for less than offlineMs: the last square is ridden out.
  const quiet = step(nodes, offlineMs - 100, false);
  assert.strictEqual(quiet.status, "ok");
  assert.strictEqual(step(nodes, 200, false).status, "offline");
  assert.strictEqual(step(nodes, 500, true).status, "ok", "back as soon as they send again");
  // The server marking both nodes offline says so at once.
  nodes.forEach((node) => { node.online = false; });
  assert.strictEqual(step(nodes, FRAME_MS, false).status, "offline");
});

test("a long run of unusable readings is ridden out on the last square", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  run(w, scannersSeeing(75, 80));
  // No echo, and no scan state to say the nodes have lost the player: 20 s.
  const silent = [1, 2, 3].map((id) => ({ id, online: true, latest: JSON.stringify({ avg: -1 }) }));
  for (let i = 1; i <= 1250; i += 1) {
    const t = 240 * FRAME_MS + i * FRAME_MS;
    w.performance.now = () => t;
    w.markSensorFrame();
    w.updateGame(t, CANVAS, silent);
  }
  const sensor = w.getGameState().sensor;
  assert.strictEqual(sensor.status, "ok");
  assert.strictEqual(sensor.held, true);
  assert.strictEqual(sensor.gx, 1);
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
  assert.strictEqual(JSON.stringify(none), JSON.stringify({ dyn: null, los: null, tri: null, avg: null }));
});

test("the game board draws one cursor: no position switch and no rings", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  run(w, scannersSeeing(75, 80));
  assert.strictEqual(w.getGameCursorStatus(CANVAS).sensor.compare, true, "Compare is on");
  const texts = textsDrawn(w);
  ["Dynamic", "DYN MID", "LOS", "TRI", "AVG", "Compare"].forEach((label) => {
    assert.ok(!texts.includes(label), `${label} is not drawn on the board`);
  });
  assert.strictEqual(w.getPositionSwitchAtPoint, undefined, "nothing on the board switches the method");
  // The sensor panel still lists every method's position.
  assert.ok(texts.some((t) => t.startsWith("LOS ")), JSON.stringify(texts));
});

test("the switch offers Dynamic first, and picking another method turns it off", () => {
  const w = loadWindow();
  assert.strictEqual(JSON.stringify(w.getPositionMethods().map((m) => m.id)), JSON.stringify(["dyn", "los", "tri", "avg"]));
  assert.strictEqual(w.getPositionMethod(), "dyn");
  assert.strictEqual(w.setPositionMethod("los"), "los");
  assert.strictEqual(w.setPositionMethod("dyn"), "dyn");
  assert.strictEqual(w.setPositionMethod("steady"), "dyn", "an unknown method is ignored");
});

test("the Kalman switch is on until the control panel turns it off", () => {
  const w = loadWindow();
  assert.strictEqual(w.getKalman(), true);
  assert.strictEqual(w.setKalman(false), false);
  assert.strictEqual(w.tuneSensor({}).kalman, false, "the filters read it from tuning");
  assert.strictEqual(w.setKalman(true), true);
});

// --- Dynamic's rules (Aaron, 5 Oct) ----------------------------------------------
// Nodes as the firmware reports them: [left, right], each { avg, angle, scanState }.
function scanners(left, right) {
  return [left, { avg: -1 }, right].map((reading, slot) => ({
    id: slot + 1,
    online: true,
    latest: JSON.stringify(reading),
  }));
}
const aimAt = (slot, x, y) => Math.round(90 + (Math.atan2(x - SENSOR_X[slot], y) * 180) / Math.PI);
const FURNITURE = { avg: 150, angle: 60, scanState: 1 };   // the right node half-finding something


test("Dynamic: both servo lines crossing in the centre column put the player there, ahead of a lone confident node", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  // The angles the rig read with a player 80 cm out in the centre on 4 Oct.
  // The left node found them (confident on its own), the right one half-found them.
  run(w, scanners({ avg: echoCm(0, 75, 80), angle: 141, scanState: 0 },
    { avg: echoCm(2, 75, 80), angle: 49, scanState: 1 }));
  const sensor = w.getGameState().sensor;
  assert.strictEqual(sensor.placedBy, "centre");
  assert.strictEqual(sensor.column, 1);
  assert.ok(sensor.xCm >= 58 && sensor.xCm <= 92, `x was ${sensor.xCm}`);
  assert.strictEqual(w.getDynamicFollowing(), "MID", "the Dynamic button names the rule");
});

test("Dynamic: in front of the left node with its servo leant in is not the centre", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  // LEFT reads 100 and RIGHT below 90, but the two lines cross in the left column.
  run(w, scanners({ avg: echoCm(0, 25, 80), angle: 100, scanState: 0 },
    { avg: echoCm(2, 25, 80), angle: aimAt(2, 25, 80), scanState: 0 }));
  const sensor = w.getGameState().sensor;
  assert.ok(["los", "tri", "avg"].includes(sensor.placedBy), `placed by ${sensor.placedBy}`);
  assert.strictEqual(sensor.column, 0);
});

test("Dynamic: a lone confident node places the player by itself", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  run(w, scanners({ avg: echoCm(0, 25, 85), angle: 90, scanState: 0 }, FURNITURE));
  const sensor = w.getGameState().sensor;
  assert.strictEqual(sensor.placedBy, "left");
  assert.strictEqual(sensor.column, 0);
  assert.ok(Math.abs(sensor.xCm - 25) < 0.5 && Math.abs(sensor.yCm - 85) < 0.5, `(${sensor.xCm}, ${sensor.yCm})`);
  assert.strictEqual(w.getDynamicFollowing(), "L");

  // Line of sight, switched on by itself, takes the furniture too.
  w.setPositionMethod("los");
  run(w, scanners({ avg: echoCm(0, 25, 85), angle: 90, scanState: 0 }, FURNITURE), 2);
  assert.strictEqual(w.getGameState().sensor.placedBy, "los");
  assert.strictEqual(w.getDynamicFollowing(), null, "Dynamic is off");
});

test("Dynamic: the centre holds for centreHoldMs while the servo lines stray just outside it", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  const holdMs = w.tuneSensor({}).centreHoldMs;
  const at = (x, y) => scanners({ avg: echoCm(0, x, y), angle: aimAt(0, x, y), scanState: 0 },
    { avg: echoCm(2, x, y), angle: aimAt(2, x, y), scanState: 0 });
  run(w, at(75, 80));
  const stray = at(110, 80);   // the lines now cross at 110 cm, in the right column
  const step = (frames) => {
    const start = w.performance.now();
    for (let i = 1; i <= frames; i += 1) {
      const t = start + i * FRAME_MS;
      w.performance.now = () => t;
      w.markSensorFrame();
      w.updateGame(t, CANVAS, stray);
    }
    return w.getGameState().sensor;
  };
  let sensor = step(Math.floor((holdMs - 50) / FRAME_MS));
  assert.strictEqual(sensor.placedBy, "centre");
  assert.strictEqual(sensor.column, 1);
  sensor = step(Math.ceil(400 / FRAME_MS));
  assert.notStrictEqual(sensor.placedBy, "centre");
});

test("Dynamic: a lone node whose own reading is in front of the board's near edge does not place the player", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  // 5 Oct: the left node, turned fully in, found something 27 cm away - 14 cm
  // out, in front of the near edge (20 cm).
  run(w, scanners({ avg: 27, angle: 160, scanState: 0 }, FURNITURE));
  assert.notStrictEqual(w.getGameState().sensor.placedBy, "left");
});
