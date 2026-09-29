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

  // The menu and setup screens are HTML pages over the canvas (see ui.js). Each
  // is filled before it is shown, so its default control exists to take focus.
  const page = HTML_SCREENS[screen];
  if (page) {
    page();
    window.showScreen(screen);
    return;
  }
  window.showScreen(null);

  if (screen === "game") {
    window.renderGame(ctx, c);
    return;
  }

  if (screen === "alert") {
    const fromGame = alertReturnScreen === "game";
    window.renderAlert(ctx, c, {
      active: true,
      distanceCm: fromGame ? window.getGameAlertInfo().distanceCm : null,
      showBack: !fromGame,
    });
  }
}

// Fills in each HTML screen from live state; called by draw().
const HTML_SCREENS = {
  menu: () => window.updateMenu(getSortedNodes()),
  options: () => window.updateOptionsScreen(),
  select_node: () => window.updateNodeSelectScreen(getSortedNodes()),
  logs: () => {
    const node = nodes.get(selectedNodeId) || { id: selectedNodeId ?? "?", address: "unknown address" };
    window.updateLogsScreen(node, logsBuffer.get(selectedNodeId) || []);
  },
  calibrate: () => window.updateCalibrateScreen(getSortedNodes()),
  calibrate_corners: () =>
    window.updateCalibrateCornersScreen(window.readSensorCoordinate(getCalibrateNodes())),
};

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

  // Out-of-bounds is the state people most often need explained, so show the
  // window the reading actually failed against.
  let why = "";
  if (debug.status === "out-of-bounds" && debug.bounds) {
    const { nearCm, farCm, calibrated } = debug.bounds;
    why =
      `  (play area ${nearCm.toFixed(0)}-${farCm.toFixed(0)}cm` +
      `, limit ${debug.limits.maxCm.toFixed(0)}cm` +
      `${calibrated ? "" : ", UNCALIBRATED"})`;
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

// Auto-advance fires at most once per visit to the calibration screen. Without
// this latch a nodes:update arriving milliseconds after the user presses Back
// on the corners page would bounce them straight forward again - with two
// nodes online the update stream runs at up to 40 messages per second.
let calibrateAutoContinueArmed = true;

// Both sensors identified means the rig is ready, so move straight on to
// corner calibration without waiting for a button press.
function maybeAutoContinueCalibration() {
  if (screen !== "calibrate") return;

  // Gate on identification, not just connectivity: two online sensors are
  // useless until we know which is left and which is right.
  if (!window.isSensorAssignmentComplete()) {
    calibrateAutoContinueArmed = true;
    return;
  }

  if (!calibrateAutoContinueArmed) return;
  calibrateAutoContinueArmed = false;
  screen = "calibrate_corners";
}

// The loop keeps running across the game <-> alert boundary so the sensors are
// still read while the alert is up - that is what lets it clear itself once the
// player steps back past the threshold.
function gameLoopTick(timestamp) {
  const runningScreen = screen === "game" || (screen === "alert" && alertReturnScreen === "game");
  if (!runningScreen) {
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

// Touching the phone pad takes the cursor over from the sensors; lifting the
// finger hands it straight back. The phone re-sends its position while a
// finger is held, so if it goes quiet (lost release, phone locked) the
// sensors take over again after REMOTE_IDLE_MS.
const REMOTE_IDLE_MS = 1000;
let remoteIdleTimer = null;

function releaseRemote() {
  window.clearTimeout(remoteIdleTimer);
  remoteIdleTimer = null;
  if (screen === "game" && window.getGameInputMode() === "remote") {
    window.setGameInputMode("sensor");
  }
}

// Commands relayed from the phone control panel (/control). The server only
// relays these when it was started with CON=1.
function handleRemoteCommand(command) {
  switch (command.action) {
    case "point":
      if (screen !== "game") break;
      if (window.getGameInputMode() !== "remote") window.setGameInputMode("remote");
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
      startGameWithMode(command.mode || "remote");
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
    default:
      return;
  }
  draw();
}

// Lets the control panel mirror the round. Cheap enough to send unconditionally;
// the server drops it when the control panel is disabled.
function sendGameStatus() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const state = window.getGameState();
  socket.send(JSON.stringify({
    type: "game:status",
    screen,
    status: state.status,
    mode: state.inputMode,
    score: state.score,
    lives: state.lives,
    level: state.level,
    remainingMs: state.remainingMs,
    activeHole: state.activeHole,
    moleType: state.moleType,
    remoteHole: state.remoteHole,
    testMode: window.getGameSettings().testMode,
  }));
}

window.setInterval(sendGameStatus, 250);

function connectSocket() {
  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    console.log("WebSocket connected");
    sentAssignmentKey = null;
    sentCalibrationKey = null;
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
      maybeAutoContinueCalibration();
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

    // Clicking to whack is a mouse-mode affordance only.
    if (window.getGameInputMode() === "mouse" && window.handleGameClick(c, point.x, point.y)) {
      draw();
    }
    return;
  }

  if (screen === "alert") {
    // A game-driven alert has no Back button; it clears when the player steps back.
    const showBack = alertReturnScreen !== "game";
    const hit = window.getAlertButtonAtPoint(c, point.x, point.y, showBack);
    if (hit && hit.type === "back") {
      screen = alertReturnScreen;
      stopAlertNoise();
      draw();
    }
    return;
  }

});

// Buttons on the HTML screens (index.html), routed here by ui.js. Keyed by
// screen, then by the button's data-action; `data` is the button's dataset.
const screenActions = {
  menu: {
    play() {
      calibrateAutoContinueArmed = true;
      window.resetSensorAssignment();
      screen = "calibrate";
    },
    options() {
      screen = "options";
    },
    logs() {
      if (nodes.size === 1) {
        selectedNodeId = getSortedNodes()[0]?.id ?? null;
        screen = "logs";
      } else {
        screen = "select_node";
      }
    },
  },
  options: {
    back() {
      screen = "menu";
    },
    duration(data) {
      window.setGameSettings({ durationMs: Number(data.value) });
    },
    lives(data) {
      window.setGameSettings({ startingLives: Number(data.value) });
    },
    sound() {
      window.setGameSettings({ soundEnabled: !window.getGameSettings().soundEnabled });
    },
    testMode() {
      window.setGameSettings({ testMode: !window.getGameSettings().testMode });
    },
  },
  select_node: {
    back() {
      screen = "menu";
    },
    node(data) {
      selectedNodeId = Number(data.node);
      screen = "logs";
    },
  },
  logs: {
    back() {
      screen = "menu";
      selectedNodeId = null;
    },
  },
  calibrate: {
    back() {
      screen = "menu";
    },
    reset() {
      window.resetSensorAssignment();
    },
    skip() {
      startGameWithMode("mouse");
    },
  },
  calibrate_corners: {
    back() {
      // Deliberate Back: hold the calibration screen instead of re-advancing.
      calibrateAutoContinueArmed = false;
      screen = "calibrate";
    },
    capture() {
      window.captureCorner(window.readSensorCoordinate(getCalibrateNodes()));
    },
    reset() {
      window.resetCornerCalibration();
    },
    skip() {
      startGameWithMode("mouse");
    },
    start() {
      if (window.isCornerCalibrationComplete()) startGameWithMode("sensor");
    },
  },
};

window.onScreenAction = function onScreenAction(action, data) {
  const handler = screenActions[screen] && screenActions[screen][action];
  if (!handler) return;
  handler(data);
  draw();
};

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
connectSocket();
