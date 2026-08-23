// alert.js - Full-screen "too close to the screen" alert.
//
// This screen covers one condition only: the raw distance reading has dropped
// below ALERT_DISTANCE_CM. It owns that threshold so the game and the
// calibration screens all agree on what "too close" means.
//
// renderAlert() takes a boolean `active`; when false it draws nothing and
// returns false, so the caller can fall through to the normal frame.

// Absolute safety floor. Calibration can only make the alert MORE cautious
// than this, never less - a badly captured near edge must not disable it.
window.ALERT_DISTANCE_CM = 10;

// The distance the alert actually fires at. Once the play area is calibrated
// this becomes the near edge of the board: step in front of that and you are
// off the board toward the screen.
window.getAlertThresholdCm = function getAlertThresholdCm() {
  const bounds = window.getCalibrationBounds ? window.getCalibrationBounds() : null;
  if (bounds && bounds.calibrated && Number.isFinite(bounds.alertCm)) {
    return Math.max(window.ALERT_DISTANCE_CM, bounds.alertCm);
  }
  return window.ALERT_DISTANCE_CM;
};

// True when `cm` is a real reading inside the danger zone. A negative value
// means "no echo" from the sensor, not "zero distance".
window.isTooClose = function isTooClose(cm) {
  return Number.isFinite(cm) && cm >= 0 && cm < window.getAlertThresholdCm();
};

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

// options:
//   active      - boolean; when false nothing is drawn and false is returned
//   distanceCm  - latest raw reading, shown to the player when available
//   showBack    - draw the manual Back button (the calibrate entry point).
//                 Sensor-driven alerts clear themselves, so they hide it.
window.renderAlert = function renderAlert(ctx, canvas, options = {}) {
  const { active = true, distanceCm = null, showBack = true } = options;
  if (!active) return false;

  const layout = window.getAlertLayout(canvas);
  const { width, height, centerX, buttonWidth, buttonHeight, x, y } = layout;

  ctx.fillStyle = "#b21b1b";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.font = `bold ${Math.max(32, Math.min(64, width * 0.06))}px monospace`;
  ctx.fillText("Too close to screen", centerX, Math.max(120, height * 0.35));

  ctx.font = `${Math.max(16, Math.min(26, width * 0.022))}px monospace`;
  const threshold = window.getAlertThresholdCm();
  ctx.fillText(
    Number.isFinite(distanceCm)
      ? `${distanceCm.toFixed(1)} cm - step back past ${threshold.toFixed(0)} cm`
      : `Step back past ${threshold.toFixed(0)} cm`,
    centerX,
    Math.max(170, height * 0.35 + 54)
  );

  if (showBack) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, buttonWidth, buttonHeight);

    ctx.fillStyle = "#b21b1b";
    ctx.font = `bold ${Math.max(18, Math.min(24, buttonHeight * 0.5))}px monospace`;
    ctx.fillText("Back", centerX, y + buttonHeight * 0.68);
  } else {
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx.font = `${Math.max(14, Math.min(20, width * 0.016))}px monospace`;
    ctx.fillText("The game resumes automatically", centerX, y + buttonHeight * 0.68);
  }

  ctx.textAlign = "start";
  return true;
};

// Only hit-testable while the manual Back button is on screen.
window.getAlertButtonAtPoint = function getAlertButtonAtPoint(canvas, x, y, showBack = true) {
  if (!showBack) return null;
  const layout = window.getAlertLayout(canvas);
  const withinX = x >= layout.x && x <= layout.x + layout.buttonWidth;
  const withinY = y >= layout.y && y <= layout.y + layout.buttonHeight;
  return withinX && withinY ? { type: "back" } : null;
};
