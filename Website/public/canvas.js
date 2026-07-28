const c = document.getElementById("game");
const ctx = c.getContext("2d");
const status = document.getElementById("status");

const nodes = new Map();

function draw() {
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = "20px monospace";
  ctx.fillStyle = "#111";

  let y = 30;
  for (const node of nodes.values()) {
    ctx.fillText(`Node ${node.id}: ${node.latest ?? "no data yet"}`, 10, y);
    y += 30;
  }
}

const liveStream = new EventSource("/stream");
liveStream.onmessage = (event) => {
  const payload = JSON.parse(event.data);
  nodes.clear();
  payload.forEach((node) => nodes.set(node.id, node));

  status.textContent = JSON.stringify(payload, null, 2);
  draw();
};

liveStream.onerror = () => {
  status.textContent = "Disconnected from stream. Retrying...";
};

