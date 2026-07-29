window.getNodeSelectLayout = function getNodeSelectLayout(canvas, nodes) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const centerX = width / 2;
  const buttonWidth = Math.min(320, Math.max(220, width * 0.32));
  const buttonHeight = Math.min(64, Math.max(48, height * 0.08));
  const gap = Math.max(12, height * 0.03);
  const totalHeight = nodes.length * (buttonHeight + gap);
  const startY = Math.max(140, height / 2 - totalHeight / 2);

  return {
    buttons: nodes.map((node, i) => ({
      label: `Node ${node.id}`,
      sublabel: node.address,
      nodeId: node.id,
      x: centerX - buttonWidth / 2,
      y: startY + i * (buttonHeight + gap),
      width: buttonWidth,
      height: buttonHeight,
    })),
    backButton: { x: 16, y: 16, width: 80, height: 36, label: "\u25C0 Back" },
  };
};

window.renderNodeSelect = function renderNodeSelect(ctx, canvas, nodes) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const centerX = width / 2;

  ctx.fillStyle = "#13131c";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#cdd6f4";
  ctx.textAlign = "center";
  ctx.font = `bold ${Math.max(22, Math.min(36, width * 0.04))}px monospace`;
  ctx.fillText("Select a Node", centerX, 60);

  const layout = window.getNodeSelectLayout(canvas, nodes);

  const bb = layout.backButton;
  ctx.fillStyle = "#475569";
  ctx.fillRect(bb.x, bb.y, bb.width, bb.height);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 14px monospace";
  ctx.textAlign = "center";
  ctx.fillText(bb.label, bb.x + bb.width / 2, bb.y + 24);

  layout.buttons.forEach((btn) => {
    ctx.fillStyle = "#313244";
    ctx.fillRect(btn.x, btn.y, btn.width, btn.height);

    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.font = `bold ${Math.max(18, Math.min(26, btn.height * 0.45))}px monospace`;
    ctx.fillText(btn.label, centerX, btn.y + btn.height * 0.48);
    ctx.font = `${Math.max(12, Math.min(16, btn.height * 0.3))}px monospace`;
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(btn.sublabel, centerX, btn.y + btn.height * 0.8);
  });

  ctx.textAlign = "start";
};

window.getLogsLayout = function getLogsLayout(canvas) {
  return {
    backButton: { x: 16, y: 16, width: 80, height: 36, label: "\u25C0 Back" },
    headerY: 66,
    rowHeight: 20,
    colTimeX: 16,
    colDataX: 140,
  };
};

window.renderLogs = function renderLogs(ctx, canvas, node, entries) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;

  ctx.fillStyle = "#13131c";
  ctx.fillRect(0, 0, width, height);

  const layout = window.getLogsLayout(canvas);

  const bb = layout.backButton;
  ctx.fillStyle = "#475569";
  ctx.fillRect(bb.x, bb.y, bb.width, bb.height);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 14px monospace";
  ctx.textAlign = "center";
  ctx.fillText(bb.label, bb.x + bb.width / 2, bb.y + 24);

  ctx.textAlign = "start";
  ctx.fillStyle = "#cdd6f4";
  ctx.font = "bold 18px monospace";
  ctx.fillText(`Node ${node.id}`, 112, 30);
  ctx.font = "13px monospace";
  ctx.fillStyle = "#a6adc8";
  ctx.fillText(node.address || "", 112, 48);

  ctx.fillStyle = "#585b70";
  ctx.font = "12px monospace";

  ctx.fillText("Time", layout.colTimeX, layout.headerY);
  ctx.fillText("Payload", layout.colDataX, layout.headerY);

  ctx.strokeStyle = "#313244";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(16, layout.headerY + 6);
  ctx.lineTo(width - 16, layout.headerY + 6);
  ctx.stroke();

  const reversed = [...entries].reverse();
  const maxVisible = Math.floor((height - layout.headerY - 16) / layout.rowHeight);
  const visibleEntries = reversed.slice(0, maxVisible);

  ctx.font = "12px monospace";
  visibleEntries.forEach((entry, i) => {
    const y = layout.headerY + 18 + i * layout.rowHeight;
    const time = new Date(entry.time).toLocaleTimeString();
    ctx.fillStyle = "#6c7086";
    ctx.fillText(time, layout.colTimeX, y);
    ctx.fillStyle = "#cdd6f4";
    let display = entry.data;
    if (display.length > 120) display = display.substring(0, 57) + "...";
    ctx.fillText(display, layout.colDataX, y);
  });

  if (entries.length === 0) {
    ctx.fillStyle = "#6c7086";
    ctx.font = "14px monospace";
    ctx.textAlign = "center";
    ctx.fillText("Waiting for data...", width / 2, height / 2);
    ctx.textAlign = "start";
  }

  ctx.textAlign = "start";
};

window.getNodeSelectButtonAtPoint = function getNodeSelectButtonAtPoint(canvas, nodes, x, y) {
  const layout = window.getNodeSelectLayout(canvas, nodes);

  const bb = layout.backButton;
  if (x >= bb.x && x <= bb.x + bb.width && y >= bb.y && y <= bb.y + bb.height) {
    return { type: "back" };
  }

  for (const btn of layout.buttons) {
    if (x >= btn.x && x <= btn.x + btn.width && y >= btn.y && y <= btn.y + btn.height) {
      return { type: "node", nodeId: btn.nodeId };
    }
  }

  return null;
};

window.getLogsButtonAtPoint = function getLogsButtonAtPoint(canvas, x, y) {
  const layout = window.getLogsLayout(canvas);
  const bb = layout.backButton;
  if (x >= bb.x && x <= bb.x + bb.width && y >= bb.y && y <= bb.y + bb.height) {
    return { type: "back" };
  }
  return null;
};
