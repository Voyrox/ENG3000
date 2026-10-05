// cursor_replay.js - how steady the sensor cursor's cell is, and how fast it
// follows a real move. Aaron, 5 Oct: the cursor should favour stability over
// volatility, yet still show the player stepping into another cell.
//
//     node Website/tools/cursor_replay.js
//     node Website/tools/cursor_replay.js --rigs rig --seeds 5 --method los
//     node Website/tools/cursor_replay.js --tune '[{}, {"cellVotes": 9}]'
//     node Website/tools/cursor_replay.js --centre-run ../ENG3000/logs/centre-20261004-154946
//     node Website/tools/cursor_replay.js --json cursor.json
//
// It runs the REAL game.js headless, as simulate_positions.js does, and reads
// three cells on every frame:
//   shown - the hole under the drawn cursor: the ring the player sees, the
//           hole that scores on hover, and the hole the control pad lights up
//   voted - gameState.sensor.gx/gy, after the cell vote and the hysteresis
//   raw   - gameState.sensor.rawGx/rawGy, the position's cell before the vote
//
// The simulated tests, each a fresh game that gets LOCK_ON_MS to find the
// player before anything is scored:
//   centre   - standing still in the middle of each of the nine cells
//   boundary - standing still on a line between two cells; either is right
//   step     - standing in a cell, then walking into the next one and staying
//   return   - standing in a cell long enough to be sure of it (FAMILIAR_MS),
//              stepping into the next one for AWAY_MS, then walking back: the
//              latency of the walk back, into a cell the game has seen the
//              player in (cell confidence)
//
// The measures, for each of the three cells:
//   flips/min - changes of cell while standing still. The gap between two
//               holes is no cell, so A, gap, A is no flip and A, gap, B is one.
//   wrong %   - the share of still frames on a cell the player is not in
//   none %    - the share of frames in the middle of a cell with no cell at
//               all (no signal, the gap between holes): a cursor that hides is
//               not a steady one. Not counted on a line, where the drawn
//               cursor sits in the gap between two holes by rights.
//   stray/min - entries into a cell the player is not in (in a step, neither
//               the cell they left nor the one they walked into): each one
//               could score a mole the player never reached
//   latency   - from the player crossing into the new cell until the cell
//               last moved there and stayed (median and 90th percentile)
//   within    - the share of steps shown within BUDGET_MS
//   missed    - steps whose new cell was not showing at the end of the step
//
// The rule (Aaron, 5 Oct): 90 % of moves shown within 1 s and none missed;
// of the settings that manage that, the one with the fewest flips wins.
//
// Two model rigs (--rigs). "ideal" is simulate_positions.js's: 2 cm of
// noise and servos that read true. "rig" is rougher, loosely after the 4 Oct
// centre test (logs/centre-20261004-154946/report.md): each servo reads a few
// degrees off where it points, so the two nodes put a still player in
// different places and the position swings at each turn handover; readings a
// little shorter than the game's body radius allows; more noise, and an echo
// lost now and then. Both are models: compare settings on them, then check
// on the rig with centre_test.py.
//
// --centre-run replays a centre_test.py recording (readings.csv, turns.csv,
// run.json) reading by reading, and scores its still spots the same way: a
// spot on a line (centre_test.py --spots cells) as a line, the others as
// cell centres. Its step spots are timed from the move beep, so their
// latency includes hearing it and walking. The recording's own geometry and
// firmware are whatever they were that day.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FRAME_MS = 1000 / 60;
const LOCK_ON_MS = 3000;
const STILL_MS = 20000;
const STEP_BEFORE_MS = 2000;       // standing in the first cell, after the lock-on
const STEP_AFTER_MS = 4000;        // standing in the new cell
const BUDGET_MS = 1000;            // the move budget (Aaron, 5 Oct)
const FAMILIAR_MS = 4000;          // a return test: standing in the first cell, before the step away
const AWAY_MS = 3000;              // and in the next one, before walking back
const TURN_MS = 1000;              // app.py TURN_INTERVAL_SECONDS
const NODE_X = [25, null, 125];
const SERVO_LIMITS = { 0: [40, 160], 2: [30, 140] };   // Config.h
const BEAM_DEG = 15;
const BOTH_DEG = 6;
const BODY_RADIUS_CM = 15;
const BODY_HALF_WIDTH_CM = 20;
const SIGNALS = ["shown", "voted", "raw"];
const CANVAS = { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 };

const RIGS = {
  ideal: { noiseCm: 2, aimErrorDeg: { 0: 0, 2: 0 }, shortCm: 0, dropout: 0, messageMs: 66 },
  rig: { noiseCm: 5, aimErrorDeg: { 0: 5, 2: -5 }, shortCm: 8, dropout: 0.03, messageMs: 95 },
};

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function loadGame(site) {
  let clock = 0;
  const quiet = { log() {}, info() {}, warn() {}, error: console.error };
  const context = { console: quiet, performance: { now: () => clock }, Image: class { set src(_) {} }, Math, JSON };
  context.window = context;
  vm.createContext(context);
  for (const file of ["alert.js", "callibrate_corners.js", "positionSolver.js", "gameStats.js", "game.js"]) {
    const full = path.join(site, "displays", file);
    if (fs.existsSync(full)) vm.runInContext(fs.readFileSync(full, "utf8"), context, { filename: file });
  }
  return { game: context, setClock: (t) => { clock = t; } };
}

// A game ready for sensor input: the method, the tuning, and a way to read
// the three cells. Cells are coded gx * 3 + gy (gy 0 nearest the screen), as
// the game's cell vote codes them; null is no cell.
function startGame(site, method, tune) {
  const { game, setClock } = loadGame(site);
  if (method && game.setPositionMethod && game.setPositionMethod(method) !== method) {
    throw new Error(`this game has no position method "${method}"`);
  }
  if (tune && Object.keys(tune).length) game.tuneSensor(tune);
  game.setGameInputMode("sensor");
  game.resetGame();

  // Hole index -> cell code, through the game's own hole centres.
  const layout = game.getGameGridLayout(CANVAS);
  const holeCell = new Map();
  for (let gx = 0; gx < 3; gx++) {
    for (let gy = 0; gy < 3; gy++) {
      const centre = game.gridToCanvasPoint(CANVAS, gx, gy);
      const hole = layout.holes.find((h) => centre.x >= h.x && centre.x <= h.x + h.size
        && centre.y >= h.y && centre.y <= h.y + h.size);
      if (hole) holeCell.set(hole.index, gx * 3 + gy);
    }
  }

  function cells() {
    const state = game.getGameState();
    const sensor = state.sensor || {};
    const cursor = state.cursor || {};
    let shown = null;
    if (cursor.inBounds && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
      const hole = layout.holes.find((h) => cursor.x >= h.x && cursor.x <= h.x + h.size
        && cursor.y >= h.y && cursor.y <= h.y + h.size);
      shown = hole ? holeCell.get(hole.index) : null;
    }
    const code = (gx, gy) => (Number.isInteger(gx) && Number.isInteger(gy) ? gx * 3 + gy : null);
    const ok = sensor.status === "ok" || sensor.held;
    return {
      shown,
      voted: ok ? code(sensor.gx, sensor.gy) : null,
      raw: sensor.status === "ok" ? code(sensor.rawGx, sensor.rawGy) : null,
    };
  }

  // The cell a point (cm) is in, by the game's own grid: columns 50 cm wide,
  // rows from the calibration bounds, no hysteresis. null off the board.
  function cellAt(x, y) {
    if (!(x >= 0 && x <= 150)) return null;
    const column = Math.max(0, Math.min(2, Math.floor(x / 50)));
    const grid = game.rawToGrid(column, y, null);
    return grid && grid.inside ? column * 3 + grid.gy : null;
  }

  // The cells right for a player standing at (x, y): the cell they are in,
  // and on a line, the cell across it too.
  function cellsNear(x, y) {
    const near = new Set();
    [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]].forEach(([dx, dy]) => {
      const cell = cellAt(x + dx, y + dy);
      if (cell !== null) near.add(cell);
    });
    return near;
  }

  // The middle of each row, and the lines between rows, from the game's
  // calibration bounds for a column.
  function rows(column) {
    const bounds = game.getCalibrationBounds().perColumn[column];
    const depth = (bounds.far - bounds.near) / 3;
    return {
      centres: [0, 1, 2].map((r) => bounds.near + (r + 0.5) * depth),
      lines: [1, 2].map((r) => bounds.near + r * depth),
    };
  }

  return { game, setClock, cells, cellAt, cellsNear, rows };
}

// One node reading on a model rig, and the firmware's servo move after it:
// simulate_positions.js's model, plus the rig's aim error, shortfall and
// dropouts. The servo moves by where it really points; the reading reports
// where it thinks it points.
function scan(slot, servo, player, rig, rand) {
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
  const nodeX = NODE_X[slot];
  const bearingTo = ([x, y]) => 90 + (Math.atan2(x - nodeX, y) * 180) / Math.PI;
  const aim = servo[slot];
  let distance = -1;
  let state = 2;
  const reach = Math.hypot(player[0] - nodeX, player[1]);
  const bodyDeg = (Math.atan2(BODY_HALF_WIDTH_CM, reach) * 180) / Math.PI;
  const off = Math.max(0, Math.abs(bearingTo(player) - aim) - bodyDeg);
  if (off <= BEAM_DEG && rand() >= rig.dropout) {
    distance = Math.max(2, reach - BODY_RADIUS_CM - rig.shortCm) + rig.noiseCm * gauss();
    state = off <= BOTH_DEG ? 0 : 1;
  }
  const [low, high] = SERVO_LIMITS[slot];
  if (state === 1) {
    servo[slot] = Math.max(low, Math.min(high, aim + (bearingTo(player) > aim ? 3 : -3)));
  } else if (state === 2) {
    servo[slot] += 14 * servo.dir[slot];
    if (servo[slot] > high || servo[slot] < low) {
      servo.dir[slot] = -servo.dir[slot];
      servo[slot] = Math.max(low, Math.min(high, servo[slot]));
    }
  }
  return { avg: distance, left: distance, right: distance, angle: aim + rig.aimErrorDeg[slot], scanState: state };
}

// Runs one simulated test. path(t) gives the player's true (x, y) at t ms;
// the returned frames carry, from LOCK_ON_MS on, the time, the true cell and
// the three cells.
function simulate({ site, method, tune, rig, seed, durationMs, path: playerAt }) {
  const play = startGame(site, method, tune);
  const rand = lcg(seed);
  const nodes = [
    { id: 1, online: true, latest: null, has_turn: true },
    null,
    { id: 3, online: true, latest: null, has_turn: false },
  ];
  const servo = { 0: 90, 2: 90, dir: { 0: 1, 2: 1 } };
  let stamp = 0;
  let nextMessage = 0;
  let turnHolder = 0;
  const frames = [];

  for (let t = 0; t < durationMs; t += FRAME_MS) {
    play.setClock(t);
    // The server's turn: one revoke and one grant, each a broadcast that the
    // game counts as a new frame of readings (app.py set_turn()).
    const holder = Math.floor(t / TURN_MS) % 2 === 0 ? 0 : 2;
    if (holder !== turnHolder) {
      turnHolder = holder;
      nodes[0].has_turn = holder === 0;
      nodes[2].has_turn = holder === 2;
      play.game.markSensorFrame();
      play.game.markSensorFrame();
      nextMessage = t + rig.messageMs;
    }
    if (t >= nextMessage) {
      nextMessage += rig.messageMs;
      nodes[holder].latest = JSON.stringify(scan(holder, servo, playerAt(t), rig, rand));
      stamp += 1;
      nodes[holder].last_seen = stamp;
      play.game.markSensorFrame();
    }
    play.game.updateGame(t, CANVAS, nodes);
    if (t < LOCK_ON_MS) continue;
    const [x, y] = playerAt(t);
    frames.push({ t, truth: play.cellAt(x, y), ...play.cells() });
  }
  return { frames, play };
}

// --- Measures ---------------------------------------------------------------

// Changes of cell, the gap (null) between two holes not counting as a cell.
function countFlips(cells) {
  let last = null;
  let flips = 0;
  cells.forEach((cell) => {
    if (cell === null) return;
    if (last !== null && cell !== last) flips += 1;
    last = cell;
  });
  return flips;
}

// Entries into a cell outside right (a Set, or a function of the frame index
// returning one).
function countStrays(cells, right) {
  const rightAt = typeof right === "function" ? right : () => right;
  let last = null;
  let strays = 0;
  cells.forEach((cell, i) => {
    if (cell !== null && cell !== last && !rightAt(i).has(cell)) strays += 1;
    if (cell !== null) last = cell;
  });
  return strays;
}

// How long after crossAt (ms) the cell last moved to target and stayed there
// to the end; null if it was not on target at the end (missed). times and
// cells are parallel arrays. A gap at the end counts as not on target.
function moveLatency(times, cells, target, crossAt) {
  if (!cells.length || cells[cells.length - 1] !== target) return null;
  let i = cells.length - 1;
  while (i > 0 && cells[i - 1] === target) i -= 1;
  return Math.max(0, times[i] - crossAt);
}

function quantile(values, q) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Still frames (each { t, ...cells }), all against one right set.
function scoreStill(frames, right) {
  const out = {};
  SIGNALS.forEach((signal) => {
    const cells = frames.map((f) => f[signal]);
    const shown = cells.filter((c) => c !== null);
    out[signal] = {
      flips: countFlips(cells),
      strays: countStrays(cells, right),
      wrong: shown.filter((c) => !right.has(c)).length,
      none: cells.length - shown.length,
      frames: cells.length,
    };
  });
  return out;
}

// --- The simulated tests ----------------------------------------------------

function stillPath(x, y) {
  return () => [x, y];
}

// Stands at a for STEP_BEFORE_MS after the lock-on, walks to b at walkCmS,
// stands at b for STEP_AFTER_MS.
function stepPath(a, b, walkCmS) {
  const walkMs = (1000 * Math.hypot(b[0] - a[0], b[1] - a[1])) / walkCmS;
  const leaveAt = LOCK_ON_MS + STEP_BEFORE_MS;
  return {
    durationMs: leaveAt + walkMs + STEP_AFTER_MS,
    at: (t) => {
      if (t <= leaveAt) return a;
      const k = Math.min(1, (t - leaveAt) / walkMs);
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    },
  };
}

// Stands at a for STEP_BEFORE_MS + FAMILIAR_MS after the lock-on, walks to
// b, stands there AWAY_MS, walks back to a and stands STEP_AFTER_MS. backAt is
// when the walk back starts.
function returnPath(a, b, walkCmS) {
  const walkMs = (1000 * Math.hypot(b[0] - a[0], b[1] - a[1])) / walkCmS;
  const leaveAt = LOCK_ON_MS + STEP_BEFORE_MS + FAMILIAR_MS;
  const backAt = leaveAt + walkMs + AWAY_MS;
  const along = (from, to, k) => [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
  return {
    durationMs: backAt + walkMs + STEP_AFTER_MS,
    backAt,
    at: (t) => {
      if (t <= leaveAt) return a;
      if (t <= backAt) return along(a, b, Math.min(1, (t - leaveAt) / walkMs));
      return along(b, a, Math.min(1, (t - backAt) / walkMs));
    },
  };
}

// The test spots, from the game's own grid.
function testSpots(site) {
  const { rows } = startGame(site, null, null);
  const columns = [25, 75, 125];
  const centre = rows(1);
  const centres = [];
  columns.forEach((x, column) => rows(column).centres.forEach((y) => centres.push([x, y])));
  const boundaries = [
    [50, centre.centres[1]], [100, centre.centres[1]],
    [75, centre.lines[0]], [75, centre.lines[1]],
    [50, centre.centres[2]], [100, centre.centres[0]],
  ];
  const [r0, r1, r2] = centre.centres;
  const steps = [
    [[25, r1], [75, r1]], [[75, r1], [125, r1]], [[125, r1], [75, r1]], [[75, r1], [25, r1]],
    [[75, r0], [75, r1]], [[75, r1], [75, r2]], [[75, r2], [75, r1]], [[75, r1], [75, r0]],
    [[75, r2], [125, r2]], [[25, r0], [75, r0]],
  ];
  return { centres, boundaries, steps };
}

function emptyTotals() {
  const totals = {};
  SIGNALS.forEach((signal) => {
    totals[signal] = {
      centre: { flips: 0, strays: 0, wrong: 0, none: 0, frames: 0 },
      boundary: { flips: 0, strays: 0, wrong: 0, none: 0, frames: 0 },
      step: { strays: 0, frames: 0, latencies: [], missed: 0, steps: 0 },
      return: { strays: 0, frames: 0, latencies: [], missed: 0, steps: 0 },
    };
  });
  return totals;
}

function addStill(totals, kind, scores) {
  SIGNALS.forEach((signal) => {
    Object.keys(scores[signal]).forEach((key) => { totals[signal][kind][key] += scores[signal][key]; });
  });
}

// A move from cell from to cell to: strays outside the two, and how long
// after moveAt (ms) each cell moved onto to and stayed.
function addStep(totals, frames, from, to, moveAt, kind = "step") {
  const allowed = new Set([from, to]);
  const times = frames.map((f) => f.t);
  SIGNALS.forEach((signal) => {
    const cells = frames.map((f) => f[signal]);
    const step = totals[signal][kind];
    step.steps += 1;
    step.frames += cells.length;
    step.strays += countStrays(cells, allowed);
    const latency = moveLatency(times, cells, to, moveAt);
    if (latency === null) step.missed += 1;
    else step.latencies.push(latency);
  });
}

// A still spot is on a line when either cell across it is right.
function stillKind(right) {
  return right.size > 1 ? "boundary" : "centre";
}

function runSimulated({ site, method, tune, rigName, seeds, walkCmS, only }) {
  const rig = RIGS[rigName];
  const spots = testSpots(site);
  const totals = emptyTotals();
  for (let seed = 1; seed <= seeds; seed++) {
    const base = seed * 7919;
    const still = [];
    if (!only || only.includes("centre")) spots.centres.forEach((p) => still.push(["centre", p]));
    if (!only || only.includes("boundary")) spots.boundaries.forEach((p) => still.push(["boundary", p]));
    still.forEach(([kind, [x, y]], i) => {
      const { frames, play } = simulate({
        site, method, tune, rig, seed: base + i, durationMs: LOCK_ON_MS + STILL_MS, path: stillPath(x, y),
      });
      addStill(totals, kind, scoreStill(frames, play.cellsNear(x, y)));
    });
    if (only && !only.includes("step")) continue;
    spots.steps.forEach(([a, b], i) => {
      const walk = stepPath(a, b, walkCmS);
      const { frames, play } = simulate({
        site, method, tune, rig, seed: base + 100 + i, durationMs: walk.durationMs, path: walk.at,
      });
      const to = play.cellAt(...b);
      const cross = frames.find((f) => f.truth === to);
      addStep(totals, frames, play.cellAt(...a), to, cross ? cross.t : walk.durationMs);
    });
    if (only && !only.includes("return")) continue;
    spots.steps.forEach(([a, b], i) => {
      const walk = returnPath(a, b, walkCmS);
      const { frames, play } = simulate({
        site, method, tune, rig, seed: base + 200 + i, durationMs: walk.durationMs, path: walk.at,
      });
      const home = play.cellAt(...a);
      const back = frames.filter((f) => f.t >= walk.backAt);
      const cross = back.find((f) => f.truth === home);
      addStep(totals, back, play.cellAt(...b), home, cross ? cross.t : walk.durationMs, "return");
    });
  }
  return totals;
}

// --- A centre_test.py recording ---------------------------------------------

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row = {};
    header.forEach((name, i) => { row[name] = values[i]; });
    return row;
  });
}

// node id -> slot (0 LEFT, 2 RIGHT): run.json's left/right when it names
// them, then --left-node/--right-node, then the lower id on the left (as
// node 1 was LEFT in the 4 Oct run).
function recordedSlots(run, ids, leftNode, rightNode) {
  const left = String(run.left ?? leftNode ?? "");
  const right = String(run.right ?? rightNode ?? "");
  const sorted = [...ids].sort((a, b) => Number(a) - Number(b));
  const leftId = left || (right ? sorted.find((id) => id !== right) : sorted[0]);
  const rightId = right || sorted.find((id) => id !== leftId);
  return { [leftId]: 0, [rightId]: 2 };
}

function runRecording({ site, method, tune, dir, leftNode, rightNode }) {
  const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  const readings = readCsv(path.join(dir, "readings.csv"));
  const turnsFile = path.join(dir, "turns.csv");
  const turns = fs.existsSync(turnsFile) ? readCsv(turnsFile) : [];
  const ids = [...new Set(readings.map((r) => r.node_id))];
  const slots = recordedSlots(run, ids, leftNode, rightNode);

  // Every event in time order: a reading, or a turn broadcast (the rows of
  // turns.csv at one time are one broadcast).
  const events = readings.map((r) => ({ t: 1000 * Number(r.t_s), reading: r }));
  const byTime = new Map();
  turns.forEach((row) => {
    const t = 1000 * Number(row.t_s);
    if (!byTime.has(t)) byTime.set(t, []);
    byTime.get(t).push(row);
  });
  byTime.forEach((rows, t) => events.push({ t, turn: rows }));
  events.sort((a, b) => a.t - b.t);

  const play = startGame(site, method, tune);
  const nodes = [null, null, null];
  Object.entries(slots).forEach(([id, slot]) => {
    nodes[slot] = { id: Number(id), online: true, latest: null, has_turn: false };
  });
  const num = (v) => (v === undefined || v === "" ? -1 : Number(v));
  // The spots scored: still ones, and steps with their move beep
  // (centre_test.py --spots cells). Walks have no position to score against.
  const scored = (run.steps || []).filter((s) => Number.isFinite(s.x_cm) && Number.isFinite(s.y_cm)
    && (s.kind === "still" || (s.kind === "step" && Number.isFinite(s.move_s) && Number.isFinite(s.to_x_cm))));
  const frames = [];
  let stamp = 0;
  let next = 0;
  const endMs = events.length ? events[events.length - 1].t : 0;
  for (let t = events.length ? events[0].t : 0; t <= endMs; t += FRAME_MS) {
    play.setClock(t);
    while (next < events.length && events[next].t <= t) {
      const event = events[next++];
      if (event.turn) {
        event.turn.forEach((row) => {
          const slot = slots[row.node_id];
          if (slot !== undefined) nodes[slot].has_turn = row.has_turn === "1";
        });
      } else {
        const r = event.reading;
        const slot = slots[r.node_id];
        if (slot === undefined) continue;
        nodes[slot].latest = JSON.stringify({
          avg: num(r.avg_cm), left: num(r.left_cm), right: num(r.right_cm),
          angle: Number(r.angle_deg), scanState: Number(r.scan_state),
        });
        stamp += 1;
        nodes[slot].last_seen = stamp;
      }
      play.game.markSensorFrame();
    }
    play.game.updateGame(t, CANVAS, nodes);
    const step = scored.find((s) => t >= 1000 * s.start_s && t <= 1000 * s.end_s);
    if (step) frames.push({ t, step: step.name, ...play.cells() });
  }

  // A recorded step's latency runs from its move beep, so it includes the
  // player hearing it and walking: about half a second more than the
  // simulated steps', which run from the crossing.
  const totals = emptyTotals();
  const perSpot = {};
  scored.forEach((step) => {
    const spot = frames.filter((f) => f.step === step.name);
    if (step.kind === "step") {
      const from = play.cellAt(step.x_cm, step.y_cm);
      addStep(totals, spot, from, play.cellAt(step.to_x_cm, step.to_y_cm), 1000 * step.move_s);
      return;
    }
    const right = play.cellsNear(step.x_cm, step.y_cm);
    perSpot[step.name] = scoreStill(spot, right);
    addStill(totals, stillKind(right), perSpot[step.name]);
  });
  return { totals, perSpot, slots };
}

// --- Report -----------------------------------------------------------------

function summarise(totals) {
  const out = {};
  SIGNALS.forEach((signal) => {
    const { centre, boundary, step } = totals[signal];
    const back = totals[signal].return;
    const still = ["flips", "strays", "wrong", "none", "frames"].reduce((sum, key) => {
      sum[key] = centre[key] + boundary[key];
      return sum;
    }, {});
    const minutes = (frames) => (frames * FRAME_MS) / 60000;
    const perMin = (count, frames) => (frames ? count / minutes(frames) : NaN);
    out[signal] = {
      centreFlipsPerMin: perMin(centre.flips, centre.frames),
      boundaryFlipsPerMin: perMin(boundary.flips, boundary.frames),
      wrongPct: still.frames - still.none ? (100 * still.wrong) / (still.frames - still.none) : NaN,
      nonePct: centre.frames ? (100 * centre.none) / centre.frames : NaN,
      straysPerMin: perMin(still.strays + step.strays, still.frames + step.frames),
      latencyP50Ms: quantile(step.latencies, 0.5),
      latencyP90Ms: quantile(step.latencies, 0.9),
      withinBudgetPct: step.steps ? (100 * step.latencies.filter((l) => l <= BUDGET_MS).length) / step.steps : NaN,
      missed: step.missed,
      steps: step.steps,
      returnP50Ms: quantile(back.latencies, 0.5),
      returnWithinBudgetPct: back.steps ? (100 * back.latencies.filter((l) => l <= BUDGET_MS).length) / back.steps : NaN,
      returnMissed: back.missed,
      returnSteps: back.steps,
    };
  });
  return out;
}

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  console.log("| Setting | Cell | Flips/min centre | Flips/min line | Wrong % | None % | Stray/min | Latency p50 | p90 | Within 1 s | Missed | Return p50 | Return within 1 s |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  rows.forEach(({ label, summary }) => {
    SIGNALS.forEach((signal) => {
      const s = summary[signal];
      const steps = s.steps ? `${s.missed}/${s.steps}` : "-";
      console.log(`| ${label} | ${signal} | ${fmt(s.centreFlipsPerMin)} | ${fmt(s.boundaryFlipsPerMin)} | ${fmt(s.wrongPct)} | ${fmt(s.nonePct)} | ${fmt(s.straysPerMin)} | ${fmt(s.latencyP50Ms / 1000, 2)} s | ${fmt(s.latencyP90Ms / 1000, 2)} s | ${fmt(s.withinBudgetPct, 0)} % | ${steps} | ${fmt(s.returnP50Ms / 1000, 2)} s | ${fmt(s.returnWithinBudgetPct, 0)} % |`);
    });
  });
}

function main(argv) {
  const option = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  const site = option("site", path.join(__dirname, "..", "public"));
  const method = option("method", null);
  const seeds = Number(option("seeds", "2"));
  const walkCmS = Number(option("walk-cm-s", "60"));
  const rigs = option("rigs", "ideal,rig").split(",");
  const only = option("tests", null);
  const centreRun = option("centre-run", null);
  const jsonOut = option("json", null);
  const tuneArg = JSON.parse(option("tune", "{}"));
  const tunes = Array.isArray(tuneArg) ? tuneArg : [tuneArg];
  const labelOf = (tune) => (Object.keys(tune).length ? JSON.stringify(tune).replace(/"/g, "") : "as is");
  const results = { method: method || "game default", seeds, walkCmS, rigs: {}, recording: null };

  rigs.forEach((rigName) => {
    if (!RIGS[rigName]) throw new Error(`no rig "${rigName}" (have ${Object.keys(RIGS).join(", ")})`);
    const rows = tunes.map((tune) => ({
      label: labelOf(tune),
      summary: summarise(runSimulated({ site, method, tune, rigName, seeds, walkCmS, only: only && only.split(",") })),
    }));
    results.rigs[rigName] = rows;
    printTable(`Rig "${rigName}" (${JSON.stringify(RIGS[rigName])}), method ${results.method}, ${seeds} seed(s), walking ${walkCmS} cm/s`, rows);
  });

  if (centreRun) {
    const rows = tunes.map((tune) => {
      const { totals, slots } = runRecording({
        site, method, tune, dir: centreRun, leftNode: option("left-node", null), rightNode: option("right-node", null),
      });
      return { label: labelOf(tune), summary: summarise(totals), slots };
    });
    results.recording = { dir: centreRun, rows };
    const sides = Object.entries(rows[0].slots).map(([id, slot]) => `node ${id} = ${slot === 0 ? "LEFT" : "RIGHT"}`).join(", ");
    printTable(`Recording ${centreRun} (${sides}): its still spots, and its steps timed from the move beep`, rows);
  }

  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  countFlips, countStrays, moveLatency, quantile, scoreStill, summarise,
  simulate, startGame, stillPath, stepPath, returnPath, runSimulated, runRecording, RIGS, LOCK_ON_MS,
};
