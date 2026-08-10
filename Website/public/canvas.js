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
const audioContext = new (window.AudioContext || window.webkitAudioContext)();

function playAlertNoise() {
  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }

  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 520;
  gain.gain.value = 0.22;
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.18);
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

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);

  if (screen === "calibrate") {
    renderCalibrate(ctx, c, getCalibrateNodes());
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
    window.renderAlert(ctx, c);
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

function gameLoopTick(timestamp) {
  if (screen !== "game") {
    gameLoopId = null;
    return;
  }
  window.updateGame(timestamp);
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
  const pointer = getCanvasPoint(event);
  if (screen === "game") {
    window.setGameCursor(c, pointer.x, pointer.y);
    if (window.handleGameHover(c, pointer.x, pointer.y)) {
      draw();
    }
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
        screen = "alert";
        playAlertNoise();
      } else if (hit.type === "skip") {
        stopGameLoop();
        window.resetGame();
        screen = "game";
        startGameLoop();
      }
      draw();
    }
    return;
  }

  if (screen === "game") {
    const levelHit = window.getGameLevelButtonAtPoint(c, point.x, point.y);
    if (levelHit) {
      window.setGameLevel(levelHit.level);
      draw();
      return;
    }

    const overButton = window.getGameOverButtonAtPoint(c, point.x, point.y);
    if (overButton) {
      screen = "menu";
      stopGameLoop();
      draw();
      return;
    }

    if (window.handleGameClick(c, point.x, point.y)) {
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
    const hit = window.getAlertButtonAtPoint(c, point.x, point.y);
    if (hit && hit.type === "back") {
      screen = "calibrate";
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
