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
// Each segment exercises a different branch. Values are [left, centre, right].

function buildStream() {
  const rand = lcg(20260913);
  const jitter = (cm, spread) => round2(cm + (rand() * 2 - 1) * spread);
  const maybe = (value, dropRate) => (rand() < dropRate ? NO_ECHO : value);
  const wall = () => maybe(jitter(235, 6), 0.25);
  const steps = [];
  const push = (l, c, r) => steps.push([l, c, r]);

  // 1. Standing in the centre column: lock on, cell settles.
  for (let i = 0; i < 120; i++) push(wall(), jitter(70, 2), wall());

  // 2. Same spot with spikes and dropouts: slew gate and hold.
  for (let i = 0; i < 70; i++) {
    const roll = rand();
    const centre = roll < 0.12 ? round2(190 + rand() * 20)
      : roll < 0.22 ? NO_ECHO : jitter(70, 2);
    push(wall(), centre, wall());
  }

  // 3. Drift into the left column: column hysteresis.
  for (let i = 0; i < 120; i++) {
    const k = i / 119;
    push(jitter(230 - 170 * k, 2), jitter(70 + 110 * k, 2), wall());
  }

  // 4. Walk toward the screen in the left column: too-close on raw readings.
  for (let i = 0; i < 80; i++) push(jitter(60 - 57 * (i / 79), 1.5), wall(), wall());

  // 5. Back out.
  for (let i = 0; i < 40; i++) push(jitter(90, 2), wall(), wall());

  // 6. Nobody there: exceed the hold budget.
  for (let i = 0; i < 130; i++) push(maybe(jitter(260, 5), 0.5), NO_ECHO, maybe(jitter(260, 5), 0.5));

  // 7. Reappear in the right column: relock after the anchor has expired.
  for (let i = 0; i < 90; i++) push(wall(), wall(), jitter(120, 2));

  // 8. Dither across a row boundary: band hysteresis.
  for (let i = 0; i < 100; i++) push(wall(), wall(), jitter(100, 5));

  // 9. Intermittent fault, good and bad alternating: the streak policy's
  //    known blind spot, recorded so the Python port reproduces it exactly.
  for (let i = 0; i < 140; i++) push(wall(), wall(), i % 2 ? jitter(118, 2) : NO_ECHO);

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

  for (const file of ["alert.js", "callibrate_corners.js", "game.js"]) {
    vm.runInContext(fs.readFileSync(path.join(DISPLAYS, file), "utf8"), context,
      { filename: file });
  }
  const w = context;

  if (calibration) {
    // Capture order is BL, BC, BR, TR, TC, TL; each reads filtered[column].
    const order = [[0, "near"], [1, "near"], [2, "near"], [2, "far"], [1, "far"], [0, "far"]];
    for (const [column, edge] of order) {
      const filtered = [null, null, null];
      filtered[column] = calibration[column][edge === "near" ? 0 : 1];
      if (!w.captureCorner({ filtered })) throw new Error(`capture failed ${column} ${edge}`);
    }
    if (!w.getCalibrationBounds().calibrated) throw new Error("calibration did not take");
  }

  w.setGameInputMode("sensor");
  w.resetGame();
  const canvas = { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 };
  const node = (id) => ({ id, online: true, latest: null });
  const nodes = [node(1), node(2), node(3)];

  const out = [];
  stream.forEach((reading, i) => {
    clock = (i + 1) * STEP_MS;
    reading.forEach((value, s) => {
      nodes[s].latest = JSON.stringify({ avg: value === NO_ECHO ? -1 : value });
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
  return out;
}

const FIELDS = ["status", "gx", "gy", "rawGx", "rawGy", "column", "held", "heldFor", "filtered"];

const stream = buildStream();
const calibrated = [[28.47, 140.68], [20.44, 138.26], [10.89, 145.81]];

const trace = {
  generatedBy: "Website/tests/generate_parity_trace.js",
  stepMs: STEP_MS,
  fields: FIELDS,
  stream,
  runs: {
    default: { calibration: null, steps: runJs(stream, null) },
    calibrated: { calibration: calibrated, steps: runJs(stream, calibrated) },
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
