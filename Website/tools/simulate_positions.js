// simulate_positions.js - score the game's position methods on a simulated rig.
//
// Runs the REAL game.js (and the scripts it needs) headless in Node, feeds it
// two simulated servo scanner nodes, and reports how far the player's position
// is from where they really are, for each position method:
//
//     node Website/tools/simulate_positions.js
//     node Website/tools/simulate_positions.js --methods dyn,los --turn-ms 1000,250
//     node Website/tools/simulate_positions.js --site path/to/other/public --seeds 5
//
// The rig: nodes at x = 25 and 125 cm on the screen line, their servo angles
// turning towards screen-right as they grow (as the rig's do). A node scans
// only in its turn (the server's TURN / HALT), reading every 66 ms. The
// player is a body --body-half-width-cm either side of their middle (default
// 20): a head sees them while any of it is within BEAM_DEG of the servo's aim,
// both heads within BOTH_DEG (found), one of them otherwise (half-found), and
// the echo comes off the near side of them, --body-radius-cm short of their
// middle (default 15; 0 and 0 make the player a point). The firmware's servo
// steps 3 degrees towards the player when half-found and sweeps 14 degrees
// when lost. Distances carry 2 cm of noise. A --furniture x,y adds an object
// (a point) the beam can find instead of the player. The player walks a tour
// of the board at 60 cm/s, pausing at each stop. --tune '{"bodyRadiusCm": 0}'
// passes settings to the game's tuneSensor() first.
//
// Reported per method: median and 90th percentile position error (cm) over the
// frames with a position, and the share of frames in the right cell. Scores
// start after a 2 s settle. It is a model: use it to compare methods, and the
// game's Compare view on the rig to check them.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const SITE = option("site", path.join(__dirname, "..", "public"));
const METHODS = option("methods", "dyn,los,tri,avg").split(",");
const TURNS_MS = option("turn-ms", "1000,0").split(",").map(Number);   // 0 = both nodes at once
const SEEDS = Number(option("seeds", "3"));
const DURATION_S = Number(option("duration", "45"));
const FURNITURE = option("furniture", null);
const BODY_RADIUS_CM = Number(option("body-radius-cm", "15"));
const BODY_HALF_WIDTH_CM = Number(option("body-half-width-cm", "20"));
const TUNE = JSON.parse(option("tune", "{}"));

const NODE_X = [25, null, 125];
const BEAM_DEG = 15;
const BOTH_DEG = 6;
const SERVO_LIMITS = { 0: [40, 160], 2: [30, 140] };
const MESSAGE_MS = 66;
const FRAME_MS = 1000 / 60;
const WALK_CM_S = 60;
const SETTLE_MS = 2000;
// Stops on the tour: x, depth (cm), and how long to stand there (s).
const TOUR = [[75, 60, 3], [30, 50, 2], [30, 110, 2.5], [75, 120, 2], [120, 110, 2.5],
  [120, 50, 2], [75, 80, 3], [40, 80, 2], [110, 70, 2], [75, 80, 0]];

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function playerAt(tSeconds) {
  let t = tSeconds;
  for (let i = 0; i < TOUR.length - 1; i++) {
    const [ax, ay, dwell] = TOUR[i];
    const [bx, by] = TOUR[i + 1];
    if (t < dwell) return [ax, ay];
    t -= dwell;
    const walk = Math.hypot(bx - ax, by - ay) / WALK_CM_S;
    if (t < walk) return [ax + ((bx - ax) * t) / walk, ay + ((by - ay) * t) / walk];
    t -= walk;
  }
  return TOUR[TOUR.length - 1].slice(0, 2);
}

function loadGame() {
  let clock = 0;
  const quiet = { log() {}, info() {}, warn() {}, error: console.error };
  const context = { console: quiet, performance: { now: () => clock }, Image: class { set src(_) {} }, Math, JSON };
  context.window = context;
  vm.createContext(context);
  for (const file of ["alert.js", "callibrate_corners.js", "positionSolver.js", "gameStats.js", "game.js"]) {
    const full = path.join(SITE, "displays", file);
    if (fs.existsSync(full)) vm.runInContext(fs.readFileSync(full, "utf8"), context, { filename: file });
  }
  return { game: context, setClock: (t) => { clock = t; } };
}

// One node reading, and the firmware's servo move after it.
function scan(slot, servo, player, furniture, rand) {
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
  const nodeX = NODE_X[slot];
  const bearingTo = ([x, y]) => 90 + (Math.atan2(x - nodeX, y) * 180) / Math.PI;
  const aim = servo[slot];
  let distance = -1;
  let state = 2;
  const reach = Math.hypot(player[0] - nodeX, player[1]);
  // How far either side of the player's middle their body reaches, seen from the node.
  const bodyDeg = (Math.atan2(BODY_HALF_WIDTH_CM, reach) * 180) / Math.PI;
  const off = Math.max(0, Math.abs(bearingTo(player) - aim) - bodyDeg);
  if (off <= BEAM_DEG) {
    distance = Math.max(2, reach - BODY_RADIUS_CM) + 2 * gauss();
    state = off <= BOTH_DEG ? 0 : 1;
  } else if (furniture) {
    const furnitureOff = Math.abs(bearingTo(furniture) - aim);
    if (furnitureOff <= BEAM_DEG) {
      distance = Math.hypot(furniture[0] - nodeX, furniture[1]) + 2 * gauss();
      state = furnitureOff <= BOTH_DEG ? 0 : 1;
    }
  }
  const [low, high] = SERVO_LIMITS[slot];
  const target = state === 2 ? null : bearingTo(off <= BEAM_DEG ? player : furniture);
  if (state === 1) servo[slot] = Math.max(low, Math.min(high, aim + (target > aim ? 3 : -3)));
  if (state === 2) {
    servo[slot] += 14 * servo.dir[slot];
    if (servo[slot] > high || servo[slot] < low) {
      servo.dir[slot] = -servo.dir[slot];
      servo[slot] = Math.max(low, Math.min(high, servo[slot]));
    }
  }
  return { avg: distance, left: distance, right: distance, angle: aim, scanState: state };
}

function run(method, turnMs, seed) {
  const { game, setClock } = loadGame();
  const rand = lcg(seed);
  const canvas = { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 };
  // An older game (--site) without this method would quietly keep its own and
  // be scored under the wrong name.
  if (game.setPositionMethod && game.setPositionMethod(method) !== method) {
    throw new Error(`this game has no position method "${method}"`);
  }
  if (Object.keys(TUNE).length) game.tuneSensor(TUNE);
  game.setGameInputMode("sensor");
  game.resetGame();
  const nodes = [{ id: 1, online: true, latest: null }, null, { id: 3, online: true, latest: null }];
  const servo = { 0: 90, 2: 90, dir: { 0: 1, 2: 1 } };
  const furniture = FURNITURE ? FURNITURE.split(",").map(Number) : null;
  const errors = [];
  let frames = 0;
  let rightCell = 0;
  let stamp = 0;
  let nextMessage = 0;
  const rowOf = (y) => (y < 60 ? 0 : y < 110 ? 1 : 2);   // default bounds, 10-160 cm
  const columnOf = (x) => Math.max(0, Math.min(2, Math.floor(x / 50)));

  for (let t = 0; t < DURATION_S * 1000; t += FRAME_MS) {
    setClock(t);
    if (t >= nextMessage) {
      nextMessage += MESSAGE_MS;
      const slots = turnMs > 0 ? (Math.floor(t / turnMs) % 2 === 0 ? [0] : [2]) : [0, 2];
      const player = playerAt(t / 1000);
      slots.forEach((slot) => {
        nodes[slot].latest = JSON.stringify(scan(slot, servo, player, furniture, rand));
        stamp += 1;
        nodes[slot].last_seen = stamp;
      });
      game.markSensorFrame();
    }
    game.updateGame(t, canvas, nodes);
    if (t < SETTLE_MS) continue;

    frames += 1;
    const sensor = game.getGameState().sensor;
    const [px, py] = playerAt(t / 1000);
    if (sensor.status === "ok" && Number.isFinite(sensor.xCm)) {
      errors.push(Math.hypot(sensor.xCm - px, sensor.yCm - py));
      if (sensor.gx === columnOf(px) && sensor.gy === rowOf(py)) rightCell += 1;
    }
  }
  errors.sort((a, b) => a - b);
  const quantile = (q) => (errors.length ? errors[Math.min(errors.length - 1, Math.floor(q * errors.length))] : NaN);
  return { median: quantile(0.5), p90: quantile(0.9), cell: frames ? rightCell / frames : 0 };
}

const LABELS = { los: "Line of sight", tri: "Trilateration", avg: "Average" };
for (const turnMs of TURNS_MS) {
  const rig = turnMs > 0 ? `${turnMs} ms turns` : "both nodes at once";
  console.log(`\n${rig}${FURNITURE ? `, furniture at (${FURNITURE})` : ""} - ${SEEDS} seeds, ${DURATION_S} s each`);
  console.log("| Method | Median error | 90th percentile | Right cell |");
  console.log("|---|---|---|---|");
  for (const method of METHODS) {
    const total = { median: 0, p90: 0, cell: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const score = run(method, turnMs, seed * 11);
      Object.keys(total).forEach((key) => { total[key] += score[key] / SEEDS; });
    }
    console.log(`| ${LABELS[method] || method} | ${total.median.toFixed(1)} cm | ${total.p90.toFixed(1)} cm | ${(100 * total.cell).toFixed(0)} % |`);
  }
}
