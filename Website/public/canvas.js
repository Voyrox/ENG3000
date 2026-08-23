const c = document.getElementById("game");
const ctx = c.getContext("2d");

const nodes = new Map();
const logsBuffer = new Map();
const calibrateSlotNodeIds = [null, null, null];
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

  if (screen === "calibrate") {
    renderCalibrate(ctx, c, getSortedNodes());
    return;
  }

  if (screen === "calibrate_corners") {
    window.renderCalibrateCorners(ctx, c, window.readSensorCoordinate(getCalibrateNodes()));
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
      showBack: !fromGame,
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
// With three sensors the node stream arrives at up to 60 messages a second, so
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

// --- Session recorder ------------------------------------------------------
// Captures one row per reading so a real test run can be exported and analysed
// offline. Recording starts and stops with the round automatically, so a normal
// play session is captured without anyone having to remember.
//
// Everything is organised by sensor - left, centre, right - because that is the
// axis a rig problem actually lives on: one flaky sensor, not one flaky frame.

const RECORD_CAP = 40000; // ~11 minutes at 60 readings/sec, then oldest drop out
const SENSOR_NAMES = ["left", "centre", "right"];

const recorder = {
  on: false,
  auto: true,
  rows: [],
  startedAt: 0,
  dropped: 0,
  meta: {},
  saved: true,
};

function roundCm(value) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(2));
}

function recordReading() {
  if (!recorder.on) return;

  const debug = window.getSensorDebug();
  const assignment = window.getSensorAssignment();
  const bounds = debug.bounds || {};

  // Raw values come straight from the nodes rather than from the pipeline
  // snapshot: the pipeline only runs during a round, so sourcing them from
  // there would record nothing but nulls on the calibration screens - which is
  // exactly where a rig is usually being diagnosed.
  const raw = getCalibrateNodes().map((node) => window.readNodeDistance(node));
  const filtered = debug.filtered || [null, null, null];
  const rejected = debug.rejected || [null, null, null];

  recorder.rows.push({
    t: Math.round(performance.now() - recorder.startedAt),
    screen,
    sensors: [0, 1, 2].map((i) => ({
      node: assignment[i],
      raw: roundCm(raw[i]),
      filtered: roundCm(filtered[i]),
      rejected: rejected[i],
    })),
    column: debug.column === null || debug.column === undefined ? null : debug.column,
    distanceCm: roundCm(debug.distanceCm),
    status: debug.status,
    held: debug.held ? 1 : 0,
    badReadings: debug.badReadings,
    gx: debug.grid ? debug.grid.gx : null,
    gy: debug.grid ? debug.grid.gy : null,
    rawGx: debug.rawCell ? debug.rawCell.gx : null,
    rawGy: debug.rawCell ? debug.rawCell.gy : null,
    calibrated: bounds.calibrated ? 1 : 0,
    alertCm: roundCm(debug.limits && debug.limits.alertCm),
    maxCm: roundCm(debug.limits && debug.limits.maxCm),
  });

  if (recorder.rows.length > RECORD_CAP) {
    recorder.rows.shift();
    recorder.dropped += 1;
  }
}

window.recordStart = function recordStart(meta) {
  if (!recorder.saved && recorder.rows.length > 0) {
    console.warn(
      `[record] discarding ${recorder.rows.length} unsaved rows from the previous run`
    );
  }
  recorder.rows = [];
  recorder.dropped = 0;
  recorder.startedAt = performance.now();
  recorder.meta = meta || {};
  recorder.on = true;
  recorder.saved = false;
  return true;
};

window.recordStop = function recordStop() {
  if (!recorder.on) return recorder.rows.length;
  recorder.on = false;

  const seconds = recorder.rows.length
    ? (recorder.rows[recorder.rows.length - 1].t - recorder.rows[0].t) / 1000
    : 0;
  console.info(
    `[record] round captured - ${recorder.rows.length} rows over ${seconds.toFixed(1)}s`
  );
  return recorder.rows.length;
};

// autoRecord()      - toggle
// autoRecord(false) - stop capturing rounds automatically
window.autoRecord = function autoRecord(enabled) {
  recorder.auto = typeof enabled === "boolean" ? enabled : !recorder.auto;
  console.info(`[record] auto-record ${recorder.auto ? "ON" : "OFF"}`);
  return recorder.auto;
};

// Called when a round begins and ends, so a play session is captured without
// anyone having to remember to start it.
function autoRecordStart(mode) {
  if (!recorder.auto) return;
  window.recordStart({ mode, startedAt: new Date().toISOString() });
  console.info(`[record] auto-started (${mode} mode)`);
}

function autoRecordStop(reason) {
  if (!recorder.on) return;
  recorder.meta.endedBy = reason;
  const state = window.getGameState();
  recorder.meta.finalScore = state.score;
  recorder.meta.finalLevel = state.level;
  window.recordStop();
  if (recorder.auto) uploadRound();
}

// --- Per-sensor summary -----------------------------------------------------

function summariseSensor(index) {
  const name = SENSOR_NAMES[index];
  const values = [];
  let noEcho = 0;
  let node = null;

  recorder.rows.forEach((row) => {
    const sensor = row.sensors[index];
    if (node === null && sensor.node !== null) node = sensor.node;
    if (sensor.raw === null) noEcho += 1;
    else values.push(sensor.raw);
  });

  const last = recorder.rows[recorder.rows.length - 1];
  const rejected = last ? last.sensors[index].rejected : 0;

  if (values.length === 0) {
    return { sensor: name, node, readings: 0, noEcho, rejected, min: null, max: null, median: null, spread: null };
  }

  const sorted = values.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  return {
    sensor: name,
    node,
    readings: values.length,
    noEcho,
    rejected,
    min: Number(sorted[0].toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
    median: Number(median.toFixed(1)),
    spread: Number((sorted[sorted.length - 1] - sorted[0]).toFixed(1)),
  };
}

window.recordStats = function recordStats() {
  const byStatus = {};
  recorder.rows.forEach((row) => {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  });

  const seconds = recorder.rows.length
    ? (recorder.rows[recorder.rows.length - 1].t - recorder.rows[0].t) / 1000
    : 0;

  // How often the resolved cell changed - the number to watch for jumpiness.
  let cellChanges = 0;
  let previous = null;
  recorder.rows.forEach((row) => {
    if (row.gx === null) return;
    const cell = row.gx + "," + row.gy;
    if (previous !== null && cell !== previous) cellChanges += 1;
    previous = cell;
  });

  const perSensor = [0, 1, 2].map(summariseSensor);

  const summary = {
    recording: recorder.on,
    rows: recorder.rows.length,
    dropped: recorder.dropped,
    seconds: Number(seconds.toFixed(1)),
    readingsPerSecond: seconds > 0 ? Number((recorder.rows.length / seconds).toFixed(1)) : 0,
    cellChanges,
  };

  console.table([summary]);
  console.table(perSensor);
  console.table([byStatus]);

  return { ...summary, byStatus, perSensor };
};

window.getRecording = function getRecording() {
  return recorder.rows.slice();
};

function downloadFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on the next tick so the download has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Columns are grouped per sensor, so one sensor's behaviour reads across a
// contiguous block rather than being scattered through the row.
function toCsv(rows) {
  if (rows.length === 0) return "";

  const columns = ["t", "screen"];
  SENSOR_NAMES.forEach((name) => {
    columns.push(`${name}_node`, `${name}_raw_cm`, `${name}_filtered_cm`, `${name}_rejected`);
  });
  columns.push(
    "active_sensor", "active_cm", "status", "held", "bad_readings",
    "grid_x", "grid_y", "raw_grid_x", "raw_grid_y",
    "calibrated", "alert_cm", "max_cm"
  );

  const valueFor = (row, column) => {
    for (let i = 0; i < SENSOR_NAMES.length; i++) {
      const name = SENSOR_NAMES[i];
      if (column === `${name}_node`) return row.sensors[i].node;
      if (column === `${name}_raw_cm`) return row.sensors[i].raw;
      if (column === `${name}_filtered_cm`) return row.sensors[i].filtered;
      if (column === `${name}_rejected`) return row.sensors[i].rejected;
    }
    switch (column) {
      case "active_sensor": return row.column === null ? "" : SENSOR_NAMES[row.column];
      case "active_cm": return row.distanceCm;
      case "bad_readings": return row.badReadings;
      case "grid_x": return row.gx;
      case "grid_y": return row.gy;
      case "raw_grid_x": return row.rawGx;
      case "raw_grid_y": return row.rawGy;
      case "alert_cm": return row.alertCm;
      case "max_cm": return row.maxCm;
      default: return row[column];
    }
  };

  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };

  const lines = [columns.join(",")];
  rows.forEach((row) => lines.push(columns.map((c) => escape(valueFor(row, c))).join(",")));
  return lines.join("\n");
}

// Everything known about the finished round, in the shape both the server and
// the manual download use.
function buildPayload() {
  const stats = window.recordStats();
  const calibration = window.getCornerCalibration();
  const assignment = window.getSensorAssignment();

  return {
    capturedAt: new Date().toISOString(),
    round: recorder.meta,
    // One entry per physical sensor: which node fills it, the bounds it was
    // calibrated to, and how it behaved across the run.
    sensors: SENSOR_NAMES.map((name, i) => ({
      sensor: name,
      node: assignment[i],
      bounds: calibration.perColumn ? calibration.perColumn[i] : null,
      summary: stats.perSensor[i],
    })),
    calibration,
    tuning: window.tuneSensor(),
    settings: window.getGameSettings(),
    stats: {
      rows: stats.rows,
      seconds: stats.seconds,
      cellChanges: stats.cellChanges,
      byStatus: stats.byStatus,
    },
    rows: recorder.rows,
  };
}

// Hands the finished round to the Flask server, which writes it into <repo>/logs
// as game-NNN-<timestamp>.json and .csv. The browser cannot write there itself.
function uploadRound() {
  if (recorder.rows.length === 0) return Promise.resolve(null);

  const body = JSON.stringify({ data: buildPayload(), csv: toCsv(recorder.rows) });

  return fetch("/api/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
    .then((response) => {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then((result) => {
      recorder.saved = true;
      console.info(
        `[record] game ${result.game} saved to logs/ - ${result.files.join(", ")} (${result.rows} rows)`
      );
      return result;
    })
    .catch((err) => {
      // Never lose the data because the server was unreachable - it stays in
      // memory, and recordSave() can still download it.
      console.warn(
        `[record] could not save to logs/ (${err.message}). ` +
          `Data is still in memory - recordSave() to download it instead.`
      );
      return null;
    });
}

window.recordUpload = uploadRound;

// recordSave()        -> CSV download
// recordSave("json")  -> JSON download, including calibration and per-sensor summary
window.recordSave = function recordSave(format) {
  if (recorder.rows.length === 0) {
    console.warn("[record] nothing captured - play a round, or call recordStart()");
    return false;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  if (String(format).toLowerCase() === "json") {
    downloadFile(`sensor-log-${stamp}.json`, JSON.stringify(buildPayload(), null, 2), "application/json");
  } else {
    downloadFile(`sensor-log-${stamp}.csv`, toCsv(recorder.rows), "text/csv");
  }

  recorder.saved = true;
  console.info(`[record] saved ${recorder.rows.length} rows`);
  return true;
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
    const named = window.getSensorAssignment()
      .map((id, i) => `${SLOT_NAMES[i]}=${id === null ? "--" : "node " + id}`)
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
    "           testing: testMode()\n" +
    "           capture: rounds record and save to logs/ automatically\n" +
    "                    recordStats() per-sensor breakdown \u00b7 recordSave() to download\n" +
    "                    recordUpload() to retry a failed save \u00b7 autoRecord(false) to disable",
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

  nextNodes
    .slice()
    .sort((a, b) => a.id - b.id)
    .forEach((node) => {
      if (calibrateSlotNodeIds.includes(node.id)) return;

      const emptyIndex = calibrateSlotNodeIds.indexOf(null);
      if (emptyIndex !== -1) {
        calibrateSlotNodeIds[emptyIndex] = node.id;
      }
    });
}

function getCalibrateNodes() {
  return calibrateSlotNodeIds.map((nodeId) => (nodeId === null ? null : nodes.get(nodeId) || null));
}

// Auto-advance fires at most once per visit to the calibration screen. Without
// this latch a nodes:update arriving milliseconds after the user presses Back
// on the corners page would bounce them straight forward again - with three
// nodes online the update stream runs at up to 60 messages per second.
let calibrateAutoContinueArmed = true;

// All three sensors online means the rig is ready, so move straight on to
// corner calibration without waiting for a button press.
function maybeAutoContinueCalibration() {
  if (screen !== "calibrate") return;

  // Gate on identification, not just connectivity: three online sensors are
  // useless until we know which is which.
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

  // A round can end with no click at all - the timer expiring or lives
  // running out - so close the recording off the state, not off a button.
  if (window.getGameState().status === "gameover") {
    autoRecordStop("gameover");
  }

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
function startGameWithMode(mode) {
  stopGameLoop();
  stopAlertNoise();
  autoRecordStop("restart"); // close off any round already in progress
  window.setGameInputMode(mode);
  window.resetGame();
  alertReturnScreen = "game";
  screen = "game";
  autoRecordStart(mode);
  startGameLoop();
}

function connectSocket() {
  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    console.log("WebSocket connected");
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
      recordReading();

      if (screen === "calibrate") {
        window.updateSensorAssignment(getSortedNodes());
      }
      updateCalibrateSlots(payload.nodes);
      maybeAutoContinueCalibration();
      logNodes();
      draw();
    } else if (payload.type === "menu:status") {
      console.log(payload.message);
    }
  });

  socket.addEventListener("close", () => {
    console.error("WebSocket closed. Reconnecting...");
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
      }
      draw();
    }
    return;
  }

  if (screen === "calibrate_corners") {
    const hit = window.getCalibrateCornersButtonAtPoint(c, point.x, point.y);
    if (hit) {
      if (hit.type === "back") {
        // Deliberate Back: hold the calibration screen instead of re-advancing.
        calibrateAutoContinueArmed = false;
        screen = "calibrate";
      } else if (hit.type === "capture") {
        window.captureCorner(window.readSensorCoordinate(getCalibrateNodes()));
      } else if (hit.type === "reset") {
        window.resetCornerCalibration();
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
        // Through startGameWithMode so the next round gets its own recording.
        startGameWithMode(window.getGameInputMode());
      } else if (pauseMenuHit.type === "menu") {
        autoRecordStop("quit");
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
        autoRecordStop("quit");
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
    calibrateAutoContinueArmed = true;
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
