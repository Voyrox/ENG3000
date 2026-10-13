// test_board.js
//
// The board's shape and its holes. These tests load the REAL browser modules
// headless in Node, as test_cursor_status.js does, and check that:
//
//   1. the classic board puts its nine round holes where the 3 x 3 always had
//      them, at full size
//   2. a random board is always 3 rows of 2-4 holes, never the classic one,
//      stays on the board, and its holes never overlap
//   3. every mole comes up one step from the last, on either board
//   4. a random board is dealt anew at each level up (not in test mode, and
//      never on the classic board), and the next mole waits for it
//   5. the holes shrink as the player levels up, down to a floor, and test
//      mode keeps them full size
//   6. only the circle scores, not the corners of the square around it
//   7. every hole of every random shape lies inside the calibrated play area,
//      and a player standing on it, as the sensors place them, puts the
//      cursor in that hole - at full size and at the smallest
//
// Run with:
//
//     node --test Website/tests/test_board.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const vm = require("vm");

const DISPLAYS = path.join(__dirname, "..", "public", "displays");
const MODULES = ["alert.js", "callibrate_corners.js", "positionSolver.js", "game.js"];

const CANVAS = { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 };
const FRAME_MS = 16;
const SENSOR_X = [25, 75, 125];
const PLAY_WIDTH_CM = 150;
const HOLES_PER_ROW = [2, 3, 4];

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
  return context;
}

function run(w, nodes, frames, from = 0) {
  for (let i = 1; i <= frames; i += 1) {
    const t = from + i * FRAME_MS;
    w.performance.now = () => t;
    w.markSensorFrame();
    w.updateGame(t, CANVAS, nodes);
  }
  return from + frames * FRAME_MS;
}

const BODY_RADIUS_CM = loadWindow().tuneSensor({}).bodyRadiusCm;
const echoCm = (slot, x, y) => Math.hypot(x - SENSOR_X[slot], y) - BODY_RADIUS_CM;

function nodesSeeing(x, y) {
  return [0, 1, 2].map((slot) => ({
    id: slot + 1,
    online: true,
    latest: JSON.stringify({ avg: echoCm(slot, x, y) }),
  }));
}

// Deals a chosen random shape: rows is the holes in each of the 3 rows.
function dealShape(w, rows) {
  const math = vm.runInContext("Math", w);
  const real = math.random;
  const values = rows.map((n) => (HOLES_PER_ROW.indexOf(n) + 0.5) / HOLES_PER_ROW.length);
  let i = 0;
  math.random = () => (i < values.length ? values[i++] : real());
  w.setGameSettings({ boardStyle: "random" });
  w.resetGame();
  math.random = real;
}

// Every random shape: 3 rows of 2-4, less the classic 3 x 3.
const ALL_SHAPES = [];
HOLES_PER_ROW.forEach((a) => HOLES_PER_ROW.forEach((b) => HOLES_PER_ROW.forEach((c) => {
  if (!(a === 3 && b === 3 && c === 3)) ALL_SHAPES.push([a, b, c]);
})));

// Rows of the board in play, from the holes' centres.
function rowsOf(layout) {
  const rows = [];
  layout.holes.forEach((h) => {
    const row = rows.find((r) => Math.abs(r.cy - h.cy) < 1e-6);
    if (row) row.holes.push(h);
    else rows.push({ cy: h.cy, holes: [h] });
  });
  return rows;
}

// Canvas pixels -> play-area cm, the inverse of the game's mapping with the
// default calibration (every column 10-160 cm deep): the classic hole
// centres are the column centres (25, 75, 125) and the row centres.
function toCm(layout, w, px, py) {
  const pitch = layout.cellSize + layout.cellGap;
  const { near, far } = w.getCalibrationBounds().perColumn[1];
  const rowDepth = (far - near) / 3;
  return {
    x: 25 + ((px - layout.gridLeft - layout.cellSize / 2) / pitch) * 50,
    y: near + ((py - layout.gridTop - layout.cellSize / 2) / pitch + 0.5) * rowDepth,
  };
}

test("Random is the default board", () => {
  const w = loadWindow();
  assert.strictEqual(w.getGameSettings().boardStyle, "random");
  w.resetGame();
  const rows = rowsOf(w.getGameGridLayout(CANVAS)).map((r) => r.holes.length);
  assert.ok(!rows.every((n) => n === 3), `rows ${rows}`);
});

test("the classic board is the familiar 3 x 3, with round holes at full size", () => {
  const w = loadWindow();
  w.setGameSettings({ boardStyle: "classic" });
  w.resetGame();
  const layout = w.getGameGridLayout(CANVAS);
  const pitch = layout.cellSize + layout.cellGap;
  assert.strictEqual(layout.holes.length, 9);
  layout.holes.forEach((h, i) => {
    assert.strictEqual(h.index, i);
    assert.ok(Math.abs(h.cx - (layout.gridLeft + layout.cellSize / 2 + (i % 3) * pitch)) < 1e-6);
    assert.ok(Math.abs(h.cy - (layout.gridTop + layout.cellSize / 2 + Math.floor(i / 3) * pitch)) < 1e-6);
    assert.ok(Math.abs(h.size - layout.cellSize) < 1e-6);
    assert.ok(Math.abs(h.r - h.size / 2) < 1e-6);
  });
});

test("a random board is 3 rows of 2-4, never classic, on the board, and its holes never overlap", () => {
  const w = loadWindow();
  w.setGameSettings({ boardStyle: "random" });
  for (let deal = 0; deal < 300; deal += 1) {
    w.resetGame();
    const layout = w.getGameGridLayout(CANVAS);
    const rows = rowsOf(layout).map((r) => r.holes.length);
    assert.strictEqual(rows.length, 3, `rows ${rows}`);
    rows.forEach((n) => assert.ok(n >= 2 && n <= 4, `rows ${rows}`));
    assert.ok(!rows.every((n) => n === 3), "never the classic 3 x 3");

    layout.holes.forEach((a) => {
      assert.ok(a.cx - a.r >= layout.gridLeft - 1e-6 && a.cx + a.r <= layout.gridLeft + layout.gridSize + 1e-6);
      assert.ok(a.cy - a.r >= layout.gridTop - 1e-6 && a.cy + a.r <= layout.gridTop + layout.gridSize + 1e-6);
      layout.holes.forEach((b) => {
        if (a.index < b.index) assert.ok(Math.hypot(a.cx - b.cx, a.cy - b.cy) >= a.r + b.r, `rows ${rows}`);
      });
    });
  }
});

test("the example shape [3, 4, 2] is laid out row by row", () => {
  const w = loadWindow();
  dealShape(w, [3, 4, 2]);
  const layout = w.getGameGridLayout(CANVAS);
  assert.deepStrictEqual(rowsOf(layout).map((r) => r.holes.map((h) => h.index)), [[0, 1, 2], [3, 4, 5, 6], [7, 8]]);
});

// One step: next along the row, or the nearest in the row above or below.
function isStep(layout, from, to) {
  const rows = rowsOf(layout);
  const rowOf = (h) => rows.findIndex((r) => r.holes.some((x) => x.index === h.index));
  const fr = rowOf(from);
  const tr = rowOf(to);
  if (fr === tr) {
    const list = rows[fr].holes.map((h) => h.index);
    return Math.abs(list.indexOf(from.index) - list.indexOf(to.index)) === 1;
  }
  if (Math.abs(fr - tr) !== 1) return false;
  const nearest = Math.min(...rows[tr].holes.map((h) => Math.abs(h.cx - from.cx)));
  return Math.abs(Math.abs(to.cx - from.cx) - nearest) < 1e-6;
}

// Whacks every mole for a while and checks each one (a bomb too) comes up a
// step from the last real mole - or, after a new deal, a step from the new
// hole nearest it.
function checkSteps(w, spawnsWanted) {
  let t = 0;
  let last = null; // { cx, cy } of the last real mole
  let spawns = 0;
  let deals = 0;
  let shape = JSON.stringify(rowsOf(w.getGameGridLayout(CANVAS)).map((r) => r.holes.length));
  let wasUp = false;
  while (spawns < spawnsWanted) {
    t = run(w, [], 1, t);
    const state = w.getGameState();
    assert.notStrictEqual(state.status, "gameover");
    // A long run: the clock and lives never end it.
    state.remainingMs = 60000;
    state.lives = 99;
    // Only the frame something comes up: a bomb left alone stays up a while.
    const up = state.activeHole !== -1;
    const spawned = up && !wasUp;
    wasUp = up;
    if (!spawned) continue;
    const layout = w.getGameGridLayout(CANVAS);
    const nowShape = JSON.stringify(rowsOf(layout).map((r) => r.holes.length));
    if (nowShape !== shape) deals += 1;
    shape = nowShape;
    const hole = layout.holes[state.activeHole];
    if (last) {
      const from = layout.holes.reduce((a, b) =>
        (Math.hypot(b.cx - last.cx, b.cy - last.cy) < Math.hypot(a.cx - last.cx, a.cy - last.cy) ? b : a));
      assert.ok(isStep(layout, from, hole), `${from.index} -> ${hole.index} on ${nowShape}`);
    }
    if (state.moleType !== "bomb") last = { cx: hole.cx, cy: hole.cy };
    spawns += 1;
    // A hat mole takes two whacks; a bomb is left alone.
    for (let i = 0; i < 2 && state.activeHole !== -1 && state.moleType !== "bomb"; i += 1) {
      w.handleGameClick(CANVAS, hole.cx, hole.cy);
    }
  }
  return deals;
}

test("every mole comes up one step from the last, on the classic board", () => {
  const w = loadWindow();
  w.setGameInputMode("mouse");
  w.setGameSettings({ boardStyle: "classic" });
  w.resetGame();
  assert.strictEqual(checkSteps(w, 200), 0, "the classic board is never dealt anew");
});

test("on a random board, every mole is one step on, across the new deals too", () => {
  for (let round = 0; round < 10; round += 1) {
    const w = loadWindow();
    w.setGameInputMode("mouse");
    w.setGameSettings({ boardStyle: "random" });
    w.resetGame();
    assert.ok(checkSteps(w, 120) >= 3, "dealt anew as the levels went up");
  }
});

test("a level up deals a new random board once the hit has flashed, and the next mole waits", () => {
  const w = loadWindow();
  w.setGameInputMode("mouse");
  dealShape(w, [3, 4, 2]);
  const state = w.getGameState();
  let t = run(w, [], 60);
  state.score = 4; // one more for level 2
  while (state.activeHole === -1) t = run(w, [], 1, t);
  const hole = w.getGameGridLayout(CANVAS).holes[state.activeHole];
  w.performance.now = () => t;
  while (state.activeHole !== -1 && state.moleType !== "bomb") w.handleGameClick(CANVAS, hole.cx, hole.cy);
  if (state.moleType === "bomb") return; // a bomb came up: nothing to whack, try another seed
  assert.strictEqual(state.peakLevel, 2);
  assert.strictEqual(state.boardPending, true, "waits for the hit to finish flashing");

  t = run(w, [], 20, t);
  const rows = rowsOf(w.getGameGridLayout(CANVAS)).map((r) => r.holes.length);
  assert.strictEqual(state.boardPending, false);
  assert.notDeepStrictEqual(rows, [3, 4, 2], "a new shape");
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(state.activeHole, -1);
  assert.ok(state.nextSpawnAt >= t - 20 * FRAME_MS + 1000, "the next mole waits for the player to see it");
});

test("test mode keeps the random board it was dealt", () => {
  const w = loadWindow();
  w.setGameInputMode("mouse");
  w.testMode(true);
  dealShape(w, [3, 4, 2]);
  w.getGameState().score = 30;
  run(w, [], 120);
  assert.deepStrictEqual(rowsOf(w.getGameGridLayout(CANVAS)).map((r) => r.holes.length), [3, 4, 2]);
});

test("the holes shrink as the player levels up, down to a floor", () => {
  const w = loadWindow();
  w.setGameInputMode("mouse");
  // Classic, so a level up does not deal a board with other hole sizes.
  w.setGameSettings({ boardStyle: "classic" });
  w.resetGame();
  const full = w.getGameGridLayout(CANVAS).holes[0].size;

  let t = run(w, [], 60);
  assert.ok(Math.abs(w.getGameGridLayout(CANVAS).holes[0].size - full) < 1e-6, "level 1 is full size");

  w.getGameState().score = 10; // level 3
  t = run(w, [], 200, t);
  const level3 = w.getGameGridLayout(CANVAS).holes[0].size / full;
  assert.ok(Math.abs(level3 - 0.88) < 0.01, `level 3 was ${level3}`);

  w.getGameState().score = 45; // level 10
  run(w, [], 200, t);
  const floor = w.getGameGridLayout(CANVAS).holes[0].size / full;
  assert.ok(Math.abs(floor - 0.55) < 0.01, `level 10 was ${floor}`);

  w.resetGame();
  assert.ok(Math.abs(w.getGameGridLayout(CANVAS).holes[0].size - full) < 1e-6, "a new round starts full size");
});

test("test mode keeps the holes full size", () => {
  const w = loadWindow();
  w.setGameInputMode("mouse");
  w.testMode(true);
  w.resetGame();
  const full = w.getGameGridLayout(CANVAS).holes[0].size;
  w.getGameState().score = 45;
  run(w, [], 200);
  assert.ok(Math.abs(w.getGameGridLayout(CANVAS).holes[0].size - full) < 1e-6);
});

test("only the circle scores, not the corners of the square around it", () => {
  const w = loadWindow();
  w.setGameInputMode("mouse");
  w.resetGame();
  let t = 0;
  while (w.getGameState().activeHole === -1) t = run(w, [], 1, t);
  const hole = w.getGameGridLayout(CANVAS).holes[w.getGameState().activeHole];

  assert.strictEqual(w.handleGameClick(CANVAS, hole.x + 2, hole.y + 2), false, "the square's corner");
  assert.strictEqual(w.getGameState().score, 0);
  assert.strictEqual(w.handleGameClick(CANVAS, hole.cx, hole.cy + hole.r * 0.9), true, "inside the circle");
});

test("every random shape's holes lie inside the calibrated play area", () => {
  const w = loadWindow();
  const { near, far } = w.getCalibrationBounds().perColumn[1];
  ALL_SHAPES.forEach((shape) => {
    dealShape(w, shape);
    const layout = w.getGameGridLayout(CANVAS);
    layout.holes.forEach((h) => {
      const topLeft = toCm(layout, w, h.cx - h.r, h.cy - h.r);
      const bottomRight = toCm(layout, w, h.cx + h.r, h.cy + h.r);
      const where = `hole ${h.index} of ${shape}: ${JSON.stringify([topLeft, bottomRight])}`;
      assert.ok(topLeft.x >= 0 && bottomRight.x <= PLAY_WIDTH_CM, where);
      assert.ok(topLeft.y >= near && bottomRight.y <= far, where);
    });
  });
});

// Stands the player on each hole's centre, as the sensors would see them,
// and checks the cursor lands in that hole. Paused, so no mole is whacked
// and no level up deals a new board underneath it.
function checkStandingOnHoles(shrunk) {
  ALL_SHAPES.forEach((shape) => {
    const w = loadWindow();
    w.setGameInputMode("sensor");
    dealShape(w, shape);
    let t = 0;
    w.pauseGame();
    // The smallest the holes get. (With nobody on the floor the round is
    // held, so playing up to it would never shrink them.)
    if (shrunk) w.getGameState().holeScale = 0.55;
    const layout = w.getGameGridLayout(CANVAS);
    if (shrunk) assert.ok(layout.holes[0].size < layout.cellSize * 0.56, "at the smallest");
    layout.holes.forEach((h) => {
      const at = toCm(layout, w, h.cx, h.cy);
      t = run(w, nodesSeeing(at.x, at.y), 150, t);
      const status = w.getGameCursorStatus(CANVAS);
      const where = `hole ${h.index} of ${shape} at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}) cm`;
      assert.strictEqual(status.sensor.status, "ok", where);
      assert.strictEqual(status.hole, h.index, where);
      const cursor = w.getGameState().cursor;
      assert.ok(Math.hypot(cursor.x - h.cx, cursor.y - h.cy) < h.r * 0.5, `${where}: cursor ${cursor.x}, ${cursor.y}`);
    });
  });
}

test("standing on any hole of any random shape puts the cursor in it", () => {
  checkStandingOnHoles(false);
});

test("and still does once the holes are at their smallest", () => {
  checkStandingOnHoles(true);
});

test("a round starts with a 3-2-1 countdown: no clock and no moles until Go", () => {
  const w = loadWindow();
  w.setGameInputMode("mouse");
  w.resetGame();
  const state = w.getGameState();
  const full = state.remainingMs;
  let t = run(w, [], 150); // 2.4 s
  assert.ok(state.countdownMs > 0, "still counting");
  assert.strictEqual(state.remainingMs, full, "the clock has not started");
  assert.strictEqual(state.activeHole, -1, "no mole yet");

  t = run(w, [], 60, t); // past 3 s
  assert.strictEqual(state.countdownMs, 0);
  assert.ok(Number.isFinite(state.goAt), "Go");
  while (state.activeHole === -1) t = run(w, [], 1, t);
  assert.ok(t - state.goAt >= 500, "the first mole comes up after Go");
});

test("the countdown waits while the sensors hold the round", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  const offline = [1, 2, 3].map((id) => ({ id, online: false, latest: null }));
  run(w, offline, 300);
  assert.strictEqual(w.getGameState().countdownMs, 3000, "nobody there: it has not started counting");
});
