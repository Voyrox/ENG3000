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

// Plays wave after wave, always going for the mole (else the hat mole), and
// checks each wave: 2 or 3 things, each a different kind on a different hole,
// coming up a step from where the last wave was played - as many of them as
// that hole has neighbours, the rest the next nearest - or, after a new deal,
// from the new hole nearest it.
function checkSteps(w, wavesWanted) {
  let t = 0;
  let last = null; // { cx, cy } of the hole the last wave was played at
  let waves = 0;
  let deals = 0;
  let shape = JSON.stringify(rowsOf(w.getGameGridLayout(CANVAS)).map((r) => r.holes.length));
  let wasUp = false;
  while (waves < wavesWanted) {
    t = run(w, [], 1, t);
    const state = w.getGameState();
    assert.notStrictEqual(state.status, "gameover");
    // A long run: the clock and lives never end it.
    state.remainingMs = 60000;
    state.lives = 99;
    // Only the frame a wave comes up.
    const up = state.items.length > 0;
    const spawned = up && !wasUp;
    wasUp = up;
    if (!spawned) continue;
    const layout = w.getGameGridLayout(CANVAS);
    const nowShape = JSON.stringify(rowsOf(layout).map((r) => r.holes.length));
    if (nowShape !== shape) deals += 1;
    shape = nowShape;

    const items = state.items.slice();
    assert.ok(items.length === 2 || items.length === 3, `${items.length} up`);
    assert.strictEqual(new Set(items.map((item) => item.type)).size, items.length, "no kind twice");
    assert.strictEqual(new Set(items.map((item) => item.hole)).size, items.length, "no hole twice");
    assert.ok(items.some((item) => item.type !== "bomb"), "always something to go for");
    if (last) {
      const from = layout.holes.reduce((a, b) =>
        (Math.hypot(b.cx - last.cx, b.cy - last.cy) < Math.hypot(a.cx - last.cx, a.cy - last.cy) ? b : a));
      const steps = layout.holes.filter((h) => isStep(layout, from, h)).length;
      const onSteps = items.filter((item) => isStep(layout, from, layout.holes[item.hole])).length;
      assert.strictEqual(onSteps, Math.min(items.length, steps), `${from.index} -> ${items.map((i) => i.hole)} on ${nowShape}`);
    }
    waves += 1;

    // Go for the mole, else the hat mole (two whacks).
    const target = items.find((item) => item.type === "mole") || items.find((item) => item.type === "super");
    const hole = layout.holes[target.hole];
    for (let i = 0; i < 2 && state.items.length; i += 1) w.handleGameClick(CANVAS, hole.cx, hole.cy);
    last = { cx: hole.cx, cy: hole.cy };
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
  while (state.items.length === 0) t = run(w, [], 1, t);
  const target = state.items.find((item) => item.type !== "bomb");
  const hole = w.getGameGridLayout(CANVAS).holes[target.hole];
  w.performance.now = () => t;
  while (state.items.length) w.handleGameClick(CANVAS, hole.cx, hole.cy);
  assert.strictEqual(state.peakLevel, 2);
  assert.strictEqual(state.boardPending, true, "waits for the hit to finish flashing");

  t = run(w, [], 20, t);
  const rows = rowsOf(w.getGameGridLayout(CANVAS)).map((r) => r.holes.length);
  assert.strictEqual(state.boardPending, false);
  assert.notDeepStrictEqual(rows, [3, 4, 2], "a new shape");
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(state.items.length, 0);
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
  while (w.getGameState().items.length === 0) t = run(w, [], 1, t);
  const hole = w.getGameGridLayout(CANVAS).holes[w.getGameState().items[0].hole];

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
  assert.strictEqual(state.items.length, 0, "no mole yet");

  t = run(w, [], 60, t); // past 3 s
  assert.strictEqual(state.countdownMs, 0);
  assert.ok(Number.isFinite(state.goAt), "Go");
  while (state.items.length === 0) t = run(w, [], 1, t);
  assert.ok(t - state.goAt >= 500, "the first mole comes up after Go");
});

test("the countdown waits while the sensors hold the round", () => {
  const w = loadWindow();
  w.setGameInputMode("sensor");
  w.resetGame();
  // Online, but no echo: nobody on the floor. (Both nodes offline would put
  // the round on the mouse instead.)
  const empty = [1, 2, 3].map((id) => ({ id, online: true, latest: JSON.stringify({ avg: -1 }) }));
  run(w, empty, 300);
  assert.strictEqual(w.getGameState().countdownMs, 3000, "nobody there: it has not started counting");
});

test("each battery pack loses 1 % every 2 minutes of round played, and is kept across sessions", () => {
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  const load = () => {
    const context = {
      console: { log() {}, info() {}, warn() {}, error() {} },
      performance: { now: () => 0 },
      Image: class { set src(_) {} },
      localStorage,
    };
    context.window = context;
    vm.createContext(context);
    ["alert.js", "callibrate_corners.js", "positionSolver.js", "game.js"].forEach((file) => {
      vm.runInContext(fs.readFileSync(path.join(DISPLAYS, file), "utf8"), context, { filename: file });
    });
    return context;
  };
  // Steps a mouse round by `ms` in 100 ms frames from time t; returns the new t.
  const play = (w, t, ms) => {
    for (const end = t + ms; t < end;) {
      t += 100;
      w.performance.now = () => t;
      w.updateGame(t, CANVAS, []);
    }
    return t;
  };
  const percents = (w) => Array.from(w.getBatteryPercents());

  let w = load();
  assert.deepStrictEqual(percents(w), [96, 99], "the packs start at 96 and 99 %");
  // Test mode: no round clock and no lives, so one round runs for minutes.
  w.setGameSettings({ testMode: true });
  w.setGameInputMode("mouse");
  w.resetGame();
  let t = play(w, 0, 3000 + 200); // the 3-2-1 does not count
  assert.deepStrictEqual(percents(w), [96, 99]);
  t = play(w, t, 2 * 60 * 1000);
  assert.deepStrictEqual(percents(w), [95, 98], "2 minutes played: 1 % off each");
  w.pauseGame();
  t = play(w, t, 10 * 60 * 1000);
  assert.deepStrictEqual(percents(w), [95, 98], "paused, they do not drain");
  w.resumeGame();
  t = play(w, t, 2 * 60 * 1000 + 500); // the frame after resuming counts nothing
  assert.deepStrictEqual(percents(w), [94, 97]);

  w = load();
  assert.deepStrictEqual(percents(w), [94, 97], "a new session carries on where the last left off");
  assert.deepStrictEqual(Array.from(w.setBatteryPercent(1, 100)), [100, 97], "and a pack can be charged again");
  assert.deepStrictEqual(percents(load()), [100, 97]);
});

// Starts a mouse round on the classic board and runs it to its first wave.
function firstWave(settings = {}) {
  const w = loadWindow();
  w.setGameInputMode("mouse");
  w.setGameSettings({ boardStyle: "classic", ...settings });
  w.resetGame();
  let t = 0;
  while (w.getGameState().items.length === 0) t = run(w, [], 1, t);
  return { w, t, state: w.getGameState(), layout: w.getGameGridLayout(CANVAS) };
}

test("waves are 2 or 3 things, all three kinds turning up, a pair more often", () => {
  const sizes = { 2: 0, 3: 0 };
  const kinds = new Set();
  for (let i = 0; i < 200; i += 1) {
    const { state } = firstWave();
    sizes[state.items.length] += 1;
    state.items.forEach((item) => kinds.add(item.type));
  }
  assert.strictEqual(sizes[2] + sizes[3], 200, "never 1, never more than 3");
  assert.ok(sizes[2] > sizes[3] && sizes[3] > 20, JSON.stringify(sizes));
  assert.deepStrictEqual([...kinds].sort(), ["bomb", "mole", "super"]);
});

test("test mode has no bombs: a mole and a hat mole", () => {
  for (let i = 0; i < 30; i += 1) {
    const { w, state } = firstWave();
    w.testMode(true);
    w.resetGame();
    let t = 0;
    while (state.items.length === 0) t = run(w, [], 1, t);
    assert.strictEqual(JSON.stringify(state.items.map((item) => item.type).sort()), '["mole","super"]');
  }
});

test("the first hit is the choice: the rest go back down, and a hat mole waits for its second", () => {
  for (let i = 0; i < 40; i += 1) {
    const { w, state, layout } = firstWave();
    const target = state.items.find((item) => item.type !== "bomb");
    const hole = layout.holes[target.hole];
    assert.strictEqual(w.handleGameClick(CANVAS, hole.cx, hole.cy), true);
    if (target.type === "super") {
      assert.strictEqual(JSON.stringify(state.items.map((item) => item.hole)), `[${target.hole}]`, "only the hat mole is left");
      assert.strictEqual(state.items[0].wounded, true);
      w.handleGameClick(CANVAS, hole.cx, hole.cy);
      assert.strictEqual(state.score, 3);
    } else {
      assert.strictEqual(state.score, 1);
    }
    assert.strictEqual(state.items.length, 0, "the wave is over");
  }
});

test("hitting the bomb ends the wave too, with its penalty", () => {
  for (let i = 0; i < 100; i += 1) {
    const { w, state, layout } = firstWave();
    const bomb = state.items.find((item) => item.type === "bomb");
    if (!bomb) continue;
    const livesBefore = state.lives;
    const hole = layout.holes[bomb.hole];
    w.handleGameClick(CANVAS, hole.cx, hole.cy);
    assert.strictEqual(state.items.length, 0);
    assert.strictEqual(state.lives, livesBefore - 1);
    return;
  }
  assert.fail("no wave with a bomb in 100 rounds");
});

test("a wave left alone costs one life, however many moles were in it", () => {
  for (let i = 0; i < 40; i += 1) {
    let { w, t, state } = firstWave();
    const livesBefore = state.lives;
    const moles = state.items.filter((item) => item.type !== "bomb").length;
    // Past every timer (12 s at level 1), but short of a second wave's.
    t = run(w, [], Math.ceil(12500 / FRAME_MS), t);
    assert.strictEqual(state.lives, livesBefore - 1, `${moles} mole(s) missed`);
  }
});
