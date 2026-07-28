const c = document.getElementById("game");
const ctx = c.getContext("2d");

const nodes = new Map();
let viewport = { width: 0, height: 0, dpr: 1 };

function getOnlineCount() {
  let count = 0;
  for (const node of nodes.values()) {
    if (node.online) {
      count += 1;
    }
  }
  return count;
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

  const onlineCount = getOnlineCount();
  const offlineCount = nodes.size - onlineCount;
  const statusText = onlineCount > 0
    ? `Nodes connected: ${onlineCount}${offlineCount > 0 ? ` | Offline: ${offlineCount}` : ""}`
    : "Waiting for ESP32 data...";

  renderMenu(ctx, c, statusText);
}

const liveStream = new EventSource("/stream");
liveStream.onmessage = (event) => {
  const payload = JSON.parse(event.data);
  nodes.clear();
  payload.forEach((node) => nodes.set(node.id, node));

  console.log("Received payload:", payload);
  draw();
};

liveStream.onerror = () => {
  console.error("Error connecting to stream. Retrying...");
};

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
