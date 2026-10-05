const c = document.getElementById("game");
const ctx = c.getContext("2d");

const nodes = new Map();
const logsBuffer = new Map();
// Node id per [left, centre, right]. The rig has two sensors, so the centre
// slot is always empty; only SENSOR_SLOTS are ever filled.
const calibrateSlotNodeIds = [null, null, null];
const SENSOR_SLOTS = [0, 2];
let selectedNodeId = null;
let viewport = { width: 0, height: 0, dpr: 1 };
const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const wsUrl = `${wsProtocol}://${location.hostname}:8765/browser`;
let socket = null;
let reconnectTimer = null;
let screen = "menu";
let gameLoopId = null;
// Which screen the alert returns to. A game-driven alert clears itself, so it
// has no Back button; the calibrate-driven one does.
let alertReturnScreen = "calibrate";
// The screen the control panel's held alert went up over, outside a round
// (holdAlert()); null when it is not up there.
let heldAlertFrom = null;
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
let alertOscillator = null;

function soundEnabled() {
  return !window.getGameSettings || window.getGameSettings().soundEnabled;
}

function playAlertNoise() {
  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }

  stopAlertNoise();

  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 520;
  gain.gain.value = 0.22;
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  alertOscillator = oscillator;
}

function stopAlertNoise() {
  if (alertOscillator) {
    alertOscillator.stop();
    alertOscillator = null;
  }
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;

  viewport = { width, height, dpr };
  c.style.width = `${width}px`;
  c.style.height = `${height}px`;
  c.width = Math.floor(width * dpr);
  c.height = Math.floor(height * dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

const sensorLocations = new Map();

function draw() {
  // console.log("Drawing screen:", screen, "selectedNodeId:", selectedNodeId, "nodes.size:", nodes.size);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);

  // Every screen change ends in a draw, so this is where the servo hold follows
  // the screen. It only sends when the wanted state changes. The same goes for
  // the Pulses button.
  syncNodesAim();
  syncNodesPulses();

  if (screen === "calibrate") {
    renderCalibrate(ctx, c, getSortedNodes());
    return;
  }

  if (screen === "game") {
    window.renderGame(ctx, c);
    return;
  }

  if (screen === "select_node") {
    renderNodeSelect(ctx, c, getSortedNodes());
    return;
  }

  if (screen === "logs" && selectedNodeId !== null) {
    const node = nodes.get(selectedNodeId) || { id: selectedNodeId, address: "unknown" };
    const entries = logsBuffer.get(selectedNodeId) || [];
    renderLogs(ctx, c, node, entries);
    return;
  }

  if (screen === "alert") {
    const fromGame = alertReturnScreen === "game";
    window.renderAlert(ctx, c, {
      active: true,
      distanceCm: fromGame ? window.getGameAlertInfo().distanceCm : null,
      showBack: !fromGame && heldAlertFrom === null,
      footer: fromGame ? "The game resumes automatically" : null,
    });
    return;
  }

  if (screen === "options") {
    window.renderOptions(ctx, c);
    return;
  }

  const statusText = nodes.size > 0
    ? `Node count: ${nodes.size} | Total RPS: ${Array.from(nodes.values()).reduce((sum, node) => sum + (node.rps || 0), 0).toFixed(1)}`
    : "Waiting for ESP32 data...";

  renderMenu(ctx, c, statusText, getSortedNodes());
}

function getSortedNodes() {
  return Array.from(nodes.values()).sort((a, b) => a.id - b.id);
}

// --- Console diagnostics ---------------------------------------------------
// With two sensors the node stream arrives at up to 40 messages a second, so
// the periodic dump is throttled. Events that are rare and interesting - a node
// dropping out, the sensor state changing - are logged the moment they happen.

const nodeLogging = {
  enabled: true,
  intervalMs: 500,
  lastAt: -Infinity,
  lastRoster: "",
  lastStatus: null,
  lastAssignment: "",
};

const SLOT_NAMES = ["LEFT", "CENTRE", "RIGHT"];

// nodeLog()       - toggle
// nodeLog(false)  - off
// nodeLog(250)    - on, dumping at most every 250ms
window.nodeLog = function nodeLog(option) {
  if (typeof option === "number") {
    nodeLogging.intervalMs = Math.max(0, option);
    nodeLogging.enabled = true;
  } else if (typeof option === "boolean") {
    nodeLogging.enabled = option;
  } else {
    nodeLogging.enabled = !nodeLogging.enabled;
  }
  console.info(
    `[nodes] logging ${nodeLogging.enabled ? "ON" : "OFF"} (every ${nodeLogging.intervalMs}ms)`
  );
  return nodeLogging.enabled;
};

// One row per connected sensor, including which slot it was assigned to.
function nodeRows() {
  const assignment = window.getSensorAssignment();

  return getSortedNodes().map((node) => {
    const slotIndex = assignment.indexOf(node.id);
    const distance = window.readNodeDistance(node);
    return {
      node: node.id,
      slot: slotIndex === -1 ? "--" : SLOT_NAMES[slotIndex],
      cm: distance === null ? null : Number(distance.toFixed(1)),
      online: node.online,
      rps: Number((node.rps || 0).toFixed(1)),
      address: node.address,
    };
  });
}

window.nodeTable = function nodeTable() {
  const rows = nodeRows();
  console.table(rows);
  return rows;
};

function logNodes() {
  if (!nodeLogging.enabled) return;

  const now = performance.now();
  const sorted = getSortedNodes();

  // Roster changes bypass the throttle - losing a sensor matters immediately.
  const roster = sorted.map((node) => `${node.id}:${node.online ? 1 : 0}`).join(",");
  const rosterChanged = roster !== nodeLogging.lastRoster;
  nodeLogging.lastRoster = roster;

  // So does a slot assignment landing.
  const assignment = window.getSensorAssignment().join(",");
  const assignmentChanged = assignment !== nodeLogging.lastAssignment;
  nodeLogging.lastAssignment = assignment;

  if (assignmentChanged) {
    const assignment = window.getSensorAssignment();
    const named = SENSOR_SLOTS
      .map((i) => `${SLOT_NAMES[i]}=${assignment[i] === null ? "--" : "node " + assignment[i]}`)
      .join("  ");
    console.info(`[assign] ${named}`);
  }

  if (!rosterChanged && !assignmentChanged && now - nodeLogging.lastAt < nodeLogging.intervalMs) {
    return;
  }
  nodeLogging.lastAt = now;

  if (rosterChanged) console.info(`[nodes] roster changed -> ${sorted.length} connected`);
  console.table(nodeRows());
}

// Sensor state transitions, logged from the game loop as they occur.
function logSensorStatus() {
  if (!nodeLogging.enabled) return;
  if (window.getGameInputMode() !== "sensor") return;

  const debug = window.getSensorDebug();
  const status = `${debug.status}${debug.held ? ":held" : ""}`;
  if (status === nodeLogging.lastStatus) return;
  nodeLogging.lastStatus = status;

  const where = debug.grid ? `grid(${debug.grid.gx},${debug.grid.gy})` : "no coordinate";
  const distance = debug.distanceCm === null ? "--" : `${debug.distanceCm.toFixed(1)}cm`;

  // Out of bounds and Sensors offline each have one cause: say which.
  let why = "";
  if (debug.status === "out-of-bounds") {
    why = `  (both nodes lost over their last ${debug.tuning.lostReadings} readings)`;
  } else if (debug.status === "offline") {
    why = `  (no reading from either node for ${(debug.tuning.offlineMs / 1000).toFixed(1)} s)`;
  }

  console.info(
    `[sensor] ${status.toUpperCase()}  ${where}  ${distance}` +
      `  bad=${debug.badReadings}/${debug.holdBudget}${why}`
  );
}

console.info(
  "%c[ENG3000]%c  logging: nodeLog(false) \u00b7 nodeTable() \u00b7 getSensorDebug()\n" +
    "           tuning:  tuneSensor({cellWindow:150})\n" +
    "           testing: testMode()",
  "color:#22c55e;font-weight:bold",
  "color:inherit"
);

function getCanvasPoint(event) {
  const rect = c.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

// Slot ordering comes from the hand-wave assignment on the calibration screen.
// Ascending node ID is only a fallback for the Skip path, where the operator
// has chosen not to identify the sensors - it is arbitrary and probably wrong,
// but it keeps mouse mode and the debug views working.
function updateCalibrateSlots(nextNodes) {
  const assigned = window.getSensorAssignment();

  if (window.isSensorAssignmentComplete()) {
    assigned.forEach((nodeId, index) => {
      calibrateSlotNodeIds[index] = nodeId;
    });
    return;
  }

  const nextIds = new Set(nextNodes.map((node) => node.id));

  // Seed from whatever the assignment has resolved so far.
  assigned.forEach((nodeId, index) => {
    calibrateSlotNodeIds[index] = nodeId !== null && nextIds.has(nodeId) ? nodeId : null;
  });

  // Fill the remaining sensor slots, never the centre, which has no sensor.
  nextNodes
    .slice()
    .sort((a, b) => a.id - b.id)
    .forEach((node) => {
      if (calibrateSlotNodeIds.includes(node.id)) return;

      const emptySlot = SENSOR_SLOTS.find((slot) => calibrateSlotNodeIds[slot] === null);
      if (emptySlot !== undefined) {
        calibrateSlotNodeIds[emptySlot] = node.id;
      }
    });
}

function getCalibrateNodes() {
  return calibrateSlotNodeIds.map((nodeId) => (nodeId === null ? null : nodes.get(nodeId) || null));
}

// --- Servos held straight while calibrating -----------------------------------
// While the calibration screen is up, every node's servo is held at 90 degrees
// so the operator can aim the nodes straight out into the play area by hand;
// on any other screen the nodes scan. The server passes it on to each node
// (AIM 90 / SCAN), holding while any open page is on this screen. Sent
// whenever the wanted state changes, and again after a reconnect, since a
// restarted server has forgotten it.
let sentNodesAim = null;

function syncNodesAim() {
  const hold = screen === "calibrate";
  if (hold === sentNodesAim) return;
  if (sendToServer({ type: "nodes:aim", hold })) sentNodesAim = hold;
}

// --- Multi-pulse (the Pulses button on the game screen) ----------------------
// The server passes the count on to every node (PULSES <n>, 1 = off). Sent when
// it changes, and again after a reconnect, since a restarted server has
// forgotten it.
let sentPulsesPerAngle = null;

function syncNodesPulses() {
  const count = window.getGameSettings().pulsesPerAngle;
  if (count === sentPulsesPerAngle) return;
  if (sendToServer({ type: "nodes:pulses", count })) sentPulsesPerAngle = count;
}

// --- Empty room (the Room button on the game screen) --------------------------
// The server tells every node to learn the room (LEARN): with nobody in the play
// area, each sweeps its range and from then on ignores the room's echoes. The
// nodes report their progress in each reading, which the button shows. A press
// while they are still learning is ignored rather than starting over.
function learnRoom() {
  if (window.getGameRoomStatus() === "learning") return;
  if (sendToServer({ type: "nodes:room", action: "learn" })) {
    window.noteGameRoomRequested();
    console.info("[scan] Learning the room");
  }
}

// A round is on screen: the game, or the alert it raised.
function roundOnScreen() {
  return screen === "game" || (screen === "alert" && alertReturnScreen === "game");
}

// The loop keeps running across the game <-> alert boundary so the sensors are
// still read while the alert is up - that is what lets it clear itself once the
// player steps back past the threshold.
function gameLoopTick(timestamp) {
  if (!roundOnScreen()) {
    gameLoopId = null;
    return;
  }

  window.updateGame(timestamp, c, getCalibrateNodes());
  logSensorStatus();

  if (window.isGameAlertActive()) {
    if (screen !== "alert") {
      alertReturnScreen = "game";
      screen = "alert";
      if (soundEnabled()) playAlertNoise();
    }
  } else if (screen === "alert" && alertReturnScreen === "game") {
    screen = "game";
    stopAlertNoise();
  }

  draw();
  gameLoopId = requestAnimationFrame(gameLoopTick);
}

function startGameLoop() {
  if (gameLoopId === null) {
    gameLoopId = requestAnimationFrame(gameLoopTick);
  }
}

function stopGameLoop() {
  if (gameLoopId !== null) {
    cancelAnimationFrame(gameLoopId);
    gameLoopId = null;
  }
}

// Single entry point into a round, from either Skip (mouse) or the corner
// calibration screen (sensor).
// --- Server-side filtering (SERVER_FILTERING on the server) -----------------
// The server reports its flag through nodes:update: with the flag on the
// message carries a "coordinate" field (null until it has one); with it off
// the field is absent. Off is the default, and then nothing in this section
// sends or changes anything - game.js filters in the browser exactly as before.
let serverFiltering = false;
// What the server was last sent, so an unchanged setup is not resent: a
// sensors:assign resets the server's filters. Cleared on every (re)connect,
// since a restarted server has forgotten both.
let sentAssignmentKey = null;
let sentCalibrationKey = null;
let sentPositionMethod = null;
let sentLostReadings = null;
let sentKalman = null;
let sentAngleLimit = null;
let sentTriAimTolerance = null;
let sentDeadZone = null;
let sentCellDecision = null;
let sentDynamicRules = null;
let sentConfidenceLevel = null;
let sentFarHalf = null;

function sendToServer(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function applyServerFilteringFlag(payload) {
  const reported = Object.prototype.hasOwnProperty.call(payload, "coordinate");
  if (reported !== serverFiltering) {
    serverFiltering = reported;
    window.setServerFilteringActive(serverFiltering);
    console.info(`[server] filtering ${serverFiltering ? "ON - using the server coordinate" : "OFF - filtering in the browser"}`);
  }
  if (serverFiltering) window.setServerCoordinate(payload.coordinate);
}

// The server cannot work out either of these itself: node IDs follow TCP
// connection order, and the play area is captured on the corners screen.
// Each is sent once complete, and again if it changes. Start Game needs both,
// so the server always has them before a sensor round.
//
// The assignment goes whatever the filtering flag: the server passes each
// scanner node its role (ROLE LEFT / ROLE RIGHT), which sets its servo limits.
function syncServerFilterSetup() {
  if (window.isSensorAssignmentComplete()) {
    const slots = window.getSensorAssignment();
    const key = JSON.stringify(slots);
    if (key !== sentAssignmentKey && sendToServer({ type: "sensors:assign", slots })) {
      sentAssignmentKey = key;
    }
  }

  if (!serverFiltering) return;

  // The position switch, so the server's chain places the player the same way.
  const method = window.getPositionMethod();
  if (method !== sentPositionMethod && sendToServer({ type: "position:method", method })) {
    sentPositionMethod = method;
  }

  // And the readings each node's lost score is taken over (Out of bounds).
  const lostReadings = window.getLostReadings();
  if (lostReadings !== sentLostReadings && sendToServer({ type: "sensor:lostReadings", count: lostReadings })) {
    sentLostReadings = lostReadings;
  }

  // The Kalman switch, so the server's chain smooths the same way.
  const kalman = window.getKalman();
  if (kalman !== sentKalman && sendToServer({ type: "filter:kalman", on: kalman })) {
    sentKalman = kalman;
  }

  // The angle limit switch, so the server's chain drops the same readings.
  const angleLimit = window.getAngleLimit();
  if (angleLimit !== sentAngleLimit && sendToServer({ type: "filter:angleLimit", on: angleLimit })) {
    sentAngleLimit = angleLimit;
  }

  // The tri aim tolerance switch, so the server's chain trilaterates the same way.
  const triAimTolerance = window.getTriAimTolerance();
  if (triAimTolerance !== sentTriAimTolerance &&
      sendToServer({ type: "filter:triAimTolerance", on: triAimTolerance })) {
    sentTriAimTolerance = triAimTolerance;
  }

  // The dead zone switch, so the server's chain checks too close the same way.
  const deadZone = window.getDeadZone();
  if (deadZone !== sentDeadZone && sendToServer({ type: "filter:deadZone", on: deadZone })) {
    sentDeadZone = deadZone;
  }

  // The cell decision switch, so the server's chain decides the cell the same way.
  const cellDecision = window.getCellDecision();
  if (cellDecision !== sentCellDecision &&
      sendToServer({ type: "filter:cellDecision", on: cellDecision })) {
    sentCellDecision = cellDecision;
  }

  // Dynamic's rule switches, so the server's chain places the player the same way.
  const rules = window.getDynamicRules();
  const rulesKey = JSON.stringify(rules);
  if (rulesKey !== sentDynamicRules && sendToServer({ type: "sensor:dynamicRules", rules })) {
    sentDynamicRules = rulesKey;
  }

  // The confidence level Dynamic's first rule places a node alone at.
  const confidenceLevel = window.getConfidenceLevel();
  if (confidenceLevel !== sentConfidenceLevel &&
    sendToServer({ type: "sensor:confidenceLevel", pct: confidenceLevel })) {
    sentConfidenceLevel = confidenceLevel;
  }

  // The far half switch, so the server's chain scores readings the same way.
  const farHalf = window.getFarHalf();
  if (farHalf !== sentFarHalf && sendToServer({ type: "sensor:farHalf", on: farHalf })) {
    sentFarHalf = farHalf;
  }

  const perColumn = window.getCapturedCalibration();
  if (perColumn) {
    const key = JSON.stringify(perColumn);
    if (key !== sentCalibrationKey && sendToServer({ type: "calibration:update", perColumn })) {
      sentCalibrationKey = key;
    }
  }
}

function startGameWithMode(mode) {
  syncServerFilterSetup();
  stopGameLoop();
  stopAlertNoise();
  window.setGameInputMode(mode);
  window.resetGame();
  alertReturnScreen = "game";
  screen = "game";
  startGameLoop();
}

// Touching the phone pad takes the cursor over from whichever mode is
// running (sensors or mouse), and nothing else on the screen changes; lifting
// the finger hands it straight back. The phone re-sends its position while a
// finger is held, so if it goes quiet (lost release, phone locked) the mode
// takes over again after REMOTE_IDLE_MS.
const REMOTE_IDLE_MS = 1000;
let remoteIdleTimer = null;

function releaseRemote() {
  window.clearTimeout(remoteIdleTimer);
  remoteIdleTimer = null;
  window.releaseRemotePoint();
}

// The control panel's "Hold: too close" button (Aaron, 5 Oct): the too-close
// alert is up while a finger is on it, from any screen, and lifting the
// finger goes back. In a round the game loop puts it up and takes it down, as
// for a real one, and the round waits (isSensorBlocked() in game.js); on any
// other screen it goes up here, over that screen. The phone re-sends the hold
// while the finger is down, so if it goes quiet the alert drops after
// REMOTE_IDLE_MS.
let alertHoldTimer = null;

function holdAlert(on) {
  window.clearTimeout(alertHoldTimer);
  alertHoldTimer = null;
  window.setAlertHeld(on);
  if (on) {
    alertHoldTimer = window.setTimeout(() => holdAlert(false), REMOTE_IDLE_MS);
    if (!roundOnScreen() && screen !== "alert") {
      heldAlertFrom = screen;
      alertReturnScreen = screen;
      screen = "alert";
      if (soundEnabled()) playAlertNoise();
    }
  } else {
    // Back to the screen it went up over, unless a round has started since.
    if (heldAlertFrom !== null && screen === "alert" && alertReturnScreen !== "game") {
      screen = heldAlertFrom;
      stopAlertNoise();
    }
    heldAlertFrom = null;
  }
  draw();
}

// Commands relayed from the phone control panel (/control). The server only
// relays these when it was started with CON=1.
function handleRemoteCommand(command) {
  switch (command.action) {
    case "point":
      // Also over the too-close alert: the phone placing the player clears it.
      if (!roundOnScreen()) break;
      window.setRemotePoint(command.x, command.y);
      window.clearTimeout(remoteIdleTimer);
      remoteIdleTimer = window.setTimeout(() => {
        releaseRemote();
        draw();
      }, REMOTE_IDLE_MS);
      break;
    case "release":
      releaseRemote();
      break;
    case "start":
      startGameWithMode(command.mode || "sensor");
      break;
    case "mode":
      if (screen === "game") window.setGameInputMode(command.mode);
      break;
    case "pause":
      window.pauseGame();
      break;
    case "resume":
      window.resumeGame();
      break;
    case "restart":
      startGameWithMode(window.getGameInputMode());
      break;
    case "menu":
      stopGameLoop();
      stopAlertNoise();
      screen = "menu";
      break;
    case "testMode":
      window.setGameSettings({ testMode: Boolean(command.enabled) });
      break;
    case "position":
      // The position switch, which is on the control panel only: Dynamic,
      // line of sight, trilateration or their average. An unknown method is
      // ignored.
      window.setPositionMethod(command.method);
      syncServerFilterSetup();
      break;
    case "compare":
      // Compare: each method's ring on the control panel's pad.
      window.setPositionCompare(command.enabled);
      break;
    case "lostReadings":
      // How many readings each node's lost score is taken over (Out of
      // bounds when both nodes are lost). Clamped by the game.
      window.setLostReadings(command.count);
      syncServerFilterSetup();
      break;
    case "kalman":
      // The Kalman switch: both of the game's Kalman filters on or off.
      window.setKalman(command.enabled);
      syncServerFilterSetup();
      break;
    case "angleLimit":
      // The angle limit: line of sight and Dynamic's node rules drop a reading
      // further than its servo line runs on the grid, or take every one.
      window.setAngleLimit(command.enabled);
      syncServerFilterSetup();
      break;
    case "triAimTolerance":
      // Trilateration's aim tolerance: its beam check lets a crossing be 20
      // degrees further off each servo's aim, or holds it to the beam.
      window.setTriAimTolerance(command.enabled);
      syncServerFilterSetup();
      break;
    case "deadZone":
      // The dead zone: too close by each reading's depth along its servo
      // line, or by the reading itself.
      window.setDeadZone(command.enabled);
      syncServerFilterSetup();
      break;
    case "cellDecision":
      // The cell decision: the margin, the dwell and each node against
      // itself, or the older vote.
      window.setCellDecision(command.enabled);
      syncServerFilterSetup();
      break;
    case "cellLock":
      // The cell lock: the drawn cursor, and the hole it scores in, keep to
      // the voted cell. Drawing only, so the server's chain is not told.
      window.setCellLock(command.enabled);
      break;
    case "tooCloseHold":
      // The hold button, down (and re-sent while held) or up.
      holdAlert(Boolean(command.on));
      break;
    case "dynamicRules":
      // Dynamic's rules on or off: { farPriority, confidenceNode, columnLock,
      // loneNode, cornerNode }, only the switches named.
      window.setDynamicRules(command.rules);
      syncServerFilterSetup();
      break;
    case "confidenceLevel":
      // The confidence level, in percent, at which a node places the player
      // on its own (Dynamic's first rule). Clamped by the game.
      window.setConfidenceLevel(command.pct);
      syncServerFilterSetup();
      break;
    case "farHalf":
      // Far half: a half reading in the back row counts as found towards
      // Out of bounds, or as half.
      window.setFarHalf(command.enabled);
      syncServerFilterSetup();
      break;
    default:
      return;
  }
  draw();
}

// Lets the control panel mirror the round. Cheap enough to send unconditionally;
// the server drops it when the control panel is disabled. The cursor is only
// current while the game loop runs; on any other screen it is whatever the
// last round left behind, so it is not sent.
function sendGameStatus() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const state = window.getGameState();
  socket.send(JSON.stringify({
    type: "game:status",
    screen,
    status: state.status,
    mode: state.inputMode,
    remote: window.isRemoteActive(),
    score: state.score,
    lives: state.lives,
    level: state.level,
    remainingMs: state.remainingMs,
    activeHole: state.activeHole,
    moleType: state.moleType,
    remoteHole: state.remoteHole,
    cursor: roundOnScreen() ? window.getGameCursorStatus(c) : null,
    testMode: window.getGameSettings().testMode,
    positionMethod: window.getPositionMethod(),
    positionMethods: window.getPositionMethods(),
    dynamicFollowing: window.getDynamicFollowing(),
    compare: window.getPositionCompare(),
    lostReadings: window.getLostReadings(),
    lostScores: window.getLostScores(),
    kalman: window.getKalman(),
    angleLimit: window.getAngleLimit(),
    triAimTolerance: window.getTriAimTolerance(),
    deadZone: window.getDeadZone(),
    cellLock: window.getCellLock(),
    cellDecision: window.getCellDecision(),
    alertHeld: window.isAlertHeld(),
    dynamicRules: window.getDynamicRules(),
    confidenceLevel: window.getConfidenceLevel(),
    farHalf: window.getFarHalf(),
  }));
}

// 10 Hz, so the cursor mirrored on the phone glides rather than steps.
window.setInterval(sendGameStatus, 100);

function connectSocket() {
  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    console.log("WebSocket connected");
    sentAssignmentKey = null;
    sentCalibrationKey = null;
    sentNodesAim = null;
    sentPulsesPerAngle = null;
    syncNodesAim();
    syncNodesPulses();
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "nodes:update") {
      payload.nodes.forEach((node) => {
        if (node.latest) {
          if (!logsBuffer.has(node.id)) logsBuffer.set(node.id, []);
          const buf = logsBuffer.get(node.id);
          buf.push({ time: Date.now(), data: node.latest });
          if (buf.length > 200) buf.splice(0, buf.length - 200);
        }
      });
      nodes.clear();
      payload.nodes.forEach((node) => nodes.set(node.id, node));

      // Tells the sensor pipeline a genuinely new reading has landed, so its
      // bad-reading budget counts readings rather than render frames.
      window.markSensorFrame();
      applyServerFilteringFlag(payload);

      if (screen === "calibrate") {
        window.updateSensorAssignment(getSortedNodes());
      }
      updateCalibrateSlots(payload.nodes);
      syncServerFilterSetup();
      logNodes();
      draw();
    } else if (payload.type === "remote:command") {
      handleRemoteCommand(payload);
    } else if (payload.type === "menu:status") {
      console.log(payload.message);
    }
  });

  socket.addEventListener("close", () => {
    console.error("WebSocket closed. Reconnecting...");
    // No server, no coordinate: the round pauses on "no signal" rather than
    // playing on a frozen one.
    if (serverFiltering) window.setServerCoordinate(null);
    // A restarted server has forgotten the position method, the lost
    // readings, the Kalman, angle limit, tri aim tolerance, dead zone and far
    // half switches, Dynamic's rule switches and the confidence level; send
    // them again.
    sentPositionMethod = null;
    sentLostReadings = null;
    sentKalman = null;
    sentAngleLimit = null;
    sentTriAimTolerance = null;
    sentDeadZone = null;
    sentCellDecision = null;
    sentDynamicRules = null;
    sentConfidenceLevel = null;
    sentFarHalf = null;
    if (reconnectTimer === null) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectSocket();
      }, 1000);
    }
  });

  socket.addEventListener("error", () => {
    console.error("WebSocket error");
  });
}

c.addEventListener("mousemove", (event) => {
  // In sensor mode the cursor belongs to the sensor reading, so the mouse must
  // not move it or score with it.
  if (screen !== "game" || window.getGameInputMode() !== "mouse") return;

  const pointer = getCanvasPoint(event);
  window.setGameCursor(c, pointer.x, pointer.y);
  if (window.handleGameHover(c, pointer.x, pointer.y)) {
    draw();
  }
});

c.addEventListener("click", (event) => {
  const point = getCanvasPoint(event);

  if (screen === "select_node") {
    const hit = window.getNodeSelectButtonAtPoint(c, getSortedNodes(), point.x, point.y);
    if (hit) {
      if (hit.type === "back") {
        screen = "menu";
      } else if (hit.type === "node") {
        selectedNodeId = hit.nodeId;
        screen = "logs";
      }
      draw();
    }
    return;
  }

  if (screen === "calibrate") {
    const hit = window.getCalibrateButtonAtPoint(c, point.x, point.y);
    if (hit) {
      if (hit.type === "back") {
        screen = "menu";
      } else if (hit.type === "reset") {
        window.resetSensorAssignment();
      } else if (hit.type === "skip") {
        startGameWithMode("mouse");
      } else if (hit.type === "start") {
        startGameWithMode("sensor");
      }
      draw();
    }
    return;
  }

  if (screen === "game") {
    const pauseMenuHit = window.getPauseMenuButtonAtPoint(c, point.x, point.y);
    if (pauseMenuHit) {
      if (pauseMenuHit.type === "resume") {
        window.resumeGame();
      } else if (pauseMenuHit.type === "restart") {
        // Through startGameWithMode so the round is fully reset, exactly as
        // when it was first started.
        startGameWithMode(window.getGameInputMode());
      } else if (pauseMenuHit.type === "menu") {
        stopGameLoop();
        screen = "menu";
      }
      draw();
      return;
    }

    if (window.getGameState().status === "paused") {
      // Round is paused and the click missed all pause-menu buttons - ignore
      // everything else (moles, etc.) until resumed.
      return;
    }

    const pauseButtonHit = window.getGamePauseButtonAtPoint(c, point.x, point.y);
    if (pauseButtonHit) {
      window.pauseGame();
      draw();
      return;
    }

    if (window.getGamePulsesButtonAtPoint(c, point.x, point.y)) {
      window.cycleGamePulses();
      draw(); // draw() sends the new count on to the nodes
      return;
    }

    if (window.getGameRoomButtonAtPoint(c, point.x, point.y)) {
      learnRoom();
      draw();
      return;
    }

    const overButton = window.getGameOverButtonAtPoint(c, point.x, point.y);
    if (overButton) {
      if (overButton.type === "restart") {
        startGameWithMode(window.getGameInputMode());
      } else if (overButton.type === "return") {
        screen = "menu";
        stopGameLoop();
      }
      draw();
      return;
    }

    // Clicking to whack is a mouse-mode affordance only, and not while the
    // phone pad has the cursor.
    if (window.getGameInputMode() === "mouse" && !window.isRemoteActive() &&
        window.handleGameClick(c, point.x, point.y)) {
      draw();
    }
    return;
  }

  if (screen === "logs") {
    const hit = window.getLogsButtonAtPoint(c, point.x, point.y);
    if (hit && hit.type === "back") {
      screen = "menu";
      selectedNodeId = null;
      draw();
    }
    return;
  }

  if (screen === "alert") {
    // A game-driven alert has no Back button; it clears when the player steps
    // back. Nor has the control panel's held one: it clears when let go.
    const showBack = alertReturnScreen !== "game" && heldAlertFrom === null;
    const hit = window.getAlertButtonAtPoint(c, point.x, point.y, showBack);
    if (hit && hit.type === "back") {
      screen = alertReturnScreen;
      stopAlertNoise();
      draw();
    }
    return;
  }

  if (screen === "options") {
    const hit = window.getOptionsButtonAtPoint(c, point.x, point.y);
    if (hit) {
      if (hit.type === "back") {
        screen = "menu";
      } else if (hit.type === "duration") {
        window.setGameSettings({ durationMs: hit.value });
      } else if (hit.type === "lives") {
        window.setGameSettings({ startingLives: hit.value });
      } else if (hit.type === "sound") {
        const current = window.getGameSettings();
        window.setGameSettings({ soundEnabled: !current.soundEnabled });
      } else if (hit.type === "testMode") {
        const current = window.getGameSettings();
        window.setGameSettings({ testMode: !current.testMode });
      }
      draw();
    }
    return;
  }

  const choice = window.getMenuButtonAtPoint(c, point.x, point.y);
  if (choice === "Play") {
    window.resetSensorAssignment();
    screen = "calibrate";
    draw();
    return;
  }

  if (choice === "Options") {
    screen = "options";
    draw();
    return;
  }

  if (choice === "Logs") {
    if (nodes.size === 1) {
      selectedNodeId = getSortedNodes()[0]?.id ?? null;
      screen = "logs";
    } else {
      screen = "select_node";
    }
    draw();
    return;
  }

  if (choice && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "menu:select", option: choice }));
  }
});

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
connectSocket();
