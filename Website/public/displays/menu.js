window.renderMenu = function renderMenu(ctx, canvas, statusText = "Waiting for ESP32 data...") {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const centerX = width / 2;
  const buttonWidth = Math.min(320, Math.max(220, width * 0.32));
  const buttonHeight = Math.min(64, Math.max(48, height * 0.08));
  const gap = Math.max(12, height * 0.03);
  const totalHeight = buttonHeight * 3 + gap * 2;
  const startY = Math.max(180, height / 2 - totalHeight / 2);

  ctx.fillStyle = "#f6f1e7";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#111";
  ctx.textAlign = "center";
  ctx.font = `bold ${Math.max(28, Math.min(52, width * 0.055))}px monospace`;
  ctx.fillText("ENG3000 Group 1", centerX, Math.max(84, height * 0.18));
  
  const options = ["Play", "Options", "Logs"];

  options.forEach((label, index) => {
    const x = centerX - buttonWidth / 2;
    const y = startY + index * (buttonHeight + gap);

    ctx.fillStyle = "#2c3e50";
    ctx.fillRect(x, y, buttonWidth, buttonHeight);

    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.max(18, Math.min(26, buttonHeight * 0.45))}px monospace`;
    ctx.fillText(label, centerX, y + buttonHeight * 0.68);
  });

  ctx.fillStyle = "#444";
  ctx.font = `${Math.max(14, Math.min(18, width * 0.02))}px monospace`;
  ctx.fillText(statusText, centerX, Math.min(height - 24, startY + totalHeight + 56));
  ctx.textAlign = "start";
};
