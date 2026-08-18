// options.js - Options screen: round duration, starting lives, sound toggle.
// Reads/writes settings via window.getGameSettings() / window.setGameSettings()
// exposed by game.js.

window.getOptionsLayout = function getOptionsLayout(canvas) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const centerX = width / 2;

  const backButton = { x: 16, y: 16, width: 80, height: 36, label: "◀ Back" };

  const rowGap = Math.max(90, height * 0.14);
  const firstRowY = Math.max(160, height * 0.28);
  const buttonWidth = 90;
  const buttonHeight = 44;
  const buttonGap = 16;

  const durationOptions = window.DURATION_OPTIONS_MS || [30000, 60000, 90000];
  const livesOptions = window.LIVES_OPTIONS || [1, 3, 5];

  function rowButtons(options, y, formatLabel) {
    const totalWidth = options.length * buttonWidth + (options.length - 1) * buttonGap;
    const startX = centerX - totalWidth / 2;
    return options.map((value, index) => ({
      value,
      label: formatLabel(value),
      x: startX + index * (buttonWidth + buttonGap),
      y,
      width: buttonWidth,
      height: buttonHeight,
    }));
  }

  const durationButtons = rowButtons(durationOptions, firstRowY, (ms) => `${ms / 1000}s`);
  const livesButtons = rowButtons(livesOptions, firstRowY + rowGap, (n) => `${n}`);

  const soundButton = {
    x: centerX - buttonWidth,
    y: firstRowY + rowGap * 2,
    width: buttonWidth * 2,
    height: buttonHeight,
  };

  return {
    width,
    height,
    centerX,
    backButton,
    firstRowY,
    rowGap,
    durationButtons,
    livesButtons,
    soundButton,
  };
};

window.renderOptions = function renderOptions(ctx, canvas) {
  const layout = window.getOptionsLayout(canvas);
  const { width, height, centerX, backButton, durationButtons, livesButtons, soundButton } = layout;
  const settings = window.getGameSettings ? window.getGameSettings() : { durationMs: 60000, startingLives: 3, soundEnabled: true };

  ctx.fillStyle = "#13131c";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#475569";
  ctx.fillRect(backButton.x, backButton.y, backButton.width, backButton.height);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 14px monospace";
  ctx.textAlign = "center";
  ctx.fillText(backButton.label, backButton.x + backButton.width / 2, backButton.y + 24);

  ctx.fillStyle = "#cdd6f4";
  ctx.font = `bold ${Math.max(20, Math.min(32, width * 0.03))}px monospace`;
  ctx.fillText("Options", centerX, Math.max(70, height * 0.12));

  function drawSectionLabel(text, y) {
    ctx.fillStyle = "#9298aa";
    ctx.font = "14px monospace";
    ctx.textAlign = "center";
    ctx.fillText(text, centerX, y - 20);
  }

  function drawButtonRow(buttons, isSelected) {
    buttons.forEach((button) => {
      const selected = isSelected(button.value);
      ctx.fillStyle = selected ? "#22c55e" : "#313244";
      ctx.beginPath();
      ctx.roundRect(button.x, button.y, button.width, button.height, 8);
      ctx.fill();
      ctx.strokeStyle = "#585b70";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = "#fff";
      ctx.font = "bold 16px monospace";
      ctx.textAlign = "center";
      ctx.fillText(button.label, button.x + button.width / 2, button.y + button.height / 2 + 6);
    });
  }

  drawSectionLabel("Round Duration", layout.firstRowY);
  drawButtonRow(durationButtons, (value) => value === settings.durationMs);

  drawSectionLabel("Starting Lives", layout.firstRowY + layout.rowGap);
  drawButtonRow(livesButtons, (value) => value === settings.startingLives);

  drawSectionLabel("Sound", layout.firstRowY + layout.rowGap * 2);
  ctx.fillStyle = settings.soundEnabled ? "#22c55e" : "#475569";
  ctx.beginPath();
  ctx.roundRect(soundButton.x, soundButton.y, soundButton.width, soundButton.height, 8);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 16px monospace";
  ctx.textAlign = "center";
  ctx.fillText(settings.soundEnabled ? "On" : "Off", soundButton.x + soundButton.width / 2, soundButton.y + soundButton.height / 2 + 6);

  ctx.textAlign = "start";
};

window.getOptionsButtonAtPoint = function getOptionsButtonAtPoint(canvas, x, y) {
  const layout = window.getOptionsLayout(canvas);

  function within(rect) {
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  }

  if (within(layout.backButton)) return { type: "back" };

  const durationHit = layout.durationButtons.find(within);
  if (durationHit) return { type: "duration", value: durationHit.value };

  const livesHit = layout.livesButtons.find(within);
  if (livesHit) return { type: "lives", value: livesHit.value };

  if (within(layout.soundButton)) return { type: "sound" };

  return null;
};
