window.renderCalibrate = function renderCalibrate(ctx, canvas, nodes = []) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const centerX = width / 2;
  const floorY = height * 1;
  const laptopW = Math.min(420, width * 0.34);
  const laptopH = Math.min(240, height * 0.24);
  const laptopX = centerX - laptopW / 2;
  const laptopY = floorY - laptopH;
  const sensorSize = Math.max(28, Math.min(44, width * 0.032));
  const sensorY = Math.max(80, floorY - laptopH - 120 - height * 0.01);

  // Background
  ctx.fillStyle = "#13131c";
  ctx.fillRect(0, 0, width, height);

  // Back/Skip buttons
  const layout = window.getCalibrateLayout(canvas);
  [layout.backButton, layout.skipButton].forEach((btn) => {
    ctx.fillStyle = "#475569";
    ctx.fillRect(btn.x, btn.y, btn.width, btn.height);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px monospace";
    ctx.textAlign = "center";
    ctx.fillText(btn.label, btn.x + btn.width / 2, btn.y + 24);
  });

  // Laptop
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(laptopX, laptopY, laptopW, laptopH * 0.72);
  ctx.fillStyle = "#42425d";
  ctx.fillRect(laptopX + 18, laptopY + 16, laptopW - 36, laptopH * 0.72 - 32);

  // Keyboard
  ctx.fillStyle = "#42425d";
  ctx.fillRect(laptopX + laptopW * 0.25, laptopY - laptopH * 0.18, laptopW * 0.5, laptopH * 0.16);
  ctx.fillStyle = "#cdd6f4";
  ctx.font = `${Math.max(12, Math.min(24, width * 0.016))}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText("Laptop", centerX, laptopY + laptopH * 0.38);

  // Title
  const titleY = Math.max(54, height * 0.09);
  ctx.fillStyle = "#cdd6f4";
  ctx.textAlign = "center";
  ctx.font = `bold ${Math.max(18, Math.min(32, width * 0.03))}px monospace`;
  ctx.fillText("Calibration Mode", centerX, titleY);

  // Sensors
  const spacing = Math.min(width * 0.22, 250);
  const sensors = [
    { label: "Left", x: centerX - spacing },
    { label: "Center", x: centerX },
    { label: "Right", x: centerX + spacing },
  ];

  // Single 3x3 grid
  const leftX = sensors[0].x;
  const rightX = sensors[2].x;
  const gridY = titleY + 220;
  const cellSize = Math.max(60, (spacing * 2 - 16) / 3);

  ctx.strokeStyle = "#585b70";
  ctx.lineWidth = 2.5;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const cx = leftX + col * (cellSize + 8);
      const cy = gridY + row * (cellSize + 8);
      ctx.fillStyle = "#313244";
      ctx.beginPath();
      ctx.roundRect(cx, cy, cellSize, cellSize, 6);
      ctx.fill();
      ctx.stroke();
    }
  }

  const gridBottomY = gridY + 3 * (cellSize + 8);

  sensors.forEach((slot, i) => {
    const sensorX = slot.x;
    const node = nodes[i];
    const isAssigned = Boolean(node);
    const isOnline = Boolean(node && node.online);

    ctx.fillStyle = isOnline ? "#22c55e" : "#ef4444";
    ctx.beginPath();
    ctx.roundRect(sensorX - sensorSize / 2, gridBottomY + 20, sensorSize, sensorSize, 6);
    ctx.fill();

    ctx.fillStyle = "#cdd6f4";
    ctx.beginPath();
    ctx.moveTo(sensorX, gridBottomY + 10);
    ctx.lineTo(sensorX - 8, gridBottomY + 18);
    ctx.lineTo(sensorX + 8, gridBottomY + 18);
    ctx.closePath();
    ctx.fill();


    // Label below
    ctx.fillStyle = "#cdd6f4";
    ctx.textAlign = "center";
    if (isAssigned) {
      ctx.font = `bold ${Math.max(12, Math.min(18, width * 0.017))}px monospace`;
      ctx.fillText(`ID: ${node.id}`, sensorX, gridBottomY + sensorSize + 46);
      ctx.font = `${Math.max(11, Math.min(16, width * 0.015))}px monospace`;
      ctx.fillText(isOnline ? `RPS: ${(node.rps || 0).toFixed(1)}` : "Offline", sensorX, gridBottomY + sensorSize + 68);
    } else {
      ctx.font = `${Math.max(11, Math.min(15, width * 0.015))}px monospace`;
      ctx.fillText("Unassigned", sensorX, gridBottomY + sensorSize + 56);
    }
  });

  ctx.textAlign = "start";
};

window.getCalibrateLayout = function getCalibrateLayout(canvas) {
  const width = canvas.clientWidth || canvas.width;
  return {
    backButton: { x: 16, y: 16, width: 80, height: 36, label: "\u25C0 Back" },
    skipButton: { x: width - 96, y: 16, width: 80, height: 36, label: "Skip \u25B6" },
  };
};

window.getCalibrateButtonAtPoint = function getCalibrateButtonAtPoint(canvas, x, y) {
  const layout = window.getCalibrateLayout(canvas);

  const bb = layout.backButton;
  if (x >= bb.x && x <= bb.x + bb.width && y >= bb.y && y <= bb.y + bb.height) {
    return { type: "back" };
  }
  const sb = layout.skipButton;
  if (x >= sb.x && x <= sb.x + sb.width && y >= sb.y && y <= sb.y + sb.height) {
    return { type: "skip" };
  }

  return null;
};
