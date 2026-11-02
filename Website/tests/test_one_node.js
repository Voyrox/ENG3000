// One node (Aaron, 2 Nov): with one node working, Play Game still goes
// through to sensor mode and that node alone tracks the player.
//
//   1. one node connected: identified, Start Game leaves the other slot empty;
//   2. two connected, one skipped: the other is identified, and the round is
//      one-node;
//   3. never both skipped, and with One node off it is both nodes, as before;
//   4. a one-node round places the player from that node alone;
//   5. it goes Out of bounds when that node is lost - which, with only both
//      nodes counted, it never could;
//   6. on line of sight, the track stays on a player standing still.
//
//     node --test Website/tests/test_one_node.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const vm = require("vm");

const DISPLAYS = path.join(__dirname, "..", "public", "displays");
const MODULES = ["alert.js", "callibrate_corners.js", "positionSolver.js", "game.js", "calibrate.js"];

const CANVAS = { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 };
const FRAME_MS = 16;
const SENSOR_X = [25, 75, 125];

function loadWindow() {
  const context = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    performance: { now: () => 0 },
    Image: class { set src(_) {} },
  };
  context.window = context;
  vm.createContext(context);
  MODULES.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(DISPLAYS, file), "utf8"), context, { filename: file });
  });
  context.setGameSettings({ boardStyle: "classic" });
  return context;
}

const BODY_RADIUS_CM = loadWindow().tuneSensor({}).bodyRadiusCm;

// A node as the firmware reports it, with the player's middle at (x, y).
function seeing(id, slot, x, y) {
  return {
    id,
    online: true,
    latest: JSON.stringify({
      avg: Math.hypot(x - SENSOR_X[slot], y) - BODY_RADIUS_CM,
      angle: Math.round(90 + (Math.atan2(x - SENSOR_X[slot], y) * 180) / Math.PI),
      scanState: 0,
    }),
  };
}

// A node sweeping with nothing in sight.
function lost(id, slot) {
  return { id, online: true, latest: JSON.stringify({ avg: -1, angle: slot === 0 ? 60 : 120, scanState: 2 }) };
}

function hand(id) {
  return { id, online: true, latest: JSON.stringify({ avg: 15 }) };
}

function room(id) {
  return { id, online: true, latest: JSON.stringify({ avg: 200 }) };
}

// Holds a hand in front of one node for long enough to assign it.
function identify(w, nodes, from) {
  w.updateSensorAssignment(nodes, from);
  w.updateSensorAssignment(nodes, from + 800);
}

function play(w, nodesFor, ms, clock) {
  for (const end = clock.t + ms; clock.t < end;) {
    clock.t += FRAME_MS;
    w.performance.now = () => clock.t;
    w.markSensorFrame();
    w.updateGame(clock.t, CANVAS, nodesFor());
  }
  return w.getGameState().sensor;
}

test("one node connected: identified, and Start Game leaves the other slot empty", () => {
  const w = loadWindow();
  assert.strictEqual(w.getOneNode(), true, "on by default");
  identify(w, [hand(7)], 0);
  assert.deepStrictEqual([...w.getSensorAssignment()], [7, null, null]);
  assert.strictEqual(w.isSensorAssignmentComplete(), false);
  assert.strictEqual(w.canStartOneNode(), true);
  assert.strictEqual(w.finishSensorAssignment(), true);
  assert.strictEqual(w.isSensorAssignmentComplete(), true);
  assert.strictEqual(w.getSensorAssignmentState().skipped.right, true);
  assert.deepStrictEqual([...w.getSensorAssignment()], [7, null, null]);
});

test("two connected, the left skipped: the right is identified and the round is one-node", () => {
  const w = loadWindow();
  w.updateSensorAssignment([room(1), room(2)], 0);
  assert.strictEqual(w.canStartOneNode(), false, "nothing identified yet");
  assert.strictEqual(w.skipSensorSlot(), true);
  assert.strictEqual(w.getSensorAssignmentState().activeKey, "right");
  assert.strictEqual(w.skipSensorSlot(), false, "never both");
  identify(w, [room(1), hand(2)], 1000);
  assert.deepStrictEqual([...w.getSensorAssignment()], [null, null, 2]);
  assert.strictEqual(w.isSensorAssignmentComplete(), true);
});

test("a second node still connected keeps Start Game waiting until it is skipped", () => {
  const w = loadWindow();
  identify(w, [hand(1), room(2)], 0);
  assert.deepStrictEqual([...w.getSensorAssignment()], [1, null, null]);
  assert.strictEqual(w.canStartOneNode(), false, "node 2 may be the right one");
  assert.strictEqual(w.finishSensorAssignment(), false);
  assert.strictEqual(w.skipSensorSlot(), true);
  assert.strictEqual(w.isSensorAssignmentComplete(), true);
  w.resetSensorAssignment();
  assert.strictEqual(w.getSensorAssignmentState().skipped.right, false, "a new calibration starts clean");
});

test("One node off: both nodes are needed, as before", () => {
  const w = loadWindow();
  assert.strictEqual(w.setOneNode(false), false);
  identify(w, [hand(7)], 0);
  assert.strictEqual(w.canStartOneNode(), false);
  assert.strictEqual(w.finishSensorAssignment(), false);
  assert.strictEqual(w.skipSensorSlot(), false);
  identify(w, [room(7), hand(8)], 1000);
  assert.strictEqual(w.isSensorAssignmentComplete(), true);
  assert.deepStrictEqual([...w.getSensorAssignment()], [7, null, 8]);
});

test("a one-node round places the player from that node, and is Out of bounds when it is lost", () => {
  const w = loadWindow();
  identify(w, [hand(1)], 0);
  w.finishSensorAssignment();
  w.setGameInputMode("sensor");
  w.resetGame();
  const clock = { t: 0 };

  const there = play(w, () => [seeing(1, 0, 40, 80), null, null], 2000, clock);
  assert.strictEqual(there.status, "ok");
  assert.strictEqual(there.column, 0);
  assert.ok(Math.abs(there.xCm - 40) < 5, `x ${there.xCm}`);
  assert.ok(Math.abs(there.yCm - 80) < 5, `y ${there.yCm}`);

  const across = play(w, () => [seeing(1, 0, 120, 90), null, null], 2000, clock);
  assert.strictEqual(across.status, "ok");
  assert.strictEqual(across.column, 2, "its servo follows the player across the board");

  const gone = play(w, () => [lost(1, 0), null, null], 600, clock);
  assert.strictEqual(gone.status, "out-of-bounds");
  assert.strictEqual(gone.nobodyFound, true);

  assert.strictEqual(play(w, () => [seeing(1, 0, 40, 80), null, null], 600, clock).status, "ok",
    "back once it finds the player again");
});

test("without a one-node assignment the missing node is counted, so the same run never goes Out of bounds", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  const clock = { t: 0 };
  play(w, () => [seeing(1, 0, 40, 80), null, null], 2000, clock);
  assert.notStrictEqual(play(w, () => [lost(1, 0), null, null], 1000, clock).status, "out-of-bounds");
});

test("a one-node round on line of sight: the track stays on a player standing still", () => {
  // A held aim counts in full with one node. Discounted, as with two, the
  // track drifted sideways off the board: (183, 22) for a player at (120, 90).
  const w = loadWindow();
  identify(w, [hand(1)], 0);
  w.finishSensorAssignment();
  w.setPositionMethod("los");
  w.setGameInputMode("sensor");
  w.resetGame();
  const clock = { t: 0 };
  play(w, () => [seeing(1, 0, 40, 80), null, null], 2000, clock);
  const still = play(w, () => [seeing(1, 0, 120, 90), null, null], 4000, clock);
  assert.strictEqual(still.status, "ok");
  assert.ok(Math.hypot(still.fixes.los.x - 120, still.fixes.los.y - 90) < 3,
    `line of sight at (${still.fixes.los.x}, ${still.fixes.los.y})`);
});
