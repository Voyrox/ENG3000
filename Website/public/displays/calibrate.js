window.renderCalibrate = function renderCalibrate(ctx, canvas) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const centerX = width / 2;
  const floorY = height * 1;
  const laptopW = Math.min(420, width * 0.34);
  const laptopH = Math.min(240, height * 0.24);
  const laptopX = centerX - laptopW / 2;
  const laptopY = floorY - laptopH;
  const sensorLift = height * 0.01;
  const sensorY = Math.max(80, floorY - laptopH - 120 - sensorLift);
  const sensorSize = Math.max(28, Math.min(44, width * 0.032));

  // Background
  ctx.fillStyle = "#f7efe0";
  ctx.fillRect(0, 0, width, height);

  // Laptop
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(laptopX, laptopY, laptopW, laptopH * 0.72);
  ctx.fillStyle = "#334155";
  ctx.fillRect(laptopX + 18, laptopY + 16, laptopW - 36, laptopH * 0.72 - 32);

  // Keyboard
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(laptopX + laptopW * 0.25, laptopY - laptopH * 0.18, laptopW * 0.5, laptopH * 0.16);
  ctx.fillStyle = "#f7efe0";
  ctx.font = `${Math.max(12, Math.min(24, width * 0.016))}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText("Laptop", centerX, laptopY + laptopH * 0.38);

  // Title
  ctx.fillStyle = "#1f2937";
  ctx.textAlign = "center";
  ctx.font = `bold ${Math.max(18, Math.min(32, width * 0.03))}px monospace`;
  ctx.fillText("Calibration Mode", centerX, Math.max(54, height * 0.09));

  const sensorXs = [centerX - laptopW * 0.5, centerX, centerX + laptopW * 0.5];
  const gridSize = Math.min(width * 0.84, laptopW * 1.5);
  const cellSize = gridSize / 3;
  const gridX = centerX - gridSize / 2;
  const gridY = Math.max(12, sensorY - gridSize - 56 - sensorLift);

  ctx.strokeStyle = "#64748b";
  ctx.lineWidth = 2;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      ctx.strokeRect(gridX + col * cellSize, gridY + row * cellSize, cellSize, cellSize);
    }
  }

  sensorXs.forEach((x, index) => {
    ctx.fillStyle = index === 1 ? "#22c55e" : "#38bdf8";
    ctx.beginPath();
    ctx.roundRect(x - sensorSize / 2, sensorY, sensorSize, sensorSize, 6);
    ctx.fill();

    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.moveTo(x, sensorY - 10);
    ctx.lineTo(x - 8, sensorY - 2);
    ctx.lineTo(x + 8, sensorY - 2);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x - 8, sensorY - 2);
    ctx.lineTo(x - 8, sensorY + 8);
    ctx.lineTo(x + 8, sensorY + 8);
    ctx.lineTo(x + 8, sensorY - 2);
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  ctx.fillStyle = "#0f172a";
  ctx.font = `${Math.max(12, Math.min(18, width * 0.016))}px monospace`;
  ctx.fillText("Sensor 1", sensorXs[0], sensorY + sensorSize + 22);
  ctx.fillText("Sensor 2", sensorXs[1], sensorY + sensorSize + 22);
  ctx.fillText("Sensor 3", sensorXs[2], sensorY + sensorSize + 22);

  ctx.textAlign = "start";
};
