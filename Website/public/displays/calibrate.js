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

  const sensorX = centerX;

  ctx.fillStyle = "#22c55e";
  ctx.beginPath();
  ctx.roundRect(sensorX - sensorSize / 2, sensorY, sensorSize, sensorSize, 6);
  ctx.fill();

  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.moveTo(sensorX, sensorY - 10);
  ctx.lineTo(sensorX - 8, sensorY - 2);
  ctx.lineTo(sensorX + 8, sensorY - 2);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(sensorX - 8, sensorY - 2);
  ctx.lineTo(sensorX - 8, sensorY + 8);
  ctx.lineTo(sensorX + 8, sensorY + 8);
  ctx.lineTo(sensorX + 8, sensorY - 2);
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = "start";
};
