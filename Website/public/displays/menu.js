window.getMenuLayout = function getMenuLayout(canvas) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const centerX = width / 2;
  const buttonWidth = Math.min(320, Math.max(220, width * 0.32));
  const buttonHeight = Math.min(64, Math.max(48, height * 0.08));
  const gap = Math.max(12, height * 0.03);
  const totalHeight = buttonHeight * 3 + gap * 2;
  const startY = Math.max(180, height / 2 - totalHeight / 2);
  const labels = ["Play", "Options", "Logs"];

  return {
    width,
    height,
    centerX,
    buttonWidth,
    buttonHeight,
    gap,
    totalHeight,
    startY,
    buttons: labels.map((label, index) => ({
      label,
      x: centerX - buttonWidth / 2,
      y: startY + index * (buttonHeight + gap),
      width: buttonWidth,
      height: buttonHeight,
    })),
  };
};

window.renderMenu = function renderMenu(ctx, canvas, statusText = "Waiting for ESP32 data...", nodes = []) {
  const layout = window.getMenuLayout(canvas);
  const { width, height, centerX, buttonHeight, totalHeight, startY, buttons } = layout;

  ctx.fillStyle = "#f6f1e7";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#111";
  ctx.textAlign = "center";
  ctx.font = `bold ${Math.max(28, Math.min(52, width * 0.055))}px monospace`;
  ctx.fillText("ENG3000 Group 1", centerX, Math.max(84, height * 0.18));

  buttons.forEach((button) => {
    const { label, x, y, width: buttonWidth } = button;

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

window.getMenuButtonAtPoint = function getMenuButtonAtPoint(canvas, x, y) {
  const layout = window.getMenuLayout(canvas);

  for (const button of layout.buttons) {
    const withinX = x >= button.x && x <= button.x + button.width;
    const withinY = y >= button.y && y <= button.y + button.height;
    if (withinX && withinY) {
      return button.label;
    }
  }

  return null;
};
