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
    renderCalibrate(ctx, c, getCalibrateNodes(), sensorLocations);
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

function getCanvasPoint(event) {
  const rect = c.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function updateCalibrateSlots(nextNodes) {
  const nextIds = new Set(nextNodes.map((node) => node.id));

  calibrateSlotNodeIds.forEach((nodeId, index) => {
    if (nodeId !== null && !nextIds.has(nodeId)) {
      calibrateSlotNodeIds[index] = null;
    }
  });

  nextNodes
    .slice()
    .sort((a, b) => a.id - b.id)
    .forEach((node) => {
      if (calibrateSlotNodeIds.includes(node.id)) {
        return;
      }

      const emptyIndex = calibrateSlotNodeIds.indexOf(null);
      if (emptyIndex !== -1) {
        calibrateSlotNodeIds[emptyIndex] = node.id;
      }
    });
}

function getCalibrateNodes() {
  return calibrateSlotNodeIds.map((nodeId) => (nodeId === null ? null : nodes.get(nodeId) || null));
}

// All three sensors online means the rig is ready, so move straight on to
// corner calibration without waiting for a button press.
function maybeAutoContinueCalibration() {
  if (screen !== "calibrate") return;
  if (window.countConfiguredNodes(getCalibrateNodes()) < window.CALIBRATE_AUTO_CONTINUE_NODES) return;
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
  window.setGameInputMode(mode);
  window.resetGame();
  alertReturnScreen = "game";
  screen = "game";
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
      updateCalibrateSlots(payload.nodes);
      nodes.clear();
      payload.nodes.forEach((node) => nodes.set(node.id, node));
      maybeAutoContinueCalibration();
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
      } else if (hit.type === "alert") {
        alertReturnScreen = "calibrate";
        screen = "alert";
        if (soundEnabled()) playAlertNoise();
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
        window.resetGame();
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
        window.resetGame();
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
      }
      draw();
    }
    return;
  }

  const choice = window.getMenuButtonAtPoint(c, point.x, point.y);
  if (choice === "Play") {
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
