const theme = {
    background: "#0f1017",
    panel: "#171923",
    panelHover: "#202330",
    panelBorder: "#2b2f3d",
    text: "#f4f4f5",
    muted: "#9298aa",
    faint: "#555b6d",
    accent: "#89b4fa",
    green: "#22c55e",
    red: "#ef4444",
    amber: "#f59e0b",
};

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawButtonIcon(ctx, label, cx, cy, size) {
  ctx.save();
  ctx.strokeStyle = theme.text;
  ctx.fillStyle = theme.text;
  ctx.lineWidth = Math.max(2, size * 0.08);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (label === "Play") {
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.18, cy - size * 0.24);
    ctx.lineTo(cx + size * 0.26, cy);
    ctx.lineTo(cx - size * 0.18, cy + size * 0.24);
    ctx.closePath();
    ctx.fill();
  } else if (label === "Options") {
    const lineStartX = cx - size * 0.08;
    const lineWidth = size * 0.3;
    [cy - size * 0.18, cy, cy + size * 0.18].forEach((lineY) => {
      ctx.beginPath();
      ctx.arc(cx - size * 0.22, lineY, size * 0.04, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(lineStartX, lineY);
      ctx.lineTo(lineStartX + lineWidth, lineY);
      ctx.stroke();
    });
  } else {
    const lineWidth = size * 0.44;
    const startX = cx - lineWidth / 2;
    [cy - size * 0.18, cy, cy + size * 0.18].forEach((lineY) => {
      ctx.beginPath();
      ctx.moveTo(startX, lineY);
      ctx.lineTo(startX + lineWidth, lineY);
      ctx.stroke();
    });
  }

  ctx.restore();
}

window.getMenuLayout = function getMenuLayout(canvas) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const centerX = width / 2;
  const buttonWidth = Math.min(440, Math.max(280, width * 0.46));
  const buttonHeight = Math.min(82, Math.max(60, height * 0.095));
  const gap = Math.max(12, height * 0.022);
  const totalHeight = buttonHeight * 3 + gap * 2;
  const startY = Math.max(170, height * 0.32);
  const labels = [
    { label: "Play", subtitle: "Start a new whack-a-mole game" },
    { label: "Options", subtitle: "Adjust settings and preferences" },
    { label: "Logs", subtitle: "Review recent system activity" },
  ];

  return {
    width,
    height,
    centerX,
    buttonWidth,
    buttonHeight,
    gap,
    totalHeight,
    startY,
    buttons: labels.map((button, index) => ({
      ...button,
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
  const statusY = Math.min(height - 80, startY + totalHeight + 24);
  const statusWidth = Math.min(320, Math.max(200, width * 0.3));
  const statusHeight = Math.max(42, buttonHeight * 0.5);
  const statusX = centerX - statusWidth / 2;
  const titleFontSize = Math.max(30, Math.min(54, width * 0.058));
  const subtitleFontSize = Math.max(13, Math.min(18, width * 0.018));
  const titleY = Math.max(90, height * 0.12);
  // Gap sized off the title's own font (its ascender reaches roughly this far
  // above the baseline), so the subtitle never sits under the title text.
  const subtitleY = Math.max(subtitleFontSize + 4, titleY - titleFontSize - 10);

  // Dark diagonal backdrop with a soft accent glow behind the title, instead
  // of a flat fill.
  const backdrop = ctx.createLinearGradient(0, 0, width, height);
  backdrop.addColorStop(0, "#181a26");
  backdrop.addColorStop(1, "#0a0b11");
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(centerX, titleY, 0, centerX, titleY, Math.max(width, height) * 0.55);
  glow.addColorStop(0, "rgba(137, 180, 250, 0.16)");
  glow.addColorStop(0.6, "rgba(137, 180, 250, 0.05)");
  glow.addColorStop(1, "rgba(137, 180, 250, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.textAlign = "center";
  ctx.fillStyle = theme.muted;
  ctx.font = `${subtitleFontSize}px sans-serif`;
  ctx.fillText("Group 1 ENGG3000", centerX, subtitleY);

  ctx.fillStyle = theme.text;
  ctx.font = `bold ${titleFontSize}px sans-serif`;
  ctx.fillText("Whack-a-Mole", centerX, titleY);

  buttons.forEach((button) => {
    const { label, subtitle, x, y, width: buttonWidth, height: currentButtonHeight } = button;
    const radius = Math.max(10, currentButtonHeight * 0.16);
    const iconSize = currentButtonHeight * 0.58;
    const iconBoxSize = currentButtonHeight * 0.62;
    const iconX = x + 28;
    const iconY = y + (currentButtonHeight - iconBoxSize) / 2;
    const textX = iconX + iconBoxSize + 20;

    ctx.save();
    drawRoundedRect(ctx, x, y, buttonWidth, currentButtonHeight, radius);
    ctx.fillStyle = theme.panel;
    ctx.fill();
    ctx.strokeStyle = theme.panelBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    drawRoundedRect(ctx, iconX, iconY, iconBoxSize, iconBoxSize, 10);
    ctx.fillStyle = theme.panelHover;
    ctx.fill();

    drawButtonIcon(ctx, label, iconX + iconBoxSize / 2, y + currentButtonHeight / 2, iconSize);

    ctx.textAlign = "left";
    ctx.fillStyle = theme.text;
    ctx.font = `bold ${Math.max(18, Math.min(26, currentButtonHeight * 0.3))}px sans-serif`;
    ctx.fillText(label, textX, y + currentButtonHeight * 0.42);

    ctx.fillStyle = theme.muted;
    ctx.font = `${Math.max(12, Math.min(16, currentButtonHeight * 0.18))}px sans-serif`;
    ctx.fillText(subtitle, textX, y + currentButtonHeight * 0.7);
    ctx.restore();
  });

  drawRoundedRect(ctx, statusX, statusY, statusWidth, statusHeight, 10);
  ctx.fillStyle = theme.panel;
  ctx.fill();
  ctx.strokeStyle = theme.panelBorder;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const statusDotX = statusX + 24;
  const statusDotY = statusY + statusHeight / 2;
  const hasNodes = Array.isArray(nodes) && nodes.length > 0;
  ctx.beginPath();
  ctx.arc(statusDotX, statusDotY, 7, 0, Math.PI * 2);
  ctx.fillStyle = hasNodes ? theme.green : theme.amber;
  ctx.fill();

  ctx.textAlign = "left";
  ctx.fillStyle = theme.muted;
  ctx.font = `${Math.max(11, Math.min(14, statusHeight * 0.32))}px sans-serif`;
  ctx.fillText(statusText, statusX + 42, statusY + statusHeight * 0.58);

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
