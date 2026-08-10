
window.getAlertLayout = function getAlertLayout(canvas) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const centerX = width / 2;
  const buttonWidth = Math.min(320, Math.max(220, width * 0.32));
  const buttonHeight = Math.min(64, Math.max(48, height * 0.08));
  const x = centerX - buttonWidth / 2;
  const y = height - buttonHeight - 30;

  return { width, height, centerX, buttonWidth, buttonHeight, x, y };
};

window.renderAlert = function renderAlert(ctx, canvas) {
  const layout = window.getAlertLayout(canvas);
  const { width, height, centerX, buttonWidth, buttonHeight, x, y } = layout;

  ctx.fillStyle = "#b21b1b";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.font = `bold ${Math.max(32, Math.min(64, width * 0.06))}px monospace`;
  ctx.fillText("Too close to screen", centerX, Math.max(120, height * 0.35));

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, buttonWidth, buttonHeight);

  ctx.fillStyle = "#b21b1b";
  ctx.font = `bold ${Math.max(18, Math.min(24, buttonHeight * 0.5))}px monospace`;
  ctx.fillText("Back", centerX, y + buttonHeight * 0.68);

  ctx.textAlign = "start";
};

window.getAlertButtonAtPoint = function getAlertButtonAtPoint(canvas, x, y) {
  const layout = window.getAlertLayout(canvas);
  const withinX = x >= layout.x && x <= layout.x + layout.buttonWidth;
  const withinY = y >= layout.y && y <= layout.y + layout.buttonHeight;
  return withinX && withinY ? { type: "back" } : null;
};
